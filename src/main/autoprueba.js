/**
 * Autoprueba de punta a punta (solo desarrollo: ALLNOVA_AUTOPRUEBA=1 y app
 * sin empaquetar). Ejercita el puente REAL (preload + IPC) desde la ventana:
 * instalación → código → respaldo → recuperación de acceso → restauración.
 * Escribe ✔/✘ en desktop.log y termina la app.
 */
const ADMIN = { nombre: 'Admin Autoprueba', email: 'admin.autoprueba@desktop.test', password: 'Autoprueba2026x' };
const NUEVA = 'Recuperada2026x';

async function ejecutar({ ventana, restaurarFlujo, log }) {
  const wc = ventana.webContents;
  wc.on('console-message', (_e, nivel, mensaje) => { if (nivel >= 2) log(`[autoprueba][consola] ${mensaje}`); });
  const conLimite = (p, ms, que) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`tiempo agotado: ${que}`)), ms))]);
  const enVentana = (codigo) => conLimite(wc.executeJavaScript(`(async () => { ${codigo} })()`, true), 120000, 'script en la ventana');
  // Espera a que la página del CRM esté cargada (con límite: el evento puede haber pasado ya).
  const esperarCarga = async () => {
    for (let i = 0; i < 120; i += 1) {
      if (!wc.isLoading() && /^http:\/\/127\.0\.0\.1:/.test(wc.getURL())) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`la ventana no cargó el CRM (url ${wc.getURL()})`);
  };
  log(`[autoprueba] inicio en ${wc.getURL()}`);
  const resultados = [];
  const ok = (m) => { resultados.push(`✔ ${m}`); log(`[autoprueba] ✔ ${m}`); };
  const falla = (m) => { throw new Error(m); };
  const login = (email, password) => enVentana(`
    const r = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} }) });
    const j = await r.json().catch(() => ({}));
    const buscar = (o) => { if (!o || typeof o !== 'object') return null; for (const [k, v] of Object.entries(o)) { if (/token/i.test(k) && typeof v === 'string' && v.split('.').length === 3) return v; const x = buscar(v); if (x) return x; } return null; };
    return { status: r.status, token: buscar(j) };`);

  try {
    await esperarCarga();
    const puente = await enVentana('return typeof window.allnovaDesktop === "object" && typeof window.allnovaDesktop.respaldos.crear === "function";');
    if (!puente) falla('el preload no expuso window.allnovaDesktop');
    ok('preload: window.allnovaDesktop disponible en la ventana del CRM');

    const inst = await enVentana(`
      const r = await fetch('/api/v1/desktop/instalar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresa: { nombre: 'Autoprueba SAC' }, admin: ${JSON.stringify(ADMIN)} }) });
      return r.status;`);
    if (inst !== 201) falla(`instalar respondió ${inst}`);
    ok('instalación inicial (201)');

    const cod = await enVentana('return await window.allnovaDesktop.codigo.ver();');
    if (!cod.ok || !/^([A-Z0-9]{4}-){5}[A-Z0-9]{4}$/.test(cod.data.codigo)) falla('código de recuperación inválido');
    const codigo = cod.data.codigo;
    ok('código de recuperación disponible por el puente');

    const bk = await enVentana('return await window.allnovaDesktop.respaldos.crear();');
    if (!bk.ok) falla(`respaldo: ${bk.mensaje}`);
    const est = await enVentana('return await window.allnovaDesktop.respaldos.estado();');
    const respaldo = est.data?.lista?.[0];
    if (!respaldo || respaldo.empresa !== 'Autoprueba SAC') falla('el respaldo no aparece en la lista');
    ok(`respaldo manual creado y verificado (${respaldo.nombre})`);

    // Datos nuevos posteriores al respaldo (la restauración debe quitarlos).
    const s1 = await login(ADMIN.email, ADMIN.password);
    if (s1.status !== 200 || !s1.token) falla(`login inicial ${s1.status}`);
    const creados = await enVentana(`
      let n = 0;
      for (const x of ['Uno', 'Dos']) {
        const r = await fetch('/api/v1/leads', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ${s1.token}' },
          body: JSON.stringify({ name: 'Lead ' + x, correo: 'lead' + x + '@desktop.test' }) });
        if (r.status === 201) n += 1;
      }
      return n;`);
    if (creados !== 2) falla(`se crearon ${creados} leads`);
    ok('2 leads creados después del respaldo');

    const malo = await enVentana(`return await window.allnovaDesktop.acceso.recuperar(${JSON.stringify(ADMIN.email)}, 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF', ${JSON.stringify(NUEVA)});`);
    if (malo.ok || malo.code !== 'CODIGO_INCORRECTO') falla('aceptó un código de recuperación incorrecto');
    ok('recuperar acceso con código incorrecto: rechazado');

    const bueno = await enVentana(`return await window.allnovaDesktop.acceso.recuperar(${JSON.stringify(ADMIN.email)}, ${JSON.stringify(codigo.toLowerCase())}, ${JSON.stringify(NUEVA)});`);
    if (!bueno.ok) falla(`recuperar acceso: ${bueno.mensaje}`);
    const conNueva = await login(ADMIN.email, NUEVA);
    const conVieja = await login(ADMIN.email, ADMIN.password);
    if (conNueva.status !== 200 || conVieja.status === 200) falla(`login tras recuperar: nueva ${conNueva.status}, vieja ${conVieja.status}`);
    ok('recuperar acceso con el código: nueva contraseña funciona, la anterior no');

    const sinToken = await enVentana(`
      const r = await fetch('/api/v1/desktop/restablecer-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ${JSON.stringify(ADMIN.email)}, password: 'Hack2026xx' }) });
      return r.status;`);
    if (sinToken !== 403) falla(`restablecer-admin sin token respondió ${sinToken}`);
    ok('el navegador no puede restablecer contraseñas sin el token interno (403)');

    // Restaurar (flujo real del IPC, con la confirmación aceptada).
    const r = await restaurarFlujo({ archivo: respaldo.archivo });
    if (!r.restaurado) falla('restauración no completada');
    await esperarCarga();
    const tras = await login(ADMIN.email, ADMIN.password);
    if (tras.status !== 200) falla(`tras restaurar, la contraseña original no funciona (${tras.status})`);
    const leads = await enVentana(`
      const r = await fetch('/api/v1/leads/kanban', { headers: { Authorization: 'Bearer ${tras.token}' } });
      const j = await r.json(); const cols = Array.isArray(j) ? j : (j.data || j.columns || []);
      return cols.reduce((n, c) => n + ((c.leads || []).length), 0);`);
    if (leads !== 0) falla(`tras restaurar hay ${leads} leads (se esperaban 0)`);
    ok(`restauración: vuelve al estado del respaldo (0 leads, contraseña original); seguridad: ${r.seguridad}`);

    const fin = await enVentana('return await window.allnovaDesktop.respaldos.estado();');
    if (!fin.data.lista.some((x) => x.motivo === 'antes-de-restaurar')) falla('no hay respaldo "antes de restaurar"');
    ok('se creó el respaldo de seguridad antes de restaurar');
    log(`[autoprueba] RESULTADO: ${resultados.length} pasos OK`);
  } catch (e) {
    log(`[autoprueba] ✘ ${e.message}`);
    log(`[autoprueba] RESULTADO: FALLÓ tras ${resultados.length} pasos`);
  }
}

module.exports = { ejecutar };
