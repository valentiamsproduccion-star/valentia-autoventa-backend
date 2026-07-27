// Generación de contenido con IA (vía "IA desde cero" del Formulario de
// Alta). Llama directamente a la API de Anthropic con https nativo de
// Node -- no hay SDK instalado porque el entorno de desarrollo no tiene
// acceso a npm, y de paso deja el backend sin dependencias externas para
// esta parte, lo cual es una ventaja real en un hosting modesto.
//
// No inventa nada por su cuenta: el prompt (rol/tono/reglas/formato) es el
// mismo, palabra por palabra, que el ya cerrado en "Prompts de Redacción
// IA" (ver src/prompts/index.js).

'use strict';

const https = require('https');
const { SISTEMA, ENTRADA_ESPERADA } = require('../prompts');

const ANTHROPIC_API_URL = 'api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

function postJSON(hostname, urlPath, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = https.request(
      {
        hostname,
        path: urlPath,
        method: 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          headers
        ),
      },
      res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            return reject(new Error('Respuesta no-JSON de ' + hostname + ': ' + data.slice(0, 300)));
          }
          if (res.statusCode >= 400) {
            return reject(new Error('HTTP ' + res.statusCode + ' de ' + hostname + ': ' + JSON.stringify(parsed)));
          }
          resolve(parsed);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Extrae el primer bloque JSON válido de un texto -- red de seguridad por si
// el modelo, a pesar de la regla "responde solo con el JSON pedido", añade
// texto alrededor.
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    // Se incluye un fragmento de la respuesta real en el error -- sin esto,
    // un fallo aquí es indepurable (no hay forma de saber si el modelo
    // rehusó, devolvió prosa, o la llamada a la API falló de otra forma).
    throw new Error('La respuesta de la IA no contiene un JSON reconocible. Respuesta recibida: ' + JSON.stringify((text || '').slice(0, 400)));
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error('La respuesta de la IA no es JSON válido (' + e.message + '). Fragmento: ' + JSON.stringify(text.slice(start, start + 400)));
  }
}

// Llama a /v1/messages con los mensajes dados y devuelve el texto del
// modelo. Centraliza la lectura de la respuesta (errores de Anthropic,
// respuesta vacía) para no repetirlo en cada vía (generar/mejorar) ni en
// el reintento de abajo.
async function llamarClaude(apiKey, sistema, messages) {
  const respuesta = await postJSON(
    ANTHROPIC_API_URL,
    '/v1/messages',
    { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    {
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      // claude-sonnet-5 activa razonamiento extendido por defecto, y ese
      // razonamiento consume el mismo presupuesto de max_tokens -- con
      // prompts largos se gastaba todo en "thinking" y no quedaba nada para
      // el JSON de salida (stop_reason: "max_tokens", sin bloque de texto).
      // Lo desactivamos explícitamente: aquí no hace falta razonamiento,
      // solo redacción siguiendo reglas ya cerradas en el prompt de sistema.
      thinking: { type: 'disabled' },
      system: sistema,
      messages,
    }
  );

  if (respuesta.type === 'error') {
    throw new Error('Anthropic devolvió un error: ' + JSON.stringify(respuesta.error || respuesta));
  }
  const textoModelo = (respuesta.content || []).map(b => b.text || '').join('\n');
  if (!textoModelo) {
    // Diagnóstico: qué tipos de bloque llegaron y por qué se paró la
    // respuesta (p. ej. "max_tokens" si el modelo gastó todo el presupuesto
    // en razonamiento interno antes de escribir el JSON).
    const tipos = (respuesta.content || []).map(b => b.type).join(',');
    throw new Error('La IA no devolvió texto. stop_reason=' + respuesta.stop_reason + ', tipos_de_bloque=[' + tipos + '], usage=' + JSON.stringify(respuesta.usage));
  }
  return textoModelo;
}

// Pide el JSON y, si el modelo se sale del formato (p. ej. porque los datos
// de entrada le parecen incoherentes y responde con una pregunta o un aviso
// en vez del JSON pedido -- ver prompts/index.js, regla "responde solo con
// el JSON"), reintenta UNA vez insistiendo explícitamente en el formato,
// antes de darle al cliente un error en crudo. Así una respuesta rara del
// modelo no tira abajo la generación de la vista previa.
async function pedirJson(apiKey, sistema, mensajeUsuario) {
  const messages = [{ role: 'user', content: mensajeUsuario }];
  const textoModelo = await llamarClaude(apiKey, sistema, messages);
  try {
    return extractJson(textoModelo);
  } catch (primerError) {
    const mensajeCorreccion =
      'Tu respuesta anterior no era el JSON pedido (empezaba así: "' +
      textoModelo.slice(0, 200) +
      '"). Recuerda la regla: responde ÚNICAMENTE con el JSON pedido, sin ' +
      'preguntas ni comentarios, aunque los datos te parezcan incompletos o ' +
      'incoherentes -- usa "[PENDIENTE: dato del cliente]" en los campos que ' +
      'no puedas rellenar con garantías.';
    const reintento = await llamarClaude(apiKey, sistema, [
      ...messages,
      { role: 'assistant', content: textoModelo },
      { role: 'user', content: mensajeCorreccion },
    ]);
    try {
      return extractJson(reintento);
    } catch (segundoError) {
      // Si insistiendo tampoco lo consigue, se propaga el error del PRIMER
      // intento (suele ser más informativo sobre la causa real -- p. ej. la
      // objeción original del modelo sobre los datos).
      throw primerError;
    }
  }
}

// datosEnBruto: el objeto con los campos de la "Tabla B" del sector
// (Formulario de Alta) tal como los rellenó el cliente.
async function generarContenido(sector, datosEnBruto) {
  const sistema = SISTEMA[sector];
  if (!sistema) throw new Error('Sector sin prompt definido: ' + sector);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Falta ANTHROPIC_API_KEY. Crea una clave en https://console.anthropic.com y ponla en el .env (ver README).'
    );
  }

  const mensajeUsuario =
    'ENTRADA DEL CLIENTE (formato esperado: ' + ENTRADA_ESPERADA[sector] + ')\n\n' +
    JSON.stringify(datosEnBruto, null, 2);

  return pedirJson(apiKey, sistema, mensajeUsuario);
}

// Vía "mejora IA": el cliente ya escribió su propio texto por bloque; la IA
// lo pule y lo ajusta a los límites de caracteres, sin inventar datos
// nuevos ni cambiar el fondo. Reutiliza el mismo prompt de sistema (rol,
// tono, reglas, ficha de límites) y solo cambia el mensaje de usuario.
async function mejorarContenido(sector, textoClientePorBloque) {
  const sistema = SISTEMA[sector];
  if (!sistema) throw new Error('Sector sin prompt definido: ' + sector);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Falta ANTHROPIC_API_KEY. Crea una clave en https://console.anthropic.com y ponla en el .env (ver README).'
    );
  }

  const mensajeUsuario =
    'El cliente ya ha escrito su propio texto para cada campo (más abajo, en bruto). ' +
    'No inventes contenido nuevo ni cambies el fondo de lo que dice: pule la redacción y ' +
    'ajusta cada campo al límite de caracteres de la ficha, exactamente igual que si lo ' +
    'redactases desde cero pero partiendo de este material real del cliente.\n\n' +
    'TEXTO DEL CLIENTE POR CAMPO\n\n' +
    JSON.stringify(textoClientePorBloque, null, 2);

  return pedirJson(apiKey, sistema, mensajeUsuario);
}

module.exports = { generarContenido, mejorarContenido, extractJson };
