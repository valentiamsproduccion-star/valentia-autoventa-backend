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
    'faqs[].pregunta': 70,
    'faqs[].respuesta': 200,
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
    'faqs[].pregunta': 70,
    'faqs[].respuesta': 200,
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
    'faqs[].pregunta': 70,
    'faqs[].respuesta': 200,
  },
  'turismo-alojamiento': {
    eyebrow_hero: 45,
    hero_title: 60,
    hero_subtitle: 170,
    'trust_badges[]': 30,
    h2_alojamiento: 55,
    lead_alojamiento: 140,
    'alojamientos[].titulo': 30,
    'alojamientos[].descripcion': 110,
    'alojamientos[].capacidad': 24,
    'alojamientos[].precio_desde': 24,
    h2_servicios: 55,
    lead_servicios: 140,
    'comodidades[]': 28,
    h2_entorno: 55,
    lead_entorno: 140,
    'entorno[].titulo': 30,
    'entorno[].descripcion': 90,
    h2_reserva: 55,
    lead_reserva: 140,
    'reserva_points[].descripcion': 80,
    'faqs[].pregunta': 70,
    'faqs[].respuesta': 200,
    'reviews[].cita': 150,
  },
  'comercio-retail': {
    eyebrow_hero: 45,
    hero_title: 60,
    hero_subtitle: 170,
    'trust_badges[]': 30,
    h2_productos: 55,
    lead_productos: 140,
    'productos[].titulo': 30,
    'productos[].descripcion': 90,
    'productos[].precio': 24,
    h2_tienda: 55,
    historia_p1: 280,
    historia_p2: 280,
    h2_razones: 55,
    lead_razones: 140,
    'razones[].titulo': 30,
    'razones[].descripcion': 95,
    h2_visita: 55,
    lead_visita: 140,
    'horarios[].dia': 20,
    'horarios[].horas': 32,
    'faqs[].pregunta': 70,
    'faqs[].respuesta': 200,
    'reviews[].cita': 150,
  },
  'reformas-construccion': {
    eyebrow_hero: 45,
    hero_title: 60,
    hero_subtitle: 180,
    'trust_badges[]': 30,
    h2_servicios: 55,
    lead_servicios: 140,
    'servicios[].titulo': 30,
    'servicios[].descripcion': 100,
    h2_proceso: 55,
    lead_proceso: 140,
    'proceso[].titulo': 28,
    'proceso[].descripcion': 90,
    'proyectos[].titulo': 35,
    'proyectos[].descripcion': 100,
    h2_presupuesto: 55,
    lead_presupuesto: 140,
    'presupuesto_points[].descripcion': 80,
    'faqs[].pregunta': 70,
    'faqs[].respuesta': 200,
    'reviews[].cita': 150,
  },
  'formacion-academias': {
    eyebrow_hero: 45,
    hero_title: 60,
    hero_subtitle: 180,
    'trust_badges[]': 30,
    h2_cursos: 55,
    lead_cursos: 140,
    'cursos[].titulo': 34,
    'cursos[].descripcion': 100,
    'cursos[].duracion': 26,
    'cursos[].modalidad': 24,
    h2_metodo: 55,
    lead_metodo: 140,
    'metodo[].titulo': 28,
    'metodo[].descripcion': 90,
    'profes[].rol': 30,
    'profes[].credencial': 95,
    h2_matricula: 55,
    lead_matricula: 140,
    'matricula_points[].descripcion': 80,
    'faqs[].pregunta': 70,
    'faqs[].respuesta': 200,
    'reviews[].cita': 150,
  },
  'ocio-cultura': {
    eyebrow_hero: 45,
    hero_title: 60,
    hero_subtitle: 170,
    'trust_badges[]': 30,
    h2_actividades: 55,
    lead_actividades: 140,
    'actividades[].titulo': 32,
    'actividades[].detalle': 30,
    'actividades[].descripcion': 100,
    h2_tarifas: 55,
    lead_tarifas: 140,
    'tarifas[].concepto': 40,
    'tarifas[].precio': 24,
    h2_reserva: 55,
    lead_reserva: 140,
    'reserva_points[].descripcion': 80,
    'horarios[].dia': 20,
    'horarios[].horas': 32,
    'faqs[].pregunta': 70,
    'faqs[].respuesta': 200,
    'reviews[].cita': 150,
  },
  'automocion': {
    eyebrow_hero: 45,
    hero_title: 60,
    hero_subtitle: 180,
    'trust_badges[]': 30,
    h2_servicios: 55,
    lead_servicios: 140,
    'servicios[].titulo': 30,
    'servicios[].descripcion': 100,
    h2_razones: 55,
    lead_razones: 140,
    'razones[].titulo': 30,
    'razones[].descripcion': 95,
    h2_cita: 55,
    lead_cita: 140,
    'cita_points[].descripcion': 80,
    'faqs[].pregunta': 70,
    'faqs[].respuesta': 200,
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
