import express from "express";
import PDFDocument from "pdfkit";
import * as nodeFs from "fs";
import * as nodePath from "path";
import crypto from "crypto";
import { getBusinessInfo } from "./tools/business.js";
import { searchVehicles, getVehicle, getVehicleStatus, findSimilarVehicles, syncInventory } from "./tools/vehicles.js";
import { upsertLead, updateContactPreferences, getCustomerHistory, scoreLead, createFollowup, stopFollowups, purgeLeadsExcept, mergeLeads, normalizePhone } from "./tools/leads.js";
import { createPurchaseRequest, createServiceRequest, createHandoff, createVehicleValuation } from "./tools/requests.js";
import { getAppointmentSlots, createAppointmentWithCalendar, updateAppointment, cancelAppointment } from "./tools/appointments.js";
import { sendInternalSummary, sendVehicleLink, sendLocation, sendWhatsapp, notifySalesperson, saveConversation, createConversationSummary } from "./tools/delivery.js";
import { createReservationPending, submitPaymentReceipt, confirmReservation, cancelReservation, reopenReservation } from "./tools/reservations.js";
import { requestFinancing } from "./tools/financing.js";
import { handleRetellWebhook } from "./tools/webhooks.js";
import { verifyRetellSignature } from "./integrations/retell-signature.js";
import { forwardVoiceAnalysis } from "./integrations/n8n.js";
import { renderPanel } from "./panel.js";
import { startScheduler } from "./scheduler.js";
import { readCollection, writeCollection, claimOnce, mutateCollectionSync } from "./store.js";
import { restoreFromTrash, moveToTrash } from "./crm/trash.js";
import { createAuthUrl, consumeState, exchangeCodeAndStore, googleStatus, describeGoogleError, gmailSearch, gmailGet, gmailListUnread, calendarBusy, calendarListEvents } from "./integrations/google.js";
import { extractWallapopContact } from "./email/interest.js";
import { sendWhatsappText, isWhatsappConnected } from "./integrations/whatsapp.js";
import { esAnteriorAlCorte } from "./deploy-safety.js";
import {
  verifyZernioSignature,
  rememberWhatsappConversation,
  listRecentWhatsappConversations,
  getRecentWhatsappMessages,
  getRealDeliveryStatus,
  isRealCustomerConversation,
  downloadWhatsAppMedia,
  saveWhatsAppMedia,
  isContactoInicialTemplateApproved,
  sendZernioWhatsappVehicleContactTemplate,
  findWhatsappConversation,
  createTeamAlertTemplate,
  teamAlertTemplateStatus,
  createClientReminderTemplate,
  clientReminderTemplateStatus,
  getClientReminderTemplateId,
} from "./integrations/zernio.js";
import { notifyVisitScheduled, team } from "./tools/team-notify.js";
import { sendTeamAlertViaTemplate } from "./integrations/zernio.js";
import { currentVehicles } from "./data/vehicles-current.js";
import { sendFacebookText, isFacebookConnected, verifyFacebookSignature } from "./integrations/facebook.js";
import twilioPkg from "twilio";
import { verifyTwilioSignature } from "./integrations/twilio-signature.js";
import { isVoiceAgentEnabled, setVoiceAgentEnabled, isWhatsappZernioAgentEnabled, setWhatsappZernioAgentEnabled, isEmailAutoSendEnabled, isWhatsappChatPaused, setWhatsappChatPaused } from "./tools/agent-toggle.js";
import { raiseAlert, deleteAlert } from "./alerts/alerts.js";
import { startGestionPortalWhatsappRetry } from "./alerts/whatsapp-retry.js";
import { handleChatMessage, LlmNotConfigured } from "./chat/agent.js";
import { enqueuePendingReply, drainPendingReplies } from "./chat/pending-replies.js";
import { withPersistentLockOrSkip } from "./locks.js";
import { createAutoTask } from "./tools/tasks.js";

// Reintento de respuestas pendientes por fallo de la IA, con las mismas
// protecciones que el mensaje entrante (agente/chat pausado, modo prueba).
setInterval(async () => {
  // Bloqueo en disco: si otra instancia ya está drenando, este ciclo se
  // salta en vez de enviar dos veces el mismo mensaje.
  await withPersistentLockOrSkip("drain_pending_replies", async () => {
    await drainPendingReplies(async (item) => {
      if (item.channel === "WHATSAPP") {
        const solo = process.env.WHATSAPP_SOLO_RESPONDER_A?.trim().replace(/^\+/, "");
        if (!isWhatsappZernioAgentEnabled() || isWhatsappChatPaused(item.contact) || (solo && item.contact.replace(/^\+/, "") !== solo)) {
          return { ok: false, error: "agente_pausado_o_modo_prueba" };
        }
      }
      const result = await handleChatMessage(item.contact, item.text, item.channel, item.contact);
      if (result.ai_failed) return { ok: false, error: "ai_failed" };
      const sent = item.channel === "WHATSAPP" ? await sendWhatsappText(item.contact, result.reply) : await sendFacebookText(item.contact, result.reply);
      return sent.ok ? { ok: true } : { ok: false, error: String(sent.error) };
    });
  }).catch((err) => console.error("[pending-replies]", err instanceof Error ? err.message : err));
}, 60_000);
import { getBusinessConfig } from "./data/business-config.js";
import { processInboundEmail, deliverEmail } from "./email/agent.js";
import { startEmailPoller } from "./email/poller.js";
import { crm } from "./crm/app.js";
import { bootstrapAdmin, listUsers } from "./crm/auth.js";
import { startDailySummary } from "./crm/daily.js";

