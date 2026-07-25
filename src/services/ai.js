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
    throw new Error('La respuesta de la IA no contiene un JSON reconocible.');
  }
  return JSON.parse(text.slice(start, end + 1));
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

  const respuesta = await postJSON(
    ANTHROPIC_API_URL,
    '/v1/messages',
    { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    {
      model: DEFAULT_MODEL,
      max_tokens: 2048,
      system: sistema,
      messages: [{ role: 'user', content: mensajeUsuario }],
    }
  );

  const textoModelo = (respuesta.content || []).map(b => b.text || '').join('\n');
  return extractJson(textoModelo);
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

  const respuesta = await postJSON(
    ANTHROPIC_API_URL,
    '/v1/messages',
    { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    {
      model: DEFAULT_MODEL,
      max_tokens: 2048,
      system: sistema,
      messages: [{ role: 'user', content: mensajeUsuario }],
    }
  );

  const textoModelo = (respuesta.content || []).map(b => b.text || '').join('\n');
  return extractJson(textoModelo);
}

module.exports = { generarContenido, mejorarContenido, extractJson };
