// Base de datos respaldada por Supabase (Postgres real, persistente) vía la
// REST API de PostgREST -- ver src/services/supabase.js.
//
// Antes esto era un archivo JSON en disco local (ver historial de git);
// se sustituyó porque el disco del plan gratuito de Render es efímero y
// puede perder datos cuando el contenedor se reinicia (comprobado en
// pruebas reales: un pedido pagado desapareció tras ~40 min de inactividad).
// Supabase da un Postgres gratuito de verdad, sin caducidad ni tarjeta.
//
// Se mantiene la MISMA API pública que tenía la versión con JSON (mismos
// nombres de función, mismos objetos de vuelta) para no tener que tocar
// server.js/publish.js más que añadiendo `await` -- lo único que cambia es
// que ahora todas las funciones son asíncronas.
//
// Modelo de almacenamiento: una única tabla "kv_store" (collection, id,
// data jsonb) en vez de una tabla por entidad -- ver README.md, sección
// "Base de datos (Supabase)", para el SQL de creación. `data` contiene el
// objeto completo (incluido su propio `id`), así que el código que consume
// estos registros no necesita cambiar.

'use strict';

const crypto = require('crypto');
const { kvSelect, kvSelectOne, kvInsert, kvUpdate } = require('../services/supabase');

function id() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'cliente';
}

// ---------- clients ----------

async function createClient(fields) {
  const client = Object.assign({ id: id(), created_at: now() }, fields);
  if (!client.slug) client.slug = slugify(client.nombre_negocio);
  await kvInsert('clients', client.id, client);
  return client;
}

async function getClient(clientId) {
  return kvSelectOne({ collection: 'clients', id: clientId });
}

async function updateClient(clientId, patch) {
  const client = await getClient(clientId);
  if (!client) throw new Error('Cliente no encontrado: ' + clientId);
  Object.assign(client, patch, { updated_at: now() });
  await kvUpdate('clients', clientId, client);
  return client;
}

// ---------- orders ----------

async function createOrder(fields) {
  const order = Object.assign({ id: id(), status: 'draft', created_at: now() }, fields);
  await kvInsert('orders', order.id, order);
  return order;
}

async function getOrder(orderId) {
  return kvSelectOne({ collection: 'orders', id: orderId });
}

async function findOrderByStripeSession(sessionId) {
  return kvSelectOne({ collection: 'orders', 'data->>stripe_session_id': sessionId });
}

// Todos los pedidos de un cliente (alta original + páginas adicionales
// compradas después) -- lo usa el editor básico post-compra (ver server.js,
// /api/mi-pagina/:token/editar) para encontrar el pedido "principal" (el que
// NO es página adicional) y actualizar su contenido.
async function getOrdersForClient(clientId) {
  return kvSelect({ collection: 'orders', 'data->>client_id': clientId });
}

async function updateOrder(orderId, patch) {
  const order = await getOrder(orderId);
  if (!order) throw new Error('Pedido no encontrado: ' + orderId);
  Object.assign(order, patch, { updated_at: now() });
  await kvUpdate('orders', orderId, order);
  return order;
}

// ---------- pages ----------
// slot: 'principal' | 'adicional'. Se guarda también el slug del cliente
// (denormalizado) para poder resolver /sites/:slug directamente en una sola
// consulta, sin tener que buscar primero el cliente.

async function upsertPage(fields) {
  const slot = fields.slot || 'principal';
  let page = await kvSelectOne({
    collection: 'pages',
    'data->>client_id': fields.client_id,
    'data->>slot': slot,
  });
  if (page) {
    Object.assign(page, fields, { slot, updated_at: now() });
    await kvUpdate('pages', page.id, page);
  } else {
    page = Object.assign({ id: id(), slot, created_at: now() }, fields);
    await kvInsert('pages', page.id, page);
  }
  return page;
}

async function getPagesForClient(clientId) {
  return kvSelect({ collection: 'pages', 'data->>client_id': clientId });
}

async function getPageBySlug(slug, slot) {
  return kvSelectOne({ collection: 'pages', 'data->>slug': slug, 'data->>slot': slot || 'principal' });
}

// ---------- magic tokens ----------
// Enlace mágico para añadir la página adicional después de la compra
// (decisión documentada en "Flujo de Autoventa y Panel de Cliente", sección 3).

async function createMagicToken(clientId, opts) {
  opts = opts || {};
  const token = crypto.randomBytes(24).toString('hex');
  const record = {
    id: id(),
    client_id: clientId,
    token,
    created_at: now(),
    expires_at: opts.expiresInDays
      ? new Date(Date.now() + opts.expiresInDays * 86400000).toISOString()
      : null, // null = sin caducidad, es un enlace permanente por diseño (ver Flujo, sección 3)
    used_at: null,
  };
  await kvInsert('magic_tokens', record.id, record);
  return record;
}

async function findValidMagicToken(token) {
  const record = await kvSelectOne({ collection: 'magic_tokens', 'data->>token': token });
  if (!record) return null;
  if (record.expires_at && new Date(record.expires_at) < new Date()) return null;
  return record;
}

async function markMagicTokenUsed(token) {
  const record = await kvSelectOne({ collection: 'magic_tokens', 'data->>token': token });
  if (record) {
    record.used_at = now();
    await kvUpdate('magic_tokens', record.id, record);
  }
  return record;
}

async function findMagicTokensForClient(clientId) {
  return kvSelect({ collection: 'magic_tokens', 'data->>client_id': clientId });
}

module.exports = {
  createClient, getClient, updateClient,
  createOrder, getOrder, findOrderByStripeSession, getOrdersForClient, updateOrder,
  upsertPage, getPagesForClient, getPageBySlug,
  createMagicToken, findValidMagicToken, markMagicTokenUsed, findMagicTokensForClient,
  slugify,
};
