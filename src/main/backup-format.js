/**
 * Formato de respaldo .allnova (v1) — cifrado, comprimido y autenticado.
 *
 *   "ALNV" | versión (1 byte) | sal (16) | iv (12) | longitud cabecera (4) | cabecera JSON (en claro)
 *   | cuerpo cifrado AES-256-GCM( gzip( registros ) ) | tag GCM (16)
 *
 * - La cabecera en claro solo trae metadatos NO sensibles (versión, fecha,
 *   empresa, conteos) para la vista previa; va autenticada como AAD, así que
 *   no se puede alterar sin que falle el descifrado.
 * - Clave = scrypt(código de recuperación, sal). Con el código se restaura en
 *   cualquier PC; sin él, nadie puede abrir el archivo.
 * - Registros: tipo (1: archivo) | nombre (u16 + utf8) | tamaño (u64) | datos.
 *
 * Node puro (sin Electron): se prueba con node --test.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');

const MAGIA = Buffer.from('ALNV');
const VERSION = 1;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function derivarClave(codigo, sal) {
  const limpio = String(codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (limpio.length < 16) throw new Error('Código de recuperación inválido');
  return crypto.scryptSync(limpio, sal, 32, SCRYPT);
}

/** Código legible: 24 caracteres base32 sin ambigüedades, en grupos de 4. */
function generarCodigo() {
  const alfabeto = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const bytes = crypto.randomBytes(24);
  const c = [...bytes].map((b) => alfabeto[b % alfabeto.length]).join('');
  return c.match(/.{4}/g).join('-');
}

function listarArchivos(raiz, base = raiz) {
  if (!fs.existsSync(raiz)) return [];
  const out = [];
  for (const e of fs.readdirSync(raiz, { withFileTypes: true })) {
    const p = path.join(raiz, e.name);
    if (e.isDirectory()) out.push(...listarArchivos(p, base));
    else if (e.isFile()) out.push({ abs: p, rel: path.relative(base, p).split(path.sep).join('/') });
  }
  return out;
}

/** Genera los registros (dump de la BD + archivos de la app) como stream. */
async function* registros(entradas) {
  for (const { nombre, abs } of entradas) {
    const n = Buffer.from(nombre, 'utf8');
    const tam = fs.statSync(abs).size;
    const cab = Buffer.alloc(1 + 2 + n.length + 8);
    cab.writeUInt8(1, 0);
    cab.writeUInt16BE(n.length, 1);
    n.copy(cab, 3);
    cab.writeBigUInt64BE(BigInt(tam), 3 + n.length);
    yield cab;
    for await (const chunk of fs.createReadStream(abs)) yield chunk;
  }
}

/**
 * Escribe un .allnova.
 * @param {object} o
 * @param {string} o.destino   ruta del archivo a crear
 * @param {Buffer} o.clave     32 bytes (derivarClave)
 * @param {Buffer} o.sal       16 bytes usados para derivar la clave
 * @param {object} o.cabecera  metadatos en claro (sin secretos)
 * @param {{nombre:string, abs:string}[]} o.entradas
 */
async function escribir({ destino, clave, sal, cabecera, entradas }) {
  const iv = crypto.randomBytes(12);
  const cabJson = Buffer.from(JSON.stringify({ ...cabecera, formato: VERSION }), 'utf8');
  const pre = Buffer.alloc(4 + 1 + 16 + 12 + 4);
  MAGIA.copy(pre, 0);
  pre.writeUInt8(VERSION, 4);
  sal.copy(pre, 5);
  iv.copy(pre, 21);
  pre.writeUInt32BE(cabJson.length, 33);

  const cifrador = crypto.createCipheriv('aes-256-gcm', clave, iv);
  cifrador.setAAD(Buffer.concat([pre, cabJson]));
  const tmp = `${destino}.parcial`;
  const salida = fs.createWriteStream(tmp);
  salida.write(Buffer.concat([pre, cabJson]));
  await pipeline(Readable.from(registros(entradas)), zlib.createGzip({ level: 6 }), cifrador, salida, { end: false });
  await new Promise((res, rej) => salida.end(cifrador.getAuthTag(), (e) => (e ? rej(e) : res())));
  fs.renameSync(tmp, destino);
  return destino;
}

/** Lee solo la cabecera en claro (vista previa). No requiere código. */
function leerCabecera(archivo) {
  const fd = fs.openSync(archivo, 'r');
  try {
    const pre = Buffer.alloc(37);
    fs.readSync(fd, pre, 0, 37, 0);
    if (!pre.subarray(0, 4).equals(MAGIA)) throw new Error('No es un respaldo de ALLNOVATECH CRM');
    const version = pre.readUInt8(4);
    if (version !== VERSION) throw new Error(`Versión de respaldo no soportada (${version})`);
    const largo = pre.readUInt32BE(33);
    const cab = Buffer.alloc(largo);
    fs.readSync(fd, cab, 0, largo, 37);
    return { pre, cabJson: cab, cabecera: JSON.parse(cab.toString('utf8')), sal: pre.subarray(5, 21), iv: pre.subarray(21, 33), inicioCuerpo: 37 + largo };
  } finally {
    fs.closeSync(fd);
  }
}