const app = express();
// CORS quitado (auditoría de seguridad, 26/10/2026): estaba abierto a
// cualquier origen (app.use(cors()) sin opciones) en TODA la app, incluidos
// /tools/* y /admin/*. Ninguna ruta real de este backend la consume un
// navegador en otro origen -- /crm/* es same-origin (HTML servido por este
// mismo servidor), y /tools/*, /webhooks/*, /admin/* los llaman siempre
// otros servidores (Retell, Twilio, Zernio, n8n), nunca JavaScript de una
// página web -- CORS no protege ni hace falta ahí. Si algún día una web en
// otro origen necesita llamar a esta API de verdad, se añade una lista
// concreta de orígenes permitidos, nunca un comodín abierto a todos.
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
// Comparación en tiempo constante (auditoría de seguridad, 26/10/2026) --
// "!==" compara byte a byte y corta en la primera diferencia, lo que en
// teoría deja un canal de temporización para adivinar el token carácter a
// carácter. crypto.timingSafeEqual exige que los dos Buffer midan igual
// (si no, lanza) -- por eso se compara la longitud por fuera, con un
// Buffer de longitud fija para no reintroducir el mismo problema ahí.
function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // mismo coste aproximado, para no filtrar la longitud por tiempo
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}
function requireAdminToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.header("x-admin-token");
  if (!process.env.ADMIN_TOKEN || !token || !tokensMatch(token, process.env.ADMIN_TOKEN)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
app.post("/admin/confirm_reservation", requireAdminToken, route((a) => confirmReservation(a)));
app.post("/admin/cancel_reservation", requireAdminToken, route((a) => cancelReservation(a)));
app.post("/admin/reopen_reservation", requireAdminToken, route((a) => reopenReservation(a)));

// Mismas dos acciones que /crm/clientes/archivados (ver crm/app.ts), pero por
// ADMIN_TOKEN en vez de sesión de navegador -- el servicio está cayéndose de
// forma intermitente por el tamaño de leads.json (lectura/escritura síncrona
// en store.ts bloqueando el event loop), así que no se puede depender de que
// el navegador aguante una sesión de CRM completa para hacer esta limpieza;
// un solo POST por curl basta aunque el servicio esté inestable.
app.get("/admin/leads_archivados/exportar-pdf", requireAdminToken, (_req, res) => {
  const leads = readCollection<{
    archived?: boolean; name?: string | null; phone?: string | null; email?: string | null;
    vehicle_interest?: string | null; channel?: string | null; created_at?: string;
  }>("leads");
  const archivados = leads.filter((l) => l.archived === true);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="leads_archivados_${new Date().toISOString().slice(0, 10)}.pdf"`);
  const doc = new PDFDocument({ margin: 40, size: "A4" });
  doc.pipe(res);
  doc.fontSize(16).text("Automóviles Lucero -- Leads archivados", { underline: true });
  doc.fontSize(10).fillColor("#555").text(`Generado ${new Date().toLocaleString("es-ES")} -- ${archivados.length} leads`);
  doc.moveDown(1);
  doc.fillColor("#000");
  for (const l of archivados) {
    doc.fontSize(10).text(
      `${l.name ?? "(sin nombre)"} -- ${l.phone ?? l.email ?? "(sin contacto)"} -- interés: ${l.vehicle_interest ?? "-"} -- canal: ${l.channel ?? "-"} -- creado: ${l.created_at ?? "-"}`,
    );
    if (doc.y > 760) doc.addPage();
  }
  doc.end();
});

app.post("/admin/leads_archivados/eliminar", requireAdminToken, (_req, res) => {
  const leads = readCollection<{ archived?: boolean }>("leads");
  const antes = leads.length;
  const restantes = leads.filter((l) => l.archived !== true);
  writeCollection("leads", restantes);
  res.json({ status: "ok", borrados: antes - restantes.length, restantes: restantes.length });
});

// Diagnóstico real de tamaño por colección (12/11/2026, tras confirmar que
// leads.json con ~6.000 archivados bloqueaba el event loop en cada
// lectura/escritura síncrona de store.ts). Antes de tocar ninguna otra
// colección hay que medir cuáles pesan de verdad -- nunca adivinar.
app.get("/admin/diagnostico_tamanos", requireAdminToken, (_req, res) => {
  const dataDir = process.env.DATA_DIR ?? nodePath.join(process.cwd(), "data");
  const files = nodeFs.readdirSync(dataDir).filter((f) => f.endsWith(".json"));
  const report = files
    .map((f) => {
      const full = nodePath.join(dataDir, f);
      const stat = nodeFs.statSync(full);
      let count: number | null = null;
      try {
        const parsed = JSON.parse(nodeFs.readFileSync(full, "utf8"));
        count = Array.isArray(parsed) ? parsed.length : null;
      } catch {
        count = null;
      }
      return { coleccion: f.replace(/\.json$/, ""), kb: Math.round(stat.size / 1024), registros: count };
    })
    .sort((a, b) => b.kb - a.kb);
  res.json({ status: "ok", colecciones: report });
});

// FALLO REAL grave encontrado 12/11/2026 vía /admin/diagnostico_tamanos:
// chat_conversations.json pesaba 99,5 MB (6.885 conversaciones) -- se lee y
// escribe ENTERO en cada mensaje real de WhatsApp/chat (store.ts es
// síncrono). Mucho más grave que leads.json. No se puede borrar: es
// historial real de clientes. Se archiva (reversible, nunca se borra) lo
// que lleva mucho tiempo sin actividad a una colección aparte que el chat
// en caliente nunca lee, igual que ya se hizo con los leads archivados.
app.post("/admin/chat_conversations/archivar_inactivas", requireAdminToken, (req, res) => {
  const diasInactividad = Number(req.query.dias ?? 45);
  const corte = Date.now() - diasInactividad * 24 * 3600_000;
  const convs = readCollection<{ id: string; updated_at?: string }>("chat_conversations");
  const archivadas = convs.filter((c) => !c.updated_at || new Date(c.updated_at).getTime() < corte);
  const activas = convs.filter((c) => c.updated_at && new Date(c.updated_at).getTime() >= corte);
  if (archivadas.length === 0) {
    res.json({ status: "ok", archivadas: 0, activas: activas.length, nota: "nada por debajo del corte" });
    return;
  }
  const yaArchivadas = readCollection<{ id: string }>("chat_conversations_archive");
  writeCollection("chat_conversations_archive", [...yaArchivadas, ...archivadas]);
  writeCollection("chat_conversations", activas);
  res.json({ status: "ok", archivadas: archivadas.length, activas: activas.length });
});

// tool_call_logs es puro log de diagnóstico (qué tool llamó el agente y
// cuándo) -- sin valor de negocio real pasado un tiempo, a diferencia de
// chat_conversations. Seguro recortar a los últimos N sin archivar.
app.post("/admin/tool_call_logs/recortar", requireAdminToken, (req, res) => {
  const quedarse = Number(req.query.quedarse ?? 2000);
  const logs = readCollection<unknown>("tool_call_logs");
  const antes = logs.length;
  const recortados = logs.slice(-quedarse);
  writeCollection("tool_call_logs", recortados);
  res.json({ status: "ok", borrados: antes - recortados.length, restantes: recortados.length });
});

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

// Reiniciar una conversación de prueba (10/11/2026, "resetea mi
// conversacion que le volvi a escribir y me volvio a enviar un texto" --
// al tocar el tope de turnos, el cierre fijo se repite hasta que el
// contador real se reinicia solo pasadas HORAS_NUEVA_CONVERSACION; esto
// lo hace al momento para seguir probando). Solo borra el HISTORIAL de
// chat de ese contacto -- nunca toca leads, citas ni reservas reales.
app.post("/admin/reset_conversation", requireAdminToken, (req, res) => {
  const contact = String(req.body?.contact ?? "").trim();
  if (!contact) return res.status(400).json({ error: "falta_contact" });
  const conversations = readCollection<{ id: string }>("chat_conversations");
  const antes = conversations.length;
  const restantes = conversations.filter((c) => normalizePhone(c.id) !== normalizePhone(contact) && c.id !== contact);
  writeCollection("chat_conversations", restantes);
  res.json({ status: "ok", borradas: antes - restantes.length });
});

// Cierre masivo de avisos ya confirmados como ruido real (10/11/2026,
// auditoría real: 5.672 de 5.772 avisos eran "no pudo cerrar la respuesta"
// o "cortada al tope de respuestas" del apagón de presupuesto/Gmail/host
// ya diagnosticado y arreglado -- verificado con los logs reales de
// llamadas a herramientas, no supuesto). Marca como "done" (nunca borra,
// reversible reabriendo desde el CRM) solo las que siguen "requested" y
// coinciden con esos dos textos exactos -- nunca toca ninguna otra.
app.post("/admin/cerrar_avisos_ruido_confirmado", requireAdminToken, (req, res) => {
  const soloContar = String(req.query.dry ?? "") === "1";
  const patron = /no pudo cerrar la respuesta|Conversaci[oó]n cortada al llegar al tope/;
  const handoffs = readCollection<{ id: string; status: string; reason?: string | null; done_at?: string | null }>("handoffs");
  const candidatos = handoffs.filter((h) => h.status === "requested" && patron.test(String(h.reason ?? "")));
  if (soloContar) return res.json({ status: "ok", dry_run: true, candidatos: candidatos.length });
  for (const h of candidatos) {
    h.status = "done";
    h.done_at = new Date().toISOString();
  }
  writeCollection("handoffs", handoffs);
  res.json({ status: "ok", cerrados: candidatos.length });
});

// Limpieza puntual (21/10/2026, misma auditoría -- "no sé a qué 84 clientes
// tengo que llamar ya"): las alertas ya existentes de visita_agendada/
// visita_proxima/visita_cancelada se habían acumulado como "pendiente" desde
// antes de que raiseAlert las auto-resolviera (ver alerts.ts) -- se marcan
// aquí una sola vez como atendidas, sin borrarlas, para que el conteo de
// "Llamar ya" refleje de verdad llamadas pendientes, no avisos ya enviados.
// Limpieza del ruido del apagón de IA (09/11/2026). createHandoffFallback
// creaba un pendiente por CADA mensaje que la IA no pudo contestar: 5.511
// pendientes con el mismo motivo, que enterraban los 244 reales y dejaban la
// pantalla de Pendientes inservible. Ya no se vuelven a generar así (ahora
// como máximo uno al día por conversación), pero los acumulados siguen ahí.
// Nunca borra: marca status "done" con una nota, así que es reversible y
// filtrable. Solo toca los que coinciden EXACTAMENTE con ese motivo; con
// ?dry=1 solo cuenta, sin escribir nada.
// CONTENCIÓN del goteo de disculpas (09/11/2026). Aparta ya, sin esperar al
// ciclo del programador, los borradores de la cola del tope diario que son la
// disculpa genérica de la IA caída. NO borra nada: cambian de estado a
// "retenido_para_revision", conservan su texto y generan una tarea para
// contestar a mano. Los borradores legítimos NO se tocan: siguen en cola y se
// envían con normalidad. Con ?dry=1 solo cuenta.
app.post("/admin/retener_borradores_disculpa", requireAdminToken, (req, res) => {
  const soloContar = String(req.query.dry ?? "") === "1";
  const esDisculpa = (m: { draft_note?: string }) => (m.draft_note ?? "").includes("no puedo responderte bien");
  let retenidos = 0;
  let legitimosIntactos = 0;
  if (soloContar) {
    // Solo lectura, sin bloqueo: un recuento no necesita exclusión -- pero sí
    // lee el estado real del disco en este instante, nunca un caché.
    const enCola = readCollection<{ outcome: string; answered?: boolean; draft_note?: string }>("email_inbox").filter((m) => m.outcome === "tope_diario_alcanzado" && !m.answered && m.draft_note);
    retenidos = enCola.filter(esDisculpa).length;
    legitimosIntactos = enCola.length - retenidos;
  } else {
    // Bajo el mismo bloqueo "col_email_inbox" que recordInbox y
    // sendPendingDailyCapEmails (09/11/2026): sin esto, esta ruta podía
    // pisar un correo que el sondeo acababa de registrar, o viceversa.
    mutateCollectionSync<{ id: string; from: string; subject: string; outcome: string; answered?: boolean; draft_note?: string; created_at: string }>("email_inbox", (inbox) => {
      const enCola = inbox.filter((m) => m.outcome === "tope_diario_alcanzado" && !m.answered && m.draft_note);
      const defectuosos = enCola.filter(esDisculpa);
      legitimosIntactos = enCola.length - defectuosos.length;
      for (const m of defectuosos) {
        m.outcome = "retenido_para_revision";
        m.draft_note = `NO ENVIADO (disculpa_generica_de_ia_caida). El cliente sigue sin respuesta: contéstale a mano.\n\nTexto que se habría enviado:\n${m.draft_note ?? ""}`;
        createAutoTask({
          lead_phone: m.from,
          type: "responder_correo",
          reason: `Correo de ${m.from} ("${m.subject || "sin asunto"}") sin responder: el borrador era la disculpa de la IA caída. Contéstale a mano.`,
          source_ref: `retenido_${m.id}`,
          channel: "EMAIL",
        });
      }
      retenidos = defectuosos.length;
      return inbox;
    });
  }
  res.json({ status: "ok", dry_run: soloContar, retenidos, legitimos_intactos: legitimosIntactos });
});

const MOTIVO_RUIDO_IA = "no pudo cerrar la respuesta";
app.post("/admin/archive_ia_outage_handoffs", requireAdminToken, (req, res) => {
  const soloContar = String(req.query.dry ?? "") === "1";
  const esRuido = (h: { reason?: string; status: string }) => h.status !== "done" && (h.reason ?? "").toLowerCase().includes(MOTIVO_RUIDO_IA);
  let archivados = 0;
  let pendientesRealesIntactos = 0;
  if (soloContar) {
    const handoffs = readCollection<{ reason?: string; status: string }>("handoffs");
    archivados = handoffs.filter(esRuido).length;
    pendientesRealesIntactos = handoffs.filter((h) => h.status !== "done" && !esRuido(h)).length;
  } else {
    // Bajo bloqueo (09/11/2026): un archivado masivo que relee y reescribe
    // la lista entera podía perder un handoff creado por un cliente real
    // justo mientras se ejecutaba (createAutoTask/create_handoff van por
    // appendToCollection, que ya toma este mismo bloqueo).
    mutateCollectionSync<{ reason?: string; status: string; done_at?: string | null; notes?: string }>("handoffs", (handoffs) => {
      pendientesRealesIntactos = handoffs.filter((h) => h.status !== "done" && !esRuido(h)).length;
      for (const h of handoffs) {
        if (!esRuido(h)) continue;
        h.status = "done";
        h.done_at = new Date().toISOString();
        h.notes = `${h.notes ? `${h.notes} -- ` : ""}Archivado en bloque: ruido del apagón de IA del 05/11/2026, nunca fue una gestión real.`;
        archivados++;
      }
      return handoffs;
    });
  }
  res.json({ status: "ok", dry_run: soloContar, archivados, pendientes_reales_intactos: pendientesRealesIntactos });
});

app.post("/admin/resolve_routine_alerts", requireAdminToken, (_req, res) => {
  const SELF_RESOLVING = new Set(["visita_agendada", "visita_proxima", "visita_cancelada"]);
  const alerts = readCollection<{ kind: string; status: string; done_at: string | null }>("alerts");
  let changed = 0;
  for (const a of alerts) {
    if (a.status === "pendiente" && SELF_RESOLVING.has(a.kind)) {
      a.status = "atendida";
      a.done_at = new Date().toISOString();
      changed++;
    }
  }
  if (changed > 0) writeCollection("alerts", alerts);
  res.json({ status: "ok", changed });
});

// Corrección puntual (23/10/2026, "siguen sin salirme los leads"): 108 de
// 119 leads reales aparecieron archivados en producción, la mayoría a los
// 0-1 días de creados -- imposible por el corte real de
// LEAD_ARCHIVE_INACTIVE_DAYS (45 días), así que no es un archivado legítimo.
// Nada se perdió (archivado solo oculta de la vista principal, nunca
// borra), pero no tenía sentido obligar a desarchivar uno por uno. Solo
// desarchiva los que no llevan de verdad 45 días reales sin actividad --
// un archivado legítimo (si alguno lo fuera) se queda como está.
app.post("/admin/fix_bad_auto_archive", requireAdminToken, (_req, res) => {
  const DAYS = 45;
  const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  const leads = readCollection<{ archived?: boolean; updated_at?: string; created_at: string }>("leads");
  let changed = 0;
  for (const l of leads) {
    if (!l.archived) continue;
    const lastActivity = new Date(l.updated_at ?? l.created_at).getTime();
    if (Number.isFinite(lastActivity) && lastActivity >= cutoff) {
      l.archived = false;
      changed++;
    }
  }
  if (changed > 0) writeCollection("leads", leads);
  res.json({ status: "ok", changed, total_leads: leads.length });
});

// Mismo camino que el botón "Restaurar" de /crm/papelera, pero sin sesión
// del CRM -- para restaurar puntualmente desde fuera (23/10/2026).
app.post("/admin/restore_from_trash", requireAdminToken, (req, res) => {
  const ids: string[] = Array.isArray(req.body?.trash_ids) ? req.body.trash_ids : [];
  let restored = 0;
  for (const id of ids) {
    if (restoreFromTrash(id)) restored++;
  }
  res.json({ status: "ok", restored, requested: ids.length });
});

// Mismo interruptor que "Activar a Carolina aquí" en /crm/integraciones,
// sin pasar por sesión (23/10/2026, tras reponer Zernio).
app.post("/admin/whatsapp_agent/:enabled", requireAdminToken, (req, res) => {
  setWhatsappZernioAgentEnabled(req.params.enabled === "activar", "admin-token");
  res.json({ status: "ok", whatsapp_agent_enabled: isWhatsappZernioAgentEnabled(), email_auto_send_enabled: isEmailAutoSendEnabled() });
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

// Incidente real (03/11/2026, "y si te dije que crees la plantilla de meta
// para solucionar eso"): TODOS los avisos reales a Ramón/José por WhatsApp
// llevaban fallando siempre (DIRECT_SEND_NOT_ELIGIBLE) porque Meta exige
// una plantilla aprobada para que el negocio escriba primero. Acción de
// una sola vez: crea la plantilla real en Meta vía Zernio. Queda pendiente
// de revisión de Meta (nunca instantáneo) -- usar /admin/zernio/team-alert-template-status
// para comprobar cuándo pase a APPROVED.
app.post("/admin/zernio/create-team-alert-template", requireAdminToken, route(async () => createTeamAlertTemplate()));
app.post("/admin/zernio/create-client-reminder-template", requireAdminToken, route(async () => createClientReminderTemplate()));
app.get("/admin/zernio/client-reminder-template-status", requireAdminToken, route(async () => {
  const id = getClientReminderTemplateId();
  if (!id) return { ok: false, error: "plantilla_no_creada_todavia" };
  return { ok: true, templateId: id, status: await clientReminderTemplateStatus(id) };
}));
// Catch-up puntual (11/11/2026, "las citas de hoy que quedaron sin aviso"):
// notifyVisitScheduled solo se dispara UNA VEZ al crear la cita -- las
// citas de hoy creadas antes de que la plantilla de aviso interno existiera
// (03-04/11) nunca llegaron a avisar a Ramón/José. Reenvía solo las citas
// confirmadas de hoy que todavía no tengan ningún "sent" de hoy mismo.
// Prueba a petición real (11/11/2026, "antes de nada, envíamelas a mí
// primero"): mismo texto/formato real que recibirían Ramón/José, pero
// enviado solo al número de pruebas (TECHNICAL_ALERT_PHONE) -- nunca toca
// team_notifications real ni resuelve handoffs, para no mezclarse con el
// reenvío real de /admin/avisar_citas_de_hoy.
app.post("/admin/test_avisar_citas_de_hoy", requireAdminToken, route(async (a: { horas?: string[] }) => {
  const testPhone = process.env.TECHNICAL_ALERT_PHONE?.trim();
  if (!testPhone) return { ok: false, error: "TECHNICAL_ALERT_PHONE_no_configurado" };
  const hoy = new Date().toISOString().slice(0, 10);
  const appts = readCollection<{ id: string; lead_phone?: string; vehicle_id?: string; requested_date?: string; requested_time?: string; status: string }>("appointments");
  const notifs = readCollection<{ lead_phone?: string | null; delivery_status: string; created_at: string }>("team_notifications");
  const horasPedidas = a.horas && a.horas.length > 0 ? new Set(a.horas) : null;
  const citasHoy = appts.filter((x) => {
    if (x.requested_date !== hoy || x.status !== "confirmed") return false;
    if (horasPedidas) return horasPedidas.has(x.requested_time ?? "");
    const t = x.requested_time ?? "";
    return !/^\d{2}:\d{2}$/.test(t) || t >= "11:00";
  });
  const yaAvisadas = new Set(notifs.filter((n) => n.delivery_status === "sent" && n.created_at.startsWith(hoy)).map((n) => n.lead_phone ?? ""));
  const resultados: unknown[] = [];
  for (const appt of citasHoy) {
    if (yaAvisadas.has(appt.lead_phone ?? "")) continue;
    const name = readCollection<{ phone: string | null; name: string | null }>("leads").find((l) => l.phone === appt.lead_phone)?.name?.trim() || "sin nombre";
    const contact = !appt.lead_phone ? name : name === "sin nombre" ? appt.lead_phone : `${name} (${appt.lead_phone})`;
    const vehicle = currentVehicles().find((v) => v.id === appt.vehicle_id);
    const vehicleStr = vehicle ? `${vehicle.make} ${vehicle.model} ${vehicle.version}` : (appt.vehicle_id ?? "sin vehículo indicado");
    const when = appt.requested_date && appt.requested_time ? `${appt.requested_date} a las ${appt.requested_time}` : appt.requested_date || "fecha por confirmar";
    const texto = `[PRUEBA -- iría a Ramón/José] 📅 Nueva visita -- ${contact} -- ${vehicleStr} -- ${when}`;
    const r = await sendTeamAlertViaTemplate(testPhone, texto);
    resultados.push({ lead_phone: appt.lead_phone, texto, ok: r.ok, error: r.ok ? null : r.error });
  }
  return { ok: true, fecha: hoy, enviadas_a_prueba: resultados };
}));
// Petición real (11/11/2026, "las que tienen visitas del coche no
// disponible borralas mejor"): mueve a la papelera (recuperable, nunca
// borrado permanente -- mismo criterio que todo el resto del CRM) las
// citas de hoy cuyo vehículo ya no está en el catálogo real.
// Rectificación puntual (11/11/2026, fallo real propio: el aviso anterior de
// "coche vendido" se basó en comparar vehicle_id contra el catálogo actual,
// pero el catálogo cambió de esquema de IDs (de UUID a "lucero-dealcar-N")
// tras una reimportación, así que NINGUNA cita de hoy tenía de verdad el
// coche vendido -- el aviso fue un falso positivo del propio sistema).
app.get("/admin/zernio/estado_real_entrega", requireAdminToken, async (req, res) => {
  const conversationId = String(req.query.conversation_id ?? "");
  if (!conversationId) return res.status(400).json({ ok: false, error: "conversation_id_requerido" });
  const limit = parseInt(String(req.query.limit ?? "10"), 10);
  res.json(await getRealDeliveryStatus(conversationId, Number.isFinite(limit) ? limit : 10));
});
app.post("/admin/aviso_equipo_texto_libre", requireAdminToken, route(async (a: { texto: string }) => {
  const resultados: unknown[] = [];
  for (const member of team()) {
    const r = await sendTeamAlertViaTemplate(member.phone, a.texto);
    resultados.push({ to: member.name, ok: r.ok, error: r.ok ? null : r.error });
  }
  return { ok: true, resultados };
}));
// DESACTIVADA (11/11/2026, fallo real propio): esta ruta comparaba
// vehicle_id de la cita contra currentVehicles() para decidir si el coche
// "ya no está disponible" -- pero el catálogo cambió de esquema de IDs (de
// UUID a "lucero-dealcar-N") tras una reimportación, así que TODA cita
// creada antes de ese cambio da igual un falso "no disponible", esté o no
// vendido el coche de verdad. Se ejecutó una vez por error con este
// criterio y avisó a Ramón/José de una venta falsa en las 6 citas de hoy --
// ya corregido (restauradas de papelera + aviso de rectificación enviado).
// Queda desactivada hasta tener una forma fiable de saber si un coche
// concreto se vendió (no solo que su id viejo ya no aparece en el feed).
app.post("/admin/trash_citas_vehiculo_no_disponible", requireAdminToken, route(async () => {
  return { ok: false, error: "ruta_desactivada_criterio_no_fiable" };
}));
app.post("/admin/avisar_citas_de_hoy", requireAdminToken, route(async () => {
  const hoy = new Date().toISOString().slice(0, 10);
  const appts = readCollection<{ id: string; lead_phone?: string; vehicle_id?: string; requested_date?: string; requested_time?: string; status: string; channel?: string | null }>("appointments");
  const notifs = readCollection<{ lead_phone?: string | null; delivery_status: string; created_at: string }>("team_notifications");
  const citasHoy = appts.filter((a) => {
    if (a.requested_date !== hoy || a.status !== "confirmed") return false;
    const t = a.requested_time ?? "";
    return !/^\d{2}:\d{2}$/.test(t) || t >= "11:00";
  });
  const yaAvisadas = new Set(
    notifs.filter((n) => n.delivery_status === "sent" && n.created_at.startsWith(hoy)).map((n) => n.lead_phone ?? ""),
  );
  const reenviadas: string[] = [];
  const saltadas: { lead_phone?: string; motivo: string }[] = [];
  for (const appt of citasHoy) {
    if (yaAvisadas.has(appt.lead_phone ?? "")) continue;
    // FALLO REAL propio corregido (11/11/2026): este filtro comparaba
    // vehicle_id contra currentVehicles() para adivinar si el coche "ya no
    // está disponible", pero el catálogo cambió de esquema de IDs tras una
    // reimportación -- cualquier cita anterior a ese cambio daba falso
    // "vendido" sin que el coche lo estuviera de verdad. Quitado (ver
    // /admin/trash_citas_vehiculo_no_disponible, desactivada por el mismo
    // motivo).
    await notifyVisitScheduled({ lead_phone: appt.lead_phone ?? null, vehicle_id: appt.vehicle_id, requested_date: appt.requested_date, requested_time: appt.requested_time, channel: appt.channel ?? null });
    reenviadas.push(appt.lead_phone ?? appt.id);
  }
  return { ok: true, fecha: hoy, total_citas_hoy: citasHoy.length, reenviadas, saltadas };
}));
app.post("/admin/zernio/team-alert-template-status", requireAdminToken, route(async (a: { template_id: string }) => ({
  status: await teamAlertTemplateStatus(a.template_id),
})));

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
// Función, no una constante de módulo (26/10/2026) -- así un teléfono
// editado desde Ajustes se tiene en cuenta al momento, sin reiniciar.
function teamPhones(): Set<string> {
  const cfg = getBusinessConfig();
  return new Set([cfg.ramonPhone.replace(/[^\d]/g, ""), cfg.josePhone.replace(/[^\d]/g, "")]);
}
app.post(
  "/admin/zernio/process-whatsapp-backlog",
  requireAdminToken,
  route(async (a: { limit?: number; max_age_hours?: number; approved?: Array<{ phone: string; text: string }> }) => {
    // FALLO REAL detectado (28/10/2026, mismo caso que replay_single_whatsapp
    // más abajo -- Carlos, HYUNDAI ix55): dry_run:false volvía a llamar a
    // handleChatMessage para enviar, así que el texto aprobado en la vista
    // previa y el que de verdad se mandaba podían ser DISTINTOS (la
    // conversación avanza de verdad en cada llamada real, no es una
    // función pura). Ahora solo existe un modo de envío: pasar "approved"
    // con los pares {phone, text} EXACTOS ya revisados -- nunca se vuelve
    // a generar nada, solo se envía tal cual. Sin "approved", esto sigue
    // siendo siempre una vista previa, nunca envía nada de verdad.
    if (a.approved && a.approved.length > 0) {
      const report: Array<Record<string, unknown>> = [];
      for (const item of a.approved) {
        const sent = await sendWhatsappText(item.phone, item.text);
        report.push({ phone: item.phone, respuesta: item.text, enviado: sent.ok, error_envio: sent.ok ? null : sent.error });
      }
      return { status: "ok", modo: "envio_aprobado", report };
    }

    const limit = a.limit ?? 100;
    const maxAgeHours = a.max_age_hours ?? 24;

    const convsResult = await listRecentWhatsappConversations(limit);
    if (!convsResult.ok) return { status: "error", error: convsResult.error };

    const now = Date.now();
    const report: Array<Record<string, unknown>> = [];
    const teamPhonesSet = teamPhones();

    for (const c of convsResult.conversations) {
      if (teamPhonesSet.has(c.phone)) {
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
        report.push({ phone: c.phone, name: c.name, pregunta: lastIncoming.text, respuesta_propuesta: chatResult.reply, enviado: false });
      } catch (err) {
        report.push({ phone: c.phone, name: c.name, saltado: `error_agente: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    return { status: "ok", modo: "vista_previa", total_conversaciones: convsResult.conversations.length, report };
  }),
);

