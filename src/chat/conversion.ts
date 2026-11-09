import { readCollection } from "../store.js";

// LUCERO_CONVERSION_ENGINE: estado comercial de una conversación, deducido
// SOLO de hechos verificables (citas y reservas reales en disco, herramientas
// que de verdad se llamaron, texto literal del cliente). Nunca usa IA y nunca
// decide por su cuenta que una visita está confirmada: eso lo dice la
// colección "appointments", no el agente.

export type Stage =
  | "NUEVO_CONTACTO"
  | "CONSULTA_INFORMATIVA"
  | "INTERES_DETECTADO"
  | "VISITA_PROPUESTA"
  | "VISITA_CONFIRMADA"
  | "RESERVA_SOLICITADA"
  | "RESERVA_FORMALIZADA"
  | "REQUIERE_HUMANO"
  | "SIN_INTERES"
  | "NO_CONTACTAR";

type Msg = { role: string; content: string | null };
type Appointment = { lead_phone?: string | null; status?: string; requested_date?: string; requested_time?: string; created_at?: string };
type Reservation = { lead_phone?: string | null; customer_phone?: string | null; status?: string };
type Lead = { phone?: string | null; do_not_contact?: boolean };

// Intención comercial real: pedir ver el coche, reservarlo, financiarlo o
// dar día/hora. Deliberadamente sin "hora"/"día" suelto, que aparecen en
// cualquier pregunta por el horario de la tienda.
export const INTENT_COMERCIAL =
  /\b(cita|visita|visitar|verlo|ver el coche|probarlo|prueba|reservar|reserva|se[ñn]al|comprarlo|me lo llevo|financiar|financiaci[oó]n|entrada|tasar|tasaci[oó]n)\b|\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)\b|\b\d{1,2}[:h]\d{0,2}\b/i;
const SIN_INTERES = /\b(no me interesa|ya no|lo dejo|he comprado otro|ya compr[eé]|d[eé]jalo|no gracias)\b/i;
const NO_CONTACTAR = /\b(no me escrib|no me escribas|no quiero mensajes|baja|stop|d[ae]rme de baja|no me contact)\b/i;
const QUIERE_PERSONA = /\b(hablar con|con ram[oó]n|con jos[eé]|una persona|humano|me llam[eé]is|ll[aá]mame|tel[eé]fono)\b/i;

export function normalizePhone(p: string | null | undefined): string {
  return String(p ?? "").replace(/[^0-9]/g, "").replace(/^34/, "");
}

function sameContact(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizePhone(a);
  return na.length > 0 && na === normalizePhone(b);
}

export function appointmentsFor(contact: string): Appointment[] {
  return readCollection<Appointment>("appointments").filter((a) => sameContact(a.lead_phone, contact));
}

// Devuelve el estado comercial real. `userText` es el mensaje que acaba de
// llegar; `messages` el historial ya guardado de esta conversación.
export function conversationStage(contact: string, userText: string, messages: Msg[] = []): Stage {
  if (NO_CONTACTAR.test(userText)) return "NO_CONTACTAR";
  const lead = readCollection<Lead>("leads").find((l) => sameContact(l.phone, contact));
  if (lead?.do_not_contact) return "NO_CONTACTAR";

  const reservas = readCollection<Reservation>("reservations").filter((r) => sameContact(r.lead_phone ?? r.customer_phone, contact));
  if (reservas.some((r) => r.status === "confirmed" || r.status === "vendido")) return "RESERVA_FORMALIZADA";
  if (reservas.length > 0) return "RESERVA_SOLICITADA";

  const citas = appointmentsFor(contact);
  if (citas.some((a) => a.status === "confirmed")) return "VISITA_CONFIRMADA";
  if (citas.length > 0) return "VISITA_PROPUESTA";

  if (SIN_INTERES.test(userText)) return "SIN_INTERES";
  if (QUIERE_PERSONA.test(userText)) return "REQUIERE_HUMANO";

  // Se consultaron huecos reales en esta conversación: ya está en marcha
  // una visita aunque todavía no haya registro de cita.
  const historial = messages.map((m) => m.content ?? "").join("\n");
  if (/"slots"/.test(historial)) return "VISITA_PROPUESTA";

  if (INTENT_COMERCIAL.test(userText) || INTENT_COMERCIAL.test(historial)) return "INTERES_DETECTADO";
  return messages.length === 0 ? "NUEVO_CONTACTO" : "CONSULTA_INFORMATIVA";
}

// Tope de mensajes del cliente por conversación. Petición real de Ramón
// (05/11/2026, "solo 4 mensajes joder") -- se mantiene para las consultas
// informativas, que es donde se iba el gasto. Pero cortar a los 4 también
// cortaba conversaciones camino de una visita: 149 conversaciones reales
// cortadas, 134 de 202 citas quedaron sin día ni hora. Cuando hay intención
// comercial real el tope se amplía, porque esos mensajes son justo los que
// generan visitas.
const TOPE_POR_ESTADO: Record<Stage, number> = {
  NUEVO_CONTACTO: 4,
  CONSULTA_INFORMATIVA: 4,
  INTERES_DETECTADO: 8,
  VISITA_PROPUESTA: 10,
  VISITA_CONFIRMADA: 10,
  RESERVA_SOLICITADA: 12,
  RESERVA_FORMALIZADA: 12,
  REQUIERE_HUMANO: 2,
  SIN_INTERES: 2,
  NO_CONTACTAR: 0,
};

export function maxUserTurnsFor(stage: Stage): number {
  return TOPE_POR_ESTADO[stage];
}

export function esComercial(stage: Stage): boolean {
  return stage === "INTERES_DETECTADO" || stage === "VISITA_PROPUESTA" || stage === "VISITA_CONFIRMADA" || stage === "RESERVA_SOLICITADA" || stage === "RESERVA_FORMALIZADA";
}
