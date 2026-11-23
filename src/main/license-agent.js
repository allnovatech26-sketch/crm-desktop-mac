/**
 * license-agent — licencia de esta PC con la oficina de licencias de
 * ALLNOVATECH (https://licencias.all-novatech.com, la misma de AgroNova y
 * NovaControl), producto `crmdesktop`.
 *
 * - La oficina firma la licencia con Ed25519 (sobre el texto b64url); aquí
 *   solo está la llave pública, así que se valida SIN Internet.
 * - La PC se identifica con su `machine` (sale del MachineGuid de Windows) y
 *   un `secreto` propio que nunca se muestra.
 * - Prueba gratis: una por PC, registrada en la oficina con el nombre de la
 *   empresa y un contacto. Mientras no se registra (sin Internet), hay un uso
 *   provisional local.
 * - Compra / renovación: la oficina devuelve una página de pago Izipay que se
 *   abre en el navegador; al confirmarse el pago la licencia llega sola.
 * - Clave ALLN-…: ventas por transferencia, efectivo o distribuidores.
 * - Vencida, anulada o sin validar por mucho tiempo → solo lectura (nunca se
 *   borra nada).
 */
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const LLAVE_PUBLICA = require('./llave-licencia');

const PRODUCTO = 'crmdesktop';
const DIAS_PROVISIONAL = 14;   // sin registro en la oficina (sin Internet al instalar)
const DIAS_GRACIA = 15;        // sin conectarse después de revalidar_hasta
const EDICIONES = ['essential_ind', 'essential_eq', 'pro_desktop'];
// Un solo producto con todo incluido; lo que cambia entre planes es la cantidad
// de usuarios, que viene firmada en la licencia (campo usuarios).
const EDICION_COMPLETA = 'pro_desktop';
const USUARIOS_PRUEBA = 2;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const llave = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(LLAVE_PUBLICA, 'base64')]), format: 'der', type: 'spki' });
const desB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Licencia firmada `b64url(JSON).b64url(firma)`; la firma cubre el texto b64url. */
function leerToken(token) {
  const [cuerpo, firma] = String(token || '').split('.');
  if (!cuerpo || !firma) return null;
  try {
    if (!crypto.verify(null, Buffer.from(cuerpo), llave, desB64u(firma))) return null;
    const p = JSON.parse(desB64u(cuerpo).toString('utf8'));
    return p && p.prod === PRODUCTO ? p : null;
  } catch (_) { return null; }
}

function idEstable() {
  let guid = '';
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    guid = (out.match(/MachineGuid\s+REG_SZ\s+([0-9a-f-]{20,})/i) || [])[1] || '';
  } catch (_) { /* sin registro: datos estables del equipo */ }
  return guid ? `id:${guid.toLowerCase()}` : `eq:${[os.hostname(), os.platform(), os.arch(), os.cpus()?.[0]?.model || ''].join('|')}`;
}

// Fechas como las maneja la oficina (YYYY-MM-DD, hora local).
const fechaLocal = (ms) => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const hoy = () => fechaLocal(Date.now());
const sumarDias = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const diasEntre = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 864e5);

/** Horas que la app espera la confirmación de un pago abierto en el navegador. */
const HORAS_PAGO_ABIERTO = 3;

class LicenseAgent {
  /**
   * @param {object} o
   * @param {string} o.archivo          donde se guarda la licencia firmada (licencia.jwt)
   * @param {() => object} o.leerConfig
   * @param {(c:object) => void} o.guardarConfig
   * @param {string} o.apiUrl           oficina de licencias
   * @param {string} o.appVersion
   * @param {(m:string)=>void} [o.log]
   */
  constructor(o) {
    Object.assign(this, o);
    this.fs = require('fs');
    this.log = o.log || (() => {});
    this.apiUrl = String(o.apiUrl || '').replace(/\/+$/, '');
  }

  // ── identidad de la PC ───────────────────────────────────────────────────
  _cfg(cambios) {
    const c = this.leerConfig();
    if (!cambios) return c;
    const n = { ...c, ...cambios };
    for (const k of Object.keys(cambios)) if (cambios[k] === null) delete n[k];
    this.guardarConfig(n);
    return n;
  }

  /** 32 hexadecimales en mayúsculas, fijos para esta PC (se recalculan si copian config.json a otra). */
  equipo() {
    const c = this._cfg();
    const id = idEstable();
    const ancla = sha(`crmdesktop-ancla|${id}`).slice(0, 32);
    if (/^[0-9A-F]{32}$/.test(c.licEquipo || '') && c.licAncla === ancla) return c.licEquipo;
    const eq = sha(`crmdesktop-equipo|${id}`).slice(0, 32).toUpperCase();
    this._cfg({ licEquipo: eq, licAncla: ancla });
    return eq;
  }

