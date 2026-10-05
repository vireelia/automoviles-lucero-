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
  reminder_sent?: boolean;
};

function parseAppointmentDateTime(a: Appointment): Date | null {
  if (!a.requested_date || !a.requested_time) return null;
  const iso = `${a.requested_date}T${a.requested_time}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function checkAppointmentReminders() {
  const appointments = readCollection<Appointment>("appointments", []);
  const now = Date.now();
  let changed = false;

  for (const appt of appointments) {
    if (appt.status === "cancelled" || appt.reminder_sent) continue;
    const when = parseAppointmentDateTime(appt);
    if (!when) continue;
    const msUntil = when.getTime() - now;
    // Ventana de disparo: entre 1h50 y 2h10 antes, para no depender de que el
    // intervalo caiga justo en el minuto exacto.
    if (msUntil > 0 && msUntil <= businessInfo.reminder.hours_before * 60 * 60 * 1000 + 10 * 60 * 1000 && msUntil >= businessInfo.reminder.hours_before * 60 * 60 * 1000 - 10 * 60 * 1000) {
      if (appt.lead_phone) {
        sendWhatsapp({ lead_phone: appt.lead_phone, message: `Recordatorio: tienes una cita en Automóviles Lucero hoy a las ${appt.requested_time}.` });
      }
      appt.reminder_sent = true;
      changed = true;
      console.log(`[scheduler] recordatorio de cita encolado para ${appt.id}`);
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
