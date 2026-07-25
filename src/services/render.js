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
  };
}

function renderServiciosProfesionales(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    areas: withIndex(contenido.areas),
    consulta_points: withIndex(contenido.consulta_points),
    hay_casos: Array.isArray(contenido.casos) && contenido.casos.length > 0,
    hay_testimonios: Array.isArray(contenido.testimonios) && contenido.testimonios.length > 0,
  });
  return renderSector('servicios-profesionales', ctx);
}

function renderSaludBienestar(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    treats: withIndex(contenido.treats),
    cita_points: withIndex(contenido.cita_points),
    hay_reviews: Array.isArray(contenido.reviews) && contenido.reviews.length > 0,
  });
  return renderSector('salud-bienestar', ctx);
}

function renderHosteleriaRestauracion(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    hay_events: Array.isArray(contenido.events) && contenido.events.length > 0,
    hay_reviews: Array.isArray(contenido.reviews) && contenido.reviews.length > 0,
  });
  return renderSector('hosteleria-restauracion', ctx);
}

const RENDERERS = {
  'servicios-profesionales': renderServiciosProfesionales,
  'salud-bienestar': renderSaludBienestar,
  'hosteleria-restauracion': renderHosteleriaRestauracion,
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
