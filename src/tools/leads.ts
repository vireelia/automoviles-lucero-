import { appendToCollection, readCollection, writeCollection } from "../store.js";
import { envelope } from "../response.js";

type Lead = {
  id: string;
  phone: string | null;
  name: string | null;
  intent: string | null;
  notes: string | null;
  channel: string | null;
  do_not_contact: boolean;
  preferred_channel: string | null;
  created_at: string;
  updated_at: string;
};

function now() {
  return new Date().toISOString();
}

export function upsertLead(args: { phone?: string; name?: string; intent?: string; notes?: string; channel?: string }) {
  const leads = readCollection<Lead>("leads");
  let lead = args.phone ? leads.find((l) => l.phone === args.phone) : undefined;

  if (lead) {
    lead.name = args.name ?? lead.name;
    lead.intent = args.intent ?? lead.intent;
    lead.notes = args.notes ? `${lead.notes ? lead.notes + " | " : ""}${args.notes}` : lead.notes;
    lead.channel = args.channel ?? lead.channel;
    lead.updated_at = now();
    writeCollection("leads", leads);
  } else {
    lead = {
      id: crypto.randomUUID(),
      phone: args.phone ?? null,
      name: args.name ?? null,
      intent: args.intent ?? null,
      notes: args.notes ?? null,
      channel: args.channel ?? null,
      do_not_contact: false,
      preferred_channel: null,
      created_at: now(),
      updated_at: now(),
    };
    appendToCollection("leads", lead);
  }

  return envelope({ status: "ok", data: lead, source: "registro interno", source_updated_at: now() });
}

export function updateContactPreferences(args: { phone: string; do_not_contact?: boolean; preferred_channel?: string }) {
  const leads = readCollection<Lead>("leads");
  const lead = leads.find((l) => l.phone === args.phone);
  if (!lead) return envelope({ status: "not_found", error_code: "lead_not_found" });

  if (typeof args.do_not_contact === "boolean") lead.do_not_contact = args.do_not_contact;
  if (args.preferred_channel) lead.preferred_channel = args.preferred_channel;
  lead.updated_at = now();
  writeCollection("leads", leads);

  return envelope({ status: "ok", data: lead, source: "registro interno", source_updated_at: now() });
}
