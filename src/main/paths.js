/**
 * Rutas de la app. Los DATOS viven fuera de la carpeta del programa (que el
 * instalador reemplaza en cada actualización) y sobreviven a desinstalar.
 *
 *   %LOCALAPPDATA%\Allnovatech\CRM\
 *     pg\        directorio de datos de PostgreSQL
 *     archivos\  uploads, PDFs/XML, reportes (cwd del backend)
 *     logs\
 *     secrets.bin  credenciales locales cifradas con DPAPI (safeStorage)
 *     config.json  puerto preferido, versión, etc. (sin secretos)
 *
 * Recursos empaquetados (solo lectura):
 *   dev:  repo (../backend, ../frontend/dist/desktop/browser, resources/)
 *   prod: process.resourcesPath (backend/, frontend/, pgsql/, node/)
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const empaquetado = app.isPackaged;
const repo = path.resolve(__dirname, '..', '..', '..');
const recursos = empaquetado ? process.resourcesPath : path.resolve(__dirname, '..', '..', 'resources');

const raizDatos = process.env.ALLNOVA_DESKTOP_DATA
  || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Allnovatech', 'CRM');

const paths = {
  empaquetado,
  raizDatos,
  pgData: path.join(raizDatos, 'pg'),
  archivos: path.join(raizDatos, 'archivos'),
  logs: path.join(raizDatos, 'logs'),
  secretos: path.join(raizDatos, 'secrets.bin'),
  licencia: path.join(raizDatos, 'licencia.jwt'),
  config: path.join(raizDatos, 'config.json'),
  pgHome: path.join(recursos, 'pgsql'),
  backend: empaquetado ? path.join(recursos, 'backend') : path.join(repo, 'backend'),
  frontend: empaquetado ? path.join(recursos, 'frontend') : path.join(repo, 'frontend', 'dist', 'desktop', 'browser'),
  // Backend con su propio Node (no el de Electron): evita recompilar bcrypt
  // y demás módulos nativos para la ABI de Electron.
  node: empaquetado ? path.join(recursos, 'node', 'node.exe') : (process.env.ALLNOVA_NODE || 'node'),
  splash: path.join(__dirname, '..', 'splash', 'splash.html')
};

function asegurarCarpetas() {
  for (const d of [paths.raizDatos, paths.archivos, paths.logs]) fs.mkdirSync(d, { recursive: true });
}

function leerConfig() {
  try { return JSON.parse(fs.readFileSync(paths.config, 'utf8')); } catch (_) { return {}; }
}

function guardarConfig(c) {
  fs.writeFileSync(paths.config, JSON.stringify(c, null, 2));
}

module.exports = { paths, asegurarCarpetas, leerConfig, guardarConfig };
