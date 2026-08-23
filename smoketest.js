// Prueba de humo end-to-end del backend, simulando las respuestas de red de
// Stripe y Anthropic (el sandbox de desarrollo no tiene salida a internet)
// para poder ejercitar el flujo completo: alta -> vista previa -> checkout
// -> webhook -> publicación -> enlace mágico -> checkout del suplemento.

'use strict';

process.env.SITES_DIR = __dirname + '/sites-smoketest'; // ya no se usa para servir, solo por si algo lo referencia
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
process.env.STRIPE_PRICE_INICIAL = 'price_inicial_fake';
process.env.STRIPE_PRICE_MENSUAL = 'price_mensual_fake';
process.env.STRIPE_PRICE_SUPLEMENTO_PAGINA = 'price_suplemento_fake';
process.env.STRIPE_PRICE_LOGO_IA = 'price_logo_ia_fake';
process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
process.env.SUPABASE_URL = 'https://fake-smoketest.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
process.env.SUPABASE_STORAGE_BUCKET = 'logos';
process.env.RESEND_API_KEY = 're_fake_key';
process.env.EMAIL_FROM = 'Valentia <onboarding@resend.dev>';
process.env.ADMIN_EMAIL = 'equipo@valentiams.test';
process.env.PORT = '3999';

// PNG 1x1 transparente real, en base64 -- sirve como archivo de logo/favicon
// de prueba sin depender de ningún archivo externo.
const FAKE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// ---- Interceptar https.request para simular Stripe, Anthropic y Supabase ----
// (el sandbox de desarrollo no tiene salida a internet real, así que no se
// puede hablar con Supabase de verdad desde aquí -- este mock reproduce lo
// mínimo de la REST API (PostgREST) que src/services/supabase.js necesita:
// GET con filtros eq. sobre "collection"/"id"/"data->>campo", POST de
// inserción y PATCH de actualización, todo contra un array en memoria.)
const https = require('https');
const crypto = require('crypto');
const EventEmitter = require('events');

let fakeStripeSessionCounter = 0;
const fakeSupabaseRows = []; // { collection, id, data, created_at, updated_at }
const fakeSentEmails = []; // { to, subject, html }

function parseQuery(path) {
  const qIndex = path.indexOf('?');
  const query = qIndex === -1 ? '' : path.slice(qIndex + 1);
  const params = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const [rawKey, rawVal] = pair.split('=');
    params[decodeURIComponent(rawKey)] = decodeURIComponent(rawVal || '');
  }
  return params;
}

function matchesFilters(row, params) {
  for (const [key, val] of Object.entries(params)) {
    if (key === 'select') continue;
    if (!val.startsWith('eq.')) continue;
    const expected = val.slice(3);
    if (key === 'collection') {
      if (row.collection !== expected) return false;
    } else if (key === 'id') {
      if (row.id !== expected) return false;
    } else {
      const m = key.match(/^data->>(.+)$/);
      if (m) {
        const field = m[1];
        if (String(row.data[field]) !== expected) return false;
      }
    }
  }
  return true;
}

function handleSupabase(options, bodyStr) {
  const pathOnly = options.path.replace(/\?.*/, '');

  // Subida de logo/favicon (src/services/supabase.js, uploadStorageFile):
  // no hace falta persistir los bytes de verdad para la prueba de humo,
  // solo responder OK como haría la Storage API real.
  if (pathOnly.startsWith('/storage/v1/object/')) {
    if (options.method === 'POST' || options.method === 'PUT') {
      return { statusCode: 200, body: JSON.stringify({ Key: pathOnly.replace('/storage/v1/object/', '') }) };
    }
    return { statusCode: 405, body: JSON.stringify({ error: 'método no simulado en storage' }) };
  }

  const params = parseQuery(options.path);
  const isKvStore = pathOnly === '/rest/v1/kv_store';
  if (!isKvStore) return { statusCode: 404, body: JSON.stringify({ error: 'tabla no simulada' }) };

  if (options.method === 'GET') {
    const rows = fakeSupabaseRows.filter(r => matchesFilters(r, params));
    return { statusCode: 200, body: JSON.stringify(rows.map(r => ({ data: r.data }))) };
  }
  if (options.method === 'POST') {
    const items = JSON.parse(bodyStr);
    for (const item of items) {
      fakeSupabaseRows.push({ collection: item.collection, id: item.id, data: item.data, created_at: new Date().toISOString(), updated_at: null });
    }
    return { statusCode: 201, body: '' };
  }
  if (options.method === 'PATCH') {
    const patch = JSON.parse(bodyStr);
    for (const row of fakeSupabaseRows) {
      if (matchesFilters(row, params)) {
        row.data = patch.data;
        row.updated_at = patch.updated_at;
      }
    }
    return { statusCode: 204, body: '' };
  }
  return { statusCode: 405, body: JSON.stringify({ error: 'método no simulado' }) };
}

