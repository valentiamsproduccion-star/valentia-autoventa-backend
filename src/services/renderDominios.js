// Conecta el dominio recién comprado (ver services/openprovider.js) al
// servicio de Render que sirve este mismo backend, vía la API pública de
// Render (api-docs.render.com). Mismo patrón que el resto de servicios:
// envoltorio fino sobre https nativo, apagado si faltan las variables de
// entorno.
//
// RENDER_API_KEY: se genera en Render, Account Settings -> API Keys.
// RENDER_SERVICE_ID: el id del servicio (empieza por "srv-"), visible en la
// URL del dashboard de este mismo servicio.
//
// Por qué A record y no ANAME/ALIAS: la zona DNS que crea Openprovider al
// registrar el dominio (ver openprovider.js, registrarDominio()) es DNS
// estándar, sin CNAME-flattening -- así que para el dominio raíz (ej.
// "miempresa.es") se usa un registro A a la IP fija que documenta Render
// para dominios raíz (216.24.57.1, ver render.com/docs/configure-other-dns),
// y para "www" un CNAME al subdominio *.onrender.com del servicio. Si
// Render cambia esa IP en el futuro, hay que actualizar RENDER_A_RECORD_IP.

'use strict';

const https = require('https');

function config() {
  const apiKey = process.env.RENDER_API_KEY;
  const serviceId = process.env.RENDER_SERVICE_ID;
  if (!apiKey || !serviceId) return null;
  return { apiKey, serviceId };
}

function estaConfigurado() {
  return !!config();
}

const RENDER_A_RECORD_IP = process.env.RENDER_A_RECORD_IP || '216.24.57.1';

function request(method, urlPath, body) {
  const cfg = config();
  if (!cfg) throw new Error('Falta RENDER_API_KEY/RENDER_SERVICE_ID en el entorno.');
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Authorization: 'Bearer ' + cfg.apiKey, Accept: 'application/json' };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({ hostname: 'api.render.com', path: urlPath, method, headers }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        let parsed;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (e) {
          return reject(new Error('Respuesta no-JSON de Render (' + urlPath + '): ' + raw.slice(0, 300)));
        }
        if (res.statusCode >= 400) {
          return reject(new Error('Render API ' + urlPath + ' -> HTTP ' + res.statusCode + ': ' + JSON.stringify(parsed).slice(0, 300)));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Añade el dominio raíz + "www" como custom domains del servicio. Render
// crea y renueva el certificado SSL en cuanto el DNS resuelve correctamente
// -- eso no pasa en el momento (el DNS tarda en propagar), así que esta
// función solo da de alta el dominio en Render; la verificación queda para
// más adelante (ver server.js, comentario "verificación de dominio
// pendiente").
async function anadirDominioPersonalizado(nombreDominio) {
  const cfg = config();
  const raiz = await request('POST', '/v1/services/' + cfg.serviceId + '/custom-domains', { name: nombreDominio });
  let www = null;
  try {
    www = await request('POST', '/v1/services/' + cfg.serviceId + '/custom-domains', { name: 'www.' + nombreDominio });
  } catch (e) {
    // No crítico -- el dominio raíz es el que importa; "www" es solo la
    // redirección cómoda. Se deja constancia en logs y se sigue.
    console.error('No se pudo añadir www.' + nombreDominio + ' en Render:', e.message);
  }
  return { raiz, www };
}

// Registros DNS que hay que crear en la zona del dominio para que apunte a
// este servicio de Render -- se pasan tal cual a
// openprovider.anadirRegistrosDns().
function registrosDnsNecesarios() {
  return [
    { name: '', type: 'A', value: RENDER_A_RECORD_IP, ttl: 3600 },
    { name: 'www', type: 'CNAME', value: process.env.PUBLIC_BASE_URL_ONRENDER || 'valentia-autoventa-backend.onrender.com', ttl: 3600 },
  ];
}

module.exports = { estaConfigurado, anadirDominioPersonalizado, registrosDnsNecesarios, RENDER_A_RECORD_IP };
