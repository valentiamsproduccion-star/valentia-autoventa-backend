// Router mínimo sobre http nativo de Node -- no hay Express instalado (sin
// acceso a npm en desarrollo). Soporta rutas con parámetros (:id),
// middlewares simples y respuestas JSON/HTML/texto.

'use strict';

function compilePath(pattern) {
  const paramNames = [];
  const regexStr = pattern
    .replace(/\/:([A-Za-z0-9_]+)/g, (_, name) => {
      paramNames.push(name);
      return '/([^/]+)';
    });
  return { regex: new RegExp('^' + regexStr + '$'), paramNames };
}

class Router {
  constructor() {
    this.routes = []; // { method, regex, paramNames, handler }
  }

  add(method, pattern, handler) {
    const { regex, paramNames } = compilePath(pattern);
    this.routes.push({ method, regex, paramNames, handler });
  }

  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (m) {
        const params = {};
        r.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
        return { handler: r.handler, params };
      }
    }
    return null;
  }
}

function readBody(req, opts) {
  opts = opts || {};
  const maxBytes = opts.maxBytes || 2 * 1024 * 1024; // 2MB, de sobra para el formulario (la carta de Hostelería es lo más largo)
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(Object.assign(new Error('Cuerpo de la petición demasiado grande.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw Object.assign(new Error('JSON inválido en el cuerpo de la petición.'), { statusCode: 400 });
  }
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
  res.end(html);
}

module.exports = { Router, readBody, readJsonBody, sendJson, sendHtml };
