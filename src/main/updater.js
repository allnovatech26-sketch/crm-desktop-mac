/**
 * Actualizaciones automáticas (electron-updater, proveedor genérico).
 *
 * Los instaladores y `latest.yml` se publican en el hosting propio
 * (build.publish.url). Si la licencia está vencida o anulada no se descarga
 * nada (el CRM sigue funcionando igual, en solo lectura). El respaldo previo y la migración los hace el próximo
 * arranque (index.js) al detectar el cambio de versión.
 */
const { dialog } = require('electron');

const CADA = 6 * 60 * 60 * 1000;

/**
 * SiteGround responde 403 a cualquier .yml/.yaml (regla del servidor; un
 * .htaccess no la levanta). electron-updater pide `latest.yml`, así que en
 * su sesión de red esa petición se lleva a la copia `latest-yml.txt` que se
 * publica junto al instalador.
 */
function redirigirManifiesto(sesion) {
  sesion.webRequest.onBeforeRequest({ urls: ['https://all-novatech.com/descargas/*'] }, (det, cb) => {
    const u = new URL(det.url);
    if (!/\/latest\.yml$/.test(u.pathname)) return cb({});
    u.pathname = u.pathname.replace(/latest\.yml$/, 'latest-yml.txt');
    cb({ redirectURL: u.toString() });
  });
}

function iniciarActualizaciones({ licencias, ventana, log }) {
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { log(`[update] no disponible: ${e.message}`); return; }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m) => log(`[update] ${m}`), warn: (m) => log(`[update] ${m}`), error: (m) => log(`[update] ${m}`), debug: () => {} };
  redirigirManifiesto(autoUpdater.netSession);

  autoUpdater.on('update-available', (info) => {
    // Con la licencia vencida o anulada no se actualiza (el CRM sigue igual, en solo lectura).
    if (licencias.estado().modo !== 'completo') {
      log(`[update] ${info.version} disponible, pero la licencia no está vigente; no se descarga`);
      return;
    }
    log(`[update] descargando ${info.version}`);
    autoUpdater.downloadUpdate().catch((x) => log(`[update] descarga: ${x.message}`));
  });

  autoUpdater.on('update-downloaded', async (info) => {
    if (!ventana || ventana.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(ventana, {
      type: 'info', title: 'ALLNOVATECH CRM', buttons: ['Reiniciar ahora', 'Al cerrar'], defaultId: 1, cancelId: 1,
      message: `Hay una nueva versión lista (${info.version}).`,
      detail: 'Antes de aplicarla se crea y verifica un respaldo de tus datos. Si eliges «Al cerrar», se instalará cuando cierres el CRM.'
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (e) => log(`[update] ${e.message}`));

  const buscar = () => autoUpdater.checkForUpdates().catch((e) => log(`[update] búsqueda: ${e.message}`));
  setTimeout(buscar, 60 * 1000);
  setInterval(buscar, CADA).unref();
}

/** "0.1.26" > "0.1.9" (solo números). */
function esMasNueva(a, b) {
  const x = String(a || '').split('.').map(Number);
  const y = String(b || '').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

const MANIFIESTO_MAC = 'https://all-novatech.com/descargas/crmdesktop/latest-mac.json';

/**
 * Mac: la app no lleva firma de Apple, así que no puede reemplazarse sola
 * (Squirrel.Mac exige firma). Se consulta latest-mac.json y, si hay una
 * versión nueva, se ofrece abrir la descarga en el navegador.
 */
function avisarVersionMac({ ventana, log, appVersion }) {
  const { app, net, shell } = require('electron');
  let avisada = null;
  const revisar = async () => {
    try {
      const r = await net.fetch(MANIFIESTO_MAC, { cache: 'no-store' });
      if (!r.ok) return log(`[update] latest-mac.json respondió ${r.status}`);
      const m = await r.json();
      if (!esMasNueva(m.version, appVersion) || avisada === m.version) return;
      avisada = m.version;
      const arm = process.arch === 'arm64' || app.runningUnderARM64Translation;
      const url = (arm ? m.arm64 : m.x64) || m.pagina;
      if (!/^https:\/\/(www\.)?all-novatech\.com\//.test(String(url || ''))) return;
      log(`[update] Mac: ${m.version} disponible`);
      if (!ventana || ventana.isDestroyed()) return;
      const { response } = await dialog.showMessageBox(ventana, {
        type: 'info', title: 'ALLNOVATECH CRM', buttons: ['Descargar', 'Más tarde'], defaultId: 0, cancelId: 1,
        message: `Hay una nueva versión del CRM para Mac (${m.version}).`,
        detail: 'Descárgala, cierra el CRM y arrastra la app nueva a Aplicaciones (reemplaza la anterior). La conexión con la PC principal se mantiene.'
      });
      if (response === 0) shell.openExternal(url);
    } catch (e) { log(`[update] Mac: ${e.message}`); }
  };
  setTimeout(revisar, 60 * 1000);
  setInterval(revisar, CADA).unref();
}

module.exports = { iniciarActualizaciones, avisarVersionMac, esMasNueva };
