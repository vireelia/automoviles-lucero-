import { appendToCollection, readCollection, writeCollection } from "../store.js";
import { envelope } from "../response.js";

function now() {
  return new Date().toISOString();
}

// No hay agenda real conectada (punto pendiente del cuestionario: "agenda y
// autoridad para confirmar citas"). Devuelve honestamente "denied" para que
// el prompt recoja la preferencia del cliente en vez de inventar huecos
// libres.
export function getAppointmentSlots() {
  return envelope({
    status: "denied",
    error_code: "no_calendar_connected",
    data: null,
    source: null,
  });
}

// Horario confirmado por el negocio 29/09/2026 (Sección 21): L-V 09:30-14:00
// y 16:30-19:00; S-D solo con cita previa y confirmación.
const WEEKDAY_WINDOWS = [
  { start: 9 * 60 + 30, end: 14 * 60 },
  { start: 16 * 60 + 30, end: 19 * 60 },
];

function parseTime(requested_time?: string): number | null {
  if (!requested_time) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(requested_time.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isWeekend(requested_date?: string): boolean {
  if (!requested_date) return false;
  const d = new Date(requested_date);
  if (Number.isNaN(d.getTime())) return false;
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function withinWeekdayWindow(minutes: number): boolean {
  return WEEKDAY_WINDOWS.some((w) => minutes >= w.start && minutes <= w.end);
}

// Sin agenda conectada, una cita nunca puede quedar "confirmed" -- como
// mucho "requested" (Sección 22: CITA != RESERVA, y no hay autoridad de
// agenda todavía). Se valida el horario confirmado para no aceptar una
// solicitud claramente fuera de lo que el negocio ya dijo que no atiende.
export function createAppointment(args: {
  lead_phone?: string;
  vehicle_id?: string;
  appointment_type?: "visita" | "prueba" | "tasacion" | "reserva_comercial";
  requested_date?: string;
  requested_time?: string;
  notes?: string;
}) {
  const minutes = parseTime(args.requested_time);
  const weekend = isWeekend(args.requested_date);

  if (weekend) {
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
      conflicts: ["Fin de semana: el negocio solo atiende con cita previa Y confirmación expresa -- dejar muy claro que queda solicitada, no confirmada."],
    });
  }

  if (minutes !== null && !withinWeekdayWindow(minutes)) {
    return envelope({
      status: "denied",
      error_code: "outside_business_hours",
      data: { hours: "L-V 09:30-14:00 y 16:30-19:00" },
      source: "política confirmada por el negocio 29/09/2026",
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
    conflicts: ["Cita NO confirmada -- solo solicitada. Pendiente de que el negocio la confirme manualmente."],
  });
}

export function updateAppointment(args: { appointment_id: string; requested_date?: string; requested_time?: string; notes?: string }) {
  const appointments = readCollection<any>("appointments", []);
  const appt = appointments.find((a) => a.id === args.appointment_id);
  if (!appt) return envelope({ status: "not_found", error_code: "appointment_not_found" });

  if (args.requested_time) {
    const minutes = parseTime(args.requested_time);
    if (minutes !== null && !isWeekend(args.requested_date ?? appt.requested_date) && !withinWeekdayWindow(minutes)) {
      return envelope({ status: "denied", error_code: "outside_business_hours", data: { hours: "L-V 09:30-14:00 y 16:30-19:00" } });
    }
  }

  appt.requested_date = args.requested_date ?? appt.requested_date;
  appt.requested_time = args.requested_time ?? appt.requested_time;
  appt.notes = args.notes ?? appt.notes;
  appt.status = "requested";
  writeCollection("appointments", appointments);

  return envelope({ status: "ok", data: appt, source: "registro interno", conflicts: ["Cambio registrado como nueva solicitud -- sigue pendiente de confirmación del negocio."] });
}

export function cancelAppointment(args: { appointment_id: string; reason?: string }) {
  const appointments = readCollection<any>("appointments", []);
  const appt = appointments.find((a) => a.id === args.appointment_id);
  if (!appt) return envelope({ status: "not_found", error_code: "appointment_not_found" });

  appt.status = "cancelled";
  appt.cancel_reason = args.reason ?? null;
  writeCollection("appointments", appointments);

  return envelope({ status: "ok", data: appt, source: "registro interno" });
}
