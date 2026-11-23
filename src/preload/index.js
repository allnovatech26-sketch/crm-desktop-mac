/**
 * Preload: puente mínimo y explícito entre el CRM (Angular) y el proceso
 * principal. Sin Node en la página; solo estas funciones, y el proceso
 * principal además verifica que la llamada venga del CRM local.
 */
const { contextBridge, ipcRenderer } = require('electron');

// 'local' (PC principal o sola) | 'cliente' (conectada a la PC principal por la red).
let modo = 'local';
try { modo = ipcRenderer.sendSync('app:modo') || 'local'; } catch (_) { /* versión sin modo equipo */ }

// Pantalla local de inicio (file://): elección de modo y emparejamiento.
contextBridge.exposeInMainWorld('allnovaInicio', {
  estado: () => ipcRenderer.invoke('inicio:estado'),
  elegirPrincipal: () => ipcRenderer.invoke('inicio:principal'),
  conectar: (datos) => ipcRenderer.invoke('inicio:conectar', datos),
  reintentar: () => ipcRenderer.invoke('inicio:reintentar'),
  desvincular: () => ipcRenderer.invoke('inicio:desvincular')
});

// Trabajo en red: en la PC principal se activa/desactiva; en una PC cliente
// solo informa a qué PC principal está conectada.
contextBridge.exposeInMainWorld('allnovaEquipo', {
  modo,
  estado: () => ipcRenderer.invoke('equipo:estado'),
  activar: () => ipcRenderer.invoke('equipo:activar'),
  desactivar: () => ipcRenderer.invoke('equipo:desactivar'),
  cambiarPrincipal: () => ipcRenderer.invoke('equipo:cambiarPrincipal')
});

// Acceso desde fuera de la oficina y desde el celular (solo en la PC principal).
if (modo !== 'cliente') contextBridge.exposeInMainWorld('allnovaRemoto', {
  estado: () => ipcRenderer.invoke('remoto:estado'),
  activar: () => ipcRenderer.invoke('remoto:activar'),
  desactivar: () => ipcRenderer.invoke('remoto:desactivar'),
  cambiarEnlace: () => ipcRenderer.invoke('remoto:cambiarEnlace'),
  vincular: () => ipcRenderer.invoke('remoto:vincular'),
  anularVinculo: () => ipcRenderer.invoke('remoto:anularVinculo'),
  quitarDispositivo: (id) => ipcRenderer.invoke('remoto:quitarDispositivo', { id })
});

// En una PC cliente los respaldos, la licencia y WhatsApp viven en la PC principal.
if (modo !== 'cliente') contextBridge.exposeInMainWorld('allnovaDesktop', {
  version: () => ipcRenderer.invoke('app:version'),
  respaldos: {
    estado: () => ipcRenderer.invoke('respaldos:estado'),
    crear: () => ipcRenderer.invoke('respaldos:crear'),
    abrirCarpeta: () => ipcRenderer.invoke('respaldos:abrirCarpeta'),
    elegirCopia: () => ipcRenderer.invoke('respaldos:elegirCopia'),
    quitarCopia: () => ipcRenderer.invoke('respaldos:quitarCopia'),
    elegirArchivo: () => ipcRenderer.invoke('respaldos:elegirArchivo'),
    previsualizar: (archivo, codigo) => ipcRenderer.invoke('respaldos:previsualizar', { archivo, codigo }),
    restaurar: (archivo, codigo) => ipcRenderer.invoke('respaldos:restaurar', { archivo, codigo })
  },
  codigo: {
    ver: () => ipcRenderer.invoke('codigo:ver'),
    confirmarGuardado: () => ipcRenderer.invoke('codigo:confirmar')
  },
  licencia: {
    estado: () => ipcRenderer.invoke('licencia:estado'),
    activar: (clave) => ipcRenderer.invoke('licencia:activar', { clave }),
    desactivar: () => ipcRenderer.invoke('licencia:desactivar'),
    prueba: (cliente, contacto, ruc) => ipcRenderer.invoke('licencia:prueba', { cliente, contacto, ruc }),
    planes: () => ipcRenderer.invoke('licencia:planes'),
    comprar: (datos) => ipcRenderer.invoke('licencia:comprar', datos),
    pagar: (datos) => ipcRenderer.invoke('licencia:pagar', datos),
    cancelarPago: () => ipcRenderer.invoke('licencia:cancelarPago'),
    revisar: () => ipcRenderer.invoke('licencia:revisar'),
    cuentaIniciar: () => ipcRenderer.invoke('licencia:cuentaIniciar'),
    cuentaEstado: (codigo) => ipcRenderer.invoke('licencia:cuentaEstado', { codigo }),
    cuentaPreviaIniciar: () => ipcRenderer.invoke('licencia:cuentaPreviaIniciar'),
    cuentaPreviaEstado: (codigo) => ipcRenderer.invoke('licencia:cuentaPreviaEstado', { codigo }),
    verCuenta: () => ipcRenderer.invoke('licencia:verCuenta'),
    soporte: (datos) => ipcRenderer.invoke('licencia:soporte', datos)
  },
  // `sesion`: token de la sesión del CRM. Con varias empresas en la PC, el
  // proceso principal pregunta al backend en qué empresa está quien pulsó
  // «Conectar» y guarda la conexión en ESA empresa.
  meta: {
    conectar: (opciones) => ipcRenderer.invoke('meta:conectar', { mensajes: opciones?.mensajes === true, sesion: opciones?.sesion || null }),
    estado: () => ipcRenderer.invoke('meta:estado'),
    cancelar: () => ipcRenderer.invoke('meta:cancelar')
  },
  whatsapp: {
    estado: (sesion) => ipcRenderer.invoke('whatsapp:estado', { sesion: sesion || null }),
    conectar: (sesion) => ipcRenderer.invoke('whatsapp:conectar', { sesion: sesion || null }),
    conectarDirecto: (token, sesion) => ipcRenderer.invoke('whatsapp:conectarDirecto', { token, sesion: sesion || null }),
    desconectar: (sesion) => ipcRenderer.invoke('whatsapp:desconectar', { sesion: sesion || null })
  },
  acceso: {
    recuperar: (email, codigo, password) => ipcRenderer.invoke('acceso:recuperar', { email, codigo, password }),
    // «Entrar con mi cuenta all-novatech.com»
    cuentaIniciar: () => ipcRenderer.invoke('acceso:cuentaIniciar'),
    cuentaEstado: (codigo) => ipcRenderer.invoke('acceso:cuentaEstado', { codigo })
  }
});
