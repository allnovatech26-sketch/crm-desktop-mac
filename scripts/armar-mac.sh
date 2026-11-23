#!/usr/bin/env bash
# Arma ALLNOVATECH CRM para Mac EN UNA MAC (Apple Silicon o Intel):
#   bash scripts/armar-mac.sh [versión]          (desde la carpeta del kit / desktop)
# Hace lo mismo que el workflow «CRM Desktop para Mac»: instala dependencias,
# arma la app para Apple Silicon (arm64) e Intel (x64), la firma ad hoc (sin
# cuenta de Apple), crea los .dmg, prueba que arranque y deja todo en salida-mac/
# con SHA512SUMS y VERSION, listo para publicar con scripts/publicar-mac.sh.
set -euo pipefail

cd "$(dirname "$0")/.."
[ "$(uname)" = "Darwin" ] || { echo "Este script se ejecuta en una Mac."; exit 1; }
command -v node >/dev/null || { echo "Falta Node.js: instálalo desde https://nodejs.org (versión LTS) y vuelve a ejecutar."; exit 1; }
V="${1:-$(node -p "require('./package.json').version")}"
echo "$V" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "Versión inválida: $V"; exit 1; }
echo "== ALLNOVATECH CRM para Mac $V =="

echo "-- Instalando dependencias (unos minutos la primera vez)…"
npm ci --no-audit --no-fund
node --test test/updater-mac.test.js

echo "-- Armando las apps…"
rm -rf dist-mac salida-mac
export CSC_IDENTITY_AUTO_DISCOVERY=false
npx electron-builder --mac dir --arm64 -c electron-builder.mac.json -c.extraMetadata.version="$V"
npx electron-builder --mac dir --x64 -c electron-builder.mac.json -c.extraMetadata.version="$V"

echo "-- Firmando y creando los .dmg…"
mkdir -p salida-mac
for par in "mac-arm64:arm64" "mac:x64"; do
  dir="${par%%:*}"; arch="${par##*:}"
  APP="dist-mac/$dir/ALLNOVATECH CRM.app"
  # Sin firma de Apple; Apple Silicon exige al menos una firma local válida.
  codesign --force --deep --sign - "$APP"
  codesign --verify --deep --strict "$APP"
  rm -rf dist-mac/staging && mkdir dist-mac/staging
  cp -R "$APP" dist-mac/staging/
  ln -s /Applications dist-mac/staging/Aplicaciones
  hdiutil create -volname "ALLNOVATECH CRM" -srcfolder dist-mac/staging -ov -format UDZO "salida-mac/ALLNOVATECH-CRM-Mac-$V-$arch.dmg"
done
(cd salida-mac && shasum -a 512 *.dmg > SHA512SUMS)
echo "$V" > salida-mac/VERSION

echo "-- Probando que arranque…"
NATIVA=$([ "$(uname -m)" = "arm64" ] && echo mac-arm64 || echo mac)
DATOS="$(mktemp -d)"
ALLNOVA_DESKTOP_DATA="$DATOS" ALLNOVA_SIN_ACTUALIZAR=1 "dist-mac/$NATIVA/ALLNOVATECH CRM.app/Contents/MacOS/ALLNOVATECH CRM" >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 30); do
  grep -q 'pantalla de conexión' "$DATOS/logs/desktop.log" 2>/dev/null && break
  sleep 1
done
kill "$PID" 2>/dev/null || true
if grep -q 'Mac sin PC principal: pantalla de conexión' "$DATOS/logs/desktop.log" 2>/dev/null && ! grep -q 'ERROR' "$DATOS/logs/desktop.log"; then
  echo "   Arranque OK."
else
  echo "   La app no arrancó bien. Registro:"; cat "$DATOS/logs/desktop.log" 2>/dev/null || true; exit 1
fi

echo
echo "Listo. Copia la carpeta salida-mac completa a la PC (USB o Drive):"
ls -lh salida-mac
[ -n "${CI:-}" ] || open salida-mac 2>/dev/null || true
