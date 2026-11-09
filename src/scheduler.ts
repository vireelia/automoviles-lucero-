import { readCollection, writeCollection } from "./store.js";
import { sendWhatsapp } from "./tools/delivery.js";
import { createFollowup } from "./tools/leads.js";
import { businessInfo } from "./data/business-info.js";
import { getBusinessConfig } from "./data/business-config.js";
import { deliverEmail, sendPendingDailyCapEmails } from "./email/agent.js";
import { notifyVisitUpcoming } from "./tools/team-notify.js";
import { raiseAlert } from "./alerts/alerts.js";
import { googleStatus } from "./integrations/google.js";
import { createAutoTask } from "./tools/tasks.js";
import { withPersistentLockOrSkip } from "./locks.js";
import { drainN8nVozOutbox } from "./integrations/n8n.js";
import { runSeguimientoComercial } from "./chat/followup-comercial.js";

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
  channel?: string | null;
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

// FALLO REAL grave detectado (04/11/2026, "pero se lo enviaste a los
// clientes?" -- comprobado con datos reales en email_outbox: al menos 2
// recordatorios de hoy fallaron de verdad (límite real de envíos de Gmail,
// "User-rate limit exceeded") pero reminder_24h_sent/reminder_6h_sent se
// marcaban en true igual, porque el envío era "fire and forget" (void) sin
// esperar ni comprobar el resultado real). Ahora espera el resultado real y
// solo devuelve true si de verdad se entregó -- si falla, el llamador no
// marca el recordatorio como enviado, así se reintenta en el siguiente
// ciclo del scheduler en vez de darlo por hecho sin serlo.
async function sendApptReminder(appt: Appointment, message: string): Promise<boolean> {
  if (!appt.lead_phone) return false;
  if (appt.lead_phone.includes("@")) {
    const result = await deliverEmail(appt.lead_phone, "Recordatorio de tu visita -- Automóviles Lucero", `${message}\n\nAutomóviles Lucero`);
    if (result.status !== "sent") {
      console.warn(`[scheduler] recordatorio por correo falló de verdad para ${appt.id} (${appt.lead_phone}):`, result.error);
      raiseAlert({
        kind: "gestion_portal",
        lead_phone: appt.lead_phone,
        reason: `El recordatorio automático de la cita de hoy no se pudo enviar por correo (${result.error ?? "fallo real desconocido"}). Avisa al cliente a mano si hace falta.`,
      });
    }
    return result.status === "sent";
  }
  const result = await sendWhatsapp({ lead_phone: appt.lead_phone, message });
  if (result.status !== "ok") {
    console.warn(`[scheduler] recordatorio por WhatsApp falló de verdad para ${appt.id} (${appt.lead_phone})`);
    raiseAlert({
      kind: "gestion_portal",
      lead_phone: appt.lead_phone,
      reason: `El recordatorio automático de la cita de hoy no se pudo enviar por WhatsApp. Avisa al cliente a mano si hace falta.`,
    });
  }
  return result.status === "ok";
}

