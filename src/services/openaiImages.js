// Generación de imágenes con IA (logo con IA, ver formulario de alta,
// sección "Logo y favicon"). Llama directamente a la API de OpenAI
// (Images API, modelo gpt-image-1) con https nativo de Node -- mismo
// patrón que services/ai.js (Anthropic) y services/stripe.js: sin SDK
// instalado, porque el entorno de desarrollo no tiene acceso a npm.
//
// Dos operaciones:
//  - generarImagen: texto -> imagen nueva (fase 1, las 3 opciones a elegir).
//  - editarImagen: imagen + texto -> imagen derivada, MISMO estilo/icono que
//    la original (fase 2, la versión apaisada del logo ya elegido -- usa el
//    endpoint de edición/outpainting en vez de generar un logo distinto
//    desde cero, para que sea visualmente coherente con lo que el cliente
//    ya vio y eligió).

'use strict';

const https = require('https');

const OPENAI_API_HOST = 'api.openai.com';
const MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';

// Modo prueba: NO llama a OpenAI, devuelve siempre el mismo PNG de relleno
// (1x1 gris) -- coste cero. Pensado para poder probar todo el flujo del
// alta (formulario, subida, vista previa, publicación) sin gastar saldo
// real cada vez que alguien del equipo prueba la sección "Logo con IA".
// Actívalo con OPENAI_IMAGES_MODO_PRUEBA=true en el .env/Render; NO lo
// dejes activo en producción o los clientes verían ese PNG gris como logo.
const MODO_PRUEBA = String(process.env.OPENAI_IMAGES_MODO_PRUEBA || '').toLowerCase() === 'true';
const PNG_RELLENO_1X1_GRIS =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function apiKeyOrThrow() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Falta OPENAI_API_KEY. Crea una clave en https://platform.openai.com/api-keys y ponla en el .env (ver README).'
    );
  }
  return apiKey;
}

function parseRespuesta(data, statusCode) {
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch (e) {
    throw new Error('Respuesta no-JSON de OpenAI: ' + data.slice(0, 300));
  }
  if (statusCode >= 400) {
    const msg = (parsed.error && parsed.error.message) || JSON.stringify(parsed);
    throw new Error('HTTP ' + statusCode + ' de OpenAI: ' + msg);
  }
  return parsed;
}

function postJSON(urlPath, apiKey, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = https.request(
      {
        hostname: OPENAI_API_HOST,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: 'Bearer ' + apiKey,
        },
      },
      res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          try {
            resolve(parseRespuesta(data, res.statusCode));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// multipart/form-data manual -- necesario para /v1/images/edits, que exige
// subir la imagen de partida como archivo (no admite JSON puro).
function postMultipart(urlPath, apiKey, fields, fileField) {
  return new Promise((resolve, reject) => {
    const boundary = 'ValentiaLogoIA' + Date.now().toString(16) + Math.random().toString(16).slice(2);
    const chunks = [];
    for (const [key, value] of Object.entries(fields)) {
      chunks.push(
        Buffer.from(
          '--' + boundary + '\r\n' +
          'Content-Disposition: form-data; name="' + key + '"\r\n\r\n' +
          value + '\r\n'
        )
      );
    }
    chunks.push(
      Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="' + fileField.name + '"; filename="' + fileField.filename + '"\r\n' +
        'Content-Type: ' + fileField.mime + '\r\n\r\n'
      )
    );
    chunks.push(fileField.data);
    chunks.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
    const body = Buffer.concat(chunks);

    const req = https.request(
      {
        hostname: OPENAI_API_HOST,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': body.length,
          Authorization: 'Bearer ' + apiKey,
        },
      },
      res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          try {
            resolve(parseRespuesta(data, res.statusCode));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function primerB64(respuesta) {
  const b64 = respuesta.data && respuesta.data[0] && respuesta.data[0].b64_json;
  if (!b64) throw new Error('OpenAI no devolvió ninguna imagen.');
  return b64;
}

// prompt -> imagen nueva en base64 (PNG). size: '1024x1024' | '1536x1024' | '1024x1536'.
// quality: 'low' | 'medium' | 'high' -- se fija explícitamente en vez de
// dejar el 'auto' de OpenAI, que en la práctica suele tirar a 'high' (la
// tarifa más cara) incluso para un simple borrador (ver logoIA.js: 'low'
// para las 3 opciones iniciales, que el cliente solo usa para elegir
// dirección de estilo; el formato final ya elegido puede pedir 'medium').
async function generarImagen(prompt, size, quality) {
  if (MODO_PRUEBA) return PNG_RELLENO_1X1_GRIS;
  const apiKey = apiKeyOrThrow();
  const respuesta = await postJSON('/v1/images/generations', apiKey, {
    model: MODEL,
    prompt,
    size: size || '1024x1024',
    quality: quality || 'low',
    n: 1,
  });
  return primerB64(respuesta);
}

// imagen de partida (base64) + prompt -> imagen derivada en base64 (PNG).
async function editarImagen(prompt, size, imagenBase64Origen, mimeOrigen, quality) {
  if (MODO_PRUEBA) return PNG_RELLENO_1X1_GRIS;
  const apiKey = apiKeyOrThrow();
  const buffer = Buffer.from(imagenBase64Origen, 'base64');
  const respuesta = await postMultipart(
    '/v1/images/edits',
    apiKey,
    { model: MODEL, prompt, size: size || '1536x1024', quality: quality || 'medium', n: '1' },
    { name: 'image', filename: 'logo-origen.png', mime: mimeOrigen || 'image/png', data: buffer }
  );
  return primerB64(respuesta);
}

module.exports = { generarImagen, editarImagen };
