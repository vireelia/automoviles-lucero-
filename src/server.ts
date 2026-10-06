import express from "express";
import cors from "cors";
import { getBusinessInfo } from "./tools/business.js";
import { searchVehicles, getVehicle, getVehicleStatus, findSimilarVehicles, syncInventory } from "./tools/vehicles.js";
import { upsertLead, updateContactPreferences, getCustomerHistory, scoreLead, createFollowup, stopFollowups } from "./tools/leads.js";
import { createPurchaseRequest, createServiceRequest, createHandoff, createVehicleValuation } from "./tools/requests.js";
import { getAppointmentSlots, createAppointmentWithCalendar, updateAppointment, cancelAppointment } from "./tools/appointments.js";
import { sendInternalSummary, sendVehicleLink, sendLocation, sendWhatsapp, notifySalesperson, saveConversation, createConversationSummary } from "./tools/delivery.js";
import { createReservationPending, submitPaymentReceipt, confirmReservation, cancelReservation } from "./tools/reservations.js";
import { requestFinancing } from "./tools/financing.js";
import { handleRetellWebhook } from "./tools/webhooks.js";
import { verifyRetellSignature } from "./integrations/retell-signature.js";
import { forwardVoiceAnalysis } from "./integrations/n8n.js";
import { renderPanel } from "./panel.js";
import { startScheduler } from "./scheduler.js";
import { appendToCollection, readCollection } from "./store.js";
import { createAuthUrl, consumeState, exchangeCodeAndStore, googleStatus, describeGoogleError } from "./integrations/google.js";
import { handleChatMessage, LlmNotConfigured } from "./chat/agent.js";
import { processInboundEmail } from "./email/agent.js";
import { startEmailPoller } from "./email/poller.js";
import { crm } from "./crm/app.js";
import { bootstrapAdmin } from "./crm/auth.js";
import { startDailySummary } from "./crm/daily.js";

const app = express();
app.use(cors());
// Guardamos el cuerpo sin procesar: la firma de Retell se calcula sobre esos bytes exactos.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
    },
  }),
);

