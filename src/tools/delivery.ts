import { appendToCollection, readCollection, writeCollection } from "../store.js";
import { envelope } from "../response.js";
import { businessInfo } from "../data/business-info.js";
import { getBusinessConfig } from "../data/business-config.js";
import { currentVehicles } from "../data/vehicles-current.js";
import { isWhatsappConnected, sendWhatsappText } from "../integrations/whatsapp.js";

function now() {
  return new Date().toISOString();
}

// send_vehicle_link, send_whatsapp, notify_salesperson: envían de verdad por
// WhatsApp Cloud API cuando hay credenciales conectadas (isWhatsappConnected()).
// send_internal_summary sigue sin destino real (no hay a dónde mandarlo todavía).
// Por disciplina de "nunca afirmar entregado sin confirmación": si la API de
// Meta devuelve error (p. ej. más de 24h desde el último mensaje del cliente,
// regla de Meta para texto libre) se propaga el error real y se marca
// "failed"/"denied", nunca "sent" sin que la API lo haya confirmado.

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
export async function sendVehicleLink(args: { lead_phone?: string; vehicle_id?: string; channel?: string }) {
  const vehicle = args.vehicle_id ? currentVehicles().find((v) => v.id === args.vehicle_id) : undefined;
  const url = vehicle?.ref_cochesnet ?? businessInfo.profiles.cochesnet;
  const isIndividual = Boolean(vehicle?.ref_cochesnet);
  const individualWarning = isIndividual ? [] : ["No hay URL individual confirmada para este vehículo -- se usa el enlace general del catálogo en su lugar, dilo así si el cliente pregunta por el enlace concreto."];
  const record = { id: crypto.randomUUID(), ...args, url, is_individual_url: isIndividual, delivery_status: "queued" as const, created_at: now() };

  if (args.channel === "whatsapp" && isWhatsappConnected() && args.lead_phone) {
    const result = await sendWhatsappText(args.lead_phone, url);
    if (result.ok) {
      appendToCollection("vehicle_link_sends", { ...record, delivery_status: "sent" as const, message_id: result.messageId });
      return envelope({ status: "ok", data: { ...record, delivery_status: "sent", message_id: result.messageId }, source: "WhatsApp Cloud API", conflicts: individualWarning });
    }
    appendToCollection("vehicle_link_sends", { ...record, delivery_status: "failed" as const, error: result.error });
    return envelope({
      status: "denied",
      data: { ...record, delivery_status: "failed" },
      error_code: "whatsapp_send_failed",
      source: "WhatsApp Cloud API",
      conflicts: [...individualWarning, `El envío por WhatsApp falló: ${result.error}. No se ha entregado.`],
    });
  }

  appendToCollection("vehicle_link_sends", record);
  return envelope({
    status: "denied",
    data: record,
    error_code: "no_destination_configured",
    source: "cola interna, sin canal de envío confirmado",
    conflicts: individualWarning,
  });
}

export function sendLocation() {
  const cfg = getBusinessConfig();
  return envelope({
    status: "ok",
    data: {
      address: cfg.address,
      zone: businessInfo.location.zone,
      how_to_arrive: cfg.howToArrive,
      transport: businessInfo.location.transport,
    },
    source: businessInfo.location.source,
    conflicts: [],
  });
}

