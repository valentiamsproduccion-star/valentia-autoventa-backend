// Punto de entrada del backend de autoventa. Implementa el flujo descrito
// en "Flujo de Autoventa y Panel de Cliente": alta -> generación de
// contenido -> vista previa -> pago -> publicación (pasos 2-7), más el
// enlace mágico de página adicional (sección 3 del mismo documento).
//
// Sin framework (Express no está disponible sin npm en este entorno) --
// es http nativo de Node más el router mínimo de src/lib/router.js.

'use strict';

const http = require('http'); // TLS lo termina el proxy/hosting, no este proceso
const path = require('path');
const fs = require('fs');

const { Router, readJsonBody, readBody, sendJson, sendHtml } = require('./lib/router');
const { renderPagina, TEMPLATE_FILE } = require('./services/render');
const { validarContenido } = require('./services/validate');
const { generarContenido, mejorarContenido } = require('./services/ai');
const { crearSesionCheckout, verificarFirmaWebhook } = require('./services/stripe');
const { publicarCliente } = require('./services/publish');
const { sendMagicLinkEmail, sendLogoIaSolicitadoEmail } = require('./services/email');
const supabase = require('./services/supabase');
const db = require('./db/db');

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ('http://localhost:' + PORT);

const SECTORES_VALIDOS = TEMPLATE_FILE; // ['servicios-profesionales', 'salud-bienestar', 'hosteleria-restauracion']

// Precios (ver "Plantillas por Sector" sección 3 y "Numeros CAC-LTV.xlsx"):
// cuota inicial + cuota mensual con el suplemento de página adicional ya
// incluido si se eligió en el alta. Los IDs de price de Stripe se crean una
// vez en el Dashboard (o con un script de setup aparte) y se referencian
// aquí por variable de entorno -- nunca se crean productos al vuelo.
const PRICE_INICIAL = process.env.STRIPE_PRICE_INICIAL;
const PRICE_MENSUAL = process.env.STRIPE_PRICE_MENSUAL;
const PRICE_SUPLEMENTO_PAGINA = process.env.STRIPE_PRICE_SUPLEMENTO_PAGINA; // 5€/mes, ver Flujo sección 3
const PRICE_LOGO_IA = process.env.STRIPE_PRICE_LOGO_IA; // 15€, pago único -- ver formulario de alta, "Logo y favicon"

// Bucket público de Supabase Storage donde se guardan los logos/favicons que
// suben los clientes en el alta (ver src/services/supabase.js, uploadStorageFile).
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'logos';

const router = new Router();

function requireSector(sector) {
  if (!SECTORES_VALIDOS.includes(sector)) {
    throw Object.assign(new Error('Sector desconocido: ' + sector), { statusCode: 400 });
  }
}

// Extensión de archivo a partir del nombre original, con el mime type como
// respaldo si el nombre no trae extensión reconocible.
function extensionDeArchivo(filename, mime) {
  const fromName = String(filename || '').split('.').pop();
  if (fromName && fromName.length <= 5 && /^[a-zA-Z0-9]+$/.test(fromName)) return fromName.toLowerCase();
  const porMime = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
    'image/svg+xml': 'svg', 'image/webp': 'webp',
    'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  };
  return porMime[mime] || 'png';
}

// Sube a Supabase Storage los archivos de logo (varias versiones posibles) y
// el favicon que el cliente adjuntó en el alta. Llegan en base64 dentro del
// JSON del formulario (sin multipart, ver src/lib/router.js) -- aquí se
// decodifican a Buffer y se suben tal cual bajo la carpeta del cliente.
async function subirLogoYFavicon(clientId, logos, favicon) {
  const result = { logo_url: null, logo_urls: [], favicon_url: null };
  if (Array.isArray(logos)) {
    let n = 0;
    for (const f of logos) {
      if (!f || !f.base64) continue;
      n++;
      const buffer = Buffer.from(f.base64, 'base64');
      const ext = extensionDeArchivo(f.filename, f.mime);
      const url = await supabase.uploadStorageFile(SUPABASE_STORAGE_BUCKET, clientId + '/logo-' + n + '.' + ext, buffer, f.mime);
      result.logo_urls.push(url);
    }
    if (result.logo_urls.length) result.logo_url = result.logo_urls[0];
  }
  if (favicon && favicon.base64) {
    const buffer = Buffer.from(favicon.base64, 'base64');
    const ext = extensionDeArchivo(favicon.filename, favicon.mime);
    result.favicon_url = await supabase.uploadStorageFile(SUPABASE_STORAGE_BUCKET, clientId + '/favicon.' + ext, buffer, favicon.mime);
  }
  return result;
}

