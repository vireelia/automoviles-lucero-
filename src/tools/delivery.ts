import { appendToCollection, readCollection, writeCollection } from "../store.js";
import { envelope } from "../response.js";
import { businessInfo } from "../data/business-info.js";
import { vehiclesSeed } from "../data/vehicles-seed.js";

function now() {
  return new Date().toISOString();
}

// send_internal_summary, send_vehicle_link, send_location, send_whatsapp,
// notify_salesperson: ninguno tiene un canal de envío real conectado
// todavía (el WhatsApp del negocio está confirmado como número, Sección 1,
// pero no hay integración técnica de envío). Por disciplina de "nunca
// afirmar entregado sin confirmación", TODOS devuelven "queued"/"denied",
// nunca "sent" ni "delivered", hasta que se conecte un destino real (n8n +
// WhatsApp Business Platform).

export function sendInternalSummary(args: { summary_text: string; structured_fields?: Record<string, unknown> }) {
  const record = { id: crypto.randomUUID(), ...args, delivery_status: "queued" as const, created_at: now() };
  appendToCollection("internal_summaries", record);
  return envelope({
    status: "denied",
    data: record,
    error_code: "no_destination_configured",
    source: "cola interna, sin canal de envío confirmado",
    conflicts: ["Queda registrado, no enviado -- nunca digas al cliente que se envió o que el equipo ya lo tiene."],
  });
}

// Si no hay URL individual confirmada del vehículo (hoy ninguna unidad del
// seed la tiene todavía), cae al enlace general del perfil de coches.net --
// es un enlace real, solo que no apunta al anuncio concreto (Sección 30:
// "enviarle también un enlace con nuestra página de venta para que pueda
// ver todo"). Nunca inventamos una URL individual que no exista.
export function sendVehicleLink(args: { lead_phone?: string; vehicle_id?: string; channel?: string }) {
  const vehicle = args.vehicle_id ? vehiclesSeed.find((v) => v.id === args.vehicle_id) : undefined;
  const url = vehicle?.ref_cochesnet ?? businessInfo.profiles.cochesnet;
  const isIndividual = Boolean(vehicle?.ref_cochesnet);
  const record = { id: crypto.randomUUID(), ...args, url, is_individual_url: isIndividual, delivery_status: "queued" as const, created_at: now() };
  appendToCollection("vehicle_link_sends", record);
  return envelope({
    status: "denied",
    data: record,
    error_code: "no_destination_configured",
    source: "cola interna, sin canal de envío confirmado",
    conflicts: isIndividual ? [] : ["No hay URL individual confirmada para este vehículo -- se usa el enlace general del catálogo en su lugar, dilo así si el cliente pregunta por el enlace concreto."],
  });
}

export function sendLocation() {
  return envelope({
    status: "ok",
    data: {
      address: businessInfo.location.address.value,
      zone: businessInfo.location.zone,
      references: businessInfo.location.references,
    },
    source: "Dirección confirmada por el negocio.",
    conflicts: [businessInfo.location.references_note],
  });
}

export function sendWhatsapp(args: { lead_phone?: string; message?: string }) {
  const record = { id: crypto.randomUUID(), ...args, delivery_status: "queued" as const, created_at: now() };
  appendToCollection("whatsapp_queue", record);
  return envelope({
    status: "denied",
    data: record,
    error_code: "no_whatsapp_integration",
    source: "cola interna -- número de WhatsApp del negocio confirmado, pero sin integración técnica de envío todavía",
    conflicts: ["Nunca digas que el mensaje de WhatsApp se envió -- queda en cola hasta conectar la integración real."],
  });
}

// notify_salesperson (Sección 47): formato fijo para leads HOT o
// incidencias urgentes. Igual que el resto, queda en cola -- el envío real
// (WhatsApp/Telegram a Ramón o José) es una automatización pendiente.
export function notifySalesperson(args: {
  name?: string;
  phone?: string;
  vehicle?: string;
  channel?: "VOICE" | "CHAT";
  intent?: string;
  objection?: string;
  last_action?: string;
  summary?: string;
  urgency?: "normal" | "alta";
}) {
  const formatted =
    `🔥 LEAD ${args.urgency === "alta" ? "CALIENTE" : ""}\n` +
    `Cliente: ${args.name ?? "sin nombre"}\n` +
    `Teléfono: ${args.phone ?? "sin teléfono"}\n` +
    `Vehículo: ${args.vehicle ?? "sin especificar"}\n` +
    `Canal: ${args.channel ?? "sin especificar"}\n` +
    `Intención: ${args.intent ?? "sin especificar"}\n` +
    `Objeción: ${args.objection ?? "ninguna registrada"}\n` +
    `Última acción: ${args.last_action ?? "sin especificar"}\n` +
    `Resumen: ${args.summary ?? "sin resumen"}`;

  const record = { id: crypto.randomUUID(), ...args, formatted, delivery_status: "queued" as const, created_at: now() };
  appendToCollection("salesperson_notifications", record);
  return envelope({
    status: "denied",
    data: record,
    error_code: "no_destination_configured",
    source: "cola interna -- destino real de Ramón/José pendiente de configurar",
    conflicts: ["Registrado como pendiente de notificar -- no digas que Ramón o José ya lo saben."],
  });
}

export function saveConversation(args: {
  phone?: string;
  channel: "VOICE" | "CHAT";
  transcript?: string;
  summary?: string;
  intent?: string;
  vehicle_id?: string;
  outcome?: string;
}) {
  const record = { id: crypto.randomUUID(), ...args, created_at: now() };
  appendToCollection("conversations", record);
  return envelope({ status: "ok", data: record, source: "registro interno" });
}

export function createConversationSummary(args: { phone?: string; summary: string }) {
  const record = { id: crypto.randomUUID(), ...args, created_at: now() };
  appendToCollection("conversation_summaries", record);
  return envelope({ status: "ok", data: record, source: "registro interno" });
}
