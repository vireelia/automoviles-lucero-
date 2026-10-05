import { appendToCollection, readCollection, writeCollection } from "../store.js";
import { envelope } from "../response.js";
import { isGoogleConnected, calendarBusy, calendarCreateEvent } from "../integrations/google.js";

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

// Madrid, UTC+1/UTC+2 según la época del año. El offset se calcula con Intl
// para que el cambio de horario no desplace las citas una hora.
function madridOffsetMinutes(at: Date): number {
  const tz = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", timeZoneName: "shortOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT+1";
  const m = /GMT([+-]\d{1,2})(?::?(\d{2}))?/.exec(tz);
  if (!m) return 60;
  const hours = Number(m[1]);
  const mins = m[2] ? Number(m[2]) : 0;
  return hours * 60 + (hours < 0 ? -mins : mins);
}

function madridLocalToUtcMs(date: string, minutes: number): number {
  const [y, mo, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  return guess - madridOffsetMinutes(new Date(guess)) * 60000;
}

const APPOINTMENT_MINUTES = 60;

// Con Google Calendar conectado: se comprueba que el hueco esté libre antes
// de registrar la cita, y si lo está se crea el evento en la agenda real del
// negocio. La cita sigue en estado "requested" -- no se confirma sola.
export async function createAppointmentWithCalendar(args: Parameters<typeof createAppointment>[0]) {
  const minutes = parseTime(args.requested_time);
  const dateOk = Boolean(args.requested_date && /^\d{4}-\d{2}-\d{2}$/.test(args.requested_date));
  if (!isGoogleConnected() || minutes === null || !dateOk || isWeekend(args.requested_date)) {
    return createAppointment(args);
  }
  const startMs = madridLocalToUtcMs(args.requested_date!, minutes);
  const endMs = startMs + APPOINTMENT_MINUTES * 60000;
  const busy = await calendarBusy(new Date(startMs).toISOString(), new Date(endMs).toISOString());
  if (busy.some((b) => Date.parse(b.start) < endMs && Date.parse(b.end) > startMs)) {
    return envelope({
      status: "denied",
      error_code: "slot_busy",
      data: null,
      source: "agenda del negocio (Google Calendar)",
      conflicts: ["Ese hueco ya está ocupado -- ofrecer otro horario."],
    });
  }
  const result = createAppointment(args);
  const registered = result as unknown as { status: string; data: { id: string } | null };
  if (registered.status !== "ok" || !registered.data) return result;

  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  const endMinutes = minutes + APPOINTMENT_MINUTES;
  const eh = String(Math.floor(endMinutes / 60)).padStart(2, "0");
  const em = String(endMinutes % 60).padStart(2, "0");
  const event = await calendarCreateEvent({
    summary: `Cita Lucero (${args.appointment_type ?? "visita"}) -- pendiente de confirmar`,
    description: `Solicitada por Miguel. Teléfono: ${args.lead_phone ?? "sin teléfono"}. Vehículo: ${args.vehicle_id ?? "sin vehículo"}. ${args.notes ?? ""}`.trim(),
    startLocal: `${args.requested_date}T${hh}:${mm}:00`,
    endLocal: `${args.requested_date}T${eh}:${em}:00`,
  });

  const all = readCollection<{ id: string; google_event_id?: string }>("appointments");
  writeCollection("appointments", all.map((a) => (a.id === registered.data!.id ? { ...a, google_event_id: event.id } : a)));
  return result;
}