// BUG REAL encontrado 30/09/2026 en producción: el comentario de abajo
// decía que Retell manda los argumentos sueltos en la raíz del body -- FALSO.
// Por defecto Retell envuelve cada llamada de tool como
// {"name": "...", "args": {...}, "call": {...}} (ver documentación real de
// custom-function), así que todas las tools estaban leyendo un objeto vacío
// como argumentos desde que se desplegaron -- por eso search_vehicle nunca
// filtraba de verdad (devolvía siempre las 38 unidades sin filtrar, y solo
// "acertaba" cuando el resultado correcto caía entre los primeros del orden
// natural del catálogo). Verificado en vivo: mismo make/model exacto vía
// curl directo SÍ filtraba (1 resultado), vía Retell daba 38 -- la única
// diferencia real era este envoltorio. Se acepta cualquiera de las dos
// formas (envuelta o plana) para no depender de que Retell no cambie el
// comportamiento por defecto, y para que las llamadas directas (admin,
// scripts de prueba) sigan funcionando igual que antes.
// Logging de auditoría por tool call (Sección "LOGS PARA PRUEBAS" del
// endurecimiento de seguridad, 01/10/2026): cada invocación real de una
// tool queda registrada -- timestamp, nombre de la tool, argumentos de
// entrada, resultado y latencia -- para poder revisar después exactamente
// qué pasó en una llamada/chat real sin depender de leer el transcript a
// mano. No es telemetría de producto, es trazabilidad para pruebas.
function route(fn: (args: any) => unknown) {
  return async (req: express.Request, res: express.Response) => {
    const startedAt = Date.now();
    const toolName = req.path.replace(/^\/tools\//, "");
    try {
      const body = req.body ?? {};
      const args = body && typeof body === "object" && "args" in body && body.args && typeof body.args === "object" ? body.args : body;
      const result = await fn(args);
      appendToCollection("tool_call_logs", {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        tool: toolName,
        input: args,
        result,
        latency_ms: Date.now() - startedAt,
      });
      res.json(result);
    } catch (err) {
      const errorResult = {
        status: "error",
        request_id: crypto.randomUUID(),
        data: null,
        error_code: err instanceof Error ? err.message : "unknown_error",
      };
      appendToCollection("tool_call_logs", {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        tool: toolName,
        input: req.body,
        result: errorResult,
        latency_ms: Date.now() - startedAt,
      });
      res.status(200).json(errorResult);
    }
  };
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// -- Tools expuestas a los agentes de voz/chat de Retell (Sección 43) --
app.post("/tools/get_business_info", route(() => getBusinessInfo()));
app.post("/tools/search_vehicles", route((a) => searchVehicles(a)));
// Alias con el nombre exacto de la Sección 43 de la especificación maestra
// (search_vehicle, create_lead, update_lead) -- mismo backend, sin duplicar
// lógica, solo para que el nombre de tool declarado a Retell coincida con
// el encargo confirmado.
app.post("/tools/search_vehicle", route((a) => searchVehicles(a)));
// Si la petición viene de una llamada de Retell (trae `call`) y el agente no ha
// indicado canal, el lead entra marcado como VOZ.
function markVoiceOrigin(req: express.Request, _res: express.Response, next: express.NextFunction) {
  const body = req.body ?? {};
  if (body.call && body.args && typeof body.args === "object" && !body.args.channel) {
    body.args.channel = "VOICE";
  }
  next();
}
app.post("/tools/create_lead", markVoiceOrigin, route((a) => upsertLead(a)));
app.post("/tools/update_lead", markVoiceOrigin, route((a) => upsertLead(a)));
app.post("/tools/get_vehicle", route((a) => getVehicle(a)));
app.post("/tools/get_vehicle_status", route((a) => getVehicleStatus(a)));
app.post("/tools/find_similar_vehicles", route((a) => findSimilarVehicles(a)));
app.post("/tools/upsert_lead", requireAdminToken, route((a) => upsertLead(a)));
app.post("/tools/update_contact_preferences", route((a) => updateContactPreferences(a)));
app.post("/tools/get_customer_history", route((a) => getCustomerHistory(a)));
app.post("/tools/score_lead", route((a) => scoreLead(a)));
app.post("/tools/create_followup", route((a) => createFollowup(a)));
app.post("/tools/stop_followups", route((a) => stopFollowups(a)));
app.post("/tools/create_purchase_request", requireAdminToken, route((a) => createPurchaseRequest(a)));
app.post("/tools/create_vehicle_valuation", route((a) => createVehicleValuation(a)));
app.post("/tools/create_service_request", route((a) => createServiceRequest(a)));
app.post("/tools/create_handoff", route((a) => createHandoff(a)));
app.post("/tools/get_appointment_slots", route(() => getAppointmentSlots()));
app.post("/tools/create_appointment", route((a) => createAppointmentWithCalendar(a)));
app.post("/tools/update_appointment", route((a) => updateAppointment(a)));
app.post("/tools/cancel_appointment", route((a) => cancelAppointment(a)));
app.post("/tools/create_reservation_pending", requireAdminToken, route((a) => createReservationPending(a)));
app.post("/tools/submit_payment_receipt", requireAdminToken, route((a) => submitPaymentReceipt(a)));
app.post("/tools/request_financing", route((a) => requestFinancing(a)));
app.post("/tools/send_internal_summary", requireAdminToken, route((a) => sendInternalSummary(a)));
app.post("/tools/send_vehicle_link", route((a) => sendVehicleLink(a)));
app.post("/tools/send_location", route(() => sendLocation()));
app.post("/tools/send_whatsapp", route((a) => sendWhatsapp(a)));
app.post("/tools/notify_salesperson", route((a) => notifySalesperson(a)));
app.post("/tools/save_conversation", route((a) => saveConversation(a)));
app.post("/tools/create_conversation_summary", route((a) => createConversationSummary(a)));
app.post("/tools/sync_inventory", requireAdminToken, route(() => syncInventory()));

// -- Rutas administrativas: SOLO para el equipo humano (Ramón/José/Virelia),
// nunca declaradas como tool de Retell. confirm/cancel de una reserva
// requieren validación humana real del pago (Sección 26) -- por eso no
// están al alcance del agente. Protegidas por un token simple compartido.
function requireAdminToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.header("x-admin-token");
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
app.post("/admin/confirm_reservation", requireAdminToken, route((a) => confirmReservation(a)));
app.post("/admin/cancel_reservation", requireAdminToken, route((a) => cancelReservation(a)));

// CRM sencillo para el equipo del concesionario.
bootstrapAdmin();
app.use("/crm", crm);

// Correo: entrada manual o desde n8n. El sondeo de Gmail usa la misma función.
app.post("/email/inbound", requireAdminToken, async (req, res) => {
  const b = req.body ?? {};
  if (typeof b.from !== "string" || typeof b.text !== "string" || !b.from.includes("@")) {
    res.status(400).json({ error: "bad_request" });
    return;
  }
  try {
    const result = await processInboundEmail({
      messageKey: typeof b.message_id === "string" ? b.message_id : crypto.randomUUID(),
      from: b.from.trim().toLowerCase(),
      fromName: typeof b.from_name === "string" ? b.from_name : "",
      subject: typeof b.subject === "string" ? b.subject : "",
      text: b.text.slice(0, 4000),
      threadId: typeof b.thread_id === "string" ? b.thread_id : undefined,
      inReplyTo: typeof b.in_reply_to === "string" ? b.in_reply_to : undefined,
      automated: Boolean(b.automated),
    });
    res.json(result);
  } catch (err) {
    if (err instanceof LlmNotConfigured) {
      res.status(503).json({ error: "llm_not_configured" });
      return;
    }
    console.error("[email] inbound:", err);
    res.status(502).json({ error: "email_processing_error" });
  }
});

app.get("/email/outbox", requireAdminToken, (_req, res) => {
  res.json(readCollection<unknown>("email_outbox").slice(-50));
});

// Chat propio de Miguel (fuera de Retell). Lo llama el canal de WhatsApp (n8n)
// o cualquier web que conecte el negocio. Solo con el token de admin.
app.post("/chat/message", requireAdminToken, async (req, res) => {
  const { session_id, text } = req.body ?? {};
  if (typeof session_id !== "string" || typeof text !== "string" || !session_id.trim() || !text.trim() || text.length > 2000) {
    res.status(400).json({ error: "bad_request" });
    return;
  }
  try {
    res.json(await handleChatMessage(session_id.trim().slice(0, 120), text.trim()));
  } catch (err) {
    if (err instanceof LlmNotConfigured) {
      res.status(503).json({ error: "llm_not_configured" });
      return;
    }
    console.error("[chat] error:", err);
    res.status(502).json({ error: "llm_error" });
  }
});

// Conexión de la cuenta de Google del negocio (Gmail + Calendar). El dueño
// abre /oauth/google/start con el usuario y contraseña del panel una sola vez.
app.get("/oauth/google/start", requireBasicAuth, (_req, res) => {
  try {
    res.redirect(createAuthUrl());
  } catch (err) {
    res.status(500).send(err instanceof Error ? err.message : "error");
  }
});

// Vuelta de Google. Muestra el resultado y un enlace de vuelta al CRM.
const googlePage = (title: string, body: string) =>
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
  `<body style="font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.5"><h2>${title}</h2>${body}` +
  `<p><a href="/crm/integraciones">Volver al CRM</a></p></body></html>`;

app.get("/oauth/google/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    res.status(400).type("html").send(googlePage("Conexión cancelada", `<p>Google devolvió: ${String(error)}</p>`));
    return;
  }
  if (typeof code !== "string" || typeof state !== "string" || !consumeState(state)) {
    res.status(400).type("html").send(
      googlePage("Enlace caducado", "<p>La autorización no es válida o ha caducado. Vuelve al CRM y pulsa Conectar Google otra vez.</p>"),
    );
    return;
  }
  try {
    const { missingScopes } = await exchangeCodeAndStore(code);
    const warning = missingScopes.length
      ? `<p style="color:#b45309">Google no concedió estos permisos: ${missingScopes.join(", ")}. Pulsa Reconectar Google y acepta todos.</p>`
      : "";
    res.type("html").send(googlePage("Google conectado", `<p>La cuenta ya está conectada.</p>${warning}`));
  } catch (err) {
    console.error("[google] callback:", err);
    res.status(500).type("html").send(googlePage("No se pudo conectar Google", `<p>${describeGoogleError(err)}</p>`));
  }
});

