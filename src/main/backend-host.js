/**
 * backend-host — corre el MISMO backend del CRM (backend/server.js) como
 * proceso hijo con su propio Node, en modo Desktop.
 *
 *   - Migraciones: `prisma migrate deploy` antes de arrancar (Fase 2: baseline).
 *   - cwd = carpeta de datos: los uploads relativos caen fuera del programa.
 *   - Solo 127.0.0.1; espera /ready (SELECT 1) antes de abrir la ventana.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

function esperarListo(puerto, timeoutMs) {
  const limite = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const intentar = () => {
      const req = http.get({ host: '127.0.0.1', port: puerto, path: '/ready', timeout: 3000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        reintentar();
      });
      req.on('error', reintentar);
      req.on('timeout', () => { req.destroy(); });
    };
    const reintentar = () => {
      if (Date.now() > limite) return reject(new Error(`El servicio local no respondió en ${timeoutMs / 1000}s`));
      setTimeout(intentar, 500);
    };
    intentar();
  });
}

function getJson(puerto, ruta) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: puerto, path: ruta, timeout: 5000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class BackendHost {
  constructor({ paths, log }) {
    this.paths = paths;
    this.log = log;
    this.proc = null;
  }

  entorno({ puerto, databaseUrl, secretos, edicion, licencia }) {
    const origen = `http://127.0.0.1:${puerto}`;
    return {
      // Solo lo necesario: no se hereda el entorno del usuario (podría traer
      // DATABASE_URL u otras variables de un desarrollo local).
      SystemRoot: process.env.SystemRoot,
      PATH: process.env.PATH,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      NODE_ENV: 'production',
      ALLNOVA_RUNTIME: 'desktop',
      ALLNOVA_EDICION: edicion,
      ALLNOVA_LICENCIA: licencia || '{}',
      ALLNOVA_DATA_DIR: this.paths.archivos,
      ALLNOVA_FRONTEND_DIR: this.paths.frontend,
      ALLNOVA_BIND_HOST: '127.0.0.1',
      PORT: String(puerto),
      DATABASE_URL: databaseUrl,
      DIRECT_URL: databaseUrl,
      JWT_SECRET: secretos.jwtSecret,
      JWT_REFRESH_SECRET: secretos.jwtRefreshSecret,
      CONNECTOR_SECRET_KEY: secretos.connectorKey,
      ENCRYPTION_KEY: secretos.encryptionKey,
      ALLNOVA_DESKTOP_TOKEN: secretos.desktopToken,
      // Notificaciones en el celular (Web Push) con las claves de esta PC.
      ...(secretos.vapidPublica && secretos.vapidPrivada ? {
        VAPID_PUBLIC_KEY: secretos.vapidPublica,
        VAPID_PRIVATE_KEY: secretos.vapidPrivada,
        VAPID_SUBJECT: 'mailto:soporte@all-novatech.com'
      } : {}),
      FRONTEND_URL: origen,
      APP_URL: origen,
      LOG_LEVEL: 'info'
    };
  }

  /** prisma migrate deploy con el CLI empaquetado junto al backend. */
  migrar(env) {
    const cli = path.join(this.paths.backend, 'node_modules', 'prisma', 'build', 'index.js');
    return new Promise((resolve, reject) => {
      const p = spawn(this.paths.node, [cli, 'migrate', 'deploy', '--schema', path.join(this.paths.backend, 'prisma', 'schema.prisma')], {
        cwd: this.paths.backend, env, windowsHide: true
      });
      let salida = '';
      p.stdout.on('data', (d) => { salida += d; });
      p.stderr.on('data', (d) => { salida += d; });
      p.once('error', reject);
      p.once('exit', (code) => {
        this.log(`[migrate] ${salida.trim().split(/\r?\n/).filter((l) => /migration|applied|No pending|Error/i.test(l)).join(' | ')}`);
        code === 0 ? resolve() : reject(new Error(`Las migraciones fallaron (código ${code}).\n${salida.slice(-2000)}`));
      });
    });
  }

  /** @param {boolean} [o.migrar=true] false si quien llama ya migró (respaldo previo + recuperación). */
  async iniciar({ puerto, databaseUrl, secretos, edicion, licencia, migrar = true }) {
    const env = this.entorno({ puerto, databaseUrl, secretos, edicion, licencia });
    if (migrar) await this.migrar(env);

    const log = fs.createWriteStream(path.join(this.paths.logs, 'backend.log'), { flags: 'a' });
    this.proc = spawn(this.paths.node, [path.join(this.paths.backend, 'server.js')], {
      cwd: this.paths.archivos, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    this.proc.stdout.pipe(log);
    this.proc.stderr.pipe(log);
    const terminoAntes = new Promise((_, reject) => {
      this.proc.once('exit', (code) => {
        this.log(`[backend] terminó (código ${code})`);
        this.proc = null;
        reject(new Error(`El servicio local se cerró al iniciar (código ${code}). Ver backend.log`));
      });
    });
    terminoAntes.catch(() => {}); // si termina después de estar listo, no es error de arranque

    await Promise.race([esperarListo(puerto, 90000), terminoAntes]);
    this.log(`[backend] listo en 127.0.0.1:${puerto}`);
    return `http://127.0.0.1:${puerto}`;
  }

  estado(puerto) {
    return getJson(puerto, '/api/v1/desktop/estado').then((r) => r.data);
  }

  /** SIGTERM y, si no termina en 10 s, kill. */
  detener() {
    if (!this.proc) return Promise.resolve();
    const p = this.proc;
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} resolve(); }, 10000);
      p.once('exit', () => { clearTimeout(t); resolve(); });
      try { p.kill('SIGTERM'); } catch (_) { clearTimeout(t); resolve(); }
    });
  }
}

module.exports = { BackendHost };
