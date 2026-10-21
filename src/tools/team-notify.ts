// Aviso directo a Ramón y José (19/10/2026, a petición real: "que la gente
// de WhatsApp... le tenemos que enviar una señal... para recordarle la
// visita, la reserva"). Solo para lo que de verdad importa -- una visita
// real agendada o cancelada, o una reserva de 500 € -- nunca para avisos
// genéricos (eso ya lo decide cada sitio que llama a raiseAlert() con otro
// kind).
//
// Dos canales SIEMPRE, nunca solo uno: WhatsApp (mejor esfuerzo -- Meta solo
// permite texto libre si Ramón/José ya escribieron antes al número del
// negocio dentro de las últimas 24h, ver integrations/zernio.ts) y correo
// (raiseAlert, canal ya probado y fiable, con el aviso visible también en
// el CRM). Si WhatsApp falla, el aviso igualmente queda registrado por
// correo -- nunca se pierde en silencio solo porque la ventana de WhatsApp
// no estuviera abierta.
import crypto from "crypto";
import { readCollection, appendToCollection } from "../store.js";
import { businessInfo } from "../data/business-info.js";
import { raiseAlert, type AlertKind } from "../alerts/alerts.js";
import { sendWhatsappText } from "../integrations/whatsapp.js";
import { currentVehicles } from "../data/vehicles-current.js";

const TEAM: { name: string; phone: string }[] = [
  { name: "Ramón", phone: businessInfo.responsables.ramon.transfer_number },
  { name: "José", phone: businessInfo.responsables.jose.transfer_number },
];

function leadName(phone: string | null | undefined): string {
  if (!phone) return "sin nombre";
  const lead = readCollection<{ phone: string | null; name: string | null }>("leads").find((l) => l.phone === phone);
  return lead?.name?.trim() || "sin nombre";
}

function vehicleLabel(vehicleId: string | null | undefined): string {
  if (!vehicleId) return "sin vehículo indicado";
  const v = currentVehicles().find((x) => x.id === vehicleId);
  return v ? `${v.make} ${v.model} ${v.version}` : vehicleId;
}

// FALLO REAL detectado (21/10/2026, "tenemos que notificar aparte del CRM, a
// Ramón y a José, siempre siempre"): hasta ahora, si el WhatsApp a Ramón o
// José fallaba, solo quedaba un console.warn -- invisible, nadie en el
// equipo podía comprobar después si de verdad les llegó o no. Ahora cada
// intento (a cada uno de los dos, por separado) queda registrado en
// "team_notifications", igual que whatsapp_queue para clientes -- consultable
// vía /debug/team_notifications.
async function notifyTeam(kind: AlertKind, whatsappText: string, leadPhone: string | null): Promise<void> {
  raiseAlert({ kind, lead_phone: leadPhone, reason: whatsappText });
  for (const member of TEAM) {
    try {
      const result = await sendWhatsappText(member.phone, whatsappText);
      appendToCollection("team_notifications", {
        id: crypto.randomUUID(),
        kind,
        to_name: member.name,
        to_phone: member.phone,
        lead_phone: leadPhone,
        message: whatsappText,
        delivery_status: result.ok ? "sent" : "failed",
        error: result.ok ? null : result.error,
        created_at: new Date().toISOString(),
      });
      if (!result.ok) {
        console.warn(`[team-notify] no se pudo avisar a ${member.name} por WhatsApp (${result.error}) -- queda el aviso por correo/CRM.`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      appendToCollection("team_notifications", {
        id: crypto.randomUUID(),
        kind,
        to_name: member.name,
        to_phone: member.phone,
        lead_phone: leadPhone,
        message: whatsappText,
        delivery_status: "failed",
        error,
        created_at: new Date().toISOString(),
      });
      console.warn(`[team-notify] fallo enviando WhatsApp a ${member.name}:`, error);
    }
  }
}

// FALLO REAL detectado (21/10/2026, "¿estás enviando mensajes al teléfono de
// Ramón y José... con el número de los clientes?"): los tres avisos llevaban
// fecha y datos del vehículo, pero nunca el teléfono real del cliente -- solo
// el nombre (a menudo "sin nombre", sobre todo en leads de coches.net sin
// nombre capturado). Ramón/José tenían que abrir el CRM solo para poder
// llamar de vuelta. contactLine lo añade siempre, con el nombre si lo hay.
function contactLine(phone: string | null | undefined, name: string): string {
  if (!phone) return name;
  return name === "sin nombre" ? phone : `${name} (${phone})`;
}

// Aviso al equipo 30 min antes de cada visita (21/10/2026, petición real:
// "a Ramón y a José que sea un poco más seguido, 30 min antes de las horas
// de las visitas reales") -- distinto del recordatorio al cliente
// (scheduler.ts, 24h/6h/1h): este es solo para que Ramón/José sepan que
// alguien llega en breve, aunque la visita nunca se haya confirmado.
export async function notifyVisitUpcoming(args: {
  lead_phone: string | null | undefined;
  vehicle_id: string | null | undefined;
  requested_time: string | null | undefined;
}): Promise<void> {
  const contact = contactLine(args.lead_phone, leadName(args.lead_phone));
  const vehicle = vehicleLabel(args.vehicle_id);
  await notifyTeam(
    "visita_proxima",
    `⏰ En 30 min: visita de ${contact} -- ${vehicle} -- hoy a las ${args.requested_time ?? "?"}`,
    args.lead_phone ?? null,
  );
}

export async function notifyVisitScheduled(args: {
  lead_phone: string | null;
  vehicle_id: string | null | undefined;
  requested_date: string | null | undefined;
  requested_time: string | null | undefined;
}): Promise<void> {
  const contact = contactLine(args.lead_phone, leadName(args.lead_phone));
  const vehicle = vehicleLabel(args.vehicle_id);
  const when = args.requested_date && args.requested_time ? `${args.requested_date} a las ${args.requested_time}` : args.requested_date || "fecha por confirmar";
  await notifyTeam(
    "visita_agendada",
    `📅 Nueva visita -- ${contact} -- ${vehicle} -- ${when}`,
    args.lead_phone ?? null,
  );
}

export async function notifyVisitCancelled(args: {
  lead_phone: string | null | undefined;
  vehicle_id: string | null | undefined;
  requested_date: string | null | undefined;
  requested_time: string | null | undefined;
}): Promise<void> {
  const contact = contactLine(args.lead_phone, leadName(args.lead_phone));
  const vehicle = vehicleLabel(args.vehicle_id);
  const when = args.requested_date && args.requested_time ? `${args.requested_date} a las ${args.requested_time}` : args.requested_date || "sin fecha";
  await notifyTeam(
    "visita_cancelada",
    `❌ Visita cancelada -- ${contact} -- ${vehicle} -- ${when}`,
    args.lead_phone ?? null,
  );
}

export async function notifyReservation(args: { lead_phone: string | null | undefined; vehicle_id: string; amount_eur: number }): Promise<void> {
  const contact = contactLine(args.lead_phone, leadName(args.lead_phone));
  const vehicle = vehicleLabel(args.vehicle_id);
  await notifyTeam(
    "reserva_pendiente",
    `💰 Nueva reserva -- ${contact} -- ${vehicle} -- señal de ${args.amount_eur} €`,
    args.lead_phone ?? null,
  );
}