app.get("/oauth/google/status", requireAdminToken, (_req, res) => res.json(googleStatus()));

// Webhook de Retell (call_analyzed / chat_analyzed) -- guarda el análisis
// automático configurado en el agente. Retell no manda nuestro ADMIN_TOKEN:
// se autentica con la firma X-Retell-Signature. Sin RETELL_API_KEY se rechaza todo.
app.post("/webhooks/retell", (req, res) => {
  const apiKey = process.env.RETELL_API_KEY;
  const rawBody = (req as express.Request & { rawBody?: string }).rawBody;
  if (!apiKey) {
    console.error("[webhook] RETELL_API_KEY no configurado: webhook de Retell rechazado");
    res.status(401).json({ error: "retell_key_missing" });
    return;
  }
  if (!rawBody || !verifyRetellSignature(rawBody, req.header("x-retell-signature"), apiKey)) {
    console.warn("[webhook] firma de Retell no válida, petición rechazada");
    res.status(401).json({ error: "invalid_signature" });
    return;
  }
  try {
    forwardVoiceAnalysis(req.body ?? {});
    res.json(handleRetellWebhook(req.body ?? {}));
  } catch (err) {
    console.error("[webhook] error:", err);
    res.status(200).json({ received: false });
  }
});

// Panel interno de solo lectura para Ramón/José -- Basic Auth con el mismo
// ADMIN_TOKEN (usuario "lucero", contraseña = ADMIN_TOKEN). No es el CRM
// real, es una ventana sobre lo que el backend ya guarda.
function requireBasicAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.header("authorization");
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    res.status(503).send("ADMIN_TOKEN no configurado");
    return;
  }
  if (header?.startsWith("Basic ")) {
    const [, password] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
    if (password === expected) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Panel Automóviles Lucero"');
  res.status(401).send("Autenticación requerida");
}
app.get("/panel", requireBasicAuth, (_req, res) => res.type("html").send(renderPanel()));

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`Automóviles Lucero backend escuchando en :${port}`);
  startScheduler();
  startEmailPoller();
  startDailySummary();
});
