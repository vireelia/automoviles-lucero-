import { appendToCollection, readCollection, writeCollection } from "../store.js";
import { envelope } from "../response.js";
import { businessInfo } from "../data/business-info.js";
import { raiseAlert } from "../alerts/alerts.js";
import { moveToTrash } from "../crm/trash.js";
import { createAutoTask } from "./tasks.js";

type Temperature = "COLD" | "WARM" | "HOT";

type Lead = {
  id: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  intent: string | null;
  notes: string | null;
  channel: string | null;
  // Agente por el que entró el cliente (VOICE, CHAT o EMAIL). Se fija una vez,
  // aunque después el cliente hable por otro canal.
  origin?: string | null;
  vehicle_interest: string | null;
  budget: string | null;
  purchase_timing: string | null;
  objection: string | null;
  temperature: Temperature;
  followup_count: number;
  do_not_contact: boolean;
  preferred_channel: string | null;
  created_at: string;
  updated_at: string;
  last_contact: string;
};

function now() {
  return new Date().toISOString();
}

function readLeads() {
  return readCollection<Lead>("leads", []);
}

// Especificación formal del agente de chat (16/10/2026, sección CRM:
// "comprueba si el lead ya existe antes de crear otro"): FALLO REAL
// confirmado en los datos de producción -- el mismo cliente real del
// Volkswagen Golf quedó duplicado en dos fichas, "+34699696463" (desde voz)
// y "699696463" (el mismo número, pero tecleado sin el prefijo del país) --
// porque la comparación era de texto exacto, sin normalizar. Voz suele dar
// "+34XXXXXXXXX", WhatsApp "34XXXXXXXXX" (sin +), y un número tecleado a
// mano puede venir sin prefijo de país -- las tres formas son el mismo
// teléfono real. No se toca nada que no sea un teléfono de verdad (un email
// usado como clave de contacto, o un identificador largo como el PSID de
// Facebook, se dejan exactamente igual).
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const digits = trimmed.replace(/[^\d+]/g, "");
  const hadPlus = digits.startsWith("+");
  const bare = digits.replace(/^\+/, "").replace(/^0+/, "");
  if (bare.length > 11 || bare.length < 7) return trimmed;
  if (bare.startsWith("34") && bare.length === 11) return "+" + bare;
  if (bare.length === 9) return "+34" + bare;
  return hadPlus ? "+" + bare : trimmed;
}

