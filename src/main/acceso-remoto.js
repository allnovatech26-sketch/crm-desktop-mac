/**
 * Acceso desde fuera de la oficina (laptop en otra red y celular).
 *
 * La PC principal abre un WebSocket de SALIDA al puente de acceso remoto
 * (desktop/puente-remoto, https://remoto.all-novatech.com). No se abre ningún
 * puerto en el router ni en Windows. Por ese túnel llegan las peticiones de
 * los navegadores remotos y esta PC las reenvía SOLO a su backend local
 * (127.0.0.1), con las mismas reglas que el modo equipo:
 *   - rutas internas de Desktop bloqueadas (rutaPermitida);
 *   - sin token interno, origen local, IP real del cliente (cabecerasHaciaBackend).
 *
 * Dispositivos: cada celular o computadora se vincula una vez con un código de
 * 8 dígitos que genera esta PC (vale 10 minutos, un solo uso). Al puente solo
 * viaja su hash. La lista de dispositivos la guarda el puente; desde aquí se
 * ven y se quitan.
 *
 * Credenciales (en secrets.bin, DPAPI):
 *   remotoCodigo  — 26 letras/números aleatorios (128 bits): el enlace de la empresa.
 *   remotoSecreto — 32 bytes aleatorios: prueba ante el puente que esta PC es la
 *                   dueña del enlace. Nunca se muestra ni sale de la PC salvo al puente.
 */
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const { rutaPermitida, cabecerasHaciaBackend } = require('./equipo');

const TROZO = 256 * 1024;
const MAX_BUFFER = 4 * 1024 * 1024;
const PING_MS = 30_000;
const VENTANA_CONECTADOS_MS = 5 * 60_000;
const ALFABETO = 'abcdefghijklmnopqrstuvwxyz234567';
const VINCULO_MS = 10 * 60_000;

