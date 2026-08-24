// Integración con la API de Openprovider (registrador de dominios) --
// mismo motivo que stripe.js/supabase.js: sin acceso a npm en este entorno,
// así que es un envoltorio fino sobre https nativo de Node.
//
// Por qué Openprovider: ver conversación con el usuario (tarea "Diseñar
// flujo de compra de dominio en el checkout") -- precios de coste, API REST
// moderna, buena cobertura de TLDs europeos (.es incluido). El cliente elige
// dominio en el alta (public/alta.html, sección "Tu dominio"); tras el pago,
// server.js lo compra automáticamente vía este servicio y lo conecta a
// Render (ver services/renderDominios.js).
//
// Autenticación: NO hay una "API key" fija -- se hace login con usuario y
// contraseña (los mismos del panel, cp.openprovider.eu) y se recibe un
// token Bearer de sesión (ver docs.openprovider.com, "Authentication").
// Aquí se cachea ese token en memoria del proceso y se vuelve a pedir si
// falta o ha pasado el tiempo de margen fijado abajo -- Openprovider no
// documenta de forma fiable cuánto dura, así que se renueva pronto en vez
// de arriesgarse a que caduque a mitad de una operación.
//
// Sandbox vs producción: OPENPROVIDER_API_HOST decide contra qué entorno se
// habla -- 'api.sandbox.openprovider.nl' (pruebas, sin gastar nada, cuenta
// aparte) o 'api.openprovider.eu' (real, cuenta con Membership Plan y saldo
// cargado). Ver README para cómo se dan de alta ambas cuentas.
//
// Todo este servicio queda "apagado" (estaConfigurado() === false) si no
// hay OPENPROVIDER_USER/OPENPROVIDER_PASSWORD en el entorno -- así el resto
// del flujo (alta, checkout, publicación) sigue funcionando exactamente
// igual que antes aunque esta pieza no esté lista todavía.

'use strict';

const https = require('https');

function config() {
  const user = process.env.OPENPROVIDER_USER;
  const password = process.env.OPENPROVIDER_PASSWORD;
  if (!user || !password) return null;
  return {
    user,
    password,
    host: process.env.OPENPROVIDER_API_HOST || 'api.openprovider.eu',
  };
}

function estaConfigurado() {
  return !!config();
}

let cachedToken = null; // { token, expiresAt }

