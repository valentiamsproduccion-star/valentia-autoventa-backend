// Servicio de renderizado: junta datos_base (comunes a los 3 sectores) +
// contenido (JSON generado por IA o escrito por el cliente) y produce el
// HTML final a partir de la plantilla .mustache del sector.

'use strict';

const fs = require('fs');
const path = require('path');
const { render } = require('../lib/mustache');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
// Plantillas por-diseño (una por cada diseño de la galería, según se vayan
// convirtiendo -- ver Tarea "Infraestructura plantilla_id"). Si el archivo
// {plantillaId}.mustache no existe aquí todavía, se usa el genérico del
// sector (TEMPLATE_FILE) sin que el cliente note ninguna diferencia: así se
// pueden ir convirtiendo los ~150 diseños uno a uno sin romper nada.
const PLANTILLAS_DIR = path.join(TEMPLATES_DIR, 'plantillas');

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

// ── Color de marca personalizado (ver Formulario de Alta, sección "Color de
// marca") ─────────────────────────────────────────────────────────────────
// Cada plantilla .mustache define su paleta con variables CSS en :root
// (--accent, --accent-mid, --accent-dim), siempre con el mismo patrón. Si el
// cliente indica un color propio (su color corporativo), lo convertimos en
// esos mismos 3 tonos y los inyectamos como un <style> extra justo antes de
// </head> -- así sobreescribe el :root original del diseño elegido sin tocar
// ninguna de las ~40 plantillas una a una. Si no indica ninguno, no se
// inyecta nada y la web usa el color del diseño tal cual, como siempre.
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function hexToRgbArr(hex) {
  const num = parseInt(hex.slice(1), 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

// percent negativo = más oscuro (mezcla hacia negro), positivo = más claro
// (mezcla hacia blanco). Se usa -12% para el tono "mid" de botones/hover,
// imitando la relación que ya tienen accent/accent-mid en las plantillas.
function shadeHex(hex, percent) {
  const [r, g, b] = hexToRgbArr(hex);
  const target = percent < 0 ? 0 : 255;
  const p = Math.abs(percent) / 100;
  const mix = (c) => Math.round((target - c) * p) + c;
  return '#' + [mix(r), mix(g), mix(b)].map(v => v.toString(16).padStart(2, '0')).join('');
}

function hexToRgba(hex, alpha) {
  const [r, g, b] = hexToRgbArr(hex);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

// Devuelve { color_primario, color_primario_mid, color_primario_dim } listos
// para el contexto de mustache, o campos vacíos si no hay color válido (el
// cliente no puso ninguno, o lo que puso no es un hexadecimal de 6 dígitos).
function colorPersonalizado(hex) {
  const limpio = String(hex || '').trim();
  if (!HEX_RE.test(limpio)) return { color_primario: '', color_primario_mid: '', color_primario_dim: '' };
  return {
    color_primario: limpio,
    color_primario_mid: shadeHex(limpio, -12),
    color_primario_dim: hexToRgba(limpio, 0.10),
  };
}

// Inyecta el <style> de sobreescritura de color justo antes de `</head>` si
// el cliente puso un color propio; si no, devuelve el HTML tal cual.
function withColorOverride(html, ctx) {
  if (!ctx.color_primario) return html;
  const style = '<style>:root{--accent:' + ctx.color_primario +
    ';--accent-mid:' + ctx.color_primario_mid +
    ';--accent-dim:' + ctx.color_primario_dim + '}</style>';
  return html.includes('</head>') ? html.replace('</head>', style + '</head>') : html + style;
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
    // Datos fiscales (ver Formulario de Alta, sección "Datos fiscales") --
    // solo los usan las páginas legales (ver services/legal.js), pero se
    // exponen aquí porque baseContext() es compartido por todas las
    // plantillas/páginas de un mismo cliente.
    razon_social: datosBase.razon_social || '',
    forma_juridica: datosBase.forma_juridica || '',
    nif_cif: datosBase.nif_cif || '',
    domicilio_fiscal: datosBase.domicilio_fiscal || '',
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
    // Color de marca (ver Formulario de Alta, sección "Color de marca") --
    // se usa vía withColorOverride() más abajo, no directamente en las
    // plantillas (que ya traen su propio :root con el color del diseño).
    ...colorPersonalizado(datosBase.color_primario),
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
  return renderSector('servicios-profesionales', ctx, opts);
}

// ── Subpáginas reales (Áreas/Equipo/Contacto en vez de anclas #areas/#equipo/
// #contacto en la misma página) -- ver Tarea "Piloto multi-página: Servicios
// profesionales". Cada subpágina reutiliza el mismo `contenido` de la
// página principal (no hace falta pedirle nada nuevo al cliente); solo se
// muestra en una plantilla propia bajo templates/subpaginas/.
const SUBPAGINAS_DIR = path.join(TEMPLATES_DIR, 'subpaginas');

function renderSubpagina(sector, pagina, ctx) {
  const templatePath = path.join(SUBPAGINAS_DIR, sector + '-' + pagina + '.mustache');
  const template = fs.readFileSync(templatePath, 'utf-8');
  return withColorOverride(render(template, ctx), ctx);
}

function renderServiciosProfesionalesAreas(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    areas: withIndex(contenido.areas),
  });
  return renderSubpagina('servicios-profesionales', 'areas', ctx);
}

function renderServiciosProfesionalesEquipo(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {});
  return renderSubpagina('servicios-profesionales', 'equipo', ctx);
}

