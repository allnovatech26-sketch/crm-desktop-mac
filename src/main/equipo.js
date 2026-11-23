/**
 * Modo equipo: varias PC de la misma red trabajan sobre UNA base de datos.
 *
 *   PC principal (servidor): además del backend local (127.0.0.1), abre un
 *   puerto HTTPS en la red (0.0.0.0:54500) que reenvía al backend. PostgreSQL
 *   y el backend siguen escuchando solo en 127.0.0.1.
 *
 *   Otras PC (clientes): no arrancan PostgreSQL ni backend; la ventana abre
 *   https://<ip-principal>:54500 y SOLO acepta el certificado emparejado.
 *
 * Seguridad:
 *   - Certificado autofirmado propio de cada PC principal (RSA 2048, 10 años),
 *     generado con New-SelfSignedCertificate y guardado como PFX con una clave
 *     aleatoria (en secrets.bin, DPAPI).
 *   - Emparejamiento: la PC principal muestra un código = primeros 12 hex del
 *     SHA-256 del certificado. El cliente lo comprueba al conectar y desde ese
 *     momento fija (pinning) la huella completa.
 *   - Desde la red no se alcanzan las rutas internas de Desktop
 *     (/api/v1/desktop/*), salvo GET /api/v1/desktop/estado.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PUERTO_EQUIPO = 54500;
const LARGO_CODIGO = 12;
const VENTANA_CONECTADOS_MS = 2 * 60 * 1000;

// ── Certificado ─────────────────────────────────────────────────────────
const SCRIPT_CERT = `
$ErrorActionPreference = 'Stop'
$c = New-SelfSignedCertificate -Subject "CN=ALLNOVATECH CRM" -FriendlyName "ALLNOVATECH CRM (red local)" -CertStoreLocation Cert:\\CurrentUser\\My -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(10) -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.1")
try {
  $p = ConvertTo-SecureString -String $env:ALLNOVA_PFX_PASS -Force -AsPlainText
  try { Export-PfxCertificate -Cert $c -FilePath $env:ALLNOVA_PFX_FILE -Password $p -CryptoAlgorithmOption AES256_SHA256 | Out-Null }
  catch { Export-PfxCertificate -Cert $c -FilePath $env:ALLNOVA_PFX_FILE -Password $p | Out-Null }
  [System.IO.File]::WriteAllBytes($env:ALLNOVA_DER_FILE, $c.RawData)
} finally { Remove-Item -Path ("Cert:\\CurrentUser\\My\\" + $c.Thumbprint) -DeleteKey }
`;

function huellaHex(der) {
  return crypto.createHash('sha256').update(der).digest('hex');
}

/** Formato de Electron (Certificate.fingerprint): "sha256/<base64>". */
function huellaElectron(hex) {
  return 'sha256/' + Buffer.from(hex, 'hex').toString('base64');
}

function codigoDeHuella(hex) {
  const c = hex.slice(0, LARGO_CODIGO).toUpperCase();
  return c.match(/.{1,4}/g).join('-');
}

function normalizarCodigo(c) {
  return String(c || '').toUpperCase().replace(/[^0-9A-F]/g, '');
}

/**
 * Crea (una vez) el certificado de la PC principal. Devuelve { pfx, der }.
 * @param {string} carpeta  donde guardar equipo.pfx / equipo.der
 * @param {string} clave    clave del PFX (de secrets.bin)
 */
const creando = new Map(); // carpeta → promesa en curso (dos llamadas a la vez crean un solo certificado)
function asegurarCertificado(carpeta, clave) {
  const clave_ = path.resolve(carpeta).toLowerCase();
  if (!creando.has(clave_)) {
    const p = crearCertificado(carpeta, clave).finally(() => creando.delete(clave_));
    creando.set(clave_, p);
  }
  return creando.get(clave_);
}

