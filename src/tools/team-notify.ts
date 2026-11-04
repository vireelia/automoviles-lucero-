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
import { getBusinessConfig } from "../data/business-config.js";
import { raiseAlert, type AlertKind } from "../alerts/alerts.js";
import { sendWhatsappText } from "../integrations/whatsapp.js";
import { sendTeamAlertViaTemplate } from "../integrations/zernio.js";
import { currentVehicles } from "../data/vehicles-current.js";
import { callUrgentAlert } from "../integrations/twilio-voice.js";

// Solo para esto se llama por voz si falla el WhatsApp (22/10/2026, caso
// real de Ramón: el número de WhatsApp del negocio ES su número personal,
// avisarle a él por WhatsApp desde esa misma cuenta nunca puede funcionar
// -- se estaría enviando un mensaje de su cuenta a su propia cuenta. La
// llamada no depende de ninguna ventana ni cuenta, así que es el único
// canal que de verdad siempre llega -- pero solo para lo urgente de
// verdad, nunca para un recordatorio rutinario de visita.
// fallo_tecnico añadido (03/11/2026, pedido real: "como podemos poner
// avisos en el sistema, para cuando haya algún error" -- incidente real
// del mismo día en el que ni WhatsApp ni correo llegaron a Ramón/José
// durante horas): un fallo técnico real (IA caída, Google desconectado)
// significa clientes reales sin respuesta -- es tan urgente como un
// handoff, merece el mismo respaldo de llamada si el WhatsApp falla.
const URGENT_ALERT_KINDS: AlertKind[] = ["handoff_urgente", "reserva_pendiente", "lead_caliente", "fallo_tecnico"];

// Alcance real reducido (04/11/2026, "envia solo avisos por whassap a ramon
// y jose de visitas y reservas solo eso"): el aviso por WhatsApp a Ramón/José
// ahora solo se envía para visitas y reservas reales -- el resto de tipos
// (handoff_urgente, lead_caliente, fallo_tecnico) siguen quedando
// registrados en el CRM (raiseAlert ya lo hace siempre) pero ya no generan
// ningún WhatsApp ni llamada de voz por este canal.
const VISIT_RESERVATION_KINDS: AlertKind[] = ["visita_agendada", "visita_cancelada", "visita_proxima", "reserva_pendiente"];

// Se lee en cada aviso, no en un const de módulo (26/10/2026) -- así un
// teléfono editado desde Ajustes se usa al momento, sin reiniciar el proceso.
function team(): { name: string; phone: string }[] {
  const cfg = getBusinessConfig();
  return [
    { name: "Ramón", phone: cfg.ramonPhone },
    { name: "José", phone: cfg.josePhone },
  ];
}

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
// Pedido real (03/11/2026, "los errores del sistema que me lleguen a mí"):
// los fallos técnicos reales (IA caída, Google desconectado, sondeo
// fallando) son distintos de los avisos normales de negocio (visita,
// reserva) -- este número extra solo recibe la categoría fallo_tecnico,
// nunca el resto, para no mezclarse con los avisos reales de Ramón/José.
// Variable de entorno, nunca hardcodeado en el código (mismo criterio que
// el resto de números/credenciales reales de este proyecto).
function technicalAlertExtraRecipient(): { name: string; phone: string } | null {
  const phone = process.env.TECHNICAL_ALERT_PHONE?.trim();
  return phone ? { name: "Aviso técnico", phone } : null;
}

