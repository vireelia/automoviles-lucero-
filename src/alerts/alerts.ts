import crypto from "crypto";
import { appendToCollection, readCollection, writeCollection } from "../store.js";
import { listUsers } from "../crm/auth.js";
import { isGoogleConnected, sendGmail } from "../integrations/google.js";

// Avisos urgentes para Ramón y José. Cada aviso queda en el CRM (bloque de Hoy)
// hasta que alguien lo marca como atendido, y además sale por correo desde la
// cuenta del negocio si Google está conectado.
export type AlertKind = "lead_caliente" | "handoff_urgente" | "reserva_pendiente" | "gestion_portal" | "visita_agendada" | "visita_cancelada" | "visita_proxima";
export type Alert = {
  id: string;
  kind: AlertKind;
  lead_phone: string | null;
  name: string | null;
  // Canal real de origen (27/10/2026, "marca de donde viene como te dije")
  // -- antes estas alertas (reserva/visita/handoff) no decían por dónde
  // había llegado el cliente, a diferencia de las de Coches.net/Wallapop
  // (que sí lo llevan dentro del propio texto del motivo).
  channel: string | null;
  reason: string;
  // draft_note (15/10/2026, a petición real -- "qué podemos hacer para
  // mejorar eso" sobre Wallapop: no hay API de mensajería para responder
  // automáticamente dentro de su app, así que la mejora real posible es que
  // el equipo se entere al instante y ya tenga el texto listo para pegar,
  // en vez de depender de que alguien mire Pendientes por su cuenta.
  draft_note: string | null;
  status: "pendiente" | "atendida";
  email_status: string;
  created_at: string;
  done_at: string | null;
};

// Evita repetir el mismo aviso para el mismo cliente mientras siga pendiente.
// FALLO GRAVÍSIMO detectado (21/10/2026, caso real de Ignacio): pidió visita
// para el 20/10 a las 11:30 (alerta real creada y enviada), y poco después
// (misma mañana, dentro de esta misma ventana de 6h) la REPROGRAMÓ al 21/10
// a las 09:30 -- create_appointment volvió a llamar a raiseAlert con el
// motivo nuevo, pero como ya había una alerta "pendiente" del mismo tipo
// para el mismo teléfono dentro de las 6h, se descartó en silencio sin
// crear la nueva. Resultado real: Ramón/José solo llegaron a saber de la
// hora VIEJA (que ya no aplicaba) y nunca de la hora real -- el cliente se
// presentó esta mañana ("Estoy aquí") sin que quedara ningún aviso nuevo en
// el CRM para esa cita. El dedup solo tiene sentido para evitar RUIDO
// (reintentos exactos del mismo aviso) -- nunca para tragarse información
// nueva real (otra fecha/hora). Por eso ahora exige también que el motivo
// sea literalmente el mismo texto, no solo el mismo tipo+teléfono.
const DEDUP_HOURS = 6;

// Destinatarios: TODOS los usuarios reales del CRM, más las direcciones de
// ALERT_EMAILS si se configuran.
// FALLO GRAVÍSIMO detectado (27/10/2026, dato real de producción): esto
// excluía a propósito a los administradores -- pero la cuenta real de
// Ramón y José en este CRM ES "admin" (automovileslucero@gmail.com), y su
// WhatsApp nunca puede recibir estos avisos (ver team-notify.ts: su número
// personal ES el número del negocio). Resultado real confirmado: 15 de 15
// avisos por WhatsApp a Ramón fallaron, y el correo -- su único respaldo
// real -- nunca se les enviaba tampoco por este filtro. Solo le llegaba a
// Rubén (equipo). Ahora todos los roles reciben el correo de respaldo.
function recipients(): string[] {
  const fromCrm = listUsers().map((u) => u.email);
  const fromEnv = (process.env.ALERT_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...fromCrm, ...fromEnv])];
}

function setEmailStatus(id: string, status: string) {
  const all = readCollection<Alert>("alerts");
  writeCollection<Alert>("alerts", all.map((a) => (a.id === id ? { ...a, email_status: status } : a)));
}

