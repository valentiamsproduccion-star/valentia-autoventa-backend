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

function construirPromptBase(datosBase) {
  const { nombre_negocio, sector, tipo_negocio, ciudad } = datosBase || {};
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
