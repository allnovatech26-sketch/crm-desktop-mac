/**
 * pg-manager — PostgreSQL local gestionado por la app (edición Individual).
 *
 * - Sin admin ni servicio de Windows: el servidor corre como proceso hijo con
 *   su propio directorio de datos y su propio puerto (no choca con otro
 *   PostgreSQL instalado en el 5432).
 * - Solo escucha en 127.0.0.1; autenticación scram-sha-256.
 * - Recupera el arranque tras un apagado brusco (postmaster.pid huérfano) y
 *   apaga en modo "fast" al cerrar la app (WAL garantiza consistencia).
 *
 * No depende de Electron: se prueba con Node puro (scripts/poc-postgres.js).
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');

const PUERTO_MIN = 54330;
const PUERTO_MAX = 54399;

function exec(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}

function puertoLibre(puerto) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(puerto, '127.0.0.1');
  });
}

async function elegirPuerto(preferido) {
  if (preferido && await puertoLibre(preferido)) return preferido;
  for (let p = PUERTO_MIN; p <= PUERTO_MAX; p += 1) if (await puertoLibre(p)) return p;
  throw new Error('No hay un puerto libre para la base de datos local');
}

/** ¿Hay un proceso vivo con ese PID? */
function procesoVivo(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * ¿Ese PID es un postgres? Windows reutiliza PIDs: un postmaster.pid viejo
 * puede apuntar a otro programa. Si no se puede saber, se asume que sí.
 */
async function esPostgres(pid) {
  if (process.platform !== 'win32') return true;
  try {
    const { stdout } = await exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    if (!/"\d+"/.test(stdout)) return false;   // "INFO: no tasks..." → ya no existe
    return /postgres/i.test(stdout);
  } catch (_) { return true; }
}

class PgManager {
  /**
   * @param {object} o
   * @param {string} o.pgHome   carpeta con bin/ lib/ share/ (resources/pgsql)
   * @param {string} o.dataDir  directorio de datos (fuera de la carpeta del programa)
   * @param {string} o.logFile  log del servidor
   * @param {(msg:string)=>void} [o.log]
   */
  constructor({ pgHome, dataDir, logFile, log = () => {} }) {
    this.bin = (n) => path.join(pgHome, 'bin', `${n}.exe`);
    this.dataDir = dataDir;
    this.logFile = logFile;
    this.log = log;
    this.puerto = null;
  }

  estaInicializado() {
    return fs.existsSync(path.join(this.dataDir, 'PG_VERSION'));
  }

  /** initdb con superusuario propio y contraseña aleatoria (no hay usuario por defecto). */
  async inicializar({ superusuario, password }) {
    if (this.estaInicializado()) return false;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const pwfile = path.join(path.dirname(this.dataDir), `.pwinit-${process.pid}`);
    fs.writeFileSync(pwfile, password, { mode: 0o600 });
    try {
      await exec(this.bin('initdb'), [
        '-D', this.dataDir, '-U', superusuario, `--pwfile=${pwfile}`,
        '-E', 'UTF8', '--locale=C', '--auth=scram-sha-256'
      ]);
    } finally {
      fs.rmSync(pwfile, { force: true });
    }
    // Solo conexiones locales; el modo Equipo (LAN) lo cambiará explícitamente.
    fs.appendFileSync(path.join(this.dataDir, 'postgresql.conf'), [
      '', '# --- ALLNOVATECH Desktop ---',
      "listen_addresses = '127.0.0.1'",
      'max_connections = 40',
      'shared_buffers = 128MB',
      "logging_collector = off", ''
    ].join('\n'));
    this.log('[pg] directorio de datos inicializado');
    return true;
  }

  /** Limpia un postmaster.pid huérfano (apagado brusco) si su proceso ya no existe. */
  limpiarPidHuerfano() {
    const pidFile = path.join(this.dataDir, 'postmaster.pid');
    if (!fs.existsSync(pidFile)) return false;
    const pid = Number(String(fs.readFileSync(pidFile, 'utf8')).split(/\r?\n/)[0]);
    if (pid && procesoVivo(pid)) return false;
    fs.rmSync(pidFile, { force: true });
    this.log(`[pg] postmaster.pid huérfano eliminado (pid ${pid})`);
    return true;
  }

  /**
   * Un postmaster todavía vivo sobre este directorio de datos solo puede ser de
   * una sesión anterior de la app que ya terminó (la instancia única impide dos
   * a la vez), así que quedó huérfano tras un cierre brusco. Se le dan unos
   * segundos por si estaba terminando y luego se apaga en modo "fast" (WAL
   * garantiza consistencia).
   */
  async liberarServidorAnterior({ esperaMs = 3000 } = {}) {
    const pidFile = path.join(this.dataDir, 'postmaster.pid');
    const pidVivo = () => {
      if (!fs.existsSync(pidFile)) return 0;
      const pid = Number(String(fs.readFileSync(pidFile, 'utf8')).split(/\r?\n/)[0]);
      return pid && procesoVivo(pid) ? pid : 0;
    };
    let pid = pidVivo();
    if (!pid) return false;
    if (!(await esPostgres(pid))) {
      fs.rmSync(pidFile, { force: true });
      this.log(`[pg] postmaster.pid apuntaba a otro programa (pid ${pid}); eliminado`);
      return false;
    }
    this.log(`[pg] servidor anterior aún activo (pid ${pid}); esperando a que termine`);
    const limite = Date.now() + esperaMs;
    while (pid && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 500));
      pid = pidVivo();
    }
    if (pid) {
      this.log(`[pg] el servidor anterior (pid ${pid}) no terminó; se apaga`);
      try {
        await exec(this.bin('pg_ctl'), ['-D', this.dataDir, '-m', 'fast', '-w', '-t', '30', 'stop']);
      } catch (e) {
        if (!/is not running|no server running|PID file .* does not exist/i.test(`${e.stderr || ''}${e.stdout || ''}`)) throw e;
      }
    }
    this.log('[pg] servidor anterior terminado');
    return true;
  }

  async iniciar({ puertoPreferido, timeoutMs = 60000 } = {}) {
    await this.liberarServidorAnterior();
    this.limpiarPidHuerfano();
    this.puerto = await elegirPuerto(puertoPreferido);
    // En Windows, `pg_ctl start` deja heredados los pipes de stdout/stderr al
    // postmaster y execFile nunca termina: se lanza con stdio ignorado y se
    // espera con pg_isready.
    await new Promise((resolve, reject) => {
      const p = spawn(this.bin('pg_ctl'), [
        '-D', this.dataDir, '-l', this.logFile, '-W', '-o', `-p ${this.puerto}`, 'start'
      ], { windowsHide: true, stdio: 'ignore' });
      p.once('error', reject);
      p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`pg_ctl start salió con código ${code} (ver ${this.logFile})`))));
    });
    const limite = Date.now() + timeoutMs;
    while (!(await this.listo())) {
      if (Date.now() > limite) throw new Error(`PostgreSQL no respondió en ${timeoutMs / 1000}s (ver ${this.logFile})`);
      await new Promise((r) => setTimeout(r, 300));
    }
    this.log(`[pg] iniciado en 127.0.0.1:${this.puerto}`);
    return this.puerto;
  }

  async listo() {
    try {
      await exec(this.bin('pg_isready'), ['-h', '127.0.0.1', '-p', String(this.puerto)]);
      return true;
    } catch (_) { return false; }
  }

  async detener() {
    if (!this.estaInicializado()) return;
    try {
      await exec(this.bin('pg_ctl'), ['-D', this.dataDir, '-m', 'fast', '-w', '-t', '30', 'stop']);
      this.log('[pg] detenido');
    } catch (e) {
      // Ya estaba detenido: no es error.
      if (!/is not running|no server running|PID file .* does not exist/i.test(`${e.stderr || ''}${e.stdout || ''}`)) throw e;
    }
  }

  /** Ejecuta SQL como superusuario (bootstrap: crear rol y base de la app). */
  async sql({ usuario, password, sql, db = 'postgres' }) {
    const { stdout } = await exec(this.bin('psql'), [
      '-h', '127.0.0.1', '-p', String(this.puerto), '-U', usuario, '-d', db,
      '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql
    ], { env: { ...process.env, PGPASSWORD: password } });
    return stdout.trim();
  }

  url({ usuario, password, db }) {
    return `postgresql://${encodeURIComponent(usuario)}:${encodeURIComponent(password)}@127.0.0.1:${this.puerto}/${db}`;
  }
}

module.exports = { PgManager, elegirPuerto, puertoLibre };
