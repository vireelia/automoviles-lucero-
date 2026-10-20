import { appendToCollection, readCollection, writeCollection } from "../store.js";
import { envelope } from "../response.js";
import { isGoogleConnected, calendarBusy, calendarCreateEvent } from "../integrations/google.js";
import { isMadridHoliday } from "../data/holidays-madrid-2026.js";
import { withAppointmentLock } from "./appointment-lock.js";
import { notifyVisitScheduled, notifyVisitCancelled } from "./team-notify.js";
import { createAutoTask } from "./tasks.js";

function now() {
  return new Date().toISOString();
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

// Fin de semana O festivo (Comunidad/municipio de Madrid, fuente real en
// holidays-madrid-2026.ts) -- ninguno de los dos admite cita automática.
function isNonBookingDay(requested_date?: string): boolean {
  if (!requested_date) return false;
  return isWeekend(requested_date) || isMadridHoliday(requested_date);
}

function withinWeekdayWindow(minutes: number): boolean {
  return WEEKDAY_WINDOWS.some((w) => minutes >= w.start && minutes <= w.end);
}

// Sin agenda conectada, una cita nunca puede quedar "confirmed" -- como
// mucho "requested" (Sección 22: CITA != RESERVA, y no hay autoridad de
// agenda todavía). Se valida el horario confirmado para no aceptar una
// solicitud claramente fuera de lo que el negocio ya dijo que no atiende.
export async function createAppointment(args: {
  lead_phone?: string;
  vehicle_id?: string;
  appointment_type?: "visita" | "prueba" | "tasacion" | "reserva_comercial";
  requested_date?: string;
  requested_time?: string;
  notes?: string;
  // Canal de origen (20/10/2026, mejora integral del CRM, sección 11.1) --
  // nunca se sobrescribe después de creada. Se guarda vía el spread de abajo.
  channel?: string;
}) {
  const minutes = parseTime(args.requested_time);
  const nonBookingDay = isNonBookingDay(args.requested_date);

  if (nonBookingDay) {
    const appointment = {
      id: crypto.randomUUID(),
      ...args,
      status: "requested" as const,
      created_at: now(),
    };
    appendToCollection("appointments", appointment);
    await notifyVisitScheduled({ lead_phone: args.lead_phone ?? null, vehicle_id: args.vehicle_id, requested_date: args.requested_date, requested_time: args.requested_time });
    createAutoTask({
      lead_phone: args.lead_phone ?? null,
      type: "confirmar_visita",
      reason: `Confirmar visita del ${args.requested_date ?? "día por fijar"} ${args.requested_time ?? ""}.`,
      source_ref: appointment.id,
      channel: args.channel ?? null,
      due_at: args.requested_date && args.requested_time ? `${args.requested_date}T${args.requested_time}:00` : null,
    });
    return envelope({
      status: "ok",
      data: appointment,
      source: "registro interno (sin agenda real conectada)",
      conflicts: ["Fin de semana o festivo: el negocio solo atiende citas presenciales con confirmación expresa -- dejar muy claro que queda solicitada, no confirmada."],
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
  await notifyVisitScheduled({ lead_phone: args.lead_phone ?? null, vehicle_id: args.vehicle_id, requested_date: args.requested_date, requested_time: args.requested_time });
  createAutoTask({
    lead_phone: args.lead_phone ?? null,
    type: "confirmar_visita",
    reason: `Confirmar visita del ${args.requested_date ?? "día por fijar"} ${args.requested_time ?? ""}.`,
    source_ref: appointment.id,
    channel: args.channel ?? null,
    due_at: args.requested_date && args.requested_time ? `${args.requested_date}T${args.requested_time}:00` : null,
  });
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
    if (minutes !== null && !isNonBookingDay(args.requested_date ?? appt.requested_date) && !withinWeekdayWindow(minutes)) {
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

export async function cancelAppointment(args: { appointment_id: string; reason?: string }) {
  const appointments = readCollection<any>("appointments", []);
  const appt = appointments.find((a) => a.id === args.appointment_id);
  if (!appt) return envelope({ status: "not_found", error_code: "appointment_not_found" });

  appt.status = "cancelled";
  appt.cancel_reason = args.reason ?? null;
  writeCollection("appointments", appointments);
  await notifyVisitCancelled({ lead_phone: appt.lead_phone, vehicle_id: appt.vehicle_id, requested_date: appt.requested_date, requested_time: appt.requested_time });

  return envelope({ status: "ok", data: appt, source: "registro interno" });
}

// Hora/fecha real de Madrid ahora mismo, para que el agente sepa de verdad
// si está en horario comercial (necesario para decidir si intentar
// transferir o no -- Sección 5 del encargo de conexión telefónica,
// 13/10/2026: "comprobar horario laboral" antes de transferir). Nunca se le
// pide a la IA que adivine la hora -- se calcula aquí con datos reales.
export function isWithinBusinessHoursNow(): boolean {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Madrid",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  if (isNonBookingDay(dateStr)) return false;
  return withinWeekdayWindow(minutes);
}

// FALLO REAL detectado (14/10/2026): sin esto, Miguel no tenía ninguna forma
// real de saber qué día era hoy -- ni la fecha ni el día de la semana --
// así que cuando el prompt le pedía "comprueba qué día es hoy" antes de
// decidir si hoy es fin de semana/festivo, se lo inventaba (llegó a decir
// que un miércoles real era domingo). Nunca debe adivinarlo: esto se calcula
// aquí con la fecha real de Madrid y se expone en get_business_info.
const WEEKDAY_NAMES_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

export function todayInfo(): { date: string; weekday: string; is_non_booking_day_today: boolean } {
  const dateStr = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
  const weekdayIndex = new Date(`${dateStr}T12:00:00`).getDay();
  return {
    date: dateStr,
    weekday: WEEKDAY_NAMES_ES[weekdayIndex],
    is_non_booking_day_today: isNonBookingDay(dateStr),
  };
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

// Máximo de huecos que se ofrecen y hasta cuántos días laborables se mira.
const MAX_SLOTS = 6;
const MAX_DAYS_AHEAD = 10;

// Huecos reales de la agenda del negocio (Google Calendar), dentro del horario
// confirmado. Sin Google conectado, sigue devolviendo honestamente "denied"
// para que el prompt recoja la preferencia del cliente en vez de inventar.
export async function getAppointmentSlots() {
  if (!isGoogleConnected()) {
    return envelope({ status: "denied", error_code: "no_calendar_connected", data: null, source: null });
  }
  const slots: { date: string; time: string }[] = [];
  const today = new Date();
  for (let dayOffset = 0; dayOffset <= MAX_DAYS_AHEAD && slots.length < MAX_SLOTS; dayOffset++) {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() + dayOffset);
    const dateStr = day.toISOString().slice(0, 10);
    if (isNonBookingDay(dateStr)) continue;

    const dayStartMs = madridLocalToUtcMs(dateStr, WEEKDAY_WINDOWS[0].start);
    const dayEndMs = madridLocalToUtcMs(dateStr, WEEKDAY_WINDOWS[WEEKDAY_WINDOWS.length - 1].end);
    let busy: { start: string; end: string }[] = [];
    try {
      busy = await calendarBusy(new Date(dayStartMs).toISOString(), new Date(dayEndMs).toISOString());
    } catch {
      continue; // si falla la consulta de un día, se prueba con el siguiente
    }

    for (const window of WEEKDAY_WINDOWS) {
      for (let m = window.start; m + APPOINTMENT_MINUTES <= window.end && slots.length < MAX_SLOTS; m += APPOINTMENT_MINUTES) {
        const slotStart = madridLocalToUtcMs(dateStr, m);
        if (dayOffset === 0 && slotStart < Date.now() + 60 * 60000) continue; // hoy, con al menos 1h de margen
        const slotEnd = slotStart + APPOINTMENT_MINUTES * 60000;
        const overlaps = busy.some((b) => Date.parse(b.start) < slotEnd && Date.parse(b.end) > slotStart);
        if (overlaps) continue;
        slots.push({ date: dateStr, time: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}` });
      }
    }
  }
  return envelope({
    status: "ok",
    data: { slots },
    source: "agenda del negocio (Google Calendar)",
    conflicts: slots.length === 0 ? ["No hay huecos libres en los próximos días dentro del horario -- recoge la preferencia del cliente."] : [],
  });
}

// Con Google Calendar conectado: se comprueba que el hueco esté libre antes
// de registrar la cita, y si lo está se crea el evento en la agenda real del
// negocio. La cita sigue en estado "requested" -- no se confirma sola.
//
// Reserva atómica real (Sección 5, encargo de festivos/reservas 13/10/2026):
// todo el bloque comprobar-hueco + crear-cita + crear-evento corre dentro de
// withAppointmentLock, así que dos llamadas concurrentes (dos clientes
// pidiendo el mismo hueco a la vez, o una misma llamada reintentada por n8n)
// nunca pueden colarse entre la comprobación y la creación del otro -- la
// revalidación "inmediatamente antes de crear" es, de hecho, la propia
// comprobación, porque nada más puede ejecutarse mientras el lock está
// tomado. Idempotencia: si ya existe una cita no cancelada para el mismo
// teléfono+fecha+hora, se devuelve esa en vez de crear un duplicado.
export async function createAppointmentWithCalendar(args: Parameters<typeof createAppointment>[0]) {
  return withAppointmentLock(async () => {
    const existing = readCollection<{ id: string; lead_phone?: string; requested_date?: string; requested_time?: string; status: string }>(
      "appointments",
    ).find(
      (a) =>
        a.status !== "cancelled" &&
        a.lead_phone === args.lead_phone &&
        a.requested_date === args.requested_date &&
        a.requested_time === args.requested_time,
    );
    if (existing) {
      return envelope({
        status: "ok",
        data: existing,
        source: "registro interno (ya existía -- reintento detectado)",
        conflicts: [],
      });
    }

    const minutes = parseTime(args.requested_time);
    const dateOk = Boolean(args.requested_date && /^\d{4}-\d{2}-\d{2}$/.test(args.requested_date));
    if (!isGoogleConnected() || minutes === null || !dateOk || isNonBookingDay(args.requested_date)) {
      return await createAppointment(args);
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
    const result = await createAppointment(args);
    const registered = result as unknown as { status: string; data: { id: string } | null };
    if (registered.status !== "ok" || !registered.data) return result;

    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    const endMinutes = minutes + APPOINTMENT_MINUTES;
    const eh = String(Math.floor(endMinutes / 60)).padStart(2, "0");
    const em = String(endMinutes % 60).padStart(2, "0");
    // Agente que la solicitó (20/10/2026, sección 15: tres identidades) --
    // antes decía siempre "Miguel" aunque viniera de WhatsApp/correo.
    const requestedByAgent = args.channel === "VOICE" ? "Miguel" : args.channel === "EMAIL" ? "Daniel" : args.channel === "WHATSAPP" || args.channel === "CHAT" || args.channel === "FACEBOOK" ? "Carolina" : "el asistente virtual";
    const event = await calendarCreateEvent({
      summary: `Cita Lucero (${args.appointment_type ?? "visita"}) -- pendiente de confirmar`,
      description: `Solicitada por ${requestedByAgent}. Teléfono: ${args.lead_phone ?? "sin teléfono"}. Vehículo: ${args.vehicle_id ?? "sin vehículo"}. ${args.notes ?? ""}`.trim(),
      startLocal: `${args.requested_date}T${hh}:${mm}:00`,
      endLocal: `${args.requested_date}T${eh}:${em}:00`,
    });

    const all = readCollection<{ id: string; google_event_id?: string }>("appointments");
    writeCollection("appointments", all.map((a) => (a.id === registered.data!.id ? { ...a, google_event_id: event.id } : a)));
    return result;
  });
}
