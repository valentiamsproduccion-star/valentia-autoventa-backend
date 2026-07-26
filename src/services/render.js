// Servicio de renderizado: junta datos_base (comunes a los 3 sectores) +
// contenido (JSON generado por IA o escrito por el cliente) y produce el
// HTML final a partir de la plantilla .mustache del sector.

'use strict';

const fs = require('fs');
const path = require('path');
const { render } = require('../lib/mustache');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

const TEMPLATE_FILE = {
  'servicios-profesionales': 'servicios-profesionales.mustache',
  'salud-bienestar': 'salud-bienestar.mustache',
  'hosteleria-restauracion': 'hosteleria-restauracion.mustache',
  'turismo-alojamiento': 'turismo-alojamiento.mustache',
  'comercio-retail': 'comercio-retail.mustache',
  'reformas-construccion': 'reformas-construccion.mustache',
  'formacion-academias': 'formacion-academias.mustache',
  'ocio-cultura': 'ocio-cultura.mustache',
  'automocion': 'automocion.mustache',
};

function soloDigitos(str) {
  return String(str || '').replace(/[^\d]/g, '');
}

// Añade el índice "n" (01, 02, ...) a cada elemento de un array, sin mutar
// el array original -- lo usan las plantillas para numerar bloques (áreas,
// tratamientos, pasos de consulta/cita).
function withIndex(list) {
  return (list || []).map((item, i) => Object.assign({}, item, { n: String(i + 1).padStart(2, '0') }));
}

// Campos comunes a los 3 sectores, calculados a partir de los "datos base
// del negocio" (ver Formulario de Alta, sección 2).
function baseContext(datosBase, opts) {
  opts = opts || {};
  const nombre = datosBase.nombre_negocio || '';
  return {
    nombre_negocio: nombre,
    inicial_negocio: nombre.trim().charAt(0).toUpperCase() || '?',
    ciudad: datosBase.ciudad || '',
    ciudad_url: encodeURIComponent(datosBase.ciudad || ''),
    telefono: datosBase.telefono || '',
    telefono_wa: soloDigitos(datosBase.telefono),
    email: datosBase.email || '',
    anio: String(new Date().getFullYear()),
    preview: !!opts.preview,
    // Logo/favicon subidos por el cliente en el alta (ver Formulario de
    // Alta, sección "Logo y favicon"). Si no hay, quedan vacíos y las
    // plantillas usan `{{^logo_url}}`/`{{^favicon_url}}` para mostrar el
    // avatar de iniciales y omitir el <link rel="icon">.
    logo_url: datosBase.logo_url || '',
    favicon_url: datosBase.favicon_url || '',
    // Fotos "de sitio" del negocio subidas en el alta (ver Formulario de
    // Alta, sección "Fotos del negocio" -- SECTORES[...].fotos en
    // public/alta.html). Si faltan, las plantillas usan `{{^foto_hero_url}}`
    // etc. para seguir mostrando el hueco de "Foto" de siempre. `galeria` se
    // expone como lista de objetos ({{#galeria}}{{url}}{{/galeria}}) para
    // poder iterarla directamente en mustache.
    foto_hero_url: datosBase.foto_hero_url || '',
    foto_secundaria_url: datosBase.foto_secundaria_url || '',
    galeria: (datosBase.galeria_urls || []).map(url => ({ url })),
  };
}

function renderServiciosProfesionales(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    areas: withIndex(contenido.areas),
    consulta_points: withIndex(contenido.consulta_points),
    hay_casos: Array.isArray(contenido.casos) && contenido.casos.length > 0,
    hay_testimonios: Array.isArray(contenido.testimonios) && contenido.testimonios.length > 0,
    hay_faqs: Array.isArray(contenido.faqs) && contenido.faqs.length > 0,
  });
  return renderSector('servicios-profesionales', ctx);
}

function renderSaludBienestar(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    treats: withIndex(contenido.treats),
    cita_points: withIndex(contenido.cita_points),
    hay_reviews: Array.isArray(contenido.reviews) && contenido.reviews.length > 0,
    hay_faqs: Array.isArray(contenido.faqs) && contenido.faqs.length > 0,
  });
  return renderSector('salud-bienestar', ctx);
}

function renderHosteleriaRestauracion(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    hay_events: Array.isArray(contenido.events) && contenido.events.length > 0,
    hay_reviews: Array.isArray(contenido.reviews) && contenido.reviews.length > 0,
    hay_faqs: Array.isArray(contenido.faqs) && contenido.faqs.length > 0,
  });
  return renderSector('hosteleria-restauracion', ctx);
}