async function notifyTeam(kind: AlertKind, whatsappText: string, leadPhone: string | null, name?: string | null, channel?: string | null): Promise<void> {
  raiseAlert({ kind, lead_phone: leadPhone, name: name ?? null, channel: channel ?? null, reason: whatsappText });
  // El aviso ya queda registrado en el CRM (raiseAlert, arriba) para TODOS
  // los tipos -- pero el envío real por WhatsApp/llamada solo se dispara
  // para visitas y reservas (petición real 04/11/2026, ver
  // VISIT_RESERVATION_KINDS).
  if (!VISIT_RESERVATION_KINDS.includes(kind)) return;
  const extra = technicalAlertExtraRecipient();
  const recipients = kind === "fallo_tecnico" && extra ? [...team(), extra] : team();
  for (const member of recipients) {
    let whatsappOk = false;
    try {
      // Fallo real detectado (03/11/2026): Ramón y José nunca le escriben
      // primero al número del negocio, así que la ventana de 24h para
      // texto libre nunca se abre -- todos los avisos fallaban siempre con
      // DIRECT_SEND_NOT_ELIGIBLE. Se intenta primero la plantilla real
      // aprobada por Meta (ver zernio.ts, createTeamAlertTemplate) con el
      // mismo texto que ya se iba a mandar; solo si la plantilla aún no
      // existe o no está aprobada se intenta el texto libre de siempre
      // (que sí puede funcionar si por casualidad hay una ventana abierta).
      const templateResult = await sendTeamAlertViaTemplate(member.phone, whatsappText);
      const result = templateResult.ok ? templateResult : await sendWhatsappText(member.phone, whatsappText);
      whatsappOk = result.ok;
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
    if (!whatsappOk && URGENT_ALERT_KINDS.includes(kind)) {
      const callResult = await callUrgentAlert(member.phone, whatsappText);
      appendToCollection("team_notifications", {
        id: crypto.randomUUID(),
        kind,
        to_name: member.name,
        to_phone: member.phone,
        lead_phone: leadPhone,
        message: whatsappText,
        delivery_status: callResult.ok ? "sent" : "failed",
        error: callResult.ok ? null : callResult.error,
        via: "voz",
        created_at: new Date().toISOString(),
      });
      if (!callResult.ok) {
        console.warn(`[team-notify] tampoco se pudo llamar a ${member.name} (${callResult.error}) -- queda el aviso por correo/CRM.`);
      }
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
// alguien llega en breve, aunque la visita nunca se haya confirmado. Texto
// natural a petición real: "recuerda que a las 11:30 tienes una reserva
// con maria" / "recuerda que a las 16:30 tienes una reserva con lucia" --
// si no hay nombre real, usa el teléfono (nunca "sin nombre" en el mensaje).
export async function notifyVisitUpcoming(args: {
  lead_phone: string | null | undefined;
  vehicle_id: string | null | undefined;
  requested_time: string | null | undefined;
  channel?: string | null;
}): Promise<void> {
  const name = leadName(args.lead_phone);
  const contact = name === "sin nombre" ? args.lead_phone ?? "un cliente" : name;
  await notifyTeam(
    "visita_proxima",
    `Recuerda que a las ${args.requested_time ?? "?"} tienes una visita con ${contact}.`,
    args.lead_phone ?? null,
    name === "sin nombre" ? null : name,
    args.channel,
  );
}

export async function notifyVisitScheduled(args: {
  lead_phone: string | null;
  vehicle_id: string | null | undefined;
  requested_date: string | null | undefined;
  requested_time: string | null | undefined;
  channel?: string | null;
}): Promise<void> {
  const name = leadName(args.lead_phone);
  const contact = contactLine(args.lead_phone, name);
  const vehicle = vehicleLabel(args.vehicle_id);
  const when = args.requested_date && args.requested_time ? `${args.requested_date} a las ${args.requested_time}` : args.requested_date || "fecha por confirmar";
  await notifyTeam(
    "visita_agendada",
    `📅 Nueva visita -- ${contact} -- ${vehicle} -- ${when}`,
    args.lead_phone ?? null,
    name === "sin nombre" ? null : name,
    args.channel,
  );
}

export async function notifyVisitCancelled(args: {
  lead_phone: string | null | undefined;
  vehicle_id: string | null | undefined;
  requested_date: string | null | undefined;
  requested_time: string | null | undefined;
  channel?: string | null;
}): Promise<void> {
  const name = leadName(args.lead_phone);
  const contact = contactLine(args.lead_phone, name);
  const vehicle = vehicleLabel(args.vehicle_id);
  const when = args.requested_date && args.requested_time ? `${args.requested_date} a las ${args.requested_time}` : args.requested_date || "sin fecha";
  await notifyTeam(
    "visita_cancelada",
    `❌ Visita cancelada -- ${contact} -- ${vehicle} -- ${when}`,
    args.lead_phone ?? null,
    name === "sin nombre" ? null : name,
    args.channel,
  );
}

// FALLO REAL detectado (21/10/2026, caso real de Lucía): create_handoff solo
// avisaba al equipo (WhatsApp + correo) cuando la urgencia era "alta" -- una
// urgencia "normal" se quedaba solo en el CRM, sin avisar a nadie. Su queja
// real de que no había nadie para ver el Tiguan ("incidencia visita",
// urgencia normal) estuvo un día entero sin que Ramón/José se enteraran,
// hasta que se revisó a mano. Ahora toda solicitud de atención avisa al
// equipo por los mismos dos canales que una visita o reserva -- la urgencia
// solo decide la prioridad de la tarea de seguimiento, nunca si se avisa o no.
export async function notifyHandoffRequested(args: { kind: AlertKind; lead_phone: string | null | undefined; reason: string; channel?: string | null }): Promise<void> {
  const name = leadName(args.lead_phone);
  const contact = contactLine(args.lead_phone, name);
  await notifyTeam(args.kind, `🔔 ${contact} -- ${args.reason}`, args.lead_phone ?? null, name === "sin nombre" ? null : name, args.channel);
}

export async function notifyReservation(args: { lead_phone: string | null | undefined; vehicle_id: string; amount_eur: number; channel?: string | null }): Promise<void> {
  const name = leadName(args.lead_phone);
  const contact = contactLine(args.lead_phone, name);
  const vehicle = vehicleLabel(args.vehicle_id);
  await notifyTeam(
    "reserva_pendiente",
    `💰 Nueva reserva -- ${contact} -- ${vehicle} -- señal de ${args.amount_eur} €`,
    args.lead_phone ?? null,
    name === "sin nombre" ? null : name,
    args.channel,
  );
}