const realRequest = https.request;
https.request = function (options, callback) {
  const req = new EventEmitter();
  let bodyChunks = [];
  req.write = chunk => { bodyChunks.push(chunk); };
  req.end = () => {
    setImmediate(() => {
      const bodyStr = Buffer.concat(bodyChunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c))).toString('utf-8');
      let responseBody;
      let statusCode = 200;

      if (options.hostname === 'api.anthropic.com') {
        responseBody = JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify({
            eyebrow_hero: 'Sector de prueba',
            hero_title: 'Título generado por IA',
            hero_subtitle: 'Subtítulo generado por IA para la prueba de humo.',
            trust_badges: ['Badge 1', 'Badge 2', 'Badge 3'],
            h2_areas: 'Áreas', lead_areas: 'Lead de áreas.',
            areas: [{ titulo: 'Área 1', descripcion: 'Descripción 1' }],
            equipo: [{ nombre: 'Persona 1', rol: 'Rol', credencial: 'Credencial' }],
            h2_casos: 'Casos', lead_casos: 'Lead casos.',
            casos: [],
            h2_consulta: 'Consulta', lead_consulta: 'Lead consulta.',
            consulta_points: [{ titulo: 'Paso 1', descripcion: 'Desc 1' }, { titulo: 'Paso 2', descripcion: 'Desc 2' }, { titulo: 'Paso 3', descripcion: 'Desc 3' }],
            testimonios: [],
          }) }],
        });
      } else if (options.hostname === 'api.stripe.com') {
        fakeStripeSessionCounter++;
        const sessionId = 'cs_test_fake_' + fakeStripeSessionCounter;
        global.__lastFakeStripeSessionId = sessionId;
        global.__lastFakeStripeBody = bodyStr; // para comprobar qué line items se mandaron (ver logo con IA)
        responseBody = JSON.stringify({ id: sessionId, url: 'https://checkout.stripe.com/fake/' + sessionId });
      } else if (options.hostname === 'fake-smoketest.supabase.co') {
        const result = handleSupabase(options, bodyStr);
        statusCode = result.statusCode;
        responseBody = result.body;
      } else if (options.hostname === 'api.resend.com') {
        const payload = JSON.parse(bodyStr);
        fakeSentEmails.push(payload);
        statusCode = 200;
        responseBody = JSON.stringify({ id: 'fake-email-' + fakeSentEmails.length });
      } else {
        statusCode = 599;
        responseBody = JSON.stringify({ error: 'host no simulado: ' + options.hostname });
      }

      req.emit('response', {
        statusCode,
        on(event, handler) {
          if (event === 'data') setImmediate(() => handler(Buffer.from(responseBody)));
          if (event === 'end') setImmediate(() => handler());
        },
      });
      if (callback) callback(req._response || { statusCode, on(event, handler) {
        if (event === 'data') setImmediate(() => handler(Buffer.from(responseBody)));
        if (event === 'end') setImmediate(() => handler());
      }});
    });
  };
  req.on = EventEmitter.prototype.on.bind(req);
  return req;
};

// ---- Arrancar el servidor real (con la red simulada) ----
const { server } = require('./src/server.js');
const db = require('./src/db/db.js');
const { verificarFirmaWebhook } = require('./src/services/stripe.js');
const { LIMITES } = require('./src/services/validate.js');
const { TEMPLATE_FILE } = require('./src/services/render.js');

// Genera contenido válido (respeta todos los límites de caracteres de
// validate.js) para CUALQUIER sector de forma automática, introspeccionando
// LIMITES[sector] -- así, si se añade un sector nuevo (o cambian sus
// límites), esta prueba de humo lo cubre sin tener que escribir un bloque de
// contenido a mano por sector.
function textoDeLongitud(n) {
  const base = 'Lorem ipsum dolor sit amet consectetur adipiscing';
  let s = '';
  while (s.length < n) s += base + ' ';
  return s.trim().slice(0, Math.max(1, n)) || 'x';
}

