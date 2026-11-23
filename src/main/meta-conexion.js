/**
 * «Conectar con Facebook» para Meta Ads (proceso principal).
 *
 * Facebook solo permite iniciar sesión desde un dominio registrado en la app
 * de Meta, y la clave secreta de esa app no puede estar en la PC. Por eso el
 * login pasa por el puente (conecta.all-novatech.com/conectar-meta), igual que
 * WhatsApp:
 *   1. pide una sesión con la licencia firmada y la llave pública RSA de esta PC;
 *   2. abre la página del puente en el navegador; el cliente inicia sesión;
 *   3. el puente canjea el token por uno de ~60 días, lee cuentas, páginas e
 *      Instagram, y deja todo CIFRADO para esta PC;
 *   4. aquí se descifra y se guarda en el CRM local (backend, token interno).
 */
const crypto = require('crypto');
const { descifrar } = require('./whatsapp-puente');

const ESPERA_MS = 30 * 60e3;

class ConexionMeta {
  /**
   * @param {object} o
   * @param {string} o.url                       https://conecta.all-novatech.com
   * @param {() => string|null} o.licencia
   * @param {() => object} o.secretos
   * @param {(s: object) => void} o.guardarSecretos
   * @param {(datos: object, idEmpresa: number|null) => Promise<object>} o.guardar   al backend local
   * @param {(url: string) => void} o.abrir
   * @param {(m: string) => void} o.log
   * @param {number} [o.intervaloMs=2500]
   */
  constructor(o) {
    this.o = o;
    this.url = String(o.url).replace(/\/+$/, '');
    this.estadoActual = { conectando: false, error: null, resultado: null };
  }

  _llaves() {
    const s = this.o.secretos();
    if (!s.waLlavePrivada || !s.waLlavePublica) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      s.waLlavePrivada = privateKey.export({ type: 'pkcs8', format: 'pem' });
      s.waLlavePublica = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      this.o.guardarSecretos(s);
    }
    return s;
  }

  async _pedir(ruta, opciones = {}) {
    let r;
    try {
      r = await fetch(this.url + ruta, { ...opciones, signal: AbortSignal.timeout(20000) });
    } catch (_) {
      throw Object.assign(new Error('No hay conexión con el servicio de ALLNOVATECH. Revisa tu Internet.'), { code: 'SIN_CONEXION' });
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `El servicio respondió ${r.status}.`), { status: r.status, code: `PUENTE_${r.status}` });
    return j;
  }

  estado() { return { ...this.estadoActual, id_empresa: this.idEmpresa ?? null }; }

  /** Abre la ventana de Facebook en el navegador; el resto sigue en segundo plano. */
  async conectar(opciones = {}) {
    const idEmpresa = opciones.idEmpresa ?? null;
    if (this.estadoActual.conectando && this.idEmpresa !== idEmpresa) {
      throw new Error('Hay una conexión con Facebook en curso para otra empresa de esta PC. Termínala en tu navegador o cancélala antes de empezar otra.');
    }
    if (this.estadoActual.conectando) {
      // Reabrir la misma ventana si el cliente la cerró por error.
      if (this.ultimaUrl) { this.o.abrir(this.ultimaUrl); return { url: this.ultimaUrl }; }
      throw new Error('Ya hay una conexión en curso. Termínala en tu navegador.');
    }
    const licencia = this.o.licencia();
    if (!licencia) {
      throw Object.assign(new Error('Para conectar Facebook, la prueba gratis o la licencia debe estar registrada en ALLNOVATECH. El CRM lo intenta solo cuando hay Internet; si en unos minutos sigue igual, abre Configuración → Licencia.'), { code: 'SIN_LICENCIA' });
    }
    const s = this._llaves();
    const j = await this._pedir('/v1/meta/sesion', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // mensajes: conexión de Messenger/Instagram (permisos de mensajes); sin él, Meta Ads.
      body: JSON.stringify({ licencia, llave: s.waLlavePublica, mensajes: opciones.mensajes === true })
    });
    this.estadoActual = { conectando: true, error: null, resultado: null };
    this.idEmpresa = idEmpresa; // la conexión se guarda en la empresa de quien la pidió
    this.mensajes = opciones.mensajes === true; // Messenger/Instagram o Meta Ads: cada botón conecta solo lo suyo
    this.ultimaUrl = j.url;
    this.o.abrir(j.url);
    this._esperar(j.sesion).catch((e) => {
      this.o.log(`[meta] conexión: ${e.message}`);
      this.estadoActual = { conectando: false, error: e.message, resultado: null };
    }).finally(() => { this.ultimaUrl = null; });
    return { url: j.url };
  }

  cancelar() {
    this.cancelado = true;
    this.estadoActual = { conectando: false, error: null, resultado: null };
  }

  async _esperar(id) {
    this.cancelado = false;
    const hasta = Date.now() + ESPERA_MS;
    while (Date.now() < hasta) {
      await new Promise((r) => setTimeout(r, this.o.intervaloMs || 2500));
      if (this.cancelado) return;
      let j;
      try { j = await this._pedir(`/v1/sesion/${id}`); } catch (e) {
        if (e.status === 404) throw new Error('La conexión venció. Vuelve a pulsar «Conectar con Facebook».');
        continue; // sin Internet un momento: se reintenta
      }
      if (j.estado === 'error') throw new Error(j.error || 'Facebook no completó la conexión.');
      if (j.estado !== 'listo') continue;
      const datos = JSON.parse(descifrar(this.o.secretos().waLlavePrivada, j.resultado));
      const r = await this.o.guardar(datos, this.idEmpresa, { mensajes: this.mensajes === true });
      this.o.log(`[meta] conectado: ${datos.cuentas?.length || 0} cuenta(s), ${datos.paginas?.length || 0} página(s)`);
      this.estadoActual = { conectando: false, error: null, resultado: r };
      return;
    }
    throw new Error('Pasaron 30 minutos sin terminar la conexión. Vuelve a pulsar «Conectar con Facebook».');
  }
}

module.exports = { ConexionMeta };