function renderServiciosProfesionalesContacto(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    areas: withIndex(contenido.areas), // para el <select> del formulario de consulta
    consulta_points: withIndex(contenido.consulta_points),
  });
  return renderSubpagina('servicios-profesionales', 'contacto', ctx);
}

// ── Salud y bienestar: Tratamientos / Equipo / Contacto ──────────────────
function renderSaludBienestarTratamientos(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    treats: withIndex(contenido.treats),
  });
  return renderSubpagina('salud-bienestar', 'tratamientos', ctx);
}
function renderSaludBienestarEquipo(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {});
  return renderSubpagina('salud-bienestar', 'equipo', ctx);
}
function renderSaludBienestarContacto(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    cita_points: withIndex(contenido.cita_points),
  });
  return renderSubpagina('salud-bienestar', 'contacto', ctx);
}

// ── Hostelería y restauración: Carta / Nosotros / Contacto ───────────────
function renderHosteleriaRestauracionCarta(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {});
  return renderSubpagina('hosteleria-restauracion', 'carta', ctx);
}
function renderHosteleriaRestauracionNosotros(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {});
  return renderSubpagina('hosteleria-restauracion', 'nosotros', ctx);
}
function renderHosteleriaRestauracionContacto(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {});
  return renderSubpagina('hosteleria-restauracion', 'contacto', ctx);
}

// ── Turismo y alojamiento: Alojamiento / Entorno / Contacto ──────────────
function renderTurismoAlojamientoAlojamiento(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    comodidades: (contenido.comodidades || []).filter(Boolean),
  });
  return renderSubpagina('turismo-alojamiento', 'alojamiento', ctx);
}
function renderTurismoAlojamientoEntorno(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    entorno: withIndex(contenido.entorno),
  });
  return renderSubpagina('turismo-alojamiento', 'entorno', ctx);
}
function renderTurismoAlojamientoContacto(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    reserva_points: withIndex(contenido.reserva_points),
  });
  return renderSubpagina('turismo-alojamiento', 'contacto', ctx);
}

// ── Comercio y retail: Productos / Tienda / Contacto ─────────────────────
function renderComercioRetailProductos(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    razones: withIndex(contenido.razones),
  });
  return renderSubpagina('comercio-retail', 'productos', ctx);
}
function renderComercioRetailTienda(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {});
  return renderSubpagina('comercio-retail', 'tienda', ctx);
}
function renderComercioRetailContacto(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {});
  return renderSubpagina('comercio-retail', 'contacto', ctx);
}

// ── Reformas y construcción: Servicios / Proceso / Contacto ──────────────
function renderReformasConstruccionServicios(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {});
  return renderSubpagina('reformas-construccion', 'servicios', ctx);
}
function renderReformasConstruccionProceso(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    proceso: withIndex(contenido.proceso),
    hay_proyectos: Array.isArray(contenido.proyectos) && contenido.proyectos.length > 0,
  });
  return renderSubpagina('reformas-construccion', 'proceso', ctx);
}
function renderReformasConstruccionContacto(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    presupuesto_points: withIndex(contenido.presupuesto_points),
  });
  return renderSubpagina('reformas-construccion', 'contacto', ctx);
}

// ── Formación y academias: Cursos / Metodología / Contacto ───────────────
function renderFormacionAcademiasCursos(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {});
  return renderSubpagina('formacion-academias', 'cursos', ctx);
}
function renderFormacionAcademiasMetodologia(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    metodo: withIndex(contenido.metodo),
    hay_profes: Array.isArray(contenido.profes) && contenido.profes.length > 0,
  });
  return renderSubpagina('formacion-academias', 'metodologia', ctx);
}
function renderFormacionAcademiasContacto(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    matricula_points: withIndex(contenido.matricula_points),
  });
  return renderSubpagina('formacion-academias', 'contacto', ctx);
}

// ── Ocio y cultura: Actividades / Tarifas / Contacto ──────────────────────
function renderOcioCulturaActividades(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {});
  return renderSubpagina('ocio-cultura', 'actividades', ctx);
}
function renderOcioCulturaTarifas(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {});
  return renderSubpagina('ocio-cultura', 'tarifas', ctx);
}
function renderOcioCulturaContacto(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    reserva_points: withIndex(contenido.reserva_points),
  });
  return renderSubpagina('ocio-cultura', 'contacto', ctx);
}

