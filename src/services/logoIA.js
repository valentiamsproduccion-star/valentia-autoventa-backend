// Logo con IA (ver formulario de alta, sección "Logo y favicon", y "Flujo de
// Autoventa" -- el cliente marca que quiere que la IA le diseñe un logo).
//
// Antes esto era un checkbox que solo avisaba al equipo por email para
// diseñarlo A MANO después del pago (ver services/email.js,
// sendLogoIaSolicitadoEmail). Ahora se genera de verdad, ANTES de la compra,
// con 3 opciones distintas para elegir -- así el cliente ve y aprueba el
// resultado final antes de pagar el suplemento de 15€.
//
// Flujo en dos fases (ver public/alta.html):
//  1) generarTresOpciones: 3 conceptos DIFERENTES (no 3 variaciones al azar
//     del mismo prompt) en cuadrado 1024x1024, para que el cliente elija.
//  2) generarFormatosDesdeEleccion: a partir del cuadrado ya elegido, deriva
//     la versión apaisada (edición/outpainting sobre la MISMA imagen, no una
//     generación nueva -- así el resultado es coherente con lo elegido) y
//     reutiliza el propio cuadrado como favicón (un PNG grande funciona bien
//     como favicon, el navegador lo reescala; evita una 3ª llamada a la API
//     y no hace falta ninguna librería de procesado de imágenes).
//
// Los 3 resultados finales (cuadrada/favicón/apaisada) viajan como base64 en
// el payload de POST /api/alta exactamente igual que un logo subido a mano
// por el cliente (ver server.js, campos `logos`/`favicon`) -- no hace falta
// tocar la subida a Supabase Storage, que ya sabe procesar ese formato.

'use strict';

const { generarImagen, editarImagen } = require('./openaiImages');

// 3 direcciones de diseño distintas -- si se pidiera "un logo" 3 veces con
// el mismo prompt saldrían variaciones aleatorias de UN mismo estilo; esto
// obliga a 3 propuestas realmente distintas entre sí.
const ESTILOS = [
  {
    id: 'a',
    nombre: 'Minimalista geométrico',
    instrucciones:
      'Estilo minimalista y geométrico: una sola figura icónica abstracta hecha con formas simples ' +
      '(círculos, líneas, triángulos), muy poco detalle, look moderno tipo marca tecnológica actual.',
  },
  {
    id: 'b',
    nombre: 'Emblema clásico',
    instrucciones:
      'Estilo de emblema o insignia clásica: un elemento central ilustrado con líneas finas y detalle ' +
      'artesanal, sensación de confianza y tradición, look atemporal.',
  },
  {
    id: 'c',
    nombre: 'Icono moderno con color',
    instrucciones:
      'Estilo icónico moderno y vistoso: forma memorable y audaz, con un color de acento fuerte y alto ' +
      'contraste, look de marca actual y cercana.',
  },
];

// Convierte las respuestas del bloque "Personaliza tu logo" (ver
// public/alta.html, collectLogoBrief()) en frases sueltas para añadir al
// prompt. Todos los campos son opcionales -- un brief vacío o undefined no
// añade nada, así que el comportamiento sin respuestas es idéntico al de
// antes.
function frasesDelBrief(brief) {
  if (!brief) return [];
  const frases = [];

  if (brief.texto_o_simbolo === 'con_texto') {
    frases.push(
      'Incluye el nombre del negocio integrado en el propio diseño del logo, con una tipografía que combine bien con el icono.'
    );
  } else if (brief.texto_o_simbolo === 'solo_simbolo') {
    frases.push(
      'Diseña SOLO un símbolo o icono, sin ningún texto ni letras en la imagen -- el nombre del negocio se añadirá aparte, fuera del logo.'
    );
  }

  if (Array.isArray(brief.personalidad) && brief.personalidad.length) {
    frases.push('La marca debe transmitir: ' + brief.personalidad.join(', ') + '.');
  }

  if (brief.paleta_colores) {
    frases.push('Paleta de colores preferida por el cliente: ' + brief.paleta_colores + '.');
  }
  if (brief.colores_evitar) {
    frases.push('Evita estos colores: ' + brief.colores_evitar + '.');
  }

  if (brief.abstracto_o_figurativo === 'abstracto') {
    frases.push('Usa un símbolo abstracto o geométrico, no un objeto literal.');
  } else if (brief.abstracto_o_figurativo === 'figurativo') {
    frases.push('Usa un elemento figurativo reconocible que represente la actividad del negocio.');
  }

  if (brief.elemento) {
    frases.push('Si encaja bien con el diseño, incorpora este elemento: ' + brief.elemento + '.');
  }

  if (brief.referencias) {
    frases.push(
      'Referencia de estilo que le gusta al cliente (inspírate en la sensación general, NO copies ningún logo real ni marca existente): ' +
        brief.referencias +
        '.'
    );
  }

  if (brief.evitar) {
    frases.push('Evita esto: ' + brief.evitar + '.');
  }

  if (brief.cliente_ideal) {
    frases.push('El cliente ideal de este negocio es: ' + brief.cliente_ideal + '.');
  }

  if (brief.tono === 'serio') {
    frases.push('Tono serio y formal.');
  } else if (brief.tono === 'cercano') {
    frases.push('Tono cercano y desenfadado.');
  }

  if (brief.uso_fisico) {
    frases.push(
      'El logo también se usará impreso en rótulos, vehículos o uniformes, así que debe funcionar bien reducido a un solo color (blanco o negro), sin depender del color para leerse.'
    );
  }

  return frases;
}

