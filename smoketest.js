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
process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
process.env.SUPABASE_URL = 'https://fake-smoketest.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
process.env.PORT = '3999';

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
  const params = parseQuery(options.path);
  const isKvStore = options.path.replace(/\?.*/, '') === '/rest/v1/kv_store';
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
        responseBody = JSON.stringify({ id: sessionId, url: 'https://checkout.stripe.com/fake/' + sessionId });
      } else if (options.hostname === 'fake-smoketest.supabase.co') {
        const result = handleSupabase(options, bodyStr);
        statusCode = result.statusCode;
        responseBody = result.body;
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
    datosBase: { nombre_negocio: 'Bufete Smoke SL', ciudad: 'Valencia', telefono: '600111222', email: 'info@smoke.test' },
    viaTexto: 'ia',
    datosBrutos: { especialidades: ['Civil', 'Laboral'], equipo: [{ nombre: 'Ana', rol: 'Socia', credencial: 'Colegiada 1' }], dato_confianza: '+10 años' },
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

  console.log('\n✔ TODO EL FLUJO END-TO-END FUNCIONA CORRECTAMENTE');
  server.close();
  https.request = realRequest;
  process.exit(0);
}

main().catch(err => {
  console.error('\n✘ FALLO EN LA PRUEBA DE HUMO:', err.message);
  console.error(err.stack);
  process.exit(1);
});