// Aviso cruzado entre agentes (26/10/2026) -- Carolina (WhatsApp) nunca
// escribe primero por su cuenta a un número que no le ha escrito antes
// (ventana de 24h de Meta para texto libre, sin plantilla aprobada), así
// que esto NUNCA envía un mensaje -- solo crea una tarea real y honesta
// para el equipo, con el aviso correcto según si ya hay o no una
// conversación de WhatsApp abierta con ese número.
function notifyWhatsappOpportunity(phone: string, lead: Lead, fromChannel: string): void {
  const hasWhatsappThread = readCollection<{ phone: string }>("whatsapp_inbox").some((m) => normalizePhone(m.phone) === phone);
  const origenLabel: Record<string, string> = { EMAIL: "correo (Daniel)", VOICE: "teléfono (Miguel)", CHAT: "chat web", FACEBOOK: "Messenger" };
  const origen = origenLabel[fromChannel] ?? fromChannel;
  const reason = hasWhatsappThread
    ? `Número conseguido por ${origen} -- ya hay conversación de WhatsApp abierta con este cliente, se le puede escribir ya.`
    : `Número conseguido por ${origen} -- todavía no escribió por WhatsApp, así que Carolina no puede iniciar la conversación sola (ventana de 24h de Meta). Contactar por WhatsApp solo si el cliente escribe primero, o llamar/escribir por el canal de siempre mientras tanto.`;
  createAutoTask({
    lead_phone: phone,
    type: "contactar_whatsapp",
    reason,
    source_ref: `whatsapp_opportunity:${lead.id}`,
    channel: fromChannel,
    priority: "normal",
  });
}
export function upsertLead(args: {
  phone?: string;
  email?: string;
  name?: string;
  intent?: string;
  notes?: string;
  channel?: string;
  vehicle_interest?: string;
  budget?: string;
  purchase_timing?: string;
}) {
  const leads = readLeads();
  const normalizedPhone = args.phone ? normalizePhone(args.phone) : undefined;
  // Teléfono es la clave principal (lo usan voz/chat, que siempre lo tienen).
  // Un lead que llega por email puede no dar teléfono -- en ese caso se
  // identifica por email para no duplicarlo en cada correo nuevo del mismo remitente.
  let lead = normalizedPhone
    ? leads.find((l) => l.phone === normalizedPhone)
    : args.email
      ? leads.find((l) => l.email === args.email)
      : undefined;
  // Aviso cruzado entre agentes (26/10/2026, "si el agente de gmail tiene
  // un cliente y le pide el numero... que le envie un aviso a carolina para
  // que lo contacte en whatsapp") -- se detecta ANTES de pisar lead.phone,
  // comparando con lo que había antes.
  const isNewPhoneFromOtherChannel = Boolean(normalizedPhone && args.channel && args.channel !== "WHATSAPP" && !lead?.phone);

  if (lead) {
    lead.name = args.name ?? lead.name;
    lead.email = args.email ?? lead.email;
    lead.phone = normalizedPhone ?? lead.phone;
    lead.intent = args.intent ?? lead.intent;
    lead.notes = args.notes ? `${lead.notes ? lead.notes + " | " : ""}${args.notes}` : lead.notes;
    lead.channel = args.channel ?? lead.channel;
    lead.origin = lead.origin ?? args.channel ?? null;
    lead.vehicle_interest = args.vehicle_interest ?? lead.vehicle_interest;
    lead.budget = args.budget ?? lead.budget;
    lead.purchase_timing = args.purchase_timing ?? lead.purchase_timing;
    lead.updated_at = now();
    lead.last_contact = now();
    writeCollection("leads", leads);
  } else {
    lead = {
      id: crypto.randomUUID(),
      phone: normalizedPhone ?? null,
      email: args.email ?? null,
      name: args.name ?? null,
      intent: args.intent ?? null,
      notes: args.notes ?? null,
      channel: args.channel ?? null,
      origin: args.channel ?? null,
      vehicle_interest: args.vehicle_interest ?? null,
      budget: args.budget ?? null,
      purchase_timing: args.purchase_timing ?? null,
      objection: null,
      temperature: "COLD",
      followup_count: 0,
      do_not_contact: false,
      preferred_channel: null,
      created_at: now(),
      updated_at: now(),
      last_contact: now(),
    };
    appendToCollection("leads", lead);
  }

  if (isNewPhoneFromOtherChannel && normalizedPhone) {
    notifyWhatsappOpportunity(normalizedPhone, lead, args.channel!);
  }

  return envelope({ status: "ok", data: lead, source: "registro interno" });
}

export function updateContactPreferences(args: { phone: string; do_not_contact?: boolean; preferred_channel?: string }) {
  const leads = readLeads();
  const lead = leads.find((l) => l.phone === args.phone);
  if (!lead) return envelope({ status: "not_found", error_code: "lead_not_found" });

  if (typeof args.do_not_contact === "boolean") lead.do_not_contact = args.do_not_contact;
  if (args.preferred_channel) lead.preferred_channel = args.preferred_channel;
  lead.updated_at = now();
  writeCollection("leads", leads);

  return envelope({ status: "ok", data: lead, source: "registro interno" });
}