function rawRequest(host, method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const req = https.request({ hostname: host, path: urlPath, method, headers }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        let parsed;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (e) {
          return reject(new Error('Respuesta no-JSON de Openprovider (' + urlPath + '): ' + raw.slice(0, 300)));
        }
        // La API de Openprovider devuelve HTTP 200 casi siempre y mete el
        // código de error real en el cuerpo (`code`/`desc`) -- hay que
        // comprobar ambos sitios.
        if (res.statusCode >= 400 || (typeof parsed.code === 'number' && parsed.code >= 400)) {
          return reject(new Error('Openprovider ' + urlPath + ' -> ' + (parsed.code || res.statusCode) + ': ' + (parsed.desc || raw.slice(0, 300))));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login() {
  const cfg = config();
  if (!cfg) throw new Error('Falta OPENPROVIDER_USER/OPENPROVIDER_PASSWORD en el entorno.');
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  const resp = await rawRequest(cfg.host, 'POST', '/v1beta/auth/login', {
    username: cfg.user,
    password: cfg.password,
    ip: '0.0.0.0',
  });
  const token = resp.data && resp.data.token;
  if (!token) throw new Error('Login de Openprovider sin token en la respuesta: ' + JSON.stringify(resp).slice(0, 300));
  cachedToken = { token, expiresAt: Date.now() + 20 * 60 * 1000 }; // 20 min de margen
  return token;
}

async function request(method, urlPath, body) {
  const cfg = config();
  const token = await login();
  return rawRequest(cfg.host, method, urlPath, body, token);
}

// Lista cerrada de TLDs vendibles en el alta (ver conversación: se limita a
// baratos y predecibles para que la renovación quepa sin sorpresas dentro
// de la cuota de 19€/mes -- nada de TLDs premium por ahora). Mantener en
// sync con public/alta.html, sección "Tu dominio".
const TLDS_PERMITIDOS = ['es', 'com', 'net', 'org', 'eu'];

// Comprueba disponibilidad (y precio, a título informativo/interno) de un
// nombre en uno o varios TLDs de la lista permitida.
async function comprobarDisponibilidad(nombre, tlds) {
  const lista = (Array.isArray(tlds) ? tlds : [tlds]).filter(t => TLDS_PERMITIDOS.includes(t));
  if (!lista.length) throw Object.assign(new Error('TLD no permitido.'), { statusCode: 400 });
  const resp = await request('POST', '/v1beta/domains/check', {
    domains: lista.map(tld => ({ name: nombre, extension: tld })),
    with_price: true,
  });
  const resultados = (resp.data && resp.data.results) || [];
  return resultados.map(r => {
    // r.price.reseller = lo que cuesta de verdad a Valentia (precio de coste
    // del Membership Plan, ver docs.openprovider.com "Check Domain") --
    // { price: number, currency: string }. Es el campo que se usa para
    // filtrar qué TLDs se ofrecen al cliente (ver server.js, sección "Tu
    // dominio": solo se enseñan los más baratos de <10€).
    const reseller = r.price && r.price.reseller ? r.price.reseller : null;
    return {
      tld: (r.domain || '').split('.').slice(1).join('.'),
      dominio: r.domain,
      disponible: r.status === 'free' && !r.is_premium, // los premium quedan fuera del flujo automático (precio impredecible)
      premium: !!r.is_premium,
      razon: r.reason || null,
      precio: reseller ? reseller.price : null,
      precio_moneda: reseller ? reseller.currency : null,
      // La forma completa tampoco se fija aquí a propósito (varía por
      // TLD/promoción) -- se guarda tal cual para depurar internamente.
      precio_raw: r.price || null,
    };
  });
}

// Crea (si hace falta) el "customer handle" que figura como titular del
// dominio. Se usa el propio cliente de Valentia como titular (no Valentia)
// -- el dominio es suyo de verdad, no solo "gestionado por" -- así que se
// necesitan sus datos fiscales, ya recogidos en el alta. domicilio_fiscal
// llega como texto libre (ver public/alta.html, "Datos fiscales"); aquí se
// intenta trocear en calle/número/ciudad/CP con una heurística simple.
// ⚠️ Best-effort: para negocios con una dirección poco habitual puede salir
// mal repartido -- queda corregible a mano desde el panel de Openprovider
// (Customers) sin tener que tocar el dominio ya registrado.
function partirDomicilio(domicilioFiscal) {
  const texto = String(domicilioFiscal || '').trim();
  // Patrón esperado: "Calle/Avenida X, 12, 28001 Madrid" (con comas) o
  // variantes sin comas -- se buscan primero un código postal de 5 dígitos
  // y, antes de él, la ciudad; el resto se reparte entre calle y número.
  const cpMatch = texto.match(/(\d{5})\s*([^\d,]+)?$/);
  const zipcode = cpMatch ? cpMatch[1] : '';
  const city = cpMatch && cpMatch[2] ? cpMatch[2].trim() : '';
  const resto = cpMatch ? texto.slice(0, cpMatch.index).replace(/,\s*$/, '') : texto;
  const numMatch = resto.match(/(\d+[a-zA-Z]?)\s*,?\s*$/);
  const number = numMatch ? numMatch[1] : '1';
  const street = (numMatch ? resto.slice(0, numMatch.index) : resto).replace(/,\s*$/, '').trim() || texto;
  return {
    street: street || 'Sin especificar',
    number: number || '1',
    city: city || 'Sin especificar',
    zipcode: zipcode || '00000',
    state: '',
    country: 'ES',
  };
}

async function crearOReutilizarCliente(datosBase) {
  const nombre = String(datosBase.nombre_negocio || 'Cliente').trim();
  const partes = nombre.split(/\s+/);
  const first_name = partes[0] || 'Cliente';
  const last_name = partes.slice(1).join(' ') || nombre;
  const telefonoDigitos = String(datosBase.telefono || '').replace(/[^\d]/g, '');
  const resp = await request('POST', '/v1beta/customers', {
    name: { first_name, last_name },
    email: datosBase.email,
    phone: {
      country_code: '+34',
      area_code: '',
      subscriber_number: telefonoDigitos || '600000000',
    },
    address: partirDomicilio(datosBase.domicilio_fiscal),
    additional_data: {
      trading_name: datosBase.razon_social || nombre,
    },
  });
  const handle = resp.data && resp.data.handle;
  if (!handle) throw new Error('Alta de cliente en Openprovider sin handle en la respuesta: ' + JSON.stringify(resp).slice(0, 300));
  return handle;
}

// Registra el dominio ya comprobado como disponible. No se especifican
// name_servers propios -- Openprovider crea automáticamente una zona DNS
// con sus propios nameservers, que luego se rellena con los registros que
// apuntan a Render (ver renderDominios.js y el paso siguiente en
// server.js, sección "Compra de dominio tras el pago").
async function registrarDominio({ nombre, tld, ownerHandle }) {
  const resp = await request('POST', '/v1beta/domains', {
    domain: { name: nombre, extension: tld },
    owner_handle: ownerHandle,
    period: 1,
    autorenew: 'off', // la renovación la decide Valentia a mano/por script propio, no Openprovider (ver conversación: se absorbe en la cuota, no es un cobro automático sin control)
    is_private_whois_enabled: true, // protege los datos del cliente en el WHOIS público
  });
  return resp.data; // incluye, entre otros, el id del dominio y el nombre de la zona DNS creada
}

// Añade (sin borrar los que ya hubiera) registros DNS a la zona del
// dominio recién registrado -- ver docs.openprovider.com, PUT
// /v1beta/dns/zones/{name}, `records.add`.
async function anadirRegistrosDns(nombreZona, registros) {
  return request('PUT', '/v1beta/dns/zones/' + encodeURIComponent(nombreZona), {
    domain: { name: nombreZona.split('.')[0], extension: nombreZona.split('.').slice(1).join('.') },
    records: { add: registros },
  });
}

module.exports = {
  estaConfigurado,
  TLDS_PERMITIDOS,
  comprobarDisponibilidad,
  crearOReutilizarCliente,
  registrarDominio,
  anadirRegistrosDns,
  partirDomicilio, // exportado para poder probarlo suelto (ver smoketest.js)
};
