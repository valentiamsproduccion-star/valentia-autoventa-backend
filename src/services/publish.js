// Publicación automática (paso 7 del "Flujo de Autoventa y Panel de
// Cliente"). Esta es la pieza que, según las respuestas de la reunión
// técnica (ver "Preguntas para la Parte Técnica", sección 2), puede cambiar
// más: aquí se deja lista la generación del HTML final, y un punto de
// extensión claro para conectar el proveedor real de hosting/dominios.
//
// Lo que SÍ hace ahora mismo: guarda el HTML final en Supabase (tabla
// kv_store, colección "pages"), listo para servir desde /sites/:slug
// (ver server.js). Antes se escribía en disco local, pero el disco del plan
// gratuito de Render es efímero y se comprobó que podía perder páginas
// publicadas al reiniciarse el contenedor -- de ahí el cambio a Supabase
// (ver README, "Base de datos (Supabase)"). Lo que NO hace (a propósito,
// hasta tener las respuestas de la reunión técnica): crear el subdominio,
// pedir el certificado SSL, dar de alta GA4/Search Console. Ese hueco está
// marcado explícitamente más abajo.

'use strict';

const { renderPagina, renderPaginaLegal, TEMPLATE_FILE_LEGAL, renderPaginaSector, subpaginasDeSector } = require('./render');
const db = require('../db/db');

// Publica (o republica) la página principal de un cliente, y opcionalmente
// la página adicional si la ha comprado.
async function publicarCliente(client, orderContext) {
  const datosBase = {
    nombre_negocio: client.nombre_negocio,
    ciudad: client.ciudad,
    telefono: client.telefono,
    email: client.email,
    // Datos fiscales (ver server.js, POST /api/alta, sección "Datos
    // fiscales") -- necesarios para las páginas legales reales (Aviso Legal,
    // Privacidad, ver services/legal.js).
    razon_social: client.razon_social,
    forma_juridica: client.forma_juridica,
    nif_cif: client.nif_cif,
    domicilio_fiscal: client.domicilio_fiscal,
    // Logo/favicon subidos en el alta (ver server.js, POST /api/alta) --
    // si el cliente no subió nada, quedan undefined y baseContext() los
    // deja vacíos (avatar de iniciales, sin favicon).
    logo_url: client.logo_url,
    favicon_url: client.favicon_url,
    // Color de marca (ver Formulario de Alta, sección "Color de marca") --
    // si el cliente no puso ninguno, render.js lo deja tal cual (undefined)
    // y la web usa el color del diseño elegido, como siempre.
    color_primario: client.color_primario,
    color_secundario: client.color_secundario,
    // Tipografía elegida (ver Formulario de Alta, sección "Tipografía") --
    // mismo patrón que el color: si no eligió ninguna, se usa la del diseño.
    fuente_id: client.fuente_id,
  };

  const htmlPrincipal = renderPagina(client.sector, datosBase, orderContext.contenidoPrincipal, { preview: false, plantillaId: client.plantilla_id });

  const slug = client.slug || db.slugify(client.nombre_negocio);
  if (!client.slug) {
    client = await db.updateClient(client.id, { slug });
  }

  await db.upsertPage({
    client_id: client.id,
    slug,
    slot: 'principal',
    html: htmlPrincipal,
    published_at: new Date().toISOString(),
  });

  // Subpáginas reales del sector (Áreas/Equipo/Contacto en vez de anclas --
  // ver Tarea "Piloto multi-página: Servicios profesionales"). Solo los
  // sectores ya convertidos tienen alguna (subpaginasDeSector devuelve []
  // para el resto), así que esto no afecta a clientes de otros sectores
  // todavía.
  for (const pagina of subpaginasDeSector(client.sector)) {
    const htmlSubpagina = renderPaginaSector(client.sector, pagina, datosBase, orderContext.contenidoPrincipal, { preview: false, plantillaId: client.plantilla_id });
    if (!htmlSubpagina) continue;
    await db.upsertPage({
      client_id: client.id,
      slug,
      slot: pagina,
      html: htmlSubpagina,
      published_at: new Date().toISOString(),
    });
  }

  // Páginas legales (Aviso Legal, Privacidad, Cookies) -- toda web publicada
  // las lleva por ley (LSSI/RGPD), así que se publican siempre, para
  // cualquier sector, no como un extra de pago (ver Tarea "Construir
  // plantillas legales genéricas").
  for (const pagina of TEMPLATE_FILE_LEGAL) {
    const htmlLegal = renderPaginaLegal(pagina, datosBase, { preview: false });
    await db.upsertPage({
      client_id: client.id,
      slug,
      slot: pagina,
      html: htmlLegal,
      published_at: new Date().toISOString(),
    });
  }

  let urlPaginaAdicional = null;
  if (orderContext.contenidoAdicional) {
    const htmlAdicional = renderPagina(client.sector, datosBase, orderContext.contenidoAdicional, { preview: false });
    await db.upsertPage({
      client_id: client.id,
      slug,
      slot: 'adicional',
      html: htmlAdicional,
      published_at: new Date().toISOString(),
    });
    urlPaginaAdicional = '/sites/' + slug + '/servicios.html';
  }

  // ────────────────────────────────────────────────────────────────
  // PUNTO DE EXTENSIÓN — pendiente de la reunión técnica:
  //
  //   1. Crear/apuntar el subdominio o dominio del cliente hacia esta
  //      página (o subir estos archivos al hosting real -- Hostinger u
  //      otro, según se decida en "Preguntas para la Parte Técnica",
  //      sección 2). Hoy se sirve desde /sites/:slug en este mismo backend.
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
    urlPrincipal: '/sites/' + slug,
    urlPaginaAdicional,
  };
}

module.exports = { publicarCliente };
