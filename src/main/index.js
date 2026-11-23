/**
 * ALLNOVATECH CRM Desktop — proceso principal de Electron.
 *
 * Arranque: instancia única → secretos (DPAPI) → PostgreSQL local (initdb la
 * primera vez + rol/base de la app) → [si cambió la versión: respaldo
 * verificado] → migraciones (si fallan: modo recuperación) → backend → ventana.
 * Primera vez: abre el asistente /instalacion. Después: /login.
 * Respaldo diario automático. Cierre: backend (SIGTERM) → PostgreSQL (fast).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { app, BrowserWindow, dialog, shell, Menu, ipcMain, session } = require('electron');
const { paths, asegurarCarpetas, leerConfig, guardarConfig } = require('./paths');
const { cargarOCrear, guardar: guardarSecretos } = require('./secrets');
const { PgManager, elegirPuerto } = require('./pg-manager');
const { BackendHost } = require('./backend-host');
const { BackupManager } = require('./backup-manager');
const { LicenseAgent } = require('./license-agent');
const { iniciarActualizaciones, avisarVersionMac } = require('./updater');
const equipo = require('./equipo');

// Oficina de licencias de ALLNOVATECH (la misma de AgroNova y NovaControl).
const LICENCIAS_API = process.env.ALLNOVA_LICENCIAS_API || 'https://licencias.all-novatech.com';
// Puente de WhatsApp (Cloudflare): recibe de Meta y entrega a esta PC, cifrado.
const PUENTE_WHATSAPP = process.env.ALLNOVA_PUENTE_WHATSAPP || 'https://conecta.all-novatech.com';
const { PuenteWhatsApp } = require('./whatsapp-puente');
const { ConexionMeta } = require('./meta-conexion');
// Acceso desde fuera de la oficina y desde el celular (túnel de salida por Cloudflare).
const PUENTE_REMOTO = process.env.ALLNOVA_PUENTE_REMOTO || 'https://remoto.all-novatech.com';
const { AccesoRemoto } = require('./acceso-remoto');
let accesoRemoto = null;
let whatsapp = null;
let conexionMeta = null;

const HORAS_ENTRE_DIARIOS = 20;
// Autoprueba de punta a punta: SOLO en desarrollo (nunca en la app empaquetada).
if (!app.isPackaged && process.argv.includes('--autoprueba') && !process.env.ALLNOVA_AUTOPRUEBA) process.env.ALLNOVA_AUTOPRUEBA = '1';
const autoprueba = !app.isPackaged && !!process.env.ALLNOVA_AUTOPRUEBA;

let ventana = null;
let pg = null;
let backend = null;
let respaldos = null;
let secretos = null;
let licencias = null;

/** Edición + estado de licencia para el backend. En desarrollo, ALLNOVA_EDICION fuerza la edición. */
function licBackend() {
  const p = licencias.paraBackend();
  if (!app.isPackaged && process.env.ALLNOVA_EDICION) p.edicion = process.env.ALLNOVA_EDICION;
  return p;
}
let ctx = null; // { puertoApp, databaseUrl, origen }
// Trabajo en red: 'local' (PC principal o sola) | 'cliente' (usa la base de otra PC).
let modoApp = 'local';
// En Mac el CRM solo se conecta a la PC principal (Windows): la base, la
// licencia, los respaldos y WhatsApp viven allí. No trae PostgreSQL ni backend.
const SOLO_CLIENTE = process.platform === 'darwin' || (!app.isPackaged && process.env.ALLNOVA_SOLO_CLIENTE === '1');
let servidorEquipo = null;
let cierreConfirmado = false;
const INICIO = path.join(__dirname, '..', 'inicio', 'inicio.html');
let cerrando = false;
let ocupado = false; // respaldo/restauración en curso

function log(msg) {
  const linea = `${new Date().toISOString()} ${msg}\n`;
  try { fs.appendFileSync(path.join(paths.logs, 'desktop.log'), linea); } catch (_) {}
  if (!paths.empaquetado) process.stdout.write(linea);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Si la ventana ya se cerró (la app se está apagando), no hay nada que
    // enfocar: tocar una ventana destruida lanza y tumba el apagado ordenado,
    // dejando PostgreSQL huérfano.
    if (cerrando || !ventana || ventana.isDestroyed()) return;
    if (ventana.isMinimized()) ventana.restore();
    ventana.focus();
  });
  // El preload pregunta el modo de forma síncrona (decide qué API expone).
  ipcMain.on('app:modo', (e) => { e.returnValue = modoApp; });
  app.whenReady().then(arrancar);
}

function crearVentana() {
  ventana = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: 'ALLNOVATECH CRM',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '..', 'preload', 'index.js')
    }
  });
  // En Mac sin menú no funcionan ⌘C/⌘V/⌘Q: se deja el menú mínimo del sistema.
  Menu.setApplicationMenu(process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    : null);
  ventana.on('close', (e) => {
    const conectados = servidorEquipo?.activo ? servidorEquipo.conectados().length : 0;
    const remotos = accesoRemoto?.enLinea ? accesoRemoto.conectados().length : 0;
    if (cierreConfirmado || cerrando || (!conectados && !remotos)) return;
    const quienes = [conectados ? `${conectados} PC conectada(s) en la red` : '', remotos ? `${remotos} conexión(es) desde fuera de la oficina o el celular` : ''].filter(Boolean).join(' y ');
    const r = dialog.showMessageBoxSync(ventana, {
      type: 'warning', title: 'ALLNOVATECH CRM', buttons: ['Cerrar de todos modos', 'Cancelar'], defaultId: 1, cancelId: 1,
      message: `Hay ${quienes} usando esta PC principal.`,
      detail: 'Si cierras el CRM aquí, se desconectan hasta que lo vuelvas a abrir. Lo que estén escribiendo sin guardar se puede perder.'
    });
    if (r === 0) cierreConfirmado = true; else e.preventDefault();
  });
  ventana.loadFile(paths.splash);
  ventana.once('ready-to-show', () => ventana.show());
  return ventana;
}

