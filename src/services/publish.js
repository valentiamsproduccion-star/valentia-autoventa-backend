// Publicación automática (paso 7 del "Flujo de Autoventa y Panel de
// Cliente"). Esta es la pieza que, según las respuestas de la reunión
// técnica (ver "Preguntas para la Parte Técnica", sección 2), puede cambiar
// más: aquí se deja lista la generación del HTML final, y un punto de
// extensión claro para conectar el proveedor real de hosting/dominios.
//
// Lo que SÍ hace ahora mismo: guarda el HTML final en disco, listo para
// servir. Lo que NO hace (a propósito, hasta tener esas respuestas): crear
// el subdominio, pedir el certificado SSL, dar de alta GA4/Search Console.
// Ese hueco está marcado explícitamente más abajo.

'use strict';

const fs = require('fs');
const path = require('path');
const { renderPagina } = require('./render');
const db = require('../db/db');

const SITES_DIR = process.env.SITES_DIR || path.join(__dirname, '..', '..', 'sites');

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'cliente';
}

// Publica (o republica) la página principal de un cliente, y opcionalmente
// la página adicional si la ha comprado.
async function publicarCliente(client, orderContext) {
  const datosBase = {
    nombre_negocio: client.nombre_negocio,
    ciudad: client.ciudad,
    telefono: client.telefono,
    email: client.email,
  };

  const htmlPrincipal = renderPagina(client.sector, datosBase, orderContext.contenidoPrincipal, { preview: false });

  const slug = client.slug || slugify(client.nombre_negocio);
  const siteDir = path.join(SITES_DIR, slug);
  fs.mkdirSync(siteDir, { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'index.html'), htmlPrincipal);

  db.upsertPage({ client_id: client.id, slot: 'principal', html_path: path.join(siteDir, 'index.html'), published_at: new Date().toISOString() });

  let urlPaginaAdicional = null;
  if (orderContext.contenidoAdicional) {
    const htmlAdicional = renderPagina(client.sector, datosBase, orderContext.contenidoAdicional, { preview: false });
    fs.writeFileSync(path.join(siteDir, 'servicios.html'), htmlAdicional);
    db.upsertPage({ client_id: client.id, slot: 'adicional', html_path: path.join(siteDir, 'servicios.html'), published_at: new Date().toISOString() });
    urlPaginaAdicional = '/' + slug + '/servicios.html';
  }

  // ────────────────────────────────────────────────────────────────
  // PUNTO DE EXTENSIÓN — pendiente de la reunión técnica:
  //
  //   1. Crear/apuntar el subdominio o dominio del cliente hacia siteDir
  //      (o subir estos archivos al hosting real -- Hostinger u otro,
  //      según se decida en "Preguntas para la Parte Técnica", sección 2).
  //   2. Emitir/renovar el certificado SSL.
  //   3. Insertar GA4 con Consent Mode v2 (mismo patrón que la landing de
  //      validación, Propuesta Técnica sección 5).
  //   4. Verificar el dominio en Search Console.
  //   5. Generar y subir sitemap.xml y robots.txt.
  //
  // Todo esto está fuera del alcance de lo que se puede automatizar sin
  // saber qué proveedor/API se va a usar -- ver el documento de preguntas
  // técnicas antes de rellenar este bloque.
  // ────────────────────────────────────────────────────────────────

  return {
    slug,
    urlPrincipal: '/' + slug + '/index.html',
    urlPaginaAdicional,
    localPath: siteDir,
  };
}

module.exports = { publicarCliente, slugify };