/** 16 bytes aleatorios en base32 (minúsculas): 26 caracteres. */
function nuevoCodigo() {
  const b = crypto.randomBytes(16);
  let bits = 0; let valor = 0; let s = '';
  for (const byte of b) {
    valor = (valor << 8) | byte; bits += 8;
    while (bits >= 5) { s += ALFABETO[(valor >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) s += ALFABETO[(valor << (5 - bits)) & 31];
  return s;
}

class AccesoRemoto {
  /**
   * @param {object} o
   * @param {string} o.url                    https://remoto.all-novatech.com
   * @param {() => string|null} o.licencia    token de licencia firmado (o null)
   * @param {() => object} o.secretos
   * @param {(s: object) => void} o.guardarSecretos
   * @param {() => number} o.puertoBackend
   * @param {(m: string) => void} o.log
   */
  constructor(o) {
    this.o = o;
    this.url = String(o.url).replace(/\/+$/, '');
    this.ws = null;
    this.detenido = true;
    this.enLinea = false;
    this.error = null;
    this.reintento = 2000;
    this.timer = null;
    this.ping = null;
    this.reqs = new Map();   // id → { preq, cancelado }
    this.wss = new Map();    // id → { ws local, cola }
    this.vistos = new Map(); // ip → ms
    this.dispositivos = [];  // [{ id, nombre, creado, ultimo }] (los manda el puente)
    this.vinculo = null;     // { codigo, vence } mientras hay un código vigente
  }

  /** Código para vincular un dispositivo nuevo (8 dígitos, 10 minutos, un solo uso). */
  crearCodigoVinculo() {
    if (this.detenido || !this.enLinea) {
      throw Object.assign(new Error('El acceso desde fuera no está en línea. Revisa el Internet de esta PC y vuelve a intentar.'), { code: 'SIN_CONEXION' });
    }
    const digitos = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
    this._enviar({ t: 'vincular', hash: crypto.createHash('sha256').update(digitos).digest('hex') });
    this.vinculo = { codigo: `${digitos.slice(0, 4)}-${digitos.slice(4)}`, vence: new Date(Date.now() + VINCULO_MS).toISOString() };
    return this.info();
  }

  anularVinculo() {
    this.vinculo = null;
    this._enviar({ t: 'anularVinculo' });
    return this.info();
  }

  revocarDispositivo(id) {
    if (!/^[a-f0-9]{16}$/.test(String(id || ''))) throw new Error('Dispositivo no válido.');
    if (!this._enviar({ t: 'revocar', dispositivo: String(id) })) {
      throw Object.assign(new Error('El acceso desde fuera no está en línea: no se pudo quitar el dispositivo. Intenta cuando diga «En línea».'), { code: 'SIN_CONEXION' });
    }
    this.dispositivos = this.dispositivos.filter((d) => d.id !== id);
    return this.info();
  }

  get codigo() { return this.o.secretos().remotoCodigo || null; }
  get enlace() { return this.codigo ? `${this.url}/e/${this.codigo}` : null; }

  _credenciales() {
    const s = this.o.secretos();
    if (!s.remotoCodigo || !s.remotoSecreto) {
      s.remotoCodigo = nuevoCodigo();
      s.remotoSecreto = crypto.randomBytes(32).toString('base64url');
      this.o.guardarSecretos(s);
    }
    return { codigo: s.remotoCodigo, secreto: s.remotoSecreto };
  }

  activar() {
    this._credenciales();
    this.detenido = false;
    this.error = null;
    this.reintento = 2000;
    this._conectar();
    return this.info();
  }

  async desactivar() {
    this.detenido = true;
    clearTimeout(this.timer);
    this._cerrarTodo();
    if (this.ws) { try { this.ws.close(1000, 'desactivado'); } catch (_) { /* nada */ } this.ws = null; }
    this.enLinea = false;
    this.error = null;
    return this.info();
  }

  /** Enlace nuevo: el anterior deja de funcionar en todos los celulares y laptops. */
  async cambiarEnlace() {
    const activo = !this.detenido;
    // Avisar al puente para que el enlace viejo diga «no válido» (si hay conexión).
    if (this._enviar({ t: 'liberar' })) await new Promise((r) => setTimeout(r, 400));
    await this.desactivar();
    const s = this.o.secretos();
    delete s.remotoCodigo; delete s.remotoSecreto;
    this.o.guardarSecretos(s);
    this.dispositivos = [];
    this.vinculo = null;
    this._credenciales();
    if (activo) this.activar();
    return this.info();
  }

  conectados() {
    const limite = Date.now() - VENTANA_CONECTADOS_MS;
    const lista = [];
    for (const [ip, t] of this.vistos) {
      if (t >= limite) lista.push({ ip, ultimo: new Date(t).toISOString() });
      else this.vistos.delete(ip);
    }
    return lista;
  }

  info() {
    return {
      activo: !this.detenido,
      enLinea: this.enLinea,
      enlace: this.enlace,
      error: this.error,
      conectados: this.detenido ? [] : this.conectados(),
      dispositivos: this.dispositivos,
      vinculo: this.vinculo && Date.parse(this.vinculo.vence) > Date.now() ? this.vinculo : null
    };
  }

  _programar() {
    if (this.detenido) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._conectar(), this.reintento);
    this.timer.unref?.();
    this.reintento = Math.min(this.reintento * 2, 60_000);
  }

  _conectar() {
    if (this.detenido) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const licencia = this.o.licencia();
    if (!licencia) {
      this.error = 'La licencia todavía no está registrada en ALLNOVATECH. Se activa sola cuando haya Internet.';
      this.reintento = 60_000;
      return this._programar();
    }
    const { codigo, secreto } = this._credenciales();
    const ws = new WebSocket(this.url.replace(/^http/, 'ws') + '/_remoto/tunel', {
      headers: { authorization: `Bearer ${secreto}`, 'x-codigo': codigo, 'x-licencia': licencia },
      handshakeTimeout: 20_000,
      maxPayload: 4 * 1024 * 1024
    });
    this.ws = ws;
    ws.on('open', () => {
      this.enLinea = true;
      this.error = null;
      this.reintento = 2000;
      this.o.log('[remoto] túnel abierto');
      clearInterval(this.ping);
      this.ping = setInterval(() => { try { ws.send('{"t":"ping"}'); } catch (_) { /* nada */ } }, PING_MS);
      ws.send('{"t":"lista"}'); // dispositivos vinculados
    });
    ws.on('unexpected-response', (_req, res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let m = '';
        try { m = JSON.parse(b).error || ''; } catch (_) { /* nada */ }
        this.error = m || `El servicio de acceso remoto respondió ${res.statusCode}.`;
        this.o.log(`[remoto] rechazado (${res.statusCode}): ${this.error}`);
        // Licencia vencida o enlace de otra PC: reintentar despacio.
        if ([401, 402, 403].includes(res.statusCode)) this.reintento = 10 * 60_000;
      });
    });
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch (_) { return; }
      try { this._manejar(m); } catch (e) { this.o.log(`[remoto] ${m.t}: ${e.message}`); }
    });
    ws.on('error', (e) => {
      if (!this.error) this.error = 'Sin conexión con el servicio de acceso remoto. Revisa el Internet de esta PC.';
      this.o.log(`[remoto] ${e.message}`);
    });
    ws.on('close', () => {
      clearInterval(this.ping);
      if (this.ws === ws) this.ws = null;
      const estaba = this.enLinea;
      this.enLinea = false;
      this._cerrarTodo();
      if (estaba) this.o.log('[remoto] túnel cerrado');
      this._programar();
    });
  }

  _cerrarTodo() {
    for (const [, r] of this.reqs) { r.cancelado = true; try { r.preq.destroy(); } catch (_) { /* nada */ } }
    this.reqs.clear();
    for (const [, w] of this.wss) { try { w.ws.terminate(); } catch (_) { /* nada */ } }
    this.wss.clear();
  }

  _enviar(msg) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  _manejar(m) {
    switch (m.t) {
      case 'req': return this._pedir(m);
      case 'rb': {
        const r = this.reqs.get(m.id);
        if (!r || r.cancelado) return;
        if (m.b) r.preq.write(Buffer.from(m.b, 'base64'));
        if (m.fin) r.preq.end();
        return;
      }
      case 'cancelar': {
        const r = this.reqs.get(m.id);
        if (r) { r.cancelado = true; r.preq.destroy(); this.reqs.delete(m.id); }
        return;
      }
      case 'wso': return this._abrirWs(m);
      case 'dispositivos':
        this.dispositivos = Array.isArray(m.lista) ? m.lista.slice(0, 500) : [];
        return;
      case 'vinculo':
        // Se usó (o se anuló por intentos fallidos): el código ya no sirve.
        this.vinculo = null;
        if (m.estado === 'usado') this.o.log(`[remoto] dispositivo vinculado: ${String(m.nombre || '').slice(0, 60)}`);
        return;
      case 'wsm': {
        const w = this.wss.get(m.id);
        if (!w) return;
        const dato = m.bin ? Buffer.from(m.d, 'base64') : m.d;
        if (w.ws.readyState === WebSocket.OPEN) w.ws.send(dato, { binary: !!m.bin });
        else w.cola.push([dato, !!m.bin]);
        return;
      }
      case 'wsc': {
        const w = this.wss.get(m.id);
        if (w) { this.wss.delete(m.id); try { w.ws.close(); } catch (_) { w.ws.terminate(); } }
        return;
      }
      default:
    }
  }

  _marcar(ip) { if (ip) this.vistos.set(ip, Date.now()); }

  _pedir(m) {
    const id = m.id;
    this._marcar(m.ip);
    if (!rutaPermitida(m.m, m.u)) {
      const cuerpo = Buffer.from(JSON.stringify({ success: false, code: 'SOLO_PC_PRINCIPAL', message: 'Esta acción solo se puede hacer en la PC principal.' }));
      this._enviar({ t: 'res', id, s: 403, h: { 'content-type': 'application/json' } });
      this._enviar({ t: 'rb', id, b: cuerpo.toString('base64'), fin: true });
      return;
    }
    const puerto = this.o.puertoBackend();
    const headers = cabecerasHaciaBackend(m.h || {}, { origenBackend: `http://127.0.0.1:${puerto}`, ipCliente: m.ip || '' });
    const r = { preq: null, cancelado: false };
    const preq = http.request({ host: '127.0.0.1', port: puerto, method: m.m, path: m.u, headers }, (pres) => {
      if (r.cancelado) { pres.destroy(); return; }
      const h = { ...pres.headers };
      delete h.connection; delete h['keep-alive']; delete h['transfer-encoding'];
      this._enviar({ t: 'res', id, s: pres.statusCode, h });
      let buf = [];
      let largo = 0;
      const vaciar = (fin) => {
        const b = Buffer.concat(buf);
        buf = []; largo = 0;
        this._enviar({ t: 'rb', id, b: b.toString('base64'), fin });
      };
      pres.on('data', (c) => {
        buf.push(c); largo += c.length;
        if (largo >= TROZO) vaciar(false);
        // Internet lento de la oficina: no llenar la memoria.
        if (this.ws && this.ws.bufferedAmount > MAX_BUFFER) {
          pres.pause();
          const esperar = () => {
            if (r.cancelado || !this.ws) return pres.destroy();
            if (this.ws.bufferedAmount > MAX_BUFFER / 2) return setTimeout(esperar, 50);
            pres.resume();
          };
          setTimeout(esperar, 50);
        }
      });
      pres.on('end', () => { this.reqs.delete(id); if (!r.cancelado) vaciar(true); });
      pres.on('error', () => { this.reqs.delete(id); this._enviar({ t: 'rerr', id }); });
    });
    r.preq = preq;
    this.reqs.set(id, r);
    preq.on('error', () => {
      if (!this.reqs.has(id)) return;
      this.reqs.delete(id);
      if (r.cancelado) return;
      const cuerpo = Buffer.from('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font-family:sans-serif;padding:24px">El CRM de la PC principal se está reiniciando. Se reintentará en unos segundos…</p><script>setTimeout(()=>location.reload(),5000)</script>');
      this._enviar({ t: 'res', id, s: 503, h: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5' } });
      this._enviar({ t: 'rb', id, b: cuerpo.toString('base64'), fin: true });
    });
    if (m.fin) preq.end();
  }

  _abrirWs(m) {
    const id = m.id;
    this._marcar(m.ip);
    if (!rutaPermitida('GET', m.u)) { this._enviar({ t: 'wsc', id, c: 1008, r: 'no permitido' }); return; }
    const puerto = this.o.puertoBackend();
    const origen = `http://127.0.0.1:${puerto}`;
    const h = cabecerasHaciaBackend(m.h || {}, { origenBackend: origen, ipCliente: m.ip || '' });
    delete h['accept-encoding'];
    delete h['sec-websocket-protocol'];
    const local = new WebSocket(`ws://127.0.0.1:${puerto}${m.u}`, { headers: h, origin: origen, perMessageDeflate: false });
    const w = { ws: local, cola: [] };
    this.wss.set(id, w);
    local.on('open', () => {
      for (const [dato, bin] of w.cola) local.send(dato, { binary: bin });
      w.cola = [];
    });
    local.on('message', (data, esBinario) => {
      this._enviar(esBinario ? { t: 'wsm', id, d: Buffer.from(data).toString('base64'), bin: true } : { t: 'wsm', id, d: data.toString(), bin: false });
    });
    const cerrado = (code, reason) => {
      if (this.wss.get(id) !== w) return;
      this.wss.delete(id);
      this._enviar({ t: 'wsc', id, c: code || 1000, r: String(reason || '') });
    };
    local.on('close', (code, reason) => cerrado(code, reason));
    local.on('error', () => cerrado(1011, 'error'));
  }
}

module.exports = { AccesoRemoto, nuevoCodigo };
