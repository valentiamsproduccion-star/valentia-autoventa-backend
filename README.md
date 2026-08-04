# Valentia Web Autoventa — backend

Implementa de principio a fin el flujo descrito en "Flujo de Autoventa y
Panel de Cliente": alta → generación de contenido → vista previa → pago →
publicación automática, más el enlace mágico de página adicional (sección 3
de ese mismo documento).

**Probado de extremo a extremo** con `node smoketest.js`, simulando las
respuestas de Stripe, Anthropic y Supabase (no requiere claves reales para
comprobar que el flujo entero funciona). Con claves reales, funciona igual
pero con IA, pagos y base de datos de verdad.

## Por qué está escrito así

Una decisión de este código no es la que se tomaría con acceso normal a
internet y a npm, y conviene saberlo antes de tocarlo:

- **Sin Express ni SDKs de Stripe/Anthropic/Supabase.** El entorno en el que
  se escribió esto no tenía acceso al registro de npm. Todo está construido
  sobre módulos nativos de Node (`http`, `https`, `crypto`, `fs`) — funciona
  igual, pero si en tu máquina sí tienes npm, nada te impide sustituir
  `src/lib/router.js` por Express o `src/services/stripe.js` por el SDK
  oficial; el resto del código no depende de cómo estén hechos por dentro.

La base de datos (`src/db/db.js`) empezó como un archivo JSON local, pero se
sustituyó por Supabase (Postgres real) porque el disco del plan gratuito de
Render es efímero y se comprobó en pruebas reales que se podían perder
pedidos pagados al reiniciarse el contenedor. Ver "Base de datos (Supabase)"
más abajo.

## Puesta en marcha (modo prueba, sin gastar dinero real)

```bash
cd autoventa
node smoketest.js
```

Esto simula Stripe, Anthropic y Supabase, y ejercita el flujo completo (alta
→ vista previa → checkout → webhook → publicación → enlace mágico → compra
del suplemento). Si termina con "✔ TODO EL FLUJO END-TO-END FUNCIONA
CORRECTAMENTE", el código está sano.

## Puesta en marcha real (con Stripe, Anthropic y Supabase de verdad)

Esto es lo único que **solo tú puedes hacer** — crear cuentas y claves no es
algo que se pueda automatizar por seguridad:

1. **Anthropic**: crea una cuenta en https://console.anthropic.com, genera
   una clave y ponla en `ANTHROPIC_API_KEY` (copia `.env.example` a `.env`
   primero).
2. **Stripe**: crea una cuenta en https://dashboard.stripe.com (el modo
   test no mueve dinero real y sirve para probar todo el flujo). En
   Productos, crea:
   - Un producto con un Price recurrente mensual → `STRIPE_PRICE_MENSUAL`
   - Un producto con un Price de pago único (la cuota inicial) →
     `STRIPE_PRICE_INICIAL`
   - Un producto con un Price recurrente de 5€/mes (el suplemento de
     página adicional, ver "Plantillas por Sector" sección 3) →
     `STRIPE_PRICE_SUPLEMENTO_PAGINA`
   - Un producto con un Price de pago único de 15€ (logo diseñado por IA,
     casilla del formulario de alta cuando el cliente no tiene logo propio)
     → `STRIPE_PRICE_LOGO_IA`
   - En Desarrolladores → Webhooks, añade un endpoint apuntando a
     `https://TU-DOMINIO/api/webhook/stripe`, evento
     `checkout.session.completed`, y copia el "Signing secret" a
     `STRIPE_WEBHOOK_SECRET`.
3. **Supabase**: ver "Base de datos (Supabase)" más abajo.
4. **Resend**: ver "Email (Resend)" más abajo.
5. **Hosting**: elige dónde vive este backend (ver siguiente sección —
   importante, Hostinger no vale para esto).
6. Arranca con `node src/server.js` (o `npm start` si añades ese script).

## Base de datos (Supabase)