// ── Automoción: Servicios / Razones / Contacto ───────────────────────────
function renderAutomocionServicios(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {});
  return renderSubpagina('automocion', 'servicios', ctx);
}
function renderAutomocionRazones(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    razones: withIndex(contenido.razones),
  });
  return renderSubpagina('automocion', 'razones', ctx);
}
function renderAutomocionContacto(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    cita_points: withIndex(contenido.cita_points),
  });
  return renderSubpagina('automocion', 'contacto', ctx);
}

// Mapa sector -> { nombre_pagina: función renderer }. Los sectores que no
// aparezcan aquí todavía no tienen subpáginas reales (ver Tarea "Replicar
// estructura multi-página a los 8 sectores restantes") -- sus enlaces de
// nav siguen siendo anclas (#areas, etc.) hasta que se conviertan.
const SUBPAGINA_RENDERERS = {
  'servicios-profesionales': {
    areas: renderServiciosProfesionalesAreas,
    equipo: renderServiciosProfesionalesEquipo,
    contacto: renderServiciosProfesionalesContacto,
  },
  'salud-bienestar': {
    tratamientos: renderSaludBienestarTratamientos,
    equipo: renderSaludBienestarEquipo,
    contacto: renderSaludBienestarContacto,
  },
  'hosteleria-restauracion': {
    carta: renderHosteleriaRestauracionCarta,
    nosotros: renderHosteleriaRestauracionNosotros,
    contacto: renderHosteleriaRestauracionContacto,
  },
  'turismo-alojamiento': {
    alojamiento: renderTurismoAlojamientoAlojamiento,
    entorno: renderTurismoAlojamientoEntorno,
    contacto: renderTurismoAlojamientoContacto,
  },
  'comercio-retail': {
    productos: renderComercioRetailProductos,
    tienda: renderComercioRetailTienda,
    contacto: renderComercioRetailContacto,
  },
  'reformas-construccion': {
    servicios: renderReformasConstruccionServicios,
    proceso: renderReformasConstruccionProceso,
    contacto: renderReformasConstruccionContacto,
  },
  'formacion-academias': {
    cursos: renderFormacionAcademiasCursos,
    metodologia: renderFormacionAcademiasMetodologia,
    contacto: renderFormacionAcademiasContacto,
  },
  'ocio-cultura': {
    actividades: renderOcioCulturaActividades,
    tarifas: renderOcioCulturaTarifas,
    contacto: renderOcioCulturaContacto,
  },
  'automocion': {
    servicios: renderAutomocionServicios,
    razones: renderAutomocionRazones,
    contacto: renderAutomocionContacto,
  },
};

// Lista de nombres de subpágina reales de un sector (p. ej. ['areas',
// 'equipo', 'contacto']), o [] si el sector todavía no tiene ninguna.
function subpaginasDeSector(sector) {
  return Object.keys(SUBPAGINA_RENDERERS[sector] || {});
}

// Punto de entrada para las subpáginas, paralelo a renderPagina() de más
// abajo. Devuelve null si el sector no tiene esa subpágina todavía (el
// llamador decide qué hacer -- ver publish.js, que simplemente no publica
// nada en ese caso).
function renderPaginaSector(sector, pagina, datosBase, contenido, opts) {
  const sectorMap = SUBPAGINA_RENDERERS[sector];
  const fn = sectorMap && sectorMap[pagina];
  if (!fn) return null;
  return fn(datosBase, contenido, opts);
}

function renderSaludBienestar(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    treats: withIndex(contenido.treats),
    cita_points: withIndex(contenido.cita_points),
    hay_reviews: Array.isArray(contenido.reviews) && contenido.reviews.length > 0,
    hay_faqs: Array.isArray(contenido.faqs) && contenido.faqs.length > 0,
  });
  return renderSector('salud-bienestar', ctx, opts);
}

function renderHosteleriaRestauracion(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    hay_events: Array.isArray(contenido.events) && contenido.events.length > 0,
    hay_reviews: Array.isArray(contenido.reviews) && contenido.reviews.length > 0,
    hay_faqs: Array.isArray(contenido.faqs) && contenido.faqs.length > 0,
  });
  return renderSector('hosteleria-restauracion', ctx, opts);
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
  return renderSector('turismo-alojamiento', ctx, opts);
}

function renderComercioRetail(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    razones: withIndex(contenido.razones),
    hay_reviews: Array.isArray(contenido.reviews) && contenido.reviews.length > 0,
    hay_faqs: Array.isArray(contenido.faqs) && contenido.faqs.length > 0,
  });
  return renderSector('comercio-retail', ctx, opts);
}