// get_customer_history (Sección 37): recupera contexto si vuelve el mismo
// cliente, para no hacerle repetir información.
// Enriquecida (20/10/2026, mejora integral del CRM, sección 16: "memoria
// compartida" entre Miguel/Carolina/Daniel) -- antes solo devolvía los
// campos sueltos del lead (notas, interés...), nunca sus visitas/reservas/
// resúmenes de conversación reales, aunque esos datos ya existían y eran
// del mismo cliente real (mismo teléfono exacto, nunca una coincidencia
// adivinada entre canales distintos -- eso sigue sin fusionarse solo, ver
// mergeLeads). Así, si un cliente habló antes con Miguel por voz y ahora
// escribe a Carolina por WhatsApp, esta herramienta ya le da el historial
// real de las visitas/reservas que dejó, sin tener que repetirlo él.
export function getCustomerHistory(args: { phone: string }) {
  const leads = readLeads();
  const lead = leads.find((l) => l.phone === args.phone);
  if (!lead) return envelope({ status: "not_found", error_code: "lead_not_found" });
  const appointments = readCollection<{ vehicle_id?: string; requested_date?: string; requested_time?: string; status: string; channel?: string; lead_phone: string | null }>("appointments").filter(
    (a) => a.lead_phone === args.phone,
  );
  const reservations = readCollection<{ vehicle_id: string; amount_eur: number; status: string; channel?: string; lead_phone: string | null }>("reservations").filter(
    (r) => r.lead_phone === args.phone,
  );
  const summaries = readCollection<{ phone?: string | null; summary: string; created_at: string }>("conversation_summaries")
    .filter((s) => s.phone === args.phone)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 5);
  return envelope({
    status: "ok",
    data: { ...lead, appointments, reservations, recent_conversation_summaries: summaries },
    source: "registro interno",
  });
}

// score_lead (Sección 36): el agente clasifica en base a la conversación y
// esta herramienta solo persiste + dispara aviso si es HOT. La
// clasificación NUNCA se muestra al cliente -- eso es una regla de prompt,
// no de esta función.
export function scoreLead(args: { phone: string; temperature: Temperature; objection?: string }) {
  const leads = readLeads();
  const lead = leads.find((l) => l.phone === args.phone);
  if (!lead) return envelope({ status: "not_found", error_code: "lead_not_found" });

  const previous = lead.temperature;
  lead.temperature = args.temperature;
  if (args.objection) lead.objection = args.objection;
  lead.updated_at = now();
  writeCollection("leads", leads);
  // Aviso solo cuando el cliente pasa a caliente (no en cada actualización).
  if (args.temperature === "HOT" && previous !== "HOT") {
    raiseAlert({
      kind: "lead_caliente",
      lead_phone: lead.phone,
      name: lead.name,
      reason: [lead.vehicle_interest, lead.intent].filter(Boolean).join(" · ") || "Quiere comprar ya",
    });
  }

  return envelope({
    status: "ok",
    data: lead,
    source: "registro interno",
    conflicts: args.temperature === "HOT" ? [`${businessInfo.lead_scoring.hot_action}`] : [],
  });
}

// create_followup / stop_followups (Sección 38): tope de 3 seguimientos
// automáticos por lead. No es esta función la que envía el mensaje (no hay
// canal de envío real conectado, ver delivery.ts) -- solo lleva la cuenta
// para que nunca se supere el máximo.
export function createFollowup(args: { phone: string; reason?: string }) {
  const leads = readLeads();
  const lead = leads.find((l) => l.phone === args.phone);
  if (!lead) return envelope({ status: "not_found", error_code: "lead_not_found" });

  const max = businessInfo.followups.max_automatic;
  if (lead.followup_count >= max) {
    return envelope({
      status: "denied",
      error_code: "followup_limit_reached",
      data: lead,
      conflicts: [`Ya se alcanzó el máximo de ${max} seguimientos automáticos para este lead -- no crear más.`],
    });
  }

  lead.followup_count += 1;
  lead.updated_at = now();
  writeCollection("leads", leads);
  appendToCollection("followups", { id: crypto.randomUUID(), phone: args.phone, reason: args.reason ?? null, created_at: now() });

  return envelope({ status: "ok", data: lead, source: "registro interno" });
}