// Caso real (28/10/2026, Carlos -- HYUNDAI ix55, "ni siquiera veo la
// respuesta de Daniel"): a diferencia del backlog de arriba (clientes que
// YA escribieron algo real en WhatsApp), este es el caso de un cliente
// que escribió por correo (Coches.net, "contacto solo por WhatsApp") y a
// quien se le abrió la conversación con la plantilla aprobada, pero cuya
// pregunta real nunca llegó a contestarse (fallo ya corregido para los
// casos nuevos, ver email/agent.ts) -- aquí no hay ningún mensaje
// entrante real en WhatsApp que leer, así que process-whatsapp-backlog no
// lo detecta. Mismo cerebro real (handleChatMessage) y mismo criterio de
// seguridad (send por defecto false, para revisar antes de mandar nada a
// un cliente real).
app.post(
  "/admin/replay_single_whatsapp",
  requireAdminToken,
  route(async (a: { phone: string; user_text?: string; send_text?: string; vehicle_label?: string }) => {
    if (!a.phone) return { status: "error", error: "falta_phone" };
    const phone = a.phone.startsWith("+") ? a.phone : `+${a.phone}`;
    // FALLO REAL detectado (28/10/2026, caso real: Carlos -- el mensaje que
    // se enseñó y se aprobó, y el que de verdad le llegó al cliente,
    // fueron DISTINTOS): handleChatMessage no es una función pura, cada
    // llamada avanza la conversación de verdad (guarda turno, puede
    // responder distinto la segunda vez) -- generar la respuesta dos
    // veces (una para enseñarla, otra al confirmar el envío) podía dar
    // dos textos diferentes, y el que se mandaba era el segundo, nunca
    // revisado. Ahora solo hay UNA generación real: send_text manda
    // EXACTAMENTE el texto ya aprobado, sin volver a preguntarle nada al
    // agente.
    if (a.send_text) {
      // Caso real (28/10/2026, "LA RUTA" -- AUDI Q3): a diferencia de
      // Carlos, aquí nunca llegó a abrirse ninguna conversación real
      // (llegó antes de que Meta aprobara la plantilla) -- un envío de
      // texto normal fallaría siempre sin conversación abierta. Si hace
      // falta, se abre primero con la plantilla real ya aprobada (mismo
      // camino real que usa email/agent.ts), y solo entonces se manda el
      // texto aprobado.
      if (!findWhatsappConversation(phone) && a.vehicle_label) {
        const templateSent = await sendZernioWhatsappVehicleContactTemplate(phone, a.vehicle_label);
        if (!templateSent.ok) return { status: "ok", enviado: false, error_envio: `no se pudo abrir la conversación: ${templateSent.error}` };
      }
      const sent = await sendWhatsappText(phone, a.send_text);
      return { status: "ok", enviado: sent.ok, respuesta: a.send_text, error_envio: sent.ok ? null : sent.error };
    }
    if (!a.user_text) return { status: "error", error: "falta_user_text_o_send_text" };
    const chatResult = await handleChatMessage(phone, a.user_text, "WHATSAPP", phone);
    return { status: "ok", enviado: false, respuesta_propuesta: chatResult.reply };
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

// Ampliado a ?limit=all (28/10/2026, mismo motivo que ya tuvieron el resto
// de /debug/* -- este también estaba fijo en 50, escondiendo fallos reales
// más antiguos al diagnosticar un problema real de envío de correos).
app.get("/email/outbox", requireAdminToken, debugSlice("email_outbox", 50));

app.get("/email/inbox", requireAdminToken, (_req, res) => {
  res.json(readCollection<unknown>("email_inbox").slice(-50));
});

// Depuración real (15/10/2026, a petición de "esta mal, arregla eso" tras
// una recurrencia del fallback en producción): permite ver exactamente qué
// llamó el agente y en qué conversación, sin tener que adivinar leyendo el
// store a mano. Solo lectura, con token de admin.
// ?limit=N (27/10/2026, "todos los mensajes, me tienen que aparecer
// actualizados... todos"): por defecto se corta a los últimos N para no
// devolver colecciones enormes sin pedirlo, pero un límite fijo sin forma
// de pedir más escondía mensajes reales más antiguos que sí hacía falta
// ver. limit=0 o "all" devuelve la colección completa.
function debugLimit(req: express.Request, def: number, max = 2000): number {
  const raw = String(req.query.limit ?? "").trim().toLowerCase();
  if (raw === "all" || raw === "0") return Infinity;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}
function debugSlice<T>(collection: string, def: number) {
  return (req: express.Request, res: express.Response) => {
    const limit = debugLimit(req, def);
    const all = readCollection<T>(collection);
    res.json(Number.isFinite(limit) ? all.slice(-limit) : all);
  };
}
app.get("/debug/tool_call_logs", requireAdminToken, debugSlice("tool_call_logs", 200));
app.get("/debug/chat_conversations", requireAdminToken, debugSlice("chat_conversations", 50));
app.get("/debug/call_analyses", requireAdminToken, debugSlice("call_analyses", 50));
app.get("/debug/studio_jobs", requireAdminToken, debugSlice("studio_jobs", 50));
app.get("/debug/alerts", requireAdminToken, debugSlice("alerts", 50));
app.get("/debug/whatsapp_retry_jobs", requireAdminToken, debugSlice("whatsapp_retry_jobs", 20));
app.get("/debug/n8n_voz_outbox", requireAdminToken, debugSlice("n8n_voz_outbox", 100));
// Reintento real del backlog de 199 alertas de HOY (03/11/2026, ver
// src/alerts/whatsapp-retry.ts para el detalle completo del porqué): el
// bug que las causó ya está corregido en src/email/agent.ts, esto solo
// reprocesa lo que quedó pendiente de ANTES del arreglo. Responde YA
// (nunca mantiene la petición abierta durante el lote, que puede tardar
// hasta ~2h) y sigue en segundo plano -- progreso real consultable en
// GET /debug/whatsapp_retry_jobs mientras corre.
app.post("/admin/retry_gestion_portal_whatsapp", requireAdminToken, async (req, res) => {
  const onlyPhones = Array.isArray(req.body?.phones) ? req.body.phones.filter((p: unknown) => typeof p === "string") : undefined;
  const result = await startGestionPortalWhatsappRetry(onlyPhones);
  res.json(result);
});
// Petición real (03/11/2026, "los demás elimínalos" -- tras contactar a los
// 10 con intención real confirmada, el dueño decidió no contactar al resto):
// mismo patrón real ya usado en el CRM (crm/app.ts, "/alertas-masivo") --
// nunca borra de verdad, mueve a la papelera (moveToTrash), reversible.
app.post("/admin/delete_gestion_portal_whatsapp_pendientes", requireAdminToken, (_req, res) => {
  const rows = readCollection<{ id: string; reason: string; name: string | null; lead_phone: string | null; status: string }>("alerts");
  const targets = rows.filter((a) => a.status === "pendiente" && (a.reason ?? "").includes("Meta todavía no permite"));
  for (const a of targets) {
    if (deleteAlert(a.id)) moveToTrash("alerts", a, `Alerta: ${a.reason} (${a.name ?? a.lead_phone ?? "sin contacto"})`, "admin-token");
  }
  res.json({ movidas_a_papelera: targets.length });
});
app.get("/debug/reservations", requireAdminToken, debugSlice("reservations", 50));
app.get("/debug/leads", requireAdminToken, debugSlice("leads", 200));
app.get("/debug/appointments", requireAdminToken, debugSlice("appointments", 100));

app.get("/debug/crm_users", requireAdminToken, (_req, res) => {
  res.json(listUsers().map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, created_at: u.created_at })));
});

