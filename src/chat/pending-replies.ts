import crypto from "crypto";
import { readCollection, writeCollection } from "../store.js";
import { raiseAlert } from "../alerts/alerts.js";
import { createAutoTask } from "../tools/tasks.js";
import { lastInboundAt } from "./whatsapp-window.js";
import { esAnteriorAlCorte } from "../deploy-safety.js";

// Nada se descarta en silencio: cuando un mensaje agota los reintentos o se
// sale de la ventana de WhatsApp, pasa a revisión humana con una tarea real
// en el CRM, además del aviso. La tarea no se duplica (dedup por source_ref).
function aRevisionHumana(item: PendingReply, motivo: string): void {
  createAutoTask({
    lead_phone: item.contact,
    type: "responder_mensaje",
    reason: `Mensaje sin responder (${motivo}): "${item.text.slice(0, 300)}". Llegó el ${item.received_at.slice(0, 16).replace("T", " ")} por ${item.channel}. Contéstale a mano.`,
    source_ref: `pending_reply_${item.key}`,
    channel: item.channel,
    priority: URGENT.test(item.text) ? "alta" : "normal",
  });
  raiseAlert({
    kind: "gestion_portal",
    lead_phone: item.contact,
    reason: `${item.channel}: mensaje sin responder (${motivo}): "${item.text.slice(0, 200)}". Queda en Tareas para atenderlo a mano.`,
  });
}

// Mensajes de WhatsApp/Facebook que la IA no pudo contestar (sin crédito,
// tope diario, error). Nunca se envía una disculpa técnica al cliente: el
// mensaje se guarda aquí y se reintenta con límite.

export type PendingChannel = "WHATSAPP" | "FACEBOOK";
export type PendingReply = {
  key: string;
  channel: PendingChannel;
  contact: string;
  text: string;
  received_at: string;
  attempts: number;
  next_retry_at: string;
  last_error?: string;
  status: "pendiente" | "agotado";
};

const COLLECTION = "chat_pending_replies";
const MAX_KEPT = 2000;
const BACKOFF_MINUTES = [5, 15, 60, 180];
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length;
// Fuera de la ventana de 24h de WhatsApp ya no se puede responder con texto libre.
const MAX_AGE_HOURS = 20;
const URGENT = /reserv|señal|pagar|comprar|cita|visita|financ/i;

export function pendingKey(channel: PendingChannel, contact: string, text: string): string {
  return crypto.createHash("sha256").update(`${channel}|${contact}|${text.trim()}`).digest("hex").slice(0, 32);
}

export function enqueuePendingReply(channel: PendingChannel, contact: string, text: string, error?: string): boolean {
  const key = pendingKey(channel, contact, text);
  const all = readCollection<PendingReply>(COLLECTION);
  if (all.some((p) => p.key === key && p.status === "pendiente")) return false;
  const now = new Date();
  all.push({ key, channel, contact, text, received_at: now.toISOString(), attempts: 0, next_retry_at: new Date(now.getTime() + BACKOFF_MINUTES[0] * 60_000).toISOString(), last_error: error, status: "pendiente" });
  writeCollection(COLLECTION, all.slice(-MAX_KEPT));
  if (URGENT.test(text)) {
    raiseAlert({ kind: "gestion_portal", lead_phone: contact, reason: `${channel}: mensaje con intención de visita/reserva sin responder (IA no disponible): "${text.slice(0, 200)}". Contéstale a mano si es posible.` });
  }
  return true;
}

export type ReplyHandler = (item: PendingReply) => Promise<{ ok: boolean; error?: string }>;

// Un mensaje por llamada para no disparar ráfagas si la IA vuelve a fallar.
export async function drainPendingReplies(handler: ReplyHandler, now = Date.now()): Promise<number> {
  const all = readCollection<PendingReply>(COLLECTION);
  let changed = false;
  for (const p of all) {
    if (p.status !== "pendiente") continue;
    // La ventana de WhatsApp se cuenta desde el último mensaje ENTRANTE real
    // del cliente (no desde cuando lo encolamos ni desde la última respuesta
    // nuestra): es lo que de verdad mide Meta. Si el cliente ha vuelto a
    // escribir después, la ventana se reabre y este mensaje sigue siendo
    // contestable.
    const ventanaDesde = p.channel === "WHATSAPP" ? (lastInboundAt(p.contact) ?? new Date(p.received_at).getTime()) : new Date(p.received_at).getTime();
    if (now - ventanaDesde > MAX_AGE_HOURS * 3600_000) {
      p.status = "agotado";
      p.last_error = "fuera_de_ventana_24h";
      changed = true;
      aRevisionHumana(p, `pasaron más de ${MAX_AGE_HOURS}h desde su último mensaje, ya fuera de la ventana de WhatsApp`);
    }
  }
  if (changed) writeCollection(COLLECTION, all);
  // Barrera de activación (10/11/2026, LUCERO_NO_AUTO_BEFORE): nunca
  // reintentar solo nada recibido antes del corte -- queda en la cola,
  // para revisión humana, nunca se contesta sin que alguien lo mire.
  const ready = all.filter((p) => p.status === "pendiente" && new Date(p.next_retry_at).getTime() <= now && !esAnteriorAlCorte(p.received_at));
  if (ready.length === 0) return 0;
  ready.sort((a, b) => Number(URGENT.test(b.text)) - Number(URGENT.test(a.text)) || a.received_at.localeCompare(b.received_at));
  const item = ready[0];
  const result = await handler(item);
  const fresh = readCollection<PendingReply>(COLLECTION);
  const idx = fresh.findIndex((p) => p.key === item.key && p.status === "pendiente");
  if (idx < 0) return 0;
  if (result.ok) {
    fresh.splice(idx, 1);
  } else {
    const attempts = fresh[idx].attempts + 1;
    fresh[idx].attempts = attempts;
    fresh[idx].last_error = result.error;
    if (attempts >= MAX_ATTEMPTS) {
      fresh[idx].status = "agotado";
      aRevisionHumana(item, `${attempts} intentos fallidos, último error: ${result.error ?? "desconocido"}`);
    } else {
      fresh[idx].next_retry_at = new Date(now + BACKOFF_MINUTES[attempts] * 60_000).toISOString();
    }
  }
  writeCollection(COLLECTION, fresh);
  return 1;
}

export function listPendingReplies(): PendingReply[] {
  return readCollection<PendingReply>(COLLECTION);
}
