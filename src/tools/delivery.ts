import { appendToCollection } from "../store.js";
import { envelope } from "../response.js";

function now() {
  return new Date().toISOString();
}

// send_internal_summary y send_vehicle_details: el número de WhatsApp
// interno del negocio sigue "PENDIENTE DE CONFIRMAR" (Sección 1) y no hay
// canal de envío conectado todavía. Por disciplina de la Sección 18 ("Si
// falla WhatsApp: mantener el registro... No decir que se envió
// correctamente"), esto SIEMPRE devuelve "queued", nunca "sent" ni
// "delivered", hasta que se conecte un destino real.

export function sendInternalSummary(args: { summary_text: string; structured_fields?: Record<string, unknown> }) {
  const record = {
    id: crypto.randomUUID(),
    ...args,
    delivery_status: "queued" as const,
    created_at: now(),
  };
  appendToCollection("internal_summaries", record);
  return envelope({
    status: "denied",
    data: record,
    error_code: "no_destination_configured",
    source: "cola interna, sin destino de WhatsApp confirmado",
    source_updated_at: now(),
    conflicts: ["El WhatsApp interno del negocio no está confirmado todavía (Sección 1) -- el resumen queda en cola, no se ha enviado."],
  });
}

export function sendVehicleDetails(args: { lead_phone?: string; vehicle_id?: string; channel?: string }) {
  const record = {
    id: crypto.randomUUID(),
    ...args,
    delivery_status: "queued" as const,
    created_at: now(),
  };
  appendToCollection("vehicle_detail_sends", record);
  return envelope({
    status: "denied",
    data: record,
    error_code: "no_destination_configured",
    source: "cola interna, sin canal de envío confirmado",
    source_updated_at: now(),
  });
}
