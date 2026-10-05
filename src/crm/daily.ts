import { readCollection, writeCollection } from "../store.js";
import { listUsers } from "./auth.js";
import { deliverEmail } from "../email/agent.js";
import { currentVehicles } from "../data/vehicles-current.js";

type Appointment = { id: string; lead_phone: string | null; vehicle_id?: string; requested_date?: string; requested_time?: string; status: string };
type Reservation = { id: string; status: string; lead_phone: string | null; vehicle_id: string };

function madridNow(): { date: string; hour: number } {
  const date = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
  const hour = Number(new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hour12: false }).slice(0, 2));
  return { date, hour };
}

function vehicleName(id?: string): string {
  const v = currentVehicles().find((x) => x.id === id);
  return v ? `${v.make} ${v.model}` : "coche sin nombre";
}

// Texto del resumen en lenguaje sencillo, sin códigos ni términos técnicos.
export function buildDailySummary(date: string): string {
  const visits = readCollection<Appointment>("appointments")
    .filter((a) => a.status !== "cancelled" && a.requested_date === date)
    .sort((x, y) => (x.requested_time ?? "").localeCompare(y.requested_time ?? ""));
  const reservations = readCollection<Reservation>("reservations").filter((r) => r.status === "pending_payment" || r.status === "pending_verification");
  const lines: string[] = [];
  lines.push(`Buenos días. Este es el resumen de hoy, ${date}.`);
  lines.push("");
  if (visits.length === 0) {
    lines.push("Hoy no hay visitas.");
  } else {
    lines.push(`Hoy hay ${visits.length} ${visits.length === 1 ? "visita" : "visitas"}:`);
    for (const v of visits) {
      lines.push(`- A las ${v.requested_time ?? "?"}: ${vehicleName(v.vehicle_id)}. Cliente: ${v.lead_phone ?? "sin contacto"}. ${v.status === "confirmed" ? "Confirmada" : "Pendiente de confirmar"}.`);
    }
  }
  lines.push("");
  lines.push(reservations.length === 0 ? "No hay reservas esperando." : `Reservas por atender: ${reservations.length}. Entra en el CRM para verlas.`);
  lines.push("");
  lines.push("Automóviles Lucero");
  return lines.join("\n");
}

// Cada día, a partir de las 8:00 (hora de Madrid), se envía una vez el resumen a
// todo el equipo con acceso al CRM.
export function startDailySummary() {
  setInterval(async () => {
    const { date, hour } = madridNow();
    if (hour < 8) return;
    const sent = readCollection<{ date: string }>("crm_daily_sent");
    if (sent.some((s) => s.date === date)) return;
    writeCollection("crm_daily_sent", [...sent, { date }].slice(-30));
    const summary = buildDailySummary(date);
    for (const u of listUsers()) {
      if (!u.email) continue;
      await deliverEmail(u.email, `Visitas de hoy (${date})`, summary);
    }
  }, 10 * 60 * 1000);
}