// ───────────────────────── 1) ALTA (formulario) ─────────────────────────
// POST /api/alta
// Body: { sector, datosBase: {nombre_negocio, ciudad, telefono, email, tipoNegocio},
//         viaTexto: "propio" | "ia" | "mejora",
//         contenido?: {...}          (si viaTexto = propio)
//         datosBrutos?: {...}        (si viaTexto = ia)
//         textoCliente?: {...}       (si viaTexto = mejora)
//         paginaAdicional?: boolean
//         -- si paginaAdicional es true, el cliente ya elige y redacta esa
//         -- segunda página en el mismo formulario (Flujo, sección 3, paso 3):
//         viaTextoAdicional?: "propio" | "ia" | "mejora"
//         contenidoAdicional?: {...}
//         datosBrutosAdicional?: {...}
//         textoClienteAdicional?: {...}
//         -- logo y favicon (ver formulario de alta, sección "Logo y
//         -- favicon"): el cliente sube archivos ya existentes, o marca que
//         -- quiere que la IA le diseñe un logo (+15€, cobro en el checkout):
//         logos?: [{ filename, mime, base64 }, ...]   (varias versiones/formatos)
//         favicon?: { filename, mime, base64 }
//         logoIaSolicitado?: boolean }
router.post('/api/alta', async (req, res) => {
  // Límite más alto que el resto de rutas (2MB por defecto, ver router.js):
  // los archivos de logo/favicon viajan en base64 dentro del mismo JSON.
  const body = await readJsonBody(req, { maxBytes: 15 * 1024 * 1024 });
  const {
    sector, datosBase, viaTexto, contenido, datosBrutos, textoCliente, paginaAdicional,
    viaTextoAdicional, contenidoAdicional, datosBrutosAdicional, textoClienteAdicional,
    logos, favicon, logoIaSolicitado,
  } = body;
  requireSector(sector);
  if (!datosBase || !datosBase.nombre_negocio || !datosBase.ciudad || !datosBase.telefono || !datosBase.email) {
    return sendJson(res, 400, { error: 'Faltan datos base del negocio (nombre, ciudad, teléfono, email).' });
  }

  let contenidoFinal;
  if (viaTexto === 'propio') {
    const { valid, errors } = validarContenido(sector, contenido);
    if (!valid) return sendJson(res, 400, { error: 'El texto supera los límites de caracteres.', detalles: errors });
    contenidoFinal = contenido;
  } else if (viaTexto === 'ia') {
    if (!datosBrutos) return sendJson(res, 400, { error: 'Faltan los datos en bruto para que la IA redacte el texto.' });
    // La IA rechaza inventar nombre_negocio/tipo_negocio/ciudad (ver
    // src/prompts, regla 1 "no inventes datos verificables") y devuelve
    // prosa en vez del JSON pedido -- lo que antes llegaba al cliente como
    // un error críptico de "JSON no reconocible". Cortamos aquí con un
    // mensaje claro, igual que ya se hace arriba con datosBase.
    if (!datosBrutos.nombre_negocio || !datosBrutos.tipo_negocio || !datosBrutos.ciudad) {
      return sendJson(res, 400, { error: 'Faltan datos del negocio para que la IA redacte el texto (nombre, tipo o ciudad).' });
    }
    contenidoFinal = await generarContenido(sector, datosBrutos);
  } else if (viaTexto === 'mejora') {
    if (!textoCliente) return sendJson(res, 400, { error: 'Falta el texto del cliente a mejorar.' });
    contenidoFinal = await mejorarContenido(sector, textoCliente);
  } else {
    return sendJson(res, 400, { error: 'viaTexto debe ser "propio", "ia" o "mejora".' });
  }

  // Página adicional elegida ya en el alta (en vez de vía el enlace mágico
  // después de la compra): mismo procesado de texto, misma validación.
  let contenidoAdicionalFinal = null;
  if (paginaAdicional) {
    const viaAd = viaTextoAdicional || viaTexto;
    if (viaAd === 'propio') {
      if (!contenidoAdicional) return sendJson(res, 400, { error: 'Falta el contenido de la página adicional.' });
      const { valid, errors } = validarContenido(sector, contenidoAdicional);
      if (!valid) return sendJson(res, 400, { error: 'El texto de la página adicional supera los límites de caracteres.', detalles: errors });
      contenidoAdicionalFinal = contenidoAdicional;
    } else if (viaAd === 'ia') {
      if (!datosBrutosAdicional) return sendJson(res, 400, { error: 'Faltan los datos en bruto de la página adicional para que la IA redacte el texto.' });
      if (!datosBrutosAdicional.nombre_negocio || !datosBrutosAdicional.tipo_negocio || !datosBrutosAdicional.ciudad) {
        return sendJson(res, 400, { error: 'Faltan datos del negocio para la página adicional (nombre, tipo o ciudad).' });
      }
      contenidoAdicionalFinal = await generarContenido(sector, datosBrutosAdicional);
    } else if (viaAd === 'mejora') {
      if (!textoClienteAdicional) return sendJson(res, 400, { error: 'Falta el texto de la página adicional a mejorar.' });
      contenidoAdicionalFinal = await mejorarContenido(sector, textoClienteAdicional);
    } else {
      return sendJson(res, 400, { error: 'viaTextoAdicional debe ser "propio", "ia" o "mejora".' });
    }
  }

  const client = await db.createClient({ sector, ...datosBase });

  // Logo/favicon (opcionales): si el cliente adjuntó archivos, se suben a
  // Supabase Storage y se guardan sus URLs en el cliente; si no adjuntó nada
  // y marcó "Quiero que la IA me diseñe un logo", eso se cobra en el
  // checkout (ver /api/checkout) y el equipo lo diseña manualmente después
  // del pago (ver services/email.js, sendLogoIaSolicitadoEmail).
  if ((Array.isArray(logos) && logos.length) || (favicon && favicon.base64)) {
    let logoInfo;
    try {
      logoInfo = await subirLogoYFavicon(client.id, logos, favicon);
    } catch (e) {
      return sendJson(res, 500, { error: 'No se pudieron subir el logo/favicon: ' + e.message });
    }
    await db.updateClient(client.id, {
      logo_url: logoInfo.logo_url,
      logo_urls: logoInfo.logo_urls,
      favicon_url: logoInfo.favicon_url,
    });
  }

  const order = await db.createOrder({
    client_id: client.id,
    sector,
    via_texto: viaTexto,
    contenido_principal: contenidoFinal,
    pagina_adicional: !!paginaAdicional,
    contenido_adicional: contenidoAdicionalFinal,
    logo_ia_solicitado: !!logoIaSolicitado,
    status: 'draft',
  });

  sendJson(res, 200, {
    orderId: order.id,
    clientId: client.id,
    previewUrl: PUBLIC_BASE_URL + '/preview/' + order.id,
    contenido: contenidoFinal,
    contenidoAdicional: contenidoAdicionalFinal,
  });
});

