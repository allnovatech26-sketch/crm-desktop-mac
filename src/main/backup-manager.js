/**
 * backup-manager — respaldos y restauración de ALLNOVATECH CRM Desktop.
 *
 * Respaldo = pg_dump (formato custom) + carpeta de archivos de la app, en un
 * único .allnova cifrado (backup-format.js). Un respaldo no cuenta hasta que se
 * VERIFICA: autenticación del archivo completo + `pg_restore --list` del dump.
 *
 * Restauración (siempre reversible):
 *   1. verificar el archivo con el código → 2. comprobar que el esquema del
 *   respaldo no es más nuevo que la app → 3. respaldo del estado actual →
 *   4. pg_restore en una base NUEVA → 5. recién entonces intercambiar base y
 *   archivos (las anteriores quedan como *_prev) → 6. el backend arranca y
 *   `migrate deploy` actualiza si el respaldo es de una versión anterior.
 *
 * Sin Electron: recibe un PgManager ya iniciado y las rutas.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const F = require('./backup-format');

const ROTACION = { diarios: 7, semanales: 4, mensuales: 12 };

function exec(bin, args, env) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err) { err.message = `${path.basename(bin)}: ${stderr || err.message}`; return reject(err); }
      resolve(stdout);
    });
  });
}

const sello = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

class BackupManager {
  /**
   * @param {object} o
   * @param {import('./pg-manager').PgManager} o.pg
   * @param {object} o.db        { usuario, password, nombre } de la app
   * @param {object} o.su        { usuario, password } superusuario local
   * @param {string} o.archivos  carpeta de archivos de la app (cwd del backend)
   * @param {string} o.carpeta   carpeta principal de respaldos
   * @param {string} o.migraciones carpeta prisma/migrations de la app instalada
   * @param {{clave:Buffer, sal:Buffer}} o.cripto  clave de respaldo (derivada del código)
   * @param {string} o.appVersion
   * @param {(m:string)=>void} [o.log]
   */
  constructor(o) {
    Object.assign(this, o);
    this.log = o.log || (() => {});
    this.bin = (n) => path.join(path.dirname(o.pg.bin('postgres')), `${n}.exe`);
  }

  envDb() { return { PGPASSWORD: this.db.password, PGHOST: '127.0.0.1', PGPORT: String(this.pg.puerto), PGUSER: this.db.usuario }; }
  envSu() { return { PGPASSWORD: this.su.password, PGHOST: '127.0.0.1', PGPORT: String(this.pg.puerto), PGUSER: this.su.usuario }; }

  migracionesLocales() {
    return fs.existsSync(this.migraciones)
      ? fs.readdirSync(this.migraciones, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
      : [];
  }

  async resumenBase(db = this.db.nombre) {
    const sql = "SELECT json_build_object("
      + "'empresa',(SELECT nomb_empre FROM empresa ORDER BY id LIMIT 1),"
      + "'conteos',json_build_object('usuarios',(SELECT count(*) FROM usuario),'leads',(SELECT count(*) FROM leads),"
      + "'clientes',(SELECT count(*) FROM clientes),'cotizaciones',(SELECT count(*) FROM cotizaciones),"
      + "'ordenes_venta',(SELECT count(*) FROM orden_venta),'productos',(SELECT count(*) FROM inventario_items)),"
      + "'migraciones',(SELECT coalesce(json_agg(migration_name ORDER BY migration_name),'[]') FROM _prisma_migrations WHERE finished_at IS NOT NULL))";
    const out = await exec(this.bin('psql'), ['-d', db, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], this.envDb());
    return JSON.parse(out.trim());
  }

  /** Crea y verifica un respaldo. motivo: diario | manual | antes-de-actualizar | antes-de-restaurar */
  async crear({ motivo = 'manual', carpeta = this.carpeta, copiaA = null } = {}) {
    fs.mkdirSync(carpeta, { recursive: true });
    const trabajo = fs.mkdtempSync(path.join(os.tmpdir(), 'alnv-bk-'));
    try {
      const dump = path.join(trabajo, 'db.dump');
      await exec(this.bin('pg_dump'), ['-d', this.db.nombre, '-Fc', '-Z', '0', '-f', dump], this.envDb());
      await exec(this.bin('pg_restore'), ['--list', dump]); // el dump es legible por pg_restore

      const resumen = await this.resumenBase();
      const entradas = [{ nombre: 'db.dump', abs: dump },
        ...F.listarArchivos(this.archivos).map(({ abs, rel }) => ({ nombre: `archivos/${rel}`, abs }))];
      const destino = path.join(carpeta, `ALLNOVATECH-respaldo-${sello()}-${motivo}.allnova`);
      await F.escribir({
        destino,
        clave: this.cripto.clave,
        sal: this.cripto.sal,
        cabecera: { app_version: this.appVersion, creado_en: new Date().toISOString(), motivo, ...resumen, archivos: entradas.length - 1 },
        entradas
      });
      await F.verificar({ archivo: destino, clave: this.cripto.clave });
      this.log(`[respaldo] ${path.basename(destino)} verificado (${(fs.statSync(destino).size / 1048576).toFixed(1)} MB)`);

      if (copiaA) {
        try {
          fs.mkdirSync(copiaA, { recursive: true });
          fs.copyFileSync(destino, path.join(copiaA, path.basename(destino)));
        } catch (e) {
          this.log(`[respaldo] no se pudo copiar a ${copiaA}: ${e.message}`);
        }
      }
      if (motivo === 'diario') this.rotar(carpeta);
      return { archivo: destino, cabecera: F.leerCabecera(destino).cabecera };
    } finally {
      fs.rmSync(trabajo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }

  listar(carpeta = this.carpeta) {
    if (!fs.existsSync(carpeta)) return [];
    return fs.readdirSync(carpeta)
      .filter((f) => f.endsWith('.allnova'))
      .map((f) => {
        const archivo = path.join(carpeta, f);
        try {
          return { archivo, nombre: f, bytes: fs.statSync(archivo).size, ...F.leerCabecera(archivo).cabecera };
        } catch (e) {
          return { archivo, nombre: f, error: e.message };
        }
      })
      .sort((a, b) => String(b.creado_en || '').localeCompare(String(a.creado_en || '')));
  }

  /** Rotación de los "diario": 7 últimos días + 1 por semana (4) + 1 por mes (12). */
  rotar(carpeta = this.carpeta) {
    const diarios = this.listar(carpeta).filter((r) => r.motivo === 'diario' && r.creado_en);
    const conservar = new Set();
    const dias = new Set(); const semanas = new Set(); const meses = new Set();
    for (const r of diarios) {
      const d = new Date(r.creado_en);
      const dia = d.toISOString().slice(0, 10);
      const semana = `${d.getUTCFullYear()}-${Math.floor((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / 6048e5)}`;
      const mes = d.toISOString().slice(0, 7);
      if (dias.size < ROTACION.diarios && !dias.has(dia)) { dias.add(dia); conservar.add(r.archivo); }
      else if (semanas.size < ROTACION.semanales && !semanas.has(semana)) { semanas.add(semana); conservar.add(r.archivo); }
      else if (meses.size < ROTACION.mensuales && !meses.has(mes)) { meses.add(mes); conservar.add(r.archivo); }
    }
    for (const r of diarios) if (!conservar.has(r.archivo)) { fs.rmSync(r.archivo, { force: true }); this.log(`[respaldo] rotado ${r.nombre}`); }
  }

  /** Vista previa antes de restaurar: verifica el código y la compatibilidad. */
  async previsualizar({ archivo, codigo }) {
    const { cabecera, sal } = F.leerCabecera(archivo);
    const clave = codigo ? F.derivarClave(codigo, sal) : this.cripto.clave;
    await F.verificar({ archivo, clave });
    const locales = new Set(this.migracionesLocales());
    const faltan = (cabecera.migraciones || []).filter((m) => !locales.has(m));
    return { cabecera, compatible: faltan.length === 0, faltan, clave };
  }

  /**
   * Restaura. El backend DEBE estar detenido (lo hace quien llama).
   * Devuelve el respaldo de seguridad creado antes de restaurar.
   */
  async restaurar({ archivo, codigo }) {
    const vista = await this.previsualizar({ archivo, codigo });
    if (!vista.compatible) {
      throw Object.assign(new Error('Este respaldo es de una versión más nueva del CRM. Actualiza la aplicación antes de restaurarlo.'), { code: 'RESPALDO_MAS_NUEVO' });
    }
    const seguridad = await this.crear({ motivo: 'antes-de-restaurar' });

    // Junto a la carpeta de datos (mismo disco): rename de archivos sin EXDEV.
    const trabajo = fs.mkdtempSync(path.join(path.dirname(this.archivos), '.restaurando-'));
    const tmpDb = `crm_restaurando_${crypto.randomBytes(3).toString('hex')}`;
    try {
      await F.extraer({ archivo, clave: vista.clave, carpetaDestino: trabajo });
      const su = this.envSu();
      await exec(this.bin('psql'), ['-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${tmpDb} OWNER ${this.db.usuario} ENCODING 'UTF8'`], su);
      await exec(this.bin('pg_restore'), ['-d', tmpDb, '--no-owner', '--role', this.db.usuario, '--exit-on-error', path.join(trabajo, 'db.dump')], su);
      const restaurado = await this.resumenBase(tmpDb);

      // Intercambio: solo ahora se toca lo actual (queda como *_prev).
      const prevDb = `${this.db.nombre}_prev_${sello().replace('-', '_')}`;
      await exec(this.bin('psql'), ['-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
        '-c', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('${this.db.nombre}','${tmpDb}') AND pid <> pg_backend_pid()`,
        '-c', `ALTER DATABASE ${this.db.nombre} RENAME TO ${prevDb}`,
        '-c', `ALTER DATABASE ${tmpDb} RENAME TO ${this.db.nombre}`], su);

      const prevArchivos = `${this.archivos}_prev_${sello()}`;
      if (fs.existsSync(this.archivos)) fs.renameSync(this.archivos, prevArchivos);
      const extraidos = path.join(trabajo, 'archivos');
      if (fs.existsSync(extraidos)) fs.renameSync(extraidos, this.archivos);
      else fs.mkdirSync(this.archivos, { recursive: true });

      this.log(`[restaurar] ${path.basename(archivo)} → ${restaurado.empresa} (anterior conservado como ${prevDb})`);
      return { restaurado, seguridad: seguridad.archivo, anterior: { db: prevDb, archivos: prevArchivos } };
    } catch (e) {
      await exec(this.bin('psql'), ['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${tmpDb}`], this.envSu()).catch(() => {});
      throw e;
    } finally {
      fs.rmSync(trabajo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }

  /**
   * Prueba de restauración (semanal): restaura el último respaldo verificado en
   * una base TEMPORAL y compara los conteos con su cabecera. No toca la base
   * real ni los archivos. Devuelve { ok, respaldo, detalle }.
   */
  async probarRestauracion() {
    const ultimo = this.listar().find((r) => !r.error && r.creado_en);
    if (!ultimo) return { ok: false, respaldo: null, detalle: 'No hay respaldos para probar.' };
    const vista = await this.previsualizar({ archivo: ultimo.archivo, codigo: null });
    if (!vista.compatible) return { ok: false, respaldo: ultimo.nombre, detalle: 'El último respaldo es de una versión más nueva.' };
    const trabajo = fs.mkdtempSync(path.join(os.tmpdir(), 'alnv-prueba-'));
    const tmpDb = `crm_prueba_${crypto.randomBytes(3).toString('hex')}`;
    const su = this.envSu();
    try {
      await F.extraer({ archivo: ultimo.archivo, clave: vista.clave, carpetaDestino: trabajo });
      await exec(this.bin('psql'), ['-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${tmpDb} OWNER ${this.db.usuario} ENCODING 'UTF8'`], su);
      await exec(this.bin('pg_restore'), ['-d', tmpDb, '--no-owner', '--role', this.db.usuario, '--exit-on-error', path.join(trabajo, 'db.dump')], su);
      const r = await this.resumenBase(tmpDb);
      const esperado = vista.cabecera.conteos || {};
      const distintos = Object.keys(esperado).filter((k) => Number(esperado[k]) !== Number(r.conteos?.[k]));
      const ok = distintos.length === 0;
      this.log(`[respaldo] prueba de restauración de ${ultimo.nombre}: ${ok ? 'OK' : 'conteos distintos: ' + distintos.join(', ')}`);
      return { ok, respaldo: ultimo.nombre, detalle: ok ? 'Se restauró completo en una base de prueba.' : `Conteos distintos: ${distintos.join(', ')}` };
    } finally {
      await exec(this.bin('psql'), ['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${tmpDb}`], su).catch(() => {});
      fs.rmSync(trabajo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }

  /**
   * Limpia lo que dejan las restauraciones: bases y carpetas *_prev_* de más
   * de `dias` días (siempre conserva las `conservar` más recientes) y restos
   * de restauraciones o pruebas interrumpidas. Antes de cada restauración se
   * creó y verificó un respaldo, así que nada se pierde.
   */
  async limpiarAnteriores({ dias = 30, conservar = 2, ahora = new Date() } = {}) {
    const limite = ahora.getTime() - dias * 864e5;
    const fechaDe = (nombre) => {
      const m = /_prev_(\d{8})[_-](\d{6})/.exec(nombre);
      return m ? Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[2].slice(0, 2), +m[2].slice(2, 4), +m[2].slice(4, 6)) : null;
    };
    const elegir = (nombres) => nombres
      .map((n) => ({ n, t: fechaDe(n) })).filter((x) => x.t !== null)
      .sort((a, b) => b.t - a.t)
      .filter((x, i) => i >= conservar && x.t < limite)
      .map((x) => x.n);
    const borrados = { bases: [], carpetas: [] };
    const su = this.envSu();

    const out = await exec(this.bin('psql'), ['-d', 'postgres', '-At', '-c', 'SELECT datname FROM pg_database'], su);
    const bases = out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const prefijo = `${this.db.nombre}_prev_`;
    const huerfanas = bases.filter((b) => /^crm_(restaurando|prueba)_[0-9a-f]{6}$/.test(b));
    for (const b of [...elegir(bases.filter((x) => x.startsWith(prefijo))), ...huerfanas]) {
      try {
        await exec(this.bin('psql'), ['-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE IF EXISTS "${b.replace(/"/g, '')}"`], su);
        borrados.bases.push(b);
      } catch (e) { this.log(`[respaldo] no se pudo borrar la base ${b}: ${e.message}`); }
    }

    const padre = path.dirname(this.archivos);
    const base = path.basename(this.archivos);
    const entradas = fs.existsSync(padre) ? fs.readdirSync(padre) : [];
    const carpetasPrev = elegir(entradas.filter((n) => n.startsWith(`${base}_prev_`)));
    const restos = entradas.filter((n) => n.startsWith('.restaurando-'));
    for (const c of [...carpetasPrev, ...restos]) {
      try { fs.rmSync(path.join(padre, c), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); borrados.carpetas.push(c); } catch (e) { this.log(`[respaldo] no se pudo borrar ${c}: ${e.message}`); }
    }
    if (borrados.bases.length || borrados.carpetas.length) this.log(`[respaldo] limpieza: ${borrados.bases.length} base(s) y ${borrados.carpetas.length} carpeta(s) antiguas`);
    return borrados;
  }
}

module.exports = { BackupManager, ROTACION };
