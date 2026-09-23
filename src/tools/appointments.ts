import { appendToCollection } from "../store.js";
import { envelope } from "../response.js";

function now() {
  return new Date().toISOString();
}

// No hay agenda real conectada (Sección 23: "agenda y autoridad para
// confirmar citas" sigue pendiente). Devuelve honestamente "denied" para
// que el prompt (Sección 13) recoja la preferencia en vez de inventar
// huecos libres.
export function getAppointmentSlots() {
  return envelope({
    status: "denied",
    error_code: "no_calendar_connected",
    data: null,
    source: null,
  });
}

// Sin agenda conectada, una cita nunca puede quedar "confirmed" -- como
// mucho "requested". Esto es intencional (Sección 13: "Una cita solo está
// confirmada si la herramienta devuelve confirmed y un identificador").
export function createAppointment(args: {
  lead_phone?: string;
  vehicle_id?: string;
  appointment_type?: "visita" | "prueba" | "tasacion" | "reserva_comercial";
  requested_date?: string;
  requested_time?: string;
  notes?: string;
}) {
  const appointment = {
    id: crypto.randomUUID(),
    ...args,
    status: "requested" as const,
    created_at: now(),
  };
  appendToCollection("appointments", appointment);
  return envelope({
    status: "ok",
    data: appointment,
    source: "registro interno (sin agenda real conectada)",
    source_updated_at: now(),
    conflicts: ["Cita NO confirmada -- solo solicitada. Pendiente de que el negocio la confirme manualmente."],
  });
}