// ───────────────────────── 2) VISTA PREVIA ─────────────────────────
// GET /preview/:orderId -- paso 5 del flujo: el cliente ve su web generada
// antes de pagar.
router.get('/preview/:orderId', async (req, res, params) => {
  const order = await db.getOrder(params.orderId);
  if (!order) return sendJson(res, 404, { error: 'Pedido no encontrado.' });
  const client = await db.getClient(order.client_id);
  const datosBase = {
    nombre_negocio: client.nombre_negocio, ciudad: client.ciudad, telefono: client.telefono, email: client.email,
    logo_url: client.logo_url, favicon_url: client.favicon_url,
  };
  const html = renderPagina(order.sector, datosBase, order.contenido_principal, { preview: true });
  sendHtml(res, 200, html);
});

// ───────────────────────── 3) CHECKOUT ─────────────────────────
// POST /api/checkout -- paso 6 del flujo: cuota inicial + cuota mensual,
// con el suplemento de página adicional ya incluido si se eligió en el alta.
router.post('/api/checkout', async (req, res) => {
  const { orderId } = await readJsonBody(req);
  const order = await db.getOrder(orderId);
  if (!order) return sendJson(res, 404, { error: 'Pedido no encontrado.' });
  if (!PRICE_INICIAL || !PRICE_MENSUAL) {
    return sendJson(res, 500, {
      error: 'Faltan STRIPE_PRICE_INICIAL / STRIPE_PRICE_MENSUAL en el .env. Créalos en el Dashboard de Stripe (modo test sirve para probar) y copia sus IDs.',
    });
  }
  if (order.pagina_adicional && !PRICE_SUPLEMENTO_PAGINA) {
    return sendJson(res, 500, {
      error: 'Este pedido incluye la página adicional pero falta STRIPE_PRICE_SUPLEMENTO_PAGINA en el .env.',
    });
  }
  if (order.logo_ia_solicitado && !PRICE_LOGO_IA) {
    return sendJson(res, 500, {
      error: 'Este pedido incluye el logo con IA pero falta STRIPE_PRICE_LOGO_IA en el .env.',
    });
  }

  // Si el cliente añadió la página adicional en el alta, el suplemento se
  // cobra como un tercer line item recurrente dentro de la misma sesión
  // (decisión de "Plantillas por Sector" sección 3: se compra ya activada).
  // El logo con IA (+15€, pago único) se añade igual que la cuota inicial.
  const session = await crearSesionCheckout({
    priceMensualId: PRICE_MENSUAL,
    priceInicialId: PRICE_INICIAL,
    priceSuplementoId: order.pagina_adicional ? PRICE_SUPLEMENTO_PAGINA : null,
    priceLogoIaId: order.logo_ia_solicitado ? PRICE_LOGO_IA : null,
    successUrl: PUBLIC_BASE_URL + '/gracias?order=' + order.id,
    cancelUrl: PUBLIC_BASE_URL + '/preview/' + order.id,
    clientReferenceId: order.id,
    metadata: { order_id: order.id, client_id: order.client_id },
  });

  await db.updateOrder(order.id, { stripe_session_id: session.id, status: 'pending_payment' });
  sendJson(res, 200, { checkoutUrl: session.url });
});

