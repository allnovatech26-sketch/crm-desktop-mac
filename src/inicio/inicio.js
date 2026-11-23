// Pantalla local de inicio: elección de modo (primera vez), emparejar con la
// PC principal y «sin conexión». Habla con el proceso principal por allnovaInicio.
(function () {
  const api = window.allnovaInicio;
  const $ = (id) => document.getElementById(id);
  const secciones = ['eleccion', 'conectar', 'sin-conexion'];

  function mostrar(id) {
    for (const s of secciones) $(s).hidden = s !== id;
    progreso('');
    if (id === 'conectar') setTimeout(() => $('host').focus(), 0);
  }
  function progreso(texto) { $('progreso').textContent = texto || ''; $('progreso').hidden = !texto; }
  function bloquear(b) { for (const el of document.querySelectorAll('button, input')) el.disabled = b; }
  async function llamar(fn, ...args) {
    const r = await fn(...args);
    if (!r || !r.ok) throw new Error((r && r.mensaje) || 'No se pudo completar.');
    return r.data;
  }

  const vista = (location.hash || '#eleccion').slice(1);
  mostrar(secciones.includes(vista) ? vista : 'eleccion');

  api.estado().then((r) => {
    const d = r && r.ok ? r.data : {};
    if (d.servidor) {
      $('host').value = d.servidor.host || '';
      $('puerto').value = d.servidor.puerto || 54500;
    }
    if (d.error) $('detalle').textContent = d.error;
    $('btn-volver').hidden = !d.primeraVez;
    // Mac: siempre trabaja con la PC principal (no puede guardar los datos aquí).
    if (d.soloCliente) {
      $('btn-desvincular').closest('.pie').hidden = true;
      $('sub-conectar').innerHTML = 'Este CRM trabaja con los datos de la <b>PC principal</b> de tu oficina (Windows). '
        + 'En ella abre <b>Configuración → Trabajo en red</b>, actívalo y copia su dirección y su código. Ambas deben estar en la misma red (mismo Wi-Fi o router).';
    }
  });

  $('btn-principal').addEventListener('click', async () => {
    bloquear(true); progreso('Preparando esta PC como principal…');
    try { await llamar(api.elegirPrincipal); } catch (e) { bloquear(false); progreso(e.message); }
  });
  $('btn-cliente').addEventListener('click', () => mostrar('conectar'));
  $('btn-volver').addEventListener('click', () => mostrar('eleccion'));
  $('btn-cambiar').addEventListener('click', () => mostrar('conectar'));

  $('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('error').hidden = true;
    bloquear(true); progreso('Conectando con la PC principal…');
    try {
      await llamar(api.conectar, { host: $('host').value.trim(), puerto: Number($('puerto').value), codigo: $('codigo').value });
    } catch (e) {
      bloquear(false); progreso('');
      $('error').textContent = e.message; $('error').hidden = false;
    }
  });

  $('btn-reintentar').addEventListener('click', async () => {
    bloquear(true); progreso('Buscando la PC principal…');
    try { await llamar(api.reintentar); } catch (e) { bloquear(false); progreso(''); $('detalle').textContent = e.message; }
  });

  $('btn-desvincular').addEventListener('click', async () => {
    bloquear(true);
    try { await llamar(api.desvincular); } catch (e) { bloquear(false); progreso(e.message); }
  });
})();
