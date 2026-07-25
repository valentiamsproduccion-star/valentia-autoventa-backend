// Validación de servidor de los límites de caracteres de "Formulario de
// Alta — Sectores MVP" (Tabla A de cada sector). El formulario del cliente
// ya limita esto en el navegador, pero el servidor nunca debe fiarse solo
// de eso -- esta es la validación real antes de guardar/publicar.
//
// Solo se aplica en la vía "propio" (bloquea) -- en "mejora IA" estos mismos
// límites los usa el prompt de mejora como objetivo, no como bloqueo aquí.

'use strict';

const LIMITES = {
  'servicios-profesionales': {
    eyebrow_hero: 45,
    hero_title: 70,
    hero_subtitle: 180,
    'trust_badges[]': 30,
    h2_areas: 55,
    lead_areas: 140,
    'areas[].titulo': 28,
    'areas[].descripcion': 100,
    'equipo[].rol': 30,
    'equipo[].credencial': 95,
    'casos[].titulo': 35,
    'casos[].descripcion': 100,
    h2_consulta: 55,
    lead_consulta: 140,
    'consulta_points[].descripcion': 80,
    'testimonios[].cita': 160,
  },
  'salud-bienestar': {
    eyebrow_hero: 45,
    hero_title: 60,
    hero_subtitle: 170,
    'trust_badges[]': 28,
    h2_tratamientos: 55,
    lead_tratamientos: 140,
    'treats[].titulo': 26,
    'treats[].descripcion': 95,
    'equipo[].rol': 30,
    'equipo[].credencial': 95,
    h2_cita: 55,
    lead_cita: 140,
    'cita_points[].descripcion': 80,
    'reviews[].cita': 150,
  },
  'hosteleria-restauracion': {
    eyebrow_hero: 42,
    hero_title: 60,
    hero_subtitle: 170,
    'trust_badges[]': 30,
    lead_carta: 130,
    'menu_cats[].platos[].nombre': 32,
    'menu_cats[].platos[].descripcion': 50,
    historia_p1: 280,
    historia_p2: 280,
    'events[].what': 45,
    'events[].desc': 60,
    res_directa_texto: 110,
    'reviews[].cita': 150,
  },
};

function checkScalar(errors, path, value, limit) {
  if (typeof value !== 'string') return;
  if (value.length > limit) {
    errors.push(path + ': ' + value.length + ' car., máximo ' + limit + '.');
  }
}

function validarContenido(sector, contenido) {
  const limites = LIMITES[sector];
  if (!limites) throw new Error('Sector sin límites definidos: ' + sector);
  const errors = [];
  const c = contenido || {};

  for (const key in limites) {
    const limit = limites[key];
    if (key.endsWith('[]') && !key.includes('.')) {
      const field = key.slice(0, -2);
      (c[field] || []).forEach((v, i) => checkScalar(errors, field + '[' + i + ']', v, limit));
    } else if (key === 'menu_cats[].platos[].nombre' || key === 'menu_cats[].platos[].descripcion') {
      const sub = key.endsWith('nombre') ? 'nombre' : 'descripcion';
      (c.menu_cats || []).forEach((cat, ci) => {
        (cat.platos || []).forEach((p, pi) => {
          checkScalar(errors, 'menu_cats[' + ci + '].platos[' + pi + '].' + sub, p[sub], limit);
        });
      });
    } else if (key.includes('[].')) {
      const [arrField, sub] = key.split('[].');
      (c[arrField] || []).forEach((item, i) => {
        checkScalar(errors, arrField + '[' + i + '].' + sub, item[sub], limit);
      });
    } else {
      checkScalar(errors, key, c[key], limit);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validarContenido, LIMITES };