// Recordatorios escalonados (petición real, 20/10/2026: "también se le debe
// de recordar aunque sea 24 horas antes de que tiene una visita y unas 6
// horas antes a los de 24 horas, y si es directamente 1h antes"): el caso
// normal (cita concertada con margen de sobra) recibe 24h antes Y 6h antes;
// el caso de última hora (la cita se concierta con menos de 24h de
// antelación, así que nunca llega a cruzar esa ventana) recibe solo el de 1h
// -- nunca los tres avisos a la vez para la misma cita.
async function checkAppointmentReminders() {
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
      const ok = await sendApptReminder(appt, `Recordatorio: mañana tienes una cita en Automóviles Lucero a las ${appt.requested_time}.`);
      if (ok) {
        appt.reminder_24h_sent = true;
        changed = true;
        console.log(`[scheduler] recordatorio 24h entregado de verdad para ${appt.id}`);
      }
      continue;
    }
    if (appt.reminder_24h_sent && !appt.reminder_6h_sent && withinWindow(msUntil, businessInfo.reminder.hours_before.mid)) {
      const ok = await sendApptReminder(appt, `Recordatorio: hoy tienes una cita en Automóviles Lucero a las ${appt.requested_time}.`);
      if (ok) {
        appt.reminder_6h_sent = true;
        changed = true;
        console.log(`[scheduler] recordatorio 6h entregado de verdad para ${appt.id}`);
      }
      continue;
    }
    if (!appt.reminder_24h_sent && !appt.reminder_1h_sent && withinWindow(msUntil, businessInfo.reminder.hours_before.short)) {
      const ok = await sendApptReminder(appt, `Recordatorio: en 1 hora tienes una cita en Automóviles Lucero (a las ${appt.requested_time}).`);
      if (ok) {
        appt.reminder_1h_sent = true;
        changed = true;
        console.log(`[scheduler] recordatorio 1h (cita de última hora) entregado de verdad para ${appt.id}`);
      }
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

// Pedido real (03/11/2026, "como podemos poner avisos en el sistema, para
// cuando haya algún error" -- tras un incidente real del mismo día en el
// que la IA y Google estuvieron caídos horas sin que nadie se enterara
// hasta que un cliente real se quejó): comprueba cada CHECK_INTERVAL_MS
// (5 min) las mismas señales reales ya construidas hoy (email_poller_errors,
// whatsapp_errors, estado de Google, correos reales que la IA no pudo
// contestar) y avisa a Ramón/José por el mismo canal real de siempre
// (notifyTeam vía raiseAlert) en cuanto algo falla -- en vez de que lo
// descubran por un cliente enfadado horas después. Dedup real ya incluido
// en raiseAlert (DEDUP_HOURS=6, mismo motivo exacto no se repite).
let lastCheckedAt = new Date().toISOString();
async function checkTechnicalHealth() {
  const now = new Date().toISOString();
  const since = lastCheckedAt;
  lastCheckedAt = now;

  if (!googleStatus().connected) {
    raiseAlert({
      kind: "fallo_tecnico",
      lead_phone: null,
      reason: "Google (Gmail/Calendar) está desconectado -- Daniel no puede leer ni enviar correos hasta que se reconecte en /crm/integraciones.",
    });
  }

  const pollerErrors = readCollection<{ at: string }>("email_poller_errors").filter((e) => e.at > since);
  if (pollerErrors.length > 0) {
    raiseAlert({
      kind: "fallo_tecnico",
      lead_phone: null,
      reason: `El sondeo de correo está fallando (${pollerErrors.length} error(es) real(es) recientes) -- revisa /debug/email_poller_errors.`,
    });
  }

  const whatsappErrors = readCollection<{ at: string }>("whatsapp_errors").filter((e) => e.at > since);
  if (whatsappErrors.length > 0) {
    raiseAlert({
      kind: "fallo_tecnico",
      lead_phone: null,
      reason: `WhatsApp está fallando al procesar mensajes reales (${whatsappErrors.length} error(es) recientes) -- revisa /debug/whatsapp_errors.`,
    });
  }

  const iaFallidos = readCollection<{ outcome: string; created_at: string }>("email_inbox").filter(
    (m) => m.outcome === "fallo_ia_pendiente_revision" && m.created_at > since,
  );
  if (iaFallidos.length > 0) {
    raiseAlert({
      kind: "fallo_tecnico",
      lead_phone: null,
      reason: `El asistente de IA está fallando -- ${iaFallidos.length} correo(s) real(es) de clientes se quedaron sin respuesta (posible problema de créditos/cuota en OpenAI). Revisa la cuenta de OpenAI.`,
    });
  }
}

// FASE 11 (09/11/2026): una confirmación por WhatsApp no es una visita
// realizada. Resultado real antes de esto: 1 de 202 visitas tenía resultado
// registrado, así que no se podía medir ninguna conversión. Pasadas
// HORAS_TRAS_VISITA de la hora de la cita, si sigue en "confirmed" nadie ha
// dicho todavía qué pasó -- se crea una tarea para que Ramón o José lo
// marquen. Nunca se asume que el cliente no vino.
const HORAS_TRAS_VISITA = 2;
function checkVisitOutcomes() {
  const appointments = readCollection<Appointment>("appointments", []);
  const now = Date.now();
  for (const appt of appointments) {
    if (appt.status !== "confirmed") continue;
    const when = parseAppointmentDateTime(appt);
    if (!when) continue;
    const horas = (now - when.getTime()) / 3600_000;
    if (horas < HORAS_TRAS_VISITA || horas > 72) continue; // nunca reabrir visitas muy antiguas
    createAutoTask({
      lead_phone: appt.lead_phone ?? null,
      type: "verificar_asistencia",
      reason: `La visita del ${appt.requested_date ?? ""} a las ${appt.requested_time ?? ""} ya pasó y nadie ha registrado si el cliente vino. Márcalo en Citas: "Vino", "Vino y compró" o "No se presentó".`,
      source_ref: appt.id,
      channel: appt.channel ?? null,
    });
  }
}

export function startScheduler() {
  setInterval(() => {
    (async () => {
      // Bloqueo en disco (09/11/2026): con dos procesos, los dos recorrerían
      // las citas a la vez y el mismo recordatorio podría salir dos veces al
      // cliente (la marca reminder_24h_sent se escribe DESPUÉS de enviar).
      // Si otro proceso ya está en el ciclo, este se salta.
      const tomado = await withPersistentLockOrSkip("scheduler_tick", async () => {
      try {
        await checkAppointmentReminders();
        checkTeamUpcomingVisits();
        // Desactivado (03/11/2026, "quita los avisos" -- ya sabe que la IA
        // está fallando por los créditos de OpenAI, no hace falta que el
        // sistema se lo siga avisando por este canal mientras lo resuelve).
        // No se borra el código -- reactivar cuando quiera volver a recibir
        // estos avisos de salud técnica.
        // await checkTechnicalHealth();
        // Desactivado (28/10/2026, "elimínalos por ahora" -- fallo real:
        // el aviso de "nos han entrado coches nuevos" se mandaba cada
        // STALE_DAYS a CUALQUIER lead inactivo, sin comprobar si ya había
        // comprado el coche. No se borra el código -- hace falta excluir
        // a los clientes que ya compraron (y revisar el intervalo real)
        // antes de volver a activarlo.
        // checkStaleFollowups();
        // Sustituto arreglado del seguimiento de arriba (FASE 6, 09/11/2026):
        // solo clientes con intención comercial comprobada, máximo 2, texto
        // fijo sin IA, nunca si ya hay cita o reserva. Apagado salvo
        // LUCERO_FOLLOWUP_ENABLED=1.
        checkVisitOutcomes();
        const seg = await runSeguimientoComercial();
        if (seg.enviados > 0) console.log(`[scheduler] ${seg.enviados} seguimiento(s) comercial(es) enviados`);
        await checkDailyTeamKeepalive();
        // FALLO REAL detectado (21/10/2026, "los chicos de Automóviles
        // Lucero no se van a poner a enviarles las cosas manuales"): el
        // backlog de correos que chocaron con el tope diario se vaciaba
        // solo si alguien entraba a Pendientes a pulsar "Enviar" a mano --
        // en la práctica nadie lo hacía. Esto lo vacía solo, respetando
        // siempre el mismo tope diario de seguridad (nunca manda de más).
        const sent = await sendPendingDailyCapEmails();
        if (sent > 0) console.log(`[scheduler] ${sent} correo(s) del backlog de tope diario enviados solos`);
        // Reintento del aviso de voz a n8n (quien crea el lead con origen
        // VOZ): sin esto, un fallo de n8n dejaba al cliente sin lead.
        const vozReenviados = await drainN8nVozOutbox();
        if (vozReenviados > 0) console.log(`[scheduler] ${vozReenviados} aviso(s) de voz reenviados a n8n`);
      } catch (err) {
        console.error("[scheduler] error:", err);
      }
      });
      if (tomado === null) console.log("[scheduler] otro proceso ya está en el ciclo, se salta este.");
    })();
  }, CHECK_INTERVAL_MS);
  console.log(`[scheduler] activo, revisa cada ${CHECK_INTERVAL_MS / 60000} minutos`);
}