app.get("/debug/facebook_processed", requireAdminToken, debugSlice("facebook_processed", 100));
app.get("/debug/handoffs", requireAdminToken, debugSlice("handoffs", 100));
app.get("/debug/zernio_whatsapp_conversations", requireAdminToken, debugSlice("zernio_whatsapp_conversations", 200));
app.get("/debug/whatsapp_inbox", requireAdminToken, debugSlice("whatsapp_inbox", 50));
app.get("/debug/email_inbox", requireAdminToken, debugSlice("email_inbox", 50));
app.get("/debug/email_processed", requireAdminToken, debugSlice("email_processed", 50));
app.get("/debug/zernio_whatsapp_processed", requireAdminToken, debugSlice("zernio_whatsapp_processed", 50));

// Puntual (24/10/2026, para reprobar un evento real tras poner OPENAI_API_KEY):
// un reenvío de Zernio se descarta en silencio si el eventId ya está en esta
// colección, aunque la primera vez nunca haya llegado a responder.
app.post("/admin/clear_zernio_processed", requireAdminToken, (req, res) => {
  const keys: string[] = Array.isArray(req.body?.keys) ? req.body.keys : [];
  const rows = readCollection<{ key: string; at: string }>("zernio_whatsapp_processed");
  const kept = keys.length > 0 ? rows.filter((r) => !keys.includes(r.key)) : [];
  writeCollection("zernio_whatsapp_processed", kept);
  res.json({ status: "ok", removed: rows.length - kept.length, remaining: kept.length });
});