async function sendAlertEmail(alert: Alert) {
  const to = recipients();
  if (to.length === 0) return setEmailStatus(alert.id, "sin_destinatarios");
  if (!isGoogleConnected()) return setEmailStatus(alert.id, "sin_correo_conectado");
  const title =
    alert.kind === "lead_caliente"
      ? "Cliente caliente: quiere comprar ya"
      : alert.kind === "reserva_pendiente"
        ? "RESERVA de 500 € -- gestionar cobro"
        : alert.kind === "gestion_portal"
          ? "Responder en la app -- el correo no llega"
          : alert.kind === "visita_agendada"
            ? "Nueva visita agendada"
            : alert.kind === "visita_cancelada"
              ? "Visita cancelada"
              : "Atención urgente";
  const body = [
    title,
    "",
    `Cliente: ${alert.name || "sin nombre"}`,
    `Teléfono: ${alert.lead_phone || "sin teléfono"}`,
    `Motivo: ${alert.reason}`,
    ...(alert.draft_note ? ["", "Texto listo para copiar y pegar en la app:", "---", alert.draft_note, "---"] : []),
    "",
    "Llámale cuanto antes. Lo tienes en el CRM, en la pantalla Hoy:",
    "https://virelia-hub-lucero.lzc0bh.easypanel.host/crm",
  ].join("\n");
  try {
    for (const address of to) {
      await sendGmail(address, `[Lucero] ${title}`, body);
    }
    setEmailStatus(alert.id, "enviado");
  } catch (err) {
    console.error("[alertas] correo:", err instanceof Error ? err.message : err);
    setEmailStatus(alert.id, "error");
  }
}

// FALLO REAL detectado (21/10/2026, "esto de llamar ya no entiendo qué
// significa... no sé a qué 84 clientes tengo que llamar ya"): el banner
// "Llamar ya" del Hoy cuenta TODAS las alertas "pendiente", incluyendo
// avisos puramente informativos que notifyTeam ya manda por WhatsApp/correo
// en el momento (nueva visita agendada, recordatorio de 30 min, visita
// cancelada) -- esos no necesitan que nadie los "atienda" aparte, ya
// cumplieron su función al enviarse, y como nadie los marcaba nunca se
// acumulaban sin parar hasta inflar el número a 84 sin que hubiera 84
// llamadas reales pendientes. Se resuelven solos al crearse -- siguen
// quedando registrados (para el correo de respaldo y la Papelera), solo
// que no cuentan como "pendiente de llamar".
const SELF_RESOLVING_KINDS: AlertKind[] = ["visita_agendada", "visita_proxima", "visita_cancelada"];

export function raiseAlert(input: {
  kind: AlertKind;
  lead_phone?: string | null;
  name?: string | null;
  channel?: string | null;
  reason: string;
  draft_note?: string | null;
}): Alert | null {
  const since = Date.now() - DEDUP_HOURS * 3600 * 1000;
  const alerts = readCollection<Alert>("alerts");
  const repeated = alerts.some(
    (a) =>
      a.status === "pendiente" &&
      a.kind === input.kind &&
      a.lead_phone === (input.lead_phone ?? null) &&
      a.reason === input.reason &&
      new Date(a.created_at).getTime() > since,
  );
  if (repeated) return null;
  const selfResolving = SELF_RESOLVING_KINDS.includes(input.kind);
  const alert: Alert = {
    id: crypto.randomUUID(),
    kind: input.kind,
    lead_phone: input.lead_phone ?? null,
    name: input.name ?? null,
    channel: input.channel ?? null,
    reason: input.reason,
    draft_note: input.draft_note ?? null,
    status: selfResolving ? "atendida" : "pendiente",
    email_status: "pendiente",
    created_at: new Date().toISOString(),
    done_at: selfResolving ? new Date().toISOString() : null,
  };
  appendToCollection("alerts", alert);
  // No se espera al correo: el aviso ya queda registrado aunque falle el envío.
  void sendAlertEmail(alert);
  return alert;
}

// FALLO REAL detectado (23/10/2026, petición real: "estos clientes que
// aparecen de ultimo, con la fecha, que aparezcan primeros, porque arriba
// salen solo los antiguos"): ordenaba de más antiguo a más reciente -- lo
// más urgente (lo que acaba de llegar) quedaba enterrado al final de la
// lista. Mismo criterio que el resto del CRM (más reciente primero).
export function pendingAlerts(): Alert[] {
  return readCollection<Alert>("alerts")
    .filter((a) => a.status === "pendiente")
    .sort((x, y) => y.created_at.localeCompare(x.created_at));
}

export function markAlertDone(id: string): boolean {
  const all = readCollection<Alert>("alerts");
  if (!all.some((a) => a.id === id)) return false;
  writeCollection<Alert>(
    "alerts",
    all.map((a) => (a.id === id ? { ...a, status: "atendida", done_at: new Date().toISOString() } : a)),
  );
  return true;
}

// Borrado real (13/10/2026), para alertas de prueba -- "atendida" las deja
// registradas igualmente, esto las quita del todo.
export function deleteAlert(id: string): boolean {
  const all = readCollection<Alert>("alerts");
  if (!all.some((a) => a.id === id)) return false;
  writeCollection<Alert>("alerts", all.filter((a) => a.id !== id));
  return true;
}