1. Crea una cuenta gratuita en https://supabase.com (no pide tarjeta) y un
   proyecto nuevo (elige la región más cercana, p. ej. `eu-west-1`).
2. En el proyecto, ve a **SQL Editor** → **New query**, pega esto y
   ejecútalo (crea la única tabla que usa este backend):

   ```sql
   create table kv_store (
     collection text not null,
     id text not null,
     data jsonb not null,
     created_at timestamptz default now(),
     updated_at timestamptz,
     primary key (collection, id)
   );
   ```

   No hace falta configurar Row Level Security: el backend usa la clave
   `service_role`, que la salta por diseño (igual de sensible que
   `STRIPE_SECRET_KEY` — solo va en variables de entorno del servidor).
3. Ve a **Project Settings → API** y copia:
   - **Project URL** → `SUPABASE_URL`
   - **service_role secret** (no la `anon` / `public`) → `SUPABASE_SERVICE_KEY`
4. Ponlas en `.env` (desarrollo local) o en las variables de entorno de
   Render (producción).
5. **Logo y favicon del cliente** (`src/services/supabase.js`,
   `uploadStorageFile`): ve a **Storage** → **New bucket**, créalo con el
   nombre `logos` (o el que pongas en `SUPABASE_STORAGE_BUCKET`) y marca la
   opción **Public bucket** — si no es público, las imágenes no se podrán
   ver en la web publicada del cliente. No hace falta ninguna tabla nueva:
   los archivos se guardan como objetos normales del bucket, bajo una
   carpeta por cliente (`{client_id}/logo-1.png`, etc.).
6. **Fotos del negocio** (mismo mecanismo, bucket aparte): en el formulario
   de alta, cada sector pide además sus propias fotos (hero, foto
   secundaria, galería, y una foto por tarjeta de equipo/productos/proyectos/
   actividades/alojamientos según el sector — ver `public/alta.html`,
   `SECTORES[...].fotos` y los campos con `photo:true`). Crea otro bucket
   **público** llamado `fotos` (o el nombre que pongas en
   `SUPABASE_FOTOS_BUCKET`) igual que el de `logos`. Si un cliente no sube
   alguna foto, la web se publica igual con el hueco de "Foto" de siempre
   hasta que la envíe.

## Email (Resend)

Envía el enlace mágico permanente (`/mi-pagina/:token`) al cliente justo
después de su primer pago (`src/server.js`, webhook de Stripe → `src/services/email.js`).

1. Crea una cuenta gratuita en https://resend.com (100 emails/día, 3.000/mes
   gratis — de sobra para este volumen).