function renderReformasConstruccion(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    proceso: withIndex(contenido.proceso),
    presupuesto_points: withIndex(contenido.presupuesto_points),
    hay_proyectos: Array.isArray(contenido.proyectos) && contenido.proyectos.length > 0,
    hay_reviews: Array.isArray(contenido.reviews) && contenido.reviews.length > 0,
    hay_faqs: Array.isArray(contenido.faqs) && contenido.faqs.length > 0,
  });
  return renderSector('reformas-construccion', ctx, opts);
}

function renderFormacionAcademias(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    metodo: withIndex(contenido.metodo),
    matricula_points: withIndex(contenido.matricula_points),
    hay_profes: Array.isArray(contenido.profes) && contenido.profes.length > 0,
    hay_reviews: Array.isArray(contenido.reviews) && contenido.reviews.length > 0,
    hay_faqs: Array.isArray(contenido.faqs) && contenido.faqs.length > 0,
  });
  return renderSector('formacion-academias', ctx, opts);
}

function renderOcioCultura(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    reserva_points: withIndex(contenido.reserva_points),
    hay_reviews: Array.isArray(contenido.reviews) && contenido.reviews.length > 0,
    hay_faqs: Array.isArray(contenido.faqs) && contenido.faqs.length > 0,
  });
  return renderSector('ocio-cultura', ctx, opts);
}

function renderAutomocion(datosBase, contenido, opts) {
  const ctx = Object.assign({}, baseContext(datosBase, opts), contenido, {
    razones: withIndex(contenido.razones),
    cita_points: withIndex(contenido.cita_points),
    hay_reviews: Array.isArray(contenido.reviews) && contenido.reviews.length > 0,
    hay_faqs: Array.isArray(contenido.faqs) && contenido.faqs.length > 0,
  });
  return renderSector('automocion', ctx, opts);
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

function renderSector(sector, ctx, opts) {
  const file = TEMPLATE_FILE[sector];
  if (!file) throw new Error('Sector desconocido: ' + sector);

  // Si este cliente eligió un diseño concreto de la galería (plantilla_id) Y
  // ese diseño ya tiene su plantilla real convertida (ver Tarea "Convertir
  // piloto: 5 diseños de Taller"), se usa esa en vez de la genérica del
  // sector -- así la web final reproduce el diseño exacto que vio el
  // cliente. Si todavía no existe (la mayoría de los ~150 diseños, por
  // ahora), cae automáticamente en la plantilla genérica de siempre.
  const plantillaId = opts && opts.plantillaId;
  let templatePath = path.join(TEMPLATES_DIR, file);
  if (plantillaId) {
    const plantillaPath = path.join(PLANTILLAS_DIR, plantillaId + '.mustache');
    if (fs.existsSync(plantillaPath)) {
      templatePath = plantillaPath;
    }
  }

  const template = fs.readFileSync(templatePath, 'utf-8');
  return withColorOverride(render(template, ctx), ctx);
}

// Punto de entrada único: sector + datos base + contenido -> HTML final.
// opts.preview = true muestra el badge "VISTA PREVIA" y las notas de
// función ampliable que no deben verse en la web publicada de un cliente real.
function renderPagina(sector, datosBase, contenido, opts) {
  const fn = RENDERERS[sector];
  if (!fn) throw new Error('Sector desconocido: ' + sector);
  return fn(datosBase, contenido, opts);
}

// ── Páginas legales (genéricas, iguales para los 9 sectores) ──────────────
// Ver Tarea "Construir plantillas legales genéricas" -- toda web publicada
// lleva Aviso Legal, Privacidad y Cookies por ley (LSSI/RGPD), rellenadas
// con los "Datos fiscales" del Formulario de Alta (ver baseContext()).
const LEGAL_DIR = path.join(TEMPLATES_DIR, 'legal');
const TEMPLATE_FILE_LEGAL = {
  'aviso-legal': 'aviso-legal.mustache',
  'privacidad': 'privacidad.mustache',
  'cookies': 'cookies.mustache',
};

function renderPaginaLegal(pagina, datosBase, opts) {
  const file = TEMPLATE_FILE_LEGAL[pagina];
  if (!file) throw new Error('Página legal desconocida: ' + pagina);
  const ctx = baseContext(datosBase, opts);
  const template = fs.readFileSync(path.join(LEGAL_DIR, file), 'utf-8');
  return withColorOverride(render(template, ctx), ctx);
}

module.exports = {
  renderPagina,
  renderPaginaLegal,
  renderPaginaSector,
  subpaginasDeSector,
  TEMPLATE_FILE: Object.keys(TEMPLATE_FILE),
  TEMPLATE_FILE_LEGAL: Object.keys(TEMPLATE_FILE_LEGAL),
};
