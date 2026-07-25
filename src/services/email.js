// Envío de email transaccional con Resend, sin el SDK oficial (no hay acceso
// a npm en este entorno de desarrollo). La API de Resend es JSON plano sobre
// HTTPS, así que esto es un envoltorio fino sobre https nativo de Node --
// mismo estilo que stripe.js y supabase.js.
//
// Uso único en este MVP: enviar el enlace mágico permanente de "mi página"
// al cliente justo después de su primer pago (ver server.js, webhook de
// Stripe, y "Flujo de Autoventa y Panel de Cliente", sección 3).

'use strict';

const https = require('https');

const RESEND_API_URL = 'api.resend.com';

function postJSON(urlPath, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = https.request(
      {
        hostname: RESEND_API_URL,
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
            parsed = data ? JSON.parse(data) : {};
          } catch (e) {
            return reject(new Error('Respuesta no-JSON de Resend: ' + data.slice(0, 300)));
          }
          if (res.statusCode >= 400) {
            return reject(new Error('HTTP ' + res.statusCode + ' de Resend: ' + JSON.stringify(parsed)));
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

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// client: registro de db.createClient (nombre_negocio, email, ...).
// urlPrincipal: URL absoluta de la web ya publicada.
// urlMiPagina: URL absoluta del enlace mágico permanente (/mi-pagina/:token).
async function sendMagicLinkEmail(client, urlPrincipal, urlMiPagina) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Falta RESEND_API_KEY. Crea una cuenta gratuita en https://resend.com, verifica el dominio y pon la clave en el .env (ver README).'
    );
  }
  const from = process.env.EMAIL_FROM || 'Valentia <onboarding@resend.dev>';
  const nombre = client.nombre_negocio || 'tu negocio';

  const html = `
    <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
      <p>Hola,</p>
      <p>Tu web para <strong>${escapeHtml(nombre)}</strong> ya está publicada:</p>
      <p><a href="${urlPrincipal}" style="color: #1a56db;">${urlPrincipal}</a></p>
      <p>Guarda este enlace: te permite añadir en cualquier momento una página
      adicional a tu web (o revisarla si ya la contrataste), sin necesidad de
      usuario ni contraseña.</p>
      <p><a href="${urlMiPagina}" style="color: #1a56db;">${urlMiPagina}</a></p>
      <p style="color: #6b7280; font-size: 13px;">Si no reconoces este correo, puedes ignorarlo.</p>
    </div>
  `.trim();

  return postJSON(
    '/emails',
    { Authorization: 'Bearer ' + apiKey },
    {
      from,
      to: [client.email],
      subject: 'Tu web ya está publicada — ' + nombre,
      html,
    }
  );
}

module.exports = { sendMagicLinkEmail };