export async function sendWhatsapp(args: { lead_phone?: string; message?: string }) {
  const record = { id: crypto.randomUUID(), ...args, delivery_status: "queued" as const, created_at: now() };

  if (isWhatsappConnected() && args.lead_phone && args.message) {
    const result = await sendWhatsappText(args.lead_phone, args.message);
    if (result.ok) {
      appendToCollection("whatsapp_queue", { ...record, delivery_status: "sent" as const, message_id: result.messageId });
      return envelope({ status: "ok", data: { ...record, delivery_status: "sent", message_id: result.messageId }, source: "WhatsApp Cloud API", conflicts: [] });
    }
    appendToCollection("whatsapp_queue", { ...record, delivery_status: "failed" as const, error: result.error });
    return envelope({
      status: "denied",
      data: { ...record, delivery_status: "failed" },
      error_code: "whatsapp_send_failed",
      source: "WhatsApp Cloud API",
      conflicts: [`El envío falló: ${result.error}. No se ha entregado -- posible causa: han pasado más de 24h desde el último mensaje del cliente (regla de Meta para texto libre fuera de plantilla).`],
    });
  }

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
// incidencias urgentes. Se envía por WhatsApp a los números personales de
// Ramón y José (confirmados en business-info.ts, responsables.*.transfer_number)
// cuando hay integración conectada -- a los dos, porque transfer_priority ya
// trata a cualquiera de los dos como válido para atender. Si falla para
// alguno, queda registrado como tal -- nunca se asume que lo vieron.
export async function notifySalesperson(args: {
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

  if (isWhatsappConnected()) {
    const cfg = getBusinessConfig();
    const recipients = [
      { name: "Ramón", phone: cfg.ramonPhone },
      { name: "José", phone: cfg.josePhone },
    ];
    const results = await Promise.all(recipients.map((r) => sendWhatsappText(r.phone, formatted).then((res) => ({ ...r, res }))));
    const sentTo = results.filter((r) => r.res.ok).map((r) => r.name);
    const failedTo = results.filter((r) => !r.res.ok).map((r) => `${r.name} (${(r.res as { error: string }).error})`);

    appendToCollection("salesperson_notifications", { ...record, delivery_status: sentTo.length > 0 ? ("sent" as const) : ("failed" as const), sent_to: sentTo, failed_to: failedTo });

    if (sentTo.length > 0) {
      return envelope({
        status: "ok",
        data: { ...record, sent_to: sentTo },
        source: "WhatsApp Cloud API",
        conflicts: failedTo.length > 0 ? [`No se pudo notificar a: ${failedTo.join(", ")}.`] : [],
      });
    }
    return envelope({
      status: "denied",
      data: { ...record, failed_to: failedTo },
      error_code: "whatsapp_send_failed",
      source: "WhatsApp Cloud API",
      conflicts: [`No se pudo notificar a nadie: ${failedTo.join(", ")}. No digas que Ramón o José ya lo saben.`],
    });
  }

  appendToCollection("salesperson_notifications", record);
  return envelope({
    status: "denied",
    data: record,
    error_code: "no_destination_configured",
    source: "cola interna -- destino real de Ramón/José pendiente de configurar",
    conflicts: ["Registrado como pendiente de notificar -- no digas que Ramón o José ya lo saben."],
  });
}

// get_responsable_contact (20/10/2026, petición real: "cuando el cliente le
// pregunte a Carolina por si puede hablar con un responsable, que le pase el
// número de Ramón o José por WhatsApp para que lo pueda llamar"). Solo para
// WhatsApp/Messenger/correo (Carolina/Daniel) -- en voz no hace falta, ya
// existe transfer_call en vivo, que resuelve lo mismo mejor. Excepción
// explícita documentada en business-info.ts privacy_rule -- los números
// reales nunca viven en el prompt, se resuelven aquí igual que en
// notify_salesperson.
export function getResponsableContact(args: { preferencia?: "ramon" | "jose" }) {
  const cfg = getBusinessConfig();
  const ramon = { nombre: "Ramón", telefono: cfg.ramonPhone };
  const jose = { nombre: "José", telefono: cfg.josePhone };
  const data =
    args.preferencia === "jose"
      ? { elegido: jose, alternativa: ramon }
      : args.preferencia === "ramon"
        ? { elegido: ramon, alternativa: jose }
        : { elegido: ramon, alternativa: jose, nota: "No se indicó preferencia -- se da el de Ramón por defecto, José como alternativa si hace falta." };
  return envelope({
    status: "ok",
    data,
    source: "Números personales confirmados por el negocio (business-info.ts, responsables.*)",
    conflicts: ["Excepción de privacidad concreta: solo dar este teléfono cuando el cliente pida explícitamente hablar con una persona -- nunca compartir ningún otro dato personal del negocio o del equipo."],
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
