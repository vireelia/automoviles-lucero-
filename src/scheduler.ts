import { readCollection, writeCollection } from "./store.js";
import { sendWhatsapp } from "./tools/delivery.js";
import { createFollowup } from "./tools/leads.js";
import { businessInfo } from "./data/business-info.js";
import { deliverEmail } from "./email/agent.js";

// Automatizaciones internas (Sección 46 del encargo: 09_APPOINTMENT_REMINDER_2H
// y 21_FOLLOWUP_SEQUENCE). Un único proceso Node ya corre 24/7 (este mismo
// backend), así que un setInterval basta -- no hace falta un cron externo
// para este volumen. Todo lo que "envía" sigue devolviendo honestamente
// "queued" (ver delivery.ts) hasta que haya integración real de WhatsApp --
// esto deja la automatización lista para el día que se conecte, sin tener
// que tocar esta lógica otra vez.

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // cada 5 minutos

type Appointment = {
  id: string;
  lead_phone?: string;
  vehicle_id?: string;
  requested_date?: string;
  requested_time?: string;
  status: string;
  reminder_24h_sent?: boolean;
  reminder_6h_sent?: boolean;
  reminder_1h_sent?: boolean;
};

function parseAppointmentDateTime(a: Appointment): Date | null {
  if (!a.requested_date || !a.requested_time) return null;
  const iso = `${a.requested_date}T${a.requested_time}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Ventana de disparo de cada aviso: ±10 minutos sobre el objetivo exacto, para
// no depender de que el intervalo de comprobación (cada 5 min) caiga justo en
// el minuto exacto.
function withinWindow(msUntil: number, hoursBefore: number): boolean {
  const target = hoursBefore * 60 * 60 * 1000;
  const tolerance = 10 * 60 * 1000;
  return msUntil <= target + tolerance && msUntil >= target - tolerance;
}

function sendApptReminder(appt: Appointment, message: string) {
  if (!appt.lead_phone) return;
  if (appt.lead_phone.includes("@")) {
    void deliverEmail(appt.lead_phone, "Recordatorio de tu visita -- Automóviles Lucero", `${message}\n\nAutomóviles Lucero`);
  } else {
    void sendWhatsapp({ lead_phone: appt.lead_phone, message });
  }
}

// Recordatorios escalonados (petición real, 20/10/2026: "también se le debe
// de recordar aunque sea 24 horas antes de que tiene una visita y unas 6
// horas antes a los de 24 horas, y si es directamente 1h antes"): el caso
// normal (cita concertada con margen de sobra) recibe 24h antes Y 6h antes;
// el caso de última hora (la cita se concierta con menos de 24h de
// antelación, así que nunca llega a cruzar esa ventana) recibe solo el de 1h
// -- nunca los tres avisos a la vez para la misma cita.
function checkAppointmentReminders() {
  const appointments = readCollection<Appointment>("appointments", []);
  const now = Date.now();
  let changed = false;

  for (const appt of appointments) {
    if (appt.status === "cancelled") continue;
    const when = parseAppointmentDateTime(appt);
    if (!when) continue;
    const msUntil = when.getTime() - now;
    if (msUntil <= 0) continue;

    if (!appt.reminder_24h_sent && withinWindow(msUntil, businessInfo.reminder.hours_before.long)) {
      sendApptReminder(appt, `Recordatorio: mañana tienes una cita en Automóviles Lucero a las ${appt.requested_time}.`);
      appt.reminder_24h_sent = true;
      changed = true;
      console.log(`[scheduler] recordatorio 24h encolado para ${appt.id}`);
      continue;
    }
    if (appt.reminder_24h_sent && !appt.reminder_6h_sent && withinWindow(msUntil, businessInfo.reminder.hours_before.mid)) {
      sendApptReminder(appt, `Recordatorio: hoy tienes una cita en Automóviles Lucero a las ${appt.requested_time}.`);
      appt.reminder_6h_sent = true;
      changed = true;
      console.log(`[scheduler] recordatorio 6h encolado para ${appt.id}`);
      continue;
    }
    if (!appt.reminder_24h_sent && !appt.reminder_1h_sent && withinWindow(msUntil, businessInfo.reminder.hours_before.short)) {
      sendApptReminder(appt, `Recordatorio: en 1 hora tienes una cita en Automóviles Lucero (a las ${appt.requested_time}).`);
      appt.reminder_1h_sent = true;
      changed = true;
      console.log(`[scheduler] recordatorio 1h (cita de última hora) encolado para ${appt.id}`);
    }
  }
  if (changed) writeCollection("appointments", appointments);
}

type Lead = {
  id: string;
  phone: string | null;
  do_not_contact: boolean;
  followup_count: number;
  updated_at: string;
  temperature: string;
};

const STALE_DAYS = 3;

function checkStaleFollowups() {
  const leads = readCollection<Lead>("leads", []);
  const now = Date.now();
  const maxFollowups = businessInfo.followups.max_automatic;

  for (const lead of leads) {
    if (lead.do_not_contact || !lead.phone) continue;
    if (lead.followup_count >= maxFollowups) continue;
    const daysSinceUpdate = (now - new Date(lead.updated_at).getTime()) / (1000 * 60 * 60 * 24);
    // Se dispara cada STALE_DAYS a partir del último contacto -- createFollowup
    // ya lleva la cuenta y updated_at se actualiza al crear uno, así que el
    // siguiente ciclo espera otros STALE_DAYS de forma natural.
    if (daysSinceUpdate >= STALE_DAYS) {
      const result = createFollowup({ phone: lead.phone, reason: "seguimiento automático (sin compra tras contacto inicial)" });
      if (result.status === "ok") {
        const message = "Hola, nos han entrado coches nuevos -- si sigues buscando, échale un ojo a nuestro catálogo.";
        if (lead.phone.includes("@")) {
          void deliverEmail(lead.phone, "Novedades en Automóviles Lucero", `${message}\n\nAutomóviles Lucero`);
        } else {
          sendWhatsapp({ lead_phone: lead.phone, message });
        }
        console.log(`[scheduler] seguimiento automático encolado para lead ${lead.id}`);
      }
    }
  }
}

export function startScheduler() {
  setInterval(() => {
    try {
      checkAppointmentReminders();
      checkStaleFollowups();
    } catch (err) {
      console.error("[scheduler] error:", err);
    }
  }, CHECK_INTERVAL_MS);
  console.log(`[scheduler] activo, revisa cada ${CHECK_INTERVAL_MS / 60000} minutos`);
}
