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
   - En Desarrolladores → Webhooks, añade un endpoint apuntando a
     `https://TU-DOMINIO/api/webhook/stripe`, evento
     `checkout.session.completed`, y copia el "Signing secret" a
     `STRIPE_WEBHOOK_SECRET`.
3. **Supabase**: ver "Base de datos (Supabase)" más abajo.
4. **Hosting**: elige dónde vive este backend (ver siguiente sección —
   importante, Hostinger no vale para esto).
5. Arranca con `node src/server.js` (o `npm start` si añades ese script).

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

- **Publicación del dominio/subdominio real, SSL, GA4, Search Console,
  sitemap.xml, robots.txt** (`src/services/publish.js`). Ahora mismo el
  servicio genera el HTML final y lo guarda en Supabase, servido desde
  `/sites/:slug` en este mismo backend — no lo sube a un hosting aparte ni
  activa un dominio propio del cliente, porque eso depende del proveedor
  que se decida en la reunión técnica.
- **Envío del enlace mágico por email** (`src/server.js`, dentro del
  webhook). El enlace se genera correctamente y queda en la base de datos,
  pero no hay proveedor de email configurado para enviarlo automáticamente.
- **Formulario campo a campo completo.** `public/alta.html` implementa la
  vía "IA desde cero" con el patrón de repetidores ya validado (tarjetas
  apilables + acordeón de categorías para la carta), y simplifica la vía
  "propio"/"mejora IA" a un campo de JSON en bruto, para no duplicar en
  código un diseño que ya está completamente especificado en "Formulario de
  Alta — Sectores MVP". El HTML/CSS de ese documento es la referencia para
  construir el formulario definitivo campo a campo.

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