/** La ventana solo navega dentro del CRM (local o de la PC principal); lo externo va al navegador. */
let origenPermitido = null;
let navegacionRestringida = false;
const esDelCrm = (url) => !!origenPermitido && (url === origenPermitido || url.startsWith(origenPermitido + '/'));
function restringirNavegacion(origen) {
  origenPermitido = origen;
  if (navegacionRestringida) return;
  navegacionRestringida = true;
  ventana.webContents.setWindowOpenHandler(({ url }) => {
    if (!esDelCrm(url) && /^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: esDelCrm(url) ? 'allow' : 'deny' };
  });
  ventana.webContents.on('will-navigate', (e, url) => {
    if (esDelCrm(url) || url.startsWith('file://')) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

function carpetaRespaldos(config) {
  if (config.carpetaRespaldos) return config.carpetaRespaldos;
  // Con una carpeta de datos alternativa (pruebas/desarrollo) los respaldos
  // quedan dentro de ella y no en los Documentos reales del usuario.
  if (process.env.ALLNOVA_DESKTOP_DATA) return path.join(paths.raizDatos, 'respaldos');
  return path.join(app.getPath('documents'), 'ALLNOVATECH Respaldos');
}

async function asegurarBase(config) {
  const su = { usuario: secretos.pgSuperusuario, password: secretos.pgSuperPassword };
  const existeRol = await pg.sql({ ...su, sql: `SELECT 1 FROM pg_roles WHERE rolname = '${secretos.dbUsuario}'` });
  if (!existeRol) await pg.sql({ ...su, sql: `CREATE ROLE ${secretos.dbUsuario} LOGIN PASSWORD '${secretos.dbPassword}'` });
  const existeDb = await pg.sql({ ...su, sql: `SELECT 1 FROM pg_database WHERE datname = '${secretos.dbNombre}'` });
  if (!existeDb) await pg.sql({ ...su, sql: `CREATE DATABASE ${secretos.dbNombre} OWNER ${secretos.dbUsuario} ENCODING 'UTF8'` });
  config.dbCreada = true;
  log('[app] rol y base de datos de la app listos');
}

function crearBackupManager(config) {
  return new BackupManager({
    pg,
    db: { usuario: secretos.dbUsuario, password: secretos.dbPassword, nombre: secretos.dbNombre },
    su: { usuario: secretos.pgSuperusuario, password: secretos.pgSuperPassword },
    archivos: paths.archivos,
    carpeta: carpetaRespaldos(config),
    migraciones: path.join(paths.backend, 'prisma', 'migrations'),
    cripto: { clave: Buffer.from(secretos.respaldoClave, 'hex'), sal: Buffer.from(secretos.respaldoSal, 'hex') },
    appVersion: app.getVersion(),
    log
  });
}

async function hayDatos() {
  try {
    const r = await respaldos.resumenBase();
    return !!r.empresa;
  } catch (_) {
    return false; // base sin esquema todavía (primera instalación)
  }
}

/** Actualización segura: respaldo verificado antes de migrar; si la migración falla, recuperar. */
async function migrarConRespaldo(config) {
  const env = backend.entorno({ puerto: ctx.puertoApp, databaseUrl: ctx.databaseUrl, secretos, ...licBackend() });
  let respaldoPrevio = null;
  if (config.version && config.version !== app.getVersion() && await hayDatos()) {
    log(`[actualizar] ${config.version} → ${app.getVersion()}: respaldo previo`);
    respaldoPrevio = (await respaldos.crear({ motivo: 'antes-de-actualizar', copiaA: config.carpetaCopia })).archivo;
  }
  try {
    await backend.migrar(env);
  } catch (e) {
    log(`[actualizar] migración fallida: ${e.message}`);
    if (!respaldoPrevio) throw e;
    const response = await confirmar({
      type: 'error',
      title: 'ALLNOVATECH CRM — Modo recuperación',
      message: 'La actualización no pudo preparar tu base de datos.',
      detail: 'Tus datos están a salvo: antes de actualizar se creó y verificó un respaldo.\n\n'
        + '«Restaurar» deja la base como estaba antes de la actualización. Después instala la versión anterior '
        + 'o contacta a soporte.\n\nRespaldo: ' + respaldoPrevio,
      buttons: ['Restaurar respaldo previo', 'Salir sin cambios'],
      defaultId: 0,
      cancelId: 1
    });
    if (response === 0) {
      await respaldos.restaurar({ archivo: respaldoPrevio });
      log('[actualizar] respaldo previo restaurado');
      if (!autoprueba) await dialog.showMessageBox(ventana, { type: 'info', title: 'ALLNOVATECH CRM', message: 'Se restauró el respaldo previo a la actualización.', detail: 'Instala la versión anterior del CRM o contacta a soporte antes de volver a actualizar.' });
    }
    throw Object.assign(new Error('Actualización revertida'), { silenciar: true });
  }
}

async function arrancar() {
  asegurarCarpetas();
  crearVentana();
  log(`[app] inicio ${app.getVersion()} datos=${paths.raizDatos}`);
  try {
    let config = leerConfig();
    registrarIpcInicio();
    registrarIpcEquipo();
    if (config.equipo?.modo === 'cliente') return await arrancarCliente();
    if (SOLO_CLIENTE) {
      // Mac sin emparejar: directo a «Conectar a la PC principal».
      modoApp = 'cliente';
      log('[equipo] Mac sin PC principal: pantalla de conexión');
      await ventana.loadFile(INICIO, { hash: 'conectar' });
      return;
    }
    // Instalación nueva: ¿PC principal o conectarse a una PC principal?
    const instalacionNueva = !config.dbCreada && !config.modoElegido && !fs.existsSync(path.join(paths.pgData, 'PG_VERSION'));
    if (instalacionNueva && !autoprueba) {
      const eleccion = await elegirModo();
      if (eleccion === 'cliente') return await arrancarCliente();
      config = leerConfig();
      await ventana.loadFile(paths.splash);
    }

    secretos = cargarOCrear(paths.secretos);
    licencias = new LicenseAgent({
      archivo: paths.licencia, leerConfig, guardarConfig, apiUrl: LICENCIAS_API, appVersion: app.getVersion(), log
    });
    { const e = licencias.estado(); log(`[licencia] ${e.tipo} ${e.edicion} modo=${e.modo} (${e.motivo})`); }

    pg = new PgManager({ pgHome: paths.pgHome, dataDir: paths.pgData, logFile: path.join(paths.logs, 'postgres.log'), log });
    const primeraVez = await pg.inicializar({ superusuario: secretos.pgSuperusuario, password: secretos.pgSuperPassword });
    const puertoPg = await pg.iniciar({ puertoPreferido: config.puertoPg });
    if (primeraVez || !config.dbCreada) await asegurarBase(config);

    respaldos = crearBackupManager(config);
    backend = new BackendHost({ paths, log });
    const puertoApp = await elegirPuerto(config.puertoApp || 54420);
    ctx = { puertoApp, databaseUrl: pg.url({ usuario: secretos.dbUsuario, password: secretos.dbPassword, db: secretos.dbNombre }) };

    await migrarConRespaldo(config);
    ctx.origen = await backend.iniciar({ puerto: puertoApp, databaseUrl: ctx.databaseUrl, secretos, ...licBackend(), migrar: false });
    guardarConfig({ ...leerConfig(), puertoPg, puertoApp, version: app.getVersion() });

    const estado = await backend.estado(puertoApp);
    restringirNavegacion(ctx.origen);
    registrarIpc();
    await ventana.loadURL(`${ctx.origen}/${estado.configurado ? 'login' : 'instalacion'}`);
    programarRespaldoDiario();
    refrescarLicenciaEnSegundoPlano();
    iniciarWhatsapp();
    iniciarAccesoRemoto();
    if (leerConfig().equipo?.modo === 'servidor') {
      iniciarServidorEquipo().catch((e) => log(`[equipo] no se pudo abrir en la red: ${e.message}`));
    }
    // Actualizaciones: solo en la app instalada (en desarrollo no hay latest.yml).
    if (app.isPackaged && !process.env.ALLNOVA_SIN_ACTUALIZAR) iniciarActualizaciones({ licencias, ventana, log });
    if (autoprueba && process.env.ALLNOVA_AUTOPRUEBA === 'arranque') { log('[autoprueba] arranque OK'); app.quit(); }
    else if (autoprueba) require('./autoprueba').ejecutar({ ventana, restaurarFlujo, log }).finally(() => app.quit());
  } catch (e) {
    log(`[app] ERROR ${e.stack || e.message}`);
    if (!e.silenciar) {
      await dialog.showMessageBox(ventana, {
        type: 'error',
        title: 'ALLNOVATECH CRM',
        message: 'No se pudo iniciar el CRM.',
        detail: `${e.message}\n\nRegistro: ${paths.logs}`
      });
    }
    await apagar();
    app.exit(1);
  }
}

// ── Trabajo en red ──────────────────────────────────────────────────────
/** Primera vez: muestra la elección y espera la respuesta ('principal' | 'cliente'). */
let resolverEleccion = null;
function elegirModo() {
  return new Promise((resolve) => {
    resolverEleccion = resolve;
    ventana.loadFile(INICIO, { hash: 'eleccion' });
  });
}

const urlCliente = (eq) => `https://${eq.host}:${eq.puerto}`;
let ultimoErrorCliente = null;

/** PC cliente: sin PostgreSQL, backend ni licencia propios; la ventana abre la PC principal. */
let clienteListo = false;
async function arrancarCliente() {
  modoApp = 'cliente';
  const eq = leerConfig().equipo;
  ctx = { origen: urlCliente(eq) };
  log(`[equipo] PC cliente → ${ctx.origen}`);
  if (!clienteListo) {
    clienteListo = true;
    // Solo se acepta el certificado emparejado para la PC principal; el resto
    // de sitios, con la verificación normal de Chromium.
    session.defaultSession.setCertificateVerifyProc((req, cb) => {
      const actual = leerConfig().equipo;
      if (actual?.modo === 'cliente' && req.hostname === actual.host) {
        return cb(equipo.certificadoEsDelEquipo(req.certificate, actual.huella) ? 0 : -2);
      }
      cb(-3);
    });
    ventana.webContents.on('did-fail-load', (_e, codigo, descripcion, url, principal) => {
      if (!principal || modoApp !== 'cliente' || codigo === -3 /* ABORTED */ || !esDelCrm(url)) return;
      log(`[equipo] sin conexión con la PC principal: ${descripcion} (${codigo})`);
      ultimoErrorCliente = codigo === -202 || codigo === -200
        ? 'La PC principal presentó un certificado distinto al emparejado. Si se reinstaló, vuelve a emparejar con «Cambiar PC principal».'
        : `Último intento: ${descripcion}.`;
      ventana.loadFile(INICIO, { hash: 'sin-conexion' });
    });
    if (app.isPackaged && !process.env.ALLNOVA_SIN_ACTUALIZAR) {
      // La licencia vive en la PC principal: aquí solo se actualiza el programa.
      // En Mac (app sin firma de Apple) no se puede instalar sola: se avisa y se abre la descarga.
      if (SOLO_CLIENTE) avisarVersionMac({ ventana, log, appVersion: app.getVersion() });
      else iniciarActualizaciones({ licencias: { estado: () => ({ modo: 'completo' }) }, ventana, log });
    }
  }
  restringirNavegacion(ctx.origen);
  await abrirPrincipal();
}

async function abrirPrincipal() {
  const eq = leerConfig().equipo;
  try {
    await equipo.leerHuellaRemota(eq.host, eq.puerto);
  } catch (e) {
    ultimoErrorCliente = e.message;
    await ventana.loadFile(INICIO, { hash: 'sin-conexion' });
    return false;
  }
  ultimoErrorCliente = null;
  ventana.loadURL(`${urlCliente(eq)}/login`).catch(() => { /* did-fail-load muestra la pantalla */ });
  return true;
}

function dePantallaInicio(event) {
  const url = event.senderFrame?.url || '';
  let archivo = '';
  try { archivo = path.normalize(decodeURIComponent(new URL(url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))); } catch (_) { /* nada */ }
  if (!url.startsWith('file://') || archivo.toLowerCase() !== path.normalize(INICIO).toLowerCase()) throw new Error('Origen no autorizado');
}

function manejarInicio(canal, fn) {
  ipcMain.handle(canal, async (event, args) => {
    try {
      dePantallaInicio(event);
      return { ok: true, data: await fn(args || {}) };
    } catch (e) {
      log(`[ipc] ${canal}: ${e.message}`);
      return { ok: false, code: e.code || 'ERROR', mensaje: e.message };
    }
  });
}

let ipcInicioRegistrado = false;
function registrarIpcInicio() {
  if (ipcInicioRegistrado) return;
  ipcInicioRegistrado = true;
  manejarInicio('inicio:estado', async () => {
    const eq = leerConfig().equipo;
    return {
      primeraVez: !!resolverEleccion,
      soloCliente: SOLO_CLIENTE,
      servidor: eq?.modo === 'cliente' ? { host: eq.host, puerto: eq.puerto } : null,
      error: ultimoErrorCliente
    };
  });
  manejarInicio('inicio:principal', async () => {
    if (!resolverEleccion) throw new Error('Esta PC ya está configurada.');
    guardarConfig({ ...leerConfig(), modoElegido: 'principal' });
    const r = resolverEleccion; resolverEleccion = null;
    r('principal');
    return true;
  });
  manejarInicio('inicio:conectar', async ({ host, puerto, codigo }) => {
    if (modoApp !== 'cliente' && !resolverEleccion) throw new Error('Esta PC es la principal: no puede conectarse a otra.');
    const r = await equipo.emparejar({ host, puerto, codigo });
    guardarConfig({ ...leerConfig(), modoElegido: 'cliente', equipo: { modo: 'cliente', host: r.host, puerto: r.puerto, huella: r.huella, emparejado_en: new Date().toISOString() } });
    log(`[equipo] emparejada con ${r.host}:${r.puerto}`);
    if (resolverEleccion) { const res = resolverEleccion; resolverEleccion = null; res('cliente'); }
    else await arrancarCliente();
    return true;
  });
  manejarInicio('inicio:reintentar', async () => {
    if (modoApp !== 'cliente') throw new Error('Esta PC no está conectada a una PC principal.');
    if (!(await abrirPrincipal())) throw new Error(ultimoErrorCliente || 'La PC principal sigue sin responder.');
    return true;
  });
  manejarInicio('inicio:desvincular', async () => {
    if (modoApp !== 'cliente') throw new Error('Esta PC no está conectada a una PC principal.');
    if (SOLO_CLIENTE) throw new Error('En Mac el CRM trabaja siempre con la PC principal de la oficina.');
    const { response } = await dialog.showMessageBox(ventana, {
      type: 'warning', title: 'ALLNOVATECH CRM', buttons: ['Usar esta PC sola', 'Cancelar'], defaultId: 1, cancelId: 1,
      message: '¿Dejar de usar la PC principal?',
      detail: 'Esta PC creará su propia base de datos vacía y necesitará su propia licencia. Los datos de la PC principal no se tocan y podrás volver a conectarte más adelante.'
    });
    if (response !== 0) return false;
    const c = leerConfig();
    delete c.equipo;
    guardarConfig({ ...c, modoElegido: 'principal' });
    log('[equipo] PC desvinculada de la PC principal; se reinicia como PC sola');
    app.relaunch();
    app.exit(0);
    return true;
  });
}

/** Clave del certificado de la red (una vez, en secrets.bin). */
async function certificadoEquipo() {
  if (!secretos.equipoPfxClave) {
    secretos.equipoPfxClave = crypto.randomBytes(24).toString('base64url');
    guardarSecretos(paths.secretos, secretos);
  }
  const cert = await equipo.asegurarCertificado(path.join(paths.raizDatos, 'equipo'), secretos.equipoPfxClave);
  return { ...cert, clave: secretos.equipoPfxClave };
}

async function iniciarServidorEquipo() {
  if (!servidorEquipo) servidorEquipo = new equipo.ServidorEquipo({ puertoBackend: () => ctx.puertoApp, log });
  if (servidorEquipo.activo) return servidorEquipo.info();
  const cert = await certificadoEquipo();
  const config = leerConfig();
  const puerto = await servidorEquipo.iniciar({ ...cert, puertoPreferido: config.equipo?.puerto || equipo.PUERTO_EQUIPO });
  guardarConfig({ ...leerConfig(), equipo: { modo: 'servidor', puerto } });
  return servidorEquipo.info();
}

/** ¿La licencia permite más de un usuario? (el modo equipo no tiene sentido con 1). */
function equipoPermitido() {
  const e = licencias.estado();
  const usuarios = Number(e.usuarios);
  return !(Number.isInteger(usuarios) && usuarios === 1);
}

function delCrmOCliente(event) {
  const url = event.senderFrame?.url || '';
  if (!ctx?.origen || !(url === ctx.origen || url.startsWith(ctx.origen + '/'))) throw new Error('Origen no autorizado');
}

let ipcEquipoRegistrado = false;
function registrarIpcEquipo() {
  if (ipcEquipoRegistrado) return;
  ipcEquipoRegistrado = true;
  const h = (canal, fn) => ipcMain.handle(canal, async (event, args) => {
    try {
      delCrmOCliente(event);
      return { ok: true, data: await fn(args || {}) };
    } catch (e) {
      log(`[ipc] ${canal}: ${e.message}`);
      return { ok: false, code: e.code || 'ERROR', mensaje: e.message };
    }
  });
  h('equipo:estado', async () => {
    if (modoApp === 'cliente') {
      const eq = leerConfig().equipo;
      return { modo: 'cliente', servidor: { host: eq.host, puerto: eq.puerto } };
    }
    const info = servidorEquipo ? servidorEquipo.info() : { activo: false, direcciones: [], conectados: [] };
    return { modo: 'principal', permitido: equipoPermitido(), ...info };
  });
  h('equipo:activar', async () => {
    if (modoApp === 'cliente') throw new Error('Solo la PC principal comparte el CRM en la red.');
    if (!equipoPermitido()) throw Object.assign(new Error('Tu plan es para 1 usuario. Para trabajar desde varias PC, cambia a un plan de 2 o más usuarios en Licencia.'), { code: 'PLAN_UN_USUARIO' });
    const info = await iniciarServidorEquipo();
    return { modo: 'principal', permitido: true, ...info };
  });
  h('equipo:desactivar', async () => {
    if (modoApp === 'cliente') throw new Error('Solo la PC principal comparte el CRM en la red.');
    if (servidorEquipo) await servidorEquipo.detener();
    const c = leerConfig();
    delete c.equipo;
    guardarConfig(c);
    log('[equipo] trabajo en red desactivado');
    return { modo: 'principal', permitido: equipoPermitido(), activo: false, direcciones: [], conectados: [] };
  });
  // Acceso desde fuera de la oficina / celular (solo PC principal o sola).
  const remoto = () => {
    if (modoApp === 'cliente') throw new Error('El acceso desde fuera de la oficina se configura en la PC principal.');
    if (!accesoRemoto) throw new Error('El CRM todavía está arrancando. Intenta en unos segundos.');
    return accesoRemoto;
  };
  h('remoto:estado', async () => remoto().info());
  h('remoto:activar', async () => {
    const info = remoto().activar();
    guardarConfig({ ...leerConfig(), remoto: { activo: true } });
    log('[remoto] acceso desde fuera activado');
    return info;
  });
  h('remoto:desactivar', async () => {
    const info = await remoto().desactivar();
    const c = leerConfig();
    delete c.remoto;
    guardarConfig(c);
    log('[remoto] acceso desde fuera desactivado');
    return info;
  });
  h('remoto:vincular', async () => remoto().crearCodigoVinculo());
  h('remoto:anularVinculo', async () => remoto().anularVinculo());
  h('remoto:quitarDispositivo', async ({ id }) => {
    const info = remoto().revocarDispositivo(id);
    log('[remoto] dispositivo quitado');
    return info;
  });
  h('remoto:cambiarEnlace', async () => {
    const info = await remoto().cambiarEnlace();
    log('[remoto] enlace cambiado');
    return info;
  });
  h('equipo:cambiarPrincipal', async () => {
    if (modoApp !== 'cliente') throw new Error('Esta PC es la principal.');
    await ventana.loadFile(INICIO, { hash: 'conectar' });
    return true;
  });
}

// ── Licencia ────────────────────────────────────────────────────────────
/** Reinicia el backend con la licencia/edición vigentes y recarga la ventana. */
async function reiniciarBackend(ruta = 'login') {
  if (ocupado) return;
  ocupado = true;
  try {
    await ventana.loadFile(paths.splash);
    await backend.detener();
    ctx.origen = await backend.iniciar({ puerto: ctx.puertoApp, databaseUrl: ctx.databaseUrl, secretos, ...licBackend(), migrar: false });
    await ventana.loadURL(`${ctx.origen}/${ruta}`);
  } finally { ocupado = false; }
}

/**
 * Refresco con la oficina de licencias (sin Internet no pasa nada): al abrir,
 * cada 6 h y, mientras hay un pago en curso, cada minuto para que la licencia
 * llegue sola apenas Izipay confirme.
 */
function refrescarLicenciaEnSegundoPlano() {
  // Si el asistente no llegó a registrar la prueba gratis, se toman los datos
  // de la empresa instalada para que `refrescar` la registre sola.
  const asegurarDatosPrueba = async () => {
    if (!licencias.faltanDatosPrueba()) return;
    const r = await postJson('/api/v1/desktop/licencia/datos-prueba', {}, { 'x-allnova-desktop-token': secretos.desktopToken });
    if (r.status === 200 && r.body?.data && licencias.prepararPrueba(r.body.data)) log('[licencia] prueba sin registrar; se registrará con los datos de la empresa');
  };
  const intentar = (forzar) => asegurarDatosPrueba().catch((e) => log(`[licencia] datos de prueba: ${e.message}`)).then(() => licencias.refrescar({ forzar })).then((cambio) => {
    if (cambio) { log('[licencia] cambió en la oficina; reiniciando'); return reiniciarBackend('dashboard'); }
    return null;
  }).catch((e) => log(`[licencia] refresco: ${e.message}`));
  setTimeout(() => intentar(true), 30 * 1000);
  setInterval(() => intentar(true), 6 * 60 * 60 * 1000).unref();
  setInterval(() => { if (leerConfig().licOrden && !ocupado) intentar(true); }, 60 * 1000).unref();
}

// ── Respaldo diario ─────────────────────────────────────────────────────
function programarRespaldoDiario() {
  const revisar = async () => {
    if (ocupado || cerrando) return;
    const config = leerConfig();
    const ultimo = config.ultimoRespaldoDiario ? new Date(config.ultimoRespaldoDiario) : null;
    if (ultimo && Date.now() - ultimo.getTime() < HORAS_ENTRE_DIARIOS * 36e5) return;
    if (!(await hayDatos())) return;
    ocupado = true;
    try {
      await respaldos.crear({ motivo: 'diario', copiaA: config.carpetaCopia });
      guardarConfig({ ...leerConfig(), ultimoRespaldoDiario: new Date().toISOString(), ultimoError: null });
    } catch (e) {
      log(`[respaldo] diario falló: ${e.message}`);
      guardarConfig({ ...leerConfig(), ultimoError: { fecha: new Date().toISOString(), mensaje: e.message } });
    }
    // Estados anteriores de restauraciones (> 30 días) y restos de procesos interrumpidos.
    try { await respaldos.limpiarAnteriores(); } catch (e) { log(`[respaldo] limpieza: ${e.message}`); }
    // Un respaldo que nunca se restauró no está probado: una vez por semana se
    // restaura el último en una base temporal y se comparan los conteos.
    const prueba = leerConfig().pruebaRestauracion;
    if (!prueba || Date.now() - new Date(prueba.fecha).getTime() > 7 * 864e5) {
      try {
        const r = await respaldos.probarRestauracion();
        guardarConfig({ ...leerConfig(), pruebaRestauracion: { fecha: new Date().toISOString(), ...r } });
      } catch (e) {
        log(`[respaldo] prueba de restauración falló: ${e.message}`);
        guardarConfig({ ...leerConfig(), pruebaRestauracion: { fecha: new Date().toISOString(), ok: false, detalle: e.message } });
      }
    }
    ocupado = false;
  };
  setTimeout(revisar, 2 * 60 * 1000); // no competir con el arranque
  setInterval(revisar, 60 * 60 * 1000).unref();
}

// ── Puente con el CRM (preload) ─────────────────────────────────────────
function delCrm(event) {
  const url = event.senderFrame?.url || '';
  if (!ctx?.origen || !url.startsWith(ctx.origen)) throw new Error('Origen no autorizado');
}

function manejar(canal, fn) {
  ipcMain.handle(canal, async (event, args) => {
    delCrm(event);
    try {
      return { ok: true, data: await fn(args || {}) };
    } catch (e) {
      log(`[ipc] ${canal}: ${e.message}`);
      return { ok: false, code: e.code || 'ERROR', mensaje: e.message };
    }
  });
}

function postJson(ruta, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const datos = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: ctx.puertoApp, path: ruta, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': datos.length, ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    req.end(datos);
  });
}

function getJson(ruta, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ctx.puertoApp, path: ruta, method: 'GET', headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Varias empresas en la PC: ¿en qué empresa está quien pulsó «Conectar»?
 * Se pregunta al backend con el token de SU sesión (no se confía en un número
 * que mande la ventana). Sin token (versiones anteriores del CRM) → null, y el
 * backend usa la única empresa de la PC.
 */
async function empresaDeSesion(sesion) {
  if (!sesion) return null;
  const r = await getJson('/api/v1/pc-empresas/actual', { authorization: `Bearer ${sesion}` });
  if (r.status === 401 || r.status === 403) {
    throw Object.assign(new Error(r.body?.mensaje && r.status === 403 && /Permiso/i.test(r.body.mensaje)
      ? 'Tu usuario no tiene permiso para conectar integraciones en esta empresa.'
      : 'Tu sesión venció. Vuelve a entrar al CRM.'), { code: 'SESION' });
  }
  if (r.status !== 200 || !r.body?.data?.id) throw new Error(r.body?.mensaje || 'No se pudo saber en qué empresa estás.');
  // Lo conectado antes de haber varias empresas es de la empresa original.
  if (whatsapp) whatsapp.migrarLegado(r.body.data.primera);
  return r.body.data.id;
}

/** Confirmación nativa; en la autoprueba de desarrollo se acepta sola. */
async function confirmar(opciones) {
  if (autoprueba) return 0;
  return (await dialog.showMessageBox(ventana, opciones)).response;
}

function normalizarCodigo(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

/** Restauración guiada (IPC y autoprueba): confirmar → detener backend → restaurar → reiniciar. */
async function restaurarFlujo({ archivo, codigo }) {
  if (ocupado) throw Object.assign(new Error('Hay un respaldo en curso; intenta en un momento.'), { code: 'OCUPADO' });
  const v = await respaldos.previsualizar({ archivo, codigo: codigo || null });
  if (!v.compatible) throw Object.assign(new Error('Este respaldo es de una versión más nueva del CRM. Actualiza la aplicación antes de restaurarlo.'), { code: 'RESPALDO_MAS_NUEVO' });
  const c = v.cabecera;
  const response = await confirmar({
    type: 'warning',
    title: 'Restaurar respaldo',
    message: '¿Reemplazar los datos actuales por este respaldo?',
    detail: `Empresa: ${c.empresa}\nFecha: ${new Date(c.creado_en).toLocaleString('es-PE')}\n`
      + `Clientes: ${c.conteos?.clientes ?? 0} · Leads: ${c.conteos?.leads ?? 0} · Cotizaciones: ${c.conteos?.cotizaciones ?? 0}\n\n`
      + 'Antes de restaurar se guardará un respaldo del estado actual. Se cerrará la sesión.',
    buttons: ['Restaurar', 'Cancelar'],
    defaultId: 1,
    cancelId: 1
  });
  if (response !== 0) return { cancelado: true };

  ocupado = true;
  try {
    await ventana.loadFile(paths.splash);
    await backend.detener();
    const r = await respaldos.restaurar({ archivo, codigo: codigo || null });
    ctx.origen = await backend.iniciar({ puerto: ctx.puertoApp, databaseUrl: ctx.databaseUrl, secretos, ...licBackend(), migrar: true });
    await ventana.loadURL(`${ctx.origen}/login?restaurado=1`);
    return { restaurado: r.restaurado.empresa, seguridad: path.basename(r.seguridad) };
  } catch (e) {
    // Volver a levantar el CRM con lo que haya (la base actual no se tocó si falló antes del intercambio).
    try { ctx.origen = await backend.iniciar({ puerto: ctx.puertoApp, databaseUrl: ctx.databaseUrl, secretos, ...licBackend(), migrar: true }); await ventana.loadURL(`${ctx.origen}/login`); } catch (_) {}
    throw e;
  } finally { ocupado = false; }
}

let ipcRegistrado = false;
function registrarIpc() {
  if (ipcRegistrado) return;
  ipcRegistrado = true;

  manejar('app:version', async () => ({ version: app.getVersion(), edicion: licBackend().edicion }));

  // Solo se abre la página de pago de la propia oficina.
  const abrirPago = (url) => {
    if (!String(url || '').startsWith(LICENCIAS_API + '/')) throw new Error('Enlace de pago no reconocido.');
    return shell.openExternal(url);
  };
  const reiniciarLuego = (ruta) => setTimeout(() => reiniciarBackend(ruta).catch((x) => log(`[licencia] reinicio: ${x.message}`)), 300);
  manejar('licencia:estado', async () => ({ ...licencias.estado(), installation_id: licencias.installationId(), pago_en_curso: !!leerConfig().licOrden }));
  manejar('licencia:activar', async ({ clave }) => {
    const e = await licencias.activar(clave);
    reiniciarLuego('dashboard');
    return e;
  });
  // Prueba gratis en la oficina: con los datos de la empresa recién creada.
  manejar('licencia:prueba', async ({ cliente, contacto, ruc }) => {
    const antes = licencias.estado();
    const e = await licencias.pedirPrueba({ cliente, contacto, ruc });
    if (antes.edicion !== e.edicion || antes.modo !== e.modo) reiniciarLuego('login');
    return e;
  });
  manejar('licencia:planes', async () => licencias.planes());
  // Compra / renovación: la página de pago de Izipay se abre en el navegador.
  manejar('licencia:comprar', async (datos) => {
    const r = await licencias.comprar(datos || {});
    await abrirPago(r.url_pago);
    return r;
  });
  manejar('licencia:pagar', async (datos) => {
    const r = await licencias.pagar(datos || {});
    await abrirPago(r.url_pago);
    return r;
  });
  manejar('licencia:cancelarPago', async () => {
    licencias.cancelarPago();
    log('[licencia] el usuario dejó de esperar el pago');
    return { ...licencias.estado(), installation_id: licencias.installationId(), pago_en_curso: false };
  });
  // Cuenta AllNovaTech: se abre all-novatech.com/mi-cuenta/conectar/ con el código; la pantalla consulta el resultado.
  const abrirCuenta = (url) => {
    if (!/^https:\/\/(www\.)?all-novatech\.com\/mi-cuenta\//.test(String(url || ''))) throw new Error('Enlace de cuenta no reconocido.');
    return shell.openExternal(url);
  };
  manejar('licencia:cuentaIniciar', async () => {
    const r = await licencias.iniciarCuenta();
    await abrirCuenta(r.url);
    return r;
  });
  manejar('licencia:cuentaEstado', async ({ codigo }) => licencias.estadoCuenta(codigo));
  // «Ya tengo cuenta» en el asistente de instalación (la PC todavía no está registrada).
  manejar('licencia:cuentaPreviaIniciar', async () => {
    const r = await licencias.iniciarCuentaPrevia();
    await abrirCuenta(r.url);
    return r;
  });
  manejar('licencia:cuentaPreviaEstado', async ({ codigo }) => licencias.estadoCuentaPrevia(codigo));
  manejar('licencia:verCuenta', async () => { await abrirCuenta('https://all-novatech.com/mi-cuenta/'); return true; });
  manejar('licencia:soporte', async (datos) => {
    const e = licencias.estado();
    const wa = whatsapp ? whatsapp.estado() : null;
    const diagnostico = {
      version: app.getVersion(), windows: `${os.release()} ${os.arch()}`, edicion: e.edicion, plan: e.plan || e.tipo,
      modo: e.modo, motivo: e.motivo, usuarios: String(e.usuarios ?? ''), vence: e.vence || '',
      whatsapp: wa ? (wa.conectado ? (wa.enLinea ? 'conectado' : 'conectado sin enlace') : 'no') : 'no',
      memoria: `${Math.round(os.totalmem() / 2 ** 30)} GB`
    };
    return licencias.soporte({ ...(datos || {}), diagnostico });
  });
  manejar('licencia:revisar', async () => {
    if (await licencias.refrescar({ forzar: true })) reiniciarLuego('dashboard');
    return licencias.estado();
  });
  manejar('licencia:desactivar', async () => {
    const r = await licencias.desactivar();
    setTimeout(() => reiniciarBackend('login').catch((x) => log(`[licencia] reinicio: ${x.message}`)), 300);
    return r;
  });

  manejar('respaldos:estado', async () => {
    const config = leerConfig();
    return {
      carpeta: carpetaRespaldos(config),
      carpetaCopia: config.carpetaCopia || null,
      ultimoDiario: config.ultimoRespaldoDiario || null,
      ultimoError: config.ultimoError || null,
      pruebaRestauracion: config.pruebaRestauracion || null,
      codigoMostrado: !!secretos.codigoMostrado,
      lista: respaldos.listar().slice(0, 30).map(({ archivo, nombre, bytes, creado_en, motivo, empresa, conteos, app_version, error }) =>
        ({ archivo, nombre, bytes, creado_en, motivo, empresa, conteos, app_version, error }))
    };
  });

  manejar('respaldos:crear', async () => {
    if (ocupado) throw Object.assign(new Error('Ya hay un respaldo en curso.'), { code: 'OCUPADO' });
    ocupado = true;
    try {
      const r = await respaldos.crear({ motivo: 'manual', copiaA: leerConfig().carpetaCopia });
      return { nombre: path.basename(r.archivo), cabecera: r.cabecera };
    } finally { ocupado = false; }
  });

  manejar('respaldos:abrirCarpeta', async () => {
    const c = carpetaRespaldos(leerConfig());
    fs.mkdirSync(c, { recursive: true });
    await shell.openPath(c);
    return true;
  });

  manejar('respaldos:elegirCopia', async () => {
    const r = await dialog.showOpenDialog(ventana, {
      title: 'Carpeta para una copia adicional (USB, Google Drive, OneDrive…)',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths[0]) return null;
    guardarConfig({ ...leerConfig(), carpetaCopia: r.filePaths[0] });
    return r.filePaths[0];
  });

  manejar('respaldos:quitarCopia', async () => {
    const c = leerConfig();
    delete c.carpetaCopia;
    guardarConfig(c);
    return true;
  });

  manejar('respaldos:elegirArchivo', async () => {
    const r = await dialog.showOpenDialog(ventana, {
      title: 'Elegir respaldo para restaurar',
      defaultPath: carpetaRespaldos(leerConfig()),
      filters: [{ name: 'Respaldo ALLNOVATECH', extensions: ['allnova'] }],
      properties: ['openFile']
    });
    return r.canceled ? null : r.filePaths[0];
  });

  manejar('respaldos:previsualizar', async ({ archivo, codigo }) => {
    const v = await respaldos.previsualizar({ archivo, codigo: codigo || null });
    const { empresa, conteos, creado_en, app_version, motivo } = v.cabecera;
    return { empresa, conteos, creado_en, app_version, motivo, compatible: v.compatible };
  });

  manejar('respaldos:restaurar', restaurarFlujo);

  // El código se puede volver a ver (es una instalación local de una sola
  // empresa); queda registrado si ya se confirmó que fue guardado.
  manejar('codigo:ver', async () => ({ codigo: secretos.codigoRecuperacion, mostrado: !!secretos.codigoMostrado }));
  manejar('codigo:confirmar', async () => {
    secretos.codigoMostrado = true;
    guardarSecretos(paths.secretos, secretos);
    return true;
  });

  // Meta Ads: «Conectar con Facebook» por el puente (solo en la PC principal).
  // Con varias empresas en la PC, cada conexión va a la empresa de la sesión
  // que la pidió (ver empresaDeSesion).
  manejar('meta:conectar', async (args) => conexionMeta.conectar({ mensajes: args?.mensajes === true, idEmpresa: await empresaDeSesion(args?.sesion) }));
  manejar('meta:estado', async () => conexionMeta ? conexionMeta.estado() : { conectando: false });
  manejar('meta:cancelar', async () => { conexionMeta?.cancelar(); return true; });

  manejar('whatsapp:estado', async (args) => {
    if (!whatsapp) return { conectado: false };
    let idEmpresa = null;
    try { idEmpresa = await empresaDeSesion(args?.sesion); } catch (e) {
      // Con sesión pero sin saber la empresa no se muestra el número de otra empresa.
      if (args?.sesion) return { conectado: false, numero: null, meta: null, error: e.message };
    }
    return whatsapp.estado(idEmpresa);
  });
  manejar('whatsapp:conectar', async (args) => whatsapp.conectar(await empresaDeSesion(args?.sesion)));
  manejar('whatsapp:conectarDirecto', async ({ token, sesion }) => whatsapp.conectarDirecto(token, await empresaDeSesion(sesion)));
  manejar('whatsapp:desconectar', async (args) => whatsapp.desconectar(await empresaDeSesion(args?.sesion)));

  // «Entrar con mi cuenta all-novatech.com»: la oficina confirma QUIÉN inició sesión en
  // la web (código atado al secreto de esta PC) y el backend busca un usuario activo con
  // ese correo. Solo valen los códigos pedidos aquí, en esta ejecución, y una sola vez.
  const codigosLogin = new Map(); // codigo → vence (ms)
  manejar('acceso:cuentaIniciar', async () => {
    for (const [c, v] of codigosLogin) if (v < Date.now()) codigosLogin.delete(c);
    const r = await licencias.iniciarCuentaPrevia();
    codigosLogin.set(r.codigo, Date.now() + (r.expira_en || 900) * 1000);
    await abrirCuenta(r.url);
    return { codigo: r.codigo, expira_en: r.expira_en };
  });
  manejar('acceso:cuentaEstado', async ({ codigo }) => {
    const vence = codigosLogin.get(codigo);
    if (!vence || vence < Date.now()) {
      codigosLogin.delete(codigo);
      throw Object.assign(new Error('El código venció. Pulsa otra vez «Entrar con mi cuenta».'), { code: 'VENCIDO' });
    }
    const e = await licencias.identidadCuenta(codigo);
    if (!e.conectado) return { conectado: false, vencido: e.vencido };
    codigosLogin.delete(codigo); // un solo uso
    if (!e.cuenta) throw new Error('La web no devolvió el correo de tu cuenta.');
    const r = await postJson('/api/v1/desktop/acceso/cuenta', { email: e.cuenta }, { 'x-allnova-desktop-token': secretos.desktopToken });
    if (r.status !== 200) throw Object.assign(new Error(r.body?.mensaje || 'No se pudo iniciar sesión.'), { code: r.body?.code });
    log(`[acceso] sesión con la cuenta ${e.cuenta}`);
    return { conectado: true, sesion: r.body?.data };
  });
  manejar('acceso:recuperar', async ({ email, codigo, password }) => {
    const a = Buffer.from(normalizarCodigo(codigo));
    const b = Buffer.from(normalizarCodigo(secretos.codigoRecuperacion));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw Object.assign(new Error('El código de recuperación no es correcto.'), { code: 'CODIGO_INCORRECTO' });
    }
    const r = await postJson('/api/v1/desktop/restablecer-admin', { email, password }, { 'x-allnova-desktop-token': secretos.desktopToken });
    if (r.status !== 200) throw Object.assign(new Error(r.body?.mensaje || 'No se pudo restablecer la contraseña.'), { code: r.body?.code });
    return true;
  });
}

// ── WhatsApp por el puente ──────────────────────────────────────────────
function iniciarWhatsapp() {
  const conToken = { 'x-allnova-desktop-token': secretos.desktopToken };
  const backendPost = async (ruta, body) => {
    const r = await postJson(ruta, body, conToken);
    if (r.status !== 200) throw new Error(r.body?.mensaje || `El CRM respondió ${r.status}.`);
    return r.body?.data;
  };
  whatsapp = new PuenteWhatsApp({
    url: PUENTE_WHATSAPP,
    licencia: () => licencias.leerToken(),
    secretos: () => secretos,
    guardarSecretos: (s) => guardarSecretos(paths.secretos, s),
    entregar: (payload) => backendPost('/api/v1/desktop/whatsapp/entrante', { payload }),
    guardarConexion: (d, idEmpresa) => backendPost('/api/v1/desktop/whatsapp/conectar', { ...d, id_empresa: idEmpresa ?? undefined }),
    borrarConexion: (idEmpresa) => backendPost('/api/v1/desktop/whatsapp/desconectar', { id_empresa: idEmpresa ?? undefined }),
    numerosDeEmpresa: async (idEmpresa) => (await backendPost('/api/v1/desktop/whatsapp/numeros', { id_empresa: idEmpresa ?? undefined }))?.numeros || [],
    abrir: (url) => shell.openExternal(url),
    log
  });
  whatsapp.iniciar();
  conexionMeta = new ConexionMeta({
    url: PUENTE_WHATSAPP,
    licencia: () => licencias.leerToken(),
    secretos: () => secretos,
    guardarSecretos: (s) => guardarSecretos(paths.secretos, s),
    guardar: async (datos, idEmpresa, opciones = {}) => {
      // El puente ya cambió la credencial del canal: se guarda aunque el CRM rechace la conexión.
      if (datos.mensajeria?.secreto && whatsapp) whatsapp.guardarCanal(datos.mensajeria.secreto);
      const r = await backendPost('/api/v1/desktop/meta/conectar', { ...datos, id_empresa: idEmpresa ?? undefined, modo: opciones.mensajes ? 'mensajes' : 'anuncios' });
      // Messenger/Instagram por el puente: misma credencial de canal que WhatsApp.
      // Las páginas que ya están en otra empresa de la PC no se registran aquí (el backend las saltó).
      const omitidas = new Set((r?.mensajeria?.omitidas || []).map((o) => String(o.id)));
      const paginas = (datos.mensajeria?.paginas || []).filter((p) => !omitidas.has(String(p.id)));
      // Solo la conexión de Messenger registra páginas en esta empresa (Meta Ads no).
      if (opciones.mensajes && datos.mensajeria?.secreto && whatsapp && paginas.length) whatsapp.usarCanalMeta(datos.mensajeria.secreto, paginas, idEmpresa);
      return r;
    },
    abrir: (url) => shell.openExternal(url),
    log
  });
}

// ── Acceso desde fuera de la oficina ────────────────────────────────────
function iniciarAccesoRemoto() {
  if (accesoRemoto) return;
  accesoRemoto = new AccesoRemoto({
    url: PUENTE_REMOTO,
    licencia: () => licencias.leerToken(),
    secretos: () => secretos,
    guardarSecretos: (s) => guardarSecretos(paths.secretos, s),
    puertoBackend: () => ctx.puertoApp,
    log
  });
  if (leerConfig().remoto?.activo) accesoRemoto.activar();
}

// ── Cierre ──────────────────────────────────────────────────────────────
async function apagar() {
  if (cerrando) return;
  cerrando = true;
  try { if (whatsapp) whatsapp.detener(); } catch (_) { /* nada */ }
  try { if (accesoRemoto) await accesoRemoto.desactivar(); } catch (_) { /* nada */ }
  try { if (servidorEquipo) await servidorEquipo.detener(); } catch (_) { /* nada */ }
  try { if (backend) await backend.detener(); } catch (e) { log(`[app] backend: ${e.message}`); }
  try { if (pg) await pg.detener(); } catch (e) { log(`[app] postgres: ${e.message}`); }
  log('[app] apagado ordenado');
}

app.on('window-all-closed', async () => {
  await apagar();
  app.quit();
});

// Apagado de Windows / cierre de sesión: mismo apagado ordenado.
app.on('before-quit', (e) => {
  if (cerrando) return;
  e.preventDefault();
  apagar().finally(() => app.quit());
});