2. En **API Keys**, crea una clave y ponla en `RESEND_API_KEY`.
3. Sin verificar un dominio propio, Resend solo deja enviar al email con el
   que te registraste — vale para probar, no para clientes reales. Para
   enviar a cualquier cliente:
   - En **Domains**, añade `valentiams.com` (o el dominio que prefieras).
   - Resend te da 3-4 registros DNS (SPF, DKIM, y opcionalmente un
     `MX`/`CNAME` de tracking) — añádelos en el mismo sitio donde ya
     configuraste el `CNAME` de `autoventa.valentiams.com` (ver "Configurar
     registro DNS", tarea ya resuelta para el subdominio).
   - Cuando Resend marque el dominio como verificado (puede tardar hasta
     unas horas por la propagación DNS), cambia `EMAIL_FROM` a algo del
     estilo `Valentia <no-reply@valentiams.com>`.
4. Si `RESEND_API_KEY` falta o el envío falla, el webhook no se rompe: la
   web se publica igual y el enlace queda guardado en Supabase, solo que no
   se envía por email (se registra el error en los logs de Render).
5. **Logo con IA**: pon tu email (o el del equipo) en `ADMIN_EMAIL` para
   recibir un aviso cuando un cliente pague la casilla "Quiero que la IA me
   diseñe un logo" (+15€) — este MVP no genera el logo automáticamente
   (haría falta un servicio de generación de imágenes aparte), así que el
   aviso es para diseñarlo y subirlo manualmente. Sin `ADMIN_EMAIL`, el
   aviso solo queda en los logs de Render.

## Dominio propio (Openprovider + Render)

El cliente puede comprar un dominio propio (p. ej. `tunegocio.es`) en el
alta (`public/alta.html`, sección "Tu dominio"). Tras el pago, el webhook de
Stripe lo compra y lo conecta automáticamente (`src/server.js`,
`comprarDominioParaCliente()`), usando dos servicios:

- `src/services/openprovider.js` — comprueba disponibilidad, da de alta al
  cliente como titular real del dominio (con sus propios datos fiscales, ya
  recogidos en el alta) y lo registra.
- `src/services/renderDominios.js` — añade el dominio como "custom domain"
  de este mismo servicio de Render (así que la web del cliente se sirve en
  su propio dominio, no solo en `/sites/:slug` — ver `esHostPropio()` /
  `serviceCustomDomainSiAplica()` en `src/server.js`).

Si `OPENPROVIDER_USER`/`OPENPROVIDER_PASSWORD` o `RENDER_API_KEY`/
`RENDER_SERVICE_ID` faltan, esta parte queda desactivada sin más: el alta,
el pago y la publicación en `/sites/:slug` siguen funcionando exactamente
igual, solo que sin dominio propio.

1. **Para probar sin gastar nada**: date de alta en el Sandbox de
   Openprovider (`cp.sandbox.openprovider.nl/signup`, cuenta gratuita y
   separada de la real, sin necesidad de Membership Plan ni saldo) y pon
   esas credenciales en `OPENPROVIDER_USER`/`OPENPROVIDER_PASSWORD`, con
   `OPENPROVIDER_API_HOST=api.sandbox.openprovider.nl`.
2. **Para vender de verdad**: da de alta la cuenta de producción
   (`cp.openprovider.eu`), activa un Membership Plan (a partir de 49,99€/año,
   100 dominios) y carga saldo — u opcionalmente activa "Recurring Payments"
   (Account → Financial) para que el saldo se recargue solo. Cambia
   `OPENPROVIDER_API_HOST=api.openprovider.eu`.
3. En Render, genera una API key (Account Settings → API Keys) para
   `RENDER_API_KEY`, y copia el id del servicio (empieza por `srv-`, está en
   la URL del dashboard) para `RENDER_SERVICE_ID`.
4. TLDs vendibles: solo `.es .com .net .org .eu` (`TLDS_PERMITIDOS` en
   `openprovider.js` — mantener en sync con la lista de `alta.html`). Se
   limita a extensiones baratas y predecibles para que la renovación quepa
   sin sorpresas dentro de la cuota mensual de 19€ — la renovación se deja
   en `autorenew: 'off'`, la decide Valentia a mano/por script propio.
5. **Coste a tener en cuenta**: cada dominio de cliente es un "custom
   domain" adicional en el mismo servicio de Render — los planes incluyen un
   número limitado (Hobby: 2, Pro: 15, Scale: 25) y luego Render cobra
   $0,25/mes por dominio de más. Con unos pocos clientes no importa; a partir
   de cierto volumen hay que revisar el plan de Render o repartir clientes
   en varios servicios.

## Elegir hosting — importante

**El hosting compartido de Hostinger donde viven hoy las plantillas
estáticas no puede ejecutar este backend.** Es hosting de solo archivos
(PHP/HTML), sin proceso Node persistente ni webhooks entrantes. Este
backend necesita un sitio que ejecute Node de forma continua — por ejemplo
Railway, Render, Fly.io o un VPS. Esta es una decisión de la reunión técnica
pendiente (ver "Preguntas para la Parte Técnica", sección 2) — aquí solo se
deja constancia de que hace falta tomarla, no se elige por vosotras.

## Qué falta por decidir (no está resuelto a propósito)

Todo esto está señalado con comentarios `PUNTO DE EXTENSIÓN` o `TODO` en el
código, en el sitio exacto donde hay que engancharlo:

- **Dominio propio del cliente**: resuelto, ver "Dominio propio (Openprovider
  + Render)" más arriba.