// ───────────────────────── 4) WEBHOOK DE STRIPE ─────────────────────────
// POST /api/webhook/stripe -- al confirmarse el pago, publica automáticamente
// (paso 7) y, si es la primera compra del cliente, genera su enlace mágico.
router.post('/api/webhook/stripe', async (req, res) => {
  const rawBody = await readBody(req);
  let event;
  try {
    event = verificarFirmaWebhook(rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const order = await db.findOrderByStripeSession(session.id);
    if (!order) return sendJson(res, 200, { received: true, warning: 'Pedido no encontrado para esta sesión.' });

    await db.updateOrder(order.id, { status: 'paid', paid_at: new Date().toISOString() });
    const client = await db.getClient(order.client_id);

    const result = await publicarCliente(client, {
      contenidoPrincipal: order.contenido_principal,
      contenidoAdicional: order.pagina_adicional ? order.contenido_adicional || null : null,
    });

    // Enlace mágico permanente para añadir la página adicional más adelante
    // si no se compró en el alta (Flujo, sección 3 -- decisión: sin panel
    // completo, sin contraseña, sin caducidad).
    const existingTokens = await db.findMagicTokensForClient(client.id);
    if (existingTokens.length === 0) {
      const tokenRecord = await db.createMagicToken(client.id);
      try {
        await sendMagicLinkEmail(
          client,
          PUBLIC_BASE_URL + result.urlPrincipal,
          PUBLIC_BASE_URL + '/mi-pagina/' + tokenRecord.token
        );
      } catch (e) {
        // La web ya está publicada y el enlace existe en la base de datos --
        // un fallo de envío de email no debe tumbar el webhook (Stripe lo
        // reintentaría) ni impedir que el cliente vea su web ya publicada.
        console.error('[email] fallo al enviar el enlace mágico:', e.message);
      }
    }

    // Logo con IA (+15€) ya cobrado: el equipo lo diseña y lo sube
    // manualmente (ver services/email.js, sendLogoIaSolicitadoEmail -- no
    // se genera la imagen automáticamente en este MVP).
    if (order.logo_ia_solicitado) {
      try {
        await sendLogoIaSolicitadoEmail(client);
      } catch (e) {
        console.error('[email] fallo al avisar del logo con IA solicitado:', e.message);
      }
    }

    console.log('[publish] cliente', client.id, '->', result.urlPrincipal);
  }

  sendJson(res, 200, { received: true });
});

// ───────────────────────── 5) ENLACE MÁGICO ─────────────────────────
// GET /mi-pagina/:token -- abre el mini-formulario para añadir la página
// adicional después de la compra, sin contraseña (Flujo, sección 3).
router.get('/mi-pagina/:token', async (req, res, params) => {
  const tokenRecord = await db.findValidMagicToken(params.token);
  if (!tokenRecord) return sendHtml(res, 404, '<h1>Enlace no válido o caducado</h1>');
  const client = await db.getClient(tokenRecord.client_id);
  const formHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'mi-pagina.html'), 'utf-8')
    .replace(/__NOMBRE_NEGOCIO__/g, client.nombre_negocio)
    .replace(/__SECTOR__/g, client.sector)
    .replace(/__TOKEN__/g, params.token);
  sendHtml(res, 200, formHtml);
});