// Puntual (27/10/2026, para corregir leads reales con channel/origin
// corrompidos por el fallo real de CHANNEL_LABEL filtrándose como valor
// de "channel" -- ver chat/agent.ts): upsert_lead ya corrige "channel",
// pero "origin" se fija una vez a propósito (no cambia solo porque el
// cliente hable después por otro canal) -- aquí sí se puede forzar, solo
// con token de admin, solo para corregir un dato ya roto, nunca para el
// flujo normal.
app.post("/admin/fix_lead_origin", requireAdminToken, (req, res) => {
  const phone = typeof req.body?.phone === "string" ? req.body.phone : null;
  const origin = typeof req.body?.origin === "string" ? req.body.origin : null;
  if (!phone || !origin) {
    res.status(400).json({ error: "bad_request", need: ["phone", "origin"] });
    return;
  }
  const leads = readCollection<{ phone: string | null; origin?: string | null }>("leads");
  const lead = leads.find((l) => l.phone === phone);
  if (!lead) {
    res.status(404).json({ error: "lead_not_found" });
    return;
  }
  lead.origin = origin;
  writeCollection("leads", leads);
  res.json({ status: "ok", phone, origin });
});

app.get("/debug/team_notifications", requireAdminToken, debugSlice("team_notifications", 200));
// Diagnóstico temporal (05/11/2026): get_appointment_slots está devolviendo
// cero huecos en los últimos 10 días a pesar de haber agenda real libre --
// esta ruta llama a calendarBusy directamente y devuelve el error real en
// vez de tragárselo, para encontrar la causa real.
app.get("/debug/calendar_busy_raw", requireAdminToken, async (_req, res) => {
  try {
    const now = new Date();
    const in3Days = new Date(now.getTime() + 3 * 24 * 3600 * 1000);
    const busy = await calendarBusy(now.toISOString(), in3Days.toISOString());
    res.json({ ok: true, timeMin: now.toISOString(), timeMax: in3Days.toISOString(), busy });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err), descripcion: describeGoogleError(err) });
  }
});
app.get("/debug/calendar_events_raw", requireAdminToken, async (_req, res) => {
  try {
    const now = new Date();
    const in10Days = new Date(now.getTime() + 10 * 24 * 3600 * 1000);
    const items = await calendarListEvents(now.toISOString(), in10Days.toISOString());
    res.json({ ok: true, timeMin: now.toISOString(), timeMax: in10Days.toISOString(), items });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err), descripcion: describeGoogleError(err) });
  }
});
app.get("/debug/email_poller_errors", requireAdminToken, debugSlice("email_poller_errors", 50));
app.get("/debug/whatsapp_errors", requireAdminToken, debugSlice("whatsapp_errors", 50));
// Diagnóstico real de verdad (03/11/2026, incidente real: el sondeo no
// registraba errores pero clientes reales (caso Juan) no se contestaban)
// -- solo lectura, muestra exactamente qué ve Gmail ahora mismo, sin
// procesar nada.
app.get("/debug/gmail_unread_now", requireAdminToken, async (_req, res) => {
  try {
    const list = await gmailListUnread();
    const sample = await Promise.all(list.slice(0, 15).map((m) => gmailGet(m.id).catch((e) => ({ id: m.id, error: e instanceof Error ? e.message : String(e) }))));
    res.json({ total_no_leidos: list.length, muestra: sample });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
// Añadido (03/11/2026, "pero no correos de nuestro sistema, si no correos de
// las plataformas reales" -- verificar contra Gmail EN VIVO, no contra lo
// que nuestro propio log interno (email_inbox) dice que procesó, para
// descartar que el log esté inflado por algo nuestro). Usa Gmail Search
// Operators reales (from:/after:), igual que el resto del sistema -- nunca
// cuenta sobre datos propios cuando puede comprobar la fuente real.
app.get("/debug/gmail_real_count_today", requireAdminToken, async (_req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
    const [cochesnet, wallapop] = await Promise.all([
      gmailSearch(`from:coches.net after:${today}`, 500),
      gmailSearch(`from:wallapop.com after:${today}`, 500),
    ]);
    res.json({ fecha: today, cochesnet_hoy: cochesnet.length, wallapop_hoy: wallapop.length, total_hoy: cochesnet.length + wallapop.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
// Uso puntual real (04/11/2026, "pero se lo enviaste a los clientes?" --
// comprobado: 2 recordatorios de hoy fallaron de verdad y quedaron
// marcados como enviados por el fallo ya corregido arriba) -- permite
// reintentar un recordatorio concreto sin esperar al siguiente ciclo.
// Uso puntual real (05/11/2026, "activalo para probarlo" -- la propia
// conversación de prueba cruzó el tope de 4 respuestas y queda bloqueada
// con el mismo cierre fijo 3 horas). Reinicia una conversación concreta
// al instante -- borra el historial de chat guardado para ese
// identificador (teléfono o "mail:..."), nunca toca leads/citas/avisos
// reales, solo el estado de la propia conversación con la IA.
app.post("/admin/reset_chat_conversation", requireAdminToken, (req, res) => {
  const { session_id } = req.body ?? {};
  if (typeof session_id !== "string") {
    res.status(400).json({ error: "session_id requerido" });
    return;
  }
  const conversaciones = readCollection<{ id: string }>("chat_conversations");
  const sinEsa = conversaciones.filter((c) => c.id !== session_id);
  writeCollection("chat_conversations", sinEsa);
  res.json({ ok: true, session_id, existia: sinEsa.length !== conversaciones.length });
});
app.post("/admin/reset_appointment_reminder", requireAdminToken, (req, res) => {
  const { appointment_id, field } = req.body ?? {};
  if (typeof appointment_id !== "string" || !["reminder_24h_sent", "reminder_6h_sent", "reminder_1h_sent"].includes(field)) {
    res.status(400).json({ error: "appointment_id y field (reminder_24h_sent|reminder_6h_sent|reminder_1h_sent) requeridos" });
    return;
  }
  let existia = false;
  mutateCollectionSync<Record<string, unknown>>("appointments", (appts) => {
    const appt = appts.find((a) => a.id === appointment_id);
    if (appt) {
      appt[field] = false;
      existia = true;
    }
    return appts;
  });
  if (!existia) {
    res.status(404).json({ error: "cita no encontrada" });
    return;
  }
  res.json({ ok: true, appointment_id, field });
});
// Envío inmediato real (04/11/2026, "y recuerdales la visita" -- la ventana
// de "6h antes" ya había pasado para el caso real de hoy, así que resetear
// el flag no bastaba para que el scheduler lo reintentara). Reutiliza el
// mismo deliverEmail/sendWhatsapp reales -- nunca inventa un canal nuevo,
// solo salta la comprobación de ventana horaria para un caso puntual.
app.post("/admin/send_appointment_reminder_now", requireAdminToken, async (req, res) => {
  const { appointment_id } = req.body ?? {};
  if (typeof appointment_id !== "string") {
    res.status(400).json({ error: "appointment_id requerido" });
    return;
  }
  const appts = readCollection<{ id: string; lead_phone?: string; requested_time?: string }>("appointments");
  const appt = appts.find((a) => a.id === appointment_id);
  if (!appt || !appt.lead_phone) {
    res.status(404).json({ error: "cita no encontrada o sin teléfono/correo real" });
    return;
  }
  const message = `Recordatorio: hoy tienes una cita en Automóviles Lucero a las ${appt.requested_time}.`;
  if (appt.lead_phone.includes("@")) {
    const result = await deliverEmail(appt.lead_phone, "Recordatorio de tu visita -- Automóviles Lucero", `${message}\n\nAutomóviles Lucero`);
    res.json({ enviado: result.status === "sent", detalle: result });
  } else {
    const result = await sendWhatsapp({ lead_phone: appt.lead_phone, message });
    res.json({ enviado: result.status === "ok", detalle: result });
  }
});
// Uso puntual real (05/11/2026, "le estoy escribiendo por whassap y no me
// responde" -- causa real: el propio número de prueba quedó pausado desde
// el 3/11 y nadie se acordaba). Reanudar un chat pausado sin tener que
// entrar al CRM con sesión.
app.post("/admin/reanudar_chat_whatsapp", requireAdminToken, (req, res) => {
  const { phone } = req.body ?? {};
  if (typeof phone !== "string") {
    res.status(400).json({ error: "phone requerido" });
    return;
  }
  setWhatsappChatPaused(phone.replace(/^\+/, ""), false, "admin-token");
  res.json({ ok: true, phone, pausado: isWhatsappChatPaused(phone.replace(/^\+/, "")) });
});
app.get("/debug/llm_usage_logs", requireAdminToken, debugSlice("llm_usage_logs", 500));
// Resumen real de consumo por canal (04/11/2026, "a lo mejor cambio de
// cuentas porque tampoco me marca el consumo que tiene cada agente" --
// OpenAI no separa el gasto por canal en su propio panel). Tokens: dato
// real devuelto por la propia API en cada llamada (ver agent.ts,
// recordLlmUsage). Euros: ESTIMADO con el precio público de gpt-4.1-mini
// (no facturado por OpenAI en este sistema, solo un cálculo orientativo) --
// nunca se presenta como el cobro real, que solo lo tiene el panel de
// OpenAI.
app.get("/debug/llm_usage_resumen", requireAdminToken, (_req, res) => {
  const PRECIO_INPUT_POR_1M = 0.4;
  const PRECIO_CACHED_POR_1M = 0.1;
  const PRECIO_OUTPUT_POR_1M = 1.6;
  const log = readCollection<{ channel: string; prompt_tokens: number; completion_tokens: number; cached_tokens: number; at: string }>("llm_usage_logs");
  const today = new Date().toISOString().slice(0, 10);
  const porCanal: Record<string, { llamadas: number; prompt_tokens: number; cached_tokens: number; completion_tokens: number }> = {};
  for (const r of log) {
    if (!r.at.startsWith(today)) continue;
    const c = (porCanal[r.channel] ??= { llamadas: 0, prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0 });
    c.llamadas++;
    c.prompt_tokens += r.prompt_tokens;
    c.cached_tokens += r.cached_tokens;
    c.completion_tokens += r.completion_tokens;
  }
  const resumen = Object.fromEntries(
    Object.entries(porCanal).map(([canal, c]) => {
      const tokensNoCacheados = Math.max(0, c.prompt_tokens - c.cached_tokens);
      const eurEstimado = (tokensNoCacheados / 1_000_000) * PRECIO_INPUT_POR_1M + (c.cached_tokens / 1_000_000) * PRECIO_CACHED_POR_1M + (c.completion_tokens / 1_000_000) * PRECIO_OUTPUT_POR_1M;
      return [canal, { ...c, porcentaje_cacheado: c.prompt_tokens > 0 ? Math.round((c.cached_tokens / c.prompt_tokens) * 100) : 0, eur_estimado: Math.round(eurEstimado * 10000) / 10000 }];
    }),
  );
  res.json({ fecha: today, por_canal: resumen, nota: "eur_estimado es orientativo (precio público gpt-4.1-mini), no el cobro real de OpenAI" });
});
app.get("/debug/trash", requireAdminToken, debugSlice("trash", 200));
app.get("/debug/whatsapp_chat_pauses", requireAdminToken, debugSlice("whatsapp_chat_pauses", 200));
app.get("/debug/agent_toggles", requireAdminToken, debugSlice("agent_toggles", 50));
// Comprobación real de solo lectura (28/10/2026, "para que carolina pueda
// enviar mensajes a las personas que... no hayan escrito antes a
// whatsapp"): la plantilla real ya está construida y conectada
// (sendZernioWhatsappVehicleContactTemplate, en email/agent.ts) -- esto
// solo consulta su estado real en Meta, nunca se asume aprobada. Vive
// aquí (no en una variable local ni extrayendo la credencial a mano)
// porque la propia credencial real de Zernio ya vive de forma segura en
// este servidor, nunca hace falta sacarla fuera.
app.get("/debug/plantilla_whatsapp_estado", requireAdminToken, async (_req, res) => {
  res.json({ contacto_inicial_vehiculo_aprobada: await isContactoInicialTemplateApproved() });
});
// Limpieza puntual real (28/10/2026, dato de prueba de la landing nueva
// que acabó en el CRM real por error de pruebas, nunca un cliente real):
// mismo patrón que ya usa el CRM para "eliminar cliente" -- se mueve a la
// papelera (recuperable), nunca se borra para siempre. Solo por teléfono
// exacto, para no arriesgar tocar el lead equivocado.
app.post("/admin/delete_lead_by_phone", requireAdminToken, route((a: { phone: string }) => {
  if (!a.phone) return { status: "error", error: "falta_phone" };
  const target = normalizePhone(a.phone);
  const leads = readCollection<{ id: string; phone?: string; name?: string | null }>("leads");
  const lead = leads.find((l) => l.phone && normalizePhone(l.phone) === target);
  if (!lead) return { status: "ok", encontrado: false };
  moveToTrash("leads", lead, `Cliente: ${lead.name || lead.phone || "sin nombre"}`, "admin-token");
  writeCollection("leads", leads.filter((l) => l.id !== lead.id));
  return { status: "ok", encontrado: true, movido_a_papelera: true };
}));
app.get("/debug/email_contact_pauses", requireAdminToken, debugSlice("email_contact_pauses", 200));
// Diagnóstico puntual (28/10/2026, para confirmar con un correo real de
// Wallapop si el arreglo de plainText/google.ts de verdad rescata
// contenido antes descartado, antes de construir nada encima) -- busca
// directo en Gmail (nunca en lo ya guardado, que se guardó vacío) y
// devuelve el texto real ya extraído con el parser corregido. Solo
// lectura, nunca contesta ni guarda nada.
app.get("/debug/wallapop_raw_sample", requireAdminToken, async (req, res) => {
  const q = typeof req.query.q === "string" && req.query.q ? req.query.q : "from:wallapop.com";
  const found = await gmailSearch(q, 5);
  const messages = await Promise.all(found.map((f) => gmailGet(f.id)));
  res.json(messages.map((m) => ({ id: m.id, subject: m.subject, from: m.from, text: m.text })));
});
// Importar el histórico real de Wallapop (28/10/2026, "ve desplegando los
// numero o correos de wallapop en el sistema... subelos normal como las
// otras secciones, no se te ocurra hacerlo en formato json"): los avisos
// de antes del arreglo de plainText se guardaron con texto vacío para
// siempre (ver email_inbox) -- la única copia real que queda es la de
// Gmail. Se busca ahí directo, se extrae cada contacto real con el mismo
// parser ya usado en producción, y se da de alta como ficha normal de
// cliente (upsertLead) -- igual que cualquier otro lead del CRM, nunca
// un volcado aparte. Deliberadamente NO contacta a nadie por WhatsApp --
// eso es una decisión real aparte, de negocio, sobre avisos que pueden
// tener semanas (algunos clientes ya habrán comprado en otro sitio).
app.post("/admin/wallapop_backlog_import", requireAdminToken, async (_req, res) => {
  const found = await gmailSearch("from:wallapop.com", 500);
  const vistos = new Set<string>();
  let creados = 0;
  let actualizados = 0;
  let sinTelefono = 0;
  const leadsAntes = readCollection<{ phone?: string | null }>("leads");
  const phonesAntes = new Set(leadsAntes.map((l) => l.phone).filter(Boolean));
  for (const f of found) {
    const m = await gmailGet(f.id);
    const contact = extractWallapopContact(m.text);
    if (!contact?.phone) {
      sinTelefono++;
      continue;
    }
    const phone = contact.phone.startsWith("+") ? contact.phone : `+${contact.phone}`;
    const normalized = normalizePhone(phone);
    if (vistos.has(normalized)) continue;
    vistos.add(normalized);
    const vehicleLabel = [contact.make, contact.model, contact.version].filter(Boolean).join(" ");
    upsertLead({
      phone,
      name: contact.name ?? undefined,
      channel: "WHATSAPP",
      vehicle_interest: vehicleLabel || undefined,
      notes: "Aviso histórico real de Wallapop (importado el 28/10/2026) -- pidió contacto por WhatsApp, pendiente de decidir si se le contacta ahora.",
    });
    if (phonesAntes.has(normalized)) actualizados++;
    else creados++;
  }
  res.json({ status: "ok", avisos_reales_encontrados: found.length, clientes_distintos: vistos.size, fichas_creadas: creados, fichas_actualizadas: actualizados, sin_telefono_real: sinTelefono });
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
  // Nota de voz/foto real (27/10/2026, ampliado el mismo día a fotos: "que
  // se pueda ver fotos"): archivo ya descargado y guardado en el volumen
  // persistente (Meta borra el original pronto, nunca se guarda solo la
  // URL de Zernio) -- media_path es el nombre de archivo real dentro de
  // whatsapp_media/, servido por /crm/whatsapp/audio/:archivo (mismo
  // nombre de ruta de siempre, sirve ambos tipos).
  media_path?: string;
  media_type?: "audio" | "image";
  // Adjunto REAL enviado desde el CRM (no recibido) -- distinto de
  // reply_text, que puede ser solo el pie de foto o un texto de respaldo.
  reply_attachment_path?: string;
  reply_attachment_type?: "image" | "audio";
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

  // Reclamo atómico entre procesos (09/11/2026): antes se leía, se
  // comprobaba y más abajo se escribía -- con dos instancias, las dos
  // podían no encontrar la clave y procesar el mismo mensaje dos veces.
  if (!(await claimOnce("whatsapp_processed", dedupeKey, MAX_WHATSAPP_PROCESSED_KEPT))) {
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

  // (la clave ya quedó reclamada arriba con claimOnce)

  // Módulo CRM mensajes/clientes (18/10/2026): registrar el mensaje entrante
  // para que se vea en /crm/whatsapp -- puramente aditivo, en su propio
  // try/catch para que un fallo aquí nunca toque la respuesta ya enviada
  // arriba ni el resto de este webhook (que ya funcionaba de antes). No
  // envía nada nuevo por WhatsApp: el envío sigue igual que siempre, esto
  // solo deja constancia de lo que ya se mandó o se intentó mandar.
  const whatsappInboxId = crypto.randomUUID();
  try {
    // Bajo bloqueo (09/11/2026): dos mensajes entrantes casi simultáneos
    // leían la misma lista y al escribir se perdía uno de los dos.
    mutateCollectionSync<WhatsappInboxRecord>("whatsapp_inbox", (inbox) => {
      inbox.push({ id: whatsappInboxId, phone: from, text, read: false, answered: false, archived: false, created_at: new Date().toISOString() });
      return inbox.slice(-500);
    });
  } catch (err) {
    console.error("[whatsapp] no se pudo registrar el mensaje entrante en el CRM:", err instanceof Error ? err.message : err);
  }

  // Barrera de activación (10/11/2026): esta ruta (n8n) no tiene tráfico
  // real desde que se conectó Zernio, pero si n8n llega a mandar la fecha
  // real del mensaje (sent_at/timestamp), se respeta igual que en los
  // demás canales.
  const sentAtRaw = typeof b.sent_at === "string" ? b.sent_at : typeof b.timestamp === "string" ? b.timestamp : undefined;
  if (esAnteriorAlCorte(sentAtRaw)) {
    console.warn(`[whatsapp] mensaje de ${from} anterior a la fecha de activación -- no se responde en automático.`);
    return;
  }

  try {
    const result = await handleChatMessage(from, text, "WHATSAPP", from);
    if (result.ai_failed) {
      enqueuePendingReply("WHATSAPP", from, text);
      return;
    }
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
    // Reclamo atómico entre procesos (09/11/2026), igual que WhatsApp directo.
    if (!(await claimOnce("zernio_whatsapp_processed", eventId, MAX_ZERNIO_WHATSAPP_PROCESSED_KEPT))) return;

    const conversationId: string | undefined = body.conversation?.id;
    const phone: string | undefined = body.message?.sender?.participantId ?? body.message?.sender?.id ?? body.message?.sender?.phone;
    // Notas de voz y fotos reales (27/10/2026, "que se escuche el audio que
    // envió" / "que se pueda ver fotos"): un mensaje de solo audio o foto
    // puede llegar con "text" vacío/null -- antes esto se descartaba en
    // silencio (el "!text" de abajo exigía texto siempre), así que una
    // nota de voz o foto real nunca llegaba a guardarse. Si hay un adjunto
    // de audio o imagen, se usa un texto honesto como respaldo (nunca se
    // inventa una transcripción ni una descripción) para que el mensaje sí
    // se procese.
    const attachments: Array<{ type?: string; mimeType?: string; url?: string }> = Array.isArray(body.message?.attachments) ? body.message.attachments : [];
    const audioAttachment = attachments.find((a) => a.type === "audio");
    const imageAttachment = attachments.find((a) => a.type === "image");
    const mediaAttachment = audioAttachment ?? imageAttachment;
    const text: string | undefined = body.message?.text || (audioAttachment ? "🎤 Nota de voz" : imageAttachment ? "📷 Foto" : undefined);
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
    // Nota de voz real: se descarga YA, antes de guardar nada -- Meta
    // borra el audio original pronto, así que esperar a "verlo después"
    // significa perderlo para siempre. Nunca bloquea el registro del
    // mensaje si falla: mejor guardar el texto honesto de respaldo que no
    // guardar nada.
    let mediaPath: string | undefined;
    if (mediaAttachment?.url) {
      const downloaded = await downloadWhatsAppMedia(mediaAttachment.url, accountId);
      if (downloaded.ok) mediaPath = saveWhatsAppMedia(downloaded.buffer, downloaded.mimeType);
      else console.warn(`[zernio-whatsapp] no se pudo descargar ${audioAttachment ? "la nota de voz" : "la foto"}:`, downloaded.error);
    }
    try {
      // Bajo bloqueo (09/11/2026): mismo motivo que en WhatsApp directo.
      mutateCollectionSync<WhatsappInboxRecord>("whatsapp_inbox", (inbox) => {
        inbox.push({
          id: whatsappInboxId,
          phone,
          text: text.trim().slice(0, 2000),
          read: false,
          answered: false,
          archived: false,
          created_at: new Date().toISOString(),
          ...(mediaPath ? { media_path: mediaPath, media_type: audioAttachment ? ("audio" as const) : ("image" as const) } : {}),
        });
        return inbox.slice(-500);
      });
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
    // Pausa por chat individual (27/10/2026, "se pueda activar y desactivar
    // a carolina en chats individuales") -- el canal sigue encendido para
    // todos los demás, solo este número concreto lo lleva el equipo a mano
    // hasta que lo reactiven desde la propia ficha del chat.
    if (isWhatsappChatPaused(phone)) {
      raiseAlert({
        kind: "handoff_urgente",
        lead_phone: phone,
        reason: `WhatsApp: Carolina está pausada en este chat en concreto -- el cliente escribió "${text.trim().slice(0, 300)}" y no se le ha respondido. Reactívala desde su ficha en Contactos cuando quieras.`,
      });
      return;
    }
    // Interruptor temporal real (05/11/2026, "que solo me responda a mi al
    // 632570373, para que no haya fallos" -- mientras se prueba el cambio
    // de hoy en vivo, nunca se deja a un cliente real sin respuesta en
    // silencio: se avisa al equipo igual que en una pausa normal, para que
    // puedan atenderlo a mano mientras dura la prueba). Variable de
    // entorno, nunca hardcodeada -- quitar WHATSAPP_SOLO_RESPONDER_A para
    // volver a responder a todos.
    const soloResponderA = process.env.WHATSAPP_SOLO_RESPONDER_A?.trim().replace(/^\+/, "");
    if (soloResponderA && phone.replace(/^\+/, "") !== soloResponderA) {
      raiseAlert({
        kind: "handoff_urgente",
        lead_phone: phone,
        reason: `WhatsApp: Carolina está en modo de prueba (solo responde a un número) -- el cliente escribió "${text.trim().slice(0, 300)}" y no se le ha respondido todavía. Atiéndelo a mano mientras dura la prueba, o quita WHATSAPP_SOLO_RESPONDER_A cuando termine.`,
      });
      return;
    }

    // Petición real (23/10/2026, "que responda con sentido" -- tras
    // reenviar mensajes reales atascados días por el webhook caído): si el
    // mensaje real del cliente es de hace horas de verdad (sentAt real,
    // nunca inventado), que Carolina lo sepa y se disculpe por la tardanza
    // en vez de responder como si acabara de llegar.
    const sentAtMs = typeof body.message?.sentAt === "string" ? new Date(body.message.sentAt).getTime() : NaN;
    const delayHours = Number.isFinite(sentAtMs) ? (Date.now() - sentAtMs) / 3600000 : 0;
    // Barrera de activación (10/11/2026): este es el canal real de entrada
    // de WhatsApp (Zernio) -- mira la fecha REAL del mensaje (sentAt),
    // nunca la de llegada al servidor. Un mensaje reenviado o un backlog
    // que llega hoy pero fue escrito antes del corte nunca dispara una
    // respuesta automática.
    if (esAnteriorAlCorte(body.message?.sentAt)) {
      raiseAlert({
        kind: "gestion_portal",
        lead_phone: phone,
        reason: `WhatsApp: mensaje de ${phone} anterior a la fecha de activación (LUCERO_NO_AUTO_BEFORE) -- no se ha respondido en automático. Revísalo a mano si corresponde: "${text.trim().slice(0, 300)}"`,
      });
      return;
    }
    const realDelayNote =
      delayHours >= 1
        ? `Dato real: este mensaje del cliente se escribió hace aproximadamente ${Math.round(delayHours)} horas -- hubo un fallo técnico real (ya resuelto) que retrasó la respuesta. Empieza tu respuesta disculpándote brevemente por la tardanza, con naturalidad, sin dar detalles técnicos, y luego responde a lo que preguntó.`
        : undefined;
    const result = await handleChatMessage(phone, text.trim().slice(0, 2000), "WHATSAPP", phone, realDelayNote);
    if (result.ai_failed) {
      enqueuePendingReply("WHATSAPP", phone, text.trim().slice(0, 2000));
      return;
    }
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
    // Pedido real (03/11/2026, "como podemos poner avisos en el sistema,
    // para cuando haya algún error"): este catch solo hacía console.error
    // -- invisible desde fuera, mismo patrón que ya se arregló para el
    // sondeo de correo. Se deja constancia real para que checkTechnicalHealth
    // (scheduler.ts) pueda detectar y avisar a Ramón/José solo.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[zernio-whatsapp] inbound:", err);
    try {
      const errors = readCollection<{ id: string; message: string; at: string }>("whatsapp_errors");
      writeCollection("whatsapp_errors", [...errors, { id: crypto.randomUUID(), message, at: new Date().toISOString() }].slice(-50));
    } catch {
      // Igual que en el sondeo de correo -- si ni esto se puede escribir,
      // no hay nada más que hacer, el console.error ya se intentó.
    }
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

  for (const entry of entries) {
    const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const event of messaging) {
      const psid: string | undefined = event?.sender?.id;
      const text: string | undefined = event?.message?.text;
      const messageId: string | undefined = event?.message?.mid;
      if (!psid || !text || !text.trim() || event?.message?.is_echo) continue;

      const dedupeKey = `${psid}|${messageId ?? text}`;
      // Reclamo atómico entre procesos (09/11/2026), igual que los otros canales.
      if (!(await claimOnce("facebook_processed", dedupeKey, MAX_FACEBOOK_PROCESSED_KEPT))) continue;

      // Barrera de activación (10/11/2026): Messenger manda un timestamp
      // real (ms desde epoch) por evento -- un mensaje reenviado o un
      // backlog de Meta que llega hoy pero es de antes del corte nunca
      // debe disparar una respuesta automática.
      const eventTimestampIso = typeof event?.timestamp === "number" ? new Date(event.timestamp).toISOString() : undefined;
      if (esAnteriorAlCorte(eventTimestampIso)) {
        console.warn(`[facebook] mensaje de ${psid} anterior a la fecha de activación -- no se responde en automático.`);
        continue;
      }

      try {
        const result = await handleChatMessage(psid, text.trim().slice(0, 2000), "FACEBOOK", psid);
        if (result.ai_failed) {
          enqueuePendingReply("FACEBOOK", psid, text.trim().slice(0, 2000));
          continue;
        }
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

  // (las claves ya quedaron reclamadas una a una con claimOnce)
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
app.post("/webhooks/retell", async (req, res) => {
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
    res.json(await handleRetellWebhook(req.body ?? {}));
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
