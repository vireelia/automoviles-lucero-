import express from "express";
import cors from "cors";
import { getBusinessInfo } from "./tools/business.js";
import { searchVehicles, getVehicle, getVehicleStatus, findSimilarVehicles, syncInventory } from "./tools/vehicles.js";
import { upsertLead, updateContactPreferences, getCustomerHistory, scoreLead, createFollowup, stopFollowups, purgeLeadsExcept, mergeLeads, normalizePhone } from "./tools/leads.js";
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
import { readCollection, writeCollection } from "./store.js";
import { createAuthUrl, consumeState, exchangeCodeAndStore, googleStatus, describeGoogleError } from "./integrations/google.js";
import { sendWhatsappText, isWhatsappConnected } from "./integrations/whatsapp.js";
import {
  verifyZernioSignature,
  rememberWhatsappConversation,
  listRecentWhatsappConversations,
  getRecentWhatsappMessages,
  isRealCustomerConversation,
} from "./integrations/zernio.js";
import { sendFacebookText, isFacebookConnected, verifyFacebookSignature } from "./integrations/facebook.js";
import twilioPkg from "twilio";
import { verifyTwilioSignature } from "./integrations/twilio-signature.js";
import { isVoiceAgentEnabled, setVoiceAgentEnabled, isWhatsappZernioAgentEnabled } from "./tools/agent-toggle.js";
import { raiseAlert } from "./alerts/alerts.js";
import { handleChatMessage, LlmNotConfigured } from "./chat/agent.js";
import { businessInfo } from "./data/business-info.js";
import { processInboundEmail } from "./email/agent.js";
import { startEmailPoller } from "./email/poller.js";
import { crm } from "./crm/app.js";
import { bootstrapAdmin, listUsers } from "./crm/auth.js";
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
// FALLO REAL detectado (20/10/2026, auditoría de 99 llamadas de voz reales):
// 4 timeouts de search_vehicles en un solo día (19/10), pese a que esa tool
// es puramente en memoria y debería responder en milisegundos. Causa real
// (confirmada leyendo el código, no solo síntoma): appendToCollection hace
// un read+JSON.parse+JSON.stringify+write SÍNCRONO de la colección entera en
// cada llamada -- y el logging de auditoría de abajo se hacía ANTES de
// responder, así que el tiempo que Retell mide incluía esa reescritura
// completa. Cuanto más crece tool_call_logs (una entrada por cada tool call
// de voz y chat, para siempre), más lenta se vuelve cada llamada, sin que el
// inventario en sí tenga ninguna culpa -- el inventario sigue consultándose
// exactamente igual que siempre, desde el snapshot ya importado del XML de
// Coches.net PRO (vehicles-seed.ts/currentVehicles()), nunca en vivo.
// Dos arreglos, sin tocar ninguna otra colección (leads/citas/reservas
// siguen escribiéndose igual, no hay riesgo de corromper datos de negocio):
// 1) el log de auditoría se escribe DESPUÉS de responder -- el tiempo que ve
//    Retell ya no incluye esa escritura.
// 2) tool_call_logs se acota a las últimas 5000 entradas en cada escritura,
//    para que el coste de cada una no siga creciendo para siempre según pasan
//    las semanas.
const TOOL_CALL_LOGS_MAX = 5000;
function logToolCall(entry: Record<string, unknown>): void {
  const items = readCollection<Record<string, unknown>>("tool_call_logs");
  items.push(entry);
  if (items.length > TOOL_CALL_LOGS_MAX) items.splice(0, items.length - TOOL_CALL_LOGS_MAX);
  writeCollection("tool_call_logs", items);
}
function route(fn: (args: any) => unknown) {
  return async (req: express.Request, res: express.Response) => {
    const startedAt = Date.now();
    const toolName = req.path.replace(/^\/tools\//, "");
    try {
      const body = req.body ?? {};
      const args = body && typeof body === "object" && "args" in body && body.args && typeof body.args === "object" ? body.args : body;
      const result = await fn(args);
      res.json(result);
      logToolCall({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        tool: toolName,
        input: args,
        result,
        latency_ms: Date.now() - startedAt,
      });
    } catch (err) {
      const errorResult = {
        status: "error",
        request_id: crypto.randomUUID(),
        data: null,
        error_code: err instanceof Error ? err.message : "unknown_error",
      };
      res.status(200).json(errorResult);
      logToolCall({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        tool: toolName,
        input: req.body,
        result: errorResult,
        latency_ms: Date.now() - startedAt,
      });
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
// Teléfono real del que llama (20/10/2026, auditoría de llamadas de voz:
// "busquemos la manera de que el agente... le envíe cogiendo el número de
// la llamada"): en una llamada de Retell, el número real está en
// `call.from_number` -- nunca hace falta que el cliente lo repita en voz ni
// que el modelo lo adivine. Solo rellena si el modelo no puso ya un
// lead_phone explícito (mismo criterio que markVoiceOrigin con el canal).
// FALLO REAL detectado (21/10/2026, caso real de Lucía y de varias reservas
// nunca convertidas -- Mohamed/Tiguan, Fran/Fiat, cliente/Citroën -- todas
// con el mismo patrón): el teléfono de Retell llega sin normalizar ("632241696"
// o "34626304959", sin el "+") mientras el lead ya está guardado como
// "+34632241696" -- cualquier búsqueda exacta por teléfono aguas abajo
// (createHandoff, team-notify, tryAutoCreateReservation) fallaba en
// silencio, perdiendo el nombre del cliente Y la reserva automática. Se
// normaliza aquí, una sola vez, en el único sitio por el que pasan las
// cuatro rutas que dependen del teléfono real de la llamada.
function markCallerPhone(req: express.Request, _res: express.Response, next: express.NextFunction) {
  const body = req.body ?? {};
  const fromNumber = body.call?.from_number;
  if (typeof fromNumber === "string" && fromNumber && body.args && typeof body.args === "object" && !body.args.lead_phone) {
    body.args.lead_phone = normalizePhone(fromNumber);
  } else if (body.args && typeof body.args === "object" && typeof body.args.lead_phone === "string") {
    body.args.lead_phone = normalizePhone(body.args.lead_phone);
  }
  next();
}
app.post("/tools/create_lead", markVoiceOrigin, route((a) => upsertLead(a)));
app.post("/tools/update_lead", markVoiceOrigin, route((a) => upsertLead(a)));
app.post("/tools/get_vehicle", route((a) => getVehicle(a)));
app.post("/tools/get_vehicle_status", route((a) => getVehicleStatus(a)));
app.post("/tools/find_similar_vehicles", route((a) => findSimilarVehicles(a)));
app.post("/tools/upsert_lead", requireAdminToken, route((a) => upsertLead(a)));
app.post("/tools/purge_leads_except", requireAdminToken, route((a) => purgeLeadsExcept(a)));
app.post("/tools/merge_leads", requireAdminToken, route((a) => mergeLeads(a)));
app.post("/tools/update_contact_preferences", route((a) => updateContactPreferences(a)));
app.post("/tools/get_customer_history", route((a) => getCustomerHistory(a)));
app.post("/tools/score_lead", route((a) => scoreLead(a)));
app.post("/tools/create_followup", route((a) => createFollowup(a)));
app.post("/tools/stop_followups", route((a) => stopFollowups(a)));
app.post("/tools/create_purchase_request", requireAdminToken, route((a) => createPurchaseRequest(a)));
app.post("/tools/create_vehicle_valuation", route((a) => createVehicleValuation(a)));
app.post("/tools/create_service_request", route((a) => createServiceRequest(a)));
app.post("/tools/create_handoff", markVoiceOrigin, markCallerPhone, route((a) => createHandoff(a)));
app.post("/tools/get_appointment_slots", route(() => getAppointmentSlots()));
app.post("/tools/create_appointment", markVoiceOrigin, markCallerPhone, route((a) => createAppointmentWithCalendar(a)));
app.post("/tools/update_appointment", route((a) => updateAppointment(a)));
app.post("/tools/cancel_appointment", route((a) => cancelAppointment(a)));
// Sin admin-token a propósito (16/10/2026): Retell la llama en vivo, igual
// que create_handoff/create_appointment -- ver la excepción puntual en
// scripts/sync-retell.mjs y prompt-core.md (CUÁNDO SE TRANSFIERE EN VOZ).
app.post("/tools/create_reservation_pending", markVoiceOrigin, markCallerPhone, route((a) => createReservationPending(a)));
app.post("/tools/submit_payment_receipt", requireAdminToken, route((a) => submitPaymentReceipt(a)));
app.post("/tools/request_financing", route((a) => requestFinancing(a)));
app.post("/tools/send_internal_summary", requireAdminToken, route((a) => sendInternalSummary(a)));
app.post("/tools/send_vehicle_link", markCallerPhone, route((a) => sendVehicleLink(a)));
app.post("/tools/send_location", route(() => sendLocation()));
app.post("/tools/send_whatsapp", markCallerPhone, route((a) => sendWhatsapp(a)));
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

// Migración puntual (21/10/2026, auditoría real de "estamos perdiendo
// reservas/visitas"): varios registros antiguos de appointments/handoffs
// quedaron con lead_phone sin normalizar ("632241696" en vez de
// "+34632241696", de antes de que markCallerPhone normalizara). Esto no
// crea datos nuevos ni borra nada -- solo reescribe el mismo teléfono en
// el formato consistente que ya usan leads/reservations, para que las
// búsquedas por teléfono (nombre del cliente, avisos al equipo, fichas)
// dejen de fallar en silencio para estos registros concretos.
app.post("/admin/normalize_phones", requireAdminToken, (_req, res) => {
  const report: Record<string, number> = {};
  for (const name of ["appointments", "handoffs"] as const) {
    const rows = readCollection<{ lead_phone?: string | null }>(name);
    let changed = 0;
    for (const row of rows) {
      if (row.lead_phone && typeof row.lead_phone === "string") {
        const normalized = normalizePhone(row.lead_phone);
        if (normalized !== row.lead_phone) {
          row.lead_phone = normalized;
          changed++;
        }
      }
    }
    if (changed > 0) writeCollection(name, rows);
    report[name] = changed;
  }
  res.json({ status: "ok", changed: report });
});

// Da de alta a mano la conversación de Zernio de un número del EQUIPO
// (Ramón/José), nunca de un cliente -- a diferencia del resto de
// conversaciones, que el propio webhook /webhooks/zernio-whatsapp aprende
// solas en cuanto alguien escribe, el número del equipo no "escribe primero"
// al bot en el uso normal, así que su mapeo se siembra aquí una vez con el
// conversationId real que ya existe en Zernio (historial de coexistencia).
app.post("/admin/zernio/seed-team-conversation", requireAdminToken, route((a: { phone: string; conversation_id: string; account_id: string }) => {
  rememberWhatsappConversation(a.phone, a.conversation_id, a.account_id);
  return { status: "ok" };
}));

// Backlog real de WhatsApp (19/10/2026, "mira los 100 mensajes reales de
// los clientes y ve respondiendo, pero verifica que son clientes"):
// conversaciones importadas del historial (de antes de este webhook) que
// nunca pasaron por el agente. Mismo cerebro de siempre (handleChatMessage,
// el mismo que usa cada mensaje nuevo) -- nunca una respuesta inventada
// aparte. Tres filtros antes de tocar nada:
// 1) Forma de cliente individual real (nunca grupo, nunca el número del
//    propio equipo -- Ramón/José se excluyen explícitamente).
// 2) Dentro de las 24h desde su último mensaje (fuera de eso, WhatsApp
//    rechaza igualmente el envío -- no tiene sentido ni intentarlo).
// 3) Con un mensaje entrante real con texto (se ignoran adjuntos sin
//    texto, mensajes no soportados, etc. -- nunca se inventa qué pedían).
// dry_run (por defecto true): genera la respuesta real del agente pero NO
// la envía -- para poder revisar antes de mandar nada a un cliente real.
const TEAM_PHONES = new Set([
  businessInfo.responsables.ramon.transfer_number.replace(/[^\d]/g, ""),
  businessInfo.responsables.jose.transfer_number.replace(/[^\d]/g, ""),
]);
app.post(
  "/admin/zernio/process-whatsapp-backlog",
  requireAdminToken,
  route(async (a: { limit?: number; dry_run?: boolean; max_age_hours?: number }) => {
    const limit = a.limit ?? 100;
    const dryRun = a.dry_run ?? true;
    const maxAgeHours = a.max_age_hours ?? 24;

    const convsResult = await listRecentWhatsappConversations(limit);
    if (!convsResult.ok) return { status: "error", error: convsResult.error };

    const now = Date.now();
    const report: Array<Record<string, unknown>> = [];

    for (const c of convsResult.conversations) {
      if (TEAM_PHONES.has(c.phone)) {
        report.push({ phone: c.phone, name: c.name, saltado: "es_del_equipo_no_cliente" });
        continue;
      }
      if (!isRealCustomerConversation(c)) {
        report.push({ phone: c.phone, name: c.name, saltado: "no_parece_cliente_individual_real" });
        continue;
      }
      if (!c.updatedTime) {
        report.push({ phone: c.phone, name: c.name, saltado: "sin_fecha" });
        continue;
      }
      const ageHours = (now - Date.parse(c.updatedTime)) / 3600000;
      if (!(ageHours <= maxAgeHours)) {
        report.push({ phone: c.phone, name: c.name, saltado: `fuera_de_ventana_24h (hace ${ageHours.toFixed(1)}h)` });
        continue;
      }

      const msgsResult = await getRecentWhatsappMessages(c.conversationId, 10);
      if (!msgsResult.ok) {
        report.push({ phone: c.phone, name: c.name, saltado: `error_leyendo_mensajes: ${msgsResult.error}` });
        continue;
      }
      const lastIncoming = msgsResult.messages.find((m) => m.direction === "incoming" && m.text && m.text.trim());
      if (!lastIncoming?.text) {
        report.push({ phone: c.phone, name: c.name, saltado: "sin_mensaje_entrante_con_texto" });
        continue;
      }

      try {
        const chatResult = await handleChatMessage(c.phone, lastIncoming.text, "WHATSAPP", c.phone);
        if (dryRun) {
          report.push({ phone: c.phone, name: c.name, pregunta: lastIncoming.text, respuesta_propuesta: chatResult.reply, enviado: false });
        } else {
          const sent = await sendWhatsappText(c.phone, chatResult.reply);
          report.push({
            phone: c.phone,
            name: c.name,
            pregunta: lastIncoming.text,
            respuesta: chatResult.reply,
            enviado: sent.ok,
            error_envio: sent.ok ? null : sent.error,
          });
        }
      } catch (err) {
        report.push({ phone: c.phone, name: c.name, saltado: `error_agente: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    return { status: "ok", dry_run: dryRun, total_conversaciones: convsResult.conversations.length, report };
  }),
);

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

app.get("/email/inbox", requireAdminToken, (_req, res) => {
  res.json(readCollection<unknown>("email_inbox").slice(-50));
});

// Depuración real (15/10/2026, a petición de "esta mal, arregla eso" tras
// una recurrencia del fallback en producción): permite ver exactamente qué
// llamó el agente y en qué conversación, sin tener que adivinar leyendo el
// store a mano. Solo lectura, con token de admin.
app.get("/debug/tool_call_logs", requireAdminToken, (_req, res) => {
  res.json(readCollection<unknown>("tool_call_logs").slice(-200));
});

app.get("/debug/chat_conversations", requireAdminToken, (_req, res) => {
  res.json(readCollection<unknown>("chat_conversations").slice(-50));
});

app.get("/debug/call_analyses", requireAdminToken, (_req, res) => {
  res.json(readCollection<unknown>("call_analyses").slice(-50));
});

app.get("/debug/studio_jobs", requireAdminToken, (_req, res) => {
  res.json(readCollection<unknown>("studio_jobs").slice(-50));
});

app.get("/debug/alerts", requireAdminToken, (_req, res) => {
  res.json(readCollection<unknown>("alerts").slice(-50));
});

app.get("/debug/reservations", requireAdminToken, (_req, res) => {
  res.json(readCollection<unknown>("reservations").slice(-50));
});

app.get("/debug/leads", requireAdminToken, (_req, res) => {
  res.json(readCollection<unknown>("leads").slice(-200));
});

app.get("/debug/appointments", requireAdminToken, (_req, res) => {
  res.json(readCollection<unknown>("appointments").slice(-100));
});

app.get("/debug/crm_users", requireAdminToken, (_req, res) => {
  res.json(listUsers().map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, created_at: u.created_at })));
});

app.get("/debug/facebook_processed", requireAdminToken, (_req, res) => {
  res.json(readCollection<unknown>("facebook_processed").slice(-100));
});

app.get("/debug/handoffs", requireAdminToken, (_req, res) => {
  res.json(readCollection<unknown>("handoffs").slice(-100));
});

app.get("/debug/zernio_whatsapp_conversations", requireAdminToken, (_req, res) => {
  res.json(readCollection<unknown>("zernio_whatsapp_conversations").slice(-200));
});

app.get("/debug/team_notifications", requireAdminToken, (_req, res) => {
  res.json(readCollection<unknown>("team_notifications").slice(-200));
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

// WhatsApp real (Fase 1, 13/10/2026): lo llama n8n tras verificar la firma
// de Meta y normalizar el payload (workflow "Lucero - WhatsApp v2"). Mismo
// patrón que /email/inbound -- n8n es solo transporte, toda la lógica
// comercial vive aquí, compartida de verdad con email y chat vía
// handleChatMessage(). Dedupe propio por mensaje (igual que email_processed)
// porque un mensaje de WhatsApp puede reintentarse desde Meta/n8n.
const MAX_WHATSAPP_PROCESSED_KEPT = 500;
// Mismo registro que lee /crm/whatsapp (src/crm/app.ts) -- tipo local
// duplicado a propósito, igual que ya se hace con email_inbox entre
// email/agent.ts y crm/app.ts en este mismo repo.
type WhatsappInboxRecord = {
  id: string;
  phone: string;
  text: string;
  reply_text?: string;
  delivered?: boolean;
  read?: boolean;
  answered?: boolean;
  answered_by?: "ia" | "equipo";
  archived?: boolean;
  created_at: string;
};
app.post("/channels/whatsapp/inbound", requireAdminToken, async (req, res) => {
  const b = req.body ?? {};
  if (typeof b.from !== "string" || typeof b.text !== "string" || !b.from.trim() || !b.text.trim()) {
    res.status(400).json({ error: "bad_request" });
    return;
  }
  const from = b.from.trim();
  const text = b.text.trim().slice(0, 2000);
  const messageId = typeof b.message_id === "string" && b.message_id ? b.message_id : crypto.randomUUID();
  const dedupeKey = `${from}|${messageId}`;

  const processed = readCollection<{ key: string; at: string }>("whatsapp_processed");
  if (processed.some((p) => p.key === dedupeKey)) {
    res.json({ ok: true, deduped: true });
    return;
  }

  // FALLO REAL grave detectado (16/10/2026, confirmado con una llamada real de
  // n8n y reproducido en local): esta ruta esperaba a que terminara TODO
  // (handleChatMessage -- varias llamadas a OpenAI -- más el envío real por
  // WhatsApp) antes de responder, ~6-8s. El proxy de EasyPanel corta la
  // conexión antes de que termine y devuelve su propia página de "Service is
  // not reachable" -- el código en sí funcionaba bien (confirmado en local,
  // mismo tiempo, misma respuesta correcta), el problema era puramente el
  // tiempo de respuesta. Mismo patrón que ya usa el webhook de Facebook:
  // responder rápido y procesar por debajo, para que n8n/Meta no vean nunca
  // ese timeout.
  res.json({ ok: true, queued: true });

  writeCollection(
    "whatsapp_processed",
    [...processed, { key: dedupeKey, at: new Date().toISOString() }].slice(-MAX_WHATSAPP_PROCESSED_KEPT),
  );

  // Módulo CRM mensajes/clientes (18/10/2026): registrar el mensaje entrante
  // para que se vea en /crm/whatsapp -- puramente aditivo, en su propio
  // try/catch para que un fallo aquí nunca toque la respuesta ya enviada
  // arriba ni el resto de este webhook (que ya funcionaba de antes). No
  // envía nada nuevo por WhatsApp: el envío sigue igual que siempre, esto
  // solo deja constancia de lo que ya se mandó o se intentó mandar.
  const whatsappInboxId = crypto.randomUUID();
  try {
    const inbox = readCollection<WhatsappInboxRecord>("whatsapp_inbox");
    inbox.push({ id: whatsappInboxId, phone: from, text, read: false, answered: false, archived: false, created_at: new Date().toISOString() });
    writeCollection("whatsapp_inbox", inbox.slice(-500));
  } catch (err) {
    console.error("[whatsapp] no se pudo registrar el mensaje entrante en el CRM:", err instanceof Error ? err.message : err);
  }

  try {
    const result = await handleChatMessage(from, text, "WHATSAPP", from);
    let delivered = false;
    if (isWhatsappConnected()) {
      const sent = await sendWhatsappText(from, result.reply);
      delivered = sent.ok;
      if (!sent.ok) {
        console.error("[whatsapp] no se pudo enviar la respuesta:", sent.error);
      }
    } else {
      console.warn("[whatsapp] credenciales no conectadas -- respuesta generada pero NO enviada:", result.reply);
    }
    try {
      const inbox = readCollection<WhatsappInboxRecord>("whatsapp_inbox");
      const rec = inbox.find((m) => m.id === whatsappInboxId);
      if (rec) {
        rec.reply_text = result.reply;
        rec.delivered = delivered;
        rec.answered = true;
        rec.answered_by = "ia";
        writeCollection("whatsapp_inbox", inbox);
      }
    } catch (err) {
      console.error("[whatsapp] no se pudo actualizar el registro del CRM:", err instanceof Error ? err.message : err);
    }
  } catch (err) {
    console.error("[whatsapp] inbound:", err instanceof Error ? err.message : err);
  }
});

// WhatsApp vía Zernio (18/10/2026, alternativa a la Fase 1 de arriba para
// evitar la verificación de negocio de Meta): Zernio llama directo a este
// webhook con eventos de su inbox unificado -- no pasa por n8n, la firma se
// verifica aquí mismo (HMAC-SHA256 sobre el cuerpo crudo, igual patrón que
// Retell/Twilio/Facebook). Solo procesamos "message.received" de la cuenta
// de WhatsApp configurada (ZERNIO_WHATSAPP_ACCOUNT_ID) -- cualquier otro
// evento o cuenta se ignora con 200 (Zernio reintenta si no hay 2xx rápido).
// Guardamos el conversationId del remitente para poder responder después
// (whatsapp.ts/zernio.ts lo necesita: en WhatsApp solo se puede enviar texto
// libre dentro de una conversación ya abierta).
const MAX_ZERNIO_WHATSAPP_PROCESSED_KEPT = 500;
app.post("/webhooks/zernio-whatsapp", async (req, res) => {
  const raw = (req as express.Request & { rawBody?: string }).rawBody ?? "";
  if (!verifyZernioSignature(raw, req.header("X-Zernio-Signature"), process.env.ZERNIO_WEBHOOK_SECRET)) {
    res.status(403).send("forbidden");
    return;
  }
  res.status(200).json({ ok: true });

  try {
    const body = req.body ?? {};
    if (body.event !== "message.received") return;
    if (process.env.ZERNIO_WHATSAPP_ACCOUNT_ID && body.account?.accountId !== process.env.ZERNIO_WHATSAPP_ACCOUNT_ID) return;

    const eventId = typeof body.id === "string" && body.id ? body.id : crypto.randomUUID();
    const processed = readCollection<{ key: string; at: string }>("zernio_whatsapp_processed");
    if (processed.some((p) => p.key === eventId)) return;
    writeCollection(
      "zernio_whatsapp_processed",
      [...processed, { key: eventId, at: new Date().toISOString() }].slice(-MAX_ZERNIO_WHATSAPP_PROCESSED_KEPT),
    );

    const conversationId: string | undefined = body.conversation?.id;
    const phone: string | undefined = body.message?.sender?.participantId ?? body.message?.sender?.id ?? body.message?.sender?.phone;
    const text: string | undefined = body.message?.text;
    const accountId: string | undefined = body.account?.accountId;
    if (!conversationId || !phone || !text || !accountId) {
      console.warn("[zernio-whatsapp] evento message.received con campos inesperados, se ignora:", JSON.stringify(body).slice(0, 500));
      return;
    }

    // Nunca contestar en un grupo de WhatsApp (19/10/2026, "que el agente de
    // chat no responda mensajes de grupos... solo mensajes de clientes
    // reales"). La documentación pública de Zernio no confirma un campo
    // "isGroup" fiable en este webhook para WhatsApp -- así que, en vez de
    // confiar en un campo que podría no existir, dos comprobaciones
    // defensivas que SÍ se pueden verificar: cualquier bandera de grupo que
    // Meta pudiera colar sin documentar (groupId/isGroup, en cualquiera de
    // los sitios donde Zernio podría ponerla), y que el identificador del
    // remitente tenga forma de número de teléfono real (solo dígitos,
    // 8-15 caracteres) -- un JID de grupo de WhatsApp no tiene esa forma.
    const looksLikeGroup =
      Boolean(body.message?.groupId || body.message?.isGroup || body.conversation?.groupId || body.conversation?.isGroup || body.message?.sender?.groupId) ||
      !/^\d{8,15}$/.test(phone);
    if (looksLikeGroup) {
      console.warn("[zernio-whatsapp] mensaje con forma de grupo (no de cliente individual), se ignora:", JSON.stringify(body).slice(0, 500));
      return;
    }

    rememberWhatsappConversation(phone, conversationId, accountId);

    // FALLO REAL detectado (21/10/2026, "en la sección de whatsapp no salen
    // los whatsapp"): este webhook (el real, el que de verdad usa Zernio)
    // nunca dejaba constancia en whatsapp_inbox -- solo el webhook viejo de
    // n8n (/channels/whatsapp/inbound, sin tráfico real desde que se conectó
    // Zernio) lo hacía. /crm/whatsapp leía siempre esa colección, así que
    // mostraba vacío aunque los mensajes reales sí estuvieran llegando y
    // respondiéndose. Mismo patrón que el webhook de n8n: registro aditivo
    // en su propio try/catch, nunca toca la respuesta real del agente.
    const whatsappInboxId = crypto.randomUUID();
    try {
      const inbox = readCollection<WhatsappInboxRecord>("whatsapp_inbox");
      inbox.push({ id: whatsappInboxId, phone, text: text.trim().slice(0, 2000), read: false, answered: false, archived: false, created_at: new Date().toISOString() });
      writeCollection("whatsapp_inbox", inbox.slice(-500));
    } catch (err) {
      console.error("[zernio-whatsapp] no se pudo registrar el mensaje entrante en el CRM:", err instanceof Error ? err.message : err);
    }

    // Interruptor nuevo (19/10/2026, "todavía no actives Miguel" justo al
    // dejar el canal conectado): con el agente en pausa, el mensaje real del
    // cliente nunca se pierde -- se avisa al equipo para que responda a mano
    // mientras tanto -- pero Miguel no contesta solo hasta que se active
    // desde Integraciones.
    if (!isWhatsappZernioAgentEnabled()) {
      raiseAlert({
        kind: "handoff_urgente",
        lead_phone: phone,
        reason: `WhatsApp (vía Zernio): el agente todavía está pausado -- el cliente escribió "${text.trim().slice(0, 300)}" y no se le ha respondido. Actívalo desde Integraciones cuando quieras que Miguel conteste aquí.`,
      });
      return;
    }

    const result = await handleChatMessage(phone, text.trim().slice(0, 2000), "WHATSAPP", phone);
    const sent = await sendWhatsappText(phone, result.reply);
    if (!sent.ok) console.error("[zernio-whatsapp] no se pudo enviar la respuesta:", sent.error);
    try {
      const inbox = readCollection<WhatsappInboxRecord>("whatsapp_inbox");
      const rec = inbox.find((m) => m.id === whatsappInboxId);
      if (rec) {
        rec.reply_text = result.reply;
        rec.delivered = sent.ok;
        rec.answered = true;
        rec.answered_by = "ia";
        writeCollection("whatsapp_inbox", inbox);
      }
    } catch (err) {
      console.error("[zernio-whatsapp] no se pudo actualizar el registro del CRM:", err instanceof Error ? err.message : err);
    }
  } catch (err) {
    console.error("[zernio-whatsapp] inbound:", err instanceof Error ? err.message : err);
  }
});

// Facebook Messenger real (16/10/2026, "vamos con el agente de chat de
// Facebook"): a diferencia de WhatsApp, aquí Meta llama DIRECTO a nuestro
// backend (sin pasar por n8n) -- la verificación de firma (X-Hub-Signature-256
// con el App Secret) es más simple que la de WhatsApp y no hace falta una
// capa intermedia. Mismo cerebro compartido vía handleChatMessage(), mismo
// patrón de dedupe que whatsapp_processed/email_processed.
app.get("/channels/facebook/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN && typeof challenge === "string") {
    res.status(200).send(challenge);
    return;
  }
  res.status(403).send("forbidden");
});

const MAX_FACEBOOK_PROCESSED_KEPT = 500;
app.post("/channels/facebook/webhook", async (req, res) => {
  const raw = (req as express.Request & { rawBody?: string }).rawBody ?? "";
  if (!verifyFacebookSignature(req.header("X-Hub-Signature-256"), raw, process.env.FACEBOOK_APP_SECRET)) {
    res.status(403).send("forbidden");
    return;
  }
  // Meta espera 200 rápido para no reintentar -- se responde ya y se procesa
  // cada mensaje real por debajo, igual que el resto de canales.
  res.status(200).send("EVENT_RECEIVED");

  const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
  const processed = readCollection<{ key: string; at: string }>("facebook_processed");
  const newlyProcessed: { key: string; at: string }[] = [];

  for (const entry of entries) {
    const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const event of messaging) {
      const psid: string | undefined = event?.sender?.id;
      const text: string | undefined = event?.message?.text;
      const messageId: string | undefined = event?.message?.mid;
      if (!psid || !text || !text.trim() || event?.message?.is_echo) continue;

      const dedupeKey = `${psid}|${messageId ?? text}`;
      if (processed.some((p) => p.key === dedupeKey) || newlyProcessed.some((p) => p.key === dedupeKey)) continue;

      try {
        const result = await handleChatMessage(psid, text.trim().slice(0, 2000), "FACEBOOK", psid);
        newlyProcessed.push({ key: dedupeKey, at: new Date().toISOString() });
        if (isFacebookConnected()) {
          const sent = await sendFacebookText(psid, result.reply);
          if (!sent.ok) console.error("[facebook] no se pudo enviar la respuesta:", sent.error);
        } else {
          console.warn("[facebook] credenciales no conectadas -- respuesta generada pero NO enviada:", result.reply);
        }
      } catch (err) {
        console.error("[facebook] inbound:", err instanceof Error ? err.message : err);
      }
    }
  }

  if (newlyProcessed.length > 0) {
    writeCollection("facebook_processed", [...processed, ...newlyProcessed].slice(-MAX_FACEBOOK_PROCESSED_KEPT));
  }
});

// Teléfono real (Fase 1-2 de la conexión telefónica, 13/10/2026): Twilio
// llama aquí en cada llamada entrante al número español, firmado con
// X-Twilio-Signature (verificado con la librería oficial, nunca a mano).
// El número NO está asociado a un Trunk de Twilio a propósito -- así esta
// ruta decide de verdad en cada llamada, en vez de un enrutamiento fijo.
app.post("/telephony/voice-inbound", express.urlencoded({ extended: false }), (req, res) => {
  if (!verifyTwilioSignature(req.header("X-Twilio-Signature"), req.body, process.env.TWILIO_AUTH_TOKEN)) {
    res.status(403).send("forbidden");
    return;
  }
  const response = new twilioPkg.twiml.VoiceResponse();
  if (isVoiceAgentEnabled()) {
    response.dial().sip("sip:sip.retellai.com");
  } else {
    // Ruta alternativa cuando Miguel está desactivado: suenan los móviles
    // reales de Ramón y José a la vez (el primero que conteste se queda con
    // la llamada) -- nunca Yoigo, eso se gestiona por fuera de este sistema.
    const dial = response.dial({ timeout: 25 });
    dial.number("+34622188213");
    dial.number("+34624807067");
  }
  res.type("text/xml").send(response.toString());
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