// POST /api/mi-pagina/:token -- genera el contenido de la página adicional
// y crea el checkout del suplemento recurrente (+5€/mes).
router.post('/api/mi-pagina/:token', async (req, res, params) => {
  const tokenRecord = await db.findValidMagicToken(params.token);
  if (!tokenRecord) return sendJson(res, 404, { error: 'Enlace no válido o caducado.' });
  const client = await db.getClient(tokenRecord.client_id);

  const { viaTexto, contenido, datosBrutos, textoCliente } = await readJsonBody(req);
  let contenidoFinal;
  if (viaTexto === 'propio') {
    const { valid, errors } = validarContenido(client.sector, contenido);
    if (!valid) return sendJson(res, 400, { error: 'El texto supera los límites de caracteres.', detalles: errors });
    contenidoFinal = contenido;
  } else if (viaTexto === 'ia') {
    contenidoFinal = await generarContenido(client.sector, datosBrutos);
  } else if (viaTexto === 'mejora') {
    contenidoFinal = await mejorarContenido(client.sector, textoCliente);
  } else {
    return sendJson(res, 400, { error: 'viaTexto debe ser "propio", "ia" o "mejora".' });
  }

  if (!PRICE_SUPLEMENTO_PAGINA) {
    return sendJson(res, 500, { error: 'Falta STRIPE_PRICE_SUPLEMENTO_PAGINA en el .env.' });
  }

  const order = await db.createOrder({
    client_id: client.id,
    sector: client.sector,
    via_texto: viaTexto,
    contenido_adicional: contenidoFinal,
    es_pagina_adicional: true,
    status: 'draft',
  });

  const session = await crearSesionCheckout({
    priceMensualId: PRICE_SUPLEMENTO_PAGINA,
    successUrl: PUBLIC_BASE_URL + '/gracias?order=' + order.id,
    cancelUrl: PUBLIC_BASE_URL + '/mi-pagina/' + params.token,
    clientReferenceId: order.id,
    metadata: { order_id: order.id, client_id: client.id, tipo: 'pagina_adicional' },
  });

  await db.updateOrder(order.id, { stripe_session_id: session.id, status: 'pending_payment' });
  markTokenReuse(tokenRecord); // no se marca "usado" de forma que invalide el enlace -- es permanente
  sendJson(res, 200, { checkoutUrl: session.url });
});

function markTokenReuse() {
  // Deliberadamente no llama a db.markMagicTokenUsed(): el enlace es
  // permanente y reutilizable (Flujo, sección 3), a diferencia de un token
  // de un solo uso. Esta función existe para que quede explícito, no
  // implícito, que es una decisión y no un olvido.
}

// ───────────────────────── SITIOS PUBLICADOS ─────────────────────────
// GET /sites/:slug y /sites/:slug/:file -- sirve el HTML que publish.js
// guarda en Supabase (tabla kv_store, colección "pages"). Antes se leía de
// disco local (SITES_DIR); se cambió porque ese disco es efímero en el plan
// gratuito de Render (ver publish.js y README, "Base de datos (Supabase)").
// PUNTO DE EXTENSIÓN: esto sigue siendo un placeholder mínimo para poder ver
// la web publicada ya mismo; el dominio/subdominio real del cliente sigue
// pendiente de la reunión técnica (ver README y publish.js).
async function sendSitePage(res, slug, file) {
  const slot = file === 'servicios.html' ? 'adicional' : 'principal';
  const page = await db.getPageBySlug(slug, slot);
  if (!page || !page.html) {
    return sendHtml(res, 404, '<h1>Página no encontrada</h1><p>Todavía no se ha publicado esta web.</p>');
  }
  sendHtml(res, 200, page.html);
}

router.get('/sites/:slug', async (req, res, params) => sendSitePage(res, params.slug, 'index.html'));
router.get('/sites/:slug/:file', async (req, res, params) => sendSitePage(res, params.slug, params.file));

// ───────────────────────── PÁGINA DE GRACIAS (mínima) ─────────────────────────
router.get('/gracias', async (req, res) => {
  sendHtml(res, 200, '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:3rem;text-align:center"><h1>Gracias, pago confirmado</h1><p>Tu web se está publicando automáticamente. Te avisaremos en cuanto esté lista.</p></body>');
});

// ───────────────────────── FORMULARIO PRINCIPAL (estático) ─────────────────────────
router.get('/', async (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'alta.html'), 'utf-8');
  sendHtml(res, 200, html);
});

// ───────────────────────── SERVIDOR ─────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const match = router.match(req.method, url.pathname);
  if (!match) {
    return sendJson(res, 404, { error: 'Ruta no encontrada: ' + req.method + ' ' + url.pathname });
  }
  try {
    await match.handler(req, res, match.params);
  } catch (e) {
    console.error(e);
    sendJson(res, e.statusCode || 500, { error: e.message || 'Error interno.' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('Valentia Web Autoventa escuchando en http://localhost:' + PORT);
  });
}

module.exports = { server, router };