export function stopFollowups(args: { phone: string }) {
  const leads = readLeads();
  const lead = leads.find((l) => l.phone === args.phone);
  if (!lead) return envelope({ status: "not_found", error_code: "lead_not_found" });

  lead.do_not_contact = true;
  lead.updated_at = now();
  writeCollection("leads", leads);

  return envelope({ status: "ok", data: lead, source: "registro interno" });
}

// Limpieza masiva de clientes de prueba/spam (15/10/2026, a petición real:
// "estos son clientes falsos, solo deja la ficha de Ángel"). Admin-only,
// nunca borra de verdad -- cada lead quitado pasa por la Papelera (igual que
// el botón "Eliminar" del CRM), así que es recuperable si alguno resulta no
// ser falso.
export function purgeLeadsExcept(args: { keep_phones?: string[]; keep_emails?: string[]; admin_email: string }) {
  const keepPhones = new Set(args.keep_phones ?? []);
  const keepEmails = new Set(args.keep_emails ?? []);
  const leads = readLeads();
  const toRemove = leads.filter((l) => {
    const keptByPhone = l.phone != null && keepPhones.has(l.phone);
    const keptByEmail = l.email != null && keepEmails.has(l.email);
    return !keptByPhone && !keptByEmail;
  });
  for (const lead of toRemove) {
    moveToTrash("leads", lead, `Cliente: ${lead.name || lead.phone || lead.email || "sin nombre"}`, args.admin_email);
  }
  const kept = leads.filter((l) => !toRemove.includes(l));
  writeCollection("leads", kept);
  return envelope({
    status: "ok",
    data: { removed_count: toRemove.length, kept_count: kept.length, removed: toRemove.map((l) => ({ id: l.id, name: l.name, phone: l.phone, email: l.email })) },
    source: "registro interno",
  });
}

// mergeLeads (16/10/2026, para fusionar duplicados reales ya existentes de
// antes del arreglo de normalizePhone -- nunca se hace solo, siempre a
// petición explícita, uno por uno). Se queda con el registro más antiguo
// (keep_id), rellena los huecos con lo que tenga el duplicado (remove_id)
// sin pisar datos ya buenos, junta las notas de los dos, y usa el canal y
// el último contacto más recientes de los dos -- igual que haría upsertLead
// si hubiera encontrado el mismo teléfono desde el principio.
export function mergeLeads(args: { keep_id: string; remove_id: string; admin_email: string }) {
  const leads = readLeads();
  const keep = leads.find((l) => l.id === args.keep_id);
  const remove = leads.find((l) => l.id === args.remove_id);
  if (!keep || !remove) {
    return envelope({ status: "error", data: null, error_code: "lead_not_found", source: "registro interno" });
  }
  keep.name = keep.name ?? remove.name;
  keep.email = keep.email ?? remove.email;
  keep.intent = keep.intent ?? remove.intent;
  keep.vehicle_interest = keep.vehicle_interest ?? remove.vehicle_interest;
  keep.budget = keep.budget ?? remove.budget;
  keep.purchase_timing = keep.purchase_timing ?? remove.purchase_timing;
  keep.objection = keep.objection ?? remove.objection;
  keep.notes = [keep.notes, remove.notes].filter(Boolean).join(" | ") || null;
  const keepIsNewer = keep.last_contact >= remove.last_contact;
  keep.channel = keepIsNewer ? keep.channel : remove.channel;
  keep.last_contact = keepIsNewer ? keep.last_contact : remove.last_contact;
  keep.updated_at = now();
  moveToTrash("leads", remove, `Duplicado fusionado en ${keep.id}: ${remove.name || remove.phone || remove.email || "sin nombre"}`, args.admin_email);
  writeCollection("leads", leads.filter((l) => l.id !== remove.id));
  return envelope({ status: "ok", data: keep, source: "registro interno" });
}
