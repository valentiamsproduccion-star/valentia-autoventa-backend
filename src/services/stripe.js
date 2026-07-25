// Integración con Stripe sin el SDK oficial (no hay acceso a npm en este
// entorno de desarrollo). La API de Stripe es HTTP/form-urlencoded plano,
// así que esto es un envoltorio fino sobre https nativo de Node -- no es
// una reimplementación completa del SDK, solo lo que este flujo necesita:
// crear una sesión de Checkout y verificar la firma de los webhooks.
//
// Verificación de firma de webhook: sigue el algoritmo documentado por
// Stripe (HMAC-SHA256 sobre "timestamp.payload_crudo", comparando contra
// la(s) firma(s) v1 de la cabecera Stripe-Signature). Ver
// https://docs.stripe.com/webhooks#verify-manually

'use strict';

const https = require('https');
const crypto = require('crypto');

const STRIPE_API_URL = 'api.stripe.com';
const STRIPE_API_VERSION = '2024-06-20';

function toFormUrlEncoded(obj, prefix) {
  const parts = [];
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const value = obj[key];
    const fullKey = prefix ? prefix + '[' + key + ']' : key;
    if (value == null) continue;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (typeof v === 'object') {
          parts.push(toFormUrlEncoded(v, fullKey + '[' + i + ']'));
        } else {
          parts.push(encodeURIComponent(fullKey + '[' + i + ']') + '=' + encodeURIComponent(v));
        }
      });
    } else if (typeof value === 'object') {
      parts.push(toFormUrlEncoded(value, fullKey));
    } else {
      parts.push(encodeURIComponent(fullKey) + '=' + encodeURIComponent(value));
    }
  }
  return parts.filter(Boolean).join('&');
}

function stripeRequest(urlPath, formObj) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      'Falta STRIPE_SECRET_KEY. Crea una cuenta de Stripe (modo test sirve para probar) y copia la clave secreta al .env (ver README).'
    );
  }
  const body = toFormUrlEncoded(formObj);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: STRIPE_API_URL,
        path: urlPath,
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(secretKey + ':').toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'Stripe-Version': STRIPE_API_VERSION,
        },
      },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            return reject(new Error('Respuesta no-JSON de Stripe: ' + data.slice(0, 300)));
          }
          if (res.statusCode >= 400) {
            return reject(new Error('Stripe HTTP ' + res.statusCode + ': ' + (parsed.error ? parsed.error.message : data)));
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

// Crea una sesión de Checkout. Para el modelo de precios de Valentia (cuota
// inicial + cuota mensual recurrente, ver "Plantillas por Sector" sección 3
// y "Numeros CAC-LTV.xlsx"), se combinan dos price en modo "subscription":
// un price recurrente (la cuota mensual) y un price de un solo pago con
// add_invoice_items para la cuota inicial. Los IDs de esos price se crean
// una vez en el Dashboard de Stripe (o vía API en el setup) y se pasan por
// variables de entorno -- no se crean productos al vuelo en cada compra.
async function crearSesionCheckout({ priceMensualId, priceInicialId, priceSuplementoId, successUrl, cancelUrl, clientReferenceId, metadata }) {
  const params = {
    mode: 'subscription',
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: clientReferenceId,
    line_items: [{ price: priceMensualId, quantity: 1 }],
    metadata: metadata || {},
    // Cuentas nuevas de Stripe traen "Managed Payments" activado por
    // defecto, que exige un tax_code en cada producto para poder cobrar.
    // Los precios de este proyecto no lo tienen configurado, así que se
    // desactiva explícitamente para esta sesión -- si en el futuro se
    // quiere usar Managed Payments, hay que fijar tax_code en cada
    // producto de Stripe y quitar esta línea.
    managed_payments: { enabled: false },
  };
  if (priceInicialId) {
    // La cuota inicial se cobra como line item adicional de un solo pago,
    // dentro de la misma sesión de Checkout.
    params.line_items.push({ price: priceInicialId, quantity: 1 });
  }
  if (priceSuplementoId) {
    // Suplemento de página adicional (+5€/mes) elegido ya en el alta --
    // se añade como tercer line item recurrente en la misma sesión, en
    // vez de crear una segunda suscripción (Flujo, sección 3).
    params.line_items.push({ price: priceSuplementoId, quantity: 1 });
  }
  return stripeRequest('/v1/checkout/sessions', params);
}

function verificarFirmaWebhook(payloadCrudo, signatureHeader, webhookSecret) {
  if (!webhookSecret) {
    throw new Error('Falta STRIPE_WEBHOOK_SECRET (lo da Stripe al crear el endpoint de webhook).');
  }
  if (!signatureHeader) throw new Error('Falta la cabecera Stripe-Signature.');

  const parts = Object.fromEntries(
    signatureHeader.split(',').map(kv => {
      const [k, v] = kv.split('=');
      return [k, v];
    })
  );
  const timestamp = parts.t;
  const firmaRecibida = parts.v1;
  if (!timestamp || !firmaRecibida) throw new Error('Cabecera Stripe-Signature con formato inesperado.');

  const payloadFirmado = timestamp + '.' + payloadCrudo;
  const firmaEsperada = crypto
    .createHmac('sha256', webhookSecret)
    .update(payloadFirmado, 'utf8')
    .digest('hex');

  const a = Buffer.from(firmaEsperada, 'utf8');
  const b = Buffer.from(firmaRecibida, 'utf8');
  const valida = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valida) throw new Error('Firma de webhook inválida — la petición no viene de Stripe.');

  return JSON.parse(payloadCrudo);
}

module.exports = { crearSesionCheckout, verificarFirmaWebhook, stripeRequest };