/** Parser de registros (stream) que escribe cada archivo en carpetaDestino. */
function extractor(carpetaDestino, alArchivo) {
  let buf = Buffer.alloc(0);
  let actual = null; // { nombre, restante, ws }
  const pendientes = [];
  const t = new Transform({
    transform(chunk, _enc, cb) {
      buf = Buffer.concat([buf, chunk]);
      try {
        while (buf.length) {
          if (!actual) {
            if (buf.length < 3) break;
            const largoNombre = buf.readUInt16BE(1);
            if (buf.length < 3 + largoNombre + 8) break;
            const nombre = buf.subarray(3, 3 + largoNombre).toString('utf8');
            const tam = Number(buf.readBigUInt64BE(3 + largoNombre));
            buf = buf.subarray(3 + largoNombre + 8);
            // Sin rutas absolutas ni "..": todo queda dentro de carpetaDestino.
            const destino = path.resolve(carpetaDestino, nombre);
            if (!destino.startsWith(path.resolve(carpetaDestino) + path.sep)) throw new Error(`Ruta inválida en el respaldo: ${nombre}`);
            fs.mkdirSync(path.dirname(destino), { recursive: true });
            const ws = fs.createWriteStream(destino);
            pendientes.push(new Promise((r, j) => { ws.on('finish', r); ws.on('error', j); }));
            actual = { nombre, restante: tam, ws };
            if (alArchivo) alArchivo(nombre, tam);
          }
          const n = Math.min(actual.restante, buf.length);
          if (n) { actual.ws.write(buf.subarray(0, n)); buf = buf.subarray(n); actual.restante -= n; }
          if (actual.restante === 0) { actual.ws.end(); actual = null; } else break;
        }
        cb();
      } catch (e) { cb(e); }
    },
    flush(cb) {
      if (actual || buf.length) return cb(new Error('Respaldo incompleto o dañado'));
      Promise.all(pendientes).then(() => cb(), cb);
    },
    // Si el descifrado falla a mitad, cerrar el archivo en curso (en Windows
    // un descriptor abierto impide borrar la carpeta de extracción).
    destroy(err, cb) {
      if (actual) { actual.ws.destroy(); actual = null; }
      Promise.allSettled(pendientes).then(() => cb(err));
    }
  });
  return t;
}

/**
 * Descifra y extrae un .allnova en carpetaDestino. Falla (sin dejar nada a
 * medias fuera de carpetaDestino) si el código es incorrecto o el archivo fue
 * alterado.
 */
async function extraer({ archivo, codigo, clave, carpetaDestino }) {
  const { pre, cabJson, cabecera, sal, iv, inicioCuerpo } = leerCabecera(archivo);
  const k = clave || derivarClave(codigo, sal);
  const total = fs.statSync(archivo).size;
  if (total < inicioCuerpo + 16) throw new Error('Respaldo incompleto o dañado');
  const tag = Buffer.alloc(16);
  const fd = fs.openSync(archivo, 'r');
  fs.readSync(fd, tag, 0, 16, total - 16);
  fs.closeSync(fd);

  const cuerpo = () => fs.createReadStream(archivo, { start: inicioCuerpo, end: total - 17 });
  const descifrador = () => {
    const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
    d.setAAD(Buffer.concat([pre, cabJson]));
    d.setAuthTag(tag);
    return d;
  };
  const invalido = (e) => (/unable to authenticate|Unsupported state|bad decrypt|incorrect header check|invalid|unexpected end/i.test(e.message)
    ? Object.assign(new Error('Código de recuperación incorrecto o respaldo dañado'), { code: 'RESPALDO_INVALIDO' })
    : e);

  // 1ª pasada: autenticar TODO el archivo sin escribir nada. GCM solo valida
  // al final, así que extraer directamente podría dejar archivos de un
  // respaldo alterado o descifrado con el código equivocado.
  try {
    await pipeline(cuerpo(), descifrador(), zlib.createGunzip(), new (require('stream').Writable)({ write(_c, _e, cb) { cb(); } }));
  } catch (e) {
    throw invalido(e);
  }

  // 2ª pasada: extraer (ya autenticado).
  fs.mkdirSync(carpetaDestino, { recursive: true });
  const archivos = [];
  try {
    await pipeline(cuerpo(), descifrador(), zlib.createGunzip(), extractor(carpetaDestino, (n) => archivos.push(n)));
  } catch (e) {
    throw invalido(e);
  }
  return { cabecera, archivos };
}

/** Verifica integridad y código sin extraer (para "verificar respaldo"). */
async function verificar({ archivo, codigo, clave }) {
  const { pre, cabJson, cabecera, sal, iv, inicioCuerpo } = leerCabecera(archivo);
  const k = clave || derivarClave(codigo, sal);
  const total = fs.statSync(archivo).size;
  if (total < inicioCuerpo + 16) throw Object.assign(new Error('Respaldo incompleto o dañado'), { code: 'RESPALDO_INVALIDO' });
  const tag = Buffer.alloc(16);
  const fd = fs.openSync(archivo, 'r');
  fs.readSync(fd, tag, 0, 16, total - 16);
  fs.closeSync(fd);
  const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
  d.setAAD(Buffer.concat([pre, cabJson]));
  d.setAuthTag(tag);
  let n = 0;
  try {
    await pipeline(fs.createReadStream(archivo, { start: inicioCuerpo, end: total - 17 }), d, zlib.createGunzip(),
      new (require('stream').Writable)({ write(c, _e, cb) { n += c.length; cb(); } }));
  } catch (_) {
    throw Object.assign(new Error('Código de recuperación incorrecto o respaldo dañado'), { code: 'RESPALDO_INVALIDO' });
  }
  return { cabecera, bytes: n };
}

module.exports = { derivarClave, generarCodigo, listarArchivos, escribir, leerCabecera, extraer, verificar };