  secreto() {
    const c = this._cfg();
    if (/^[0-9a-f]{64}$/.test(c.licSecreto || '')) return c.licSecreto;
    const s = crypto.randomBytes(32).toString('hex');
    this._cfg({ licSecreto: s });
    return s;
  }

  installationId() { return this.equipo(); }

  leerToken() {
    try { return this.fs.readFileSync(this.archivo, 'utf8').trim() || null; } catch (_) { return null; }
  }

  guardarToken(token) {
    if (!leerToken(token)) throw new Error('La licencia recibida no tiene una firma válida.');
    this.fs.mkdirSync(require('path').dirname(this.archivo), { recursive: true });
    this.fs.writeFileSync(this.archivo, token);
  }

  borrarToken() { this.fs.rmSync(this.archivo, { force: true }); }

  // ── estado ───────────────────────────────────────────────────────────────
  /**
   * { tipo: 'prueba'|'licencia', edicion, modo: 'completo'|'solo_lectura', motivo,
   *   plan?, cliente?, vence?, dias_restantes?, clave?, usuarios?, equipos?, provisional?, pago_disponible? }
   */
  estado() {
    const c = this._cfg();
    if (!c.instaladoEn) this._cfg({ instaladoEn: new Date().toISOString() });
    const h = hoy();
    const lic = leerToken(this.leerToken());
    const extra = { pago_disponible: !!c.licInfo?.pago_disponible, provisional: false, cuenta: c.licInfo?.cuenta || null };
    if (lic) {
      const edicion = EDICIONES.includes(lic.edicion) ? lic.edicion : EDICION_COMPLETA;
      const prueba = lic.plan === 'PRUEBA';
      const vence = lic.vence || lic.expira || null;
      const base = {
        tipo: prueba ? 'prueba' : 'licencia', edicion, plan: lic.plan, cliente: lic.cliente || null, clave: lic.clave || null,
        vence, usuarios: lic.usuarios ?? null, empresas: lic.empresas ?? null, equipos: lic.equipos ?? null, revalidar_hasta: lic.revalidar_hasta || null, ...extra
      };
      if (lic.equipo && lic.equipo !== this.equipo()) return { ...base, modo: 'solo_lectura', motivo: 'otro_equipo' };
      if (vence && vence < h) return { ...base, modo: 'solo_lectura', motivo: prueba ? 'prueba_vencida' : 'vencida' };
      if (lic.revalidar_hasta && sumarDias(lic.revalidar_hasta, DIAS_GRACIA) < h) return { ...base, modo: 'solo_lectura', motivo: 'sin_validar' };
      return { ...base, modo: 'completo', motivo: prueba ? 'prueba' : 'ok', dias_restantes: vence ? diasEntre(h, vence) : null };
    }
    if (c.licAnulada) return { tipo: 'licencia', edicion: EDICION_COMPLETA, usuarios: 1, modo: 'solo_lectura', motivo: 'revocada', ...extra };
    if (c.pruebaNegada) return { tipo: 'prueba', edicion: EDICION_COMPLETA, usuarios: 1, modo: 'solo_lectura', motivo: 'prueba_usada', detalle: c.pruebaNegada, ...extra };
    // Sin licencia de la oficina: uso provisional local mientras se registra la prueba.
    const desde = fechaLocal(new Date(this._cfg().instaladoEn).getTime());
    const hasta = sumarDias(desde, DIAS_PROVISIONAL);
    const vencida = hasta < h;
    return {
      tipo: 'prueba', edicion: EDICION_COMPLETA, usuarios: USUARIOS_PRUEBA, modo: vencida ? 'solo_lectura' : 'completo', motivo: vencida ? 'prueba_vencida' : 'prueba',
      vence: hasta, dias_restantes: Math.max(0, diasEntre(h, hasta)), ...extra, provisional: true, pendiente: c.pruebaError || null
    };
  }

  /** Lo que el backend necesita (env): edición y estado de la licencia. */
  paraBackend() {
    const e = this.estado();
    return {
      edicion: e.edicion,
      licencia: JSON.stringify({ modo: e.modo, motivo: e.motivo, tipo: e.tipo, usuarios: Number(e.usuarios) > 0 ? Number(e.usuarios) : null, empresas: Number(e.empresas) > 0 ? Number(e.empresas) : null, prueba_hasta: e.tipo === 'prueba' ? e.vence || null : null, dias_restantes: e.dias_restantes ?? null, vence: e.vence || null })
    };
  }