- **SSL, GA4, Search Console, sitemap.xml, robots.txt por cliente**: SSL se
  emite solo en cuanto Render verifica el DNS del dominio propio (parte de
  lo de arriba); GA4/Search Console/sitemap/robots por cliente individual
  siguen sin resolver — no hace falta para el MVP, cada web publicada ya
  lleva su propio `<title>`/meta tags básicos.
- **Envío del enlace mágico por email**: resuelto, ver "Email (Resend)" más
  arriba. Solo falta que verifiques tu propio dominio en Resend cuando
  quieras enviar a clientes reales (mientras tanto, `RESEND_API_KEY` sin
  dominio verificado solo entrega al email de tu cuenta Resend).
- **Generación real del logo con IA** (`src/services/email.js`,
  `sendLogoIaSolicitadoEmail`). El formulario de alta ya cobra los 15€ y
  avisa por email cuando un cliente lo pide, pero el logo en sí lo diseña
  el equipo a mano (no hay integración con un generador de imágenes) — es
  un punto de extensión a futuro si el volumen lo justifica. Mientras tanto
  la web del cliente muestra un avatar de iniciales hasta que se le suba
  el logo definitivo (mismo campo `logo_url` que si el cliente hubiera
  subido uno propio).

## Antes de producción

- **Revisar límites y validación de entrada** más allá de los caracteres
  (`src/services/validate.js`) — por ejemplo, sanear el campo `precio` de
  la carta o el formato del teléfono.
- **Rate limiting** en `/api/alta` y `/api/mi-pagina/:token` — no hay
  ninguno implementado todavía.
- **Backups de Supabase** una vez haya clientes reales (Supabase hace
  backups automáticos incluso en el plan gratuito, pero conviene revisar la
  retención antes de depender de ellos).
- El plan gratuito de Supabase pausa el proyecto (no borra los datos, pero
  deja de responder peticiones) tras 7 días sin actividad — hay que
  reactivarlo a mano desde el panel de Supabase, o programar un ping
  periódico (p. ej. un cron cada pocos días) para que nunca llegue a
  pausarse. Con tráfico real esto no debería pasar nunca; solo importa si el
  proyecto queda inactivo mucho tiempo.

## Estructura

```
autoventa/
  src/
    server.js              punto de entrada, todas las rutas
    lib/
      router.js             router mínimo sobre http nativo
      mustache.js            motor de plantillas mínimo (sin dependencias)
    db/
      db.js                  funciones de datos (clients/orders/pages/tokens), sobre Supabase
    services/
      render.js              junta datos base + contenido -> HTML final
      ai.js                  llama a la API de Anthropic (generar / mejorar)
      stripe.js               llama a la API de Stripe (checkout, webhooks)
      supabase.js              llama a la REST API de Supabase (Postgres)
      validate.js             valida límites de caracteres (vía "propio")
      publish.js               genera el HTML final y lo guarda vía db.js
    prompts/
      index.js                los 3 prompts, iguales a "Prompts de Redacción IA"
    templates/
      *.mustache               las 3 plantillas de sector, con marcadores {{campo}}
  public/
    alta.html                 formulario de alta (vía IA completa, vía propio simplificada)
    mi-pagina.html             mini-formulario del enlace mágico
  smoketest.js                 prueba end-to-end con red simulada
  .env.example
```

## Documentos de referencia de este proyecto

Todo el diseño que hay detrás de este código está en los documentos ya
entregados en la carpeta del proyecto:

- Flujo de Autoventa y Panel de Cliente (el flujo completo, paso a paso)
- Prompts de Redacción IA (los 3 prompts, verbatim en `src/prompts/index.js`)
- Formulario de Alta — Sectores MVP (el diseño campo a campo de referencia)
- Preguntas para la Parte Técnica (lo que falta decidir antes de producción)
- Plantillas por Sector (el modelo de precios: cuota inicial + mensual +
  suplemento de página adicional)
