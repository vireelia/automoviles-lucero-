# Automóviles Lucero — Backend

Backend único (Node.js + TypeScript, Express) que da servicio a un concesionario de coches: agente de IA conversacional ("Miguel") por voz (Retell), WhatsApp, Facebook Messenger, email y chat web, además de un CRM propio server-rendered y un "Studio" de generación de imagen/vídeo con IA.

## Stack

- Node 22, TypeScript (ESM, `NodeNext`), Express.
- Sin framework de frontend: el CRM y el panel son HTML generado en servidor.
- Persistencia: colecciones JSON planas en disco (`src/store.ts`), bajo `DATA_DIR` (default `./data`), escritura atómica. Es deliberadamente provisional, no una base de datos definitiva.
- Scripts: `npm run dev` (tsx watch), `npm run build` (tsc → `dist/`), `npm start`.
- Docker: build multi-stage, expone el puerto `80` (`PORT=80`), monta `/app/data` como volumen (si no, cada redeploy borraría leads/citas).

## Arquitectura general

`src/server.ts` es el punto de entrada. Monta:

- **Tools de IA** (`/tools/*`): funciones invocables por el agente, usadas tanto por Retell (voz) como por el chat propio (`chat/dispatch.ts`). Todas responden con un `envelope()` uniforme (`status`, `request_id`, `data`, `source`, `source_updated_at`, `conflicts`, `error_code`) para que el LLM nunca reciba un "ok" vacío sin saber de dónde viene el dato. El middleware `route()` además registra cada llamada en `tool_call_logs` y **siempre devuelve 200** (incluso en error) porque Retell no tolera fallos HTTP.
- **CRM** (`/crm/*`, en `src/crm/app.ts`): interfaz humana para el equipo (Ramón/José) — citas, reservas, pendientes/handoffs, fichas de cliente, overrides de precio de coches, gestión de equipo, integraciones (Google/email/teléfono), papelera, y el Studio de IA. Auth propia por cookie de sesión (`src/crm/auth.ts`), roles `admin`/`comercial`/`equipo`.
- **Canales**: WhatsApp Cloud API, Facebook Messenger (Graph API + verificación de firma), teléfono (Twilio, deriva a Retell SIP o a móviles humanos), email (poller de Gmail cada 3 min + agente de respuesta).
- **Chat propio** (`src/chat/agent.ts`): agente que usa la API de OpenAI Chat Completions (u otro endpoint compatible vía `LLM_BASE_URL`), con bucle de tool-calling (`tool-schemas.json` + `dispatch.ts`), usado por WhatsApp/Facebook/email/chat web (Retell tiene su propio LLM gestionado aparte, sincronizado por `scripts/sync-retell.mjs`).
- **Studio** (`src/studio/*`): generación de imagen/vídeo vía Higgsfield, con presupuesto y concurrencia limitados, sólo accesible por `admin` desde el CRM.
- **Panel** (`src/panel.ts`): vista HTML de solo lectura con Basic Auth para el equipo.
- **Scheduler/alerts**: recordatorios de cita, seguimientos automáticos de leads, alertas urgentes deduplicadas por email.

## Convenciones del dominio (importantes para no romper nada)

- **Nunca inventar datos**: todo dato de negocio (horarios, precios, contacto) lleva `validation_status` (`owner_confirmed`/`unconfirmed`) en `src/data/business-info.ts` y `vehicles-seed.ts`/`vehicles-current.ts`. El agente de IA está instruido (prompts en `src/data/prompt-*.md`) para no afirmar como hecho lo no confirmado.
- **Acciones administrativas sensibles** (`confirm_reservation`, `cancel_reservation`, `purge_leads_except`, `merge_leads`, `sync_inventory`, Studio) requieren `ADMIN_TOKEN` o sesión CRM de rol `admin`; nunca están expuestas al agente de voz/chat.
- **`src/data/vehicles-seed.ts` se regenera con `scripts/import-dealcar.mjs`**, no se edita a mano.
- **`.retell-state.json`** guarda los IDs de LLM/Agente de voz y chat en Retell; lo actualiza `scripts/sync-retell.mjs`, no se toca a mano.
- El inventario real de coches viene de un feed externo (Coches.net PRO / Dealcar); `vehicle-state.ts` mantiene un estado propio (`AVAILABLE`/`RESERVATION_PENDING`/`RESERVED`/`SOLD`) independiente del feed.

## Variables de entorno