  // ── llamadas a la oficina: POST JSON con producto, machine y secreto; errores en {detail} ──
  async _llamar(ruta, cuerpo, metodo = 'POST') {
    let r;
    try {
      r = await fetch(`${this.apiUrl}/v1/${ruta}`, metodo === 'GET'
        ? { signal: AbortSignal.timeout(15000) }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
          body: JSON.stringify({ producto: PRODUCTO, machine: this.equipo(), secreto: this.secreto(), version: this.appVersion, ...cuerpo }) });
    } catch (_) {
      throw Object.assign(new Error('No se pudo conectar con la oficina de licencias de ALLNOVATECH. Revisa tu Internet e inténtalo otra vez.'), { code: 'SIN_CONEXION', red: true });
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.detail || `La oficina de licencias respondió ${r.status}.`), { status: r.status, vincular: !!j.vincular, code: `OFICINA_${r.status}` });
    return j;
  }

  _guardarInfo(j) {
    const cuenta = 'cuenta' in j ? (j.cuenta || null) : (this._cfg().licInfo?.cuenta || null);
    this._cfg({ licInfo: { estado: j.estado || null, pago_disponible: !!j.pago_disponible, expira: j.expira || null, cuenta, visto: new Date().toISOString() } });
  }

  // ── cuenta AllNovaTech (portal del cliente en all-novatech.com/mi-cuenta/) ──
  /** La PC tiene que estar registrada en la oficina (prueba o licencia), no en uso provisional. */
  _exigirRegistro() {
    if (!leerToken(this.leerToken())) {
      throw Object.assign(new Error('Primero registra tu prueba gratis o activa tu licencia (necesita Internet).'), { code: 'SIN_REGISTRO' });
    }
  }

  /** Pide un código de enlace: { codigo, url, expira_en }. */
  async iniciarCuenta() {
    this._exigirRegistro();
    const j = await this._llamar('cuenta/iniciar', {});
    if (!String(j.url || '').startsWith('https://')) throw new Error('La oficina no devolvió un enlace válido.');
    return { codigo: j.codigo, url: j.url, expira_en: Number(j.expira_en) || 900 };
  }

  /**
   * «Ya tengo cuenta» en el asistente: la PC aún no está registrada en la oficina,
   * así que el código se ata a su secreto. { codigo, url, expira_en }
   */
  /**
   * «Entrar con mi cuenta all-novatech.com» en el login: solo dice QUIÉN confirmó el
   * código en la web (su correo). No guarda nada ni cambia la cuenta de la licencia.
   * { conectado, vencido, cuenta }
   */
  async identidadCuenta(codigo) {
    const j = await this._llamar('cuenta/previo/estado', { codigo: String(codigo || '') });
    if (!j.conectado) return { conectado: false, vencido: !!j.vencido };
    return { conectado: true, vencido: false, cuenta: j.cuenta ? String(j.cuenta).trim().toLowerCase() : null };
  }

  async iniciarCuentaPrevia() {
    const j = await this._llamar('cuenta/previo/iniciar', {});
    if (!String(j.url || '').startsWith('https://')) throw new Error('La oficina no devolvió un enlace válido.');
    return { codigo: j.codigo, url: j.url, expira_en: Number(j.expira_en) || 900 };
  }

  /**
   * { conectado, vencido, cuenta, empresa: { nombre, ruc, contacto }, claves: [{ clave, plan, dias, equipos }] }
   * Al conectarse se recuerda el correo de la cuenta.
   */
  async estadoCuentaPrevia(codigo) {
    const j = await this._llamar('cuenta/previo/estado', { codigo: String(codigo || '') });
    if (!j.conectado) return { conectado: false, vencido: !!j.vencido };
    if (j.cuenta) this._cfg({ licInfo: { ...(this._cfg().licInfo || {}), cuenta: j.cuenta } });
    const claves = (Array.isArray(j.claves) ? j.claves : [])
      .filter((k) => /^ALLN(-[A-Z0-9]{5}){4}$/.test(String(k?.clave || '')))
      .map((k) => ({ clave: k.clave, plan: String(k.plan || ''), dias: Number(k.dias) || 0, equipos: Number(k.equipos) || 1 }));
    const e = j.empresa || {};
    return {
      conectado: true, vencido: false, cuenta: j.cuenta || null,
      empresa: { nombre: String(e.nombre || '').slice(0, 120), ruc: /^\d{11}$/.test(String(e.ruc || '')) ? e.ruc : null, contacto: e.contacto || null },
      claves
    };
  }

  /** { conectado, cuenta, vencido } — al conectarse se recuerda el correo. */
  async estadoCuenta(codigo) {
    const j = await this._llamar('cuenta/estado', { codigo: String(codigo || '') });
    if (j.conectado && j.cuenta) this._cfg({ licInfo: { ...(this._cfg().licInfo || {}), cuenta: j.cuenta } });
    return { conectado: !!j.conectado, cuenta: j.cuenta || null, vencido: !!j.vencido };
  }

  /** Mensaje a soporte con el diagnóstico de la PC: { numero, cuenta }. */
  async soporte({ asunto, mensaje, email, nombre, diagnostico }) {
    this._exigirRegistro();
    const a = String(asunto || '').trim(), m = String(mensaje || '').trim();
    if (a.length < 3 || a.length > 160) throw new Error('El asunto debe tener entre 3 y 160 caracteres.');
    if (m.length < 5 || m.length > 5000) throw new Error('El mensaje debe tener entre 5 y 5000 caracteres.');
    const conectada = !!this._cfg().licInfo?.cuenta;
    if (!conectada && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || '').trim())) throw new Error('Escribe tu correo para que te llegue la respuesta.');
    try {
      const j = await this._llamar('soporte', {
        asunto: a, mensaje: m, email: conectada ? undefined : String(email).trim(),
        nombre: String(nombre || '').trim().slice(0, 120) || undefined, diagnostico: diagnostico || {}
      });
      return { numero: j.numero, cuenta: j.cuenta || null };
    } catch (e) {
      if (e.status === 429) e.message = 'Enviaste muchos mensajes en poco tiempo. Espera un rato e inténtalo otra vez.';
      if (e.status === 502) e.message = 'Soporte no pudo recibir tu mensaje ahora. Escríbenos por WhatsApp desde all-novatech.com.';
      throw e;
    }
  }

  /**
   * ¿Falta registrar la prueba y no hay de dónde reintentarlo? Pasa si el
   * asistente no llegó a pedirla (se cerró la app, se instaló desde otra
   * ventana…): sin licencia, sin datos guardados, sin negativa ni compra.
   */
  faltanDatosPrueba() {
    const c = this._cfg();
    return !leerToken(this.leerToken()) && !c.pruebaDatos && !c.pruebaNegada && !c.licOrden && !c.licAnulada;
  }

  /** Guarda los datos de la empresa para que `refrescar` registre la prueba. */
  prepararPrueba({ cliente, contacto, ruc } = {}) {
    if (!String(cliente || '').trim() || !String(contacto || '').trim()) return false;
    this._cfg({ pruebaDatos: { cliente: String(cliente).trim(), contacto: String(contacto).trim(), ruc: ruc || null } });
    return true;
  }

  /** Prueba gratis registrada en la oficina (una por PC). */
  async pedirPrueba({ cliente, contacto, ruc }) {
    if (!String(cliente || '').trim() || !String(contacto || '').trim()) throw new Error('Para la prueba gratis se necesita el nombre de tu empresa y un correo o celular.');
    try {
      const j = await this._llamar('prueba', { cliente: String(cliente).trim(), contacto: String(contacto).trim(), ruc: /^\d{11}$/.test(String(ruc || '')) ? String(ruc) : undefined });
      this.guardarToken(j.licencia);
      this._cfg({ pruebaNegada: null, pruebaError: null, pruebaDatos: null });
      this.log('[licencia] prueba registrada en la oficina');
      return this.estado();
    } catch (e) {
      if (e.status === 409) this._cfg({ pruebaNegada: String(e.message).slice(0, 200) });
      else {
        // Sin red o cualquier otro fallo (oficina caída, 5xx…): se guarda para
        // reintentarlo al refrescar; si no, la PC quedaría sin prueba para siempre.
        this._cfg({ pruebaDatos: { cliente, contacto, ruc: ruc || null }, pruebaError: e.red ? null : String(e.message).slice(0, 200) });
      }
      throw e;
    }
  }

  async activar(clave) {
    const k = String(clave || '').trim().toUpperCase();
    if (!/^ALLN(-[A-Z0-9]{5}){4}$/.test(k)) throw Object.assign(new Error('La clave tiene la forma ALLN-XXXXX-XXXXX-XXXXX-XXXXX.'), { code: 'CLAVE_INVALIDA' });
    const j = await this._llamar('activar', { clave: k, cliente: this._cfg().pruebaDatos?.cliente || this._cfg().licCliente || undefined });
    this.guardarToken(j.licencia);
    this._cfg({ pruebaNegada: null, licAnulada: null });
    this.log('[licencia] activada con clave');
    await this.refrescar({ forzar: true }).catch(() => {});
    return this.estado();
  }

  /**
   * Al abrir y cada pocas horas (sin Internet no pasa nada). Renueva
   * revalidar_hasta, trae la licencia nueva tras un pago y detecta anulaciones.
   * Devuelve true si cambió la licencia (para reiniciar el backend).
   */
  async refrescar({ forzar = false } = {}) {
    this._vencerPagoAbandonado();
    const c = this._cfg();
    const token = this.leerToken();
    if (!leerToken(token)) {
      if (c.pruebaDatos && !c.pruebaNegada) {
        try { await this.pedirPrueba(c.pruebaDatos); return true; } catch (_) { return false; }
      }
      if (!c.licOrden) return false;   // sin compra pendiente no hay nada que consultar
    }
    if (!forzar && c.licInfo?.visto && Date.now() - new Date(c.licInfo.visto).getTime() < 60 * 60 * 1000 && !c.licOrden) return false;
    let j;
    try { j = await this._llamar('estado', {}); } catch (e) {
      if (e.status === 401 && e.vincular && token) {
        await this._llamar('vincular', { lic_hash: sha(String(token)) }).catch(() => {});
        try { j = await this._llamar('estado', {}); } catch (_) { return false; }
      } else return false;
    }
    this._guardarInfo(j);
    if (j.licencia) {
      if (j.licencia === token) return false;
      try { this.guardarToken(j.licencia); this._cfg({ licOrden: null, licAnulada: null }); return true; } catch (_) { return false; }
    }
    if (token && j.estado && j.estado !== 'activa' && j.estado !== 'pendiente') {
      this.borrarToken();
      this._cfg({ licAnulada: true });
      this.log(`[licencia] la oficina la marcó como ${j.estado}`);
      return true;
    }
    return false;
  }

  /** Libera esta PC para usar la clave en otra. */
  async desactivar() {
    if (!this.leerToken()) return { liberada: false };
    await this._llamar('liberar', {});
    this.borrarToken();
    this._cfg({ licInfo: null });
    return { liberada: true };
  }

  // ── compra y renovación con Izipay (la oficina da la página de pago) ──
  async planes() {
    const j = await this._llamar(`planes?producto=${PRODUCTO}`, null, 'GET');
    return { planes: j.planes || [], pagos: !!j.pagos };
  }

  async comprar({ plan, cliente, contacto, email, ruc }) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || ''))) throw new Error('Escribe un correo válido: ahí llega tu comprobante y tu licencia.');
    const j = await this._llamar('comprar', { plan, cliente, contacto: contacto || email, email, ruc: /^\d{11}$/.test(String(ruc || '')) ? String(ruc) : undefined });
    this._cfg({ licOrden: j.orden, licOrdenEn: new Date().toISOString(), licCliente: cliente });
    return { orden: j.orden, url_pago: j.url_pago, monto: j.monto };
  }

  async pagar({ email } = {}) {
    const j = await this._llamar('pagar', { email: email || undefined });
    this._cfg({ licOrden: j.orden, licOrdenEn: new Date().toISOString() });
    return { orden: j.orden, url_pago: j.url_pago, monto: j.monto, dias: j.dias };
  }

  /**
   * «Ya no voy a pagar»: deja de esperar la confirmación. Si igual se paga, la
   * oficina aplica el pago a este equipo y la licencia llega en la siguiente
   * consulta (cada 6 h, al abrir el CRM o con «Revisar»).
   */
  cancelarPago() {
    this._cfg({ licOrden: null, licOrdenEn: null });
    return true;
  }

  /** Un pago abierto y no confirmado en 3 h se da por abandonado (antes se esperaba para siempre). */
  _vencerPagoAbandonado(ahora = Date.now()) {
    const c = this._cfg();
    if (!c.licOrden) return false;
    if (!c.licOrdenEn) { this._cfg({ licOrdenEn: new Date(ahora).toISOString() }); return false; }   // orden de una versión anterior
    if (ahora - new Date(c.licOrdenEn).getTime() < HORAS_PAGO_ABIERTO * 36e5) return false;
    this._cfg({ licOrden: null, licOrdenEn: null });
    this.log(`[licencia] el pago ${c.licOrden} no se confirmó en ${HORAS_PAGO_ABIERTO} h: se deja de esperar`);
    return true;
  }
}

module.exports = { LicenseAgent, leerToken, PRODUCTO, DIAS_PROVISIONAL, EDICION_COMPLETA, USUARIOS_PRUEBA };
