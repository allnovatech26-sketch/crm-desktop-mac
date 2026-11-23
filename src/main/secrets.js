/**
 * Secretos locales de la instalación, generados en el primer arranque y
 * guardados cifrados con safeStorage (DPAPI en Windows, ligado al usuario).
 * Nunca hay contraseñas por defecto ni secretos embebidos en el instalador.
 */
const fs = require('fs');
const crypto = require('crypto');
const { safeStorage } = require('electron');

const aleatorio = (n = 32) => crypto.randomBytes(n).toString('base64url');

/**
 * Claves VAPID propias de esta PC (P-256) para las notificaciones en el
 * celular (Web Push). Formato de web-push: pública = punto sin comprimir
 * (65 bytes) y privada = 32 bytes, ambas en base64url.
 */
function clavesVapid() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' });
  const x = Buffer.from(j.x, 'base64url');
  const y = Buffer.from(j.y, 'base64url');
  return { vapidPublica: Buffer.concat([Buffer.from([4]), x, y]).toString('base64url'), vapidPrivada: j.d };
}

function generar() {
  return {
    pgSuperusuario: 'allnova_admin',
    pgSuperPassword: aleatorio(24),
    dbUsuario: 'allnova_app',
    dbPassword: aleatorio(24),
    dbNombre: 'crm',
    jwtSecret: aleatorio(48),
    jwtRefreshSecret: aleatorio(48),
    // 64 hex = clave AES-256 directa para secretCrypto (CONNECTOR_SECRET_KEY).
    connectorKey: crypto.randomBytes(32).toString('hex'),
    encryptionKey: crypto.randomBytes(32).toString('hex'),
    ...nuevoCodigoRecuperacion(),
    // Canal interno Electron → backend (recuperar acceso del admin): solo el
    // proceso principal lo conoce; el navegador nunca lo ve.
    desktopToken: aleatorio(32),
    ...clavesVapid(),
    creado_en: new Date().toISOString()
  };
}

/**
 * Código de recuperación: abre los respaldos en cualquier PC y permite
 * restablecer la contraseña del administrador. La clave de respaldo se deriva
 * de él (scrypt) y se guarda para no pedirlo en cada respaldo automático.
 */
function nuevoCodigoRecuperacion() {
  const F = require('./backup-format');
  const codigo = F.generarCodigo();
  const sal = crypto.randomBytes(16);
  return {
    codigoRecuperacion: codigo,
    codigoMostrado: false,
    respaldoSal: sal.toString('hex'),
    respaldoClave: F.derivarClave(codigo, sal).toString('hex')
  };
}

function cargarOCrear(archivo) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('El cifrado del sistema (DPAPI) no está disponible en este equipo.');
  }
  if (fs.existsSync(archivo)) {
    const s = JSON.parse(safeStorage.decryptString(fs.readFileSync(archivo)));
    // Instalaciones anteriores a los respaldos: completar lo que falte.
    if (!s.codigoRecuperacion || !s.desktopToken || !s.vapidPublica) {
      Object.assign(s, s.codigoRecuperacion ? {} : nuevoCodigoRecuperacion(), s.desktopToken ? {} : { desktopToken: aleatorio(32) },
        s.vapidPublica ? {} : clavesVapid());
      guardar(archivo, s);
    }
    return s;
  }
  const s = generar();
  guardar(archivo, s);
  return s;
}

function guardar(archivo, s) {
  fs.writeFileSync(archivo, safeStorage.encryptString(JSON.stringify(s)));
}

module.exports = { cargarOCrear, guardar, clavesVapid };
