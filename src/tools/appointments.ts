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

// Único horario confirmado por el dueño hasta ahora (23/09/2026): las citas
// no pueden ser antes de las 9:30. El resto del horario (cierre, descanso,
// fines de semana) sigue sin confirmar -- por eso solo se valida este
// límite inferior, no el de compramostufurgon.com completo (sin validar).
const EARLIEST_APPOINTMENT_HOUR = 9;
const EARLIEST_APPOINTMENT_MINUTE = 30;

function isBeforeEarliestSlot(requested_time?: string): boolean {
  if (!requested_time) return false;
  const match = /^(\d{1,2}):(\d{2})/.exec(requested_time.trim());
  if (!match) return false; // formato no reconocido -- no bloqueamos, dejamos que el negocio lo revise
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < EARLIEST_APPOINTMENT_HOUR || (hour === EARLIEST_APPOINTMENT_HOUR && minute < EARLIEST_APPOINTMENT_MINUTE);
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
  if (isBeforeEarliestSlot(args.requested_time)) {
    return envelope({
      status: "denied",
      error_code: "before_opening_hour",
      data: { earliest_allowed: "09:30" },
      source: "política confirmada por el negocio (23/09/2026)",
    });
  }

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
