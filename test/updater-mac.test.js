// Aviso de versión nueva en Mac: comparación de versiones (sin Electron).
const test = require('node:test');
const assert = require('node:assert');
const { esMasNueva } = require('../src/main/updater');

test('compara versiones número a número', () => {
  assert.strictEqual(esMasNueva('0.1.27', '0.1.26'), true);
  assert.strictEqual(esMasNueva('0.1.10', '0.1.9'), true);
  assert.strictEqual(esMasNueva('0.2.0', '0.1.99'), true);
  assert.strictEqual(esMasNueva('0.1.26', '0.1.26'), false);
  assert.strictEqual(esMasNueva('0.1.9', '0.1.10'), false);
  assert.strictEqual(esMasNueva('', '0.1.26'), false);
  assert.strictEqual(esMasNueva(undefined, '0.1.26'), false);
});
