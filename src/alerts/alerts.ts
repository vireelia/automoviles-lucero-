import crypto from "crypto";
import { appendToCollection, readCollection, writeCollection } from "../store.js";
import { listUsers } from "../crm/auth.js";
import { isGoogleConnected, sendGmail } from "../integrations/google.js";

// Avisos urgentes para Ramón y José. Cada aviso queda en el CRM (bloque de Hoy)
// hasta que alguien lo marca como atendido, y además sale por correo desde la
// cuenta del negocio si Google está conectado.
export type AlertKind = "lead_caliente" | "handoff_urgente";
export type Alert = {
  id: string;
  kind: AlertKind;
  lead_phone: string | null;
  name: string | null;
  reason: string;
  status: "pendiente" | "atendida";
  email_status: string;
  created_at: string;
  done_at: string | null;
};

// Evita repetir el mismo aviso para el mismo cliente mientras siga pendiente.
const DEDUP_HOURS = 6;

// Destinatarios: los usuarios del CRM con rol de comercial o equipo (no el administrador),
// más las direcciones de ALERT_EMAILS si se configuran.
function recipients(): string[] {
  const fromCrm = listUsers()
    .filter((u) => u.role === "comercial" || u.role === "equipo")
    .map((u) => u.email);
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
  const title = alert.kind === "lead_caliente" ? "Cliente caliente: quiere comprar ya" : "Atención urgente o reserva de 500 €";
  const body = [
    title,
    "",
    `Cliente: ${alert.name || "sin nombre"}`,
    `Teléfono: ${alert.lead_phone || "sin teléfono"}`,
    `Motivo: ${alert.reason}`,
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

export function raiseAlert(input: {
  kind: AlertKind;
  lead_phone?: string | null;
  name?: string | null;
  reason: string;
}): Alert | null {
  const since = Date.now() - DEDUP_HOURS * 3600 * 1000;
  const alerts = readCollection<Alert>("alerts");
  const repeated = alerts.some(
    (a) =>
      a.status === "pendiente" &&
      a.kind === input.kind &&
      a.lead_phone === (input.lead_phone ?? null) &&
      new Date(a.created_at).getTime() > since,
  );
  if (repeated) return null;
  const alert: Alert = {
    id: crypto.randomUUID(),
    kind: input.kind,
    lead_phone: input.lead_phone ?? null,
    name: input.name ?? null,
    reason: input.reason,
    status: "pendiente",
    email_status: "pendiente",
    created_at: new Date().toISOString(),
    done_at: null,
  };
  appendToCollection("alerts", alert);
  // No se espera al correo: el aviso ya queda registrado aunque falle el envío.
  void sendAlertEmail(alert);
  return alert;
}

export function pendingAlerts(): Alert[] {
  return readCollection<Alert>("alerts")
    .filter((a) => a.status === "pendiente")
    .sort((x, y) => x.created_at.localeCompare(y.created_at));
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
