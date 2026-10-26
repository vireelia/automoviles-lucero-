import { readCollection, writeCollection } from "./store.js";
import { sendWhatsapp } from "./tools/delivery.js";
import { createFollowup } from "./tools/leads.js";
import { businessInfo } from "./data/business-info.js";
import { getBusinessConfig } from "./data/business-config.js";
import { deliverEmail, sendPendingDailyCapEmails } from "./email/agent.js";
import { notifyVisitUpcoming } from "./tools/team-notify.js";

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
  team_reminder_30m_sent?: boolean;
};

// FALLO REAL detectado (21/10/2026, "no podemos perder reservas" -- el aviso
// de 30 min al equipo para la visita de las 16:30 seguía sin enviarse a las
// 17:15): `new Date("2026-10-21T16:30")` sin zona se interpreta en la zona
// LOCAL del proceso Node, y este contenedor corre en UTC, no en
// Europe/Madrid. España está en UTC+2 en octubre (CEST), así que "16:30"
// (hora real de Madrid) se leía como "16:30 UTC" = 18:30 Madrid -- cada
// recordatorio (24h/6h/1h al cliente y 30 min al equipo) disparaba con 2h de
// retraso real, después de que la visita ya hubiera pasado. Confirmado con
// team_notifications reales: la visita de las 09:30 avisó a las 09:05 UTC
// (11:05 Madrid), 1h35 tarde. Se corrige interpretando explícitamente
// requested_date+requested_time como hora de Madrid (truco de doble
// conversión vía Intl, igual de robusto en invierno con CET).
function parseAppointmentDateTime(a: Appointment): Date | null {
  if (!a.requested_date || !a.requested_time) return null;
  const guess = new Date(`${a.requested_date}T${a.requested_time}:00Z`);
  if (Number.isNaN(guess.getTime())) return null;
  const madridReading = guess.toLocaleString("sv-SE", { timeZone: "Europe/Madrid" }).replace(" ", "T") + "Z";
  const madridReadingAsUtc = new Date(madridReading).getTime();
  const offsetMs = madridReadingAsUtc - guess.getTime();
  return new Date(guess.getTime() - offsetMs);
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

// Aviso al equipo 30 min antes de cada visita (21/10/2026, petición real:
// "a Ramón y a José que sea un poco más seguido, 30 min antes de las horas
// de las visitas reales") -- independiente de los recordatorios al cliente
// de arriba: aunque la visita siga sin confirmar, Ramón/José tienen que
// saber que alguien llega en breve. Una sola vez por cita, con su propio
// flag (team_reminder_30m_sent), nunca mezclado con reminder_1h_sent del
// cliente.
function checkTeamUpcomingVisits() {
  const appointments = readCollection<Appointment>("appointments", []);
  const now = Date.now();
  let changed = false;

  for (const appt of appointments) {
    if (appt.status === "cancelled" || appt.team_reminder_30m_sent) continue;
    const when = parseAppointmentDateTime(appt);
    if (!when) continue;
    const msUntil = when.getTime() - now;
    if (msUntil <= 0) continue;

    if (withinWindow(msUntil, 0.5)) {
      void notifyVisitUpcoming({ lead_phone: appt.lead_phone ?? null, vehicle_id: appt.vehicle_id, requested_time: appt.requested_time });
      appt.team_reminder_30m_sent = true;
      changed = true;
      console.log(`[scheduler] aviso de 30 min al equipo encolado para ${appt.id}`);
    }
  }
  if (changed) writeCollection("appointments", appointments);
}

// Aviso de "buen final de día" al equipo (22/10/2026, a petición real:
// "buscar una manera de que el agente contacte al final del día... para
// que no se cierre la ventana"). Un mensaje nuestro NO reabre la ventana
// de 24h de Meta por sí solo -- solo lo hace un mensaje REAL de Ramón/José
// hacia el número del negocio. Lo que sí hace este aviso es invitar a una
// respuesta rápida (un emoji basta) -- si contestan, esa respuesta SÍ es
// un mensaje suyo real y les reabre la ventana para el día siguiente. Una
// sola vez al día, cerca del cierre de la tarde (19:30), nunca de madrugada.
const DAILY_KEEPALIVE_TARGET_MINUTES = 19 * 60 + 30; // 19:30 Madrid (a petición real)

function madridNowMinutes(): number {
  const [h, m] = new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" }).split(":").map(Number);
  return h * 60 + m;
}

function madridTodayStr(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
}

type KeepaliveState = { last_sent_date?: string };

async function checkDailyTeamKeepalive() {
  const today = madridTodayStr();
  const state = readCollection<KeepaliveState>("daily_keepalive_state", [{}]);
  if (state[0]?.last_sent_date === today) return;
  if (Math.abs(madridNowMinutes() - DAILY_KEEPALIVE_TARGET_MINUTES) > 10) return;

  const cfg = getBusinessConfig();
  const team = [
    { name: "Ramón", phone: cfg.ramonPhone },
    { name: "José", phone: cfg.josePhone },
  ];
  for (const member of team) {
    try {
      const result = await sendWhatsapp({
        lead_phone: member.phone,
        message: `Buenas tardes, ${member.name}. Todo bien por hoy -- si puedes, respóndeme aunque sea con un 👍 para que no se te cierre el WhatsApp con el sistema. ¡Buen final de día!`,
      });
      console.log(`[scheduler] keepalive de fin de día a ${member.name}: ${result.data?.delivery_status ?? "sin respuesta"}`);
    } catch (err) {
      console.error(`[scheduler] error en keepalive a ${member.name}:`, err instanceof Error ? err.message : err);
    }
  }
  writeCollection("daily_keepalive_state", [{ last_sent_date: today }]);
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
    (async () => {
      try {
        checkAppointmentReminders();
        checkTeamUpcomingVisits();
        checkStaleFollowups();
        await checkDailyTeamKeepalive();
        // FALLO REAL detectado (21/10/2026, "los chicos de Automóviles
        // Lucero no se van a poner a enviarles las cosas manuales"): el
        // backlog de correos que chocaron con el tope diario se vaciaba
        // solo si alguien entraba a Pendientes a pulsar "Enviar" a mano --
        // en la práctica nadie lo hacía. Esto lo vacía solo, respetando
        // siempre el mismo tope diario de seguridad (nunca manda de más).
        const sent = await sendPendingDailyCapEmails();
        if (sent > 0) console.log(`[scheduler] ${sent} correo(s) del backlog de tope diario enviados solos`);
      } catch (err) {
        console.error("[scheduler] error:", err);
      }
    })();
  }, CHECK_INTERVAL_MS);
  console.log(`[scheduler] activo, revisa cada ${CHECK_INTERVAL_MS / 60000} minutos`);
}
