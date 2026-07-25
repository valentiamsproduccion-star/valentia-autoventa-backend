// Base de datos mínima basada en un archivo JSON, sin dependencias nativas.
//
// Por qué así: el hosting compartido de Hostinger (donde viven hoy las
// plantillas estáticas) no puede ejecutar un backend Node con una base de
// datos real, y el sandbox de desarrollo no tiene acceso a npm para
// instalar better-sqlite3/pg. Esto es deliberadamente lo más simple posible
// para que el flujo funcione de principio a fin ya, sabiendo que hay que
// sustituirlo por Postgres o SQLite real antes de manejar tráfico de
// producción (ver README, sección "Antes de producción").
//
// Escritura atómica: escribe en un archivo temporal y hace rename, para no
// dejar el JSON a medias si el proceso se cae a mitad de una escritura.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = { clients: [], orders: [], pages: [], magic_tokens: [] };

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(EMPTY, null, 2));
}

function load() {
  ensure();
  const raw = fs.readFileSync(DB_FILE, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('db.json corrupto: ' + e.message);
  }
}

function save(data) {
  ensure();
  const tmp = DB_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function id() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

// ---------- clients ----------

function createClient(fields) {
  const db = load();
  const client = Object.assign({ id: id(), created_at: now() }, fields);
  db.clients.push(client);
  save(db);
  return client;
}

function getClient(clientId) {
  return load().clients.find(c => c.id === clientId) || null;
}

// ---------- orders ----------

function createOrder(fields) {
  const db = load();
  const order = Object.assign({ id: id(), status: 'draft', created_at: now() }, fields);
  db.orders.push(order);
  save(db);
  return order;
}

function getOrder(orderId) {
  return load().orders.find(o => o.id === orderId) || null;
}

function findOrderByStripeSession(sessionId) {
  return load().orders.find(o => o.stripe_session_id === sessionId) || null;
}

function updateOrder(orderId, patch) {
  const db = load();
  const order = db.orders.find(o => o.id === orderId);
  if (!order) throw new Error('Pedido no encontrado: ' + orderId);
  Object.assign(order, patch, { updated_at: now() });
  save(db);
  return order;
}

// ---------- pages ----------

function upsertPage(fields) {
  const db = load();
  let page = db.pages.find(p => p.client_id === fields.client_id && p.slot === (fields.slot || 'principal'));
  if (page) {
    Object.assign(page, fields, { updated_at: now() });
  } else {
    page = Object.assign({ id: id(), slot: 'principal', created_at: now() }, fields);
    db.pages.push(page);
  }
  save(db);
  return page;
}

function getPagesForClient(clientId) {
  return load().pages.filter(p => p.client_id === clientId);
}

// ---------- magic tokens ----------
// Enlace mágico para añadir la página adicional después de la compra
// (decisión documentada en "Flujo de Autoventa y Panel de Cliente", sección 3).

function createMagicToken(clientId, opts) {
  opts = opts || {};
  const db = load();
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
  db.magic_tokens.push(record);
  save(db);
  return record;
}

function findValidMagicToken(token) {
  const db = load();
  const record = db.magic_tokens.find(t => t.token === token);
  if (!record) return null;
  if (record.expires_at && new Date(record.expires_at) < new Date()) return null;
  return record;
}

function markMagicTokenUsed(token) {
  const db = load();
  const record = db.magic_tokens.find(t => t.token === token);
  if (record) {
    record.used_at = now();
    save(db);
  }
  return record;
}

module.exports = {
  createClient, getClient,
  createOrder, getOrder, findOrderByStripeSession, updateOrder,
  upsertPage, getPagesForClient,
  createMagicToken, findValidMagicToken, markMagicTokenUsed,
  _load: load, _save: save, // exportado para tests
};
