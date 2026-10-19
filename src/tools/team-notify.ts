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
import { readCollection } from "../store.js";
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

async function notifyTeam(kind: AlertKind, whatsappText: string, leadPhone: string | null): Promise<void> {
  raiseAlert({ kind, lead_phone: leadPhone, reason: whatsappText });
  for (const member of TEAM) {
    try {
      const result = await sendWhatsappText(member.phone, whatsappText);
      if (!result.ok) {
        console.warn(`[team-notify] no se pudo avisar a ${member.name} por WhatsApp (${result.error}) -- queda el aviso por correo/CRM.`);
      }
    } catch (err) {
      console.warn(`[team-notify] fallo enviando WhatsApp a ${member.name}:`, err instanceof Error ? err.message : err);
    }
  }
}

export async function notifyVisitScheduled(args: {
  lead_phone: string | null;
  vehicle_id: string | null | undefined;
  requested_date: string | null | undefined;
  requested_time: string | null | undefined;
}): Promise<void> {
  const name = leadName(args.lead_phone);
  const vehicle = vehicleLabel(args.vehicle_id);
  const when = args.requested_date && args.requested_time ? `${args.requested_date} a las ${args.requested_time}` : args.requested_date || "fecha por confirmar";
  await notifyTeam(
    "visita_agendada",
    `📅 Nueva visita -- ${name} -- ${vehicle} -- ${when}`,
    args.lead_phone ?? null,
  );
}

export async function notifyVisitCancelled(args: {
  lead_phone: string | null | undefined;
  vehicle_id: string | null | undefined;
  requested_date: string | null | undefined;
  requested_time: string | null | undefined;
}): Promise<void> {
  const name = leadName(args.lead_phone);
  const vehicle = vehicleLabel(args.vehicle_id);
  const when = args.requested_date && args.requested_time ? `${args.requested_date} a las ${args.requested_time}` : args.requested_date || "sin fecha";
  await notifyTeam(
    "visita_cancelada",
    `❌ Visita cancelada -- ${name} -- ${vehicle} -- ${when}`,
    args.lead_phone ?? null,
  );
}

export async function notifyReservation(args: { lead_phone: string | null | undefined; vehicle_id: string; amount_eur: number }): Promise<void> {
  const name = leadName(args.lead_phone);
  const vehicle = vehicleLabel(args.vehicle_id);
  await notifyTeam(
    "reserva_pendiente",
    `💰 Nueva reserva -- ${name} -- ${vehicle} -- señal de ${args.amount_eur} €`,
    args.lead_phone ?? null,
  );
}