function construirPromptBase(datosBase) {
  const { nombre_negocio, sector, tipo_negocio, ciudad, brief } = datosBase || {};
  let prompt =
    'Diseña un logotipo profesional para un negocio real llamado "' + (nombre_negocio || '') + '"';
  if (tipo_negocio) prompt += ', del tipo "' + tipo_negocio + '"';
  if (sector) prompt += ' (sector: ' + sector + ')';
  if (ciudad) prompt += ', ubicado en ' + ciudad;
  prompt +=
    '. Debe funcionar bien tanto en tamaño pequeño (favicon) como grande. ' +
    'Fondo blanco sólido y liso (para poder recortarlo después), sin marcas de agua, ' +
    'sin texto de relleno ni lorem ipsum, sin bordes ni marcos decorativos alrededor del lienzo, ' +
    'sin firmas ni watermarks de IA.';

  const frasesBrief = frasesDelBrief(brief);
  if (frasesBrief.length) prompt += ' ' + frasesBrief.join(' ');

  return prompt;
}

// Fase 1: 3 opciones en cuadrado (1024x1024).
async function generarTresOpciones(datosBase) {
  if (!datosBase || !datosBase.nombre_negocio) {
    throw new Error('Falta el nombre del negocio para generar el logo.');
  }
  const base = construirPromptBase(datosBase);
  const opciones = [];
  for (const estilo of ESTILOS) {
    const prompt = base + ' ' + estilo.instrucciones;
    const base64 = await generarImagen(prompt, '1024x1024');
    opciones.push({ id: estilo.id, nombre: estilo.nombre, base64, mime: 'image/png' });
  }
  return opciones;
}

// Fase 2: deriva favicón + apaisada a partir del cuadrado ya elegido por el cliente.
async function generarFormatosDesdeEleccion(base64Cuadrada, datosBase) {
  if (!base64Cuadrada) throw new Error('Falta la imagen del logo elegido.');
  const nombreNegocio = (datosBase && datosBase.nombre_negocio) || '';
  const promptApaisada =
    'Convierte este logotipo en un formato horizontal (apaisado), ancho, tipo cabecera de web, ' +
    'manteniendo EXACTAMENTE el mismo icono, estilo y colores del logo original -- no inventes un ' +
    'diseño distinto. ' +
    (nombreNegocio
      ? 'Puedes añadir el nombre "' + nombreNegocio + '" en texto junto al icono si mejora la composición. '
      : '') +
    'Fondo blanco sólido y liso, sin marcos.';
  const apaisadaBase64 = await editarImagen(promptApaisada, '1536x1024', base64Cuadrada, 'image/png');
  return {
    cuadrada: { base64: base64Cuadrada, mime: 'image/png' },
    favicon: { base64: base64Cuadrada, mime: 'image/png' },
    apaisada: { base64: apaisadaBase64, mime: 'image/png' },
  };
}

module.exports = { generarTresOpciones, generarFormatosDesdeEleccion };