// ── Sectores añadidos (fase 2): turismo, comercio, reformas, formación ──
// Todos comparten el mismo patrón: numeran los bloques que la plantilla
// muestra como "01, 02, ..." y calculan los flags hay_* de las secciones
// opcionales (reviews, faqs, etc.).

function renderTurismoAlojamiento(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    // comodidades llega como lista de longitud fija desde el formulario
    // (campo fixedText); filtramos las vacías para no pintar chips en blanco.
    comodidades: (contenido.comodidades || []).filter(Boolean),
    entorno: withIndex(contenido.entorno),
    reserva_points: withIndex(contenido.reserva_points),
    hay_reviews: Array.isArray(contenido.reviews) && contenido.reviews.length > 0,
    hay_faqs: Array.isArray(contenido.faqs) && contenido.faqs.length > 0,
  });
  return renderSector('turismo-alojamiento', ctx);
}

function renderComercioRetail(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    razones: withIndex(contenido.razones),
    hay_reviews: Array.isArray(contenido.reviews) && contenido.reviews.length > 0,
    hay_faqs: Array.isArray(contenido.faqs) && contenido.faqs.length > 0,
  });
  return renderSector('comercio-retail', ctx);
}

function renderReformasConstruccion(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    proceso: withIndex(contenido.proceso),
    presupuesto_points: withIndex(contenido.presupuesto_points),
    hay_proyectos: Array.isArray(contenido.proyectos) && contenido.proyectos.length > 0,
    hay_reviews: Array.isArray(contenido.reviews) && contenido.reviews.length > 0,
    hay_faqs: Array.isArray(contenido.faqs) && contenido.faqs.length > 0,
  });
  return renderSector('reformas-construccion', ctx);
}

function renderFormacionAcademias(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    metodo: withIndex(contenido.metodo),
    matricula_points: withIndex(contenido.matricula_points),
    hay_profes: Array.isArray(contenido.profes) && contenido.profes.length > 0,
    hay_reviews: Array.isArray(contenido.reviews) && contenido.reviews.length > 0,
    hay_faqs: Array.isArray(contenido.faqs) && contenido.faqs.length > 0,
  });
  return renderSector('formacion-academias', ctx);
}

function renderOcioCultura(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    reserva_points: withIndex(contenido.reserva_points),
    hay_reviews: Array.isArray(contenido.reviews) && contenido.reviews.length > 0,
    hay_faqs: Array.isArray(contenido.faqs) && contenido.faqs.length > 0,
  });
  return renderSector('ocio-cultura', ctx);
}

function renderAutomocion(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    razones: withIndex(contenido.razones),
    cita_points: withIndex(contenido.cita_points),
    hay_reviews: Array.isArray(contenido.reviews) && contenido.reviews.length > 0,
    hay_faqs: Array.isArray(contenido.faqs) && contenido.faqs.length > 0,
  });
  return renderSector('automocion', ctx);
}

const RENDERERS = {
  'servicios-profesionales': renderServiciosProfesionales,
  'salud-bienestar': renderSaludBienestar,
  'hosteleria-restauracion': renderHosteleriaRestauracion,
  'turismo-alojamiento': renderTurismoAlojamiento,
  'comercio-retail': renderComercioRetail,
  'reformas-construccion': renderReformasConstruccion,
  'formacion-academias': renderFormacionAcademias,
  'ocio-cultura': renderOcioCultura,
  'automocion': renderAutomocion,
};

function renderSector(sector, ctx) {
  const file = TEMPLATE_FILE[sector];
  if (!file) throw new Error('Sector desconocido: ' + sector);
  const templatePath = path.join(TEMPLATES_DIR, file);
  const template = fs.readFileSync(templatePath, 'utf-8');
  return render(template, ctx);
}

// Punto de entrada único: sector + datos base + contenido -> HTML final.
// opts.preview = true muestra el badge "VISTA PREVIA" y las notas de
// función ampliable que no deben verse en la web publicada de un cliente real.
function renderPagina(sector, datosBase, contenido, opts) {
  const fn = RENDERERS[sector];
  if (!fn) throw new Error('Sector desconocido: ' + sector);
  return fn(datosBase, contenido, opts);
}

module.exports = { renderPagina, TEMPLATE_FILE: Object.keys(TEMPLATE_FILE) };