function contenidoValidoParaSector(sector) {
  const limites = LIMITES[sector];
  const contenido = {};
  for (const key in limites) {
    const limit = limites[key];
    if (key.endsWith('[]') && !key.includes('.')) {
      const field = key.slice(0, -2);
      contenido[field] = [textoDeLongitud(Math.min(limit, 12)), textoDeLongitud(Math.min(limit, 12))];
    } else if (key === 'menu_cats[].platos[].nombre' || key === 'menu_cats[].platos[].descripcion') {
      if (!contenido.menu_cats) contenido.menu_cats = [{ nombre: 'Categoría', platos: [{}] }];
      const sub = key.endsWith('nombre') ? 'nombre' : 'descripcion';
      contenido.menu_cats[0].platos[0][sub] = textoDeLongitud(Math.min(limit, 20));
    } else if (key.includes('[].')) {
      const [arrField, sub] = key.split('[].');
      if (!contenido[arrField]) contenido[arrField] = [{}];
      contenido[arrField][0][sub] = textoDeLongitud(Math.min(limit, 20));
    } else {
      contenido[key] = textoDeLongitud(Math.min(limit, 30));
    }
  }
  return contenido;
}

function request(method, path, bodyObj, extraHeaders) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const body = bodyObj !== undefined ? (typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj)) : null;
    const req = http.request(
      { hostname: 'localhost', port: 3999, path, method, headers: Object.assign(
        body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
        extraHeaders || {}
      ) },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
          resolve({ statusCode: res.statusCode, body: parsed, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  await new Promise(resolve => server.listen(3999, resolve));
  console.log('Servidor de prueba escuchando en :3999\n');

  // 1) ALTA vía IA
  const altaResp = await request('POST', '/api/alta', {
    sector: 'servicios-profesionales',
    datosBase: { nombre_negocio: 'Bufete Smoke SL', ciudad: 'Valencia', telefono: '600111222', email: 'info@smoke.test', razon_social: 'Bufete Smoke S.L.', forma_juridica: 'SL', nif_cif: 'B12345678', domicilio_fiscal: 'Calle Mayor 1, 46001 Valencia' },
    viaTexto: 'ia',
    datosBrutos: { nombre_negocio: 'Bufete Smoke SL', tipo_negocio: 'Abogacía', ciudad: 'Valencia', especialidades: ['Civil', 'Laboral'], equipo: [{ nombre: 'Ana', rol: 'Socia', credencial: 'Colegiada 1' }], dato_confianza: '+10 años' },
    paginaAdicional: false,
  });
  console.log('1) POST /api/alta ->', altaResp.statusCode, altaResp.body.orderId ? 'orderId OK' : altaResp.body);
  if (altaResp.statusCode !== 200) throw new Error('Fallo en /api/alta');
  const orderId = altaResp.body.orderId;

  // 2) VISTA PREVIA
  const previewResp = await request('GET', '/preview/' + orderId);
  const previewOk = previewResp.statusCode === 200 && typeof previewResp.raw === 'string' && previewResp.raw.includes('Bufete Smoke SL') && !previewResp.raw.match(/\{\{[^}]*\}\}/);
  console.log('2) GET /preview/:orderId ->', previewResp.statusCode, previewOk ? 'HTML con datos del cliente, sin tags sin resolver' : 'FALLO');
  if (!previewOk) throw new Error('Vista previa incorrecta');

  // 3) CHECKOUT
  const checkoutResp = await request('POST', '/api/checkout', { orderId });
  console.log('3) POST /api/checkout ->', checkoutResp.statusCode, checkoutResp.body.checkoutUrl ? 'checkoutUrl OK' : checkoutResp.body);
  if (checkoutResp.statusCode !== 200) throw new Error('Fallo en /api/checkout');

  const order = await db.getOrder(orderId);
  const sessionId = order.stripe_session_id;

  // 4) WEBHOOK (simulando el evento real de Stripe, firmado correctamente)
  const eventPayload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: sessionId } } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(t + '.' + eventPayload, 'utf8').digest('hex');
  const webhookResp = await request('POST', '/api/webhook/stripe', eventPayload, { 'Stripe-Signature': 't=' + t + ',v1=' + sig });
  console.log('4) POST /api/webhook/stripe ->', webhookResp.statusCode, webhookResp.body);
  if (webhookResp.statusCode !== 200 || !webhookResp.body.received) throw new Error('Fallo en el webhook');

  const orderPaid = await db.getOrder(orderId);
  console.log('   pedido tras webhook: status =', orderPaid.status);
  if (orderPaid.status !== 'paid') throw new Error('El pedido no quedó marcado como pagado');

  // La web publicada ahora vive en Supabase (mock en memoria en esta prueba
  // de humo), no en disco -- se comprueba pidiéndola por HTTP, igual que un
  // visitante real.
  const siteResp = await request('GET', '/sites/bufete-smoke-sl');
  const published = siteResp.statusCode === 200 && typeof siteResp.raw === 'string' && siteResp.raw.includes('Bufete Smoke SL');
  console.log('   web publicada en /sites/bufete-smoke-sl ->', published ? 'EXISTE' : 'NO EXISTE');
  if (!published) throw new Error('No se publicó el sitio');
  console.log('   contiene VISTA PREVIA (no debería, es la web final):', siteResp.raw.includes('VISTA PREVIA'));

  // 5) ENLACE MÁGICO generado automáticamente tras el primer pago
  const client = await db.getClient(order.client_id);
  const tokens = await db.findMagicTokensForClient(client.id);
  console.log('5) enlace mágico creado tras el pago:', tokens.length === 1 ? 'SI (' + tokens[0].token.slice(0,10) + '...)' : 'NO (' + tokens.length + ')');
  if (tokens.length !== 1) throw new Error('No se generó el enlace mágico');
  const magicToken = tokens[0].token;

  // 5b) Email con el enlace mágico enviado en el mismo webhook (vía Resend, simulado)
  const emailOk = fakeSentEmails.length === 1
    && fakeSentEmails[0].to[0] === 'info@smoke.test'
    && fakeSentEmails[0].html.includes(magicToken);
  console.log('5b) email con el enlace mágico enviado:', emailOk ? 'SI (' + fakeSentEmails.length + ' envío/s)' : 'NO (' + JSON.stringify(fakeSentEmails) + ')');
  if (!emailOk) throw new Error('No se envió (o se envió mal) el email del enlace mágico');

  // 6) Abrir el enlace mágico (mini-formulario)
  const miPaginaResp = await request('GET', '/mi-pagina/' + magicToken);
  console.log('6) GET /mi-pagina/:token ->', miPaginaResp.statusCode, typeof miPaginaResp.raw === 'string' && miPaginaResp.raw.includes('Bufete Smoke SL') ? 'contiene nombre del negocio' : 'FALLO');

  // 7) Comprar la página adicional a través del enlace mágico
  const contenidoAdicional = {
    eyebrow_hero: 'Servicios extra', hero_title: 'Más servicios', hero_subtitle: 'Página adicional de prueba.',
    trust_badges: ['a', 'b', 'c'], h2_areas: 'x', lead_areas: 'y', areas: [{ titulo: 'Z', descripcion: 'W' }],
    equipo: [{ nombre: 'Ana', rol: 'Socia', credencial: 'Colegiada 1' }],
    h2_casos: '', lead_casos: '', casos: [],
    h2_consulta: 'x', lead_consulta: 'y', consulta_points: [{ titulo: 'a', descripcion: 'b' }, { titulo: 'c', descripcion: 'd' }, { titulo: 'e', descripcion: 'f' }],
    testimonios: [],
  };
  const miPaginaPost = await request('POST', '/api/mi-pagina/' + magicToken, { viaTexto: 'propio', contenido: contenidoAdicional });
  console.log('7) POST /api/mi-pagina/:token ->', miPaginaPost.statusCode, miPaginaPost.body.checkoutUrl ? 'checkoutUrl OK' : miPaginaPost.body);
  if (miPaginaPost.statusCode !== 200) throw new Error('Fallo al comprar la página adicional');

  // 8) Enlace mágico sigue siendo válido tras usarlo (es permanente, no de un solo uso)
  const stillValid = !!(await db.findValidMagicToken(magicToken));
  console.log('8) enlace mágico sigue activo tras usarlo (permanente por diseño):', stillValid);
  if (!stillValid) throw new Error('El enlace mágico se invalidó y no debería');

  // 8b) EDITOR BÁSICO (mismo enlace mágico, feedback de Raquel 31/07/2026):
  // GET /mi-pagina/:token/editar debe servir el formulario, GET .../contenido
  // debe devolver el contenido actual del cliente, y POST .../editar debe
  // guardar el cambio y republicar -- se comprueba que el nuevo titular
  // aparece en la web publicada de verdad.
  const editarPageResp = await request('GET', '/mi-pagina/' + magicToken + '/editar');
  console.log('8b) GET /mi-pagina/:token/editar ->', editarPageResp.statusCode, typeof editarPageResp.raw === 'string' && editarPageResp.raw.includes('Crea tu web') ? 'sirve el formulario' : 'FALLO');
  if (editarPageResp.statusCode !== 200) throw new Error('Fallo al servir el editor');

  const contenidoActualResp = await request('GET', '/api/mi-pagina/' + magicToken + '/contenido');
  console.log('8c) GET /api/mi-pagina/:token/contenido ->', contenidoActualResp.statusCode, contenidoActualResp.body.sector === 'servicios-profesionales' ? 'sector OK' : contenidoActualResp.body);
  if (contenidoActualResp.statusCode !== 200) throw new Error('Fallo al leer el contenido actual para el editor');
  if (!contenidoActualResp.body.contenido || !contenidoActualResp.body.contenido.hero_title) throw new Error('El contenido devuelto no trae el hero_title original');

  const contenidoEditado = Object.assign({}, contenidoActualResp.body.contenido, {
    hero_title: 'Titular editado desde el editor básico',
  });
  const guardarResp = await request('POST', '/api/mi-pagina/' + magicToken + '/editar', { viaTexto: 'propio', contenido: contenidoEditado });
  console.log('8d) POST /api/mi-pagina/:token/editar ->', guardarResp.statusCode, guardarResp.body.url || guardarResp.body);
  if (guardarResp.statusCode !== 200) throw new Error('Fallo al guardar la edición: ' + JSON.stringify(guardarResp.body));

  const sitioReeditadoResp = await request('GET', '/sites/bufete-smoke-sl');
  const reflejaEdicion = typeof sitioReeditadoResp.raw === 'string' && sitioReeditadoResp.raw.includes('Titular editado desde el editor básico');
  console.log('8e) la web publicada refleja el texto editado:', reflejaEdicion);
  if (!reflejaEdicion) throw new Error('La web publicada no refleja el cambio hecho desde el editor');

  const ordenPrincipalTrasEditar = await db.getOrder(orderId);
  console.log('8f) el pedido principal (no la página adicional) es el que se actualizó:', ordenPrincipalTrasEditar.contenido_principal.hero_title === 'Titular editado desde el editor básico');
  if (ordenPrincipalTrasEditar.contenido_principal.hero_title !== 'Titular editado desde el editor básico') throw new Error('Se actualizó el pedido equivocado');

  // 9) ALTA con logo/favicon subidos por el cliente -- verifica que se sube
  // a Storage (mock) y que la vista previa usa la imagen en vez del avatar
  // de iniciales.
  const altaConLogoResp = await request('POST', '/api/alta', {
    sector: 'salud-bienestar',
    datosBase: { nombre_negocio: 'Clínica Smoke', ciudad: 'Madrid', telefono: '600222333', email: 'info@clinica-smoke.test', razon_social: 'Clínica Smoke S.L.', forma_juridica: 'SL', nif_cif: 'B22345678', domicilio_fiscal: 'Calle Alcalá 10, 28001 Madrid' },
    viaTexto: 'ia',
    datosBrutos: { nombre_negocio: 'Clínica Smoke', tipo_negocio: 'Centro de fisioterapia', ciudad: 'Madrid', tratamientos: ['Fisioterapia'], equipo: [{ nombre: 'Bea', rol: 'Fisio', credencial: 'Colegiada 2' }], dato_confianza: '+5 años' },
    paginaAdicional: false,
    logos: [{ filename: 'logo.png', mime: 'image/png', base64: FAKE_PNG_BASE64 }],
    favicon: { filename: 'favicon.png', mime: 'image/png', base64: FAKE_PNG_BASE64 },
  });
  console.log('9) POST /api/alta con logo+favicon ->', altaConLogoResp.statusCode, altaConLogoResp.body.orderId ? 'orderId OK' : altaConLogoResp.body);
  if (altaConLogoResp.statusCode !== 200) throw new Error('Fallo en /api/alta con logo/favicon');
  const clienteConLogo = await db.getClient(altaConLogoResp.body.clientId);
  const logoGuardado = !!clienteConLogo.logo_url && !!clienteConLogo.favicon_url;
  console.log('   logo_url/favicon_url guardados en el cliente:', logoGuardado ? 'SI' : 'NO (' + JSON.stringify({ logo_url: clienteConLogo.logo_url, favicon_url: clienteConLogo.favicon_url }) + ')');
  if (!logoGuardado) throw new Error('No se guardaron logo_url/favicon_url tras subir los archivos');

  const previewConLogoResp = await request('GET', '/preview/' + altaConLogoResp.body.orderId);
  const previewUsaLogo = typeof previewConLogoResp.raw === 'string' && previewConLogoResp.raw.includes('<img src="' + clienteConLogo.logo_url + '"');
  console.log('   vista previa usa <img> de logo en vez del avatar de iniciales:', previewUsaLogo ? 'SI' : 'NO');
  if (!previewUsaLogo) throw new Error('La vista previa no está usando el logo subido');

  // 9b) VISTA PREVIA EN DIRECTO -- POST /api/alta/:orderId/apariencia debe
  // actualizar el color/fuente del cliente SIN tocar el contenido, y la
  // vista previa debe reflejarlo al momento (ver public/alta.html, sección
  // "Vista previa en directo").
  const aparienciaResp = await request('POST', '/api/alta/' + altaConLogoResp.body.orderId + '/apariencia', {
    color_primario: '#123456', color_secundario: '', color_terciario: '', fuente_id: 'moderna',
  });
  console.log('9b) POST /api/alta/:orderId/apariencia ->', aparienciaResp.statusCode, aparienciaResp.body);
  if (aparienciaResp.statusCode !== 200) throw new Error('Fallo al actualizar la apariencia en directo');
  const clienteTrasApariencia = await db.getClient(altaConLogoResp.body.clientId);
  const aparienciaOk = clienteTrasApariencia.color_primario === '#123456' && clienteTrasApariencia.fuente_id === 'moderna';
  console.log('    color_primario/fuente_id actualizados en el cliente:', aparienciaOk ? 'SI' : 'NO (' + JSON.stringify({ color_primario: clienteTrasApariencia.color_primario, fuente_id: clienteTrasApariencia.fuente_id }) + ')');
  if (!aparienciaOk) throw new Error('La apariencia en directo no actualizó el cliente');
  const contenidoSinTocar = clienteTrasApariencia.logo_url === clienteConLogo.logo_url;
  console.log('    el resto de campos del cliente (ej. logo_url) no se tocan:', contenidoSinTocar ? 'SI' : 'NO');
  if (!contenidoSinTocar) throw new Error('La apariencia en directo tocó campos que no debía');

  const previewTrasApariencia = await request('GET', '/preview/' + altaConLogoResp.body.orderId);
  const previewReflejaColor = typeof previewTrasApariencia.raw === 'string' && previewTrasApariencia.raw.includes('#123456');
  console.log('    la vista previa recargada ya usa el color nuevo:', previewReflejaColor ? 'SI' : 'NO');
  if (!previewReflejaColor) throw new Error('La vista previa no reflejó el cambio de color en directo');

  // Guardarraíl: una vez el pedido deja de ser 'draft' (pago iniciado o
  // completado), ya no debe admitir cambios de apariencia en directo -- así
  // un orderId adivinado no puede tocar la web de un cliente ya vendida.
  await db.updateOrder(altaConLogoResp.body.orderId, { status: 'paid' });
  const aparienciaTrasPagoResp = await request('POST', '/api/alta/' + altaConLogoResp.body.orderId + '/apariencia', { color_primario: '#000000' });
  const bloqueadoTrasPago = aparienciaTrasPagoResp.statusCode === 409;
  console.log('    tras marcar el pedido como pagado, la apariencia en directo queda bloqueada (409):', bloqueadoTrasPago ? 'SI' : 'NO (' + aparienciaTrasPagoResp.statusCode + ')');
  if (!bloqueadoTrasPago) throw new Error('La apariencia en directo debería bloquearse tras el pago');

  // 10) ALTA sin logo, pidiendo que la IA lo diseñe (+15€) -- verifica que
  // el pedido queda marcado y que el checkout manda el price de 15€ como
  // line item extra (igual que la cuota inicial).
  const altaLogoIaResp = await request('POST', '/api/alta', {
    sector: 'servicios-profesionales',
    datosBase: { nombre_negocio: 'Consultoría Smoke', ciudad: 'Sevilla', telefono: '600333444', email: 'info@consultoria-smoke.test', razon_social: 'Consultoría Smoke S.L.', forma_juridica: 'SL', nif_cif: 'B32345678', domicilio_fiscal: 'Avenida de la Constitución 5, 41001 Sevilla' },
    viaTexto: 'ia',
    datosBrutos: { nombre_negocio: 'Consultoría Smoke', tipo_negocio: 'Consultoría', ciudad: 'Sevilla', especialidades: ['Fiscal'], equipo: [{ nombre: 'Luis', rol: 'Socio', credencial: 'Colegiado 3' }], dato_confianza: '+8 años' },
    paginaAdicional: false,
    logoIaSolicitado: true,
  });
  console.log('10) POST /api/alta con logoIaSolicitado ->', altaLogoIaResp.statusCode, altaLogoIaResp.body.orderId ? 'orderId OK' : altaLogoIaResp.body);
  if (altaLogoIaResp.statusCode !== 200) throw new Error('Fallo en /api/alta con logoIaSolicitado');
  const orderLogoIa = await db.getOrder(altaLogoIaResp.body.orderId);
  console.log('    pedido.logo_ia_solicitado:', orderLogoIa.logo_ia_solicitado === true ? 'SI' : 'NO');
  if (orderLogoIa.logo_ia_solicitado !== true) throw new Error('El pedido no quedó marcado con logo_ia_solicitado');

  const checkoutLogoIaResp = await request('POST', '/api/checkout', { orderId: altaLogoIaResp.body.orderId });
  console.log('11) POST /api/checkout (con logo IA) ->', checkoutLogoIaResp.statusCode, checkoutLogoIaResp.body.checkoutUrl ? 'checkoutUrl OK' : checkoutLogoIaResp.body);
  if (checkoutLogoIaResp.statusCode !== 200) throw new Error('Fallo en /api/checkout con logo IA');
  const precioLogoIaEnviado = typeof global.__lastFakeStripeBody === 'string' && global.__lastFakeStripeBody.includes(encodeURIComponent(process.env.STRIPE_PRICE_LOGO_IA));
  console.log('    price de logo IA (15€) incluido en la sesión de Stripe:', precioLogoIaEnviado ? 'SI' : 'NO');
  if (!precioLogoIaEnviado) throw new Error('El checkout no incluyó el price de logo con IA');

  // 11b) DOMINIO PROPIO -- este entorno de prueba no define
  // OPENPROVIDER_USER/OPENPROVIDER_PASSWORD a propósito (ver openprovider.js,
  // estaConfigurado()), así que /api/dominio/disponibilidad debe degradar
  // con elegancia a {configurado:false} en vez de fallar -- así el alta.html
  // real puede seguir sin bloquear el flujo cuando el servicio todavía no
  // está listo en un entorno dado.
  const dominioDispResp = await request('GET', '/api/dominio/disponibilidad?nombre=miempresa&tlds=es,com');
  const dominioDispOk = dominioDispResp.statusCode === 200 && dominioDispResp.body.configurado === false;
  console.log('11b) GET /api/dominio/disponibilidad (sin configurar) ->', dominioDispResp.statusCode, dominioDispOk ? 'configurado:false OK' : dominioDispResp.body);
  if (!dominioDispOk) throw new Error('/api/dominio/disponibilidad debería responder configurado:false sin variables de Openprovider');

  // 11c) ENRUTADO POR DOMINIO PROPIO -- una petición con un Host que nadie
  // tiene conectado todavía debe caer al enrutado normal por ruta (404 "Ruta
  // no encontrada"), no romperse (ver server.js, serviceCustomDomainSiAplica).
  const hostDesconocidoResp = await request('GET', '/', null, { Host: 'dominio-que-no-existe.es' });
  const hostDesconocidoOk = hostDesconocidoResp.statusCode === 200 && typeof hostDesconocidoResp.raw === 'string' && hostDesconocidoResp.raw.includes('Crea tu web');
  console.log('11c) GET / con Host de dominio propio desconocido -> sigue sirviendo el formulario normal:', hostDesconocidoOk ? 'SI' : 'NO (' + hostDesconocidoResp.statusCode + ')');
  if (!hostDesconocidoOk) throw new Error('Un Host desconocido no debería romper el enrutado normal');

  // 12) Flujo COMPLETO (alta "propio" -> checkout -> webhook -> publicación)
  // para el resto de sectores. Los pasos 1-11 ya prueban a fondo
  // servicios-profesionales y salud-bienestar (incluida la vía IA, logo,
  // enlace mágico, etc.) -- esto cierra el hueco de cobertura de los otros
  // 7 sectores (hostelería, turismo, comercio, reformas, formación, ocio,
  // automoción), que hasta ahora solo se habían probado a nivel de
  // renderizado, no a través del flujo entero con pago y publicación real.
  const SECTORES_PENDIENTES = TEMPLATE_FILE.filter(
    s => !['servicios-profesionales', 'salud-bienestar'].includes(s)
  );
  console.log('\n12) Flujo completo (alta propio -> checkout -> webhook -> publicación) para el resto de sectores:');
  for (const sector of SECTORES_PENDIENTES) {
    const nombreNegocio = 'Smoke ' + sector + ' SL';
    const contenido = contenidoValidoParaSector(sector);

    const alta = await request('POST', '/api/alta', {
      sector,
      datosBase: { nombre_negocio: nombreNegocio, ciudad: 'Bilbao', telefono: '600555666', email: 'info@' + sector.replace(/[^a-z]/g, '') + '.test', razon_social: nombreNegocio + ' S.L.', forma_juridica: 'SL', nif_cif: 'B99999999', domicilio_fiscal: 'Gran Vía 1, 48001 Bilbao' },
      viaTexto: 'propio',
      contenido,
      paginaAdicional: false,
    });
    if (alta.statusCode !== 200) throw new Error(`[${sector}] fallo en /api/alta: ${JSON.stringify(alta.body)}`);

    const previewR = await request('GET', '/preview/' + alta.body.orderId);
    const previewOkSector = previewR.statusCode === 200 && previewR.raw.includes(nombreNegocio) && !previewR.raw.match(/\{\{[^}]*\}\}/);
    if (!previewOkSector) throw new Error(`[${sector}] vista previa incorrecta o con tags sin resolver`);

    const checkout = await request('POST', '/api/checkout', { orderId: alta.body.orderId });
    if (checkout.statusCode !== 200) throw new Error(`[${sector}] fallo en /api/checkout: ${JSON.stringify(checkout.body)}`);

    const orderSector = await db.getOrder(alta.body.orderId);
    const eventPayloadSector = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: orderSector.stripe_session_id } } });
    const tSector = Math.floor(Date.now() / 1000);
    const sigSector = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(tSector + '.' + eventPayloadSector, 'utf8').digest('hex');
    const webhookSector = await request('POST', '/api/webhook/stripe', eventPayloadSector, { 'Stripe-Signature': 't=' + tSector + ',v1=' + sigSector });
    if (webhookSector.statusCode !== 200 || !webhookSector.body.received) throw new Error(`[${sector}] fallo en el webhook`);

    const clientSector = await db.getClient(orderSector.client_id);
    const siteR = await request('GET', '/sites/' + clientSector.slug);
    const publishedOk = siteR.statusCode === 200 && siteR.raw.includes(nombreNegocio) && !siteR.raw.match(/\{\{[^}]*\}\}/);
    if (!publishedOk) throw new Error(`[${sector}] no se publicó correctamente en /sites/${clientSector.slug}`);

    console.log(`    ✔ ${sector}: alta(propio) -> checkout -> webhook -> publicado en /sites/${clientSector.slug} (${siteR.raw.length} chars, sin tags pendientes)`);
  }

  // 13) PLANTILLA POR DISEÑO (plantilla_id) -- el primer diseño convertido a
  // producción de verdad (ver src/templates/plantillas/README.md y la Tarea
  // "Convertir piloto: 5 diseños de Taller"). Comprueba que, cuando el
  // cliente elige un diseño concreto de la galería, la web publicada usa
  // ESE diseño (marcador único: la paleta roja #D62828) y no el genérico del
  // sector -- de principio a fin, con pago y publicación real, igual que
  // cualquier otro alta.
  const nombrePlantilla = 'Smoke Taller Plantilla SL';
  const altaPlantilla = await request('POST', '/api/alta', {
    sector: 'automocion',
    datosBase: { nombre_negocio: nombrePlantilla, ciudad: 'Bilbao', telefono: '600555666', email: 'info@tallerplantilla.test', razon_social: nombrePlantilla + ' S.L.', forma_juridica: 'SL', nif_cif: 'B99999998', domicilio_fiscal: 'Gran Vía 1, 48001 Bilbao' },
    viaTexto: 'propio',
    contenido: contenidoValidoParaSector('automocion'),
    paginaAdicional: false,
    plantillaId: 'taller-01-urgencia-mecanica-24h',
  });
  if (altaPlantilla.statusCode !== 200) throw new Error('[plantilla_id] fallo en /api/alta: ' + JSON.stringify(altaPlantilla.body));

  const checkoutPlantilla = await request('POST', '/api/checkout', { orderId: altaPlantilla.body.orderId });
  if (checkoutPlantilla.statusCode !== 200) throw new Error('[plantilla_id] fallo en /api/checkout');

  const orderPlantilla = await db.getOrder(altaPlantilla.body.orderId);
  const eventPayloadPlantilla = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: orderPlantilla.stripe_session_id } } });
  const tPlantilla = Math.floor(Date.now() / 1000);
  const sigPlantilla = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(tPlantilla + '.' + eventPayloadPlantilla, 'utf8').digest('hex');
  const webhookPlantilla = await request('POST', '/api/webhook/stripe', eventPayloadPlantilla, { 'Stripe-Signature': 't=' + tPlantilla + ',v1=' + sigPlantilla });
  if (webhookPlantilla.statusCode !== 200 || !webhookPlantilla.body.received) throw new Error('[plantilla_id] fallo en el webhook');

  const clientPlantilla = await db.getClient(orderPlantilla.client_id);
  const sitePlantillaR = await request('GET', '/sites/' + clientPlantilla.slug);
  const usaDisenoElegido = sitePlantillaR.statusCode === 200 && sitePlantillaR.raw.includes('#D62828') && !sitePlantillaR.raw.match(/\{\{[^}]*\}\}/);
  console.log('13) plantilla_id (Taller, diseño 1) -> web publicada usa el diseño elegido, no el genérico:', usaDisenoElegido ? 'SI' : 'NO');
  if (!usaDisenoElegido) throw new Error('La web publicada no refleja el diseño elegido en la galería (plantilla_id)');

  console.log('\n✔ TODO EL FLUJO END-TO-END FUNCIONA CORRECTAMENTE (9/9 sectores cubiertos)');
  server.close();
  https.request = realRequest;
  process.exit(0);
}

main().catch(err => {
  console.error('\n✘ FALLO EN LA PRUEBA DE HUMO:', err.message);
  console.error(err.stack);
  process.exit(1);
});