function crearCertificado(carpeta, clave) {
  const pfx = path.join(carpeta, 'equipo.pfx');
  const der = path.join(carpeta, 'equipo.der');
  if (fs.existsSync(pfx) && fs.existsSync(der)) {
    return Promise.resolve({ pfx: fs.readFileSync(pfx), der: fs.readFileSync(der) });
  }
  fs.mkdirSync(carpeta, { recursive: true });
  const script = path.join(os.tmpdir(), `allnova-cert-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(script, SCRIPT_CERT);
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true,
      timeout: 60000,
      env: { ...process.env, ALLNOVA_PFX_PASS: clave, ALLNOVA_PFX_FILE: pfx + '.tmp', ALLNOVA_DER_FILE: der + '.tmp' }
    }, (err, _out, errOut) => {
      try { fs.unlinkSync(script); } catch (_) { /* nada */ }
      if (err) {
        for (const f of [pfx + '.tmp', der + '.tmp']) { try { fs.unlinkSync(f); } catch (_) { /* nada */ } }
        return reject(new Error(`No se pudo crear el certificado de la red local: ${String(errOut || err.message).trim().slice(0, 400)}`));
      }
      fs.renameSync(der + '.tmp', der);
      fs.renameSync(pfx + '.tmp', pfx);
      resolve({ pfx: fs.readFileSync(pfx), der: fs.readFileSync(der) });
    });
  });
}

/** Direcciones IPv4 de la red local (para mostrarlas en la PC principal). */
function direccionesLocales() {
  const out = [];
  for (const [nombre, lista] of Object.entries(os.networkInterfaces())) {
    for (const i of lista || []) {
      if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) continue;
      out.push({ ip: i.address, interfaz: nombre });
    }
  }
  return out;
}

// ── Servidor (PC principal) ─────────────────────────────────────────────
/**
 * ¿Una petición de la red puede pasar? Las rutas internas de Desktop (WhatsApp
 * entrante, instalar, restablecer admin…) son solo para este equipo.
 */
function rutaPermitida(metodo, url) {
  const ruta = String(url || '').split('?')[0];
  if (/^\/api\/v1\/desktop(\/|$)/i.test(ruta)) {
    return metodo === 'GET' && /^\/api\/v1\/desktop\/estado\/?$/i.test(ruta);
  }
  return true;
}

/** Cabeceras para el backend: origen local, IP real del cliente y sin token interno. */
function cabecerasHaciaBackend(headers, { origenBackend, ipCliente }) {
  const h = { ...headers };
  delete h['x-allnova-desktop-token'];
  delete h['x-forwarded-host'];
  // La página es del mismo origen para el navegador; el backend solo conoce su
  // origen local (CORS de Express y de Socket.IO).
  if (h.origin) h.origin = origenBackend;
  h['x-forwarded-for'] = ipCliente; // se reemplaza: un cliente no puede falsear su IP
  h['x-forwarded-proto'] = 'https';
  return h;
}

class ServidorEquipo {
  /**
   * @param {object} o
   * @param {() => number} o.puertoBackend  puerto actual del backend local
   * @param {(m: string) => void} o.log
   */
  constructor({ puertoBackend, log }) {
    this.puertoBackend = puertoBackend;
    this.log = log;
    this.server = null;
    this.puerto = null;
    this.huella = null;
    this.vistos = new Map(); // ip → último acceso (ms)
    this.sockets = new Set();
  }

  get activo() { return !!this.server; }

  conectados() {
    const limite = Date.now() - VENTANA_CONECTADOS_MS;
    const lista = [];
    for (const [ip, t] of this.vistos) {
      if (t >= limite) lista.push({ ip, ultimo: new Date(t).toISOString() });
      else this.vistos.delete(ip);
    }
    return lista;
  }

  async iniciar({ pfx, der, clave, puertoPreferido = PUERTO_EQUIPO }) {
    if (this.server) return this.puerto;
    this.huella = huellaHex(der);
    const server = https.createServer({ pfx, passphrase: clave, minVersion: 'TLSv1.2' }, (req, res) => this.reenviar(req, res));
    server.on('upgrade', (req, socket, head) => this.reenviarUpgrade(req, socket, head));
    server.on('connection', (s) => { this.sockets.add(s); s.once('close', () => this.sockets.delete(s)); });
    server.on('clientError', (_e, s) => { try { s.destroy(); } catch (_) { /* nada */ } });
    server.keepAliveTimeout = 65000;
    let puerto = puertoPreferido;
    for (let intento = 0; ; intento++) {
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(puerto, '0.0.0.0', () => { server.off('error', reject); resolve(); });
        });
        break;
      } catch (e) {
        if (e.code !== 'EADDRINUSE' || intento >= 20) throw new Error(`No se pudo abrir el puerto de la red local (${e.message}).`);
        puerto++;
      }
    }
    this.server = server;
    this.puerto = server.address().port;
    this.log(`[equipo] PC principal escuchando en 0.0.0.0:${puerto} (código ${codigoDeHuella(this.huella)})`);
    return puerto;
  }

  marcar(req) {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (ip) this.vistos.set(ip, Date.now());
    return ip;
  }

  reenviar(req, res) {
    const ipCliente = this.marcar(req);
    if (!rutaPermitida(req.method, req.url)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, code: 'SOLO_PC_PRINCIPAL', message: 'Esta acción solo se puede hacer en la PC principal.' }));
      return;
    }
    const puerto = this.puertoBackend();
    const origenBackend = `http://127.0.0.1:${puerto}`;
    const preq = http.request({
      host: '127.0.0.1', port: puerto, method: req.method, path: req.url,
      headers: cabecerasHaciaBackend(req.headers, { origenBackend, ipCliente })
    }, (pres) => {
      res.writeHead(pres.statusCode, pres.statusMessage, pres.headers);
      pres.pipe(res);
    });
    preq.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '5' });
        res.end('<!doctype html><meta charset="utf-8"><title>ALLNOVATECH CRM</title><p style="font-family:sans-serif;padding:24px">La PC principal se está reiniciando. Se reintentará en unos segundos…</p><script>setTimeout(()=>location.reload(),5000)</script>');
      } else res.destroy();
    });
    req.on('aborted', () => preq.destroy());
    req.pipe(preq);
  }

  reenviarUpgrade(req, socket, head) {
    const ipCliente = this.marcar(req);
    if (!rutaPermitida(req.method, req.url)) { socket.destroy(); return; }
    const puerto = this.puertoBackend();
    const headers = cabecerasHaciaBackend(req.headers, { origenBackend: `http://127.0.0.1:${puerto}`, ipCliente });
    const destino = net.connect(puerto, '127.0.0.1', () => {
      let crudo = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (const [k, v] of Object.entries(headers)) {
        for (const val of Array.isArray(v) ? v : [v]) crudo += `${k}: ${val}\r\n`;
      }
      destino.write(crudo + '\r\n');
      if (head && head.length) destino.write(head);
      destino.pipe(socket);
      socket.pipe(destino);
    });
    const cerrar = () => { socket.destroy(); destino.destroy(); };
    destino.on('error', cerrar);
    socket.on('error', cerrar);
    socket.on('close', () => destino.destroy());
    destino.on('close', () => socket.destroy());
  }

  detener() {
    if (!this.server) return Promise.resolve();
    const s = this.server;
    this.server = null;
    this.vistos.clear();
    return new Promise((resolve) => {
      s.close(() => resolve());
      for (const sock of this.sockets) { try { sock.destroy(); } catch (_) { /* nada */ } }
      this.sockets.clear();
      setTimeout(resolve, 3000).unref?.();
    });
  }

  info() {
    return {
      activo: this.activo,
      puerto: this.puerto,
      codigo: this.huella ? codigoDeHuella(this.huella) : null,
      direcciones: this.activo ? direccionesLocales().map((d) => ({ ...d, url: `https://${d.ip}:${this.puerto}` })) : [],
      conectados: this.activo ? this.conectados() : []
    };
  }
}

