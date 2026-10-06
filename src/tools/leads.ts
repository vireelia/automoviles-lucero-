import { appendToCollection, readCollection, writeCollection } from "../store.js";
import { envelope } from "../response.js";
import { businessInfo } from "../data/business-info.js";
import { raiseAlert } from "../alerts/alerts.js";

type Temperature = "COLD" | "WARM" | "HOT";

type Lead = {
  id: string;
  phone: string | null;
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

export function upsertLead(args: {
  phone?: string;
  name?: string;
  intent?: string;
  notes?: string;
  channel?: string;
  vehicle_interest?: string;
  budget?: string;
  purchase_timing?: string;
}) {
  const leads = readLeads();
  let lead = args.phone ? leads.find((l) => l.phone === args.phone) : undefined;

  if (lead) {
    lead.name = args.name ?? lead.name;
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
      phone: args.phone ?? null,
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
export function getCustomerHistory(args: { phone: string }) {
  const leads = readLeads();
  const lead = leads.find((l) => l.phone === args.phone);
  if (!lead) return envelope({ status: "not_found", error_code: "lead_not_found" });
  return envelope({ status: "ok", data: lead, source: "registro interno" });
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
