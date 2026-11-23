/**
 * Cliente del puente de WhatsApp (desktop/puente-whatsapp) en el proceso principal.
 *
 * - Conectar: pide una sesión al puente (con la licencia firmada y la llave
 *   pública RSA de esta PC), abre la ventana de Facebook en el navegador y
 *   espera el resultado: el token del negocio y la credencial del canal,
 *   cifrados para esta PC. Luego guarda la conexión en el CRM local.
 * - Recibir: mantiene un WebSocket con el buzón de esta PC. Cada mensaje llega
 *   cifrado; se descifra, se entrega al backend local (que lo procesa como si
 *   viniera de Meta) y recién entonces se confirma al puente para que lo borre.
 *   Si el CRM no pudo guardarlo, no se confirma y el puente lo reenvía.
 *
 * La llave privada y la credencial del canal viven en los secretos locales
 * (cifrados con DPAPI); nunca salen de la PC.
 */
const crypto = require('crypto');
const WebSocket = require('ws');

const ESPERA_SESION_MS = 30 * 60e3;

function descifrar(privadaPem, carga) {
  const c = JSON.parse(carga);
  const llave = crypto.privateDecrypt({ key: privadaPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(c.k, 'base64'));
  const datos = Buffer.from(c.c, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', llave, Buffer.from(c.iv, 'base64'));
  d.setAuthTag(datos.subarray(datos.length - 16));
  return Buffer.concat([d.update(datos.subarray(0, datos.length - 16)), d.final()]).toString('utf8');
}

class PuenteWhatsApp {
  /**
   * @param {object} o
   * @param {string} o.url               https://conecta.all-novatech.com
   * @param {() => string|null} o.licencia    token de licencia firmado (o null)
   * @param {() => object} o.secretos         secretos locales (se modifican y se guardan con o.guardarSecretos)
   * @param {(s: object) => void} o.guardarSecretos
   * @param {(payload: object) => Promise<void>} o.entregar       al backend local
   * @param {(datos: object) => Promise<void>} o.guardarConexion  al backend local
   * @param {() => Promise<void>} o.borrarConexion
   * @param {(url: string) => void} o.abrir     abre el navegador
   * @param {(m: string) => void} o.log
   */
  constructor(o) {
    Object.assign(this, { url: String(o.url).replace(/\/+$/, ''), o });
    this.ws = null;
    this.estadoConexion = { conectando: false, error: null, enLinea: false, recibidos: 0, ultimo: null };
    this.reintento = 2000;
    this.detenido = false;
  }

  _s() { return this.o.secretos(); }
  _guardar(cambios) { const s = this._s(); Object.assign(s, cambios); this.o.guardarSecretos(s); }

  _llaves() {
    const s = this._s();
    if (!s.waLlavePrivada || !s.waLlavePublica) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      this._guardar({
        waLlavePrivada: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        waLlavePublica: publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
      });
    }
    return this._s();
  }

  _licencia() {
    const t = this.o.licencia();
    if (!t) {
      throw Object.assign(new Error('Para usar WhatsApp, la prueba gratis o la licencia debe estar registrada en ALLNOVATECH. El CRM lo intenta solo cuando hay Internet; si en unos minutos sigue igual, abre Configuración → Licencia.'), { code: 'SIN_LICENCIA' });
    }
    return t;
  }

  async _pedir(ruta, opciones = {}) {
    let r;
    try {
      r = await fetch(this.url + ruta, { ...opciones, signal: AbortSignal.timeout(20000) });
    } catch (_) {
      throw Object.assign(new Error('No hay conexión con el servicio de WhatsApp. Revisa tu Internet.'), { code: 'SIN_CONEXION' });
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `El servicio de WhatsApp respondió ${r.status}.`), { status: r.status, code: `PUENTE_${r.status}` });
    return j;
  }

  // ── Varias empresas en la PC ─────────────────────────────────────────
  // El canal del puente es UNO por PC (todos los números y páginas llegan al
  // mismo buzón; el backend reparte cada mensaje a su empresa por número o
  // página). Lo que sí es por empresa es qué número/páginas conectó cada una:
  //   waNumeros[idEmpresa]          número(s) de WhatsApp de esa empresa
  //   metaMensajeriaPor[idEmpresa]  páginas de Messenger/Instagram de esa empresa
  // `waNumero` / `metaMensajeria` son de versiones de una sola empresa: se
  // pasan a la empresa original con migrarLegado().

  /** Lo guardado antes de haber varias empresas pasa a la empresa original. */
  migrarLegado(idPrimera) {
    if (idPrimera == null) return;
    const s = this._s();
    const cambios = {};
    if (s.waNumero && !Object.keys(s.waNumeros || {}).length) {
      cambios.waNumeros = { [idPrimera]: s.waNumero };
      cambios.waNumero = null;
    }
    if (s.metaMensajeria && !Object.keys(s.metaMensajeriaPor || {}).length) {
      cambios.metaMensajeriaPor = { [idPrimera]: s.metaMensajeria };
      cambios.metaMensajeria = null;
    }
    if (Object.keys(cambios).length) this._guardar(cambios);
  }

  _numerosPorEmpresa() { return { ...(this._s().waNumeros || {}) }; }
  _mensajeriaPorEmpresa() { return { ...(this._s().metaMensajeriaPor || {}) }; }

  /**
   * @param {number|null} [idEmpresa]  empresa de la sesión; sin ella, la vista
   *   de una sola empresa de siempre.
   */
  estado(idEmpresa = null) {
    const s = this._s();
    if (idEmpresa == null) {
      const numero = s.waNumero || Object.values(s.waNumeros || {})[0] || null;
      const meta = s.metaMensajeria || Object.values(s.metaMensajeriaPor || {})[0] || null;
      return {
        // WhatsApp está conectado si hay número; el canal puede estar abierto solo por Messenger/Instagram.
        conectado: !!s.waCanal && (!!numero || !meta),
        numero,
        meta,
        ...this.estadoConexion
      };
    }
    const numero = (s.waNumeros || {})[idEmpresa] || null;
    return {
      conectado: !!s.waCanal && !!numero,
      numero,
      meta: (s.metaMensajeriaPor || {})[idEmpresa] || null,
      ...this.estadoConexion,
      // «Conectando…» solo en la empresa que inició la conexión.
      conectando: !!this.estadoConexion.conectando && this.idEmpresaConectando === idEmpresa
    };
  }

  /** Paso 1: abre la ventana de Facebook en el navegador. El resto sigue en segundo plano. */
  async conectar(idEmpresa = null) {
    if (this.estadoConexion.conectando) throw new Error('Ya hay una conexión en curso. Termínala en tu navegador.');
    this.idEmpresaConectando = idEmpresa;
    const s = this._llaves();
    const j = await this._pedir('/v1/sesion', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ licencia: this._licencia(), llave: s.waLlavePublica })
    });
    this.estadoConexion = { ...this.estadoConexion, conectando: true, error: null };
    this.o.abrir(j.url);
    this._esperarSesion(j.sesion).catch((e) => {
      this.o.log(`[whatsapp] conexión: ${e.message}`);
      this.estadoConexion = { ...this.estadoConexion, conectando: false, error: e.message };
    });
    return { url: j.url };
  }

  /** Guarda la conexión (ventana de Facebook o directa) en el backend y abre el canal. */
  async _aplicar(d, idEmpresa = null) {
    // El puente ya reemplazó la credencial del canal de esta PC: se guarda SIEMPRE,
    // aunque el CRM rechace la conexión (número de otra empresa, etc.). Si no, la
    // PC se queda con la credencial vieja y TODAS las empresas dejan de recibir.
    if (d.secreto) this.guardarCanal(d.secreto);
    try {
      await this.o.guardarConexion(d, idEmpresa);
    } catch (e) {
      this.estadoConexion = { ...this.estadoConexion, conectando: false, error: e.message };
      throw e;
    }
    const total = Array.isArray(d.numeros) ? d.numeros.length : 1;
    const numero = { phone_number_id: d.phone_number_id, waba_id: d.waba_id, display: d.display_phone_number, nombre: d.verified_name, total };
    if (idEmpresa == null) this._guardar({ waCanal: d.secreto, waNumero: numero });
    else this._guardar({ waCanal: d.secreto, waNumeros: { ...this._numerosPorEmpresa(), [idEmpresa]: numero } });
    this.o.log(`[whatsapp] ${total > 1 ? `${total} números conectados` : `número ${d.display_phone_number || d.phone_number_id} conectado`}${d.directo ? ' (conexión directa)' : ''}`);
    this.estadoConexion = { ...this.estadoConexion, conectando: false, error: null };
    this.reiniciar();
  }

  /**
   * Conexión directa (dueño de la cuenta de Meta): con un token de usuario del sistema
   * de su portafolio. Conecta todas sus cuentas de WhatsApp y números de una vez.
   */
  async conectarDirecto(token, idEmpresa = null) {
    if (this.estadoConexion.conectando) throw new Error('Ya hay una conexión en curso. Termínala o espera un momento.');
    const limpio = String(token || '').trim();
    if (!/^EAA[A-Za-z0-9]{30,}/.test(limpio)) throw new Error('Pega el token completo del usuario del sistema (empieza con EAA…).');
    const s = this._llaves();
    const j = await this._pedir('/v1/conectar-directo', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ licencia: this._licencia(), llave: s.waLlavePublica, token: limpio })
    });
    const d = JSON.parse(descifrar(this._s().waLlavePrivada, j.resultado));
    await this._aplicar(d, idEmpresa);
    return { numeros: (d.numeros || []).map((n) => ({ display: n.display_phone_number, nombre: n.verified_name })), avisos: j.avisos || [] };
  }

  async _esperarSesion(id) {
    const hasta = Date.now() + ESPERA_SESION_MS;
    while (Date.now() < hasta) {
      await new Promise((r) => setTimeout(r, 2500));
      let j;
      try { j = await this._pedir(`/v1/sesion/${id}`); } catch (e) { if (e.status === 404) throw new Error('La conexión venció. Vuelve a pulsar «Conectar WhatsApp».'); continue; }
      if (j.estado === 'error') throw new Error(j.error || 'Facebook no completó la conexión.');
      if (j.estado !== 'listo') continue;
      await this._aplicar(JSON.parse(descifrar(this._s().waLlavePrivada, j.resultado)), this.idEmpresaConectando ?? null);
      return;
    }
    throw new Error('Se acabó el tiempo para conectar. Vuelve a pulsar «Conectar WhatsApp».');
  }

  /**
   * Desconecta el WhatsApp de una empresa. Con varias empresas el canal del
   * puente es compartido: se le pide al puente que olvide SOLO los números de
   * esta empresa, y la credencial del canal se borra solo si ya no queda nada.
   */
  async desconectar(idEmpresa = null) {
    const s = this._s();
    const porEmpresa = this._numerosPorEmpresa();
    const suyo = idEmpresa == null ? (s.waNumero || null) : (porEmpresa[idEmpresa] || null);
    if (idEmpresa != null) delete porEmpresa[idEmpresa];
    const quedanOtros = Object.keys(porEmpresa).length > 0 || (idEmpresa != null && !!s.waNumero);
    // El canal del puente también trae Messenger/Instagram: si están conectados, sigue abierto.
    const sigueMeta = !!s.metaMensajeria || Object.keys(s.metaMensajeriaPor || {}).length > 0;
    const sigue = quedanOtros || sigueMeta;

    this.detener();
    try {
      // Con otras empresas usando el canal se mandan SOLO los números de esta; si
      // esta empresa no tenía número, no se le pide nada al puente (un cuerpo vacío
      // borraría los números de todas las empresas de la PC).
      if (s.waCanal && (suyo || !quedanOtros)) {
        const numeros = quedanOtros ? await this._numerosDeEmpresa(idEmpresa, suyo) : null;
        await this._pedir('/v1/desconectar', {
          method: 'POST',
          headers: { authorization: `Bearer ${this._equipo()}.${s.waCanal}`, 'content-type': 'application/json' },
          body: JSON.stringify(numeros ? { numeros } : {})
        }).catch(() => {});
      }
      await this.o.borrarConexion(idEmpresa);
      this._guardar({
        waCanal: sigue ? s.waCanal : null,
        ...(idEmpresa == null ? { waNumero: null } : { waNumeros: porEmpresa })
      });
      this.estadoConexion = { conectando: false, error: null, enLinea: false, recibidos: 0, ultimo: null };
      return { ok: true };
    } finally {
      // Pase lo que pase, si el canal sigue en uso se vuelve a abrir.
      if (sigue || this._s().waCanal) this.reiniciar();
    }
  }

  /** phone_number_id de la empresa (el backend tiene la lista completa si conectó varios). */
  async _numerosDeEmpresa(idEmpresa, suyo) {
    let lista = null;
    try { lista = this.o.numerosDeEmpresa ? await this.o.numerosDeEmpresa(idEmpresa) : null; } catch (_) { lista = null; }
    return [...new Set([...(Array.isArray(lista) ? lista : []), suyo && suyo.phone_number_id].filter(Boolean).map(String))];
  }

  /** Credencial nueva del canal (la emite el puente en cada conexión): se guarda y se reabre. */
  guardarCanal(secreto) {
    if (!secreto || this._s().waCanal === secreto) return;
    this._guardar({ waCanal: secreto });
    this.reiniciar();
  }

  /**
   * «Conectar con Facebook» trajo Messenger/Instagram: el puente emitió una credencial
   * nueva para el canal de esta PC (la misma que usa WhatsApp). Se guarda y se reabre.
   */
  usarCanalMeta(secreto, paginas = [], idEmpresa = null) {
    if (!secreto) return;
    const meta = { paginas: paginas.map((p) => ({ id: p.id, nombre: p.nombre, instagram: p.instagram?.usuario || null })), desde: new Date().toISOString() };
    if (idEmpresa == null) this._guardar({ waCanal: secreto, metaMensajeria: meta });
    else this._guardar({ waCanal: secreto, metaMensajeriaPor: { ...this._mensajeriaPorEmpresa(), [idEmpresa]: meta } });
    this.o.log(`[meta] Messenger/Instagram: ${paginas.length} página(s) por el puente`);
    this.reiniciar();
  }

  _equipo() {
    const [cuerpo] = String(this._licencia()).split('.');
    return JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8')).equipo;
  }

  // ── buzón ─────────────────────────────────────────────────────────────
  iniciar() {
    this.detenido = false;
    if (!this._s().waCanal || this.ws) return;
    let licencia, equipo;
    try { licencia = this._licencia(); equipo = this._equipo(); } catch (e) {
      this.estadoConexion.error = e.message;
      return this._programar(30 * 60e3);
    }
    const ws = new WebSocket(this.url.replace(/^http/, 'ws') + '/v1/buzon', {
      headers: { authorization: `Bearer ${equipo}.${this._s().waCanal}`, 'x-licencia': licencia },
      handshakeTimeout: 20000
    });
    this.ws = ws;
    let ping = null;
    ws.on('open', () => {
      this.reintento = 2000;
      this.estadoConexion = { ...this.estadoConexion, enLinea: true, error: null };
      ping = setInterval(() => { try { ws.send('{"tipo":"ping"}'); } catch (_) {} }, 25000);
    });
    ws.on('message', (datos) => this._recibir(ws, datos).catch((e) => this.o.log(`[whatsapp] buzón: ${e.message}`)));
    ws.on('unexpected-response', (req, res) => {
      // 401: la credencial ya no vale (se conectó en otra PC o se desconectó).
      // 402: licencia vencida o sin WhatsApp. No insistir cada pocos segundos.
      let cuerpo = '';
      res.on('data', (c) => { cuerpo += c; });
      res.on('end', () => {
        let msg = ''; try { msg = JSON.parse(cuerpo).error || ''; } catch (_) {}
        this.estadoConexion.error = msg || `El servicio de WhatsApp respondió ${res.statusCode}.`;
        if (res.statusCode === 401) { this._guardar({ waCanal: null }); this.estadoConexion.error = 'WhatsApp se desconectó de esta PC. Vuelve a conectarlo.'; }
        if (res.statusCode === 402 || res.statusCode === 403) this.reintento = 30 * 60e3;
      });
    });
    ws.on('error', (e) => { this.o.log(`[whatsapp] conexión: ${e.message}`); });
    ws.on('close', () => {
      clearInterval(ping);
      if (this.ws === ws) this.ws = null;
      this.estadoConexion.enLinea = false;
      if (!this.detenido && this._s().waCanal) this._programar(this.reintento);
      this.reintento = Math.min(this.reintento * 2, 60000);
    });
  }

  _programar(ms) {
    clearTimeout(this.temporizador);
    this.temporizador = setTimeout(() => this.iniciar(), ms);
    this.temporizador.unref?.();
  }

  async _recibir(ws, datos) {
    let m; try { m = JSON.parse(String(datos)); } catch (_) { return; }
    if (m.tipo !== 'mensajes' || !Array.isArray(m.mensajes)) return;
    const ok = [];
    for (const x of m.mensajes) {
      let payload;
      try { payload = JSON.parse(descifrar(this._s().waLlavePrivada, x.carga)); } catch (e) {
        // Cifrado con otra llave (p. ej. de una conexión anterior): no se puede abrir nunca; se descarta.
        this.o.log(`[whatsapp] mensaje ${x.id} ilegible, se descarta: ${e.message}`);
        ok.push(x.id); continue;
      }
      try {
        await this.o.entregar(payload);
        ok.push(x.id);
        this.estadoConexion.recibidos++;
        this.estadoConexion.ultimo = new Date().toISOString();
      } catch (e) {
        // El CRM no lo guardó (p. ej. aún arrancando): sin confirmar, el puente lo reenvía.
        this.o.log(`[whatsapp] no se pudo entregar ${x.id}: ${e.message}`);
        break;
      }
    }
    if (ok.length && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ tipo: 'ok', ids: ok, mas: ok.length === m.mensajes.length }));
  }

  detener() {
    this.detenido = true;
    clearTimeout(this.temporizador);
    if (this.ws) { try { this.ws.close(1000, 'detenido'); } catch (_) {} this.ws = null; }
  }

  reiniciar() { this.detener(); this.iniciar(); }
}

module.exports = { PuenteWhatsApp, descifrar };
