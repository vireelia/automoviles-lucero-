import express from "express";
import multer from "multer";
import crypto from "crypto";
import { readCollection, writeCollection } from "../store.js";
import { userForSession, createSession, destroySession, verifyPassword, hashPassword, listUsers, saveUsers, type CrmUser } from "./auth.js";
import { vehiclesSeed } from "../data/vehicles-seed.js";
import { currentVehicles } from "../data/vehicles-current.js";
import { createReservationPending, confirmReservation, cancelReservation, reopenReservation } from "../tools/reservations.js";
import { getOfficialStatus, setOfficialStatus, type OfficialVehicleStatus } from "../tools/vehicle-state.js";
import { deliverEmail } from "../email/agent.js";
import { pendingAlerts, markAlertDone, deleteAlert } from "../alerts/alerts.js";
import { moveToTrash, listTrash, restoreFromTrash, purgeFromTrash } from "./trash.js";
import { tryAutoCreateReservation } from "../tools/requests.js";
import { notifyVisitCancelled, notifyVisitScheduled } from "../tools/team-notify.js";
import { normalizePhone, upsertLead } from "../tools/leads.js";
import { parseCochesNetJsonBlock } from "../email/interest.js";
import { listTasks, createManualTask, createAutoTask, completeTask, assignTask, type Task, type TaskType } from "../tools/tasks.js";
import { isVoiceAgentEnabled, setVoiceAgentEnabled, isEmailAutoSendEnabled, setEmailAutoSendEnabled, isWhatsappZernioAgentEnabled, setWhatsappZernioAgentEnabled } from "../tools/agent-toggle.js";
import { sendWhatsappText } from "../integrations/whatsapp.js";
import { STUDIO_TEMPLATES, findTemplate, VIDEO_ENGINES, VIDEO_STYLES, IMAGE_ENGINES, IMAGE_ASPECT_RATIOS, findVideoEngine, findVideoStyle, findImageEngine } from "../studio/templates.js";
import { createStudioJob, listStudioJobs, getStudioJob, pollStudioJob, saveUploadedPhoto, absolutePathFor, budgetInfo, PUBLIC_BASE_URL, type StudioJob } from "../studio/jobs.js";
import { isHiggsfieldConnected } from "../studio/higgsfield.js";
import { isZernioConnected, listZernioAccounts, publishZernioPost, isZernioWhatsappConfigured, getWhatsappConnectUrl, type ZernioAccount } from "../integrations/zernio.js";
import { existsSync as fileExists } from "fs";
import path from "path";
import {
  googleStatus,
  googleConfigMissing,
  createAuthUrl,
  disconnectGoogle,
  sendGmail,
  calendarCreateEvent,
  calendarDeleteEvent,
  describeGoogleError,
} from "../integrations/google.js";

export const crm = express.Router();
crm.use(express.urlencoded({ extended: false, limit: "100kb" }));

// ---------- datos ----------
type Lead = {
  id: string;
  phone: string | null;
  // Ya existía en el dato real (tools/leads.ts) pero el CRM nunca lo leía
  // (25/10/2026, Contactos Pro: hace falta para cruzar un correo con su
  // ficha -- un lead que entra solo por email se identifica por email,
  // no por teléfono, ver upsertLead en tools/leads.ts).
  email?: string | null;
  name: string | null;
  notes: string | null;
  channel: string | null;
  origin?: string | null;
  vehicle_interest: string | null;
  temperature: string;
  followup_count: number;
  do_not_contact: boolean;
  // Limpieza de clientes de poco interés (19/10/2026, a petición real:
  // "ocultar/archivar, no borrar"): nunca se borra nada aquí, solo deja de
  // salir en la lista principal.
  archived?: boolean;
  // Clientes para publicidad (21/10/2026, petición real: vehículo que varios
  // pedían ya no está en el catálogo real -- vendido -- y no les interesa
  // otro modelo distinto. No son un lead activo de ventas ni tampoco "sin
  // interés" (archived) -- son un contacto real para remarketing el día que
  // entre un coche parecido. Lista propia, fuera de Clientes y Pendientes.
  marketing_list?: boolean;
  // Venta cerrada/perdida (20/10/2026, mejora integral del CRM, sección 6.3:
  // esto SÍ es una decisión humana que ningún dato derivado puede inferir
  // -- a diferencia de la "fase" (visita concertada, reserva pendiente...),
  // que se deriva sola de citas/reservas reales, ver leadPhase().
  sale_outcome?: "cerrada" | "perdida" | null;
  lost_reason?: string | null;
  // Comercial responsable y próxima acción (20/10/2026, secciones 6.4/13):
  // campos explícitos, nadie los deriva por el cliente.
  assigned_to?: string | null;
  next_action?: string | null;
  // Bandeja única de entrada (21/10/2026, Fase A del encargo de reorganización
  // integral): la única parte de "calidad de datos" que ningún dato derivado
  // puede decidir sola -- si de verdad es un lead comercial (spam/número
  // equivocado/proveedor no lo son). El resto (incompleto/dudoso/posible
  // duplicado) se deriva solo, ver dataQuality(). Opcional, se lee con
  // `?? false` -- ningún registro histórico necesita migración.
  non_commercial?: boolean;
  updated_at?: string;
  created_at: string;
};
type Reservation = {
  id: string;
  vehicle_id: string;
  lead_phone: string | null;
  amount_eur: number;
  status: "pending_payment" | "pending_verification" | "confirmed" | "expired" | "cancelled";
  created_at: string;
  verified_by: string | null;
  // Canal de origen (20/10/2026, mejora integral del CRM, sección 12.1):
  // nunca se sobrescribe después de creada, igual que "origin" en Lead.
  // Ausente en reservas históricas -- se muestran como "Origen desconocido",
  // nunca se adivina.
  channel?: string | null;
  // Caducidad real de la señal (22/10/2026, a petición real: "tenemos que
  // poner caducidad") -- ya la calcula createReservationPending (15 días,
  // ver business-info.ts) pero nunca se mostraba en el CRM, así que Ramón
  // y José no tenían forma de saber cuándo se acababa el plazo sin mirar
  // el JSON a mano. Ausente en reservas muy antiguas -- se omite la fecha
  // en vez de inventarla.
  expires_at?: string | null;
};
type Appointment = {
  id: string;
  lead_phone: string | null;
  vehicle_id?: string;
  appointment_type?: string;
  requested_date?: string;
  requested_time?: string;
  notes?: string;
  status: string;
  created_at: string;
  // Canal de origen (20/10/2026, sección 11.1) -- mismo criterio que en Reservation.
  channel?: string | null;
};
type Handoff = { id: string; lead_phone: string | null; lead_name?: string | null; reason?: string; urgency?: string; notes?: string; reason_type?: string; status: string; created_at: string; channel?: string };
// Especificación formal del agente de chat (16/10/2026, sección CRM: "...y
// resumen de conversación"): el agente ya llamaba a save_conversation/
// create_conversation_summary, pero esos datos no se veían en ningún sitio
// del CRM -- se guardaban y ahí se quedaban. Se muestran ahora en la ficha
// del cliente.
type ConversationSummary = { id: string; phone?: string | null; summary: string; created_at: string };
type InboxMail = { id: string; from: string; subject: string; text: string; outcome: string; portal?: string | null; draft_note?: string; thread_id?: string; in_reply_to?: string; answered?: boolean; answered_by?: "ia" | "equipo"; read?: boolean; archived?: boolean; internal_note?: string | null; created_at: string };
// Correo realmente enviado (26/10/2026, "que se parezca lo mas a gmail")
// -- mismo dato real que ya guardaba deliverEmail en email/agent.ts
// (email_outbox), nunca leído desde el CRM hasta ahora. Se cruza por
// thread_id con email_inbox para reconstruir el hilo real de verdad
// (como ya se hizo con whatsapp_inbox), en vez de mostrar solo el último
// correo entrante suelto.
type EmailOutboxRow = { id: string; to: string; subject: string; body: string; status: "sent" | "queued" | "failed"; thread_id?: string; created_at: string };
// Mensajes de WhatsApp entrantes (módulo CRM mensajes/clientes, 18/10/2026).
// Solo registra lo que escribe el cliente y si la IA respondió -- esta
// bandeja NO tiene botón de responder: el envío real de WhatsApp sigue
// desactivado hasta verificar la conexión (a petición expresa: "preparar la
// interfaz y la lógica, pero no activar el envío hasta verificar la
// conexión prevista para mañana").
type WhatsappMessage = {
  id: string;
  phone: string;
  text: string;
  reply_text?: string | null;
  delivered?: boolean;
  read?: boolean;
  answered?: boolean;
  answered_by?: "ia" | "equipo";
  archived?: boolean;
  internal_note?: string | null;
  created_at: string;
};
type CallAnalysis = {
  id: string;
  channel: string;
  from_number?: string | null;
  duration_ms?: number | null;
  call_successful?: boolean | null;
  summary?: string | null;
  issues_detected?: string | null;
  security_event?: string | null;
  needs_review?: boolean;
  read?: boolean;
  archived?: boolean;
  // Reales desde Retell (25/10/2026, Contactos Pro) -- ausentes en llamadas
  // anteriores a este cambio, nunca se inventan: si no hay grabación o
  // transcripción real, el CRM no muestra esa sección para esa llamada.
  recording_url?: string | null;
  transcript?: string | null;
  direction?: string | null;
  transfer_outcome?: string | null;
  internal_note?: string | null;
  internal_note_by?: string | null;
  // Motivo real (25/10/2026) -- del post_call_analysis_data de Retell, no
  // inventado; ausente en llamadas anteriores a este cambio.
  intent?: string | null;
  call_vehicle_of_interest?: string | null;
  outcome?: string | null;
  created_at: string;
};
type VehicleOverride = { vehicle_id: string; price_eur: number };

const RESERVATION_TEXT: Record<string, string> = {
  pending_payment: "Espera el pago de 500 €",
  pending_verification: "Dice que ha pagado: falta comprobarlo",
  confirmed: "Reserva confirmada",
  expired: "Caducada",
  cancelled: "Cancelada",
};
const APPOINTMENT_TEXT: Record<string, string> = {
  requested: "Pendiente de confirmar",
  confirmed: "Confirmada",
  cancelled: "Cancelada",
  no_presentado: "No se presentó",
};
const VEHICLE_TEXT: Record<OfficialVehicleStatus, string> = {
  AVAILABLE: "Disponible",
  RESERVATION_PENDING: "Reserva en curso",
  RESERVED: "Reservado",
  SOLD: "Vendido",
};
const TEMP: Record<string, { label: string; cls: string; help: string; letter: string }> = {
  HOT: { label: "Caliente · quiere comprar ya", cls: "t-hot", help: "caliente", letter: "C" },
  WARM: { label: "Tibio · interesado, sin prisa", cls: "t-warm", help: "tibio", letter: "T" },
  COLD: { label: "Frío · solo está mirando", cls: "t-cold", help: "frío", letter: "F" },
};
// Mismos tonos ya reales de temperatura (.t-hot/.t-warm/.t-cold, más abajo
// en el CSS) pero en versión clara, para el avatar y el punto de color de
// la fila compacta de Clientes (26/10/2026, opción "B" de las ideas de
// diseño mandadas -- "vamos a probar esta").
const TEMP_AVATAR: Record<string, [string, string]> = {
  HOT: ["#fee2e2", "#dc2626"],
  WARM: ["#ffedd5", "#f97316"],
  COLD: ["#dbeafe", "#2563eb"],
};
// Fase comercial (20/10/2026, mejora integral del CRM, sección 6.3): "no
// utilizar una única etiqueta para representar conceptos distintos" -- la
// temperatura (TEMP, interés) y la fase (dónde está la operación) son dos
// cosas distintas y se muestran por separado. La fase se DERIVA de datos
// reales (citas/reservas ya existentes) en vez de ser un campo editable a
// mano que alguien tendría que mantener sincronizado -- la única excepción
// es venta cerrada/perdida, que sí es una decisión humana explícita
// (sale_outcome en Lead) porque ningún dato derivado puede inferirla sola.
type LeadPhase = "nuevo" | "pendiente_contactar" | "contactado" | "visita_concertada" | "visita_realizada" | "negociacion_financiacion" | "reserva_pendiente" | "reservado" | "venta_cerrada" | "venta_perdida" | "archivado" | "no_contactar";
const LEAD_PHASE_LABEL: Record<LeadPhase, string> = {
  nuevo: "Nuevo",
  pendiente_contactar: "Pendiente de contactar",
  contactado: "Contactado",
  visita_concertada: "Visita concertada",
  visita_realizada: "Visita realizada",
  negociacion_financiacion: "Negociación/financiación",
  reserva_pendiente: "Reserva pendiente",
  reservado: "Reservado",
  venta_cerrada: "Venta cerrada",
  venta_perdida: "Venta perdida",
  archivado: "Archivado",
  no_contactar: "No contactar",
};
// Color por fase (26/10/2026, "E1" del embudo comercial -- antes columnas
// sin ningún color que las distinguiera). Progresión real del proceso:
// gris (sin empezar) -> ámbar (hay que actuar) -> azul (en marcha) ->
// violeta (negociando) -> verde (ganado) -- venta_perdida/archivado en
// gris apagado, nunca rojo de "error" (perder una venta no es un fallo
// del sistema).
const EMBUDO_PHASE_COLOR: Record<LeadPhase, [string, string]> = {
  nuevo: ["#eef1f5", "#5b6472"],
  pendiente_contactar: ["#fff4e0", "#8a5a00"],
  contactado: ["#dbeafe", "#1d4ed8"],
  visita_concertada: ["#e0f2fe", "#0369a1"],
  visita_realizada: ["#e0f2fe", "#0369a1"],
  negociacion_financiacion: ["#ede9fe", "#6d28d9"],
  reserva_pendiente: ["#fff4e0", "#8a5a00"],
  reservado: ["#dcfce7", "#15803d"],
  venta_cerrada: ["#e3f6e8", "#1f7a42"],
  venta_perdida: ["#f3f4f6", "#6b7280"],
  archivado: ["#f3f4f6", "#6b7280"],
  no_contactar: ["#f3f4f6", "#6b7280"],
};
function leadPhase(
  lead: Lead,
  appts: Appointment[],
  reservations: Reservation[],
  today: string,
  financingRequests: { lead_phone?: string; status: string }[] = [],
): LeadPhase {
  if (lead.sale_outcome === "cerrada") return "venta_cerrada";
  if (lead.sale_outcome === "perdida") return "venta_perdida";
  if (lead.archived) return "archivado";
  if (lead.do_not_contact) return "no_contactar";
  const myReservations = reservations.filter((r) => r.lead_phone === lead.phone);
  if (myReservations.some((r) => r.status === "confirmed")) return "reservado";
  if (myReservations.some((r) => r.status === "pending_payment" || r.status === "pending_verification")) return "reserva_pendiente";
  // Negociación/financiación (20/10/2026, sección 13): dato real ya
  // existente (financing_requests), nunca inventado -- una solicitud de
  // financiación todavía sin resolver es una señal real de negociación en
  // curso, distinta de solo "contactado".
  if (financingRequests.some((f) => f.lead_phone === lead.phone && f.status === "pending_review")) return "negociacion_financiacion";
  const myAppts = appts.filter((a) => a.lead_phone === lead.phone && a.status !== "cancelled");
  if (myAppts.some((a) => a.status === "confirmed" && (a.requested_date ?? "") >= today)) return "visita_concertada";
  if (myAppts.some((a) => a.status === "confirmed" && (a.requested_date ?? "") < today)) return "visita_realizada";
  if (lead.notes || lead.vehicle_interest || lead.followup_count > 0) return "contactado";
  if (lead.next_action) return "pendiente_contactar";
  return "nuevo";
}
// Aviso de posible duplicado (20/10/2026, sección 6.5): nunca fusiona
// solo -- solo avisa con enlace a la otra ficha y al mergeLeads ya
// existente (solo admin). Compara por teléfono normalizado, el mismo
// criterio que ya usa upsertLead -- "phone" a veces guarda en realidad un
// correo (patrón ya existente en este CRM), normalizePhone ya lo cubre.
function findPossibleDuplicate(lead: Lead, allLeads: Lead[]): Lead | null {
  if (!lead.phone) return null;
  const key = normalizePhone(lead.phone);
  return allLeads.find((other) => other.id !== lead.id && other.phone && normalizePhone(other.phone) === key) ?? null;
}
// Contactos Pro (25/10/2026, "que ningún cliente se escape"): cruza un
// mensaje/llamada/correo entrante con su ficha real -- por teléfono
// normalizado (voz/WhatsApp) o por email (correo, mismo criterio que ya
// usa upsertLead para identificar un lead sin teléfono). Si no encuentra
// nada, devuelve null -- eso es justo la señal real de "este contacto no
// tiene ficha", nunca se inventa una.
function findLeadForContact(allLeads: Lead[], phone?: string | null, email?: string | null): Lead | null {
  if (phone) {
    const key = normalizePhone(phone);
    const byPhone = allLeads.find((l) => l.phone && normalizePhone(l.phone) === key);
    if (byPhone) return byPhone;
  }
  if (email) {
    const key = email.trim().toLowerCase();
    const byEmail = allLeads.find((l) => (l.email ?? "").trim().toLowerCase() === key);
    if (byEmail) return byEmail;
  }
  return null;
}
// Mini-ficha inline para Contactos Pro -- misma leadCard de siempre (mismos
// datos, mismas acciones) si hay ficha real; si no, un aviso visible en vez
// de dejarlo pasar en silencio (eso es justo lo que se quiere evitar).
function contactLeadBlock(allLeads: Lead[], user: CrmUser, appts: Appointment[], resv: Reservation[], today: string, financing: { lead_phone?: string; status: string }[], phone?: string | null, email?: string | null): string {
  const lead = findLeadForContact(allLeads, phone, email);
  if (!lead) {
    return `<div class="box" style="background:#fdecea;border:1px solid var(--urgent)"><b>⚠️ Sin ficha de cliente</b> -- este contacto todavía no tiene un lead asociado en el CRM.</div>`;
  }
  return leadCard(lead, user, leadPhase(lead, appts, resv, today, financing), findPossibleDuplicate(lead, allLeads), appts);
}
// Avatar circular de color por contacto (25/10/2026, Lucero PRO -- "hazlo
// exactamente igual" al mockup de referencia, que sí lleva círculos de
// color). Solo lo usa Contactos; el cuadrado gris se queda para el menú
// lateral y el usuario conectado, que son insignias de interfaz, no de
// persona. Puramente decorativo para distinguir filas de un vistazo,
// nunca significa nada por sí mismo -- determinista: el mismo teléfono/
// correo siempre sale del mismo color.
const AVATAR_PALETTE: [string, string][] = [
  ["#fde4cf", "#b5551f"], ["#fde0e6", "#b5365b"], ["#f3e8c7", "#8a6a1a"], ["#d9f2e3", "#1f8a55"],
  ["#e6e0fb", "#5b3fb0"], ["#fdf3c0", "#8a6d12"], ["#d3f3ef", "#1b8278"], ["#dce8fb", "#2c5fb0"],
];
function avatarColor(key: string): [string, string] {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}
function avatarBadge(key: string, name: string, size = 36): string {
  const [bg, fg] = avatarColor(key || name);
  return `<div class="avatar" style="width:${size}px;height:${size}px;background:${bg};color:${fg};font-size:${Math.round(size * 0.34)}px">${esc(avatarInitials(name))}</div>`;
}
function avatarInitials(name: string): string {
  const trimmed = name.trim();
  // Sin ficha todavía: el "nombre" es el teléfono/correo en crudo -- las 2
  // primeras letras de un teléfono son siempre "+3", nada útil para
  // distinguir filas. Las 2 últimas cifras sí cambian de una fila a otra.
  if (/^\+?\d[\d\s-]{5,}$/.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, "");
    return digits.slice(-2) || "?";
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
// Bandeja única de entrada (21/10/2026, Fase A): calidad de datos derivada,
// nunca guardada -- misma filosofía que leadPhase. Solo "no_comercial" es
// una decisión humana explícita (lead.non_commercial), el resto se calcula
// de datos ya reales.
type DataQuality = "completo" | "incompleto" | "dudoso" | "posible_duplicado" | "no_comercial";
function dataQuality(lead: Lead, allLeads: Lead[]): DataQuality {
  if (lead.non_commercial) return "no_comercial";
  if (findPossibleDuplicate(lead, allLeads)) return "posible_duplicado";
  if (!lead.phone && !lead.name) return "incompleto";
  if (!lead.vehicle_interest && !lead.notes) return "incompleto";
  // normalizePhone deja el texto tal cual si no parece un teléfono real
  // (menos de 7 o más de 11 dígitos) -- esa es la señal de "dudoso".
  if (lead.phone && !lead.phone.includes("@") && !/^\+?\d{9,11}$/.test(lead.phone.replace(/\D/g, ""))) return "dudoso";
  if (lead.origin && !(lead.origin in ORIGIN)) return "dudoso";
  return "completo";
}
const DATA_QUALITY_LABEL: Record<DataQuality, string> = {
  completo: "Completo",
  incompleto: "Incompleto",
  dudoso: "Dudoso",
  posible_duplicado: "Posible duplicado",
  no_comercial: "No comercial",
};
// Prioridad P1-P4 (21/10/2026, Fase A, sección 7 del encargo): v1 simple
// sobre datos YA reales (temperatura, fase, avisos urgentes abiertos).
// Nunca se guarda -- el motor de reglas completo (más criterios de
// negocio) es Fase B/C/D, fuera de esta entrega.
type LeadPriority = "P1" | "P2" | "P3" | "P4";
function leadPriority(lead: Lead, phase: LeadPhase, hasOpenUrgentHandoff: boolean): LeadPriority {
  if (hasOpenUrgentHandoff) return "P1";
  if (lead.temperature === "HOT" && (phase === "nuevo" || phase === "pendiente_contactar" || phase === "contactado")) return "P1";
  if (phase === "pendiente_contactar" || lead.temperature === "WARM") return "P2";
  if (phase === "nuevo") return "P3";
  return "P4";
}
const LEAD_PRIORITY_LABEL: Record<LeadPriority, string> = {
  P1: "P1 -- Urgente",
  P2: "P2 -- Alta",
  P3: "P3 -- Normal",
  P4: "P4 -- Diferida",
};
// Agente/canal por el que entró el cliente. El texto va en la tarjeta; la letra solo indica temperatura.
// FALLO REAL detectado en la auditoría del 18/10/2026: a los leads reales
// con origin "WHATSAPP" (confirmado en data/leads.json de producción) les
// faltaba entrada aquí -- se mostraban como "Origen sin registrar" aunque
// el dato correcto SÍ estaba guardado. Lo mismo le faltaba a "FACEBOOK".
// "coches.net" (en minúsculas, el nombre del portal) añadido tras ver datos
// reales de producción (18/10/2026): algún lead real tiene ese valor exacto
// en `channel`/`origin` en vez de un canal real -- se muestra honestamente
// tal cual está guardado, sin tocar de dónde viene ese dato.
const ORIGIN: Record<string, string> = { VOICE: "Voz", CHAT: "Chat", EMAIL: "Correo", WHATSAPP: "WhatsApp", FACEBOOK: "Facebook", MANUAL: "Añadido a mano", "coches.net": "Coches.net" };
// Pestañas de origen en Visitas/Reservas (20/10/2026, mejora integral del
// CRM, secciones 11.1/12.1): Llamadas / WhatsApp / Otros canales -- "otros"
// incluye correo, chat web, añadido a mano, y origen desconocido (dato
// histórico sin canal registrado), nunca se adivina cuál sería.
function channelBucket(channel: string | null | undefined): "llamadas" | "whatsapp" | "otros" {
  if (channel === "VOICE") return "llamadas";
  if (channel === "WHATSAPP") return "whatsapp";
  return "otros";
}
// Plataforma que originó el contacto (distinta del canal): Coches.net,
// Wallapop... Antes de mostrar un dato de origen hay que decir
// "Origen desconocido" en vez de inventarlo (encargo del cliente, Fase 2).
function platformLabel(portal: string | null | undefined): string {
  return portal && portal.trim() ? portal : "Origen desconocido";
}
// Etiqueta de plataforma EN COLOR (a petición real, 18/10/2026: "que salga
// también como una tarjeta de color") -- un color real y reconocible por
// portal en vez del tag gris neutro que usa el resto del CRM.
const PORTAL_TAG_STYLE: Record<string, string> = {
  "coches.net": "background:#dbeafe;color:#1e3a8a",
  wallapop: "background:#dcfce7;color:#14532d",
  milanuncios: "background:#ffe4d6;color:#7c2d12",
};
function platformTag(portal: string | null | undefined): string {
  const label = platformLabel(portal);
  const style = PORTAL_TAG_STYLE[(portal ?? "").trim().toLowerCase()] ?? "background:#e2e8f0;color:#1e293b";
  return `<span class="tag" style="${style}">${esc(label)}</span>`;
}
// Identificador útil para mostrar cuando falta el nombre (encargo real,
// Fase 2: "si no se conoce el nombre, mostrar un identificador útil, como
// su número de teléfono, sin inventar datos"). Dato real de producción
// (18/10/2026): varios leads de Coches.net no tienen ni nombre ni un
// teléfono real -- su "phone" es un correo-relay anónimo del propio portal
// (tipo bec672e7-...@contactos.coches.net), que no identifica a nadie para
// una persona. Para esos casos concretos se prioriza el coche de interés,
// que sí dice algo útil; nunca se inventa un nombre.
function isCochesNetRelay(contact: string | null | undefined): boolean {
  return Boolean(contact && contact.includes("@") && /coches\.net$/i.test(contact));
}
function leadDisplayName(l: Lead): string {
  if (l.name) return l.name;
  if (l.phone && !isCochesNetRelay(l.phone)) return l.phone;
  if (l.vehicle_interest) return `Interesado/a en ${l.vehicle_interest}`;
  return "Sin datos de contacto";
}
// Limpieza automática de clientes de poco interés (19/10/2026, a petición
// real: "ocultar/archivar, no borrar" + "Fría + sin contacto reciente").
// Nunca borra nada -- solo deja de salir en la lista principal de
// Clientes. Reversible con un clic ("Desarchivar"). Configurable por si
// el tope de días hace falta ajustarlo sin tocar código.
const LEAD_ARCHIVE_INACTIVE_DAYS = Number(process.env.LEAD_ARCHIVE_INACTIVE_DAYS ?? 45);
function autoArchiveColdLeads(): void {
  const leads = list<Lead>("leads");
  const cutoff = Date.now() - LEAD_ARCHIVE_INACTIVE_DAYS * 24 * 60 * 60 * 1000;
  // FALLO REAL detectado (20/10/2026): nunca archivar -- ni a mano en masa ni
  // aquí -- un lead con un aviso (handoff) todavía sin atender en Pendientes;
  // el aviso es la única señal real de una oportunidad en curso cuando
  // todavía no existe cita/reserva (ver también /clientes-masivo).
  const openHandoffPhones = new Set(list<Handoff>("handoffs").filter((h) => h.status === "requested" && h.lead_phone).map((h) => h.lead_phone as string));
  let changed = false;
  for (const l of leads) {
    if (l.archived || l.temperature !== "COLD") continue;
    if (l.phone && openHandoffPhones.has(l.phone)) continue;
    const lastActivity = new Date(l.updated_at ?? l.created_at).getTime();
    if (Number.isFinite(lastActivity) && lastActivity < cutoff) {
      l.archived = true;
      changed = true;
    }
  }
  if (changed) save("leads", leads);
}
// Igual que leadDisplayName, pero para sitios que solo tienen phone/name
// sueltos (Avisos, Pendientes) y no el Lead completo -- a petición real,
// 18/10/2026: "eliminar estos códigos raros que salen en cliente, mejor
// pon el nombre, no quiero códigos que confundan". Busca en Clientes por
// el mismo contacto antes de rendirse; nunca inventa un nombre.
function findLeadByContact(contact: string): Lead | undefined {
  // FALLO REAL detectado (26/10/2026, al completar nombre/vehículo/correo
  // en Visitas/Reservas): esto solo miraba el correo guardado en el campo
  // antiguo "phone" -- un lead moderno que entra solo por correo usa el
  // campo "email" dedicado (ver el comentario de Lead.email), así que no
  // se encontraba nunca y se perdían su nombre y su vehículo de interés
  // real. Se comprueban los dos campos.
  if (contact.includes("@")) return list<Lead>("leads").find((l) => l.phone === contact || l.email === contact);
  const digits = normalizePhoneDigits(contact);
  if (!digits) return undefined;
  return list<Lead>("leads").find((l) => normalizePhoneDigits(l.phone) === digits);
}
function contactLabel(phone: string | null | undefined, name: string | null | undefined): string {
  if (name) return name;
  if (!phone) return "Cliente sin contacto";
  // Se mira primero si ya hay un nombre real guardado en Clientes para este
  // mismo contacto (19/10/2026, "pon toda la información") -- antes solo se
  // miraba en los casos de correo-relay de Coches.net, así que un teléfono
  // normal con nombre ya conocido (p. ej. añadido a mano en una reserva) se
  // seguía mostrando como número suelto en vez de su nombre real.
  const lead = findLeadByContact(phone);
  if (lead?.name) return lead.name;
  if (!isCochesNetRelay(phone)) return phone;
  if (lead?.vehicle_interest) return `Interesado/a en ${lead.vehicle_interest}`;
  return "Cliente de Coches.net (sin nombre)";
}

// Igual que whatsappGreetingFor (Clientes), pero para Avisos/Reservas/
// Incidencias que solo tienen un aviso suelto (sin el Lead completo a mano)
// -- a petición real (22/10/2026, "aqui y en todos los mensajes que
// especifique el motivo el coche todo, porque estoy probando y no me
// aparece el cambio"): el mensaje de WhatsApp debe llevar nombre y coche
// real, nunca un saludo genérico tipo "sobre su reserva". A propósito NO se
// usa el texto interno del aviso (`reason`/`notes`) como mensaje -- ese
// texto está escrito para el equipo (p. ej. "la transferencia a Ramón
// falló y nadie le ha llamado de vuelta todavía") y nunca debe llegar al
// cliente tal cual, aunque mencione el coche correcto.
function waMessageFor(phone: string | null | undefined, name: string | null | undefined, closing?: string): string {
  const lead = phone ? findLeadByContact(phone) : undefined;
  const realName = name || lead?.name;
  const greeting = realName ? `Hola ${realName}` : "Hola";
  const vehicle = lead?.vehicle_interest;
  const vehiclePart = vehicle ? ` sobre ${vehicle}` : "";
  return `${greeting}, le escribe Automóviles Lucero${vehiclePart}. ${closing ?? "¿En qué le podemos ayudar?"}`;
}

// Frase con lo que quiere el cliente, sacada de sus visitas y reservas reales.
function situation(l: Lead): string {
  const key = l.phone ?? "";
  const car = (id?: string) => vehicleName(id);
  const appt = list<Appointment>("appointments").filter((a) => a.lead_phone === key && a.status !== "cancelled").sort((x, y) => (x.requested_date ?? "").localeCompare(y.requested_date ?? ""))[0];
  if (appt) {
    const d = dayLabel(appt.requested_date);
    return `Quiere ir ${d.weekday === "Día por fijar" ? "a una fecha por fijar" : `el ${d.weekday} ${d.day} de ${d.month}`} a las ${appt.requested_time ?? "?"} a ver ${car(appt.vehicle_id)}`;
  }
  const res = list<Reservation>("reservations").find((r) => r.lead_phone === key && r.status !== "cancelled" && r.status !== "expired");
  if (res) {
    return res.status === "confirmed" ? `Tiene reservado ${car(res.vehicle_id)}` : `Quiere reservar ${car(res.vehicle_id)}: espera el pago de 500 €`;
  }
  if (l.vehicle_interest) return `Pregunta por ${l.vehicle_interest}`;
  return l.temperature === "HOT" ? "Quiere comprar ya" : "Todavía está informándose";
}
const DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

// Solo el comercial (y el administrador) confirma pagos y marca ventas.
function canConfirmPayments(user: CrmUser): boolean {
  return user.role === "admin" || user.role === "comercial";
}
const ROLE_NAME: Record<string, string> = { admin: "Puede todo", comercial: "Confirma pagos y ventas", equipo: "Ver y trabajar" };

function list<T>(name: string): T[] {
  return readCollection<T>(name);
}
function save<T>(name: string, rows: T[]) {
  writeCollection(name, rows);
}
function now() {
  return new Date().toISOString();
}
function todayMadrid(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
}
// Filtros temporales de Clientes (20/10/2026, mejora integral del CRM,
// sección 6.1): se convierte cada "created_at" (timestamp real) a su día de
// calendario EN HORA DE MADRID (mismo truco que todayMadrid, usa el huso
// real vía Intl -- así el cambio de hora de verano/invierno no desplaza
// ningún cliente de día) y luego toda la aritmética de rango (sumar/restar
// días, límites de mes) se hace sobre esas cadenas "YYYY-MM-DD" con fechas
// ancladas en UTC -- nunca mezcla las dos cosas, para no arrastrar un
// desfase de huso horario a la aritmética de calendario.
function madridDateOnly(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
}
function addDaysToDateStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function monthBoundsOf(dateStr: string, monthsBack: number): { start: string; end: string } {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() - monthsBack;
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
type DateFilterKey = "hoy" | "ayer" | "7dias" | "30dias" | "mes" | "mes_anterior" | "todo";
const DATE_FILTER_LABEL: Record<DateFilterKey, string> = {
  hoy: "Hoy",
  ayer: "Ayer",
  "7dias": "Últimos 7 días",
  "30dias": "Últimos 30 días",
  mes: "Este mes",
  mes_anterior: "Mes anterior",
  todo: "Todo",
};
function matchesDateFilter(filter: DateFilterKey, isoCreatedAt: string | undefined, today: string): boolean {
  if (filter === "todo") return true;
  if (!isoCreatedAt) return false;
  const d = madridDateOnly(isoCreatedAt);
  if (filter === "hoy") return d === today;
  if (filter === "ayer") return d === addDaysToDateStr(today, -1);
  if (filter === "7dias") return d >= addDaysToDateStr(today, -6) && d <= today;
  if (filter === "30dias") return d >= addDaysToDateStr(today, -29) && d <= today;
  if (filter === "mes") {
    const { start, end } = monthBoundsOf(today, 0);
    return d >= start && d <= end;
  }
  if (filter === "mes_anterior") {
    const { start, end } = monthBoundsOf(today, 1);
    return d >= start && d <= end;
  }
  return true;
}
function vehicleName(id: string | undefined | null): string {
  const v = currentVehicles().find((x) => x.id === id);
  return v ? `${v.make} ${v.model} ${v.year ?? ""}`.trim() : "Coche sin nombre";
}
// Tarjeta de vehículo en la ficha de un contacto (25/10/2026, mockup) --
// SOLO cuando `vehicle_interest` (texto libre que escribe el agente de
// IA) coincide EXACTO, sin difusión, con un coche real del catálogo. Se
// prueban 3 formas reales de nombrarlo (sin versión, con versión, con
// año) porque el agente no siempre incluye todos los datos -- nunca se
// adivina "el más parecido": si ninguna forma coincide del todo, no hay
// tarjeta, se queda como texto (ver contactDetailHeader/Interés). Sin
// foto: el catálogo real (vehicles-seed.ts) no guarda ninguna imagen, así
// que no se inventa una.
function findExactVehicleMatch(interest: string | null | undefined): import("../data/vehicles-seed.js").Vehicle | null {
  const key = (interest ?? "").trim().toLowerCase();
  if (!key) return null;
  return currentVehicles().find((v) => {
    const forms = [`${v.make} ${v.model}`, `${v.make} ${v.model} ${v.version}`, vehicleName(v.id)];
    return forms.some((f) => f.trim().toLowerCase() === key);
  }) ?? null;
}
function vehicleCard(v: import("../data/vehicles-seed.js").Vehicle): string {
  return `<div class="box" style="display:flex;gap:14px;align-items:center">
<div>
<b style="font-size:15px">${esc(`${v.make} ${v.model} ${v.version}`.trim())}</b>
<p class="sub" style="margin:2px 0 0">${esc(priceOf(v.id).toLocaleString("es-ES"))} € · ${esc(v.fuel)}${v.year ? ` · ${v.year}` : ""} · ${esc(v.km.toLocaleString("es-ES"))} km</p>
<a class="link" href="/crm/coches/${esc(v.id)}" style="font-size:13px">Ver vehículo →</a>
</div>
</div>`;
}
function priceOf(vehicleId: string): number {
  const override = list<VehicleOverride>("vehicle_overrides").find((o) => o.vehicle_id === vehicleId);
  return override?.price_eur ?? vehiclesSeed.find((v) => v.id === vehicleId)?.price_eur ?? 0;
}
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function fmtDate(iso: string | undefined | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
// "lunes 7 oct" a partir de 2026-10-07
function dayLabel(isoDate: string | undefined): { weekday: string; day: string; month: string } {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return { weekday: "Día por fijar", day: "--", month: "" };
  const d = new Date(`${isoDate}T12:00:00`);
  return { weekday: DAYS[d.getDay()], day: String(d.getDate()).padStart(2, "0"), month: MONTHS[d.getMonth()] };
}
function phoneLink(contact: string | null | undefined): string {
  if (!contact || contact.includes("@") || !/\d{6,}/.test(contact)) return "";
  return `<a class="btn light" href="tel:${esc(contact)}">Llamar</a>`;
}
// Botón de correo real (26/10/2026, petición real: "que se le pueda
// contactar a todosss" en Visitas/Reservas) -- hasta ahora solo había
// forma de contactar por teléfono/WhatsApp; un cliente que solo dejó
// correo (p. ej. relay de Coches.net sin teléfono real) se quedaba sin
// ningún botón de contacto en estas tarjetas.
function mailLink(email: string | null | undefined): string {
  if (!email) return "";
  return `<a class="btn light" href="mailto:${esc(email)}">Correo</a>`;
}
function option(value: string, label: string, selected: string | undefined) {
  return `<option value="${esc(value)}"${selected === value ? " selected" : ""}>${esc(label)}</option>`;
}
// Número listo para WhatsApp (España por defecto): solo cifras, con 34 delante si hace falta.
function waNumber(contact: string | null | undefined): string | null {
  if (!contact || contact.includes("@")) return null;
  let digits = contact.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 9) digits = `34${digits}`;
  return digits.length >= 11 ? digits : null;
}
function waButton(contact: string | null | undefined, message: string): string {
  const num = waNumber(contact);
  if (!num) return "";
  return `<a class="btn ok" target="_blank" rel="noopener" href="https://wa.me/${num}?text=${encodeURIComponent(message)}">Escribir por WhatsApp</a>`;
}
// Versión compacta en icono de phoneLink/waButton/mailLink (26/10/2026,
// fila de Clientes -- opción "B" de las ideas de diseño, "vamos a probar
// esta"): mismo enlace real y mismo criterio de cuándo se muestra, solo
// con icono en vez de texto para que quepan varias acciones en una fila
// de una sola línea. phoneLink/waButton/mailLink se quedan igual, los
// sigue usando el resto del CRM (Visitas, Reservas, etc.).
const ICON_PHONE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.6 10.8a15.3 15.3 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.3.2 2.5.6 3.6a1 1 0 0 1-.25 1l-2.25 2.2Z"/></svg>`;
const ICON_WHATSAPP = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3Zm0 16.2c-1.5 0-3-.4-4.2-1.2l-.3-.2-2.7.7.7-2.6-.2-.3A7.2 7.2 0 1 1 12 19.2Zm3.9-5.4c-.2-.1-1.3-.6-1.5-.7-.2-.1-.3-.1-.5.1-.1.2-.5.7-.6.8-.1.1-.2.1-.4 0-.2-.1-.9-.3-1.7-1-.6-.6-1-1.3-1.2-1.5-.1-.2 0-.3.1-.4l.3-.4.2-.3v-.3c0-.1-.5-1.2-.7-1.6-.2-.4-.4-.4-.5-.4h-.4c-.1 0-.4 0-.6.3-.2.2-.8.8-.8 1.9s.8 2.2.9 2.4c.1.1 1.6 2.5 3.9 3.4.5.2 1 .4 1.3.5.5.2 1 .1 1.4.1.4-.1 1.3-.5 1.5-1 .2-.5.2-.9.1-1l-.3-.1Z"/></svg>`;
const ICON_MAIL = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h16a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Zm-.6 1.1 8.6 6.3 8.6-6.3"/></svg>`;
function phoneIconLink(contact: string | null | undefined): string {
  if (!contact || contact.includes("@") || !/\d{6,}/.test(contact)) return "";
  return `<a class="ibtn" href="tel:${esc(contact)}" aria-label="Llamar" title="Llamar">${ICON_PHONE}</a>`;
}
function waIconButton(contact: string | null | undefined, message: string): string {
  const num = waNumber(contact);
  if (!num) return "";
  return `<a class="ibtn" target="_blank" rel="noopener" href="https://wa.me/${num}?text=${encodeURIComponent(message)}" aria-label="Escribir por WhatsApp" title="Escribir por WhatsApp" style="border-color:#bfe7cc;color:#2e9e55">${ICON_WHATSAPP}</a>`;
}
function mailIconLink(email: string | null | undefined): string {
  if (!email) return "";
  return `<a class="ibtn" href="mailto:${esc(email)}" aria-label="Correo" title="Correo" style="border-color:#c7d4e8;color:#2d5fa8">${ICON_MAIL}</a>`;
}
// El borrador de "pendiente_whatsapp_manual" ya trae el enlace wa.me real
// incrustado en el texto (email/agent.ts) -- se extrae solo para mostrarlo
// como botón real, en vez de obligar a leer/copiar el enlace a mano.
function extractWaLink(note: string | null | undefined): string | null {
  const m = note?.match(/https:\/\/wa\.me\/\d+/);
  return m ? m[0] : null;
}
// El motivo de la alerta siempre empieza con "Coches.net: "/"Wallapop: "
// cuando lo genera email/agent.ts -- se separa para mostrar el portal como
// etiqueta en color (a petición real, 18/10/2026: "que salga en color
// como una tarjeta igual que urgente"), igual que ya se hace en Correos.
function extractLeadingPortal(reason: string): { portal: string | null; rest: string } {
  const m = reason.match(/^(Coches\.net|Wallapop|Milanuncios):\s*/i);
  if (!m) return { portal: null, rest: reason };
  return { portal: m[1] ?? null, rest: reason.slice(m[0].length) };
}
// FALLO REAL detectado (21/10/2026, "es un caos, el texto se sale de la
// pantalla, buscame que inquietud tiene cada cliente"): Correos mostraba el
// correo entero de Coches.net tal cual -- enlaces de tracking kilométricos,
// pies de firma, el bloque JSON al final -- en vez de lo único que importa:
// quién es, su coche y qué pregunta de verdad. parseCochesNetJsonBlock ya
// aísla ese bloque real; esto arma un resumen legible con lo que encuentre,
// y solo cae al texto crudo (ya envuelto por CSS) si no hay nada que extraer.
function emailPreviewBox(text: string): string {
  const parsed = parseCochesNetJsonBlock(text);
  if (!parsed || (!parsed.name && !parsed.inquiry && !parsed.car)) {
    return `<div class="box" style="background:#f7f8fa;white-space:pre-wrap;font-size:19px">${esc(text)}</div>`;
  }
  const vehicle = parsed.car ? [parsed.car.make, parsed.car.model, parsed.car.version].filter(Boolean).join(" ") : null;
  const lines = [
    parsed.name ? `<b>${esc(parsed.name)}</b>` : null,
    parsed.phone ? `Tel: ${esc(parsed.phone)}` : null,
    parsed.email ? `Correo: ${esc(parsed.email)}` : null,
    vehicle ? `Coche: ${esc(vehicle)}${parsed.car?.price ? ` (${esc(String(parsed.car.price))}€)` : ""}` : null,
  ].filter(Boolean).join(" · ");
  return `<div class="box" style="background:#f7f8fa;font-size:19px">
${lines ? `<p style="margin:0 0 8px">${lines}</p>` : ""}
${parsed.inquiry ? `<p style="margin:0"><b>Dice:</b> "${esc(parsed.inquiry)}"</p>` : ""}
</div>`;
}
function normalizePhoneDigits(p: string | null | undefined): string {
  return (p ?? "").replace(/\D/g, "");
}
function confirmButton(label: string, action: string, extra: string, question: string): string {
  return `<button class="btn ${extra}" name="accion" value="${esc(action)}" onclick="return confirm('${esc(question)}')">${esc(label)}</button>`;
}
function button(label: string, action: string, extra = "") {
  return `<button class="btn ${extra}" name="accion" value="${esc(action)}">${esc(label)}</button>`;
}
// Tarjeta grande de filtro (21/10/2026, "misma organizacion que
// influencers en klikar" -- grupos principales como tarjetas con icono +
// contador, no pestañas de texto). `icon` es un emoji, nunca un icon-font
// (coherente con el resto del CRM, que ya usa emoji sueltos como 🔴/✅).
function toggleCard(href: string, icon: string, iconBg: string, iconColor: string, label: string, sub: string, count: number, active: boolean): string {
  return `<a href="${esc(href)}" class="toggle-card${active ? " active" : ""}">
<span class="ticon" style="background:${iconBg};color:${iconColor}">${icon}</span>
<span class="tbody"><b>${esc(label)}</b><span class="sub" style="margin:0">${esc(sub)}</span></span>
<span class="tcount">${count}</span>
</a>`;
}

// ---------- pantalla ----------
// Lucero PRO (25/10/2026, "hazlo exactamente igual" al mockup de
// referencia): menú lateral en lista plana, con el orden y las 19
// secciones exactas del mockup. Las páginas reales que ya existían y no
// aparecen en el mockup (Clientes y oportunidades, Embudo comercial,
// Seguimiento -> ya es "Tareas" aquí, Incidencias, Entrada de leads,
// Clientes para publicidad, Studio IA) NO se eliminan -- sus rutas siguen
// vivas y alcanzables (desde "Editar/ver ficha" en Contactos, desde
// Buscar, o por URL directa), simplemente no están en este menú, mismo
// criterio que ya se usó al sacar Llamadas/WhatsApp/Correos del menú
// cuando se construyó Contactos. Las 4 secciones del mockup sin página
// real detrás (Anuncios/Agenda/Ventas/Ajustes) se construyen como rutas
// reales con un estado honesto "en construcción" -- nunca decorativas,
// nunca con datos inventados.
const NAV_ITEMS: { key: string; href: string; label: string; adminOnly?: boolean }[] = [
  { key: "home", href: "/crm", label: "Inicio" },
  { key: "car", href: "/crm/coches", label: "Vehículos" },
  // Clientes (/crm/clientes) tenía ruta y funcionalidad reales desde
  // siempre (filtros por temperatura, alta manual...) pero se quitó del
  // menú el 25/10/2026 al ajustar el menú al mockup de referencia, que no
  // la incluía -- a petición real (26/10/2026, "ni siquiera existe una
  // seccion de clientes que es lo mas importante") vuelve, y arriba del
  // todo porque es, literalmente, la sección más importante.
  { key: "briefcase", href: "/crm/clientes", label: "Clientes" },
  { key: "megaphone", href: "/crm/anuncios", label: "Anuncios" },
  // Studio IA tenía ruta propia (/crm/studio) desde el 16/10/2026 pero
  // solo era alcanzable como enlace suelto dentro de "Anuncios" -- a
  // petición real (26/10/2026, "esto ponlo como una seccion aparte") pasa
  // a tener su propia entrada en el menú, igual que el resto. Sigue
  // reservada a admin (gasta dinero real en cada generación, misma
  // decisión del 16-17/10/2026 documentada en page()).
  { key: "studio", href: "/crm/studio", label: "Studio IA", adminOnly: true },
  // A petición real (25/10/2026, "las secciones de fuera de llamada,
  // mensajes, whatsapp y correos, déjalas en contacto, fuera no hace
  // falta que estén"): Mensajes/WhatsApp/Llamadas/Correo ya no están
  // sueltas en el menú -- solo como pestañas dentro de Contactos
  // (/crm/contactos/whatsapp|correo|llamadas, que siguen existiendo
  // tal cual, nada se rompe). "Mensajes" se elimina del todo, pestaña
  // incluida, a petición expresa.
  { key: "user", href: "/crm/contactos", label: "Contactos" },
  { key: "calendar", href: "/crm/agenda", label: "Agenda" },
  { key: "pin", href: "/crm/citas", label: "Visitas" },
  { key: "bookmark", href: "/crm/reservas", label: "Reservas" },
  { key: "trending", href: "/crm/ventas", label: "Ventas" },
  { key: "check", href: "/crm/seguimiento", label: "Tareas" },
  { key: "chart", href: "/crm/informes", label: "Informes" },
  { key: "cpu", href: "/crm/asistentes", label: "Asistentes", adminOnly: true },
  { key: "plug", href: "/crm/integraciones", label: "Integraciones", adminOnly: true },
  { key: "users", href: "/crm/equipo", label: "Usuarios", adminOnly: true },
  { key: "settings", href: "/crm/ajustes", label: "Ajustes", adminOnly: true },
  { key: "trash", href: "/crm/papelera", label: "Papelera", adminOnly: true },
];
// Iconos de línea minimalistas, inline (sin depender de ningún CDN/
// librería externa -- este backend no sirve assets de terceros). Un solo
// trazo por icono, mismo estilo visual que el mockup.
const NAV_ICON_PATHS: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5M5.5 9.5V20a1 1 0 0 0 1 1h3.5v-6h4v6H17a1 1 0 0 0 1-1V9.5",
  car: "M5 16.5h14M6.5 16.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM5 12.5l1.3-4a2 2 0 0 1 1.9-1.4h7.6a2 2 0 0 1 1.9 1.4l1.3 4H5Z",
  megaphone: "M3 10v4a1 1 0 0 0 1 1h2l5.5 4V5L6 9H4a1 1 0 0 0-1 1Zm14-2.2a4 4 0 0 1 0 8.4M19 4.5a8 8 0 0 1 0 15",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9c0-4 3.6-7 8-7s8 3 8 7",
  message: "M21 11.5a8.5 8.5 0 0 1-12.3 7.6L4 20l1-4.7a8.5 8.5 0 1 1 16-3.8Z",
  phone: "M6.6 10.8a15.3 15.3 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.3.2 2.5.6 3.6a1 1 0 0 1-.25 1l-2.25 2.2Z",
  mail: "M4 5.5h16a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Zm-.6 1.1 8.6 6.3 8.6-6.3",
  calendar: "M7 3v3.2M17 3v3.2M4.5 9h15M5.5 5.5h13a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Z",
  pin: "M12 21s7-6.3 7-11.5A7 7 0 0 0 5 9.5C5 14.7 12 21 12 21Zm0-9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  bookmark: "M6.5 3h11a1 1 0 0 1 1 1v17l-6.5-4-6.5 4V4a1 1 0 0 1 1-1Z",
  trending: "M3 17l6-6 4 4 7.5-8.5M14 6.5h6.5V13",
  check: "M9 12.2l2 2 4-4.2M5.5 4h13a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z",
  chart: "M4.5 20V10.5M11 20V4.5M17.5 20v-7M4.5 20h16",
  cpu: "M8.5 4v3M12 4v3M15.5 4v3M8.5 17v3M12 17v3M15.5 17v3M4 8.5h3M4 12h3M4 15.5h3M17 8.5h3M17 12h3M17 15.5h3M7.5 7.5h9v9h-9Z",
  plug: "M9 3v5M15 3v5M6 8h12l-1 4.7a5 5 0 0 1-10 0L6 8Zm3 10v3m6-3v3",
  users: "M15.5 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.9M16.5 3.1a4 4 0 0 1 0 7.8",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-2.1a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V19a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H4a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V4a2 2 0 0 1 4 0v.1c0 .7.4 1.3 1 1.6h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1c.3.6.9 1 1.6 1H20a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
  trash: "M4 7h16M9.5 7V4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7m-8 0 1 12.2a1 1 0 0 0 1 .8h5.6a1 1 0 0 0 1-.8L18 7",
  studio: "m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z",
  briefcase: "M4 7.5h16a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1ZM8.5 7.5v-2a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2M3 12.5h18",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm9 2-5.2-5.2",
  bell: "M12 3a5 5 0 0 0-5 5v3.3c0 .6-.2 1.2-.6 1.7L5 15h14l-1.4-2c-.4-.5-.6-1.1-.6-1.7V8a5 5 0 0 0-5-5Zm-2.5 15a2.5 2.5 0 0 0 5 0",
  plus: "M12 5v14M5 12h14",
  chevron: "M6 9l6 6 6-6",
};
function navIcon(key: string, size = 18): string {
  const d = NAV_ICON_PATHS[key] ?? NAV_ICON_PATHS.user;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
}

function page(section: string, user: CrmUser, body: string, msg?: string): string {
  // Studio IA gasta dinero real en cada generación (16-17/10/2026) -- a
  // petición real ("a esa seccion, solo puedo acceder yo y el correo de
  // automoviles lucero o administradores") queda reservada a admins, igual
  // que Papelera/Integraciones/Equipo.
  const navItems = NAV_ITEMS.filter((it) => !it.adminOnly || user.role === "admin");
  // Datos reales para la barra superior (25/10/2026) -- nunca inventados,
  // mismos conteos/condiciones ya usados en Hoy y en Correos/WhatsApp/
  // Incidencias, recalculados aquí porque la barra la comparten todas
  // las páginas, no solo Hoy.
  const pendingMails = list<InboxMail>("email_inbox").filter((m) => m.outcome !== "automated_no_reply" && !m.answered).length;
  const pendingWhatsapp = list<WhatsappMessage>("whatsapp_inbox").filter((m) => !m.answered).length;
  const msgTotal = pendingMails + pendingWhatsapp;
  const msgHref = pendingWhatsapp > pendingMails ? "/crm/contactos/whatsapp?f=pendientes" : "/crm/contactos/correo?f=pendientes";
  const msgTitle = `${pendingMails} correo(s) y ${pendingWhatsapp} WhatsApp sin responder`;
  const overdueTasks = listTasks().filter((t) => t.status === "pendiente" && (t.priority === "alta" || (t.due_at && t.due_at < new Date().toISOString()))).length;
  const alertCount = pendingAlerts().length;
  const notifTotal = overdueTasks + alertCount;
  const notifTitle = `${alertCount} aviso(s) urgente(s) y ${overdueTasks} tarea(s) vencida(s)`;
  const roleLabel: Record<string, string> = { admin: "Administrador", comercial: "Comercial", equipo: "Equipo" };
  const integrationsOk = isZernioWhatsappConfigured() && googleStatus().connected && Boolean(process.env.RETELL_API_KEY) && Boolean(process.env.OPENAI_API_KEY);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(section)} · Lucero</title>
<link rel="manifest" href="/crm/manifest.json"><meta name="theme-color" content="#ffffff">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Lucero"><link rel="apple-touch-icon" href="/crm/icono.svg">
<style>
*{box-sizing:border-box}
/* Identidad visual CRM PRO (25/10/2026, rediseño pedido estilo coches.net
   PRO): fondo blanco, paneles gris muy claro, rojo = acción/prioridad,
   verde = confirmado, naranja = pendiente, rojo intenso = urgente. Un
   solo lugar para estos colores -- el resto del CSS los usa por token,
   nunca el hex suelto, para no volver a tener dos rojos/naranjas por
   accidente. */
:root{--bg:#ffffff;--panel:#f6f7f9;--ink:#1a1d23;--ink-dim:#5b6472;--border:#e3e5ea;--accent:#dc2626;--accent-dim:#fdeceb;--urgent:#b3261e;--ok:#2e9e55;--ok-bg:#e3f6e8;--warn:#d9822b;--warn-bg:#fff4e0;--off:#9aa1ad}
body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
/* Menú lateral rediseñado (25/10/2026, rediseño visual CRM PRO: fondo
   blanco, acento rojo, colapsable, con barra superior nueva) -- header/
   nav/main siguen siendo los mismos elementos de siempre (softRefreshHoy
   sigue buscando el texto literal <main>/</main>, sin tocar: solo se le
   añade un wrapper .appcol alrededor junto con la barra superior, el
   propio <main> no cambia). En móvil (<=900px) la barra lateral vuelve a
   ser horizontal, sin colapsar (es más usable con poco ancho).*/
body{display:flex;min-height:100vh}
header{background:var(--bg);color:var(--ink);border-right:1px solid var(--border);padding:16px 12px;display:flex;flex-direction:column;gap:14px;flex:0 0 226px;width:226px;height:100vh;position:sticky;top:0;align-self:flex-start;transition:width .15s,flex-basis .15s}
header .brand{display:flex;align-items:center;gap:10px}
header .brand .wordmark{font-size:19px;font-weight:800;color:var(--ink);white-space:nowrap;overflow:hidden;letter-spacing:-.02em}
header .brand .wordmark em{font-style:normal;background:var(--accent);color:#fff;font-size:11px;font-weight:800;padding:2px 7px;border-radius:999px;margin-left:5px;vertical-align:2px}
header .brand .subbrand{display:block;font-size:9.5px;font-weight:600;letter-spacing:.09em;color:var(--ink-dim);white-space:nowrap;overflow:hidden;margin-top:1px}
.sidebar-toggle{background:none;border:1px solid var(--border);border-radius:8px;width:30px;height:30px;flex:0 0 30px;font-size:15px;line-height:1;cursor:pointer;color:var(--ink-dim)}
.sidebar-toggle:hover{background:var(--panel)}
nav{display:flex;flex-direction:column;gap:1px;flex:1;overflow-y:auto}
nav a{color:var(--ink);text-decoration:none;display:flex;align-items:center;gap:11px;padding:8px 10px;border-radius:9px;font-size:13.5px}
nav a .navicon{flex:0 0 18px;display:flex;color:var(--ink-dim)}
nav a .navlabel{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
nav a:hover{background:var(--panel)}
nav a.on{background:var(--accent-dim);color:var(--accent);font-weight:700}
nav a.on .navicon{color:var(--accent)}
.sidebar-user{display:flex;align-items:center;gap:10px;padding:10px 6px 2px;border-top:1px solid var(--border);margin-top:4px}
.sidebar-user .avatar{width:32px;height:32px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0}
.sidebar-user .uname{font-size:13px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sidebar-user .urole{font-size:11px;color:var(--ink-dim)}
.sidebar-user form{margin:0 0 0 auto}
.sidebar-user form button{padding:5px 9px;font-size:12px;margin:0}
header.collapsed{width:60px;flex:0 0 60px;padding:16px 8px}
header.collapsed .brand .wordmark,header.collapsed .brand .subbrand,header.collapsed nav a .navlabel,header.collapsed .sidebar-user .uname,header.collapsed .sidebar-user .urole,header.collapsed .sidebar-user form{display:none}
header.collapsed nav a{justify-content:center;padding:9px 0}
header.collapsed .sidebar-user{justify-content:center}
.appcol{flex:1;min-width:0;display:flex;flex-direction:column;min-height:100vh}
.topbar{display:flex;align-items:center;gap:10px;background:var(--bg);border-bottom:1px solid var(--border);padding:10px 18px;position:sticky;top:0;z-index:5;flex-wrap:wrap}
.topbar-search{flex:1;min-width:200px;max-width:520px;margin:0;display:flex;align-items:center;gap:6px;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:0 6px 0 10px}
.topbar-search svg{flex:0 0 16px;color:var(--ink-dim)}
.topbar-search input{flex:1;margin:0;padding:9px 6px;font-size:14px;background:transparent;border:0}
.topbar-search kbd{font:inherit;font-size:11px;color:var(--ink-dim);background:#fff;border:1px solid var(--border);border-radius:6px;padding:2px 6px;margin:0}
.topbar-icon{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:10px;border:1px solid var(--border);background:#fff;color:var(--ink);text-decoration:none;position:relative;flex-shrink:0}
.topbar-icon:hover{background:var(--panel)}
.topbar-icon .badge{position:absolute;top:-6px;right:-6px;background:var(--accent);color:#fff;font-size:10px;font-weight:700;border-radius:999px;min-width:17px;height:17px;display:flex;align-items:center;justify-content:center;padding:0 4px}
.topbar-status{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--ink);white-space:nowrap}
.topbar-status .dot{width:9px;height:9px;border-radius:50%;flex:0 0 9px}
.topbar-status .dot.ok{background:var(--ok)}
.topbar-status .dot.down{background:var(--urgent)}
.topbar-biz{display:flex;align-items:center;gap:4px;font-size:14px;font-weight:700;color:var(--ink);text-decoration:none;white-space:nowrap}
main{flex:1;min-width:0;max-width:1440px;width:100%;margin:0 auto;padding:18px}
@media(max-width:900px){
body{display:block}
header{position:static;width:auto!important;flex:none!important;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:space-between}
nav{flex-direction:row;flex-wrap:wrap;overflow-y:visible}
.sidebar-user{border-top:0}
}
h1{font-size:27px;margin:4px 0 4px;letter-spacing:-.01em}
h2{font-size:20px;margin:20px 0 10px}
.sub{color:var(--ink-dim);margin:0 0 16px;font-size:15px}
.msg{background:var(--ok-bg);border:1px solid var(--ok);padding:12px 16px;border-radius:9px;margin-bottom:16px;font-size:15px;font-weight:600;color:var(--ink)}
.card{background:#fff;border:1px solid var(--border);border-radius:7px;padding:14px 16px;margin-bottom:12px;box-shadow:none;display:flex;gap:14px;flex-wrap:wrap;position:relative}
/* Inicio en dos columnas (26/10/2026, "F1" -- petición real: "es una
   lista larga de secciones apiladas" -- quería la ESTRUCTURA distinta,
   no solo el estilo). Izquierda: lo urgente/de hoy (avisos, pendientes,
   visitas y reservas de hoy). Derecha, más estrecha: lo que entra nuevo
   (clientes de hoy, próximas visitas). En pantalla estrecha se apila
   igual que antes -- ninguna columna queda más angosta que el contenido. */
.home-cols{display:flex;gap:22px;align-items:flex-start;flex-wrap:wrap}
.home-main{flex:2 1 480px;min-width:0}
.home-side{flex:1 1 300px;min-width:0}
@media(max-width:860px){.home-cols{flex-direction:column}}
/* Fichas de clientes en horizontal, varias por fila (22/10/2026, petición
   real: "ese orden usalo para los clientes... en todas las secciones" --
   mismo criterio visto en el CRM de Klikar: grid que reparte en columnas
   según el ancho, en vez de una lista apilada de una sola columna). */
.cards-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;margin-bottom:14px}
.cards-grid .card{margin:0}
/* Tarjeta de vehículo (26/10/2026, "B1" -- cuadrícula en vez de lista
   plana). Sin foto real en el catálogo -- el bloque "Sin foto" es
   honesto, nunca una imagen inventada. */
.vehicle-card{background:#fff;border:1px solid var(--border);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:7px}
.vehicle-card .photo{height:60px;border-radius:8px;background:var(--panel);display:flex;align-items:center;justify-content:center;color:#b6bac2;font-size:11px}
.vehicle-card h3{margin:0;font-size:15px}
.vehicle-card .specs{font-size:12.5px;color:var(--ink-dim)}
.vehicle-card .pricerow{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px}
.vehicle-card .pricerow b{font-size:19px;white-space:nowrap}
.vehicle-card .btn{margin:2px 0 0;text-align:center}
/* Fila compacta (26/10/2026, "mandame ideas de tarjetas" -> "vamos a
   probar esta" -- opción B de tres ideas, elegida por Eliud para
   Clientes, y luego "A2" para Visitas/Reservas en la ronda de "diseño de
   todas las secciones"): en vez de una tarjeta alta, una fila de una
   sola línea -- se ve mucho más de un vistazo con muchos registros.
   .record-row es genérica (antes "lead-row", solo para Clientes) para
   que Visitas/Reservas reutilicen exactamente el mismo lenguaje visual,
   solo cambiando el avatar circular por una fecha compacta. flex-wrap en
   vez de columnas fijas de grid para que no se rompa en pantallas
   estrechas (p. ej. la mini-ficha dentro de Contactos): lo que no cabe
   baja de línea solo.*/
.records-list{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}
.record-row{display:flex;align-items:center;gap:14px;background:#fff;border:1px solid var(--border);border-radius:11px;padding:11px 16px;flex-wrap:wrap}
.record-row .avatar{width:34px;height:34px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex-shrink:0}
.record-row .datebadge{min-width:46px;flex-shrink:0;border-radius:9px;padding:4px 8px;text-align:center}
.record-row .datebadge span{display:block;font-size:9px;text-transform:uppercase}
.record-row .datebadge b{display:block;font-size:15px;line-height:1.15}
.record-row .who{min-width:120px;flex:1 1 150px;display:flex;flex-direction:column;gap:1px}
.record-row .who b{font-size:15.5px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.record-row .who span{font-size:12.5px;color:var(--ink-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.record-row .situation{min-width:160px;flex:2 1 220px;font-size:13px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.record-row .meta{display:flex;align-items:center;gap:10px;flex-shrink:0}
.record-row .temp{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;white-space:nowrap}
.record-row .temp i{width:7px;height:7px;border-radius:999px;display:inline-block}
.record-row .lastcontact{font-size:12.5px;color:var(--ink-dim);white-space:nowrap;flex-shrink:0}
.record-row .acts{display:flex;align-items:center;gap:6px;margin-left:auto;flex-shrink:0}
.record-row .flags{flex-basis:100%;display:flex;flex-wrap:wrap;gap:6px}
.record-row .edits{flex-basis:100%;display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px;border-top:1px solid #f0f1f3;padding-top:10px;margin-top:2px}
.record-row .edits label{font-size:11.5px;margin:0 0 3px}
.record-row .edits input{width:auto;margin:0;padding:7px 9px;font-size:13px}
.record-row .btn{font-size:13px;padding:6px 10px;margin:0}
.card .info{flex:1;min-width:220px}
.card h3{margin:0 0 6px;font-size:18px}
.card p{margin:3px 0;font-size:15px}
/* Fichas más pequeñas dentro de .cards-grid (22/10/2026, petición real:
   "me gusta asi [el contenido]... pero que sea un poco mas pequeño no ta
   grande") -- mismo contenido/orden de siempre, solo más compacto: no se
   toca el tamaño de letra/botones del resto del CRM (serían demasiado
   pequeños para pulsar fuera de una ficha). */
.card .tag{font-size:13px;padding:4px 10px;margin:3px 4px 3px 0}
.card .tletra{width:26px;height:26px;font-size:13px}
.card .origen{font-size:13px;padding:3px 8px}
.card .btn{font-size:14px;padding:8px 14px;margin:4px 6px 4px 0}
.when{background:#fff;color:var(--ink);border:1px solid var(--border);border-radius:6px;padding:8px 12px;text-align:center;min-width:92px}
.when b{display:block;font-size:32px;line-height:1}
.when span{font-size:14px;display:block;color:var(--ink-dim)}
.when em{font-style:normal;font-size:21px;font-weight:700;display:block;margin-top:4px}
.tag{display:inline-block;padding:5px 11px;border-radius:999px;font-size:14px;margin:4px 6px 4px 0;background:var(--panel)}
.todo{background:var(--warn-bg);border:1px solid var(--warn);border-radius:9px;padding:14px 16px;margin-bottom:20px}
.todo a{display:block;font-size:16px;padding:8px 0;color:var(--ink);font-weight:600;text-decoration:none}
.allok{background:var(--ok-bg);border:1px solid var(--ok);border-radius:9px;padding:16px;margin-bottom:20px;font-size:17px;font-weight:700;color:var(--ink)}
.empty{background:#fff;border:1px solid var(--border);border-radius:9px;padding:18px;color:var(--ink-dim);font-size:15px}
/* Rediseño de tarjetas (25/10/2026, 2º aviso: "cambia el diseño, sigue
   igual que antes") -- la barra de color de 4px se cambia por un tinte
   suave de fondo en toda la tarjeta (mismo criterio que ya usan las
   tarjetas de Actividad en Contactos), más sutil que una barra sólida y
   visualmente bien distinto de antes. El estado ya se lee en el texto
   del .tag de cada tarjeta -- el color de fondo es un apoyo, no la única
   señal. */
.urgent{background:#fdecea;border-color:#f3c6c1}.pending{background:var(--warn-bg);border-color:#f0dcb3}.done{background:var(--ok-bg);border-color:#c7e8d1}.off{background:var(--panel);opacity:.7}
/* Módulo mensajes/clientes (18/10/2026): "leído" y "respondido" son estados
   distintos -- sin responder resalta (fondo claro, texto en negrita);
   respondido se apaga (fondo gris, sin perder legibilidad); sin leer lleva
   además el texto en negrita. No confundir con .urgent/.pending/.done, que
   son el borde de color de Pendientes/Reservas/Visitas. */
.msg-unanswered{background:#fffaf0}
.msg-answered{background:#f3f4f6;opacity:.82}
.msg-unread h3,.msg-unread .meta{font-weight:800}
.msg-read h3,.msg-read .meta{font-weight:400}
.estado-ia{background:#e0ecff;color:#1d3a8a}
.estado-equipo{background:#e3f6e8;color:#1d6b3d}
.bulkbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;background:#fff;border:1px solid var(--border);border-radius:9px;padding:14px 18px;margin:0 0 16px;box-shadow:none}
.bulkbar label{font-size:17px;font-weight:600;display:flex;align-items:center;gap:6px}
.msgsel{width:22px;height:22px;margin:0}
.filterbar{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}
.filterbar a{text-decoration:none}
.btn{font:inherit;font-size:15px;padding:11px 18px;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer;margin:6px 8px 6px 0;text-decoration:none;display:inline-block}
.btn.ok{background:var(--ok)}.btn.warn{background:var(--warn)}.btn.danger{background:var(--urgent)}.btn.light{background:var(--panel);color:var(--ink)}
/* Botón de solo icono (26/10/2026, fila compacta de Clientes) -- mismo
   tamaño que .tletra, para que quepan Llamar/WhatsApp/Correo sin que la
   fila crezca de alto. */
.ibtn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:9px;border:1px solid var(--border);background:#fff;color:var(--ink);text-decoration:none;cursor:pointer;margin:0;flex-shrink:0}
.ibtn:hover{border-color:var(--accent);color:var(--accent)}
input,select,textarea{font:inherit;font-size:15px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;width:100%;margin:6px 0 14px;background:#fff}
label{font-size:14px;font-weight:700;color:var(--ink)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:640px){.row{grid-template-columns:1fr}h1{font-size:23px}}
.box{background:#fff;border:1px solid var(--border);border-radius:9px;padding:18px 20px;margin-bottom:18px;box-shadow:none;overflow-wrap:break-word;word-break:break-word}
/* Integraciones en dos columnas (21/10/2026, a petición real: "ponlas en
   un lado como el crm de klikar") -- lista lateral de secciones a la
   izquierda (ancla a cada caja), contenido a la derecha. Solo esta
   página la usa, no toca el resto del CSS compartido. */
.side-layout{display:flex;gap:24px;align-items:flex-start}
.side-nav{flex:0 0 220px;position:sticky;top:20px;display:flex;flex-direction:column;gap:4px}
.side-nav a{padding:10px 14px;border-radius:12px;text-decoration:none;color:var(--ink);font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.side-nav a:hover{background:#e4e7ec}
.side-nav a.on-tab{background:var(--accent);color:#fff}
.side-nav a.on-tab .tag{background:#fff!important;color:var(--accent)!important}
/* Pestañas horizontales de Contactos (25/10/2026, mockup: Mensajes/
   WhatsApp/Llamadas/Correo arriba, subrayado rojo en la activa). */
.htabs{display:flex;gap:22px;border-bottom:1px solid var(--border);margin-bottom:16px;flex-wrap:wrap}
.htabs a{display:inline-flex;align-items:center;gap:6px;padding:4px 2px 11px;color:var(--ink-dim);text-decoration:none;font-size:14px;font-weight:600;border-bottom:2px solid transparent;margin-bottom:-1px}
.htabs a.on-tab{color:var(--ink);border-bottom-color:var(--accent)}
.htabs a .tag{background:var(--accent);color:#fff;font-size:11px;padding:1px 7px}
.side-content{flex:1;min-width:0}
@media(max-width:900px){.side-layout{flex-direction:column}.side-nav{position:static;flex-direction:row;flex-wrap:wrap;width:100%}}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:18px}
.stat{background:#fff;border:1px solid var(--border);border-radius:9px;padding:14px 16px;text-decoration:none;color:inherit;border-left:4px solid var(--accent);box-shadow:none}
.stat b{display:block;font-size:30px;line-height:1;color:var(--ink)}
.stat span{font-size:14px;color:var(--ink-dim)}
/* Tarjetas grandes de filtro (21/10/2026, a petición real: "usa la misma
   organizacion que utilizamos para influencers en klikar" -- ahí los
   grupos principales son tarjetas grandes clicables con icono y
   contador, no pestañas de texto pequeñas). Mismo patrón aquí, en vez de
   reimplementar el componente de Klikar (React) en un backend 100%
   servidor sin framework -- misma idea visual, con las herramientas que
   ya existen en este CRM. */
.toggle-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:18px}
.toggle-card{display:flex;align-items:center;gap:12px;background:#fff;border-radius:16px;padding:16px 18px;text-decoration:none;color:inherit;box-shadow:0 1px 3px rgba(0,0,0,.08);border:3px solid transparent}
.toggle-card:hover{border-color:#c3c9d4}
.toggle-card.active{border-color:var(--accent);background:var(--accent-dim)}
.toggle-card .ticon{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0}
.toggle-card .tbody{flex:1;min-width:0}
.toggle-card .tbody b{display:block;font-size:18px;line-height:1.25}
.toggle-card .tbody .sub{display:block;font-size:14px;line-height:1.3;color:#6b7280;margin:2px 0 0}
.toggle-card .tcount{font-size:32px;font-weight:800;line-height:1}
.t-hot{background:var(--accent);color:#fff;font-weight:700}
.t-warm{background:#f97316;color:#fff;font-weight:700}
.t-cold{background:#2563eb;color:#fff;font-weight:700}
.tletra{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9px;font-weight:800;margin-right:8px;flex-shrink:0}
.origen{display:inline-block;background:#e2e8f0;color:#1e293b;font-size:15px;font-weight:600;padding:4px 10px;border-radius:999px;margin-right:6px}
.legend{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}
a.link{color:#1d4ed8;font-weight:700;font-size:20px}
.search{display:flex;gap:10px;margin:0 0 16px}.search input{margin:0}
.pick-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px;margin:0 0 20px}
.pick-grid.compact{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.pick-card{display:flex;flex-direction:column;gap:6px;background:#fff;border:3px solid #e4e7ec;border-radius:16px;padding:14px;cursor:pointer;position:relative;transition:border-color .12s,transform .12s,box-shadow .12s}
.pick-card input{position:absolute;opacity:0;pointer-events:none}
.pick-card:hover{transform:translateY(-2px);box-shadow:0 4px 14px rgba(0,0,0,.08)}
.pick-card:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 3px rgba(220,38,38,.15)}
.pick-icon-badge{width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;color:#fff;background:var(--accent)}
.pick-label{font-weight:700;font-size:18px}
.pick-desc{font-size:14px;color:#4b5563;margin:0}
.pill-group{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px}
.pill-choice{display:inline-flex;align-items:center;gap:6px;background:#e8ebf1;border:3px solid transparent;border-radius:999px;padding:10px 16px;font-size:17px;cursor:pointer;font-weight:600;position:relative}
.pill-choice input{position:absolute;opacity:0;pointer-events:none}
.pill-choice:has(input:checked){background:var(--accent);color:#fff}
/* Lucero Studio AI: mundo propio, más colorido que el resto del CRM (a
   petición real, 17/10/2026: "mas colorido, mas tarjetas y mejor orden") --
   vídeo en azul, imagen en ámbar, para que se distinga de un vistazo qué
   grupo de plantillas/opciones aplica a cuál. */
.studio-section{border-radius:18px;padding:18px 20px;margin:0 0 20px}
.studio-section.sec-video{background:linear-gradient(135deg,#eef4ff,#f7faff)}
.studio-section.sec-image{background:linear-gradient(135deg,#fff4e6,#fffaf2)}
.studio-section.sec-tune{background:linear-gradient(135deg,#f3f0ff,#faf8ff)}
.studio-section h2{margin:0 0 4px;font-size:22px}
.studio-section .sub{margin:0 0 14px}
.pick-card.kind-video{background:#fff;border-color:#c7dbff}
.pick-card.kind-video:has(input:checked){border-color:#2563eb;background:#eaf1ff;box-shadow:0 0 0 3px rgba(37,99,235,.18)}
.pick-card.kind-video .pick-icon-badge{background:#2563eb}
.pick-card.kind-image{background:#fff;border-color:#f3d9ad}
.pick-card.kind-image:has(input:checked){border-color:#d9822b;background:#fff1dc;box-shadow:0 0 0 3px rgba(217,130,43,.18)}
.pick-card.kind-image .pick-icon-badge{background:#d9822b}
.pick-card.kind-tune{background:#fff;border-color:#ddd0fb}
.pick-card.kind-tune:has(input:checked){border-color:#7c3aed;background:#f3ecff;box-shadow:0 0 0 3px rgba(124,58,237,.18)}
.pick-card.kind-tune .pick-icon-badge{background:#7c3aed}
.studio-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:0 0 20px}
.studio-ribbon{display:inline-block;padding:5px 12px;border-radius:999px;font-size:14px;font-weight:700;color:#fff;margin-bottom:6px}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
.gallery .card{display:block;margin:0;position:relative}
/* Contactos Pro -- vista de 3 paneles (25/10/2026, a petición real con
   mockup de referencia: lista / ficha / actividad, como un cliente de
   correo). Solo la usa /crm/contactos -- las páginas sueltas de siempre
   (/crm/whatsapp, /crm/correos, /crm/llamadas) siguen con sus tarjetas de
   toda la vida, sin tocar. */
.contactos-shell{display:flex;background:#fff;border:1px solid var(--border);border-radius:12px;overflow:hidden}
.contactos-list{flex:0 0 330px;border-right:1px solid var(--border);display:flex;flex-direction:column;min-width:0}
.contactos-list-scroll{overflow-y:auto;max-height:70vh}
.contact-row{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--border);text-decoration:none;color:var(--ink)}
.contact-row:hover{background:var(--panel)}
.contact-row.active{background:var(--accent-dim)}
.contact-row .avatar{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex-shrink:0}
.contact-row .rbody{flex:1;min-width:0}
.contact-row .rbody b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.contact-row .rbody .rsub{display:block;font-size:12px;color:var(--ink-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.contact-row .rmeta{text-align:right;flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.contact-row .rmeta time{font-size:11px;color:var(--ink-dim)}
.contactos-detail{flex:1;min-width:0;padding:20px 24px;max-height:70vh;overflow-y:auto}
.contactos-activity{flex:0 0 290px;border-left:1px solid var(--border);padding:16px;max-height:70vh;overflow-y:auto;min-width:0}
.cpager{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;border-top:1px solid var(--border);font-size:12px;color:var(--ink-dim)}
.cpager a{color:var(--ink);text-decoration:none;padding:3px 7px;border-radius:6px}
.cpager a.on{background:var(--accent);color:#fff}
.meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin:14px 0;background:var(--panel);border-radius:10px;padding:12px 14px}
.meta-grid div{font-size:12px;color:var(--ink-dim)}
.meta-grid div b{display:block;font-size:14px;color:var(--ink);font-weight:700;margin-top:2px}
.activity-item{border-radius:10px;padding:10px 12px;margin-bottom:8px;font-size:13px}
.activity-item.in{background:#fdecea}
.activity-item.ia{background:var(--panel)}
.activity-item.wa{background:var(--ok-bg)}
.activity-item.email{background:#e0ecff}
.activity-item time{display:block;font-size:11px;color:var(--ink-dim);margin-top:4px}
/* Conversación real de WhatsApp (25/10/2026, petición real: "quiero que
   se vea la conversacion real") -- todos los mensajes reales con ese
   teléfono, en orden, cliente a la izquierda y negocio a la derecha,
   como un chat de verdad. Nada inventado: cada burbuja es un registro
   real de whatsapp_inbox. */
/* Colores reales de WhatsApp (26/10/2026, petición real: "que se parezca
   lo mas a whassap") -- fondo de chat beige/verde clásico, burbuja
   saliente verde clara, entrante blanca, hora dentro de la propia
   burbuja (como WhatsApp de verdad), no como línea aparte. */
.wa-thread{display:flex;flex-direction:column;gap:6px;max-height:380px;overflow-y:auto;padding:12px;background:#e5ddd5;border-radius:10px}
.wa-bubble{max-width:78%;padding:7px 10px 8px;border-radius:8px;font-size:14px;white-space:pre-wrap;box-shadow:0 1px 1px rgba(0,0,0,.08)}
.wa-row{display:flex;flex-direction:column}
.wa-row.in{align-items:flex-start}
.wa-row.out{align-items:flex-end}
.wa-row .wa-bubble.in{background:#fff;border-top-left-radius:2px}
.wa-row .wa-bubble.out{background:#d9fdd3;border-top-right-radius:2px}
.wa-bubble time{display:block;font-size:10.5px;color:#8696a0;text-align:right;margin-top:3px}
.wa-typing-row{display:flex;justify-content:flex-start}
.wa-typing{display:inline-flex;align-items:center;gap:5px;background:#fff;border-radius:8px;border-top-left-radius:2px;padding:9px 12px;box-shadow:0 1px 1px rgba(0,0,0,.08)}
.wa-typing span{width:6px;height:6px;border-radius:999px;background:#8696a0;display:inline-block;animation:wa-bounce 1.2s infinite ease-in-out}
.wa-typing span:nth-child(2){animation-delay:.15s}
.wa-typing span:nth-child(3){animation-delay:.3s}
@keyframes wa-bounce{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}
/* Hilo de correo al estilo Gmail (26/10/2026, "en gmail tambien") -- cada
   mensaje real como su propia tarjeta con remitente/hora, los nuestros
   (Daniel o el equipo) con un tinte azulado, igual que Gmail resalta tus
   propios mensajes enviados dentro de una conversación. */
.mail-thread{display:flex;flex-direction:column;gap:8px;max-height:420px;overflow-y:auto;padding:2px}
.mail-item{background:#fff;border:1px solid var(--border);border-radius:9px;padding:10px 14px;display:flex;gap:10px}
.mail-item.out{background:#f0f6ff;border-color:#c7d9f5}
.mail-item .mail-body{flex:1;min-width:0}
.mail-item .mail-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:3px}
.mail-item .mail-from{font-weight:700;font-size:13.5px}
.mail-item .mail-time{font-size:11px;color:var(--ink-dim);white-space:nowrap}
.mail-item .mail-text{font-size:13.5px;white-space:pre-wrap;color:var(--ink)}
.mail-typing{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:#1f7a42;font-weight:700;padding:4px 2px}
@media(max-width:1100px){.contactos-shell{flex-direction:column}.contactos-list{flex:none;border-right:0;border-bottom:1px solid var(--border)}.contactos-list-scroll{max-height:320px}.contactos-activity{flex:none;border-left:0;border-top:1px solid var(--border);max-height:none}.contactos-detail{max-height:none}}
@media print{header,nav,.noprint,.btn{display:none!important}body{background:#fff}main{max-width:none}.card{box-shadow:none;border:1px solid #999}}
</style></head><body>
<header id="sidebar">
<div class="brand"><button class="sidebar-toggle" type="button" aria-label="Contraer o expandir el menú" onclick="luceroToggleSidebar()">☰</button><a href="/crm" style="text-decoration:none"><span class="wordmark">LUCERO<em>PRO</em></span><span class="subbrand">AUTOMÓVILES LUCERO</span></a></div>
<nav>${navItems.map((it) => `<a href="${it.href}" class="${section === it.label ? "on" : ""}" title="${esc(it.label)}"><span class="navicon">${navIcon(it.key)}</span><span class="navlabel">${esc(it.label)}</span></a>`).join("")}</nav>
<div class="sidebar-user"><div class="avatar">${esc(avatarInitials(user.name))}</div><div style="min-width:0"><div class="uname">${esc(user.name)}</div><div class="urole">${esc(roleLabel[user.role] ?? user.role)}</div></div><form method="post" action="/crm/salir"><button class="btn light" type="submit">Salir</button></form></div>
</header>
<div class="appcol">
<div class="topbar noprint">
<form class="topbar-search" method="get" action="/crm/buscar">${navIcon("search", 16)}<input id="lucero-search" name="q" placeholder="Buscar contactos, vehículos, matrículas..." required><kbd>⌘K</kbd></form>
<a class="topbar-icon" href="/crm/seguimiento" title="Crear una tarea">${navIcon("plus", 18)}</a>
<a class="topbar-icon" href="${msgHref}" title="${esc(msgTitle)}">${navIcon("message", 18)}${msgTotal > 0 ? `<span class="badge">${msgTotal > 99 ? "99+" : msgTotal}</span>` : ""}</a>
<a class="topbar-icon" href="/crm" title="${esc(notifTitle)}">${navIcon("bell", 18)}${notifTotal > 0 ? `<span class="badge">${notifTotal > 99 ? "99+" : notifTotal}</span>` : ""}</a>
<span class="topbar-status"><span class="dot ${integrationsOk ? "ok" : "down"}"></span>${integrationsOk ? "Asistentes activos" : "Revisar asistentes"}</span>
<a class="topbar-biz" href="/crm/integraciones" style="margin-left:auto">Automóviles Lucero${navIcon("chevron", 14)}</a>
</div>
<main>${msg ? `<div class="msg">${esc(msg)}</div>` : ""}${body}</main>
</div>
<script>
function luceroToggleSidebar(){try{var h=document.getElementById('sidebar');var on=h.classList.toggle('collapsed');localStorage.setItem('lucero_sidebar_collapsed',on?'1':'0')}catch(e){}}
(function(){try{if(localStorage.getItem('lucero_sidebar_collapsed')==='1'){var h=document.getElementById('sidebar');if(h)h.classList.add('collapsed')}}catch(e){}})();
document.addEventListener("keydown", function (e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); var s = document.getElementById("lucero-search"); if (s) s.focus(); }
});
</script>
<script>
// Mantiene el scroll al enviar un formulario (14/10/2026, a petición real:
// "cada vez que elimino un cliente la página vuelve al principio"). Cualquier
// acción con botón (eliminar, confirmar, cancelar...) hace un POST normal que
// recarga la página entera -- el navegador vuelve arriba por defecto. Se
// guarda la posición justo antes de enviar cualquier formulario de esta
// página, y se restaura al cargar la misma URL base (sin la query de
// mensaje) después del redirect. Genérico: funciona en cualquier lista del
// CRM, no solo en Clientes.
(function () {
  // FALLO REAL detectado (23/10/2026, "cada vez que borro algo en clientes la
  // pagina se mueve"): guardar window.scrollY en crudo solo funciona si el
  // alto de la página es el mismo antes y después del redirect -- al borrar
  // una tarjeta (o si las tarjetas cambian de tamaño, como pasó hoy al
  // hacerlas más compactas) el alto total cambia, y ese mismo número de
  // píxeles ya no apunta al mismo sitio visual. Se guarda como proporción
  // del alto total en vez de un valor absoluto, así se adapta sola si el
  // documento es un poco más alto o más bajo en la carga siguiente.
  var KEY = "lucero_scroll:" + location.pathname;
  var saved = sessionStorage.getItem(KEY);
  if (saved) {
    sessionStorage.removeItem(KEY);
    var ratio = parseFloat(saved);
    if (!isNaN(ratio)) window.scrollTo(0, ratio * document.documentElement.scrollHeight);
  }
  // Contactos tiene su propio scroll interno por columna (lista/ficha/
  // actividad), aparte del scroll de la página -- se guarda igual, como
  // proporción, con una clave por columna (25/10/2026, mismo aviso: "que
  // no se mueva la pantalla").
  var INNER_SELECTORS = [".contactos-list-scroll", ".contactos-detail", ".contactos-activity"];
  INNER_SELECTORS.forEach(function (sel) {
    var innerKey = KEY + ":" + sel;
    var innerSaved = sessionStorage.getItem(innerKey);
    if (innerSaved) {
      sessionStorage.removeItem(innerKey);
      var el = document.querySelector(sel);
      var r = parseFloat(innerSaved);
      if (el && !isNaN(r)) el.scrollTop = r * el.scrollHeight;
    }
  });
  document.addEventListener("submit", function () {
    try {
      var h = document.documentElement.scrollHeight;
      sessionStorage.setItem(KEY, String(h > 0 ? window.scrollY / h : 0));
      INNER_SELECTORS.forEach(function (sel) {
        var el = document.querySelector(sel);
        if (el && el.scrollHeight > 0) sessionStorage.setItem(KEY + ":" + sel, String(el.scrollTop / el.scrollHeight));
      });
    } catch (e) {}
  }, true);
})();
// Selección masiva de mensajes (módulo mensajes/clientes, 18/10/2026):
// la casilla "Seleccionar todos" marca/desmarca todas las de su misma
// bandeja de un golpe. Genérico, lo usan Correos/WhatsApp/Llamadas.
window.toggleAllMsgs = function (master, name) {
  document.querySelectorAll('input[type=checkbox][name="' + name + '"]').forEach(function (cb) {
    cb.checked = master.checked;
  });
};
// Aviso en vivo de alertas urgentes (13/10/2026, sin sonido desde
// 25/10/2026 -- a petición real: "quita todo eso de activar sonido").
// Comprueba cada 15s si hay una alerta urgente nueva (lead caliente,
// reserva, escalado) y, si la hay y estás en Hoy, refresca esa página
// sola -- sigue siendo útil sin el timbre, por eso se queda.
(function () {
  var KEY = "lucero_seen_alerts";
  function seen() { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; } }
  function saveSeen(a) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) {} }
  function softRefreshHoy() {
    // Se extrae con indexOf/substring, no con un regex -- un regex aquí
    // dentro de esta plantilla de TypeScript necesita las barras
    // invertidas escapadas dos veces (una para TS, otra para el propio
    // regex), y un fallo exacto en ese escapado rompió TODO este script
    // la primera vez (13/10/2026) -- ni sonaba ni refrescaba nada, un
    // error de sintaxis silencioso. Así no hay barras invertidas que
    // puedan romperse.
    fetch("/crm").then(function (r) { return r.text(); }).then(function (html) {
      var start = html.indexOf("<main>");
      var end = html.lastIndexOf("</main>");
      var main = document.querySelector("main");
      if (start !== -1 && end !== -1 && main) {
        main.innerHTML = html.slice(start + 6, end);
      }
    }).catch(function () {});
  }
  function check() {
    fetch("/crm/alertas-activas.json").then(function (r) { return r.json(); }).then(function (d) {
      var prev = seen();
      var ids = d.ids || [];
      var fresh = ids.filter(function (id) { return prev.indexOf(id) === -1; });
      saveSeen(ids);
      if (fresh.length > 0 && (location.pathname === "/crm" || location.pathname === "/crm/")) softRefreshHoy();
    }).catch(function () {});
  }
  check();
  setInterval(check, 15000);
})();
</script>
</body></html>`;
}

// Campo de contraseña con un botón para ver u ocultar el texto.
function pwInput(attrs: string, id: string): string {
  return `<div style="position:relative"><input id="${id}" type="password" ${attrs} style="padding-right:72px"><button type="button" onclick="var i=document.getElementById('${id}');var s=i.type==='password';i.type=s?'text':'password';this.textContent=s?'Ocultar':'Ver'" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);width:auto;margin:0;padding:6px 10px;font-size:15px;background:none;color:#dc2626;font-weight:600;cursor:pointer;border:0">Ver</button></div>`;
}

function loginPage(error?: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Entrar · Lucero PRO</title>
<style>*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;display:flex;min-height:100vh;align-items:center;justify-content:center;color:#1a1d23}
.brand{text-align:center;margin-bottom:18px}
.brand .wordmark{font-size:24px;font-weight:800;letter-spacing:-.02em}
.brand .wordmark em{font-style:normal;background:#dc2626;color:#fff;font-size:12px;font-weight:800;padding:2px 8px;border-radius:999px;margin-left:6px;vertical-align:3px}
.brand .sub{display:block;font-size:10.5px;font-weight:600;letter-spacing:.09em;color:#5b6472;margin-top:2px}
.box{background:#fff;border:1px solid #e3e5ea;border-radius:14px;padding:28px;width:min(400px,92vw);box-shadow:0 1px 3px rgba(16,24,40,.06)}
h1{margin:0 0 14px;font-size:19px}
label{font-size:13px;font-weight:700}
input{font:inherit;font-size:15px;padding:10px 12px;width:100%;margin:6px 0 14px;border:1px solid #e3e5ea;border-radius:10px}
button{font:inherit;font-size:15px;font-weight:700;padding:12px;width:100%;border:0;border-radius:10px;background:#dc2626;color:#fff;cursor:pointer}
.err{background:#fdecea;color:#8a1f0c;border:1px solid #b3261e;padding:10px;border-radius:10px;margin-bottom:12px;font-size:14px}</style></head>
<body><div><div class="brand"><span class="wordmark">LUCERO<em>PRO</em></span><span class="sub">AUTOMÓVILES LUCERO</span></div>
<form class="box" method="post" action="/crm/entrar"><h1>Entrar</h1>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<label>Correo</label><input name="email" type="email" required autofocus>
<label>Contraseña</label>${pwInput('name="password" required', 'pw-entrar')}
<button type="submit">Entrar</button></form></div></body></html>`;
}

// ---------- sesión ----------
function cookieValue(req: express.Request, name: string): string | undefined {
  const raw = req.headers.cookie ?? "";
  const found = raw.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : undefined;
}
function setSessionCookie(res: express.Response, token: string, req: express.Request) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `crm_session=${encodeURIComponent(token)}; Path=/crm; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`);
}
function clearSessionCookie(res: express.Response) {
  res.setHeader("Set-Cookie", "crm_session=; Path=/crm; HttpOnly; SameSite=Strict; Max-Age=0");
}

crm.get("/entrar", (_req, res) => {
  res.type("html").send(loginPage());
});

crm.post("/entrar", (req, res) => {
  const email = String(req.body.email ?? "").trim().toLowerCase();
  const password = String(req.body.password ?? "");
  const user = listUsers().find((u) => u.email === email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    res.status(401).type("html").send(loginPage("Correo o contraseña incorrectos."));
    return;
  }
  setSessionCookie(res, createSession(user.id), req);
  res.redirect("/crm");
});

crm.post("/salir", (req, res) => {
  destroySession(cookieValue(req, "crm_session"));
  clearSessionCookie(res);
  res.redirect("/crm/entrar");
});

crm.get("/manifest.json", (_req, res) => {
  res.type("application/manifest+json").send(JSON.stringify({
    name: "Lucero: clientes y reservas",
    short_name: "Lucero",
    start_url: "/crm",
    scope: "/crm",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [{ src: "/crm/icono.svg", sizes: "any", type: "image/svg+xml" }],
  }));
});
crm.get("/icono.svg", (_req, res) => {
  res.type("image/svg+xml").send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#dc2626"/><text x="256" y="350" font-family="Arial,sans-serif" font-size="300" font-weight="700" fill="#ffffff" text-anchor="middle">L</text></svg>');
});

crm.use((req, res, next) => {
  // La propia API de Higgsfield necesita descargar la foto subida desde
  // fuera, sin cookie de sesión del CRM -- por eso esta única ruta queda
  // pública (sirve solo archivos de coches para anuncios, nada sensible).
  if (req.path === "/entrar" || req.path.startsWith("/studio/archivo/")) return next();
  const user = userForSession(cookieValue(req, "crm_session"));
  if (!user) {
    res.redirect("/crm/entrar");
    return;
  }
  (res.locals as { user: CrmUser }).user = user;
  next();
});

function me(res: express.Response): CrmUser {
  return (res.locals as { user: CrmUser }).user;
}
function back(res: express.Response, to: string, msg: string) {
  res.redirect(`${to}${to.includes("?") ? "&" : "?"}msg=${encodeURIComponent(msg)}`);
}
// Mismo criterio que ya usaba Clientes (21/10/2026, "que no me cambie de
// sección") -- Contactos Pro (25/10/2026) lo reutiliza para que una acción
// hecha desde dentro de /crm/contactos vuelva ahí, no a la página suelta
// de siempre. Solo acepta rutas internas reales (/crm/...), nunca una URL
// externa.
function safeVolver(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.startsWith("/crm/") && !raw.startsWith("//") ? raw : fallback;
}
function msgOf(req: express.Request): string | undefined {
  return typeof req.query.msg === "string" ? req.query.msg : undefined;
}

// ---------- tarjetas reutilizables ----------
// Vehículo por el que pregunta, con reserva (vehicle_id siempre real) pero
// visita (vehicle_id opcional -- puede no haberse enlazado al catálogo
// todavía): si falta, se usa el interés guardado en la ficha del cliente
// antes de rendirse, nunca se deja la visita sin ningún coche mostrado.
function appointmentVehicleLabel(a: Appointment, lead: Lead | undefined): string {
  if (a.vehicle_id) return vehicleName(a.vehicle_id);
  if (lead?.vehicle_interest) return lead.vehicle_interest;
  return "Vehículo sin especificar";
}

// Tono real por estado (confirmada/pendiente/cancelada), reutilizado como
// color de la pastilla de fecha y del texto de estado en la fila
// compacta -- mismo criterio de color que ya usaban las tarjetas altas
// (.pending/.done/.off), solo que ahora pinta un elemento pequeño en vez
// de toda la tarjeta.
const ROW_TONE_COLOR: Record<string, [string, string]> = {
  pending: ["#fff4e0", "#8a5a00"],
  done: ["#e3f6e8", "#1f7a42"],
  urgent: ["#fdecea", "#8a1f0c"],
  off: ["#f6f7f9", "#5b6472"],
};
// Tarjeta de estado (26/10/2026, "C1" -- Integraciones/Asistentes:
// "Estado: X" era una frase suelta, fácil de pasar por alto). Reutiliza
// los mismos 4 tonos de ROW_TONE_COLOR -- "done" = conectado/respondiendo,
// "pending" = pausado/modo de prueba (intencional, no roto), "urgent" =
// no conectado/fallo real, "off" = sin configurar. Un icono con la
// inicial + una pastilla con punto de color, antes de la caja de siempre
// con todos los botones/datos reales -- no se quita ni se inventa nada.
function statusBadge(letter: string, tone: string): string {
  const [bg, fg] = ROW_TONE_COLOR[tone] ?? ROW_TONE_COLOR.off;
  return `<div style="width:30px;height:30px;border-radius:9px;background:${bg};color:${fg};display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;flex-shrink:0">${esc(letter)}</div>`;
}
function statusPill(label: string, tone: string): string {
  const [, fg] = ROW_TONE_COLOR[tone] ?? ROW_TONE_COLOR.off;
  return `<span style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;color:${fg}"><span style="width:7px;height:7px;border-radius:999px;background:currentColor;display:inline-block"></span>${esc(label)}</span>`;
}
// Estado real de la conversación (26/10/2026, petición real: "que se vea
// cuando carolina este escribiendo... y cuando tenemos nosotros que
// responder") -- tres estados reales, nunca inventados: ya respondido
// (con quién), "escribiendo" SOLO si el agente de ese canal está
// encendido de verdad (isWhatsappZernioAgentEnabled/isEmailAutoSendEnabled)
// y el mensaje es reciente (la IA responde en segundos/pocos minutos, no
// horas -- pasada esa ventana, ya no está "escribiendo", simplemente
// nadie ha contestado todavía), o pendiente de que responda el equipo.
// Sin webhook en vivo no hay forma de saber el instante exacto en que la
// IA empieza a redactar -- esto es una aproximación honesta por tiempo,
// no un "escribiendo..." en tiempo real de verdad.
const AGENT_TYPING_WINDOW_MS = 2 * 60 * 1000;
function agentReplyStatus(createdAt: string, answered: boolean | undefined, answeredBy: "ia" | "equipo" | undefined, agentEnabled: boolean, agentName: string): { kind: "typing" | "pending_team" | "answered"; label: string; tone: string } {
  if (answered) return { kind: "answered", label: answeredBy === "ia" ? `${agentName} ya respondió` : "Ya respondió el equipo", tone: "done" };
  const ageMs = Date.now() - new Date(createdAt).getTime();
  if (agentEnabled && ageMs >= 0 && ageMs < AGENT_TYPING_WINDOW_MS) return { kind: "typing", label: `${agentName} está escribiendo…`, tone: "done" };
  return { kind: "pending_team", label: "Pendiente -- responde el equipo", tone: "pending" };
}
function apptCard(a: Appointment): string {
  const d = dayLabel(a.requested_date);
  const tone = a.status === "requested" ? "pending" : a.status === "confirmed" ? "done" : "off";
  const [badgeBg, badgeFg] = ROW_TONE_COLOR[tone] ?? ROW_TONE_COLOR.off;
  const lead = a.lead_phone ? findLeadByContact(a.lead_phone) : undefined;
  const veh = appointmentVehicleLabel(a, lead);
  const whatsapp = waIconButton(a.lead_phone, `Hola, le escribe Automóviles Lucero. Le esperamos el ${d.weekday} ${d.day} de ${d.month} a las ${a.requested_time ?? ""} para ver el ${veh}. ¿Le viene bien?`);
  const mail = mailIconLink(lead?.email ?? (a.lead_phone?.includes("@") ? a.lead_phone : null));
  const contactPart = a.lead_phone && !a.lead_phone.includes("@") ? a.lead_phone : lead?.email ?? null;
  const actions = [
    a.status === "requested" ? button("Confirmar", "confirmar", "ok") : "",
    a.status === "confirmed" ? button("No se presentó", "no_presentado", "light") : "",
    a.status !== "cancelled" ? confirmButton("Cancelar", "cancelar", "danger", "¿Seguro que quieres cancelar esta visita?") : "",
    // "Devolver" (22/10/2026, petición real: "asi como hayan botones de
    // cancelar... que hayan botones de devolver") -- reactiva una visita
    // cancelada por error, vuelve a pendiente de confirmar (no se asume
    // directamente "confirmed": el equipo la confirma con el botón de al
    // lado si de verdad quiere auto-confirmarla).
    a.status === "cancelled" ? button("Devolver", "devolver", "ok") : "",
    // A petición real (16/10/2026, "en esta sección quiero que añadas la
    // papelera, para borrar consultas antiguas"): disponible siempre, no
    // solo cuando está cancelada -- una consulta vieja pendiente de
    // confirmar también hay que poder limpiarla sin cancelarla antes.
    confirmButton("🗑️", "eliminar", "light", "¿Eliminar esta visita para siempre? Se puede restaurar luego desde la Papelera."),
  ].join("");
  const flags = [
    !lead?.name ? `<span class="tag" style="background:#fde2e1;color:#7a1c17">Sin nombre</span>` : "",
    !a.lead_phone ? `<span class="tag" style="background:#fde2e1;color:#7a1c17">Sin teléfono</span>` : "",
    a.notes ? `<span class="tag">${esc(a.notes)}</span>` : "",
  ].filter(Boolean).join(" ");
  // Fila compacta (26/10/2026, "A2" -- misma fila que Clientes): el
  // <form> envuelve acciones/avisos/campos editables con display:contents
  // para que sus hijos sigan fluyendo como celdas sueltas de .record-row
  // (flex-wrap), sin romper que TODOS los botones -- confirmar, cancelar,
  // devolver, eliminar, cambiar día/hora -- sigan siendo un solo envío
  // real al mismo sitio de siempre (/crm/citas/:id), solo distinguidos
  // por accion=, exactamente igual que en la tarjeta alta anterior.
  return `<div class="record-row" id="c-${esc(a.id)}">
${simpleCheckbox("citas-bulk", a.id)}
<div class="datebadge" style="background:${badgeBg};color:${badgeFg}"><span>${esc(d.weekday.slice(0, 3))}</span><b>${esc(d.day)}</b><span>${esc(a.requested_time ?? "")}</span></div>
<div class="who"><b>${lead?.name ? esc(lead.name) : `<span style="color:#b3261e">Sin nombre</span>`}</b><span>${esc(veh)}${contactPart ? ` · ${esc(contactPart)}` : ""}</span></div>
<div class="meta"><span style="font-size:12.5px;font-weight:700;color:${badgeFg}">${esc(APPOINTMENT_TEXT[a.status] ?? a.status)}</span><span class="lastcontact">${esc(ORIGIN[a.channel ?? ""] ?? "Origen desconocido")}</span></div>
<form method="post" action="/crm/citas/${esc(a.id)}" style="display:contents">
<div class="acts">${phoneIconLink(a.lead_phone)}${whatsapp}${mail}${actions}</div>
<div class="flags"><span class="tag">Preguntó el ${esc(fmtDate(a.created_at))}${lead?.updated_at && lead.updated_at !== a.created_at ? ` · Último contacto ${esc(fmtDate(lead.updated_at))}` : ""}</span>${flags}</div>
<div class="edits"><div><label>Otro día</label><input type="date" name="fecha" value="${esc(a.requested_date ?? "")}"></div>
<div><label>Otra hora</label><input type="time" name="hora" value="${esc(a.requested_time ?? "")}"></div>
<button class="btn light" type="submit" name="accion" value="cambiar">Cambiar</button></div>
</form>
</div>`;
}

function reservationCard(r: Reservation, user: CrmUser): string {
  const sold = getOfficialStatus(r.vehicle_id) === "SOLD";
  const tone = sold ? "off" : r.status === "pending_verification" ? "urgent" : r.status === "pending_payment" ? "pending" : r.status === "confirmed" ? "done" : "off";
  const [badgeBg, badgeFg] = ROW_TONE_COLOR[tone] ?? ROW_TONE_COLOR.off;
  const veh = vehicleName(r.vehicle_id);
  const lead = r.lead_phone ? findLeadByContact(r.lead_phone) : undefined;
  const mail = mailIconLink(lead?.email ?? (r.lead_phone?.includes("@") ? r.lead_phone : null));
  const actions: string[] = [];
  if (r.status === "pending_payment") actions.push(button("Ha pagado", "pagado", "warn"));
  if (r.status === "pending_verification") {
    if (canConfirmPayments(user)) actions.push(confirmButton("Confirmar", "confirmar", "ok", "¿Has comprobado el justificante de los 500 €?"));
    else actions.push(`<span class="tag">El pago lo confirma el comercial</span>`);
  }
  if (r.status === "confirmed" && !sold && canConfirmPayments(user)) actions.push(confirmButton("Vendido y entregado", "vendido", "ok", "¿Seguro que el coche ya está vendido y entregado?"));
  if (sold) actions.unshift(`<span class="tag" style="background:#e5e7eb">Vendido y entregado</span>`);
  if (r.status === "pending_payment" || r.status === "pending_verification") actions.push(confirmButton("Cancelar", "cancelar", "danger", "¿Seguro que quieres cancelar esta reserva?"));
  // "Devolver" (22/10/2026, petición real: "asi como hayan botones de
  // cancelar... que hayan botones de devolver") -- reactiva una reserva
  // cancelada por error, con 15 días de plazo nuevos (nunca el plazo ya
  // vencido). No se ofrece si el coche ya se vendió de verdad mientras
  // tanto (reopenReservation también lo bloquea del lado del servidor).
  if (r.status === "cancelled" && !sold) actions.push(confirmButton("Devolver", "devolver", "ok", "¿Volver a activar esta reserva? Empieza de nuevo con 15 días de plazo."));
  // Papelera real (13/10/2026): solo para reservas ya cerradas (canceladas o
  // caducadas) y solo el administrador -- una reserva viva nunca se borra
  // sin pasar antes por cancelar/confirmar, para no perder el rastro de un
  // pago real a medio gestionar.
  if ((r.status === "cancelled" || r.status === "expired") && user.role === "admin") {
    actions.push(confirmButton("Eliminar", "eliminar", "danger", `"${veh}" se borra para siempre del registro, no se puede deshacer.`));
  }
  const whatsapp = r.status === "pending_payment"
    ? waIconButton(r.lead_phone, `Hola, le escribe Automóviles Lucero. Para apartar el ${veh} necesitamos 500 €. Cuando haga el pago, envíenos el justificante por aquí. Gracias.`)
    : "";
  const canBulkDelete = (r.status === "cancelled" || r.status === "expired") && user.role === "admin";
  // Caducidad visible (22/10/2026): solo importa mientras la reserva sigue
  // viva (pagada/por verificar) -- una vez confirmada, cancelada o
  // caducada, el plazo ya no significa nada. Aviso en rojo si quedan 3
  // días o menos, para que el equipo no se entere tarde.
  const daysLeft = r.expires_at ? Math.ceil((new Date(r.expires_at).getTime() - Date.now()) / 86400000) : null;
  const expiring = daysLeft !== null && (r.status === "pending_payment" || r.status === "pending_verification");
  const contactPart = r.lead_phone && !r.lead_phone.includes("@") ? r.lead_phone : lead?.email ?? null;
  const flags = [
    !lead?.name ? `<span class="tag" style="background:#fde2e1;color:#7a1c17">Sin nombre</span>` : "",
    !r.lead_phone ? `<span class="tag" style="background:#fde2e1;color:#7a1c17">Sin teléfono</span>` : "",
    r.verified_by ? `<span class="tag">Confirmada por ${esc(r.verified_by)}</span>` : "",
    expiring ? `<span class="tag" style="${daysLeft! <= 3 ? "background:#fdecea;color:#8a1f0c" : ""}">⏰ Caduca el ${esc(fmtDate(r.expires_at!))} (quedan ${daysLeft} día${daysLeft === 1 ? "" : "s"})</span>` : "",
  ].filter(Boolean).join(" ");
  return `<div class="record-row" id="r-${esc(r.id)}">
${canBulkDelete ? simpleCheckbox("reservas-bulk", r.id) : ""}
<div class="datebadge" style="background:${badgeBg};color:${badgeFg}"><span>Reserva</span><b>${r.amount_eur}€</b></div>
<div class="who"><b>${lead?.name ? esc(lead.name) : `<span style="color:#b3261e">Sin nombre</span>`}</b><span>${esc(veh)}${contactPart ? ` · ${esc(contactPart)}` : ""}</span></div>
<div class="meta"><span style="font-size:12.5px;font-weight:700;color:${badgeFg}">${esc(sold ? "Vendido" : RESERVATION_TEXT[r.status] ?? r.status)}</span><span class="lastcontact">${esc(ORIGIN[r.channel ?? ""] ?? "Origen desconocido")}</span></div>
<form method="post" action="/crm/reservas/${esc(r.id)}" style="display:contents">
<div class="acts">${phoneIconLink(r.lead_phone)}${whatsapp}${mail}${actions.join("")}</div>
<div class="flags"><span class="tag">Preguntó el ${esc(fmtDate(r.created_at))}${lead?.updated_at && lead.updated_at !== r.created_at ? ` · Último contacto ${esc(fmtDate(lead.updated_at))}` : ""}</span>${flags}</div>
<div class="edits"><div><label>Teléfono del cliente</label><input name="telefono" value="${esc(r.lead_phone ?? "")}"></div>
<div><label>Importe (€)</label><input type="number" name="importe" value="${r.amount_eur}" min="0"></div>
<button class="btn light" type="submit" name="accion" value="editar">Guardar</button></div>
</form>
</div>`;
}

// Visitas y reservas del canal (22/10/2026, a petición real: "las
// reservas o visitas de llamada se meten en llamadas, los de whatsapp en
// whatsapp y los de gmail en gmail") -- cada página de canal (Llamadas,
// WhatsApp, Correos) muestra también lo que ese mismo canal generó de
// verdad, reutilizando apptCard/reservationCard tal cual, nunca una
// vista paralela. Solo lo activo (citas no canceladas, reservas no
// cerradas) -- lo histórico sigue en Visitas/Reservas.
function channelActivitySection(channel: "VOICE" | "WHATSAPP" | "EMAIL", user: CrmUser): string {
  const appts = list<Appointment>("appointments").filter((a) => a.channel === channel && a.status !== "cancelled");
  const resv = list<Reservation>("reservations").filter((r) => r.channel === channel && r.status !== "cancelled" && r.status !== "expired");
  if (appts.length === 0 && resv.length === 0) return "";
  return `<div class="box"><h3 style="margin-top:0">Visitas y reservas de este canal</h3>
<div class="records-list">
${resv.length > 0 ? resv.map((r) => reservationCard(r, user)).join("") : ""}
${appts.length > 0 ? appts.map(apptCard).join("") : ""}
</div>
</div>`;
}
// Mensaje del botón "Escribir por WhatsApp" con contexto real (22/10/2026,
// petición real de Ramón: "que también salga el coche por el que está
// interesado, y hora y fecha") -- antes era un saludo genérico sin ningún
// dato, igual para todos los clientes. Ahora, si el lead tiene coche de
// interés guardado y/o una cita real (no cancelada, con día y hora) se
// añaden -- nunca se inventa ninguno de los dos si no existen de verdad.
function whatsappGreetingFor(l: Lead, appts: Appointment[]): string {
  const greeting = l.name ? `Hola ${l.name}` : "Hola";
  const vehiclePart = l.vehicle_interest ? ` sobre ${l.vehicle_interest}` : "";
  const myAppt = l.phone ? appts.find((a) => a.lead_phone === l.phone && a.status !== "cancelled" && a.requested_date && a.requested_time) : undefined;
  let visitPart = "";
  if (myAppt) {
    const d = dayLabel(myAppt.requested_date);
    visitPart = ` Le esperamos el ${d.weekday} ${d.day} de ${d.month} a las ${myAppt.requested_time}.`;
  }
  return `${greeting}, le escribe Automóviles Lucero${vehiclePart}.${visitPart} ¿En qué le podemos ayudar?`;
}
// Fila compacta (26/10/2026, "mandame ideas de tarjetas y diseño... vamos
// a probar esta" -- opción B de 3 ideas, elegida por Eliud tras ver un
// mockup real con datos de ejemplo). Mismos datos y mismas acciones de
// siempre (nada nuevo, nada quitado) -- solo una fila de una línea en vez
// de una tarjeta alta, para ver muchos clientes de un vistazo. El color
// del avatar pasa a ser el de la temperatura (antes era un color fijo por
// persona, pensado para distinguir personas en una conversación -- aquí
// interesa más distinguir de un vistazo quién está caliente).
function leadCard(l: Lead, user: CrmUser, phase: LeadPhase, duplicate: Lead | null, appts: Appointment[], volver?: string): string {
  const t = TEMP[l.temperature] ?? TEMP.COLD;
  const [avatarBg, avatarFg] = TEMP_AVATAR[l.temperature] ?? TEMP_AVATAR.COLD;
  const displayName = leadDisplayName(l);
  const whatsapp = waIconButton(l.phone, whatsappGreetingFor(l, appts));
  const mail = mailIconLink(l.email ?? null);
  // A petición real (21/10/2026, "cada vez que borre un lead que no me
  // cambie de sección"): se lleva la lista filtrada actual (t/d, o la
  // búsqueda) para volver exactamente ahí, no a la lista sin filtrar.
  const volverField = volver ? `<input type="hidden" name="volver" value="${esc(volver)}">` : "";
  const del = user.role === "admin"
    ? `<form method="post" action="/crm/clientes/${esc(l.id)}" style="display:inline">${volverField}${confirmButton("Eliminar", "eliminar", "danger", `¿Eliminar a "${l.name || l.phone || "este cliente"}"? Se puede restaurar luego desde la Papelera.`)}</form>`
    : "";
  const archiveBtn = `<form method="post" action="/crm/clientes/${esc(l.id)}" style="display:inline">${volverField}<button class="btn light" type="submit" name="accion" value="${l.archived ? "desarchivar" : "archivar"}">${l.archived ? "Desarchivar" : "Archivar"}</button></form>`;
  const sel = user.role === "admin" ? `<input class="msgsel" type="checkbox" name="ids" value="${esc(l.id)}" form="clientes-bulk">` : "";
  // Origen (primera captación) y canal (último contacto) son dos conceptos
  // distintos que ya se guardan por separado (20/10/2026, sección 7) --
  // antes solo se mostraba uno. Se muestran los dos, y solo el canal si
  // coinciden, para no repetir la misma etiqueta dos veces sin motivo.
  const originLabel = ORIGIN[l.origin ?? ""] ?? (l.origin ? l.origin : null);
  const channelLabel = ORIGIN[l.channel ?? ""] ?? (l.channel ? l.channel : null);
  const channelTags = originLabel && channelLabel && originLabel !== channelLabel
    ? `<span class="origen">Captado: ${esc(originLabel)}</span> <span class="origen">Último contacto: ${esc(channelLabel)}</span>`
    : `<span class="origen">${esc(originLabel ?? channelLabel ?? "Origen sin registrar")}</span>`;
  const duplicateWarning = duplicate
    ? `<a class="tag" href="/crm/clientes/${esc(duplicate.id)}" style="background:#fde2e1;color:#7a1c17;text-decoration:none">⚠️ Posible duplicado: mismo teléfono que ${esc(leadDisplayName(duplicate))}</a>`
    : "";
  // Segunda línea de avisos (duplicado/sin nombre/no contactar/archivado +
  // fase + origen): solo aparece cuando hay algo real que avisar, para que
  // la fila normal se quede en una sola línea.
  const flags = [
    !l.name ? `<span class="tag" style="background:#fde2e1;color:#7a1c17">Sin nombre</span>` : "",
    l.do_not_contact ? `<span class="tag">No volver a escribir</span>` : "",
    l.archived ? `<span class="tag">Archivado</span>` : "",
    duplicateWarning,
    `<span class="tag">${esc(LEAD_PHASE_LABEL[phase])}</span>`,
    channelTags,
  ].filter(Boolean).join(" ");
  return `<div class="record-row">
${sel}
<div class="avatar" style="background:${avatarBg};color:${avatarFg}">${esc(avatarInitials(displayName))}</div>
<div class="who"><b>${esc(displayName)}</b><span>${esc(l.phone || l.email || "")}</span></div>
<div class="situation" title="${esc(situation(l))}">${esc(situation(l))}</div>
<div class="meta">
<span class="temp" style="color:${t.cls === "t-hot" ? "var(--accent)" : t.cls === "t-warm" ? "#f97316" : "#2563eb"}"><i style="background:currentColor"></i>${esc(t.help.charAt(0).toUpperCase() + t.help.slice(1))}</span>
<span class="lastcontact">${esc(fmtDate(l.updated_at ?? l.created_at))}</span>
</div>
<div class="acts">
<a class="btn light" href="/crm/clientes/${esc(l.id)}">Ficha</a>
${phoneIconLink(l.phone)}${whatsapp}${mail}${archiveBtn}${del}
</div>
${flags ? `<div class="flags">${flags}</div>` : ""}
</div>`;
}

// ---------- Hoy ----------
// Fase A (21/10/2026, a petición real: "esto más organizado, así se ve
// feo"): antes era una sola frase larga, con el correo-relay de
// Coches.net en crudo y "sin contacto" repetido -- ahora una lista real,
// una visita por línea, reutilizando contactLabel (mismo que ya limpia
// esto en Reservas/Pendientes) en vez del teléfono/correo sin tratar.
function todaySummary(today: string): string {
  const list2 = list<Appointment>("appointments").filter((a) => a.status !== "cancelled" && a.requested_date === today).sort((x, y) => (x.requested_time ?? "").localeCompare(y.requested_time ?? ""));
  if (list2.length === 0) return `<p style="margin:0;font-size:22px"><b>Hoy no tienes visitas.</b></p>`;
  const leads = list<Lead>("leads");
  const rows = list2.map((a) => {
    const lead = a.lead_phone ? leads.find((l) => l.phone === a.lead_phone) : null;
    return `<li><b>${esc(a.requested_time ?? "?")}</b> -- ${esc(vehicleName(a.vehicle_id))} -- ${esc(contactLabel(a.lead_phone, lead?.name))}</li>`;
  });
  return `<p style="margin:0 0 8px;font-size:22px"><b>Hoy tienes ${list2.length} ${list2.length === 1 ? "visita" : "visitas"}</b></p>
<ul style="margin:0;padding-left:22px;font-size:20px;line-height:1.7">${rows.join("")}</ul>`;
}

crm.get("/", (req, res) => {
  const today = todayMadrid();
  const appts = list<Appointment>("appointments").filter((a) => a.status !== "cancelled");
  const reservations = list<Reservation>("reservations");
  const handoffs = list<Handoff>("handoffs").filter((h) => h.status === "requested");
  const mails = list<InboxMail>("email_inbox").filter((m) => m.outcome !== "automated_no_reply" && !m.answered);
  // Petición real (23/10/2026, "todos los leads nuevos de hoy"): clientes que
  // escribieron hoy por primera vez, aunque todavía no tengan cita ni
  // reserva -- antes Hoy solo mostraba lo que ya tenía una acción concreta
  // agendada. Mismo criterio de "hoy" que el resto del CRM (madridDateOnly),
  // y nunca archivados/publicidad (ya tienen su propia vista).
  const allLeads = list<Lead>("leads");
  const financingToday = readCollection<{ lead_phone?: string; status: string }>("financing_requests");
  const newLeadsToday = allLeads
    .filter((l) => !l.archived && !l.marketing_list && l.created_at && madridDateOnly(l.created_at) === today)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  const todayAppts = appts.filter((a) => a.requested_date === today).sort((x, y) => (x.requested_time ?? "").localeCompare(y.requested_time ?? ""));
  const upcoming = appts.filter((a) => (a.requested_date ?? "") > today).sort((x, y) => (x.requested_date ?? "").localeCompare(y.requested_date ?? "")).slice(0, 6);
  const toAttend = reservations.filter((r) => r.status === "pending_payment" || r.status === "pending_verification");
  // Indicadores nuevos del rediseño visual (25/10/2026): solo con datos ya
  // reales, nada inventado. "Activa" usa el mismo criterio que ya existe
  // en el resto del CRM para una reserva viva (:416/:1132). "Sin
  // responsable" usa el campo real `assigned_to` (añadido 20/10/2026).
  const activeReservations = reservations.filter((r) => r.status !== "cancelled" && r.status !== "expired");
  const leadsSinResponsable = allLeads.filter((l) => !l.archived && !l.marketing_list && !l.do_not_contact && !l.assigned_to);
  // Fase A punto 2/7 (21/10/2026): las tareas urgentes/vencidas nunca
  // aparecían en Hoy, el único sitio pensado para "qué hago ahora mismo" --
  // aunque ya se veían en /crm/seguimiento. Mismo patrón {href,text}.
  const urgentTasks = listTasks().filter((t) => t.status === "pendiente" && (t.priority === "alta" || (t.due_at && t.due_at < new Date().toISOString())));
  // Petición real (23/10/2026, "separa las visitas de hoy y las reservas...
  // pero con las visitas y reservas por confirmar"): antes todo iba junto en
  // una sola lista -- confirmar una reserva se perdía entre avisos de
  // incidencias, correos y tareas. Ahora "por confirmar" (lo que de verdad
  // hay que decidir hoy) vive separado del resto.
  const todoConfirmar: { href: string; text: string }[] = [
    ...toAttend.filter((r) => r.status === "pending_verification").map((r) => ({ href: "/crm/reservas", text: `Confirmar la reserva de ${vehicleName(r.vehicle_id)}` })),
    ...todayAppts.filter((a) => a.status === "requested").map((a) => ({ href: "/crm/citas", text: `Confirmar la visita de hoy a las ${a.requested_time ?? "?"}` })),
  ];
  const todoOtros: { href: string; text: string }[] = [
    // FALLO REAL detectado (22/10/2026, "al darle a enviar mensaje de
    // whatsapp, no envia nada"): cuando el motivo traía un enlace wa.me
    // incrustado como texto plano, toda la fila quedaba envuelta en un único
    // <a> hacia /crm/incidencias -- el "enlace" de WhatsApp que se veía no
    // era clicable de verdad, solo texto dentro de otro enlace. Ahora, si hay
    // wa.me real, el href va directo a WhatsApp (con el motivo real como
    // mensaje) y se abre en pestaña nueva; si no, sigue yendo a su sección.
    ...handoffs.map((h) => {
      const reasonRaw = h.reason ?? "un cliente necesita una persona";
      const waLink = extractWaLink(reasonRaw);
      const text = waLink ? reasonRaw.replace(waLink, "").replace(/\s*[:.]\s*$/, "").trim() : reasonRaw;
      const href = waLink ? `${waLink}?text=${encodeURIComponent(waMessageFor(h.lead_phone, h.lead_name))}` : h.reason_type === "reserva" ? "/crm/reservas" : "/crm/incidencias";
      return { href, text: `Atender: ${text}` };
    }),
    ...mails.map((m) => ({ href: "/crm/correos", text: `Contestar a ${m.from}` })),
    ...urgentTasks.map((t) => ({ href: "/crm/seguimiento", text: `Tarea: ${t.reason ?? TASK_TYPE_LABEL[t.type]}` })),
  ];
  const d = dayLabel(today);
  const alerts = pendingAlerts();
  const emailLabels: Record<string, string> = {
    enviado: "sí",
    pendiente: "en curso",
    sin_correo_conectado: "no, falta conectar Google",
    sin_destinatarios: "no hay destinatarios",
    error: "error al enviar",
  };
  const alertBlock = alerts.length
    ? `<div class="msg" style="background:#fdecea;border-color:#c62828"><b>Llamar ya (${alerts.length})</b> -- las tarjetas de abajo, con el motivo y el botón para llamar o escribir a cada una.</div>` +
      (me(res).role === "admin" ? simpleBulkBar("alertas-bulk", "/crm/alertas-masivo", alerts.length, "¿Eliminar las alertas seleccionadas? Úsalo solo para pruebas; se pueden recuperar luego desde la Papelera.") : "") +
      alerts
        .map(
          (a) => {
            // La razón a veces trae un enlace wa.me incrustado como texto
            // plano (encargo real, 18/10/2026: "esto se ve feo porque sale
            // asi") -- se extrae y se muestra como botón real de WhatsApp,
            // en vez de una URL suelta dentro del párrafo.
            const waLink = extractWaLink(a.reason);
            const afterWaStrip = waLink ? a.reason.replace(waLink, "").replace(/\s*[:.]\s*$/, "").trim() : a.reason;
            const { portal, rest: reasonClean } = extractLeadingPortal(afterWaStrip);
            return `<div class="card" style="position:relative"><div class="info">
${me(res).role === "admin" ? simpleCheckbox("alertas-bulk", a.id) : ""}
<h3>${esc(contactLabel(a.lead_phone, a.name))}</h3>
<p><span class="tletra t-hot">${a.kind === "lead_caliente" ? "C" : a.kind === "reserva_pendiente" ? "R" : "!"}</span><span class="tag t-hot">${a.kind === "lead_caliente" ? "Caliente" : a.kind === "reserva_pendiente" ? "RESERVA 500€" : "Urgente"}</span> ${portal ? platformTag(portal) : ""} ${esc(fmtDate(a.created_at))}</p>
<p>${esc(reasonClean)}</p>
<p>Aviso por correo: ${esc(emailLabels[a.email_status] ?? a.email_status)}</p>
${phoneLink(a.lead_phone)}${waLink ? waButton(waLink.replace("https://wa.me/", ""), waMessageFor(a.lead_phone, a.name)) : ""}
<form method="post" action="/crm/alertas/${esc(a.id)}" style="display:inline"><button class="btn ok" type="submit">Ya le he llamado</button></form>
${me(res).role === "admin" ? `<form method="post" action="/crm/alertas/${esc(a.id)}" style="display:inline"><button class="btn danger" type="submit" name="accion" value="eliminar" onclick="return confirm('¿Eliminar esta alerta para siempre? Úsalo solo para pruebas.')">Eliminar</button></form>` : ""}
</div></div>`;
          },
        )
        .join("")
    : "";
  const todoLinks = (items: { href: string; text: string }[]) =>
    items.slice(0, 8).map((t) => `<a href="${esc(t.href)}"${t.href.startsWith("https://wa.me/") ? ' target="_blank" rel="noopener"' : ""}>→ ${esc(t.text)}</a>`).join("");
  const todoBlock = `${todoConfirmar.length ? `<div class="todo"><h2 style="margin-top:0">Visitas y reservas por confirmar</h2>${todoLinks(todoConfirmar)}</div>` : ""}
${todoOtros.length ? `<div class="todo"><h2 style="margin-top:0">Lo que tienes que hacer</h2>${todoLinks(todoOtros)}</div>` : ""}
${todoConfirmar.length === 0 && todoOtros.length === 0 ? `<div class="allok">Todo hecho. No hay nada pendiente.</div>` : ""}`;
  const body = `<h1>Hoy</h1><p class="sub">${esc(d.weekday)} ${esc(d.day)} de ${esc(d.month)}</p>
<form class="search noprint" method="get" action="/crm/buscar"><input name="q" placeholder="Buscar: nombre, teléfono o coche" required><button class="btn" type="submit">Buscar</button></form>
<div class="box">${todaySummary(today)}</div>
<div class="stats">
<a class="stat" href="/crm/citas"><b>${todayAppts.length}</b><span>visitas hoy</span></a>
<a class="stat" href="/crm/reservas"><b>${toAttend.length}</b><span>reservas por atender</span></a>
<a class="stat" href="/crm/incidencias"><b>${handoffs.filter((h) => h.reason_type !== "reserva").length}</b><span>incidencias</span></a>
<a class="stat" href="/crm/correos"><b>${mails.length}</b><span>correos por contestar</span></a>
<a class="stat" href="/crm/reservas"><b>${activeReservations.length}</b><span>reservas activas</span></a>
<a class="stat" href="/crm/clientes"><b>${leadsSinResponsable.length}</b><span>leads sin responsable</span></a>
</div>
<div class="home-cols">
<div class="home-main">
${alertBlock}
${todoBlock}
${me(res).role === "admin" && todayAppts.length + upcoming.length > 0 ? simpleBulkBar("citas-bulk", "/crm/citas-masivo", todayAppts.length + upcoming.length, "¿Eliminar las visitas seleccionadas? Se pueden recuperar luego desde la Papelera.") : ""}
<h2>Visitas de hoy</h2>${todayAppts.length === 0 ? `<div class="empty">Hoy no hay visitas.</div>` : `<div class="records-list">${todayAppts.map(apptCard).join("")}</div>`}
<h2>Reservas que hay que atender</h2>${toAttend.length === 0 ? `<div class="empty">No hay reservas esperando.</div>` : `<div class="records-list">${toAttend.map((r) => reservationCard(r, me(res))).join("")}</div>`}
</div>
<div class="home-side">
<h2>Clientes nuevos de hoy (${newLeadsToday.length})</h2>${newLeadsToday.length === 0 ? `<div class="empty">Hoy todavía no ha escrito ningún cliente nuevo.</div>` : `<div class="records-list">${newLeadsToday.map((l) => leadCard(l, me(res), leadPhase(l, appts, reservations, today, financingToday), findPossibleDuplicate(l, allLeads), appts, "/crm")).join("")}</div>`}
<h2>Próximas visitas</h2>${upcoming.length === 0 ? `<div class="empty">No hay visitas próximas.</div>` : `<div class="records-list">${upcoming.map(apptCard).join("")}</div>`}
</div>
</div>`;
  res.type("html").send(page("Inicio", me(res), body, msgOf(req)));
});

// ---------- Buscar ----------
crm.get("/buscar", (req, res) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  const match = (...values: (string | null | undefined)[]) => values.some((v) => v && v.toLowerCase().includes(q));
  const allLeads = list<Lead>("leads");
  const allAppts = list<Appointment>("appointments");
  const allResv = list<Reservation>("reservations");
  const allFinancing = readCollection<{ lead_phone?: string; status: string }>("financing_requests");
  const today = todayMadrid();
  const leads = q ? allLeads.filter((l) => match(l.name, l.phone, l.vehicle_interest) || (digits.length >= 4 && (l.phone ?? "").replace(/\D/g, "").includes(digits))) : [];
  const appts = q ? allAppts.filter((a) => match(a.lead_phone, vehicleName(a.vehicle_id))) : [];
  const resv = q ? allResv.filter((r) => match(r.lead_phone, vehicleName(r.vehicle_id))) : [];
  const cars = q ? currentVehicles().filter((v) => match(vehicleName(v.id))) : [];
  const found = leads.length + appts.length + resv.length + cars.length;
  const body = `<h1>Buscar</h1><p class="sub">${q ? `Resultados para "${esc(q)}": ${found}` : "Escribe algo arriba."}</p>
${leads.length > 0 ? `<div class="records-list">${leads.map((l) => leadCard(l, me(res), leadPhase(l, allAppts, allResv, today, allFinancing), findPossibleDuplicate(l, allLeads), allAppts, `/crm/buscar?q=${encodeURIComponent(q)}`)).join("")}</div>` : ""}
${appts.length > 0 || resv.length > 0 ? `<div class="records-list">${appts.map(apptCard).join("")}${resv.map((r) => reservationCard(r, me(res))).join("")}</div>` : ""}
<div class="cards-grid">
${cars.map((v) => `<div class="card"><div class="info"><h3>${esc(vehicleName(v.id))}</h3><p>${esc(priceOf(v.id).toLocaleString("es-ES"))} €</p><a class="btn" href="/crm/coches/${esc(v.id)}">Ver coche</a></div></div>`).join("")}
</div>
${q && found === 0 ? `<div class="empty">No encuentro nada con eso.</div>` : ""}`;
  res.type("html").send(page("Hoy", me(res), body));
});

// ---------- Semana para imprimir ----------
crm.get("/semana", (req, res) => {
  const start = new Date(`${todayMadrid()}T12:00:00`);
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d.toLocaleDateString("sv-SE"));
  }
  const appts = list<Appointment>("appointments").filter((a) => a.status !== "cancelled" && days.includes(a.requested_date ?? ""))
    .sort((x, y) => `${x.requested_date}${x.requested_time}`.localeCompare(`${y.requested_date}${y.requested_time}`));
  const body = `<div class="noprint" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h1 style="margin:0">Visitas de esta semana</h1><button class="btn ok" onclick="window.print()">Imprimir</button></div>
<p class="sub">Próximos siete días.</p>
${appts.length === 0 ? `<div class="empty">No hay visitas esta semana.</div>` : `<div class="records-list">${appts.map(apptCard).join("")}</div>`}`;
  res.type("html").send(page("Visitas", me(res), body));
});

// ---------- Visitas ----------
crm.get("/citas", (req, res) => {
  const f = typeof req.query.f === "string" ? req.query.f : "todas";
  const c = typeof req.query.c === "string" ? req.query.c : "todos";
  const d = typeof req.query.d === "string" ? req.query.d : "todas";
  const today = todayMadrid();
  let items = list<Appointment>("appointments");
  if (f === "pendientes") items = items.filter((a) => a.status === "requested");
  if (f === "confirmadas") items = items.filter((a) => a.status === "confirmed");
  if (f === "no_presentado") items = items.filter((a) => a.status === "no_presentado");
  if (c !== "todos") items = items.filter((a) => channelBucket(a.channel) === c);
  // Pestañas por día (21/10/2026, Fase A punto 6, "es mucho lio" -- la lista
  // mezclaba hoy con pendientes de días pasados y sin fecha). Por defecto
  // "todas" para no romper ningún enlace ya guardado (incluidos los del
  // propio dashboard de Hoy); un tercer eje independiente de f/c.
  if (d === "hoy") items = items.filter((a) => a.requested_date === today);
  else if (d === "ayer") items = items.filter((a) => a.requested_date === addDaysToDateStr(today, -1));
  else if (d === "sin_fecha") items = items.filter((a) => !a.requested_date);
  else if (d === "otros_dias") items = items.filter((a) => a.requested_date && a.requested_date !== today && a.requested_date !== addDaysToDateStr(today, -1));
  items.sort((x, y) => `${x.requested_date ?? ""}${x.requested_time ?? ""}`.localeCompare(`${y.requested_date ?? ""}${y.requested_time ?? ""}`));
  const pill = (k: string, label: string) => `<a href="/crm/citas?f=${k}&c=${c}&d=${d}" class="tag" style="text-decoration:none;${f === k ? "background:var(--accent);color:#fff" : ""}">${label}</a>`;
  const canalPill = (k: string, label: string) => `<a href="/crm/citas?f=${f}&c=${k}&d=${d}" class="tag" style="text-decoration:none;${c === k ? "background:var(--accent);color:#fff" : ""}">${label}</a>`;
  const diaPill = (k: string, label: string) => `<a href="/crm/citas?f=${f}&c=${c}&d=${k}" class="tag" style="text-decoration:none;${d === k ? "background:var(--accent);color:#fff" : ""}">${label}</a>`;
  const body = `<h1>Visitas</h1>
<p class="sub">Aquí ves los días y las horas en que vendrán los clientes a ver un coche.</p>
<p>${diaPill("todas", "Todos los días")} ${diaPill("hoy", "Hoy")} ${diaPill("ayer", "Ayer")} ${diaPill("otros_dias", "Otros días")} ${diaPill("sin_fecha", "Sin fecha")}</p>
<p>${canalPill("todos", "Todos los canales")} ${canalPill("llamadas", "Llamadas")} ${canalPill("whatsapp", "WhatsApp")} ${canalPill("otros", "Otros canales")}</p>
<p>${pill("todas", "Todas")} ${pill("pendientes", "Por confirmar")} ${pill("confirmadas", "Confirmadas")} ${pill("no_presentado", "No presentado")} <a class="link noprint" href="/crm/semana">Ver la semana para imprimir</a></p>
${items.length > 0 ? simpleBulkBar("citas-bulk", "/crm/citas-masivo", items.length, "¿Eliminar las visitas seleccionadas? Se pueden recuperar luego desde la Papelera.") : ""}
${items.length === 0 ? `<div class="empty">No hay visitas en esta lista.</div>` : `<div class="records-list">${items.map(apptCard).join("")}</div>`}`;
  res.type("html").send(page("Visitas", me(res), body, msgOf(req)));
});

crm.post("/citas/:id", async (req, res) => {
  const accion = String(req.body.accion ?? "");
  const appts = list<Appointment>("appointments");
  const a = appts.find((x) => x.id === req.params.id);
  if (!a) return back(res, "/crm/citas", "No encuentro esa visita");
  if (accion === "eliminar") {
    // A petición real (16/10/2026, "en esta sección quiero que añadas la
    // papelera, para borrar consultas antiguas"): antes solo se podía
    // eliminar una visita ya cancelada -- pero una consulta vieja sin fecha
    // fijada (pendiente de confirmar) también hay que poder limpiarla sin
    // tener que cancelarla primero. Se puede restaurar desde la Papelera
    // igual que cualquier otra cosa, así que quitar esta restricción no
    // pierde nada.
    if (me(res).role !== "admin") return back(res, "/crm/citas", "Solo el administrador puede eliminar visitas");
    moveToTrash("appointments", a, `Visita: ${vehicleName(a.vehicle_id)} (${a.lead_phone ?? "sin contacto"})`, me(res).email);
    save("appointments", appts.filter((x) => x.id !== a.id));
    return back(res, "/crm/citas", "Visita movida a la papelera");
  }
  if (accion === "confirmar") a.status = "confirmed";
  else if (accion === "cancelar") {
    a.status = "cancelled";
    // A petición real (20/10/2026, mejora integral del CRM, sección 11.5):
    // esto se quedaba sin avisar a Ramón/José -- notifyVisitCancelled ya
    // existe y se usa desde el agente, pero cancelar a mano desde el CRM
    // nunca pasaba por ahí. Mismo aviso, mismo sitio, sin duplicar lógica.
    await notifyVisitCancelled({ lead_phone: a.lead_phone, vehicle_id: a.vehicle_id, requested_date: a.requested_date, requested_time: a.requested_time });
  } else if (accion === "devolver") {
    a.status = "requested";
    await notifyVisitScheduled({ lead_phone: a.lead_phone, vehicle_id: a.vehicle_id, requested_date: a.requested_date, requested_time: a.requested_time });
  } else if (accion === "no_presentado") {
    a.status = "no_presentado";
    // Seguimiento comercial (20/10/2026, sección 14, "un cliente no se
    // presente" crea una tarea de recuperación) -- deduplicada por el id
    // real de la visita.
    createAutoTask({
      lead_phone: a.lead_phone,
      type: "recuperar_cliente",
      reason: `No se presentó a la visita de ${vehicleName(a.vehicle_id)} del ${a.requested_date ?? ""} ${a.requested_time ?? ""}.`,
      source_ref: a.id,
      channel: a.channel ?? null,
    });
  } else if (accion === "cambiar") {
    const fecha = String(req.body.fecha ?? "").trim();
    const hora = String(req.body.hora ?? "").trim();
    if (fecha) a.requested_date = fecha;
    if (hora) a.requested_time = hora;
  }
  save("appointments", appts);
  back(
    res,
    "/crm/citas",
    accion === "confirmar"
      ? "Visita confirmada"
      : accion === "cancelar"
        ? "Visita cancelada"
        : accion === "devolver"
          ? "Visita devuelta: vuelve a estar pendiente de confirmar"
          : accion === "no_presentado"
            ? "Marcada como no presentado"
            : "Día y hora cambiados",
  );
});

// Borrado masivo (a petición real, 18/10/2026: "el borrar masivo lo quiero
// en todas las secciones"). Mismas reglas que el borrado individual: solo
// administrador, papelera recuperable.
crm.post("/citas-masivo", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm/citas", "Solo el administrador puede eliminar visitas");
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  if (ids.length === 0) return back(res, "/crm/citas", "No seleccionaste ninguna visita");
  const appts = list<Appointment>("appointments");
  const targets = appts.filter((a) => ids.includes(a.id));
  for (const a of targets) moveToTrash("appointments", a, `Visita: ${vehicleName(a.vehicle_id)} (${a.lead_phone ?? "sin contacto"})`, me(res).email);
  save("appointments", appts.filter((a) => !ids.includes(a.id)));
  back(res, "/crm/citas", targets.length === 0 ? "No había nada que hacer" : `${targets.length} visita(s) movida(s) a la papelera`);
});

// ---------- Reservas ----------
crm.get("/reservas", async (req, res) => {
  const c = typeof req.query.c === "string" ? req.query.c : "todos";
  let reservations = list<Reservation>("reservations").sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (c !== "todos") reservations = reservations.filter((r) => channelBucket(r.channel) === c);
  const available = currentVehicles().filter((v) => getOfficialStatus(v.id) === "AVAILABLE");
  // Solo las cerradas (canceladas/caducadas) se pueden borrar -- mismo
  // criterio que el borrado individual, ninguna reserva viva se cuenta.
  const bulkEligible = me(res).role === "admin" ? reservations.filter((r) => r.status === "cancelled" || r.status === "expired").length : 0;
  // Interesados en reservar, sin confirmar aún (21/10/2026, "si hay
  // reservas de 500€ que se metan en reservas" -- antes vivían mezclados
  // en Pendientes). El backfill automático de reservas (18/10/2026) se
  // mueve aquí también -- Reservas es ahora el único dueño de este dato.
  const interesHandoffs = list<Handoff>("handoffs").filter((h) => h.reason_type === "reserva" && h.status === "requested");
  for (const h of interesHandoffs) {
    if (h.lead_phone) {
      const lead = list<Lead>("leads").find((l) => l.phone === h.lead_phone);
      await tryAutoCreateReservation(h.lead_phone, lead?.vehicle_interest ?? null);
    }
  }
  // Tras el backfill, solo quedan como "interés sin confirmar" los que de
  // verdad no tienen ninguna reserva real todavía (ambiguos o sin match
  // único de vehículo -- la función nunca adivina, ver tools/requests.ts).
  const allReservationsForCheck = list<Reservation>("reservations");
  const interesados = interesHandoffs.filter((h) => !allReservationsForCheck.some((r) => r.lead_phone === h.lead_phone));
  const canalPill = (k: string, label: string) => `<a href="/crm/reservas?c=${k}" class="tag" style="text-decoration:none;${c === k ? "background:var(--accent);color:#fff" : ""}">${label}</a>`;
  const body = `<h1>Reservas</h1>
<p class="sub">Una reserva aparta un coche con 500 €. Cuando el cliente paga, compruébalo y pulsa "Confirmar la reserva".</p>
${interesados.length > 0 ? `<h2>Interesados en reservar, sin confirmar (${interesados.length})</h2>
<p class="sub">Pidieron reservar pero no se pudo identificar un único coche real en el catálogo -- confírmalo a mano con el cliente y crea la reserva abajo.</p>
<div class="cards-grid">
${interesados.map((h) => `<div class="card urgent" style="position:relative"><div class="info">
<h3>${esc(h.reason ?? "Quiere reservar")}</h3>
<p><span class="tag t-hot">RESERVA 500€ -- sin confirmar</span></p>
<p>Cliente: <b>${esc(contactLabel(h.lead_phone, h.lead_name))}</b> · ${esc(fmtDate(h.created_at))}</p>${h.notes ? `<p>${esc(h.notes)}</p>` : ""}
<form method="post" action="/crm/avisos/${esc(h.id)}"><button class="btn ok" type="submit">Ya lo he atendido</button>${phoneLink(h.lead_phone)}${waButton(h.lead_phone, waMessageFor(h.lead_phone, h.lead_name, "¿En qué le podemos ayudar con la reserva?"))}</form>
</div></div>`).join("")}
</div>` : ""}
<div class="box"><h3 style="margin-top:0">Hacer una reserva a mano</h3>
<form method="post" action="/crm/reservas">
<label>Nombre del cliente</label><input name="nombre" placeholder="Si no lo escribes, queda sin nombre en el CRM">
<label>Coche</label><select name="vehicle_id">${available.map((v) => option(v.id, `${vehicleName(v.id)} · ${priceOf(v.id)} €`, "")).join("")}</select>
<label>Teléfono o correo del cliente</label><input name="contacto" required>
<button class="btn ok" type="submit">Crear la reserva</button></form></div>
<p>${canalPill("todos", "Todos los canales")} ${canalPill("llamadas", "Llamadas")} ${canalPill("whatsapp", "WhatsApp")} ${canalPill("otros", "Otros canales")}</p>
${bulkEligible > 0 ? simpleBulkBar("reservas-bulk", "/crm/reservas-masivo", bulkEligible, "¿Eliminar las reservas canceladas/caducadas seleccionadas? Se pueden recuperar luego desde la Papelera.") : ""}
${reservations.length === 0 ? `<div class="empty">No hay reservas en esta lista.</div>` : `<div class="records-list">${reservations.map((r) => reservationCard(r, me(res))).join("")}</div>`}`;
  res.type("html").send(page("Reservas", me(res), body, msgOf(req)));
});

crm.post("/reservas", async (req, res) => {
  const vehicleId = String(req.body.vehicle_id ?? "");
  const contacto = String(req.body.contacto ?? "").trim();
  const nombre = String(req.body.nombre ?? "").trim();
  if (!vehicleId || !contacto) return back(res, "/crm/reservas", "Elige un coche y escribe el contacto del cliente");
  // A petición real (19/10/2026, "pon toda la información para crear una
  // reserva"): si se escribe un nombre, se guarda en Clientes (nuevo o
  // completando uno ya existente que no lo tuviera) -- así la reserva no
  // se queda con un contacto sin nombre en ningún sitio del CRM, igual
  // que ya hace el alta manual de Clientes.
  if (nombre) {
    const leads = list<Lead>("leads");
    const existing = leads.find((l) => l.phone === contacto);
    if (existing) {
      if (!existing.name) {
        existing.name = nombre;
        existing.updated_at = now();
        save("leads", leads);
      }
    } else {
      leads.push({
        id: crypto.randomUUID(),
        phone: contacto,
        name: nombre,
        notes: null,
        channel: "MANUAL",
        origin: "MANUAL",
        vehicle_interest: vehicleId ? vehicleName(vehicleId) : null,
        temperature: "WARM",
        followup_count: 0,
        do_not_contact: false,
        created_at: now(),
      });
      save("leads", leads);
    }
  }
  const result = (await createReservationPending({ vehicle_id: vehicleId, lead_phone: contacto, channel: "MANUAL" })) as unknown as { status: string };
  if (result.status !== "ok") return back(res, "/crm/reservas", "Ese coche no está disponible para reservar");
  back(res, "/crm/reservas", "Reserva creada. Espera el pago de 500 €");
});

crm.post("/reservas/:id", (req, res) => {
  const accion = String(req.body.accion ?? "");
  const reservations = list<Reservation>("reservations");
  const r = reservations.find((x) => x.id === req.params.id);
  if (!r) return back(res, "/crm/reservas", "No encuentro esa reserva");
  if (accion === "pagado") {
    r.status = "pending_verification";
    save("reservations", reservations);
    createAutoTask({
      lead_phone: r.lead_phone,
      type: "verificar_reserva",
      reason: `Justificante recibido para ${vehicleName(r.vehicle_id)} -- comprobar y confirmar o rechazar.`,
      source_ref: r.id,
      channel: r.channel ?? null,
      priority: "alta",
    });
    return back(res, "/crm/reservas", "Anotado: falta comprobar el justificante");
  }
  if ((accion === "confirmar" || accion === "vendido") && !canConfirmPayments(me(res))) {
    return back(res, "/crm/reservas", "Solo el comercial puede confirmar pagos y ventas");
  }
  if (accion === "confirmar") {
    confirmReservation({ reservation_id: r.id, verified_by: me(res).name });
    return back(res, "/crm/reservas", "Reserva confirmada: el coche queda reservado");
  }
  if (accion === "cancelar") {
    cancelReservation({ reservation_id: r.id, reason: "cancelada desde el CRM" });
    return back(res, "/crm/reservas", "Reserva cancelada: el coche vuelve a estar disponible");
  }
  if (accion === "devolver") {
    const result = reopenReservation({ reservation_id: r.id });
    if (result.status !== "ok") {
      return back(res, "/crm/reservas", result.error_code === "vehicle_already_sold" ? "No se puede devolver: el coche ya se vendió" : "No se pudo devolver esta reserva");
    }
    return back(res, "/crm/reservas", "Reserva devuelta: vuelve a estar activa con 15 días de plazo");
  }
  if (accion === "vendido") {
    setOfficialStatus(r.vehicle_id, "SOLD", r.id);
    return res.redirect(`/crm/reservas?msg=${encodeURIComponent("Anotado: coche vendido")}#r-${r.id}`);
  }
  if (accion === "eliminar") {
    if (me(res).role !== "admin") return back(res, "/crm/reservas", "Solo el administrador puede eliminar reservas");
    if (r.status !== "cancelled" && r.status !== "expired") {
      return back(res, "/crm/reservas", "Solo se pueden eliminar reservas ya canceladas o caducadas");
    }
    moveToTrash("reservations", r, `Reserva: ${vehicleName(r.vehicle_id)} (${r.lead_phone ?? "sin contacto"})`, me(res).email);
    save("reservations", reservations.filter((x) => x.id !== r.id));
    return back(res, "/crm/reservas", "Reserva movida a la papelera");
  }
  if (accion === "editar") {
    const telefono = String(req.body.telefono ?? "").trim();
    const importe = Number(req.body.importe);
    if (telefono) r.lead_phone = telefono;
    if (Number.isFinite(importe) && importe >= 0) r.amount_eur = importe;
    save("reservations", reservations);
    return back(res, "/crm/reservas", "Cambios guardados");
  }
  back(res, "/crm/reservas", "No entendí esa acción");
});

// Borrado masivo (18/10/2026, "el borrar masivo lo quiero en todas las
// secciones") -- mismo criterio que el individual: solo canceladas o
// caducadas, nunca una reserva viva, solo administrador.
crm.post("/reservas-masivo", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm/reservas", "Solo el administrador puede eliminar reservas");
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  if (ids.length === 0) return back(res, "/crm/reservas", "No seleccionaste ninguna reserva");
  const reservations = list<Reservation>("reservations");
  const targets = reservations.filter((r) => ids.includes(r.id) && (r.status === "cancelled" || r.status === "expired"));
  for (const r of targets) moveToTrash("reservations", r, `Reserva: ${vehicleName(r.vehicle_id)} (${r.lead_phone ?? "sin contacto"})`, me(res).email);
  const targetIds = new Set(targets.map((t) => t.id));
  save("reservations", reservations.filter((r) => !targetIds.has(r.id)));
  back(res, "/crm/reservas", targets.length === 0 ? "No había nada que hacer (solo se pueden borrar canceladas o caducadas)" : `${targets.length} reserva(s) movida(s) a la papelera`);
});

// ---------- Seguimiento comercial ----------
const TASK_TYPE_LABEL: Record<TaskType, string> = {
  llamar: "Llamar a cliente",
  responder_mensaje: "Responder mensaje",
  responder_correo: "Responder correo",
  confirmar_visita: "Confirmar visita",
  verificar_reserva: "Verificar reserva",
  revisar_financiacion: "Revisar financiación",
  recuperar_cliente: "Recuperar cliente",
  seguimiento_propuesta: "Seguimiento de propuesta",
  resolver_incidencia: "Resolver incidencia",
  revisar_handoff: "Revisar handoff",
  otra: "Otra tarea comercial",
};
function taskCard(t: Task): string {
  const overdue = t.due_at ? t.due_at < new Date().toISOString() : false;
  const tone = t.status === "completada" ? "off" : overdue ? "urgent" : t.priority === "alta" ? "pending" : "";
  return `<div class="card ${tone}" id="task-${esc(t.id)}"><div class="info">
<h3>${esc(TASK_TYPE_LABEL[t.type])}</h3>
<p><span class="tag">${esc(contactLabel(t.lead_phone, null))}</span>${t.channel ? ` <span class="tag">${esc(ORIGIN[t.channel] ?? t.channel)}</span>` : ""}${t.priority === "alta" ? ` <span class="tag" style="background:#fde2e1;color:#7a1c17">Prioridad alta</span>` : ""}${overdue && t.status === "pendiente" ? ` <span class="tag" style="background:#b3261e;color:#fff">Vencida</span>` : ""}${t.status === "completada" ? `<span class="tag">Completada</span>` : ""}</p>
${t.reason ? `<p>${esc(t.reason)}</p>` : ""}
<p class="sub">Creada: ${esc(fmtDate(t.created_at))}${t.due_at ? ` · Vence: ${esc(fmtDate(t.due_at))}` : ""}${t.assigned_to ? ` · Asignada a: ${esc(t.assigned_to)}` : ""}</p>
${t.lead_phone ? `<a class="btn light" href="/crm/buscar?q=${esc(t.lead_phone)}">Ver cliente</a>` : ""}
${t.status === "pendiente" ? `<form method="post" action="/crm/seguimiento/${esc(t.id)}/asignar" style="display:inline"><select name="assigned_to" onchange="this.form.submit()"><option value="">Sin asignar</option>${listUsers().map((u) => `<option value="${esc(u.email)}" ${t.assigned_to === u.email ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></form>` : ""}
${t.status === "pendiente" ? `<form method="post" action="/crm/seguimiento/${esc(t.id)}" style="display:inline">${button("Completar", "completar", "ok")}</form>` : ""}
</div></div>`;
}
crm.get("/seguimiento", (req, res) => {
  const tasks = listTasks();
  const f = typeof req.query.f === "string" ? req.query.f : "pendientes";
  const leads = list<Lead>("leads");
  // Automatización derivada (20/10/2026, sección 14: "un cliente caliente
  // no tenga una próxima acción") -- no se materializa en tasks.json (no
  // nace de un evento puntual, es un estado continuo que se re-evalúa solo
  // cada vez que se mira esta página, igual que el archivado automático).
  const hotWithoutAction = leads.filter((l) => l.temperature === "HOT" && !l.archived && !l.do_not_contact && !l.next_action && !l.sale_outcome);
  let items = tasks;
  if (f === "pendientes") items = items.filter((t) => t.status === "pendiente");
  if (f === "vencidas") items = items.filter((t) => t.status === "pendiente" && t.due_at && t.due_at < new Date().toISOString());
  if (f === "completadas") items = items.filter((t) => t.status === "completada");
  items = items.sort((a, b) => (b.priority === "alta" ? 1 : 0) - (a.priority === "alta" ? 1 : 0) || (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"));
  const pill = (k: string, label: string) => `<a href="/crm/seguimiento?f=${k}" class="tag" style="text-decoration:none;${f === k ? "background:var(--accent);color:#fff" : ""}">${label}</a>`;
  const body = `<h1>Tareas</h1>
<p class="sub">Tareas comerciales de todos los canales -- algunas se crean solas (visita por confirmar, justificante por verificar, cliente que no se presentó, handoff urgente), otras se añaden a mano.</p>
${hotWithoutAction.length > 0 ? `<div class="msg" style="background:#fdecea;border-color:#c62828">🔥 ${hotWithoutAction.length} cliente(s) caliente(s) sin próxima acción definida: ${hotWithoutAction.map((l) => `<a class="link" href="/crm/clientes?q=${esc(l.phone ?? "")}">${esc(leadDisplayName(l))}</a>`).join(", ")}</div>` : ""}
<div class="box"><h3 style="margin-top:0">Añadir una tarea</h3>
<form method="post" action="/crm/seguimiento">
<label>Tipo</label><select name="type">${Object.entries(TASK_TYPE_LABEL).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("")}</select>
<label>Teléfono o correo del cliente (opcional)</label><input name="lead_phone">
<label>Motivo</label><input name="reason" required>
<div class="row"><div><label>Prioridad</label><select name="priority"><option value="normal">Normal</option><option value="alta">Alta</option></select></div>
<div><label>Fecha límite (opcional)</label><input type="date" name="due_at"></div></div>
<button class="btn ok" type="submit">Crear tarea</button></form></div>
<p>${pill("pendientes", "Pendientes")} ${pill("vencidas", "Vencidas")} ${pill("completadas", "Completadas")} ${pill("todas", "Todas")}</p>
${items.length === 0 ? `<div class="empty">No hay tareas en esta lista.</div>` : `<div class="cards-grid">${items.map(taskCard).join("")}</div>`}`;
  res.type("html").send(page("Tareas", me(res), body, msgOf(req)));
});
crm.post("/seguimiento", (req, res) => {
  const type = String(req.body.type ?? "otra") as TaskType;
  const reason = String(req.body.reason ?? "").trim();
  if (!reason) return back(res, "/crm/seguimiento", "Escribe el motivo de la tarea");
  const leadPhoneRaw = String(req.body.lead_phone ?? "").trim();
  createManualTask({
    lead_phone: leadPhoneRaw || null,
    type: Object.keys(TASK_TYPE_LABEL).includes(type) ? type : "otra",
    reason,
    priority: req.body.priority === "alta" ? "alta" : "normal",
    assigned_to: me(res).email,
    due_at: req.body.due_at ? String(req.body.due_at) : null,
  });
  back(res, "/crm/seguimiento", "Tarea creada");
});
crm.post("/seguimiento/:id", (req, res) => {
  const ok = completeTask(req.params.id, me(res).email);
  back(res, "/crm/seguimiento", ok ? "Tarea completada" : "No encuentro esa tarea");
});
crm.post("/seguimiento/:id/asignar", (req, res) => {
  const assignedTo = String(req.body.assigned_to ?? "").trim() || null;
  const ok = assignTask(req.params.id, assignedTo);
  back(res, "/crm/seguimiento", ok ? "Tarea asignada" : "No encuentro esa tarea");
});

// ---------- Embudo comercial ----------
// Columnas del funnel (20/10/2026, sección 13): reutiliza leadPhase, nunca
// un modelo paralelo -- "archivado"/"no_contactar" quedan fuera a propósito,
// son estados de gestión del cliente, no una etapa de venta en curso (ya se
// ven en Clientes). Mover una tarjeta entre columnas no es un simple
// drag-and-drop: las etapas ligadas a visitas/reservas/financiación solo
// cambian cuando esa operación real cambia (clicando "Ver ficha" se llega a
// donde de verdad se actúa) -- lo único editable aquí mismo es responsable
// y próxima acción, que sí son campos propios del cliente.
const EMBUDO_COLUMNS: LeadPhase[] = [
  "nuevo",
  "pendiente_contactar",
  "contactado",
  "visita_concertada",
  "visita_realizada",
  "negociacion_financiacion",
  "reserva_pendiente",
  "reservado",
  "venta_cerrada",
  "venta_perdida",
];
// Tarjeta compacta con borde de color por fase (26/10/2026, "E1" --
// mismo dato y mismas acciones de siempre, solo más corta y con el color
// de EMBUDO_PHASE_COLOR como borde izquierdo para que se note a qué
// columna pertenece incluso si se saca de ahí (vista en lista).
function embudoCard(l: Lead, phase: LeadPhase, resv: Reservation[]): string {
  const myReserva = resv.find((r) => r.lead_phone === l.phone && (r.status === "pending_payment" || r.status === "pending_verification" || r.status === "confirmed"));
  const daysInPhase = Math.floor((Date.now() - new Date(l.updated_at ?? l.created_at).getTime()) / 86400000);
  const [, accent] = EMBUDO_PHASE_COLOR[phase] ?? EMBUDO_PHASE_COLOR.nuevo;
  return `<div style="background:#fff;border:1px solid var(--border);border-left:3px solid ${accent};border-radius:9px;padding:11px 13px;margin-bottom:8px;display:flex;flex-direction:column;gap:5px">
<b style="font-size:14.5px">${esc(leadDisplayName(l))}</b>
<span style="font-size:12.5px;color:var(--ink-dim)">${esc(l.vehicle_interest ?? "sin coche de interés")}${myReserva ? ` · ${myReserva.amount_eur} €` : ""}</span>
<span class="origen" style="align-self:flex-start">${esc(ORIGIN[l.origin ?? ""] ?? "origen sin registrar")}</span>
<form method="post" action="/crm/clientes/${esc(l.id)}" style="display:flex;flex-direction:column;gap:5px;margin-top:2px">
<input type="hidden" name="accion" value="actualizar_embudo"><input type="hidden" name="volver" value="/crm/embudo">
<select name="assigned_to" onchange="this.form.submit()" style="font-size:12.5px;padding:6px 8px;margin:0"><option value="">Sin asignar</option>${listUsers().map((u) => `<option value="${esc(u.email)}" ${l.assigned_to === u.email ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>
<input name="next_action" value="${esc(l.next_action ?? "")}" placeholder="Próxima acción, ej. llamar el jueves" style="font-size:12.5px;padding:6px 8px;margin:0">
<button class="btn light" type="submit" style="font-size:12.5px;padding:6px 10px;margin:0;align-self:flex-start">Guardar</button>
</form>
<span style="font-size:11.5px;color:var(--ink-dim)">${daysInPhase === 0 ? "Hoy" : `Hace ${daysInPhase} día(s)`} en esta fase · <a class="link" href="/crm/clientes/${esc(l.id)}">Ver ficha</a></span>
</div>`;
}
crm.get("/embudo", (req, res) => {
  const vista = req.query.v === "lista" ? "lista" : "columnas";
  const leads = list<Lead>("leads");
  const appts = list<Appointment>("appointments");
  const resv = list<Reservation>("reservations");
  const financing = readCollection<{ lead_phone?: string; status: string }>("financing_requests");
  const today = todayMadrid();
  const withPhase = leads
    .map((l) => ({ lead: l, phase: leadPhase(l, appts, resv, today, financing) }))
    .filter((x) => EMBUDO_COLUMNS.includes(x.phase));
  // Cabecera de columna con color de fase (26/10/2026, "E1" -- antes
  // columnas sin ningún color que las distinguiera).
  const columnHeader = (phase: LeadPhase, count: number) => {
    const [bg, fg] = EMBUDO_PHASE_COLOR[phase] ?? EMBUDO_PHASE_COLOR.nuevo;
    return `<div style="background:${bg};color:${fg};border-radius:9px;padding:8px 12px;font-size:13.5px;font-weight:700;margin-bottom:8px">${esc(LEAD_PHASE_LABEL[phase])} (${count})</div>`;
  };
  const body = vista === "lista"
    ? `<h1>Embudo comercial</h1>
<p class="sub">${withPhase.length} oportunidad(es) activa(s). <a class="link" href="/crm/embudo">Ver en columnas</a></p>
${EMBUDO_COLUMNS.map((phase) => {
  const items = withPhase.filter((x) => x.phase === phase);
  return items.length === 0 ? "" : `${columnHeader(phase, items.length)}${items.map((x) => embudoCard(x.lead, x.phase, resv)).join("")}`;
}).join("")}`
    : `<h1>Embudo comercial</h1>
<p class="sub">${withPhase.length} oportunidad(es) activa(s). <a class="link" href="/crm/embudo?v=lista">Ver en lista</a></p>
<div style="display:flex;gap:14px;overflow-x:auto;padding-bottom:10px">
${EMBUDO_COLUMNS.map((phase) => {
  const items = withPhase.filter((x) => x.phase === phase);
  return `<div style="min-width:280px;flex-shrink:0">${columnHeader(phase, items.length)}${items.map((x) => embudoCard(x.lead, x.phase, resv)).join("") || `<div class="empty">Vacío</div>`}</div>`;
}).join("")}
</div>`;
  res.type("html").send(page("Embudo comercial", me(res), body, msgOf(req)));
});

// ---------- Pendientes (avisos de los agentes y correos) ----------
// Para el timbre (ver script en page()): lista de IDs de alertas urgentes
// activas ahora mismo, para que el navegador detecte cuáles son nuevas.
crm.get("/alertas-activas.json", (_req, res) => {
  res.json({ ids: pendingAlerts().map((a) => a.id) });
});

// Avisos ya atendidos (21/10/2026, petición real: "que no me sigan
// apareciendo tantos números en pendientes" -- con 28+ avisos reales
// acumulados, la lista única se volvía inmanejable). Antes, al pulsar "Ya
// lo he atendido" el aviso simplemente desaparecía sin dejar rastro en el
// CRM (solo quedaba en el JSON crudo) -- ahora tiene su propia sección,
// separada de "por atender", igual que Clientes para publicidad separó los
// leads de coches vendidos sin perderlos de vista.
function handoffCard(h: Handoff, isAdmin: boolean, attended: boolean): string {
  const reasonRaw = h.reason ?? "Aviso";
  const waLink = extractWaLink(reasonRaw);
  const afterWaStrip = waLink ? reasonRaw.replace(waLink, "").replace(/\s*[:.]\s*$/, "").trim() : reasonRaw;
  const { portal, rest: reasonClean } = extractLeadingPortal(afterWaStrip);
  const actions = attended
    ? `${isAdmin ? `<button class="btn light" type="submit" name="accion" value="reabrir">Reabrir</button>` : ""}${isAdmin ? `<button class="btn danger" type="submit" name="accion" value="eliminar" onclick="return confirm('¿Eliminar este aviso para siempre?')">Eliminar</button>` : ""}`
    : `<button class="btn ok" type="submit">Ya lo he atendido</button>${phoneLink(h.lead_phone)}${waLink ? waButton(waLink.replace("https://wa.me/", ""), waMessageFor(h.lead_phone, h.lead_name)) : ""}${isAdmin ? `<button class="btn danger" type="submit" name="accion" value="eliminar" onclick="return confirm('¿Eliminar este aviso para siempre? Úsalo solo para pruebas, no para avisos reales ya atendidos.')">Eliminar</button>` : ""}`;
  return `<div class="card ${attended ? "off" : h.reason_type === "reserva" ? "urgent" : h.urgency === "alta" ? "urgent" : "pending"}" style="position:relative"><div class="info">
${isAdmin ? simpleCheckbox("avisos-bulk", h.id) : ""}
<h3>${esc(reasonClean || "Aviso")}</h3>
<p><span class="tag ${h.reason_type === "reserva" || h.reason_type === "compra_inmediata" || h.urgency === "alta" ? "t-hot" : ""}">${h.reason_type === "reserva" ? "RESERVA 500€" : h.reason_type === "compra_inmediata" ? "Compra inmediata" : h.urgency === "alta" ? "Urgente" : "Normal"}</span> ${portal ? platformTag(portal) : ""}</p>
<p>Cliente: <b>${esc(contactLabel(h.lead_phone, h.lead_name))}${h.lead_name && h.lead_phone && !isCochesNetRelay(h.lead_phone) ? ` (${esc(h.lead_phone)})` : ""}</b> · ${esc(fmtDate(h.created_at))}</p>${h.notes ? `<p>${esc(h.notes)}</p>` : ""}
<form method="post" action="/crm/avisos/${esc(h.id)}">${actions}</form>
</div></div>`;
}
// Fase A -- limpieza del "cajón de sastre" (21/10/2026, petición real: "en
// pendientes hay de todo... quítala, quiero que cada cosa tenga su sección
// diferente"): Pendientes mezclaba reservas, incidencias y correos en una
// sola lista. Ahora cada tipo vive donde ya se gestiona de verdad --
// reservas (reason_type:"reserva") en /crm/reservas, el resto de avisos
// (reason_type "otro"/"compra_inmediata") aquí en Incidencias, y los
// correos ya tenían su propia página en /crm/correos. /crm/pendientes
// sigue existiendo solo como redirección, por si queda algún enlace viejo.
crm.get("/incidencias", (req, res) => {
  const isAdmin = me(res).role === "admin";
  const v = typeof req.query.v === "string" ? req.query.v : "por_atender";
  const allHandoffs = list<Handoff>("handoffs").filter((h) => h.reason_type !== "reserva");
  const pendientes = allHandoffs.filter((h) => h.status === "requested").sort((a, b) => b.created_at.localeCompare(a.created_at));
  const atendidos = allHandoffs.filter((h) => h.status === "done").sort((a, b) => b.created_at.localeCompare(a.created_at));
  const handoffs = v === "atendidos" ? atendidos : pendientes;
  // Tareas vencidas (20/10/2026, sección 19) -- solo un aviso con enlace a
  // Seguimiento, sin duplicar aquí la lista completa de tareas.
  const overdueTasks = listTasks().filter((t) => t.status === "pendiente" && t.due_at && t.due_at < new Date().toISOString());
  // Tarjetas grandes en vez de pestañas de texto (21/10/2026, "misma
  // organizacion que influencers en klikar" -- ahí Internos/Externos son
  // 2 tarjetas grandes con icono y contador, no texto pequeño).
  const vCard = (key: string, icon: string, iconBg: string, iconColor: string, label: string, sub: string, n: number) =>
    toggleCard(`/crm/incidencias?v=${key}`, icon, iconBg, iconColor, label, sub, n, v === key);
  const body = `<h1>Incidencias</h1>
<p class="sub">Lo que Miguel, Carolina o Daniel no pueden resolver solos y no es una reserva (eso vive en Reservas). Cuando lo hayas atendido, pulsa el botón.</p>
${overdueTasks.length > 0 ? `<div class="msg" style="background:#fdecea;border-color:#c62828">⏰ ${overdueTasks.length} tarea(s) de seguimiento vencida(s) -- <a class="link" href="/crm/seguimiento?f=vencidas">verlas</a></div>` : ""}
<div class="toggle-cards">
${vCard("por_atender", "🔴", "#fee2e2", "#dc2626", "Por atender", "Necesitan una persona", pendientes.length)}
${vCard("atendidos", "✅", "#dcfce7", "#16a34a", "Ya atendidas", "Resueltas, para auditoría", atendidos.length)}
</div>
<h2>${v === "atendidos" ? "Incidencias ya atendidas" : "Incidencias por atender"} (${handoffs.length})</h2>
${isAdmin && handoffs.length > 0 ? simpleBulkBar("avisos-bulk", "/crm/avisos-masivo", handoffs.length, "¿Eliminar los avisos seleccionados? Se pueden recuperar luego desde la Papelera.") : ""}
${handoffs.length === 0 ? `<div class="empty">${v === "atendidos" ? "Todavía no hay nada marcado como atendido." : "No hay incidencias pendientes."}</div>` : `<div class="cards-grid">${handoffs.map((h) => handoffCard(h, isAdmin, v === "atendidos")).join("")}</div>`}`;
  res.type("html").send(page("Incidencias", me(res), body, msgOf(req)));
});

crm.get("/pendientes", (_req, res) => res.redirect("/crm/incidencias"));

// Destino de vuelta según el tipo de aviso (21/10/2026): una reserva vive
// en Reservas, el resto en Incidencias -- cada botón de este formulario
// genérico vuelve a donde de verdad se gestiona ese tipo.
function avisoHome(h: Handoff): string {
  return h.reason_type === "reserva" ? "/crm/reservas" : "/crm/incidencias";
}
crm.post("/avisos/:id", (req, res) => {
  const accion = String(req.body.accion ?? "atendido");
  const items = list<Handoff>("handoffs");
  const h = items.find((x) => x.id === req.params.id);
  if (!h) return back(res, "/crm/incidencias", "No encuentro ese aviso");
  const home = avisoHome(h);
  if (accion === "eliminar") {
    if (me(res).role !== "admin") return back(res, home, "Solo el administrador puede eliminar avisos");
    moveToTrash("handoffs", h, `Aviso: ${h.reason ?? "sin motivo"} (${h.lead_name ?? h.lead_phone ?? "sin contacto"})`, me(res).email);
    save("handoffs", items.filter((x) => x.id !== h.id));
    return back(res, home, "Aviso movido a la papelera");
  }
  if (accion === "reabrir") {
    h.status = "requested";
    save("handoffs", items);
    return back(res, `${home}${home === "/crm/incidencias" ? "?v=por_atender" : ""}`, "Aviso reabierto");
  }
  h.status = "done";
  save("handoffs", items);
  back(res, `${home}${home === "/crm/incidencias" ? "?v=atendidos" : ""}`, "Aviso atendido");
});

// Borrado masivo de avisos (18/10/2026, "el borrar masivo lo quiero en
// todas las secciones") -- solo administrador, papelera recuperable.
crm.post("/avisos-masivo", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm/incidencias", "Solo el administrador puede eliminar avisos");
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  if (ids.length === 0) return back(res, "/crm/incidencias", "No seleccionaste ningún aviso");
  const items = list<Handoff>("handoffs");
  const targets = items.filter((h) => ids.includes(h.id));
  for (const h of targets) moveToTrash("handoffs", h, `Aviso: ${h.reason ?? "sin motivo"} (${h.lead_name ?? h.lead_phone ?? "sin contacto"})`, me(res).email);
  save("handoffs", items.filter((h) => !ids.includes(h.id)));
  back(res, "/crm/incidencias", targets.length === 0 ? "No había nada que hacer" : `${targets.length} aviso(s) movido(s) a la papelera`);
});

crm.post("/correos/:id", async (req, res) => {
  const accion = String(req.body.accion ?? "");
  const volver = safeVolver(req.body.volver, "/crm/correos");
  const inbox = list<InboxMail>("email_inbox");
  const m = inbox.find((x) => x.id === req.params.id);
  if (!m) return back(res, volver, "No encuentro ese correo");
  if (accion === "nota") {
    m.internal_note = String(req.body.nota ?? "").trim() || null;
    save("email_inbox", inbox);
    return back(res, volver, "Nota guardada");
  }
  // Acciones nuevas del módulo mensajes/clientes (18/10/2026), solo
  // alcanzables desde /crm/correos -- Pendientes no tiene botones para
  // ellas, así que no cambia nada de lo que ya funcionaba ahí.
  if (accion === "marcar_leido") {
    m.read = true;
    save("email_inbox", inbox);
    return back(res, volver, "Marcado como leído");
  }
  if (accion === "archivar") {
    m.archived = true;
    save("email_inbox", inbox);
    return back(res, volver, "Correo archivado");
  }
  if (accion === "ya") {
    // Responde una persona, no la IA -- se registra así (Fase 4 del encargo:
    // "Respondido por IA" vs "Respondido por equipo").
    m.answered = true;
    m.answered_by = "equipo";
    save("email_inbox", inbox);
    return back(res, volver, "Hecho");
  }
  const text = String(req.body.respuesta ?? "").trim();
  if (!text) return back(res, volver, "Escribe la respuesta antes de enviarla");
  const subject = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject || "su consulta"}`;
  const thread = m.thread_id && m.in_reply_to ? { threadId: m.thread_id, inReplyTo: m.in_reply_to } : undefined;
  const delivery = await deliverEmail(m.from, subject, `${text}\n\nAutomóviles Lucero`, thread);
  m.answered = true;
  m.answered_by = "equipo";
  save("email_inbox", inbox);
  if (delivery.status === "sent") back(res, volver, "Respuesta enviada");
  else if (delivery.status === "queued") back(res, volver, "Respuesta guardada: se enviará cuando Gmail esté conectado");
  else back(res, volver, "No se pudo enviar. Inténtalo otra vez");
});

crm.get("/avisos", (_req, res) => res.redirect("/crm/incidencias"));

// ---------- Mensajes: filtros, estados y acciones masivas compartidas ----------
// Módulo CRM mensajes/clientes (18/10/2026). Las tres bandejas (Correos,
// WhatsApp, Llamadas) comparten exactamente la misma idea de estado y las
// mismas acciones masivas -- este bloque es el único sitio donde vive esa
// lógica, para que las tres se comporten igual y no haya que mantenerla
// tres veces.
type MsgFilter = "todos" | "pendientes" | "respondidos" | "sin_leer" | "archivados";
const MSG_FILTERS: MsgFilter[] = ["todos", "pendientes", "respondidos", "sin_leer", "archivados"];
function msgFilterFromQuery(req: express.Request): MsgFilter {
  const f = String(req.query.f ?? "todos");
  return (MSG_FILTERS as string[]).includes(f) ? (f as MsgFilter) : "todos";
}
// "Pendiente"/"Respondido" no aplica a llamadas (no se puede "contestar" una
// llamada ya ocurrida) -- para esas, hasAnswered=false y el filtro
// correspondiente simplemente no se ofrece en su barra.
function matchesMsgFilter(f: MsgFilter, m: { answered?: boolean; read?: boolean; archived?: boolean }): boolean {
  if (f === "archivados") return Boolean(m.archived);
  if (m.archived) return false;
  if (f === "pendientes") return !m.answered;
  if (f === "respondidos") return Boolean(m.answered);
  if (f === "sin_leer") return !m.read;
  return true;
}
function answeredTag(m: { answered?: boolean; answered_by?: "ia" | "equipo" }): string {
  if (!m.answered) return `<span class="tag" style="background:#fff3cd;color:#7a5b00">Pendiente de respuesta</span>`;
  // No inventar quién respondió: antes de este módulo (18/10/2026) solo el
  // equipo podía marcar un correo como respondido (la IA nunca lo hacía),
  // así que un registro antiguo sin `answered_by` corresponde a una persona
  // -- pero por si acaso no se puede asegurar al 100%, si falta el dato se
  // muestra neutral en vez de adivinar.
  if (m.answered_by === "ia") return `<span class="tag estado-ia">Respondido por IA</span>`;
  if (m.answered_by === "equipo") return `<span class="tag estado-equipo">Respondido por equipo</span>`;
  return `<span class="tag">Respondido</span>`;
}
function msgRowClass(m: { answered?: boolean; read?: boolean }, hasAnswered: boolean): string {
  const estado = hasAnswered ? (m.answered ? "msg-answered" : "msg-unanswered") : "";
  const leido = m.read ? "msg-read" : "msg-unread";
  return `card ${estado} ${leido}`.trim();
}
// Reconstruye la URL exacta de una vista filtrada (base + f + q) -- la usa
// el campo oculto "volver" de cada tarjeta de mensaje/llamada, para que
// una acción (marcar leído, archivar, responder...) vuelva exactamente a
// la pestaña/filtro de donde salió, sea la página suelta o Contactos.
function withFilterQS(base: string, f: MsgFilter, q: string): string {
  const params: string[] = [];
  if (f !== "todos") params.push(`f=${f}`);
  if (q) params.push(`q=${encodeURIComponent(q)}`);
  return params.length ? `${base}?${params.join("&")}` : base;
}
function filterPills(base: string, f: MsgFilter, q: string, withAnswered: boolean): string {
  const labels: [MsgFilter, string][] = withAnswered
    ? [["todos", "Todos"], ["pendientes", "Pendientes"], ["respondidos", "Respondidos"], ["sin_leer", "Sin leer"], ["archivados", "Archivados"]]
    : [["todos", "Todas"], ["sin_leer", "Sin leer"], ["archivados", "Archivadas"]];
  const qs = q ? `&q=${encodeURIComponent(q)}` : "";
  return `<div class="filterbar">${labels.map(([k, label]) => `<a class="tag" href="${base}?f=${k}${qs}" style="${f === k ? "outline:3px solid var(--accent)" : ""}">${esc(label)}</a>`).join("")}</div>`;
}
// Desplegable de filtro (25/10/2026, Contactos -- mockup: "Todas las
// llamadas" como <select>, no pastillas). Mismos valores/semántica que
// filterPills, solo cambia la forma; navega de verdad al elegir.
function filterDropdown(base: string, f: MsgFilter, q: string, withAnswered: boolean, allLabel: string): string {
  const labels: [MsgFilter, string][] = withAnswered
    ? [["todos", allLabel], ["pendientes", "Pendientes"], ["respondidos", "Respondidos"], ["sin_leer", "Sin leer"], ["archivados", "Archivados"]]
    : [["todos", allLabel], ["sin_leer", "Sin leer"], ["archivados", "Archivadas"]];
  const qs = q ? `&q=${encodeURIComponent(q)}` : "";
  return `<select onchange="location.href=this.value" style="width:auto;min-width:200px;margin:0">${labels.map(([k, label]) => `<option value="${esc(base)}?f=${k}${qs}" ${f === k ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
}
function searchBox(base: string, f: MsgFilter, q: string, placeholder: string): string {
  return `<form class="search" method="get" action="${base}">${f !== "todos" ? `<input type="hidden" name="f" value="${esc(f)}">` : ""}<input name="q" placeholder="${esc(placeholder)}" value="${esc(q)}"><button class="btn" type="submit">Buscar</button>${q ? `<a class="btn light" href="${base}${f !== "todos" ? `?f=${f}` : ""}">Quitar filtro</a>` : ""}</form>`;
}
function bulkBar(base: string, f: MsgFilter, q: string, count: number, withAnswered: boolean): string {
  const scope = f === "todos" ? "todos los mensajes de esta vista" : f === "sin_leer" ? "los mensajes sin leer de esta vista" : f === "archivados" ? "los mensajes archivados de esta vista" : f === "pendientes" ? "los mensajes pendientes de esta vista" : "los mensajes respondidos de esta vista";
  return `<form id="${base}-bulk" method="post" action="${base}-masivo"><input type="hidden" name="f" value="${esc(f)}"><input type="hidden" name="q" value="${esc(q)}"></form>
<div class="bulkbar">
<label><input class="msgsel" type="checkbox" onchange="toggleAllMsgs(this,'ids')"> Seleccionar todos (${count})</label>
<button class="btn light" type="submit" form="${base}-bulk" name="accion" value="marcar_leido">Marcar leído</button>
<button class="btn light" type="submit" form="${base}-bulk" name="accion" value="archivar">Archivar</button>
<button class="btn danger" type="submit" form="${base}-bulk" name="accion" value="eliminar_seleccionados" onclick="return confirm('¿Eliminar los mensajes seleccionados? Se pueden recuperar luego desde la Papelera.')">Eliminar seleccionados</button>
<button class="btn danger" type="submit" form="${base}-bulk" name="accion" value="eliminar_todos" onclick="return confirm('¿Eliminar ${scope.replace(/'/g, "")} (' + document.querySelectorAll(\`input[type=checkbox][name=ids]\`).length + ' en pantalla)? Se pueden recuperar luego desde la Papelera.')">Eliminar todos los de esta vista</button>
</div>`;
}
function msgCheckbox(base: string, id: string): string {
  return `<input class="msgsel" type="checkbox" name="ids" value="${esc(id)}" form="${base}-bulk" style="position:absolute;top:18px;right:20px">`;
}
// Versión simple del bulkbar para secciones sin estados de leído/archivado
// (Visitas, Reservas, Avisos, Clientes) -- a petición real, 18/10/2026:
// "el borrar masivo lo quiero en todas las secciones". Solo seleccionar
// todos + eliminar seleccionados (papelera recuperable), nada de filtros.
function simpleBulkBar(formId: string, action: string, count: number, confirmMsg: string): string {
  return `<form id="${formId}" method="post" action="${action}"></form>
<div class="bulkbar">
<label><input class="msgsel" type="checkbox" onchange="toggleAllMsgs(this,'ids')"> Seleccionar todos (${count})</label>
<button class="btn danger" type="submit" form="${formId}" name="accion" value="eliminar_seleccionados" onclick="return confirm('${esc(confirmMsg).replace(/'/g, "\\'")}')">Eliminar seleccionados</button>
</div>`;
}
function simpleCheckbox(formId: string, id: string): string {
  return `<input class="msgsel" type="checkbox" name="ids" value="${esc(id)}" form="${formId}" style="position:absolute;top:18px;right:20px">`;
}
// Ejecuta la acción masiva sobre una colección genérica -- compartido por
// Correos/WhatsApp/Llamadas. `label` sirve para la Papelera.
function runBulkAction<T extends { id: string; read?: boolean; archived?: boolean; answered?: boolean }>(
  collection: string,
  accion: string,
  ids: string[],
  filterScope: { f: MsgFilter; q: string; search: (m: T) => boolean },
  labelOf: (m: T) => string,
  deletedBy: string,
): number {
  const items = list<T>(collection);
  const targets = accion === "eliminar_todos" ? items.filter((m) => matchesMsgFilter(filterScope.f, m) && filterScope.search(m)) : items.filter((m) => ids.includes(m.id));
  if (targets.length === 0) return 0;
  const targetIds = new Set(targets.map((t) => t.id));
  if (accion === "marcar_leido") {
    for (const m of items) if (targetIds.has(m.id)) m.read = true;
    save(collection, items);
  } else if (accion === "archivar") {
    for (const m of items) if (targetIds.has(m.id)) m.archived = true;
    save(collection, items);
  } else if (accion === "eliminar_seleccionados" || accion === "eliminar_todos") {
    for (const m of targets) moveToTrash(collection, m, labelOf(m), deletedBy);
    save(collection, items.filter((m) => !targetIds.has(m.id)));
  }
  return targets.length;
}
function searchMatches(q: string, ...fields: (string | null | undefined)[]): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  return fields.some((f) => (f ?? "").toLowerCase().includes(needle));
}

// ---------- Correos (bandeja completa) ----------
// Contactos Pro (25/10/2026): el listado de cada canal se saca a una
// función propia -- la usan tanto la página suelta de siempre (/crm/
// correos) como la bandeja única nueva (/crm/contactos/correo). `navBase`
// decide a dónde van los enlaces de filtro/búsqueda (para quedarse dentro
// de Contactos si se entra desde ahí); las acciones (marcar/archivar/
// eliminar) siempre van al endpoint real de siempre, nunca cambian.
function correoPanel(f: MsgFilter, q: string, user: CrmUser, navBase: string): string {
  const all = list<InboxMail>("email_inbox").filter((m) => m.outcome !== "automated_no_reply");
  const items = all.filter((m) => matchesMsgFilter(f, m) && searchMatches(q, m.from, m.subject, m.portal, m.text)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const allLeads = list<Lead>("leads");
  const allAppts = list<Appointment>("appointments");
  const allResv = list<Reservation>("reservations");
  const allFinancing = readCollection<{ lead_phone?: string; status: string }>("financing_requests");
  const today = todayMadrid();
  const volver = withFilterQS(navBase, f, q);
  return `${channelActivitySection("EMAIL", user)}
${filterPills(navBase, f, q, true)}
${searchBox(navBase, f, q, "Buscar por remitente, asunto o portal")}
${items.length > 0 ? bulkBar("/crm/correos", f, q, items.length, true) : ""}
${items.length === 0 ? `<div class="empty">No hay correos en esta vista.</div>` : `<div class="cards-grid">${items.map((m) => `<div class="${msgRowClass(m, true)}" style="position:relative"><div class="info">
${msgCheckbox("/crm/correos", m.id)}
<h3>${esc(m.subject || "(sin asunto)")}</h3>
<p class="meta">De: <b>${esc(m.from)}</b> · ${platformTag(m.portal)} · ${esc(fmtDate(m.created_at))}</p>
<p>${answeredTag(m)}${m.archived ? ` <span class="tag">Archivado</span>` : ""}</p>
${m.outcome === "pendiente_gestion_portal" ? `<p><b>Hay que responder desde ${esc(platformLabel(m.portal))}, no por correo</b> -- este correo es solo un aviso, al comprador no le llega una respuesta aquí.</p>` : ""}
${m.outcome === "tope_diario_alcanzado" ? `<p><b>Hoy ya se alcanzó el tope de correos automáticos</b> -- por seguridad (para que Gmail no bloquee la cuenta por enviar de más), esta respuesta no se mandó sola. Revísala y envíala tú.</p>` : ""}
${m.outcome === "pendiente_whatsapp_manual" ? `<p><b>Este cliente pidió que le escriban solo por WhatsApp</b> -- el envío automático falló (todavía no hay un número real conectado y verificado), hace falta escribirle a mano.${extractWaLink(m.draft_note) ? ` ${waButton(extractWaLink(m.draft_note)!.replace("https://wa.me/", ""), "")}` : ""}</p>` : ""}
${emailPreviewBox(m.text)}
${m.draft_note ? `<p style="margin-top:10px"><b>${m.outcome === "tope_diario_alcanzado" ? "Respuesta ya redactada" : `Borrador para copiar en ${esc(platformLabel(m.portal))}`}:</b></p><div class="box" style="background:#eef6ec;white-space:pre-wrap;font-size:19px">${esc(m.draft_note)}</div>` : ""}
<form method="post" action="/crm/correos/${esc(m.id)}"><input type="hidden" name="volver" value="${esc(volver)}">
${!m.answered ? `<label>Tu respuesta (si no escribes nada, no se envía nada)</label><textarea name="respuesta" rows="4"></textarea><button class="btn ok" type="submit" name="accion" value="responder">Enviar mi respuesta</button><button class="btn light" type="submit" name="accion" value="ya">No hace falta</button>` : ""}
${!m.read ? `<button class="btn light" type="submit" name="accion" value="marcar_leido">Marcar leído</button>` : ""}
${!m.archived ? `<button class="btn light" type="submit" name="accion" value="archivar">Archivar</button>` : ""}
</form>
${contactLeadBlock(allLeads, user, allAppts, allResv, today, allFinancing, null, m.from)}
</div></div>`).join("")}</div>`}`;
}

crm.get("/correos", (req, res) => {
  const f = msgFilterFromQuery(req);
  const q = String(req.query.q ?? "").trim();
  const body = `<h1>Correos</h1>
<p><span class="tag" style="background:var(--panel);color:var(--ink)">Agente encargado: Daniel</span></p>
<p class="sub">Todo lo que ha llegado por correo: lo que ya contestó Daniel solo y lo que espera respuesta humana.</p>
${correoPanel(f, q, me(res), "/crm/correos")}`;
  res.type("html").send(page("Correos", me(res), body, msgOf(req)));
});

crm.post("/correos-masivo", (req, res) => {
  const f = msgFilterFromQuery(req);
  const q = String(req.body.q ?? "").trim();
  const accion = String(req.body.accion ?? "");
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  const n = runBulkAction<InboxMail>(
    "email_inbox",
    accion,
    ids,
    { f, q, search: (m) => searchMatches(q, m.from, m.subject, m.portal, m.text) },
    (m) => `Correo: ${m.subject || "(sin asunto)"} (${m.from})`,
    me(res).email,
  );
  back(res, "/crm/correos", n === 0 ? "No había nada que hacer" : accion.startsWith("eliminar") ? `${n} correo(s) movido(s) a la papelera` : accion === "archivar" ? `${n} correo(s) archivado(s)` : `${n} correo(s) marcado(s) como leído`);
});

// ---------- WhatsApp (bandeja completa -- solo lectura, sin responder) ----------
// A petición expresa: "preparar la interfaz y la lógica, pero no activar el
// envío hasta verificar la conexión prevista para mañana". Por eso esta
// bandeja NO tiene ningún formulario de respuesta -- solo leer, marcar
// leído, archivar y eliminar, igual que las demás.
function whatsappPanel(f: MsgFilter, q: string, user: CrmUser, navBase: string): string {
  const all = list<WhatsappMessage>("whatsapp_inbox");
  const items = all.filter((m) => matchesMsgFilter(f, m) && searchMatches(q, m.phone, m.text)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const allLeads = list<Lead>("leads");
  const allAppts = list<Appointment>("appointments");
  const allResv = list<Reservation>("reservations");
  const allFinancing = readCollection<{ lead_phone?: string; status: string }>("financing_requests");
  const today = todayMadrid();
  const volver = withFilterQS(navBase, f, q);
  return `${channelActivitySection("WHATSAPP", user)}
${filterPills(navBase, f, q, true)}
${searchBox(navBase, f, q, "Buscar por número de teléfono")}
${items.length > 0 ? bulkBar("/crm/whatsapp", f, q, items.length, true) : ""}
${items.length === 0 ? `<div class="empty">No hay mensajes de WhatsApp en esta vista.</div>` : `<div class="cards-grid">${items.map((m) => `<div class="${msgRowClass(m, true)}" style="position:relative"><div class="info">
${msgCheckbox("/crm/whatsapp", m.id)}
<h3>${esc(m.phone)}</h3>
<p class="meta"><span class="tag">WhatsApp directo</span> · ${esc(fmtDate(m.created_at))}</p>
<p>${answeredTag(m)}${m.answered && m.delivered === false ? ` <span class="tag" style="background:#fde2e1;color:#7a1c17">No entregado (WhatsApp no conectado)</span>` : ""}${m.archived ? ` <span class="tag">Archivado</span>` : ""}</p>
${emailPreviewBox(m.text)}
${m.reply_text ? `<p style="margin-top:10px"><b>Última respuesta:</b></p><div class="box" style="background:#eef6ec;white-space:pre-wrap;font-size:19px">${esc(m.reply_text)}</div>` : ""}
<form method="post" action="/crm/whatsapp/${esc(m.id)}"><input type="hidden" name="volver" value="${esc(volver)}">
<label>Responder por WhatsApp</label><textarea name="respuesta" rows="3" placeholder="Escribe tu respuesta..."></textarea><button class="btn ok" type="submit" name="accion" value="responder">Enviar por WhatsApp</button>
${phoneLink(m.phone)}
${!m.read ? `<button class="btn light" type="submit" name="accion" value="marcar_leido">Marcar leído</button>` : ""}
${!m.archived ? `<button class="btn light" type="submit" name="accion" value="archivar">Archivar</button>` : ""}
${confirmButton("Eliminar", "eliminar", "danger", "¿Eliminar este mensaje? Se puede recuperar luego desde la Papelera.")}
</form>
${contactLeadBlock(allLeads, user, allAppts, allResv, today, allFinancing, m.phone, null)}
</div></div>`).join("")}</div>`}`;
}

crm.get("/whatsapp", (req, res) => {
  const f = msgFilterFromQuery(req);
  const q = String(req.query.q ?? "").trim();
  const body = `<h1>WhatsApp</h1>
<p><span class="tag" style="background:var(--panel);color:var(--ink)">Agente encargado: Carolina</span></p>
<p class="sub">Mensajes entrantes por WhatsApp (vía Zernio) y la respuesta real de Carolina.</p>
${whatsappPanel(f, q, me(res), "/crm/whatsapp")}`;
  res.type("html").send(page("WhatsApp", me(res), body, msgOf(req)));
});

crm.post("/whatsapp/:id", async (req, res) => {
  const accion = String(req.body.accion ?? "");
  const volver = safeVolver(req.body.volver, "/crm/whatsapp");
  const items = list<WhatsappMessage>("whatsapp_inbox");
  const m = items.find((x) => x.id === req.params.id);
  if (!m) return back(res, volver, "No encuentro ese mensaje");
  if (accion === "nota") {
    m.internal_note = String(req.body.nota ?? "").trim() || null;
    save("whatsapp_inbox", items);
    return back(res, volver, "Nota guardada");
  }
  // Responder de verdad desde el CRM (25/10/2026, petición real: "que se
  // pueda hablar con el cliente desde whatsapp y correos") -- mismo envío
  // real que ya usa Carolina (sendWhatsappText/Zernio), nunca se finge un
  // envío: si WhatsApp no está conectado o ya pasaron las 24h desde el
  // último mensaje del cliente (límite real de Meta, no de este CRM), el
  // error se muestra tal cual, tal y como ya se documentó en CLAUDE.md.
  if (accion === "responder") {
    const text = String(req.body.respuesta ?? "").trim();
    if (!text) return back(res, volver, "Escribe la respuesta antes de enviarla");
    const result = await sendWhatsappText(m.phone, text);
    if (!result.ok) return back(res, volver, `No se pudo enviar: ${result.error}`);
    m.answered = true;
    m.answered_by = "equipo";
    m.reply_text = text;
    save("whatsapp_inbox", items);
    return back(res, volver, "Respuesta enviada");
  }
  if (accion === "eliminar") {
    moveToTrash("whatsapp_inbox", m, `WhatsApp: ${m.phone}`, me(res).email);
    save("whatsapp_inbox", items.filter((x) => x.id !== m.id));
    return back(res, volver, "Mensaje movido a la papelera");
  }
  if (accion === "marcar_leido") m.read = true;
  else if (accion === "archivar") m.archived = true;
  save("whatsapp_inbox", items);
  back(res, volver, "Hecho");
});

crm.post("/whatsapp-masivo", (req, res) => {
  const f = msgFilterFromQuery(req);
  const q = String(req.body.q ?? "").trim();
  const accion = String(req.body.accion ?? "");
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  const n = runBulkAction<WhatsappMessage>(
    "whatsapp_inbox",
    accion,
    ids,
    { f, q, search: (m) => searchMatches(q, m.phone, m.text) },
    (m) => `WhatsApp: ${m.phone}`,
    me(res).email,
  );
  back(res, "/crm/whatsapp", n === 0 ? "No había nada que hacer" : accion.startsWith("eliminar") ? `${n} mensaje(s) movido(s) a la papelera` : accion === "archivar" ? `${n} mensaje(s) archivado(s)` : `${n} mensaje(s) marcado(s) como leído`);
});

// ---------- Llamadas (bandeja completa -- solo lectura, sin "respondido") ----------
function llamadasPanel(f: MsgFilter, q: string, user: CrmUser, navBase: string): string {
  const all = list<CallAnalysis>("call_analyses");
  const items = all.filter((m) => matchesMsgFilter(f, m) && searchMatches(q, m.from_number, m.summary)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const allLeads = list<Lead>("leads");
  const allAppts = list<Appointment>("appointments");
  const allResv = list<Reservation>("reservations");
  const allFinancing = readCollection<{ lead_phone?: string; status: string }>("financing_requests");
  const today = todayMadrid();
  const dur = (ms: number | null | undefined) => (ms == null ? "—" : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`);
  const volver = withFilterQS(navBase, f, q);
  return `${channelActivitySection("VOICE", user)}
${filterPills(navBase, f, q, false)}
${searchBox(navBase, f, q, "Buscar por número de teléfono")}
${items.length > 0 ? bulkBar("/crm/llamadas", f, q, items.length, false) : ""}
${items.length === 0 ? `<div class="empty">No hay llamadas en esta vista.</div>` : `<div class="cards-grid">${items.map((m) => `<div class="card ${m.needs_review ? "urgent" : ""} ${m.read ? "msg-read" : "msg-unread"}" style="position:relative"><div class="info">
${msgCheckbox("/crm/llamadas", m.id)}
<h3>${esc(m.from_number || "Número desconocido")}</h3>
<p class="meta"><span class="tag">${esc(m.channel === "VOICE" ? "Voz" : "Chat")}</span> · Duración ${dur(m.duration_ms)} · ${esc(fmtDate(m.created_at))}</p>
<p>${m.call_successful === false ? `<span class="tag" style="background:#fde2e1;color:#7a1c17">Con problemas</span>` : m.call_successful === true ? `<span class="tag" style="background:#e3f6e8;color:#1d6b3d">Correcta</span>` : `<span class="tag">Sin valorar</span>`}${m.needs_review ? ` <span class="tag" style="background:#fde2e1;color:#7a1c17">Revisar</span>` : ""}${m.archived ? ` <span class="tag">Archivada</span>` : ""}</p>
${m.summary ? `<div class="box" style="background:#f7f8fa;white-space:pre-wrap;font-size:19px">${esc(m.summary)}</div>` : `<p class="empty" style="padding:10px 0">Sin resumen disponible.</p>`}
<form method="post" action="/crm/llamadas/${esc(m.id)}"><input type="hidden" name="volver" value="${esc(volver)}">${phoneLink(m.from_number)}
${!m.read ? `<button class="btn light" type="submit" name="accion" value="marcar_leido">Marcar leído</button>` : ""}
${!m.archived ? `<button class="btn light" type="submit" name="accion" value="archivar">Archivar</button>` : ""}
${confirmButton("Eliminar", "eliminar", "danger", "¿Eliminar esta llamada? Se puede recuperar luego desde la Papelera.")}
</form>
${contactLeadBlock(allLeads, user, allAppts, allResv, today, allFinancing, m.from_number, null)}
</div></div>`).join("")}</div>`}`;
}

crm.get("/llamadas", (req, res) => {
  const f = msgFilterFromQuery(req);
  const q = String(req.query.q ?? "").trim();
  const body = `<h1>Llamadas</h1>
<p><span class="tag" style="background:var(--panel);color:var(--ink)">Agente encargado: Miguel</span></p>
<p class="sub">Llamadas atendidas por Miguel, con el resultado del análisis automático.</p>
${llamadasPanel(f, q, me(res), "/crm/llamadas")}`;
  res.type("html").send(page("Llamadas", me(res), body, msgOf(req)));
});

crm.post("/llamadas/:id", (req, res) => {
  const accion = String(req.body.accion ?? "");
  const volver = safeVolver(req.body.volver, "/crm/llamadas");
  const items = list<CallAnalysis>("call_analyses");
  const m = items.find((x) => x.id === req.params.id);
  if (!m) return back(res, volver, "No encuentro esa llamada");
  if (accion === "nota") {
    m.internal_note = String(req.body.nota ?? "").trim() || null;
    save("call_analyses", items);
    return back(res, volver, "Nota guardada");
  }
  if (accion === "eliminar") {
    moveToTrash("call_analyses", m, `Llamada: ${m.from_number ?? "sin número"}`, me(res).email);
    save("call_analyses", items.filter((x) => x.id !== m.id));
    return back(res, volver, "Llamada movida a la papelera");
  }
  if (accion === "marcar_leido") m.read = true;
  else if (accion === "archivar") m.archived = true;
  save("call_analyses", items);
  back(res, volver, "Hecho");
});

crm.post("/llamadas-masivo", (req, res) => {
  const f = msgFilterFromQuery(req);
  const q = String(req.body.q ?? "").trim();
  const accion = String(req.body.accion ?? "");
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  const n = runBulkAction<CallAnalysis>(
    "call_analyses",
    accion,
    ids,
    { f, q, search: (m) => searchMatches(q, m.from_number, m.summary) },
    (m) => `Llamada: ${m.from_number ?? "sin número"}`,
    me(res).email,
  );
  back(res, "/crm/llamadas", n === 0 ? "No había nada que hacer" : accion.startsWith("eliminar") ? `${n} llamada(s) movida(s) a la papelera` : accion === "archivar" ? `${n} llamada(s) archivada(s)` : `${n} llamada(s) marcada(s) como leída`);
});

// ---------- Contactos (bandeja única: WhatsApp + Correo + Llamadas) ----------
// Pedido real (25/10/2026, con mockup de referencia "LUCERO PRO" -- "tiene
// que ser todo así, ojo" / "y que funcione de verdad"): 3 paneles -- lista
// paginada de verdad / ficha del contacto seleccionado / actividad y notas
// internas -- como un cliente de correo. Las rutas sueltas (/crm/whatsapp,
// /crm/correos, /crm/llamadas) y sus paneles de tarjetas se quedan tal
// cual, nada se rompe ni se borra. Se actualiza sola cada 8s.
//
// Grabación/transcripción (audio real, <audio>, nunca inventado) solo
// aparecen cuando la llamada las trae de verdad (recording_url/transcript,
// capturados desde el webhook de Retell a partir de hoy -- llamadas
// anteriores a este cambio no las tendrán, y no se simulan). La ficha de
// vehículo con foto/precio del mockup NO se incluye: `vehicle_interest`
// del lead es texto libre, no un id de coche real -- intentar adivinar a
// qué vehículo del catálogo se refiere podría mostrar el coche equivocado
// a un cliente real, así que se muestra como texto, nunca como una ficha
// de coche que parece más segura de lo que es.
const CONTACTOS_CANALES = ["whatsapp", "correo", "llamadas"] as const;
type ContactoCanal = (typeof CONTACTOS_CANALES)[number];
const CONTACTOS_PAGE_SIZE = 50;

function contactosUrl(navBase: string, f: MsgFilter | null, q: string, pageNum: number, id?: string): string {
  const params: string[] = [];
  if (f && f !== "todos") params.push(`f=${f}`);
  if (q) params.push(`q=${encodeURIComponent(q)}`);
  if (pageNum > 1) params.push(`page=${pageNum}`);
  if (id) params.push(`id=${encodeURIComponent(id)}`);
  if (!params.length) return navBase;
  return `${navBase}${navBase.includes("?") ? "&" : "?"}${params.join("&")}`;
}
function contactDetailHeader(lead: Lead | null, fallbackName: string, phone?: string | null, email?: string | null): string {
  const name = lead?.name || fallbackName;
  const badge = lead
    ? `<span class="tag" style="background:var(--ok-bg);color:#1d6b3d">Cliente</span>`
    : `<span class="tag" style="background:#fdecea;color:#7a1c17">Sin ficha</span>`;
  return `<div style="display:flex;align-items:center;gap:14px;margin-bottom:4px">
${avatarBadge(phone || email || name, name, 52)}
<div><h3 style="margin:0 0 4px">${esc(name)}</h3><p class="sub" style="margin:0">${badge}${phone ? ` · ${esc(phone)}` : ""}${email ? ` · ${esc(email)}` : ""}</p></div>
</div>`;
}
function cpager(navBase: string, f: MsgFilter | null, q: string, pageNum: number, totalPages: number, total: number, count: number): string {
  if (total === 0) return "";
  const from = (pageNum - 1) * CONTACTOS_PAGE_SIZE + 1;
  const to = from + count - 1;
  const pageLink = (p: number, label: string, on = false) => `<a href="${esc(contactosUrl(navBase, f, q, p))}" class="${on ? "on" : ""}">${label}</a>`;
  const nums: string[] = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - pageNum) <= 1) nums.push(pageLink(p, String(p), p === pageNum));
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  return `<div class="cpager"><span>Mostrando ${from}-${to} de ${total}</span><div>${nums.join(" ")}${pageNum < totalPages ? pageLink(pageNum + 1, "›") : ""}</div></div>`;
}

const CALL_INTENT_LABEL: Record<string, string> = {
  comprar: "Quiere comprar", vender_o_tasar: "Quiere vender o tasar", tramite: "Trámite",
  consulta_general: "Consulta general", reclamacion: "Reclamación", otro: "Otro motivo",
};
// Filtro específico de llamadas (25/10/2026, encargo: el selector debe
// distinguir Entrantes/Salientes/Perdidas/Contestadas/Transferidas a un
// empleado/Atendidas por el asistente virtual/Pendientes de revisar) --
// todo con campos reales ya capturados (direction, call_successful,
// transfer_outcome, needs_review), ninguno inventado.
type CallFilter = "todas" | "entrantes" | "salientes" | "perdidas" | "contestadas" | "transferidas" | "ia" | "revisar";
const CALL_FILTER_LABEL: [CallFilter, string][] = [
  ["todas", "Todas las llamadas"], ["entrantes", "Entrantes"], ["salientes", "Salientes"],
  ["perdidas", "Perdidas"], ["contestadas", "Contestadas"], ["transferidas", "Transferidas a un empleado"],
  ["ia", "Atendidas por el asistente virtual"], ["revisar", "Pendientes de revisar"],
];
function matchesCallFilter(cf: CallFilter, m: CallAnalysis): boolean {
  if (cf === "todas") return true;
  if (cf === "entrantes") return m.direction === "inbound";
  if (cf === "salientes") return m.direction === "outbound";
  if (cf === "perdidas") return m.call_successful === false;
  if (cf === "contestadas") return m.call_successful === true;
  if (cf === "transferidas") return m.transfer_outcome === "transferido_ramon" || m.transfer_outcome === "transferido_jose";
  if (cf === "ia") return !m.transfer_outcome || m.transfer_outcome === "no_aplico";
  if (cf === "revisar") return Boolean(m.needs_review);
  return true;
}
function callFilterDropdown(navBase: string, cf: CallFilter, q: string): string {
  const qs = q ? `&q=${encodeURIComponent(q)}` : "";
  return `<select onchange="location.href=this.value" style="width:auto;min-width:220px;margin:0">${CALL_FILTER_LABEL.map(([k, label]) => `<option value="${esc(navBase)}?cf=${k}${qs}" ${cf === k ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
}
function callsContactos(cf: CallFilter, q: string, pageNum: number, navBase: string, allLeads: Lead[], appts: Appointment[], resv: Reservation[], today: string, financing: { lead_phone?: string; status: string }[], selectedIdRaw: string | undefined): { rows: string; detail: string; activity: string; total: number; totalPages: number; selectedId: string | null } {
  const dirLabel: Record<string, string> = { inbound: "Entrante", outbound: "Saliente" };
  const all = list<CallAnalysis>("call_analyses");
  const filtered = all.filter((m) => matchesCallFilter(cf, m) && searchMatches(q, m.from_number, m.summary)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const totalPages = Math.max(1, Math.ceil(filtered.length / CONTACTOS_PAGE_SIZE));
  const pageItems = filtered.slice((pageNum - 1) * CONTACTOS_PAGE_SIZE, pageNum * CONTACTOS_PAGE_SIZE);
  const selected = filtered.find((m) => m.id === selectedIdRaw) ?? pageItems[0] ?? null;
  const callStatusTag = (m: CallAnalysis) => m.call_successful === false
    ? `<span class="tag" style="background:var(--urgent);color:#fff;font-size:10px;padding:2px 6px">Perdida</span>`
    : m.call_successful === true
      ? `<span class="tag" style="background:var(--ok);color:#fff;font-size:10px;padding:2px 6px">Contestada</span>`
      : "";
  const rows = pageItems.length === 0 ? `<div class="empty" style="margin:14px">No hay llamadas en esta vista.</div>` : pageItems.map((m) => {
    const lead = findLeadForContact(allLeads, m.from_number, null);
    const name = lead?.name || m.from_number || "Número desconocido";
    const sub = lead?.vehicle_interest || m.summary || "Sin resumen";
    const time = (fmtDate(m.created_at).split(", ")[1]) ?? "";
    return `<a href="${esc(contactosUrl(navBase, null, q, pageNum, m.id))}" class="contact-row${selected?.id === m.id ? " active" : ""}">
${avatarBadge(m.from_number || m.id, name)}
<div class="rbody"><b>${esc(name)}</b><span class="rsub">${esc(sub)}</span></div>
<div class="rmeta"><time>${esc(time)}</time>${callStatusTag(m)}${m.needs_review ? `<span class="tag" style="background:var(--warn);color:#fff;font-size:10px;padding:2px 6px">Revisar</span>` : ""}</div>
</a>`;
  }).join("");
  if (!selected) return { rows, detail: `<div class="empty">No hay llamadas en esta vista.</div>`, activity: "", total: filtered.length, totalPages, selectedId: null };
  const lead = findLeadForContact(allLeads, selected.from_number, null);
  const [fecha, hora] = fmtDate(selected.created_at).split(", ");
  const dur = selected.duration_ms == null ? "—" : `${Math.floor(selected.duration_ms / 60000)}:${String(Math.round((selected.duration_ms % 60000) / 1000)).padStart(2, "0")}`;
  const volver = contactosUrl(navBase, null, q, pageNum, selected.id);
  // Motivo (6.3 del encargo) vs Resumen (6.4): dos campos reales distintos
  // de Retell -- intent/call_vehicle_of_interest son el análisis de ESTA
  // llamada concreta (nunca se sobrescriben entre llamadas, cada una tiene
  // su propio registro), summary es la síntesis. Si Retell no dio intent
  // para esta llamada (llamadas de antes de hoy), no se muestra Motivo.
  const motivoText = selected.intent
    ? `${CALL_INTENT_LABEL[selected.intent] ?? selected.intent}${selected.call_vehicle_of_interest ? ` -- ${selected.call_vehicle_of_interest}` : ""}.`
    : null;
  const detail = `${contactDetailHeader(lead, selected.from_number || "Número desconocido", selected.from_number, lead?.email ?? null)}
${lead?.vehicle_interest ? (findExactVehicleMatch(lead.vehicle_interest) ? vehicleCard(findExactVehicleMatch(lead.vehicle_interest)!) : `<p class="sub" style="margin:4px 0 0">Interés: <b>${esc(lead.vehicle_interest)}</b></p>`) : ""}
<div class="meta-grid"><div>Fecha<b>${esc(fecha ?? "—")}</b></div><div>Hora<b>${esc(hora ?? "—")}</b></div><div>Duración<b>${dur}</b></div><div>Tipo<b>${esc(dirLabel[selected.direction ?? ""] ?? "—")}</b></div><div>Responsable<b>Miguel (IA)</b></div></div>
${selected.issues_detected && selected.issues_detected !== "ninguno" ? `<div class="box" style="background:#fdecea;border:1px solid var(--urgent);margin-bottom:12px"><b>Incidencia detectada:</b> ${esc(selected.issues_detected)}</div>` : ""}
${motivoText ? `<h3 style="margin-bottom:6px">Motivo de la llamada</h3><p>${esc(motivoText)}</p>` : ""}
<h3 style="margin-bottom:6px">Resumen</h3><p>${selected.summary ? esc(selected.summary) : "Sin resumen disponible."}</p>
<h3 style="margin-bottom:6px">Grabación</h3>${selected.recording_url ? `<audio controls preload="none" style="width:100%"><source src="${esc(selected.recording_url)}"></audio>` : `<p class="sub">Grabación no disponible para esta llamada.</p>`}
${selected.transcript ? `<details style="margin-top:14px"><summary style="cursor:pointer;font-weight:700;color:var(--accent)">Ver transcripción completa</summary><div class="box" style="white-space:pre-wrap;font-size:13px;margin-top:8px">${esc(selected.transcript)}</div></details>` : `<p class="sub" style="margin-top:8px">Transcripción no disponible para esta llamada.</p>`}
<form method="post" action="/crm/llamadas/${esc(selected.id)}" style="margin-top:16px"><input type="hidden" name="volver" value="${esc(volver)}">${phoneLink(selected.from_number)}
${!selected.read ? `<button class="btn light" type="submit" name="accion" value="marcar_leido">Marcar leído</button>` : ""}
${!selected.archived ? `<button class="btn light" type="submit" name="accion" value="archivar">Archivar</button>` : ""}
${confirmButton("Eliminar", "eliminar", "danger", "¿Eliminar esta llamada? Se puede recuperar luego desde la Papelera.")}
</form>`;
  const activity = `<h3 style="margin-top:0">Actividad</h3>
<div class="activity-item in">Llamada ${esc(dirLabel[selected.direction ?? ""] ?? "")} · ${dur}<time>${esc(fmtDate(selected.created_at))}</time></div>
${selected.needs_review ? `<div class="activity-item ia">⚠️ Marcada para revisar</div>` : ""}
${selected.read ? `<div class="activity-item ia">Leída</div>` : ""}
${selected.archived ? `<div class="activity-item ia">Archivada</div>` : ""}
<h3>Notas internas</h3>
${selected.internal_note ? `<p class="sub" style="margin:0 0 6px">Última nota -- ${esc(selected.internal_note_by ?? "equipo")}</p>` : ""}
<form method="post" action="/crm/llamadas/${esc(selected.id)}"><input type="hidden" name="volver" value="${esc(volver)}"><textarea name="nota" rows="4" placeholder="Escribe una nota interna...">${esc(selected.internal_note ?? "")}</textarea><button class="btn" type="submit" name="accion" value="nota">Guardar nota</button><p class="sub" style="margin:4px 0 0;font-size:11px">Solo visible para el equipo</p></form>`;
  return { rows, detail, activity, total: filtered.length, totalPages, selectedId: selected.id };
}

// Ficha + actividad de un mensaje de WhatsApp (25/10/2026) -- factorizado
// de whatsappContactos para que la pestaña combinada "Mensajes" pueda
// reusar exactamente la misma ficha sin duplicar el HTML.
function whatsappDetailFor(selected: WhatsappMessage, allLeads: Lead[], volver: string): { detail: string; activity: string } {
  const lead = findLeadForContact(allLeads, selected.phone, null);
  // Conversación real (25/10/2026, "quiero que se vea la conversacion
  // real"): todos los mensajes de whatsapp_inbox con este mismo teléfono,
  // en orden cronológico -- cada fila ya guarda el mensaje del cliente y,
  // si lo hubo, la respuesta real (de la IA o del equipo, answered_by lo
  // distingue). No es una tabla nueva: es el mismo dato real que ya
  // existía, solo mostrado como hilo en vez de un mensaje suelto.
  const thread = list<WhatsappMessage>("whatsapp_inbox")
    .filter((m) => m.phone === selected.phone)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const threadHtml = thread.map((m) => `<div class="wa-row in"><div class="wa-bubble in">${esc(m.text)}<time>${esc(fmtDate(m.created_at).split(", ")[1] ?? "")}</time></div></div>${m.reply_text ? `<div class="wa-row out"><div class="wa-bubble out">${esc(m.reply_text)}<time>${m.answered_by === "ia" ? "Carolina (IA)" : "Equipo"}</time></div></div>` : ""}`).join("");
  // Estado real de la conversación (26/10/2026, "que se vea cuando
  // carolina este escribiendo... y cuando tenemos nosotros que
  // responder") -- se mira el ÚLTIMO mensaje del hilo, no el que esté
  // seleccionado: es la conversación la que está "escribiendo" o
  // "pendiente", no un mensaje suelto antiguo.
  const lastMsg = thread[thread.length - 1] ?? selected;
  const waStatus = agentReplyStatus(lastMsg.created_at, lastMsg.answered, lastMsg.answered_by, isWhatsappZernioAgentEnabled(), "Carolina");
  const typingRow = waStatus.kind === "typing" ? `<div class="wa-typing-row"><div class="wa-typing"><span></span><span></span><span></span></div></div>` : "";
  const detail = `${contactDetailHeader(lead, selected.phone, selected.phone, lead?.email ?? null)}
${lead?.vehicle_interest ? (findExactVehicleMatch(lead.vehicle_interest) ? vehicleCard(findExactVehicleMatch(lead.vehicle_interest)!) : `<p class="sub" style="margin:4px 0 0">Interés: <b>${esc(lead.vehicle_interest)}</b></p>`) : ""}
<div class="meta-grid"><div>Mensajes<b>${thread.length}</b></div><div>Último<b>${esc(fmtDate(thread[thread.length - 1]?.created_at ?? selected.created_at))}</b></div><div>Estado<b>${statusPill(waStatus.label, waStatus.tone)}</b></div></div>
${selected.answered && selected.delivered === false ? `<div class="box" style="background:#fdecea;border:1px solid var(--urgent);margin-bottom:12px;margin-top:10px">No entregado -- WhatsApp no conectado en ese momento.</div>` : ""}
<h3 style="margin-bottom:6px;margin-top:12px">Conversación</h3><div class="wa-thread">${threadHtml}${typingRow}</div>
<form method="post" action="/crm/whatsapp/${esc(thread[thread.length - 1]?.id ?? selected.id)}" style="margin-top:16px"><input type="hidden" name="volver" value="${esc(volver)}">
<label>Responder por WhatsApp</label><textarea name="respuesta" rows="4" placeholder="Escribe tu respuesta..."></textarea><button class="btn ok" type="submit" name="accion" value="responder">Enviar por WhatsApp</button>
<p class="sub" style="margin:4px 0 0;font-size:12px">Solo se puede enviar texto libre dentro de las 24h desde el último mensaje del cliente -- límite real de WhatsApp, no de este CRM.</p>
</form>
<form method="post" action="/crm/whatsapp/${esc(selected.id)}" style="margin-top:10px"><input type="hidden" name="volver" value="${esc(volver)}">${phoneLink(selected.phone)}
${!selected.read ? `<button class="btn light" type="submit" name="accion" value="marcar_leido">Marcar leído</button>` : ""}
${!selected.archived ? `<button class="btn light" type="submit" name="accion" value="archivar">Archivar</button>` : ""}
${confirmButton("Eliminar este mensaje", "eliminar", "danger", "¿Eliminar este mensaje? Se puede recuperar luego desde la Papelera.")}
</form>`;
  const activity = `<h3 style="margin-top:0">Actividad</h3>
<div class="activity-item wa">WhatsApp recibido<time>${esc(fmtDate(selected.created_at))}</time></div>
${selected.answered ? `<div class="activity-item ia">Respondido ${selected.answered_by === "ia" ? "por Carolina (IA)" : "por el equipo"}</div>` : ""}
${selected.archived ? `<div class="activity-item ia">Archivado</div>` : ""}
<h3>Notas internas</h3>
<form method="post" action="/crm/whatsapp/${esc(selected.id)}"><input type="hidden" name="volver" value="${esc(volver)}"><textarea name="nota" rows="4" placeholder="Escribe una nota interna...">${esc(selected.internal_note ?? "")}</textarea><button class="btn" type="submit" name="accion" value="nota">Guardar nota</button><p class="sub" style="margin:4px 0 0;font-size:11px">Solo visible para el equipo</p></form>`;
  return { detail, activity };
}
// Hilo real de correo (26/10/2026, "en gmail tambien... que se parezca
// lo mas a gmail") -- igual que ya se hizo con whatsapp_inbox: se cruza
// email_inbox (lo que entra) con email_outbox (lo que de verdad se
// envió, tanto si lo redactó Daniel solo como si lo escribió el equipo a
// mano -- deliverEmail guarda ahí los dos casos por igual) por
// thread_id, y se ordena todo por fecha real. Nunca se inventa quién
// escribió cada envío: se usa el answered_by del mensaje entrante más
// cercano en el tiempo, el único dato real que lo dice.
function correoDetailFor(selected: InboxMail, allLeads: Lead[], volver: string): { detail: string; activity: string } {
  const lead = findLeadForContact(allLeads, null, selected.from);
  const inboundThread = (selected.thread_id ? list<InboxMail>("email_inbox").filter((m) => m.thread_id === selected.thread_id) : [selected])
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  // FALLO REAL detectado y corregido antes de confirmar (26/10/2026):
  // filtrar solo status==="sent" hacía desaparecer del hilo una
  // respuesta real recién enviada en cuanto Gmail no estaba conectado
  // (se guarda igual en email_outbox, honestamente como "queued") -- el
  // equipo veía "Ya respondió el equipo" pero su propio texto no
  // aparecía por ningún lado. Se muestran los tres estados reales
  // (sent/queued/failed), cada uno con su aviso honesto, nunca se oculta
  // un envío real.
  const outboundThread = selected.thread_id
    ? list<EmailOutboxRow>("email_outbox").filter((o) => o.thread_id === selected.thread_id)
    : [];
  type ThreadItem = { kind: "in" | "out"; created_at: string; from: string; body: string; status?: EmailOutboxRow["status"] };
  const items: ThreadItem[] = [
    ...inboundThread.map((m): ThreadItem => ({ kind: "in", created_at: m.created_at, from: lead?.name || m.from, body: m.text })),
    ...outboundThread.map((o): ThreadItem => {
      const prior = [...inboundThread].reverse().find((m) => m.created_at <= o.created_at) ?? inboundThread[0];
      return { kind: "out", created_at: o.created_at, from: prior?.answered_by === "equipo" ? "El equipo" : "Daniel (IA)", body: o.body, status: o.status };
    }),
  ].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const threadHtml = items.map((it) => {
    const statusNote = it.status === "queued"
      ? `<p class="sub" style="margin:4px 0 0;font-size:11.5px">En cola -- se enviará cuando Gmail esté conectado</p>`
      : it.status === "failed"
        ? `<p class="sub" style="margin:4px 0 0;font-size:11.5px;color:var(--urgent)">No se pudo enviar</p>`
        : "";
    const body = it.kind === "in" ? emailPreviewBox(it.body) : `<div class="mail-text">${esc(it.body)}</div>${statusNote}`;
    return `<div class="mail-item ${it.kind}">${avatarBadge(it.from, it.from, 30)}<div class="mail-body"><div class="mail-head"><span class="mail-from">${esc(it.from)}</span><span class="mail-time">${esc(fmtDate(it.created_at))}</span></div>${body}</div></div>`;
  }).join("");
  // Estado real de la conversación (26/10/2026, "que se vea cuando...
  // tenemos nosotros que responder", mismo criterio ya aplicado a
  // WhatsApp): se mira el correo entrante más reciente del hilo, no el
  // seleccionado.
  const lastInbound = inboundThread[inboundThread.length - 1] ?? selected;
  const mailStatus = agentReplyStatus(lastInbound.created_at, lastInbound.answered, lastInbound.answered_by, isEmailAutoSendEnabled(), "Daniel");
  const typingLine = mailStatus.kind === "typing" ? `<p class="mail-typing">Daniel está redactando…</p>` : "";
  const detail = `${contactDetailHeader(lead, selected.from, lead?.phone ?? null, selected.from)}
${lead?.vehicle_interest ? (findExactVehicleMatch(lead.vehicle_interest) ? vehicleCard(findExactVehicleMatch(lead.vehicle_interest)!) : `<p class="sub" style="margin:4px 0 0">Interés: <b>${esc(lead.vehicle_interest)}</b></p>`) : ""}
<div class="meta-grid"><div>Correos<b>${items.length}</b></div><div>Portal<b>${esc(platformLabel(selected.portal))}</b></div><div>Estado<b>${statusPill(mailStatus.label, mailStatus.tone)}</b></div></div>
${selected.outcome === "pendiente_gestion_portal" ? `<div class="box" style="background:#fff4e0;border:1px solid var(--warn);margin-bottom:12px">Hay que responder desde ${esc(platformLabel(selected.portal))}, no por correo.</div>` : ""}
<h3 style="margin-bottom:6px">Asunto</h3><p>${esc(selected.subject || "(sin asunto)")}</p>
<h3 style="margin-bottom:6px">Conversación</h3><div class="mail-thread">${threadHtml}</div>
${typingLine}
${selected.draft_note ? `<h3 style="margin-bottom:6px">Borrador</h3><div class="box" style="background:var(--ok-bg);white-space:pre-wrap">${esc(selected.draft_note)}</div>` : ""}
<form method="post" action="/crm/correos/${esc(selected.id)}" style="margin-top:16px"><input type="hidden" name="volver" value="${esc(volver)}">
${!selected.answered ? `<label>Tu respuesta (si no escribes nada, no se envía nada)</label><textarea name="respuesta" rows="4"></textarea><button class="btn ok" type="submit" name="accion" value="responder">Enviar mi respuesta</button><button class="btn light" type="submit" name="accion" value="ya">No hace falta</button>` : ""}
${!selected.read ? `<button class="btn light" type="submit" name="accion" value="marcar_leido">Marcar leído</button>` : ""}
${!selected.archived ? `<button class="btn light" type="submit" name="accion" value="archivar">Archivar</button>` : ""}
</form>`;
  const activity = `<h3 style="margin-top:0">Actividad</h3>
<div class="activity-item email">Correo recibido<time>${esc(fmtDate(selected.created_at))}</time></div>
${selected.answered ? `<div class="activity-item ia">Respondido ${selected.answered_by === "ia" ? "por Daniel (IA)" : "por el equipo"}</div>` : ""}
${selected.archived ? `<div class="activity-item ia">Archivado</div>` : ""}
<h3>Notas internas</h3>
<form method="post" action="/crm/correos/${esc(selected.id)}"><input type="hidden" name="volver" value="${esc(volver)}"><textarea name="nota" rows="4" placeholder="Escribe una nota interna...">${esc(selected.internal_note ?? "")}</textarea><button class="btn" type="submit" name="accion" value="nota">Guardar nota</button><p class="sub" style="margin:4px 0 0;font-size:11px">Solo visible para el equipo</p></form>`;
  return { detail, activity };
}

function whatsappContactos(f: MsgFilter, q: string, pageNum: number, navBase: string, allLeads: Lead[], appts: Appointment[], resv: Reservation[], today: string, financing: { lead_phone?: string; status: string }[], selectedIdRaw: string | undefined): { rows: string; detail: string; activity: string; total: number; totalPages: number; selectedId: string | null } {
  const all = list<WhatsappMessage>("whatsapp_inbox");
  const filtered = all.filter((m) => matchesMsgFilter(f, m) && searchMatches(q, m.phone, m.text)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const totalPages = Math.max(1, Math.ceil(filtered.length / CONTACTOS_PAGE_SIZE));
  const pageItems = filtered.slice((pageNum - 1) * CONTACTOS_PAGE_SIZE, pageNum * CONTACTOS_PAGE_SIZE);
  const selected = filtered.find((m) => m.id === selectedIdRaw) ?? pageItems[0] ?? null;
  const rows = pageItems.length === 0 ? `<div class="empty" style="margin:14px">No hay mensajes en esta vista.</div>` : pageItems.map((m) => {
    const lead = findLeadForContact(allLeads, m.phone, null);
    const name = lead?.name || m.phone;
    const time = (fmtDate(m.created_at).split(", ")[1]) ?? "";
    return `<a href="${esc(contactosUrl(navBase, f, q, pageNum, m.id))}" class="contact-row${selected?.id === m.id ? " active" : ""}">
${avatarBadge(m.phone, name)}
<div class="rbody"><b>${esc(name)}</b><span class="rsub">${esc(m.text)}</span></div>
<div class="rmeta"><time>${esc(time)}</time>${!m.answered ? `<span class="tag" style="background:var(--warn);color:#fff;font-size:10px;padding:2px 6px">Pendiente</span>` : ""}</div>
</a>`;
  }).join("");
  if (!selected) return { rows, detail: `<div class="empty">No hay mensajes en esta vista.</div>`, activity: "", total: filtered.length, totalPages, selectedId: null };
  const { detail, activity } = whatsappDetailFor(selected, allLeads, contactosUrl(navBase, f, q, pageNum, selected.id));
  return { rows, detail, activity, total: filtered.length, totalPages, selectedId: selected.id };
}

function correoContactos(f: MsgFilter, q: string, pageNum: number, navBase: string, allLeads: Lead[], appts: Appointment[], resv: Reservation[], today: string, financing: { lead_phone?: string; status: string }[], selectedIdRaw: string | undefined): { rows: string; detail: string; activity: string; total: number; totalPages: number; selectedId: string | null } {
  const all = list<InboxMail>("email_inbox").filter((m) => m.outcome !== "automated_no_reply");
  const filtered = all.filter((m) => matchesMsgFilter(f, m) && searchMatches(q, m.from, m.subject, m.portal, m.text)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const totalPages = Math.max(1, Math.ceil(filtered.length / CONTACTOS_PAGE_SIZE));
  const pageItems = filtered.slice((pageNum - 1) * CONTACTOS_PAGE_SIZE, pageNum * CONTACTOS_PAGE_SIZE);
  const selected = filtered.find((m) => m.id === selectedIdRaw) ?? pageItems[0] ?? null;
  const rows = pageItems.length === 0 ? `<div class="empty" style="margin:14px">No hay correos en esta vista.</div>` : pageItems.map((m) => {
    const lead = findLeadForContact(allLeads, null, m.from);
    const name = lead?.name || m.from;
    const time = (fmtDate(m.created_at).split(", ")[1]) ?? "";
    return `<a href="${esc(contactosUrl(navBase, f, q, pageNum, m.id))}" class="contact-row${selected?.id === m.id ? " active" : ""}">
${avatarBadge(m.from, name)}
<div class="rbody"><b>${esc(name)}</b><span class="rsub">${esc(m.subject || "(sin asunto)")}</span></div>
<div class="rmeta"><time>${esc(time)}</time>${!m.answered ? `<span class="tag" style="background:var(--warn);color:#fff;font-size:10px;padding:2px 6px">Pendiente</span>` : ""}</div>
</a>`;
  }).join("");
  if (!selected) return { rows, detail: `<div class="empty">No hay correos en esta vista.</div>`, activity: "", total: filtered.length, totalPages, selectedId: null };
  const { detail, activity } = correoDetailFor(selected, allLeads, contactosUrl(navBase, f, q, pageNum, selected.id));
  return { rows, detail, activity, total: filtered.length, totalPages, selectedId: selected.id };
}

// Secciones del mockup todavía sin módulo real detrás (25/10/2026,
// Lucero PRO: "no quiero fallos" / nunca datos inventados) -- en vez de
// quitarlas del menú o fingir contenido, un estado honesto de verdad: lo
// que se puede hacer hoy mismo (enlaces a lo que sí existe) y que está
// pendiente de construir. Nunca contadores ni listas falsas.
function placeholderPage(title: string, why: string, mientrasTanto: { href: string; text: string }[]): string {
  return `<h1>${esc(title)}</h1>
<div class="box" style="background:var(--panel)"><b>Esta sección todavía está en construcción.</b><p class="sub" style="margin:8px 0 0">${esc(why)}</p></div>
${mientrasTanto.length ? `<h2>Mientras tanto</h2>${mientrasTanto.map((m) => `<p><a class="link" href="${esc(m.href)}">${esc(m.text)} →</a></p>`).join("")}` : ""}`;
}
crm.get("/anuncios", (req, res) => {
  const body = placeholderPage("Anuncios", "Publicar y gestionar anuncios en portales (Coches.net, Milanuncios...) desde aquí todavía no está construido.", [
    { href: "/crm/coches", text: "Ver y editar el catálogo de vehículos" },
  ]);
  res.type("html").send(page("Anuncios", me(res), body, msgOf(req)));
});
crm.get("/agenda", (req, res) => {
  const body = placeholderPage("Agenda", "Un calendario propio con todas las visitas, llamadas y tareas en una sola vista todavía no está construido.", [
    { href: "/crm/citas", text: "Ver las visitas programadas" },
    { href: "/crm/seguimiento", text: "Ver las tareas pendientes" },
  ]);
  res.type("html").send(page("Agenda", me(res), body, msgOf(req)));
});
crm.get("/ventas", (req, res) => {
  const body = placeholderPage("Ventas", "Un resumen propio de ventas cerradas (importes, comisiones, histórico) todavía no está construido.", [
    { href: "/crm/embudo", text: "Ver el embudo comercial" },
    { href: "/crm/informes", text: "Ver los informes ya disponibles" },
  ]);
  res.type("html").send(page("Ventas", me(res), body, msgOf(req)));
});
crm.get("/ajustes", (req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Esta sección es solo para el administrador");
  const body = placeholderPage("Ajustes", "Un panel propio de configuración general (horarios, datos del negocio, plantillas) todavía no está construido.", [
    { href: "/crm/integraciones", text: "Ver conexiones y agentes de IA" },
    { href: "/crm/equipo", text: "Ver usuarios del equipo" },
  ]);
  res.type("html").send(page("Ajustes", me(res), body, msgOf(req)));
});

crm.get("/contactos", (_req, res) => res.redirect("/crm/contactos/whatsapp"));

// Alta manual de un contacto (25/10/2026, "+ Nuevo contacto" del mockup)
// -- reusa upsertLead, el mismo que usan voz/chat/correo para dar de alta
// un lead real; aparece después en Clientes y en Contactos como
// cualquier otro. Va antes de "/contactos/:canal" porque si no, Express
// trataría "nuevo" como si fuera un nombre de canal.
crm.get("/contactos/nuevo", (req, res) => {
  const body = `<h1>Nuevo contacto</h1>
<p class="sub">Da de alta un cliente a mano -- queda guardado como cualquier otro lead real, y aparece también en Clientes.</p>
<form class="box" method="post" action="/crm/contactos/nuevo">
<div class="row">
<div><label>Nombre</label><input name="nombre" required></div>
<div><label>Teléfono o correo</label><input name="contacto" required placeholder="+34600111222 o nombre@correo.com"></div>
</div>
<div class="row">
<div><label>Vehículo de interés</label><input name="vehicle_interest" placeholder="Ej. BMW Serie 3"></div>
<div><label>Canal</label><select name="canal"><option value="WHATSAPP">WhatsApp</option><option value="VOICE">Teléfono</option><option value="EMAIL">Correo</option><option value="MANUAL" selected>Presencial / otro</option></select></div>
</div>
<button class="btn ok" type="submit">Crear contacto</button>
<a class="btn light" href="/crm/contactos">Cancelar</a>
</form>`;
  res.type("html").send(page("Contactos", me(res), body, msgOf(req)));
});
crm.post("/contactos/nuevo", (req, res) => {
  const nombre = String(req.body.nombre ?? "").trim();
  const contacto = String(req.body.contacto ?? "").trim();
  const vehicleInterest = String(req.body.vehicle_interest ?? "").trim();
  const canal = String(req.body.canal ?? "MANUAL").trim();
  if (!nombre || !contacto) return back(res, "/crm/contactos/nuevo", "Falta el nombre o el teléfono/correo");
  const isEmail = contacto.includes("@");
  // Comprobación real de duplicados antes de guardar (25/10/2026, encargo:
  // "antes de guardar, el sistema debe comprobar posibles duplicados por
  // teléfono y correo... ofrecerá abrir su ficha... en lugar de crear otro
  // duplicado") -- upsertLead ya fusiona por teléfono/correo normalizado
  // (tools/leads.ts), así que nunca se duplica el registro; esto solo
  // decide el mensaje honesto: si ya existía, se dice así en vez de fingir
  // que se creó uno nuevo.
  const existing = findLeadForContact(list<Lead>("leads"), isEmail ? null : contacto, isEmail ? contacto : null);
  const result = upsertLead({
    name: nombre,
    phone: isEmail ? undefined : contacto,
    email: isEmail ? contacto : undefined,
    vehicle_interest: vehicleInterest || undefined,
    channel: canal,
  });
  if (result.status !== "ok" || !result.data) return back(res, "/crm/contactos/nuevo", "No se pudo crear el contacto");
  back(res, `/crm/clientes/${result.data.id}`, existing ? `Ya existía este contacto (${existing.name || existing.phone || existing.email || ""}) -- se actualizó su ficha, no se creó otro` : "Contacto creado");
});

crm.get("/contactos/:canal", (req, res) => {
  const canal = req.params.canal as ContactoCanal;
  if (!CONTACTOS_CANALES.includes(canal)) return back(res, "/crm/contactos/mensajes", "Esa sección de Contactos no existe");
  const f = msgFilterFromQuery(req);
  const cf: CallFilter = CALL_FILTER_LABEL.some(([k]) => k === req.query.cf) ? (req.query.cf as CallFilter) : "todas";
  const q = String(req.query.q ?? "").trim();
  const pageNum = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const selectedIdRaw = typeof req.query.id === "string" ? req.query.id : undefined;
  const user = me(res);
  const navBase = `/crm/contactos/${canal}`;
  const allLeads = list<Lead>("leads");
  const appts = list<Appointment>("appointments");
  const resv = list<Reservation>("reservations");
  const today = todayMadrid();
  const financing = readCollection<{ lead_phone?: string; status: string }>("financing_requests");
  const pendingWa = list<WhatsappMessage>("whatsapp_inbox").filter((m) => !m.answered).length;
  const pendingCo = list<InboxMail>("email_inbox").filter((m) => m.outcome !== "automated_no_reply" && !m.answered).length;
  const unreadLl = list<CallAnalysis>("call_analyses").filter((m) => !m.read).length;
  const tabLink = (key: ContactoCanal, label: string, count: number) =>
    `<a href="/crm/contactos/${key}" class="${canal === key ? "on-tab" : ""}">${esc(label)}${count > 0 ? ` <span class="tag">${count > 99 ? "99+" : count}</span>` : ""}</a>`;
  const tabs = `<div class="htabs">
${tabLink("whatsapp", "WhatsApp", pendingWa)}
${tabLink("correo", "Correo", pendingCo)}
${tabLink("llamadas", "Llamadas", unreadLl)}
</div>`;
  const built = canal === "whatsapp"
    ? whatsappContactos(f, q, pageNum, navBase, allLeads, appts, resv, today, financing, selectedIdRaw)
    : canal === "correo"
      ? correoContactos(f, q, pageNum, navBase, allLeads, appts, resv, today, financing, selectedIdRaw)
      : callsContactos(cf, q, pageNum, `${navBase}?cf=${cf}`, allLeads, appts, resv, today, financing, selectedIdRaw);
  const withAnswered = canal !== "llamadas";
  const listLabel: Record<ContactoCanal, string> = { whatsapp: "Todo WhatsApp", correo: "Todo el correo", llamadas: "Todas las llamadas" };
  const pagerQs = canal === "llamadas" ? null : f;
  const body = `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
<h1 style="margin:0">Contactos</h1>
<a class="btn" href="/crm/contactos/nuevo">+ Nuevo contacto</a>
</div>
<p class="sub">Se actualiza sola.</p>
${tabs}
<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
${canal === "llamadas" ? callFilterDropdown(navBase, cf, q) : filterDropdown(navBase, f, q, withAnswered, listLabel[canal])}
${searchBox(navBase, f, q, canal === "correo" ? "Buscar por remitente, asunto o portal" : "Buscar por número de teléfono")}
</div>
<div class="contactos-shell" id="contactos-panel" data-canal="${canal}">
<div class="contactos-list">
<div class="contactos-list-scroll">${built.rows}</div>
${cpager(canal === "llamadas" ? `${navBase}?cf=${cf}` : navBase, pagerQs, q, pageNum, built.totalPages, built.total, built.rows ? Math.min(CONTACTOS_PAGE_SIZE, built.total - (pageNum - 1) * CONTACTOS_PAGE_SIZE) : 0)}
</div>
<div class="contactos-detail">${built.detail}</div>
<div class="contactos-activity">${built.activity}</div>
</div>
<script>
(function(){
  // No mover la pantalla al refrescar sola (25/10/2026, petición real:
  // "cada vez que elimino algo que no se mueva la pantalla, ajustalo
  // bien") -- las 3 columnas tienen su propio scroll interno
  // (.contactos-list-scroll/.contactos-detail/.contactos-activity), y
  // reemplazar su HTML entero las reiniciaba a arriba de todo cada 8s o
  // tras cualquier acción. Se guarda cada scrollTop antes y se restaura
  // justo después de pintar el HTML nuevo.
  var SCROLL_SELECTORS = [".contactos-list-scroll", ".contactos-detail", ".contactos-activity"];
  function refrescar(){
    try{
      var activo = document.activeElement;
      var tag = activo && activo.tagName;
      if(tag === "TEXTAREA" || tag === "INPUT") return;
      var scrolls = SCROLL_SELECTORS.map(function(sel){ var el = document.querySelector(sel); return el ? el.scrollTop : null; });
      fetch(location.pathname + location.search).then(function(r){ return r.text(); }).then(function(html){
        var doc = new DOMParser().parseFromString(html, "text/html");
        var fresco = doc.getElementById("contactos-panel");
        var mio = document.getElementById("contactos-panel");
        if(fresco && mio){
          mio.innerHTML = fresco.innerHTML;
          SCROLL_SELECTORS.forEach(function(sel, i){
            if(scrolls[i] == null) return;
            var el = document.querySelector(sel);
            if(el) el.scrollTop = scrolls[i];
          });
        }
      }).catch(function(){});
    }catch(e){}
  }
  setInterval(refrescar, 8000);
})();
</script>`;
  res.type("html").send(page("Contactos", user, body, msgOf(req)));
});

// ---------- Clientes (solo lectura de la segmentación de los agentes) ----------
// ---------- Entrada de leads (bandeja única de triaje) ----------
// Fase A (21/10/2026, punto 4 del encargo): "qué atiendo ahora mismo, en
// orden" -- distinto de Clientes, que es el listado histórico completo
// para buscar a alguien. Sin acciones masivas en esta v1: toda edición
// real sigue pasando por "Ver ficha" hacia /crm/clientes/:id, donde ya vive.
function entradaCard(l: Lead, phase: LeadPhase, quality: DataQuality, priority: LeadPriority, duplicate: Lead | null, appts: Appointment[]): string {
  const t = TEMP[l.temperature] ?? TEMP.COLD;
  const prioCls = priority === "P1" ? "t-hot" : priority === "P2" ? "t-warm" : "";
  const qualityNote = quality === "posible_duplicado" && duplicate
    ? `<a class="link" href="/crm/clientes/${esc(duplicate.id)}" style="color:#9a3412">⚠️ ${esc(DATA_QUALITY_LABEL[quality])}: mismo teléfono que ${esc(leadDisplayName(duplicate))}</a>`
    : DATA_QUALITY_LABEL[quality];
  return `<div class="card" style="position:relative"><div class="info">
<h3>${esc(leadDisplayName(l))}</h3>
<p><span class="tag ${prioCls}">${esc(LEAD_PRIORITY_LABEL[priority])}</span> <span class="tletra ${t.cls}">${t.letter}</span><span class="tag ${t.cls}">${esc(t.label)}</span> <span class="tag">${esc(LEAD_PHASE_LABEL[phase])}</span></p>
<p>${qualityNote}</p>
<p><b>${esc(situation(l))}</b></p>
<p>Último contacto: ${esc(fmtDate(l.updated_at ?? l.created_at))}</p>
<a class="btn" href="/crm/clientes/${esc(l.id)}">Editar / ver ficha</a>${phoneLink(l.phone)}${waButton(l.phone, whatsappGreetingFor(l, appts))}
</div></div>`;
}
crm.get("/entrada", (req, res) => {
  const p = typeof req.query.p === "string" && ["P1", "P2", "P3", "P4"].includes(req.query.p) ? (req.query.p as LeadPriority) : "todas";
  const cal = typeof req.query.cal === "string" && ["completo", "incompleto", "dudoso", "posible_duplicado", "no_comercial"].includes(req.query.cal)
    ? (req.query.cal as DataQuality)
    : "todas";
  const today = todayMadrid();
  const all = list<Lead>("leads");
  const appts = list<Appointment>("appointments");
  const reservations = list<Reservation>("reservations");
  const financing = readCollection<{ lead_phone?: string; status: string }>("financing_requests");
  const handoffs = list<Handoff>("handoffs");
  const activeLeads = all.filter((l) => !l.archived && !l.marketing_list && !l.do_not_contact && !l.sale_outcome);
  const rows = activeLeads.map((l) => {
    const phase = leadPhase(l, appts, reservations, today, financing);
    const quality = dataQuality(l, all);
    const hasOpenUrgentHandoff = Boolean(
      l.phone && handoffs.some((h) => h.status === "requested" && h.urgency === "alta" && h.lead_phone && normalizePhone(h.lead_phone) === normalizePhone(l.phone!)),
    );
    const priority = leadPriority(l, phase, hasOpenUrgentHandoff);
    return { lead: l, phase, quality, priority, duplicate: findPossibleDuplicate(l, all) };
  });
  // Tarjetas grandes para la prioridad (21/10/2026, "misma organizacion
  // que influencers en klikar"): los contadores reflejan el filtro de
  // calidad activo (igual que en Klikar el país filtra antes de contar
  // Internos/Externos), pero no el de prioridad -- así cada tarjeta
  // muestra cuánto hay en SU grupo, no el resultado ya filtrado.
  const calFiltered = rows.filter((r) => cal === "todas" || r.quality === cal);
  const countByPrio = (k: string) => calFiltered.filter((r) => r.priority === k).length;
  const filtered = calFiltered
    .filter((r) => p === "todas" || r.priority === p)
    .sort((a, b) => a.priority.localeCompare(b.priority) || (b.lead.updated_at ?? b.lead.created_at).localeCompare(a.lead.updated_at ?? a.lead.created_at));
  const prioCard = (k: string, icon: string, iconBg: string, iconColor: string, label: string, sub: string) =>
    toggleCard(`/crm/entrada?p=${k}&cal=${cal}`, icon, iconBg, iconColor, label, sub, k === "todas" ? calFiltered.length : countByPrio(k), p === k);
  const calPill = (k: string, label: string) => `<a href="/crm/entrada?p=${p}&cal=${k}" class="tag" style="text-decoration:none;${cal === k ? "background:var(--accent);color:#fff" : ""}">${label}</a>`;
  const body = `<h1>Entrada de leads</h1>
<p class="sub">Qué atiende ahora mismo, en orden de prioridad. Para el historial completo o buscar a alguien concreto, usa Clientes.</p>
<div class="toggle-cards">
${prioCard("todas", "📋", "#e8ebf1", "#1a1d23", "Todas", "Toda la bandeja")}
${prioCard("P1", "🔴", "#fee2e2", "#dc2626", "P1 -- Urgente", "Atender ya")}
${prioCard("P2", "🟠", "#ffedd5", "#ea580c", "P2 -- Alta", "Pronto")}
${prioCard("P3", "🟡", "#fef9c3", "#a16207", "P3 -- Normal", "Sin prisa")}
${prioCard("P4", "⚪", "#f3f4f6", "#4b5563", "P4 -- Diferida", "Más adelante")}
</div>
<div class="legend">${calPill("todas", "Toda calidad")} ${calPill("completo", "Completo")} ${calPill("incompleto", "Incompleto")} ${calPill("dudoso", "Dudoso")} ${calPill("posible_duplicado", "Posible duplicado")} ${calPill("no_comercial", "No comercial")}</div>
${filtered.length === 0 ? `<div class="empty">Nada en esta vista.</div>` : `<div class="cards-grid">${filtered.map((r) => entradaCard(r.lead, r.phase, r.quality, r.priority, r.duplicate, appts)).join("")}</div>`}`;
  res.type("html").send(page("Entrada de leads", me(res), body, msgOf(req)));
});

crm.get("/clientes", (req, res) => {
  autoArchiveColdLeads();
  const t = typeof req.query.t === "string" && (TEMP[req.query.t] || req.query.t === "archivados") ? req.query.t : "todos";
  const dateFilter: DateFilterKey = (["hoy", "ayer", "7dias", "30dias", "mes", "mes_anterior", "todo"] as const).includes(req.query.d as DateFilterKey)
    ? (req.query.d as DateFilterKey)
    : "todo";
  const today = todayMadrid();
  const all = list<Lead>("leads");
  const appts = list<Appointment>("appointments");
  const reservations = list<Reservation>("reservations");
  const financing = readCollection<{ lead_phone?: string; status: string }>("financing_requests");
  const archivedCount = all.filter((l) => l.archived).length;
  const leads = all
    .filter((l) => (t === "archivados" ? l.archived : !l.archived && !l.marketing_list && (t === "todos" || l.temperature === t)))
    .filter((l) => matchesDateFilter(dateFilter, l.created_at, today))
    // Petición real (23/10/2026, "organizalos de primeros a ultimos segun las
    // fechas"): de más antiguo a más reciente (antes era al revés).
    .sort((a, b) => (a.updated_at ?? a.created_at).localeCompare(b.updated_at ?? b.created_at));
  // Tarjetas grandes en vez de pestañas de texto (21/10/2026, "misma
  // organizacion que influencers en klikar"): mismo filtro de siempre
  // (?t=), solo con icono + contador real por grupo.
  const activeLeadsForCount = all.filter((l) => !l.archived && !l.marketing_list);
  const countByTemp = (temp: string) => activeLeadsForCount.filter((l) => l.temperature === temp).length;
  const tempCard = (k: string, icon: string, iconBg: string, iconColor: string, label: string, sub: string, count: number) =>
    toggleCard(`/crm/clientes?t=${k}&d=${dateFilter}`, icon, iconBg, iconColor, label, sub, count, t === k);
  const datePill = (k: DateFilterKey) => `<a href="/crm/clientes?t=${t}&d=${k}" class="tag" style="text-decoration:none;${dateFilter === k ? "background:var(--accent);color:#fff" : ""}">${DATE_FILTER_LABEL[k]}</a>`;
  const isAdmin = me(res).role === "admin";
  const bulk = isAdmin && leads.length > 0
    ? `<form id="clientes-bulk" method="post" action="/crm/clientes-masivo"><input type="hidden" name="t" value="${esc(t)}"></form>
<div class="bulkbar">
<label><input class="msgsel" type="checkbox" onchange="toggleAllMsgs(this,'ids')"> Seleccionar todos (${leads.length})</label>
${t === "archivados"
  ? `<button class="btn ok" type="submit" form="clientes-bulk" name="accion" value="desarchivar_seleccionados">Desarchivar seleccionados</button>`
  : `<button class="btn light" type="submit" form="clientes-bulk" name="accion" value="archivar_seleccionados">Archivar seleccionados</button>`}
<button class="btn danger" type="submit" form="clientes-bulk" name="accion" value="eliminar_seleccionados" onclick="return confirm('¿Eliminar los clientes seleccionados? Se pueden recuperar luego desde la Papelera.')">Eliminar seleccionados</button>
</div>`
    : "";
  const body = `<h1>Clientes</h1>
<p class="sub">Miguel, Carolina y Daniel anotan solos lo que quiere cada cliente, sea cual sea el canal. Tú solo lo lees y llamas si hace falta. Los clientes fríos sin contacto en ${LEAD_ARCHIVE_INACTIVE_DAYS} días se archivan solos -- nunca se borran, solo dejan de aparecer aquí.</p>
<div class="box"><h3 style="margin-top:0">Añadir un cliente a mano</h3>
<form method="post" action="/crm/clientes">
<div class="row"><div><label>Nombre</label><input name="nombre"></div>
<div><label>Teléfono</label><input name="telefono" required></div></div>
<label>Coche de interés</label><input name="vehicle_interest">
<button class="btn ok" type="submit">Añadir cliente</button></form></div>
<div class="toggle-cards">
${tempCard("todos", "👥", "#e8ebf1", "#1a1d23", "Todos", "Clientes activos", activeLeadsForCount.length)}
${tempCard("HOT", "🔥", "#fee2e2", "#dc2626", "Caliente", "Intención de compra clara", countByTemp("HOT"))}
${tempCard("WARM", "🙂", "#ffedd5", "#ea580c", "Tibio", "Interés real, sin prisa", countByTemp("WARM"))}
${tempCard("COLD", "❄️", "#e0f2fe", "#0369a1", "Frío", "Consulta exploratoria", countByTemp("COLD"))}
${tempCard("archivados", "🗄️", "#f3f4f6", "#4b5563", "Archivados", "Sin contacto hace tiempo", archivedCount)}
</div>
<div class="legend">${datePill("hoy")} ${datePill("ayer")} ${datePill("7dias")} ${datePill("30dias")} ${datePill("mes")} ${datePill("mes_anterior")} ${datePill("todo")}</div>
${bulk}
${leads.length === 0 ? `<div class="empty">${t === "archivados" ? "No hay clientes archivados." : "No hay clientes en esta lista para ese periodo -- prueba a quitar el filtro de fecha."}</div>` : `<div class="records-list">${leads.map((l) => leadCard(l, me(res), leadPhase(l, appts, reservations, today, financing), findPossibleDuplicate(l, all), appts, `/crm/clientes?t=${t}&d=${dateFilter}`)).join("")}</div>`}`;
  res.type("html").send(page("Clientes y oportunidades", me(res), body, msgOf(req)));
});

crm.post("/clientes", (req, res) => {
  const telefono = String(req.body.telefono ?? "").trim();
  if (!telefono) return back(res, "/crm/clientes", "Escribe el teléfono del cliente");
  const leads = list<Lead>("leads");
  // Arreglo real (20/10/2026, sección 6.5): el alta manual comparaba el
  // teléfono tal cual, sin normalizar -- a diferencia de upsertLead (el
  // mismo número en otro formato, ej. "622188213" vs "+34622188213",
  // colaba un duplicado). Mismo criterio que ya usa el resto del CRM.
  const key = normalizePhone(telefono);
  if (leads.some((l) => l.phone && normalizePhone(l.phone) === key)) return back(res, "/crm/clientes", "Ya existe un cliente con ese teléfono");
  leads.push({
    id: crypto.randomUUID(),
    phone: telefono,
    name: String(req.body.nombre ?? "").trim() || null,
    notes: null,
    channel: "MANUAL",
    origin: "MANUAL",
    vehicle_interest: String(req.body.vehicle_interest ?? "").trim() || null,
    temperature: "COLD",
    followup_count: 0,
    do_not_contact: false,
    created_at: now(),
  });
  save("leads", leads);
  back(res, "/crm/clientes", "Cliente añadido");
});

crm.get("/clientes/:id", (req, res) => {
  const allLeads = list<Lead>("leads");
  const lead = allLeads.find((l) => l.id === req.params.id);
  if (!lead) return back(res, "/crm/clientes", "No encuentro ese cliente");
  const key = lead.phone ?? "";
  const appts = list<Appointment>("appointments").filter((a) => a.lead_phone === key);
  const resv = list<Reservation>("reservations").filter((r) => r.lead_phone === key);
  const summaries = list<ConversationSummary>("conversation_summaries").filter((c) => c.phone === key);
  const financing = readCollection<{ lead_phone?: string; status: string }>("financing_requests").filter((f) => f.lead_phone === key);
  const t = TEMP[lead.temperature] ?? TEMP.COLD;
  const phase = leadPhase(lead, appts, resv, todayMadrid(), financing);
  const duplicate = findPossibleDuplicate(lead, allLeads);
  // Cronología única (20/10/2026, sección 6.4): visitas + reservas +
  // resúmenes de conversación, todo junto y ordenado por fecha -- antes
  // estaban en tres bloques separados sin relación temporal entre ellos.
  const timeline: { at: string; html: string }[] = [
    ...appts.map((a) => ({
      at: a.created_at,
      html: `📅 Visita (${esc(ORIGIN[a.channel ?? ""] ?? "origen desconocido")}): ${esc(a.requested_date ?? "sin fecha")} ${esc(a.requested_time ?? "")} -- <b>${esc(APPOINTMENT_TEXT[a.status] ?? a.status)}</b>`,
    })),
    ...resv.map((r) => ({
      at: r.created_at,
      html: `💰 Reserva (${esc(ORIGIN[r.channel ?? ""] ?? "origen desconocido")}) de ${esc(vehicleName(r.vehicle_id))} -- <b>${esc(RESERVATION_TEXT[r.status] ?? r.status)}</b> (${r.amount_eur} €)`,
    })),
    ...summaries.map((s) => ({ at: s.created_at, html: `💬 Resumen de conversación: ${esc(s.summary)}` })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const duplicateWarning = duplicate
    ? `<div class="msg" style="background:#fff8e6;border-color:#d9a22b">⚠️ Posible duplicado: <a class="link" href="/crm/clientes/${esc(duplicate.id)}">${esc(leadDisplayName(duplicate))}</a> tiene el mismo teléfono normalizado. Si es la misma persona, pide a un administrador que lo fusione desde /tools/merge_leads.</div>`
    : "";
  const saleOutcomeBox = `<div class="box"><h3 style="margin-top:0">Venta cerrada o perdida</h3>
<p class="sub">Esto es una decisión del equipo -- nunca se marca solo.</p>
${lead.sale_outcome ? `<p><b>Estado:</b> ${lead.sale_outcome === "cerrada" ? "Venta cerrada" : `Venta perdida${lead.lost_reason ? ` -- ${esc(lead.lost_reason)}` : ""}`} <form method="post" action="/crm/clientes/${esc(lead.id)}" style="display:inline">${button("Reabrir oportunidad", "reabrir", "light")}</form></p>` : `
<form method="post" action="/crm/clientes/${esc(lead.id)}" style="display:inline">${confirmButton("✅ Venta cerrada", "venta_cerrada", "ok", "¿Confirmas que esta venta se ha cerrado?")}</form>
<form method="post" action="/crm/clientes/${esc(lead.id)}" style="display:inline">
<select name="lost_reason"><option value="">Motivo de la pérdida...</option>${["Precio", "Financiación", "Vehículo vendido o no disponible", "Compró en otro concesionario", "No responde", "Cancelación", "No interesado", "Otro"].map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("")}</select>
<button class="btn danger" type="submit" name="accion" value="venta_perdida">❌ Venta perdida</button>
</form>`}
</div>`;
  const body = `<p><a class="link" href="/crm/clientes">← Volver a clientes</a></p>
<h1>${esc(lead.name || lead.phone || "Cliente")}</h1>
<p><span class="tag ${t.cls}">${esc(t.label)}</span> <span class="tag">${esc(LEAD_PHASE_LABEL[phase])}</span> <span class="origen">Captado: ${esc(ORIGIN[lead.origin ?? ""] ?? "sin registrar")}</span> <span class="origen">Último contacto: ${esc(ORIGIN[lead.channel ?? ""] ?? "sin registrar")}</span></p>
${duplicateWarning}
<div class="box"><p><b>Lo que quiere:</b> ${esc(situation(lead))}</p>
<p><b>Contacto:</b> ${esc(lead.phone ?? "—")}</p>
${phoneLink(lead.phone)}</div>
${saleOutcomeBox}
${timeline.length > 0 ? `<div class="box"><h3 style="margin-top:0">Historial</h3>${timeline.map((e) => `<p class="sub">${esc(fmtDate(e.at))}</p><p>${e.html}</p>`).join("<hr>")}</div>` : ""}
<form class="box" method="post" action="/crm/clientes/${esc(lead.id)}">
<label>Nombre</label><input name="nombre" value="${esc(lead.name ?? "")}">
<label>Coche de interés</label><input name="vehicle_interest" value="${esc(lead.vehicle_interest ?? "")}">
<label>Notas para el equipo</label><textarea name="notes" rows="3">${esc(lead.notes ?? "")}</textarea>
<button class="btn ok" type="submit" name="accion" value="guardar">Guardar cambios</button>
${lead.do_not_contact ? button("Volver a escribirle", "reactivar", "light") : button("No volver a escribirle", "no_contactar", "danger")}
${lead.non_commercial ? button("No es spam, es un cliente real", "quitar_no_comercial", "light") : button("Marcar como no comercial (spam/nº equivocado)", "marcar_no_comercial", "light")}
${me(res).role === "admin" ? confirmButton("Eliminar cliente", "eliminar", "danger", `¿Eliminar a "${lead.name || lead.phone || "este cliente"}"? Se puede restaurar luego desde la Papelera.`) : ""}
</form>`;
  res.type("html").send(page("Clientes y oportunidades", me(res), body, msgOf(req)));
});

crm.post("/clientes/:id", (req, res) => {
  const leads = list<Lead>("leads");
  const lead = leads.find((l) => l.id === req.params.id);
  if (!lead) return back(res, "/crm/clientes", "No encuentro ese cliente");
  const accion = String(req.body.accion ?? "guardar");
  // A petición real (21/10/2026, "cada vez que borre un lead que no me
  // cambie de sección"): al borrar/archivar desde una lista filtrada
  // (Clientes con ?t=/?d=, Buscar con ?q=), antes siempre volvía a la
  // lista sin filtrar o a la ficha -- un salto brusco. Mismo "volver" ya
  // usado por Embudo/Entrada, ampliado a cualquier ruta propia del CRM
  // (nunca externa, por seguridad) en vez de una lista cerrada de dos.
  const safeVolver = typeof req.body.volver === "string" && req.body.volver.startsWith("/crm/") && !req.body.volver.startsWith("//") ? req.body.volver : null;
  if (accion === "eliminar") {
    if (me(res).role !== "admin") return back(res, safeVolver ?? `/crm/clientes/${lead.id}`, "Solo el administrador puede eliminar clientes");
    moveToTrash("leads", lead, `Cliente: ${lead.name || lead.phone || "sin nombre"}`, me(res).email);
    save("leads", leads.filter((x) => x.id !== lead.id));
    return back(res, safeVolver ?? "/crm/clientes", "Cliente movido a la papelera");
  }
  if (accion === "no_contactar") lead.do_not_contact = true;
  else if (accion === "reactivar") lead.do_not_contact = false;
  else if (accion === "marcar_no_comercial") lead.non_commercial = true;
  else if (accion === "quitar_no_comercial") lead.non_commercial = false;
  else if (accion === "archivar") lead.archived = true;
  else if (accion === "desarchivar") lead.archived = false;
  else if (accion === "mover_publicidad") lead.marketing_list = true;
  else if (accion === "quitar_publicidad") lead.marketing_list = false;
  else if (accion === "venta_cerrada") {
    lead.sale_outcome = "cerrada";
    lead.lost_reason = null;
  } else if (accion === "venta_perdida") {
    lead.sale_outcome = "perdida";
    lead.lost_reason = String(req.body.lost_reason ?? "").trim() || "Otro";
  } else if (accion === "reabrir") {
    lead.sale_outcome = null;
    lead.lost_reason = null;
  } else if (accion === "actualizar_embudo") {
    // Edición rápida desde el Embudo (20/10/2026, sección 13) -- solo toca
    // responsable/próxima acción, nunca nombre/coche/notas (eso sigue
    // siendo el formulario "guardar" de la ficha completa).
    lead.assigned_to = String(req.body.assigned_to ?? "").trim() || null;
    lead.next_action = String(req.body.next_action ?? "").trim() || null;
  } else {
    // El teléfono NO se edita aquí a propósito: es la clave con la que
    // casan las visitas y reservas de este cliente (situation(), la propia
    // ficha), y cambiarlo a mano las dejaría huérfanas sin que nadie se dé
    // cuenta.
    lead.name = String(req.body.nombre ?? "").trim() || null;
    lead.vehicle_interest = String(req.body.vehicle_interest ?? "").trim() || null;
    lead.notes = String(req.body.notes ?? "").trim() || null;
  }
  lead.updated_at = now();
  save("leads", leads);
  const ACCION_MSG: Record<string, string> = {
    guardar: "Cambios guardados",
    no_contactar: "Listo: no le escribiremos más",
    reactivar: "Listo: sí se le puede escribir",
    marcar_no_comercial: "Marcado como no comercial",
    quitar_no_comercial: "Ya no está marcado como no comercial",
    archivar: "Cliente archivado",
    desarchivar: "Cliente desarchivado",
    mover_publicidad: "Movido a Clientes para publicidad",
    quitar_publicidad: "Quitado de Clientes para publicidad",
    venta_cerrada: "Venta marcada como cerrada",
    venta_perdida: "Venta marcada como perdida",
    reabrir: "Oportunidad reabierta",
    actualizar_embudo: "Responsable/próxima acción actualizados",
  };
  back(res, safeVolver ?? `/crm/clientes/${lead.id}`, ACCION_MSG[accion] ?? "Listo");
});

// Eliminar varios clientes a la vez (a petición real, 18/10/2026: "la
// selección... donde selecciona cada tarjeta de cada cliente para poder
// borrar todo"). Mismo patrón que Correos/WhatsApp/Llamadas: papelera
// recuperable, nunca borrado directo -- y solo el administrador, igual que
// ya exigía el borrado individual de clientes.
crm.post("/clientes-masivo", (req, res) => {
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  if (ids.length === 0) return back(res, "/crm/clientes", "No seleccionaste ningún cliente");
  const accion = String(req.body.accion ?? "eliminar_seleccionados");

  if (accion === "archivar_seleccionados" || accion === "desarchivar_seleccionados") {
    const leads = list<Lead>("leads");
    const targets = leads.filter((l) => ids.includes(l.id));
    const verbo = accion === "archivar_seleccionados" ? "archivado(s)" : "desarchivado(s)";
    if (accion === "desarchivar_seleccionados") {
      for (const l of targets) l.archived = false;
      save("leads", leads);
      return back(res, "/crm/clientes", targets.length === 0 ? "No había nada que hacer" : `${targets.length} cliente(s) ${verbo}`);
    }
    // FALLO REAL detectado (20/10/2026): un archivado masivo por antigüedad
    // se tragó clientes con avisos reales sin resolver (p. ej. una oferta de
    // compra o un "quiero reservar" que nunca llegó a confirmarse) solo
    // porque no tenían cita/reserva registrada todavía -- el aviso vivía
    // únicamente en Pendientes, no en una cita/reserva real. Regla nueva:
    // nunca archivar un lead con un aviso (handoff) todavía sin atender.
    const openHandoffPhones = new Set(list<Handoff>("handoffs").filter((h) => h.status === "requested" && h.lead_phone).map((h) => h.lead_phone as string));
    const skipped = targets.filter((l) => l.phone && openHandoffPhones.has(l.phone));
    const toArchive = targets.filter((l) => !(l.phone && openHandoffPhones.has(l.phone)));
    for (const l of toArchive) l.archived = true;
    save("leads", leads);
    const skippedMsg = skipped.length > 0 ? ` (${skipped.length} omitido(s) por tener un aviso sin atender en Pendientes)` : "";
    return back(res, "/crm/clientes", toArchive.length === 0 ? "No había nada que archivar" : `${toArchive.length} cliente(s) ${verbo}${skippedMsg}`);
  }

  if (me(res).role !== "admin") return back(res, "/crm/clientes", "Solo el administrador puede eliminar clientes");
  const leads = list<Lead>("leads");
  const targets = leads.filter((l) => ids.includes(l.id));
  for (const l of targets) moveToTrash("leads", l, `Cliente: ${l.name || l.phone || "sin nombre"}`, me(res).email);
  save("leads", leads.filter((l) => !ids.includes(l.id)));
  back(res, "/crm/clientes", targets.length === 0 ? "No había nada que hacer" : `${targets.length} cliente(s) movido(s) a la papelera`);
});

// ---------- Clientes para publicidad ----------
// Petición real (21/10/2026): varios clientes preguntaron por un coche que
// ya no está en el inventario real (vendido) y no les interesa otro modelo
// distinto -- no son un lead activo de ventas, pero tampoco "sin interés"
// (archivados): son un contacto real para remarketing el día que entre un
// coche parecido. Lista propia, fuera de Clientes/Pendientes/Visitas.
crm.get("/publicidad", (req, res) => {
  const leads = list<Lead>("leads").filter((l) => l.marketing_list).sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at));
  const body = `<h1>Clientes para publicidad</h1>
<p class="sub">Preguntaron por un coche que ya no está disponible y no quieren otro modelo -- no son una oportunidad activa, pero sí un contacto real para cuando entre algo parecido. Nunca se les escribe desde aquí solos: esto es solo una lista para campañas futuras.</p>
${leads.length === 0 ? `<div class="empty">No hay clientes en esta lista.</div>` : `<div class="cards-grid">${leads.map((l) => `<div class="card"><div class="info">
<h3>${esc(l.name || l.phone || "Sin datos de contacto")}</h3>
<p>${l.phone ? `<b>${esc(l.phone)}</b> · ` : ""}${esc(l.vehicle_interest || "Sin vehículo registrado")}</p>
${l.notes ? `<p>${esc(l.notes)}</p>` : ""}
<form method="post" action="/crm/clientes/${esc(l.id)}">${phoneLink(l.phone)}<button class="btn light" type="submit" name="accion" value="quitar_publicidad">Quitar de esta lista</button></form>
</div></div>`).join("")}</div>`}`;
  res.type("html").send(page("Clientes para publicidad", me(res), body, msgOf(req)));
});

// ---------- Coches ----------
const STATUS_TAG: Record<OfficialVehicleStatus, string> = {
  AVAILABLE: "background:#dcfce7;color:#166534",
  RESERVATION_PENDING: "background:#ffedd5;color:#9a3412",
  RESERVED: "background:#ffedd5;color:#9a3412",
  SOLD: "background:#e5e7eb;color:#374151",
};

// Cuadrícula de tarjetas (26/10/2026, "B1" de las ideas de diseño: antes
// era una lista plana de texto, ninguna de las 34 fichas se distinguía
// de otra salvo por el nombre). Sin foto real en el catálogo (nunca se
// inventa una) -- la mejora está en la estructura: precio como
// protagonista, estado como pastilla de color, para ojear el stock de
// un vistazo en vez de leer fila por fila.
crm.get("/coches", (req, res) => {
  const body = `<h1>Vehículos</h1>
<p class="sub">Toca un coche para cambiar si está disponible, reservado o vendido, y su precio.</p>
<div class="cards-grid">
${currentVehicles().map((v) => {
  const st = getOfficialStatus(v.id);
  return `<div class="vehicle-card">
<div class="photo">Sin foto</div>
<h3>${esc(vehicleName(v.id))}</h3>
<span class="specs">${v.year ? `${esc(v.year)} · ` : ""}${esc(v.km.toLocaleString("es-ES"))} km · ${esc(v.fuel)}</span>
<div class="pricerow"><b>${esc(priceOf(v.id).toLocaleString("es-ES"))} €</b><span class="tag" style="${STATUS_TAG[st]}">${esc(VEHICLE_TEXT[st])}</span></div>
<a class="btn light" href="/crm/coches/${esc(v.id)}">Cambiar</a>
</div>`;
}).join("")}
</div>`;
  res.type("html").send(page("Vehículos", me(res), body, msgOf(req)));
});

crm.get("/coches/:id", (req, res) => {
  const v = currentVehicles().find((x) => x.id === req.params.id);
  if (!v) return back(res, "/crm/coches", "No encuentro ese coche");
  const st = getOfficialStatus(v.id);
  const body = `<p><a class="link" href="/crm/coches">← Volver a coches</a></p>
<h1>${esc(vehicleName(v.id))}</h1>
<p>${esc(v.km.toLocaleString("es-ES"))} km · ${esc(v.fuel)} · ${esc(v.power_cv)} CV</p>
<p>${v.known_defects ? `Detalle conocido: <b>${esc(v.known_defects)}</b>` : "Sin averías conocidas"}</p>
<form class="box" method="post" action="/crm/coches/${esc(v.id)}">
<label>Estado</label><select name="estado">
${(["AVAILABLE", "RESERVED", "SOLD"] as OfficialVehicleStatus[]).map((s) => option(s, VEHICLE_TEXT[s], st)).join("")}</select>
<label>Precio (€)</label><input name="precio" type="number" value="${esc(priceOf(v.id))}" min="0">
<button class="btn ok" type="submit">Guardar</button></form>`;
  res.type("html").send(page("Vehículos", me(res), body, msgOf(req)));
});

crm.post("/coches/:id", (req, res) => {
  const v = vehiclesSeed.find((x) => x.id === req.params.id);
  if (!v) return back(res, "/crm/coches", "No encuentro ese coche");
  const estado = String(req.body.estado ?? "") as OfficialVehicleStatus;
  if (["AVAILABLE", "RESERVED", "SOLD"].includes(estado)) setOfficialStatus(v.id, estado, null);
  const precio = Number(req.body.precio);
  if (Number.isFinite(precio) && precio >= 0) {
    const overrides = list<VehicleOverride>("vehicle_overrides").filter((o) => o.vehicle_id !== v.id);
    overrides.push({ vehicle_id: v.id, price_eur: precio });
    save("vehicle_overrides", overrides);
  }
  back(res, `/crm/coches/${v.id}`, "Coche guardado");
});

// Paleta categórica validada (skill de dataviz, references/palette.md --
// 8 tonos, orden fijo, separación mínima de contraste comprobada para
// daltonismo con el script del propio skill) -- reutilizada tal cual,
// nunca una elegida a ojo. Solo para Informes (26/10/2026, "D1" -- antes
// eran números y frases sueltas, ahora un embudo y barras reales con los
// mismos datos de siempre).
const CHART_CATEGORICAL = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
function funnelChart(stages: { label: string; count: number }[]): string {
  const max = Math.max(1, ...stages.map((s) => s.count));
  const H = 84;
  const bars = stages.map((s) => {
    const h = Math.max(3, Math.round((s.count / max) * H));
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:6px;flex:1;min-width:0">
<div style="width:100%;max-width:110px;height:${h}px;background:${CHART_CATEGORICAL[0]};border-radius:4px 4px 0 0"></div>
<span style="font-size:11.5px;color:var(--ink-dim);text-align:center">${esc(s.label)} <b style="color:var(--ink)">${s.count}</b></span>
</div>`;
  }).join("");
  return `<div style="display:flex;align-items:flex-end;gap:10px;height:${H}px;margin:6px 0 2px">${bars}</div>`;
}
function hBarChart(rows: [string, number][]): string {
  if (rows.length === 0) return `<p class="sub">Sin datos todavía.</p>`;
  const max = Math.max(1, ...rows.map(([, n]) => n));
  return `<div style="display:flex;flex-direction:column;gap:8px;margin-top:6px">${rows.map(([label, n], i) => {
    const w = Math.max(4, Math.round((n / max) * 100));
    const color = CHART_CATEGORICAL[i % CHART_CATEGORICAL.length];
    return `<div style="display:flex;align-items:center;gap:8px"><span style="width:160px;font-size:12.5px;color:var(--ink-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0">${esc(label)}</span><div style="flex:1;background:var(--panel);border-radius:4px;height:11px"><div style="width:${w}%;height:100%;background:${color};border-radius:4px"></div></div><b style="font-size:12.5px;width:28px;text-align:right;flex-shrink:0">${n}</b></div>`;
  }).join("")}</div>`;
}
// ---------- Informes comerciales ----------
// Fase 4 de la mejora integral del CRM (20/10/2026, sección 18): reutiliza
// exactamente los mismos filtros temporales de Clientes (Fase 1) y el
// mismo patrón de agregación real que ya usaba el cuadro de voz en
// Integraciones (contar/filtrar arrays en memoria con datos reales, nunca
// una cifra inventada). "No contar dos veces la misma venta": una venta
// cerrada vive en un único campo (Lead.sale_outcome), así que cualquier
// desglose por canal cuenta ese mismo lead una sola vez, nunca una vez por
// cada canal por el que pasó.
crm.get("/informes", (req, res) => {
  const dateFilter: DateFilterKey = (["hoy", "ayer", "7dias", "30dias", "mes", "mes_anterior", "todo"] as const).includes(req.query.d as DateFilterKey)
    ? (req.query.d as DateFilterKey)
    : "30dias";
  const today = todayMadrid();
  const leads = list<Lead>("leads").filter((l) => matchesDateFilter(dateFilter, l.created_at, today));
  const appts = list<Appointment>("appointments").filter((a) => matchesDateFilter(dateFilter, a.created_at, today));
  const resv = list<Reservation>("reservations").filter((r) => matchesDateFilter(dateFilter, r.created_at, today));
  const handoffs = list<Handoff>("handoffs").filter((h) => matchesDateFilter(dateFilter, h.created_at, today));
  const tasks = listTasks();
  const financing = readCollection<{ lead_phone?: string; status: string }>("financing_requests");

  const leadsNuevos = leads.length;
  const leadsCalientes = leads.filter((l) => l.temperature === "HOT").length;
  const leadsContactados = leads.filter((l) => {
    const p = leadPhase(l, appts, resv, today, financing);
    return p !== "nuevo" && p !== "pendiente_contactar";
  }).length;
  const visitasConcertadas = appts.length;
  const visitasRealizadas = appts.filter((a) => a.status === "confirmed" && (a.requested_date ?? "") < today).length;
  const visitasNoPresentado = appts.filter((a) => a.status === "no_presentado").length;
  const reservasCreadas = resv.length;
  const reservasConfirmadas = resv.filter((r) => r.status === "confirmed").length;
  const reservasCanceladas = resv.filter((r) => r.status === "cancelled").length;
  const ventasCerradas = leads.filter((l) => l.sale_outcome === "cerrada").length;
  const ventasPerdidas = leads.filter((l) => l.sale_outcome === "perdida");
  const motivosPerdida = new Map<string, number>();
  for (const l of ventasPerdidas) motivosPerdida.set(l.lost_reason ?? "Otro", (motivosPerdida.get(l.lost_reason ?? "Otro") ?? 0) + 1);
  const tareasVencidas = tasks.filter((t) => t.status === "pendiente" && t.due_at && t.due_at < new Date().toISOString()).length;

  // Tiempo medio hasta el primer contacto humano: desde que se crea el lead
  // hasta su primer handoff real -- solo se promedia cuando hay datos de
  // verdad, nunca un número relleno cuando no hay ningún handoff todavía.
  const allHandoffs = list<Handoff>("handoffs");
  const firstContactHours: number[] = [];
  for (const l of leads) {
    if (!l.phone) continue;
    const firstHandoff = allHandoffs.filter((h) => h.lead_phone === l.phone).sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (firstHandoff) firstContactHours.push((new Date(firstHandoff.created_at).getTime() - new Date(l.created_at).getTime()) / 3600000);
  }
  const avgFirstContactHours = firstContactHours.length ? firstContactHours.reduce((a, b) => a + b, 0) / firstContactHours.length : null;

  // Conversión: siempre sobre los leads del propio periodo, para que la
  // tasa tenga sentido junto a los contadores de arriba -- nunca mezclando
  // un numerador del periodo con un denominador histórico completo.
  const leadsConVisita = leads.filter((l) => appts.some((a) => a.lead_phone === l.phone)).length;
  const leadsConReserva = leads.filter((l) => resv.some((r) => r.lead_phone === l.phone)).length;
  const convLeadVisita = leadsNuevos > 0 ? (leadsConVisita / leadsNuevos) * 100 : null;
  const convVisitaReserva = leadsConVisita > 0 ? (leads.filter((l) => appts.some((a) => a.lead_phone === l.phone) && resv.some((r) => r.lead_phone === l.phone)).length / leadsConVisita) * 100 : null;
  const convReservaVenta = leadsConReserva > 0 ? (leads.filter((l) => resv.some((r) => r.lead_phone === l.phone) && l.sale_outcome === "cerrada").length / leadsConReserva) * 100 : null;

  // Coste real de voz (mismo dato que Integraciones, Retell lo reporta por
  // llamada) -- nunca se mezcla con WhatsApp/chat/correo, que no tienen
  // coste medido por canal todavía.
  const voiceCalls = readCollection<{ channel: string; created_at: string; cost_cents: number | null }>("call_analyses")
    .filter((c) => c.channel === "VOICE")
    .filter((c) => matchesDateFilter(dateFilter, c.created_at, today));
  const voiceCostEur = voiceCalls.reduce((sum, c) => sum + (c.cost_cents ?? 0), 0) / 100;
  const costePorLlamada = voiceCalls.length > 0 ? voiceCostEur / voiceCalls.length : null;

  // Atribución: primera captación (Lead.origin, nunca se sobrescribe) vs
  // canal de conversión (el canal real de la reserva que llevó a la venta,
  // cuando existe) -- dos tablas distintas, cada venta cuenta una sola vez
  // en cada una.
  const porOrigen = new Map<string, number>();
  for (const l of leads) porOrigen.set(ORIGIN[l.origin ?? ""] ?? "Origen desconocido", (porOrigen.get(ORIGIN[l.origin ?? ""] ?? "Origen desconocido") ?? 0) + 1);
  const ventasPorCanalConversion = new Map<string, number>();
  for (const l of leads.filter((x) => x.sale_outcome === "cerrada")) {
    const miReserva = resv.find((r) => r.lead_phone === l.phone);
    const label = ORIGIN[miReserva?.channel ?? ""] ?? "Origen desconocido";
    ventasPorCanalConversion.set(label, (ventasPorCanalConversion.get(label) ?? 0) + 1);
  }

  // Calidad de datos y duplicados (21/10/2026, Fase A punto 3): pasada real
  // de agrupación sobre TODOS los leads (nunca solo el periodo elegido,
  // porque un duplicado puede venir de hace meses) -- misma normalización
  // que ya usa findPossibleDuplicate/upsertLead. Nunca fusiona solo, solo
  // enlaza a las fichas para fusión manual.
  const allLeadsEver = list<Lead>("leads");
  const dupGroups = new Map<string, Lead[]>();
  for (const l of allLeadsEver) {
    if (!l.phone) continue;
    const key = normalizePhone(l.phone);
    if (!dupGroups.has(key)) dupGroups.set(key, []);
    dupGroups.get(key)!.push(l);
  }
  const realDupGroups = [...dupGroups.values()].filter((g) => g.length > 1);
  const dupRowCount = realDupGroups.reduce((sum, g) => sum + g.length, 0);
  const sinTelefonoNiNombre = allLeadsEver.filter((l) => !l.phone && !l.name).length;

  const stat = (n: number | string, label: string) => `<div class="stat"><b>${n}</b><span>${label}</span></div>`;
  const datePill = (k: DateFilterKey) => `<a href="/crm/informes?d=${k}" class="tag" style="text-decoration:none;${dateFilter === k ? "background:var(--accent);color:#fff" : ""}">${DATE_FILTER_LABEL[k]}</a>`;
  const pct = (n: number | null) => (n === null ? "sin datos" : `${n.toFixed(0)}%`);
  const body = `<h1>Informes</h1>
<p class="sub">Todo lo de abajo son conteos reales del periodo elegido -- nunca una cifra estimada. "Sin datos" significa que todavía no hay ningún caso real que medir, no un error.</p>
<div class="legend">${(["hoy", "ayer", "7dias", "30dias", "mes", "mes_anterior", "todo"] as DateFilterKey[]).map(datePill).join(" ")}</div>
<div class="stats">
${stat(leadsNuevos, "leads nuevos")}
${stat(leadsContactados, "leads contactados")}
${stat(leadsCalientes, "leads calientes")}
${stat(visitasConcertadas, "visitas concertadas")}
${stat(visitasRealizadas, "visitas realizadas")}
${stat(visitasNoPresentado, "no presentado")}
${stat(reservasCreadas, "reservas creadas")}
${stat(reservasConfirmadas, "reservas pagadas y verificadas")}
${stat(reservasCanceladas, "reservas canceladas")}
${stat(ventasCerradas, "ventas cerradas")}
${stat(ventasPerdidas.length, "ventas perdidas")}
${stat(tareasVencidas, "tareas vencidas")}
</div>
<div class="box"><h3 style="margin-top:0">Conversión del periodo</h3>
${funnelChart([{ label: "Leads", count: leadsNuevos }, { label: "Visitas", count: leadsConVisita }, { label: "Reservas", count: leadsConReserva }, { label: "Ventas", count: ventasCerradas }])}
<p>Lead → visita: <b>${pct(convLeadVisita)}</b> · Visita → reserva: <b>${pct(convVisitaReserva)}</b> · Reserva → venta: <b>${pct(convReservaVenta)}</b></p>
<p class="sub">Tiempo medio hasta el primer contacto humano (handoff real): ${avgFirstContactHours !== null ? `${avgFirstContactHours.toFixed(1)} horas` : "sin datos todavía"}</p>
</div>
<div class="box"><h3 style="margin-top:0">Coste real -- agente de voz</h3>
<p>Llamadas: <b>${voiceCalls.length}</b> · Coste total: <b>${voiceCostEur.toFixed(2)} $</b> · Coste por llamada: <b>${costePorLlamada !== null ? `${costePorLlamada.toFixed(2)} $` : "sin datos"}</b></p>
<p class="sub">WhatsApp, chat y correo todavía no tienen coste medido por canal -- no se muestra un número para no inventarlo.</p>
</div>
${ventasPerdidas.length > 0 ? `<div class="box"><h3 style="margin-top:0">Motivos de venta perdida</h3>${[...motivosPerdida.entries()].map(([m, n]) => `<p>${esc(m)}: <b>${n}</b></p>`).join("")}</div>` : ""}
<div class="box"><h3 style="margin-top:0">Leads por canal de primera captación</h3>${hBarChart([...porOrigen.entries()].sort((a, b) => b[1] - a[1]))}</div>
${ventasPorCanalConversion.size > 0 ? `<div class="box"><h3 style="margin-top:0">Ventas cerradas por canal de conversión (reserva)</h3>${hBarChart([...ventasPorCanalConversion.entries()].sort((a, b) => b[1] - a[1]))}</div>` : ""}
<div class="box"><h3 style="margin-top:0">Calidad de datos y duplicados (histórico completo, no solo el periodo)</h3>
<p>Grupos de teléfono duplicado: <b>${realDupGroups.length}</b> (${dupRowCount} fichas en total) · Sin teléfono ni nombre: <b>${sinTelefonoNiNombre}</b></p>
${realDupGroups.length > 0
  ? realDupGroups.map((g) => `<p class="sub">${g.map((l) => `<a class="link" href="/crm/clientes/${esc(l.id)}">${esc(leadDisplayName(l))}</a>`).join(" ↔ ")}</p>`).join("")
  : `<p class="sub">No hay duplicados de teléfono ahora mismo.</p>`}
</div>`;
  res.type("html").send(page("Informes", me(res), body, msgOf(req)));
});

// ---------- Equipo (solo administrador) ----------
crm.get("/equipo", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Esta sección es solo para el administrador");
  const users = listUsers();
  const body = `<h1>Usuarios</h1>
<p class="sub">Aquí das de alta a Ramón y a José, y cambias las contraseñas.</p>
<div class="box"><h3 style="margin-top:0">Dar de alta a alguien</h3>
<form method="post" action="/crm/equipo">
<div class="row"><div><label>Nombre</label><input name="nombre" required></div>
<div><label>Correo para entrar</label><input name="correo" type="email" required></div>
<div><label>Contraseña (mínimo 8)</label>${pwInput('name="clave" minlength="8" required', 'pw-alta')}</div>
<div><label>Puede…</label><select name="rol"><option value="equipo">Ver y trabajar (no confirma pagos)</option><option value="comercial">Comercial: confirma pagos y ventas</option><option value="admin">Todo, incluido el equipo</option></select></div></div>
<button class="btn ok" type="submit">Dar de alta</button></form></div>
${users.map((u) => `<div class="card"><div class="info"><h3>${esc(u.name)}</h3><p>${esc(u.email)} · ${esc(ROLE_NAME[u.role] ?? u.role)}</p>
<form method="post" action="/crm/equipo/${esc(u.id)}">
<label>Nueva contraseña</label>${pwInput('name="clave" minlength="8"', `pw-${esc(u.id)}`)}
<button class="btn light" type="submit" name="accion" value="clave">Cambiar contraseña</button>
${u.id !== me(res).id ? button("Quitar el acceso", "quitar", "danger") : ""}
</form></div></div>`).join("")}`;
  res.type("html").send(page("Usuarios", me(res), body, msgOf(req)));
});

crm.post("/equipo", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Solo el administrador");
  const email = String(req.body.correo ?? "").trim().toLowerCase();
  const clave = String(req.body.clave ?? "");
  if (clave.length < 8) return back(res, "/crm/equipo", "La contraseña tiene que tener al menos 8 caracteres");
  const users = listUsers();
  if (users.some((u) => u.email === email)) return back(res, "/crm/equipo", "Ese correo ya tiene acceso");
  users.push({
    id: crypto.randomUUID(),
    name: String(req.body.nombre ?? "").trim(),
    email,
    password_hash: hashPassword(clave),
    role: req.body.rol === "admin" ? "admin" : req.body.rol === "comercial" ? "comercial" : "equipo",
    created_at: now(),
  });
  saveUsers(users);
  back(res, "/crm/equipo", "Persona dada de alta");
});

crm.post("/equipo/:id", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Solo el administrador");
  const users = listUsers();
  const u = users.find((x) => x.id === req.params.id);
  if (!u) return back(res, "/crm/equipo", "No encuentro a esa persona");
  if (String(req.body.accion) === "quitar") {
    if (u.id === me(res).id) return back(res, "/crm/equipo", "No puedes quitarte el acceso a ti mismo");
    saveUsers(users.filter((x) => x.id !== u.id));
    return back(res, "/crm/equipo", "Acceso quitado");
  }
  const clave = String(req.body.clave ?? "");
  if (clave.length < 8) return back(res, "/crm/equipo", "La contraseña tiene que tener al menos 8 caracteres");
  u.password_hash = hashPassword(clave);
  saveUsers(users);
  back(res, "/crm/equipo", "Contraseña cambiada");
});

// ---------- Integraciones: Google (solo administrador) ----------
const GOOGLE_SCOPE_NAMES: Record<string, string> = {
  "https://www.googleapis.com/auth/gmail.send": "Enviar correo",
  "https://www.googleapis.com/auth/gmail.readonly": "Leer correo",
  "https://www.googleapis.com/auth/calendar": "Calendario completo",
};
type GoogleTest = { id: string; event_id: string; link: string; created_at: string };

// Hora local de Madrid de mañana, sin desfase: Google recibe la zona horaria aparte.
function tomorrowAt(hour: number, minutes: number): string {
  const day = new Date(Date.now() + 24 * 3600 * 1000).toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
  return `${day}T${String(hour).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
}
function onlyAdmin(res: express.Response): boolean {
  return me(res).role === "admin";
}

// Estadísticas reales de llamadas de voz (25/10/2026, factorizado al
// separar Integraciones de Asistentes) -- las usan ambas páginas: aquí
// solo para el estado de Miguel, en /crm/asistentes para el coste y la
// cola de calidad. Una sola lectura real, nunca dos fuentes distintas.
function voiceCallStats() {
  const recentCalls = readCollection<{
    channel: string;
    call_id?: string | null;
    from_number?: string | null;
    created_at: string;
    duration_ms: number | null;
    cost_cents: number | null;
    transfer_outcome?: string | null;
    custom_analysis_data?: { outcome?: string; issues_detected?: string };
    max_pause_sec?: number | null;
    needs_review?: boolean;
    summary?: string | null;
  }>("call_analyses").filter((c) => c.channel === "VOICE");
  const lastCall = recentCalls.length ? recentCalls[recentCalls.length - 1] : null;
  const totalCostEur = recentCalls.reduce((sum, c) => sum + (c.cost_cents ?? 0), 0) / 100;
  const escalatedCount = recentCalls.filter((c) => c.custom_analysis_data?.outcome === "escalado_a_persona").length;
  const transferRamon = recentCalls.filter((c) => c.transfer_outcome === "transferido_ramon").length;
  const transferJose = recentCalls.filter((c) => c.transfer_outcome === "transferido_jose").length;
  const transferNadie = recentCalls.filter((c) => c.transfer_outcome === "ninguno_respondio_registrado").length;
  return { recentCalls, lastCall, totalCostEur, escalatedCount, transferRamon, transferJose, transferNadie };
}

crm.get("/integraciones", (req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Esta sección es solo para el administrador");
  const st = googleStatus();
  const missing = googleConfigMissing();
  const test = readCollection<GoogleTest>("google_test_events")[0];
  const scopes = (st.scopes ?? "").split(" ").filter(Boolean);
  const scopesHtml = scopes.length
    ? `<ul>${scopes.map((s) => `<li>${esc(GOOGLE_SCOPE_NAMES[s] ?? s)}</li>`).join("")}</ul>`
    : "<p>Todavía no hay permisos concedidos.</p>";
  const config = missing.length
    ? `<div class="msg" style="background:#fdecea;border-color:#c62828">Falta en EasyPanel: ${esc(missing.join(", "))}. Añádelo y pulsa Implementar.</div>`
    : "";
  const connectButton = st.connected
    ? `<a class="btn light" href="/crm/integraciones/google/conectar">Reconectar Google</a>`
    : `<a class="btn ok" href="/crm/integraciones/google/conectar">Conectar Google</a>`;
  const disconnectButton = st.connected
    ? `<form method="post" action="/crm/integraciones/google/desconectar" style="display:inline"><button class="btn danger" type="submit" onclick="return confirm('¿Desconectar Google? Daniel dejará de enviar correos y no se podrá comprobar disponibilidad real para las visitas.')">Desconectar Google</button></form>`
    : "";
  const tests = st.connected
    ? `<div class="box"><h3 style="margin-top:0">Pruebas</h3>
<form method="post" action="/crm/integraciones/google/probar-gmail" style="display:inline"><button class="btn light" type="submit">Probar Gmail</button></form>
<form method="post" action="/crm/integraciones/google/probar-calendar" style="display:inline"><button class="btn light" type="submit">Probar Calendar</button></form>
${test ? `<p>Evento de prueba creado: <a href="${esc(test.link)}" target="_blank" rel="noopener">abrir en Google Calendar</a></p>
<form method="post" action="/crm/integraciones/google/borrar-prueba" style="display:inline"><button class="btn danger" type="submit">Borrar evento de prueba</button></form>` : ""}
</div>`
    : "";
  const emailSendOn = isEmailAutoSendEnabled();
  const emailModeBox = `<div class="box"><div style="display:flex;align-items:center;gap:10px;margin-bottom:2px">${statusBadge("C", emailSendOn ? "done" : "pending")}<div><h3 style="margin:0">Correo -- envío automático</h3>${statusPill(emailSendOn ? "Activado" : "Modo de prueba", emailSendOn ? "done" : "pending")}</div></div>
<p class="sub">${emailSendOn ? "Envía respuestas reales" : "Clasifica y redacta, pero no envía nada"}</p>
<form method="post" action="/crm/integraciones/correo/${emailSendOn ? "desactivar-envio" : "activar-envio"}" style="display:inline">
<button class="btn ${emailSendOn ? "danger" : "ok"}" type="submit" onclick="return confirm('${emailSendOn ? "¿Pasar a modo de prueba? El agente seguirá leyendo y redactando respuestas, pero ninguna saldrá de verdad -- se quedan en Pendientes para revisar." : "¿Activar el envío automático? Las respuestas que redacte el agente empezarán a salir de verdad."}')">${emailSendOn ? "Pasar a modo de prueba" : "Activar envío automático"}</button>
</form>
<p class="sub">En modo de prueba, cada correo se clasifica y se redacta igual que siempre -- solo cambia que la respuesta se queda como nota en Pendientes en vez de enviarse. Útil para probar cambios sin arriesgar un envío real.</p>
</div>`;
  const voiceOn = isVoiceAgentEnabled();
  const vs = voiceCallStats();
  const voiceBox = `<div class="box"><div style="display:flex;align-items:center;gap:10px;margin-bottom:2px">${statusBadge("M", voiceOn ? "done" : "pending")}<div><h3 style="margin:0">Teléfono -- agente de voz Miguel</h3>${statusPill(voiceOn ? "Respondiendo" : "Desactivado", voiceOn ? "done" : "pending")}</div></div>
<p class="sub">Número: +34 919 58 88 87${voiceOn ? "" : " -- suenan Ramón y José directamente"}</p>
<form method="post" action="/crm/integraciones/telefono/${voiceOn ? "desactivar" : "activar"}" style="display:inline">
<button class="btn ${voiceOn ? "danger" : "ok"}" type="submit" onclick="return confirm('${voiceOn ? "¿Desactivar a Miguel? Las llamadas nuevas sonarán directamente en los móviles de Ramón y José." : "¿Activar a Miguel? Volverá a responder él las llamadas nuevas."}')">${voiceOn ? "Desactivar a Miguel" : "Activar a Miguel"}</button>
</form>
<p class="sub">Esto NO toca el desvío de Yoigo -- solo decide si las llamadas que ya llegan al número de Twilio las contesta Miguel o van directas a Ramón/José.</p>
<p>Llamadas registradas: <strong>${vs.recentCalls.length}</strong> -- Última: <strong>${vs.lastCall ? esc(fmtDate(vs.lastCall.created_at)) : "ninguna todavía"}</strong></p>
<p>Escaladas a persona: <strong>${vs.escalatedCount}</strong> -- Coste estimado acumulado: <strong>${vs.totalCostEur.toFixed(2)} $</strong></p>
<p>Transferencias -- a Ramón: <strong>${vs.transferRamon}</strong> · a José: <strong>${vs.transferJose}</strong> · nadie respondió: <strong>${vs.transferNadie}</strong></p>
<p class="sub">El coste y las transferencias son los reales que reporta Retell al terminar cada llamada (sumado desde el 13/10/2026) -- no incluye llamadas anteriores a esa fecha, y no hay un evento en vivo por cada intento, solo el resultado final de la llamada.</p>
</div>`;
  // Lista lateral (21/10/2026, a petición real: "ponlas en un lado como el
  // crm de klikar") -- mismas cajas de siempre, reorganizadas en dos
  // columnas en vez de una sola lista larga de arriba a abajo.
  // "Agentes IA" y "Calidad de llamadas" se mudaron a /crm/asistentes
  // (25/10/2026, "hay integraciones que sobran" -- el encargo separa
  // "Asistentes: configuración y actividad de asistentes virtuales" de
  // "Integraciones: WhatsApp, correo, telefonía y calendario"; esto solo
  // reagrupa cajas ya reales que existían, no se pierde ni se inventa nada).
  const sideNav = `<nav class="side-nav">
<a href="#google">Google</a>
<a href="#correo">Correo</a>
<a href="#whatsapp">WhatsApp</a>
<a href="#telefono">Teléfono -- voz</a>
</nav>`;
  const body = `<h1>Integraciones</h1>
<p class="sub">Conexión con WhatsApp, correo, telefonía y calendario. La actividad de los asistentes vive en <a class="link" href="/crm/asistentes">Asistentes</a>.</p>
${config}
<div class="side-layout">
${sideNav}
<div class="side-content">
<div class="box" id="google"><div style="display:flex;align-items:center;gap:10px;margin-bottom:2px">${statusBadge("G", st.connected ? "done" : "urgent")}<div><h3 style="margin:0">Google</h3>${statusPill(st.connected ? "Conectado" : "No conectado", st.connected ? "done" : "urgent")}</div></div>
<p>Cuenta conectada: <strong>${esc(st.connected_email ?? (st.connected ? "(no leída)" : "ninguna"))}</strong></p>
${st.connected_at ? `<p>Conectada desde: ${esc(fmtDate(st.connected_at))}</p>` : ""}
<p>Permisos concedidos:</p>${scopesHtml}
<p>${connectButton} ${disconnectButton}</p>
</div>
${tests}
<div id="correo">${emailModeBox}</div>
<div id="whatsapp">${whatsappZernioBox(req)}</div>
<div id="telefono">${voiceBox}</div>
</div>
</div>`;
  res.type("html").send(page("Integraciones", me(res), body, msgOf(req)));
});

crm.get("/asistentes", (req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Esta sección es solo para el administrador");
  const vs = voiceCallStats();
  const emailSendOn = isEmailAutoSendEnabled();
  // Tarjetas de los 3 agentes (20/10/2026, mejora integral del CRM, sección
  // 15; separado de Integraciones el 25/10/2026): resumen por identidad,
  // reutilizando datos reales que ya se registran (leads, handoffs, tasks,
  // call_analyses) -- nunca una tarjeta visual sin datos detrás. El coste
  // solo es real para voz (Retell lo reporta); en WhatsApp/chat/correo se
  // dice honestamente que no hay seguimiento de coste por canal todavía.
  const allLeadsForAgents = list<Lead>("leads");
  const allHandoffsForAgents = list<Handoff>("handoffs");
  const allTasksForAgents = listTasks();
  // Último evento recibido por canal (25/10/2026, encargo de fiabilidad,
  // "panel de salud... último evento recibido"): del propio registro
  // crudo del canal (la llamada/mensaje/correo más reciente), no de
  // cuándo se tocó por última vez un lead -- es la señal real de si el
  // canal sigue recibiendo eventos de verdad.
  const lastVoiceEvent = vs.recentCalls.length ? vs.recentCalls[vs.recentCalls.length - 1].created_at : null;
  const lastWaEvent = list<WhatsappMessage>("whatsapp_inbox").sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.created_at ?? null;
  const lastMailEvent = list<InboxMail>("email_inbox").sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.created_at ?? null;
  function agentCard(name: string, funcion: string, estado: string, canales: string, channelKeys: string[], lastEvent: string | null, active: boolean): string {
    const clientes = allLeadsForAgents.filter((l) => l.channel && channelKeys.includes(l.channel)).length;
    const handoffsCount = allHandoffsForAgents.filter((h) => h.channel && channelKeys.includes(h.channel)).length;
    const tareasPendientes = allTasksForAgents.filter((t) => t.status === "pendiente" && t.channel && channelKeys.includes(t.channel)).length;
    const ultima = allLeadsForAgents
      .filter((l) => l.channel && channelKeys.includes(l.channel))
      .sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at))[0];
    const tone = active ? "done" : "pending";
    return `<div class="box"><div style="display:flex;align-items:center;gap:10px;margin-bottom:2px">${statusBadge(name.charAt(0), tone)}<div><h3 style="margin:0">${esc(name)}</h3>${statusPill(estado, tone)}</div></div>
<p class="sub">${esc(funcion)}</p>
<p>Canales: ${esc(canales)}</p>
<p>Último evento recibido: <strong>${lastEvent ? esc(fmtDate(lastEvent)) : "ninguno todavía"}</strong></p>
<p>Clientes atendidos: <strong>${clientes}</strong> · Avisos generados: <strong>${handoffsCount}</strong> · Tareas pendientes: <strong>${tareasPendientes}</strong></p>
<p class="sub">Última actividad: ${ultima ? esc(fmtDate(ultima.updated_at ?? ultima.created_at)) : "ninguna todavía"}</p>
</div>`;
  }
  const agentCards = `<h2 style="margin-top:0">Agentes IA</h2>
<div class="row">
${agentCard("Miguel -- voz", "Atiende llamadas al teléfono del negocio.", isVoiceAgentEnabled() ? "Respondiendo" : "Pausado", "Teléfono", ["VOICE"], lastVoiceEvent, isVoiceAgentEnabled())}
${agentCard("Carolina -- WhatsApp y chat", "Atiende WhatsApp, Messenger de Facebook y el chat web.", isWhatsappZernioAgentEnabled() ? "Respondiendo en WhatsApp" : "Pausada en WhatsApp", "WhatsApp, Messenger, Chat web", ["WHATSAPP", "CHAT", "FACEBOOK"], lastWaEvent, isWhatsappZernioAgentEnabled())}
${agentCard("Daniel -- correo", "Lee, clasifica y responde el correo comercial.", emailSendOn ? "Envío automático activado" : "Modo de prueba -- redacta, no envía", "Correo electrónico", ["EMAIL"], lastMailEvent, emailSendOn)}
</div>
<p class="sub">Coste real acumulado -- solo disponible para voz (Retell lo reporta por llamada): ${vs.totalCostEur.toFixed(2)} $. WhatsApp/chat/correo todavía no tienen seguimiento de coste por canal.</p>`;
  // Calidad de llamadas (15/10/2026, el "cerebro" pedido): cada llamada real
  // queda marcada sola (ver tools/webhooks.ts) si tuvo una pausa larga, un
  // fallo o un incidente de seguridad -- así se ve de un vistazo cuáles
  // merece la pena escuchar, en vez de pedir la API de Retell cada vez.
  const toReview = vs.recentCalls.filter((c) => c.needs_review).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 10);
  const qualityBox = `<div class="box"><h3 style="margin-top:0">Calidad de llamadas (automático)</h3>
<p class="sub">Cada llamada real se revisa sola al terminar -- aquí aparecen las que tuvieron una pausa larga (más de 6s), no salieron bien, o tuvieron algún incidente. Útil para detectar fallos reales sin tener que escuchar todas.</p>
${toReview.length === 0
  ? `<p>Ninguna llamada marcada para revisar por ahora.</p>`
  : toReview.map((c) => `<p>${esc(fmtDate(c.created_at))} -- ${esc(c.from_number ?? "número desconocido")}${c.max_pause_sec ? ` -- pausa de ${c.max_pause_sec.toFixed(1)}s` : ""}${c.custom_analysis_data?.issues_detected && c.custom_analysis_data.issues_detected !== "ninguno" ? ` -- ${esc(c.custom_analysis_data.issues_detected)}` : ""}${c.summary ? `<br><span class="sub">${esc(c.summary)}</span>` : ""}</p>`).join("")}
</div>`;
  const body = `<h1>Asistentes</h1>
<p class="sub">Configuración y actividad real de los 3 asistentes de IA. La conexión técnica (WhatsApp/correo/teléfono) vive en <a class="link" href="/crm/integraciones">Integraciones</a>.</p>
${agentCards}
${qualityBox}`;
  res.type("html").send(page("Asistentes", me(res), body, msgOf(req)));
});

// Inicia el consentimiento de Google desde el propio CRM (sin cabeceras ni curl).
crm.get("/integraciones/google/conectar", (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  try {
    res.redirect(createAuthUrl());
  } catch (err) {
    back(res, "/crm/integraciones", describeGoogleError(err));
  }
});

crm.post("/integraciones/correo/activar-envio", (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  setEmailAutoSendEnabled(true, me(res).email);
  back(res, "/crm/integraciones", "Envío automático de correo activado.");
});

crm.post("/integraciones/correo/desactivar-envio", (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  setEmailAutoSendEnabled(false, me(res).email);
  back(res, "/crm/integraciones", "Modo de prueba activado -- el correo ya no envía respuestas reales.");
});

// WhatsApp vía Zernio (18/10/2026, para no depender de la verificación de
// negocio de Meta): el accountId que devuelve el Embedded Signup se muestra
// aquí para copiarlo a ZERNIO_WHATSAPP_ACCOUNT_ID en EasyPanel -- es config
// estática, igual de sitio que el resto de variables ZERNIO_*, no un token
// que cambie solo como los de Google.
function whatsappZernioBox(req: express.Request): string {
  const configured = isZernioWhatsappConfigured();
  const callbackAccountId = typeof req.query.wa_account_id === "string" ? req.query.wa_account_id : null;
  const callbackError = typeof req.query.error === "string" ? req.query.error : null;
  const result = callbackAccountId
    ? `<div class="msg" style="background:#eaf6ea;border-color:#2e9e55">Cuenta conectada en Zernio: <code>${esc(callbackAccountId)}</code>. Copia este valor en <code>ZERNIO_WHATSAPP_ACCOUNT_ID</code> (EasyPanel) y vuelve a implementar para activarlo.</div>`
    : callbackError
      ? `<div class="msg" style="background:#fdecea;border-color:#c62828">Zernio no pudo conectar el número: ${esc(callbackError)}</div>`
      : "";
  const agentOn = isWhatsappZernioAgentEnabled();
  const agentToggle = configured
    ? `<p>Carolina en este canal: <strong>${agentOn ? "Respondiendo" : "Pausada -- los mensajes avisan al equipo, nadie los contesta solo"}</strong></p>
<form method="post" action="/crm/integraciones/whatsapp/agente/${agentOn ? "desactivar" : "activar"}" style="display:inline">
<button class="btn ${agentOn ? "danger" : "ok"}" type="submit" onclick="return confirm('${agentOn ? "¿Pausar a Carolina en WhatsApp? Los mensajes nuevos seguirán avisando al equipo, pero nadie los contestará solo." : "¿Activar a Carolina en WhatsApp? Empezará a contestar ella sola los mensajes nuevos de este número."}')">${agentOn ? "Pausar a Carolina aquí" : "Activar a Carolina aquí"}</button>
</form>`
    : "";
  const waTone = !configured ? "off" : agentOn ? "done" : "pending";
  const waLabel = !configured ? "No configurado" : agentOn ? "Respondiendo" : "Pausada";
  return `<div class="box"><div style="display:flex;align-items:center;gap:10px;margin-bottom:2px">${statusBadge("W", waTone)}<div><h3 style="margin:0">WhatsApp -- vía Zernio</h3>${statusPill(waLabel, waTone)}</div></div>
<p class="sub">Alternativa a la WhatsApp Cloud API directa de Meta: conecta el número con un clic (Embedded Signup gestionado por Zernio), sin el proceso de verificación de negocio de Meta.</p>
${result}
<p><a class="btn ${configured ? "light" : "ok"}" href="/crm/integraciones/whatsapp/conectar">${configured ? "Reconectar" : "Conectar"} WhatsApp con Zernio</a></p>
<p class="sub">Requiere <code>ZERNIO_API_KEY</code> y <code>ZERNIO_PROFILE_ID</code> ya puestos en el servidor.</p>
${agentToggle}
</div>`;
}

crm.get("/integraciones/whatsapp/conectar", async (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  const redirectUrl = `${PUBLIC_BASE_URL}/crm/integraciones/whatsapp/callback`;
  const result = await getWhatsappConnectUrl(redirectUrl);
  if (!result.ok) return back(res, "/crm/integraciones", `No se pudo iniciar la conexión con Zernio: ${result.error}`);
  res.redirect(result.authUrl);
});

// Zernio vuelve aquí tras el Embedded Signup con accountId (éxito) o error
// en la query string -- lo mostramos para que el admin lo copie a la
// variable de entorno, no hay sitio en disco donde guardarlo solo.
crm.get("/integraciones/whatsapp/callback", (req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  const accountId = typeof req.query.accountId === "string" ? req.query.accountId : null;
  const error = typeof req.query.error === "string" ? req.query.error : null;
  const qs = accountId ? `wa_account_id=${encodeURIComponent(accountId)}` : error ? `error=${encodeURIComponent(error)}` : "";
  res.redirect(`/crm/integraciones${qs ? `?${qs}` : ""}`);
});

crm.post("/integraciones/whatsapp/agente/activar", (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  setWhatsappZernioAgentEnabled(true, me(res).email);
  back(res, "/crm/integraciones", "Carolina activada en WhatsApp -- ya contesta ella sola los mensajes nuevos de este número.");
});

crm.post("/integraciones/whatsapp/agente/desactivar", (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  setWhatsappZernioAgentEnabled(false, me(res).email);
  back(res, "/crm/integraciones", "Carolina pausada en WhatsApp -- los mensajes nuevos avisan al equipo, nadie los contesta solo.");
});

crm.post("/integraciones/telefono/activar", (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  setVoiceAgentEnabled(true, me(res).email);
  back(res, "/crm/integraciones", "Miguel activado -- vuelve a contestar las llamadas nuevas.");
});

crm.post("/integraciones/telefono/desactivar", (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  setVoiceAgentEnabled(false, me(res).email);
  back(res, "/crm/integraciones", "Miguel desactivado -- las llamadas nuevas sonarán en los móviles de Ramón y José.");
});

crm.post("/integraciones/google/desconectar", async (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  try {
    await disconnectGoogle();
    writeCollection("google_test_events", []);
    back(res, "/crm/integraciones", "Google desconectado");
  } catch (err) {
    back(res, "/crm/integraciones", describeGoogleError(err));
  }
});

crm.post("/integraciones/google/probar-gmail", async (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  const to = googleStatus().connected_email;
  if (!to) return back(res, "/crm/integraciones", "No sé a qué cuenta enviar la prueba. Reconecta Google.");
  try {
    await sendGmail(to, "Prueba de conexión del CRM", `Este correo confirma que el CRM de Automóviles Lucero puede enviar correo desde ${to}. Puedes borrarlo.`);
    back(res, "/crm/integraciones", `Correo de prueba enviado a ${to}`);
  } catch (err) {
    console.error("[google] prueba gmail:", err);
    back(res, "/crm/integraciones", `Gmail: ${describeGoogleError(err)}`);
  }
});

crm.post("/integraciones/google/probar-calendar", async (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  try {
    const event = await calendarCreateEvent({
      summary: "PRUEBA CRM - borrar",
      description: "Evento de prueba creado desde el CRM para comprobar Google Calendar. Se borra con el botón del CRM.",
      startLocal: tomorrowAt(10, 0),
      endLocal: tomorrowAt(10, 30),
    });
    writeCollection<GoogleTest>("google_test_events", [
      { id: crypto.randomUUID(), event_id: event.id, link: event.htmlLink, created_at: now() },
    ]);
    back(res, "/crm/integraciones", "Evento de prueba creado para mañana a las 10:00");
  } catch (err) {
    console.error("[google] prueba calendar:", err);
    back(res, "/crm/integraciones", `Calendar: ${describeGoogleError(err)}`);
  }
});

crm.post("/integraciones/google/borrar-prueba", async (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  const test = readCollection<GoogleTest>("google_test_events")[0];
  if (!test) return back(res, "/crm/integraciones", "No hay evento de prueba que borrar");
  try {
    await calendarDeleteEvent(test.event_id);
  } catch (err) {
    // Si alguien ya lo borró a mano en Google, no hay nada que hacer: limpiamos el registro.
    const gone = err instanceof Error && /google_api_(404|410)/.test(err.message);
    if (!gone) return back(res, "/crm/integraciones", `Calendar: ${describeGoogleError(err)}`);
  }
  writeCollection("google_test_events", []);
  back(res, "/crm/integraciones", "Evento de prueba borrado");
});

// ---------- Avisos para llamar (cualquier usuario del CRM) ----------
type AlertRow = { id: string; kind: string; lead_phone: string | null; name: string | null; reason: string };
crm.post("/alertas/:id", (req, res) => {
  const accion = String(req.body.accion ?? "atendido");
  if (accion === "eliminar") {
    if (me(res).role !== "admin") return back(res, "/crm", "Solo el administrador puede eliminar alertas");
    const alert = list<AlertRow>("alerts").find((a) => a.id === req.params.id);
    if (!alert) return back(res, "/crm", "No encuentro esa alerta");
    if (!deleteAlert(req.params.id)) return back(res, "/crm", "No encuentro esa alerta");
    moveToTrash("alerts", alert, `Alerta: ${alert.reason} (${alert.name ?? alert.lead_phone ?? "sin contacto"})`, me(res).email);
    return back(res, "/crm", "Alerta movida a la papelera");
  }
  if (!markAlertDone(req.params.id)) return back(res, "/crm", "No encuentro ese aviso");
  back(res, "/crm", "Aviso marcado como atendido");
});

// Borrado masivo de alertas (18/10/2026, "el borrar masivo lo quiero en
// todas las secciones") -- mismo patrón que el individual: se quita de
// alerts y se guarda en la papelera, nunca se pierde de verdad.
crm.post("/alertas-masivo", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Solo el administrador puede eliminar alertas");
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  if (ids.length === 0) return back(res, "/crm", "No seleccionaste ninguna alerta");
  const rows = list<AlertRow>("alerts");
  const targets = rows.filter((a) => ids.includes(a.id));
  for (const a of targets) {
    if (deleteAlert(a.id)) moveToTrash("alerts", a, `Alerta: ${a.reason} (${a.name ?? a.lead_phone ?? "sin contacto"})`, me(res).email);
  }
  back(res, "/crm", targets.length === 0 ? "No había nada que hacer" : `${targets.length} alerta(s) movida(s) a la papelera`);
});

// ---------- Papelera (solo administrador) ----------
const TRASH_LABELS: Record<string, string> = {
  reservations: "Reserva",
  appointments: "Visita",
  handoffs: "Aviso",
  alerts: "Alerta",
  leads: "Cliente",
  email_inbox: "Correo",
  whatsapp_inbox: "WhatsApp",
  call_analyses: "Llamada",
};

crm.get("/papelera", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Esta sección es solo para el administrador");
  const items = listTrash();
  const bulk = items.length > 0
    ? `<form id="papelera-bulk" method="post" action="/crm/papelera-masivo"></form>
<div class="bulkbar">
<label><input class="msgsel" type="checkbox" onchange="toggleAllMsgs(this,'ids')"> Seleccionar todos (${items.length})</label>
<button class="btn ok" type="submit" form="papelera-bulk" name="accion" value="restaurar_seleccionados">Restaurar seleccionados</button>
<button class="btn danger" type="submit" form="papelera-bulk" name="accion" value="eliminar_seleccionados" onclick="return confirm('¿Eliminar para siempre los seleccionados? Ya no se podrán recuperar.')">Eliminar definitivamente los seleccionados</button>
</div>`
    : "";
  const body = `<h1>Papelera</h1>
<p class="sub">Aquí quedan las reservas, visitas, avisos y alertas que se eliminaron -- nada se borra para siempre hasta que lo confirmes aquí.</p>
${bulk}
${items.length === 0 ? `<div class="empty">La papelera está vacía.</div>` : items.map((t) => `<div class="card" style="position:relative"><div class="info">
${simpleCheckbox("papelera-bulk", t.id)}
<h3>${esc(t.label)}</h3>
<p><span class="tag">${esc(TRASH_LABELS[t.collection] ?? t.collection)}</span></p>
<p>Eliminado por ${esc(t.deleted_by)} el ${esc(fmtDate(t.deleted_at))}</p>
<form method="post" action="/crm/papelera/${esc(t.id)}">
<button class="btn ok" type="submit" name="accion" value="restaurar">Restaurar</button>
<button class="btn danger" type="submit" name="accion" value="eliminar" onclick="return confirm('¿Eliminar esto para siempre? Ya no se podrá recuperar.')">Eliminar definitivamente</button>
</form>
</div></div>`).join("")}`;
  res.type("html").send(page("Papelera", me(res), body, msgOf(req)));
});

crm.post("/papelera/:id", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Solo el administrador puede gestionar la papelera");
  const accion = String(req.body.accion ?? "");
  if (accion === "restaurar") {
    if (!restoreFromTrash(req.params.id)) return back(res, "/crm/papelera", "No encuentro eso en la papelera");
    return back(res, "/crm/papelera", "Restaurado");
  }
  if (accion === "eliminar") {
    if (!purgeFromTrash(req.params.id)) return back(res, "/crm/papelera", "No encuentro eso en la papelera");
    return back(res, "/crm/papelera", "Eliminado para siempre");
  }
  back(res, "/crm/papelera", "No entendí esa acción");
});

// Acciones masivas de Papelera (18/10/2026, "el borrar masivo lo quiero en
// todas las secciones") -- restaurar o eliminar definitivamente varios a la
// vez, mismas reglas que una por una.
crm.post("/papelera-masivo", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Solo el administrador puede gestionar la papelera");
  const accion = String(req.body.accion ?? "");
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  if (ids.length === 0) return back(res, "/crm/papelera", "No seleccionaste nada");
  let done = 0;
  for (const id of ids) {
    if (accion === "restaurar_seleccionados") {
      if (restoreFromTrash(id)) done++;
    } else if (accion === "eliminar_seleccionados") {
      if (purgeFromTrash(id)) done++;
    }
  }
  back(res, "/crm/papelera", done === 0 ? "No había nada que hacer" : accion === "restaurar_seleccionados" ? `${done} elemento(s) restaurado(s)` : `${done} elemento(s) eliminado(s) para siempre`);
});

// ---------- Lucero Studio AI (16/10/2026) ----------
// Módulo independiente: si Higgsfield falla, no afecta a Miguel, al chat ni
// al resto del CRM. Fotos y vídeos se suben/descargan al mismo volumen
// persistente que el resto de datos del negocio.
const studioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const STUDIO_STATUS_TEXT: Record<string, string> = {
  submitted: "Enviado, esperando a Higgsfield",
  in_progress: "Generando…",
  completed: "Listo",
  failed: "Falló",
  nsfw: "Rechazado por contenido",
  canceled: "Cancelado",
  rejected_budget: "No enviado: se pasaría del tope mensual",
  rejected_concurrency: "No enviado: demasiadas generaciones a la vez, espera a que termine alguna",
};

const STUDIO_RIBBON_COLOR: Record<string, string> = {
  completed: "#2e9e55",
  submitted: "#d9a22b",
  in_progress: "#d9a22b",
  failed: "#b3261e",
  nsfw: "#b3261e",
  canceled: "#9aa1ad",
  rejected_budget: "#b3261e",
  rejected_concurrency: "#b3261e",
};

function studioJobCard(j: StudioJob, zernioAccounts: ZernioAccount[] = []): string {
  const template = findTemplate(j.template_id);
  const tone = j.status === "completed" ? "done" : j.status === "submitted" || j.status === "in_progress" ? "pending" : j.status === "canceled" ? "off" : "urgent";
  const outputs = j.output_paths
    .map((p) => {
      const src = `/crm/studio/archivo/${esc(p)}`;
      const media = p.endsWith(".mp4")
        ? `<video controls style="width:100%;border-radius:12px;display:block" src="${src}"></video>`
        : `<img style="width:100%;border-radius:12px;display:block" src="${src}">`;
      return `<div style="margin:8px 0">${media}<a class="btn light" href="${src}" download style="margin-top:6px;width:100%;text-align:center">⬇️ Descargar</a></div>`;
    })
    .join("");
  const publishBlock =
    j.status === "completed" && j.output_paths.length > 0 && zernioAccounts.length > 0
      ? `<form method="post" action="/crm/studio/publicar" style="margin-top:10px">
<input type="hidden" name="job_id" value="${esc(j.id)}">
<label>Publicar en</label>
<select name="account_id">${zernioAccounts.map((a) => `<option value="${esc(a.id)}">${esc(String(a.platform))} (${esc(a.id)})</option>`).join("")}</select>
<input name="caption" placeholder="Texto de la publicación" value="${esc(j.vehicle_label)}">
<button class="btn ok" type="submit">📣 Publicar en redes</button>
</form>`
      : "";
  const engine = j.engine_id ? (template?.kind === "image" ? findImageEngine(j.engine_id) : findVideoEngine(j.engine_id)) : undefined;
  const style = j.style_id ? findVideoStyle(j.style_id) : undefined;
  const detailTags = [
    engine ? `<span class="tag">${engine.icon} ${esc(engine.label)}</span>` : "",
    style ? `<span class="tag">${style.icon} ${esc(style.label)}</span>` : "",
    j.duration_sec ? `<span class="tag">${j.duration_sec}s</span>` : "",
    j.aspect_ratio ? `<span class="tag">${esc(j.aspect_ratio)}</span>` : "",
  ].join("");
  const ribbonColor = STUDIO_RIBBON_COLOR[j.status] ?? "#9aa1ad";
  return `<div class="card ${tone}"><div class="info">
<span class="studio-ribbon" style="background:${ribbonColor}">${esc(STUDIO_STATUS_TEXT[j.status] ?? j.status)}</span>
<h3>${template ? `${template.icon} ` : ""}${esc(template?.label ?? j.template_id)} · ${esc(j.vehicle_label)}</h3>
<p><span class="tag">~${j.estimated_cost_eur.toFixed(2)} €</span>${detailTags}</p>
<p>Pedido por ${esc(j.created_by)} el ${esc(fmtDate(j.created_at))}</p>
${j.manual_prompt ? `<p>Pedido extra: "${esc(j.manual_prompt)}"</p>` : ""}
${j.error && j.status !== "completed" ? `<p>${esc(j.error)}</p>` : ""}
${outputs}
${publishBlock}
</div></div>`;
}

crm.get("/studio", async (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Esta sección es solo para administradores");
  const jobs = listStudioJobs();
  const active = jobs.filter((j) => j.status === "submitted" || j.status === "in_progress");
  await Promise.all(active.map((j) => pollStudioJob(j.id)));
  const fresh = listStudioJobs();
  const budget = budgetInfo();

  if (!isHiggsfieldConnected()) {
    const body = `<h1>Studio IA</h1>
<p class="sub">Genera vídeos e imágenes publicitarias de los coches con IA.</p>
<div class="todo"><h2 style="margin-top:0">Falta conectar Higgsfield</h2><p>Todavía no hay una clave de API de Higgsfield puesta en el servidor. Avisa al administrador para que la añada antes de poder generar nada.</p></div>`;
    return res.type("html").send(page("Studio IA", me(res), body, msgOf(req)));
  }

  const pickCard = (kindClass: string, name: string, value: string, icon: string, label: string, desc: string, checked: boolean, required = false) =>
    `<label class="pick-card ${kindClass}"><input type="radio" name="${name}" value="${esc(value)}" ${required ? "required" : ""} ${checked ? "checked" : ""}>
<span class="pick-icon-badge">${icon}</span><span class="pick-label">${esc(label)}</span>${desc ? `<p class="pick-desc">${esc(desc)}</p>` : ""}</label>`;

  const videoTemplateCards = STUDIO_TEMPLATES.filter((t) => t.kind === "video")
    .map((t, i) => pickCard("kind-video", "template_id", t.id, t.icon, t.label, t.description, i === 0, true))
    .join("");
  const imageTemplateCards = STUDIO_TEMPLATES.filter((t) => t.kind === "image")
    .map((t) => pickCard("kind-image", "template_id", t.id, t.icon, t.label, t.description, false))
    .join("");
  const vehicleOptions = currentVehicles()
    .map((v) => `<option value="${esc(v.id)}">${esc(vehicleName(v.id))}</option>`)
    .join("");
  const videoEngineCards = VIDEO_ENGINES.map((e, i) =>
    pickCard("kind-tune", "video_engine_id", e.id, e.icon, e.label, `~${e.pricePerSecondEur.toFixed(3)} €/s · ${e.description}`, i === 0),
  ).join("");
  const imageEngineCards = IMAGE_ENGINES.map((e, i) =>
    pickCard("kind-tune", "image_engine_id", e.id, e.icon, e.label, `~${e.pricePerImageEur.toFixed(3)} €/imagen · ${e.description}`, i === 0),
  ).join("");
  const styleCards = VIDEO_STYLES.map((s, i) => pickCard("kind-tune", "style_id", s.id, s.icon, s.label, s.description, i === 0)).join("");
  const durationCards =
    pickCard("kind-tune", "duration_choice", "corta", "⏱️", "Corta", "", true) + pickCard("kind-tune", "duration_choice", "larga", "⏳", "Larga", "", false);
  const aspectCards = IMAGE_ASPECT_RATIOS.map((r, i) => pickCard("kind-tune", "aspect_ratio", r.id, r.icon, r.label, "", i === 0)).join("");

  const pendingJobs = fresh.filter((j) => j.status === "submitted" || j.status === "in_progress");
  const doneJobs = fresh.filter((j) => j.status !== "submitted" && j.status !== "in_progress");
  const spentRatio = budget.monthlyBudgetEur > 0 ? budget.spentEur / budget.monthlyBudgetEur : 0;
  const spentColor = spentRatio >= 1 ? "#b3261e" : spentRatio >= 0.8 ? "#d9822b" : "#2e9e55";

  const zernioAccounts = isZernioConnected() ? await listZernioAccounts() : { ok: false as const, error: "zernio_no_configurado" };
  const accounts = zernioAccounts.ok ? zernioAccounts.accounts : [];
  const zernioNotice = isZernioConnected()
    ? !zernioAccounts.ok
      ? `<p class="sub">⚠️ No se pudo conectar con Zernio: ${esc(zernioAccounts.error)}</p>`
      : accounts.length === 0
        ? `<p class="sub">⚠️ Zernio está conectado pero no hay ninguna cuenta de red social enlazada todavía (hazlo desde el panel de Zernio).</p>`
        : ""
    : "";

  const body = `<h1>Studio IA</h1>
<p class="sub">Genera vídeos e imágenes publicitarias de los coches con IA (Higgsfield). Los resultados aparecen abajo del todo, en "Resultados" -- ahí se ven y se descargan.</p>
<div class="studio-stats">
<div class="stat" style="border-left-color:${spentColor}"><b>${budget.spentEur.toFixed(2)} €</b><span>gastado este mes (tope ${budget.monthlyBudgetEur} €)</span></div>
<div class="stat" style="border-left-color:#2563eb"><b>${budget.activeNow} / ${budget.maxConcurrent}</b><span>generando ahora mismo</span></div>
</div>
<form method="post" action="/crm/studio/generar" enctype="multipart/form-data">

<div class="studio-section sec-video">
<h2>🎬 Plantillas de vídeo</h2>
<p class="sub">Necesitan la foto real del coche. La cámara se mueve sola según la plantilla.</p>
<div class="pick-grid">${videoTemplateCards}</div>
</div>

<div class="studio-section sec-image">
<h2>🖼️ Plantillas de imagen</h2>
<p class="sub">No necesitan foto -- la IA genera la escena entera a partir del texto.</p>
<div class="pick-grid">${imageTemplateCards}</div>
</div>

<div class="box">
<label>Coche (del stock)</label>
<select name="vehicle_id"><option value="">-- o escríbelo abajo a mano --</option>${vehicleOptions}</select>
<label>O escribe el coche a mano (si no está en el stock)</label>
<input name="vehicle_label_manual" placeholder="Ej: Peugeot 3008 2020">
<label>Detalle extra (solo para "Temporada / evento": qué ambiente quieres)</label>
<input name="extra" placeholder="Ej: Navidad, verano en la playa...">
<label>Foto real del coche (obligatoria en las plantillas de vídeo)</label>
<input type="file" name="foto" accept="image/*">
</div>

<div class="studio-section sec-tune">
<h2>⚙️ Cómo lo quieres</h2>
<p class="sub">Precios reales publicados por Higgsfield (algunos son precio "desde": la factura real puede ser algo mayor según duración/resolución). Estas opciones solo cambian algo según el tipo de plantilla que hayas elegido arriba.</p>
<label>Motor de vídeo</label>
<div class="pick-grid compact">${videoEngineCards}</div>
<label>Estilo de vídeo</label>
<div class="pick-grid compact">${styleCards}</div>
<label>Duración de vídeo</label>
<div class="pick-grid compact">${durationCards}</div>
<label>Motor de imagen</label>
<div class="pick-grid compact">${imageEngineCards}</div>
<label>Formato de imagen</label>
<div class="pick-grid compact">${aspectCards}</div>
<label>¿Algo más en concreto que quieras pedir? (opcional -- se añade a lo que ya genera la plantilla, no lo sustituye)</label>
<textarea name="manual_prompt" rows="3" placeholder="Ej: que el cielo esté nublado, que la cámara empiece desde más abajo..."></textarea>
</div>

<button class="btn ok" type="submit" style="font-size:24px;padding:18px 28px">✨ Generar</button>
</form>

${zernioNotice}
<h2>⏳ En curso</h2>${pendingJobs.length === 0 ? `<div class="empty">Nada generándose ahora mismo.</div>` : `<div class="gallery">${pendingJobs.map((j) => studioJobCard(j, accounts)).join("")}</div>`}
<h2>🎞️ Resultados</h2>${doneJobs.length === 0 ? `<div class="empty">Todavía no has generado nada. En cuanto generes algo, aparecerá aquí -- se puede ver y descargar directamente desde esta página.</div>` : `<div class="gallery">${doneJobs.map((j) => studioJobCard(j, accounts)).join("")}</div>`}`;
  res.type("html").send(page("Studio IA", me(res), body, msgOf(req)));
});

crm.post("/studio/generar", studioUpload.single("foto"), async (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Esta sección es solo para administradores");
  const templateId = String(req.body.template_id ?? "");
  const template = findTemplate(templateId);
  if (!template) return back(res, "/crm/studio", "Elige una plantilla válida");
  const vehicleId = String(req.body.vehicle_id ?? "").trim();
  const manual = String(req.body.vehicle_label_manual ?? "").trim();
  const vehicleLabel = vehicleId ? vehicleName(vehicleId) : manual;
  if (!vehicleLabel) return back(res, "/crm/studio", "Dime qué coche es: elígelo del stock o escríbelo a mano");
  if (template.needsPhoto && !req.file) return back(res, "/crm/studio", `La plantilla "${template.label}" necesita que subas antes la foto real del coche`);

  const photo = req.file ? saveUploadedPhoto(req.file.buffer, req.file.originalname) : null;
  const extra = String(req.body.extra ?? "").trim() || undefined;
  const manualPrompt = String(req.body.manual_prompt ?? "").trim() || undefined;
  const engineId = String((template.kind === "video" ? req.body.video_engine_id : req.body.image_engine_id) ?? "").trim() || undefined;
  const styleId = String(req.body.style_id ?? "").trim() || undefined;
  const durationChoice = req.body.duration_choice === "larga" ? "larga" : "corta";
  const aspectRatio = String(req.body.aspect_ratio ?? "").trim() || undefined;
  const result = await createStudioJob({ templateId, vehicleLabel, extra, manualPrompt, engineId, styleId, durationChoice, aspectRatio, photo, createdBy: me(res).email });
  if (!result.ok) return back(res, "/crm/studio", `No se pudo crear el encargo: ${result.error}`);
  if (result.job.status === "rejected_budget" || result.job.status === "rejected_concurrency" || result.job.status === "failed") {
    return back(res, "/crm/studio", result.job.error ?? "No se pudo enviar el encargo");
  }
  back(res, "/crm/studio", "Encargo enviado a Higgsfield. Tardará un rato -- vuelve a esta página para ver el resultado.");
});

// Publica un resultado ya generado del Studio en una red social conectada
// vía Zernio. Solo admin, igual que el resto del Studio -- gasta cuota de
// publicación real y queda visible en público, nunca se expone al agente.
crm.post("/studio/publicar", async (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Esta sección es solo para administradores");
  if (!isZernioConnected()) return back(res, "/crm/studio", "Zernio no está configurado en el servidor");
  const jobId = String(req.body.job_id ?? "");
  const job = getStudioJob(jobId);
  if (!job) return back(res, "/crm/studio", "Encargo no encontrado");
  if (job.status !== "completed" || job.output_paths.length === 0) return back(res, "/crm/studio", "Este encargo todavía no tiene resultado para publicar");

  const accountId = String(req.body.account_id ?? "").trim();
  if (!accountId) return back(res, "/crm/studio", "Elige una cuenta de destino");
  const accountsResult = await listZernioAccounts();
  const account = accountsResult.ok ? accountsResult.accounts.find((a) => a.id === accountId) : undefined;
  if (!account) return back(res, "/crm/studio", "Esa cuenta ya no está disponible en Zernio");

  const caption = String(req.body.caption ?? "").trim() || job.vehicle_label;
  const mediaUrls = job.output_paths.map((p) => `${PUBLIC_BASE_URL}/crm/studio/archivo/${p}`);
  const result = await publishZernioPost({
    content: caption,
    mediaUrls,
    platforms: [{ platform: String(account.platform), accountId }],
    publishNow: true,
  });
  if (!result.ok) return back(res, "/crm/studio", `No se pudo publicar: ${result.error}`);
  back(res, "/crm/studio", `Publicado en ${String(account.platform)} (estado: ${result.status}).`);
});

// Ruta pública (sin sesión, ver excepción más arriba): Higgsfield descarga
// desde aquí la foto que se sube, y aquí mismo se ven/descargan los
// resultados ya generados. Solo sirve archivos dentro de las dos carpetas
// de Studio, nunca cualquier ruta del volumen de datos.
crm.get("/studio/archivo/*", (req, res) => {
  const rel = String((req.params as Record<string, string>)[0] ?? "");
  const safe = path.normalize(rel);
  if (!safe.startsWith("studio_uploads/") && !safe.startsWith("studio_outputs/")) return res.status(404).end();
  const abs = absolutePathFor(safe);
  if (!fileExists(abs)) return res.status(404).end();
  res.sendFile(abs);
});