| Variable | Uso |
|---|---|
| `DATA_DIR` | Carpeta de almacenamiento JSON |
| `PORT` | Puerto del servidor (Docker usa 80) |
| `ADMIN_TOKEN` | Header `x-admin-token` para rutas admin y password del panel |
| `OPENAI_API_KEY`, `LLM_BASE_URL`, `LUCERO_CHAT_MODEL` | LLM del chat propio (WhatsApp/Facebook/email/chat) |
| `RETELL_API_KEY` | Agente de voz gestionado (webhook + script de sync) |
| `FACEBOOK_WEBHOOK_VERIFY_TOKEN`, `FACEBOOK_APP_SECRET`, `FACEBOOK_PAGE_ACCESS_TOKEN` | Messenger |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Cloud API |
| `TWILIO_AUTH_TOKEN`, `TWILIO_VOICE_WEBHOOK_URL` | Telefonía |
| `TWILIO_ACCOUNT_SID`, `TWILIO_VOICE_FROM_NUMBER` | Llamada saliente de aviso urgente al equipo (`callUrgentAlert`, `integrations/twilio-voice.ts`) -- `TWILIO_VOICE_FROM_NUMBER` es el número real de Twilio que hace la llamada (el mismo de voz entrante, `+34 919 58 88 87`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | OAuth Gmail + Calendar |
| `N8N_VOZ_WEBHOOK_URL` | Reenvío de análisis de llamadas de voz |
| `CRM_ADMIN_EMAIL`, `CRM_ADMIN_PASSWORD`, `CRM_FORCE_ADMIN_RESET` | Bootstrap del admin del CRM |
| `GMAIL_DAILY_SEND_CAP` | Tope diario de envíos de email automáticos |
| `ALERT_EMAILS` | Destinatarios extra de alertas urgentes |
| `HIGGSFIELD_API_KEY_ID`, `HIGGSFIELD_API_KEY_SECRET`, `HIGGSFIELD_MONTHLY_BUDGET_EUR`, `HIGGSFIELD_MAX_CONCURRENT`, `PUBLIC_BASE_URL` | Studio de generación de imagen/vídeo |
| `ZERNIO_API_KEY` | Zernio: publicación en redes + WhatsApp (ver abajo) |
| `ZERNIO_PROFILE_ID` | Workspace de Zernio, necesario para el Embedded Signup de WhatsApp |
| `ZERNIO_WHATSAPP_ACCOUNT_ID` | Cuenta de WhatsApp conectada en Zernio; si está puesta, WhatsApp usa Zernio en vez de la Cloud API directa de Meta |
| `ZERNIO_WEBHOOK_SECRET` | Secreto para verificar la firma del webhook de Zernio (`X-Zernio-Signature`) |

## Integración con Zernio

[Zernio](https://zernio.com) es una API para programar publicaciones y mensajería unificada en redes sociales (Facebook, Instagram, WhatsApp, X, LinkedIn, etc.) y gestionar anuncios. Cliente en `src/integrations/zernio.ts` (`@zernio/node`), configurado sólo por variables de entorno (nunca credenciales hardcodeadas). Dos usos reales en este proyecto:

### 1. Publicar contenido del Studio en redes

Publica automáticamente el contenido de imagen/vídeo que genera el **Studio** (Higgsfield) en las redes del concesionario, sin salir del CRM.

- Sólo necesita `ZERNIO_API_KEY`.
- Botón "📣 Publicar en redes" en cada resultado completado de `/crm/studio` (rol `admin`), que llama a `POST /crm/studio/publicar`.
- **No** se expone como tool del agente de voz/chat.

### 2. WhatsApp Business sin verificación de negocio de Meta

`src/integrations/whatsapp.ts` (`isWhatsappConnected`/`sendWhatsappText`, usado por todas las tools de envío en `tools/delivery.ts` y por los canales en `server.ts`) elige backend automáticamente:

- Si `ZERNIO_API_KEY` + `ZERNIO_WHATSAPP_ACCOUNT_ID` están puestos → usa Zernio (Embedded Signup, sin el proceso de verificación de negocio de Meta ni revisión de app).
- Si no, y están `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID` → usa la WhatsApp Cloud API directa de Meta (integración original, Fase 1).

Piezas:
- **Conectar el número**: `/crm/integraciones` → caja "WhatsApp -- vía Zernio" → botón que abre el Embedded Signup. Al volver, Zernio da un `accountId` que hay que copiar a `ZERNIO_WHATSAPP_ACCOUNT_ID` (variable de entorno, no hay sitio en disco para guardarlo) y redesplegar.
- **Webhook de mensajes entrantes**: `POST /webhooks/zernio-whatsapp` — hay que darle esta URL a Zernio (panel de webhooks) suscrita al evento `message.received`, con un secreto que va también en `ZERNIO_WEBHOOK_SECRET`. Verifica la firma HMAC-SHA256 sobre el cuerpo crudo, guarda qué `conversationId` corresponde a cada teléfono (`zernio_whatsapp_conversations`, en `zernio.ts`) y responde con el mismo agente de chat (`handleChatMessage`) que WhatsApp directo/Facebook/email.
- **Limitación real de WhatsApp (de Meta, no de Zernio)**: sólo se puede responder con texto libre dentro de las 24h desde el último mensaje del cliente, y sólo si ya hay una conversación conocida (el cliente escribió primero). Para iniciar una conversación nueva haría falta una plantilla aprobada por Meta — no implementado, por ahora `sendZernioWhatsappText` devuelve error controlado (`sin_conversacion_abierta`) en ese caso, nunca finge un envío.
- **El número de WhatsApp del negocio ES el número personal de Ramón, cuenta en modo "Coexistence" con la app real de WhatsApp Business** (confirmado 22/10/2026 vía `zernio.accounts.listAccounts` → `metadata.isCoexistence: true`). Esto significa que **avisar a Ramón por WhatsApp desde ese mismo número nunca puede funcionar** -- sería su propia cuenta enviándose un mensaje a sí misma, no es un problema de plantilla pendiente ni de ventana de 24h. Por eso `notifyTeam` (`tools/team-notify.ts`) llama por voz (`integrations/twilio-voice.ts`, `callUrgentAlert`) cuando el WhatsApp falla en un aviso urgente de verdad (`URGENT_ALERT_KINDS`) -- la llamada no depende de ninguna cuenta ni ventana. Para José (contacto externo real a esa cuenta) la plantilla/ventana de 24h sigue siendo la vía correcta.

## Comandos útiles

```bash
npm run dev     # desarrollo con recarga (tsx watch)
npm run build   # compila a dist/
npm start        # producción (requiere build previo)
node scripts/import-dealcar.mjs <export.xml>   # regenera vehicles-seed.ts
node scripts/sync-retell.mjs                   # sincroniza prompts/tools con Retell
```