// ── Cliente (otras PC) ──────────────────────────────────────────────────
function validarHost(host) {
  const h = String(host || '').trim();
  if (net.isIPv4(h)) return h;
  if (/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(h) && h.length <= 253) return h.toLowerCase();
  return null;
}

/** Lee la huella del certificado que presenta la PC principal (sin confiar todavía en él). */
function leerHuellaRemota(host, puerto, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: puerto, rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host, timeout: timeoutMs }, () => {
      const c = s.getPeerCertificate(true);
      s.end();
      if (!c || !c.raw) return reject(Object.assign(new Error('La PC principal no presentó un certificado.'), { code: 'SIN_CERTIFICADO' }));
      resolve(huellaHex(c.raw));
    });
    s.on('timeout', () => { s.destroy(); reject(Object.assign(new Error('La PC principal no responde. Revisa que el CRM esté abierto en ella, que el modo equipo esté activado y que ambas PC estén en la misma red.'), { code: 'SIN_RESPUESTA' })); });
    s.on('error', (e) => reject(Object.assign(new Error(
      e.code === 'ECONNREFUSED' ? 'La PC principal rechazó la conexión. Revisa que el modo equipo esté activado y la dirección/puerto.'
        : e.code === 'ENOTFOUND' ? 'No se encontró esa dirección en la red.'
          : `No se pudo conectar con la PC principal (${e.code || e.message}).`
    ), { code: 'SIN_RESPUESTA' })));
  });
}

/**
 * Emparejar con la PC principal: comprueba el código y devuelve la huella completa.
 * @returns {Promise<{ host, puerto, huella }>}
 */
async function emparejar({ host, puerto, codigo }) {
  const h = validarHost(host);
  if (!h) throw Object.assign(new Error('Escribe la dirección de la PC principal (por ejemplo 192.168.1.20).'), { code: 'DIRECCION_INVALIDA' });
  const p = Number(puerto || PUERTO_EQUIPO);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw Object.assign(new Error('Puerto inválido.'), { code: 'DIRECCION_INVALIDA' });
  const cod = normalizarCodigo(codigo);
  if (cod.length !== LARGO_CODIGO) throw Object.assign(new Error('El código de emparejamiento tiene 12 caracteres (por ejemplo A1B2-C3D4-E5F6).'), { code: 'CODIGO_INVALIDO' });
  const huella = await leerHuellaRemota(h, p);
  const a = Buffer.from(huella.slice(0, LARGO_CODIGO).toUpperCase());
  const b = Buffer.from(cod);
  if (!crypto.timingSafeEqual(a, b)) {
    throw Object.assign(new Error('El código no coincide con el de la PC principal. Revísalo en la PC principal: Configuración → Trabajo en red.'), { code: 'CODIGO_INCORRECTO' });
  }
  return { host: h, puerto: p, huella };
}

/** ¿Este certificado (de Electron) es el emparejado? */
function certificadoEsDelEquipo(certificado, huella) {
  return !!certificado && !!huella && certificado.fingerprint === huellaElectron(huella);
}

module.exports = {
  PUERTO_EQUIPO,
  ServidorEquipo,
  asegurarCertificado,
  direccionesLocales,
  emparejar,
  leerHuellaRemota,
  certificadoEsDelEquipo,
  codigoDeHuella,
  huellaHex,
  huellaElectron,
  rutaPermitida,
  cabecerasHaciaBackend,
  validarHost
};
