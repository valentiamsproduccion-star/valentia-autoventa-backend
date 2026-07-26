// Integración con Supabase (Postgres + REST autogenerada vía PostgREST) sin
// SDK oficial -- mismo motivo que stripe.js: no hay acceso a npm en este
// entorno de desarrollo, así que esto es un envoltorio fino sobre https
// nativo de Node.
//
// Por qué Supabase: sustituye al JSON local de src/db/db.js, que vive en el
// disco efímero del plan gratuito de Render y puede perder datos cuando el
// contenedor se reinicia (ver README, "Antes de producción"). Supabase tiene
// un plan gratuito con Postgres persistente de verdad, sin tarjeta.
//
// Esquema: una única tabla genérica "kv_store" (colección + id + datos en
// JSONB) en vez de una tabla por entidad -- así el resto del código
// (db.js) apenas cambia de forma, solo de "dónde" guarda. Ver el SQL de
// creación en README.md, sección "Base de datos (Supabase)".
//
// Se usa la service_role key (nunca la anon key) porque este código corre
// solo en el backend y necesita saltarse Row Level Security -- exactamente
// igual de sensible que STRIPE_SECRET_KEY, así que va solo en variables de
// entorno de Render, nunca en el cliente.

'use strict';

const https = require('https');

function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      'Faltan SUPABASE_URL y/o SUPABASE_SERVICE_KEY. Crea un proyecto gratuito en supabase.com, ' +
      'ejecuta el SQL de README.md ("Base de datos (Supabase)") y copia esos dos valores a las ' +
      'variables de entorno (ver README).'
    );
  }
  // El host de la REST API es el mismo proyecto, sin protocolo.
  const hostname = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return { hostname, key };
}

// Petición genérica a PostgREST (`/rest/v1/<tabla>`). `query` es la parte de
// query string ya construida (sin el "?"); `body`, si se pasa, se manda como
// JSON. `extraHeaders` permite cosas como `Prefer: return=representation` o
// `Prefer: resolution=merge-duplicates` para upserts.
function postgrestRequest(method, pathAndQuery, body, extraHeaders) {
  const { hostname, key } = supabaseConfig();
  const bodyStr = body !== undefined ? JSON.stringify(body) : null;
  const headers = Object.assign(
    {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {},
    extraHeaders || {}
  );
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path: '/rest/v1/' + pathAndQuery, method, headers },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error('Supabase HTTP ' + res.statusCode + ' en ' + method + ' ' + pathAndQuery + ': ' + data.slice(0, 500)));
          }
          if (!data) return resolve(null);
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Respuesta no-JSON de Supabase: ' + data.slice(0, 300)));
          }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------- helpers específicos de la tabla kv_store ----------
// Fila: { collection text, id text, data jsonb, created_at, updated_at }
// PK compuesta (collection, id). Ver README para el SQL de creación.

function encodeFilters(filters) {
  // filters: { collection: 'orders', 'data->>stripe_session_id': 'abc' }
  return Object.entries(filters)
    .map(([k, v]) => encodeURIComponent(k) + '=eq.' + encodeURIComponent(v))
    .join('&');
}

async function kvSelect(filters) {
  const qs = encodeFilters(filters);
  const rows = await postgrestRequest('GET', 'kv_store?' + qs + '&select=data', null, {});
  return (rows || []).map(r => r.data);
}

async function kvSelectOne(filters) {
  const rows = await kvSelect(filters);
  return rows[0] || null;
}

async function kvInsert(collection, id, data) {
  await postgrestRequest(
    'POST',
    'kv_store',
    [{ collection, id, data }],
    { Prefer: 'return=minimal' }
  );
  return data;
}

async function kvUpdate(collection, id, data) {
  const qs = encodeFilters({ collection, id });
  await postgrestRequest(
    'PATCH',
    'kv_store?' + qs,
    { data, updated_at: new Date().toISOString() },
    { Prefer: 'return=minimal' }
  );
  return data;
}

// ---------- Supabase Storage (logo / favicon subidos por el cliente) ----------
// A diferencia de kv_store (PostgREST sobre /rest/v1/...), Storage vive en
// /storage/v1/... del mismo proyecto. No hace falta parsear multipart en
// ningún lado: el cliente (alta.html) manda el archivo ya en base64 dentro
// del JSON de /api/alta, el servidor lo decodifica a un Buffer y lo sube
// aquí tal cual (bytes crudos en el body, Content-Type real del archivo).
// `x-upsert: true` permite volver a subir con la misma ruta sin que falle
// si ya existía (útil si el cliente cambia de logo más adelante).

function encodeStoragePath(filePath) {
  return String(filePath).split('/').map(encodeURIComponent).join('/');
}

function uploadStorageFile(bucket, filePath, buffer, contentType) {
  const { hostname, key } = supabaseConfig();
  const urlPath = '/storage/v1/object/' + encodeURIComponent(bucket) + '/' + encodeStoragePath(filePath);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: urlPath,
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: 'Bearer ' + key,
          'Content-Type': contentType || 'application/octet-stream',
          'Content-Length': buffer.length,
          'x-upsert': 'true',
        },
      },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error('Supabase Storage HTTP ' + res.statusCode + ' subiendo ' + filePath + ': ' + data.slice(0, 500)));
          }
          resolve(publicStorageUrl(bucket, filePath));
        });
      }
    );
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

// URL pública de un archivo del bucket. Requiere que el bucket se haya
// creado como "Public bucket" en el dashboard de Supabase (ver README,
// "Base de datos (Supabase)") -- si no, esta URL devolvería 400/403.
function publicStorageUrl(bucket, filePath) {
  const { hostname } = supabaseConfig();
  return 'https://' + hostname + '/storage/v1/object/public/' + encodeURIComponent(bucket) + '/' + encodeStoragePath(filePath);
}

module.exports = { postgrestRequest, kvSelect, kvSelectOne, kvInsert, kvUpdate, uploadStorageFile, publicStorageUrl };
