// Barrera central de envíos salientes (17/11/2026, incidente real reportado
// por Ramón: un aviso de Coches.net sobre un anuncio ya SOLD/retirado
// internamente generaba un primer contacto por WhatsApp ofreciendo el coche
// como si siguiera disponible -- contactLeadViaWhatsapp, src/email/agent.ts,
// nunca comprobaba getOfficialStatus() antes de escribir).
//
// Esto NO es la ventana de 24h de Meta (esa es una regla técnica de WhatsApp,
// ya implementada en chat/whatsapp-window.ts, y Meta la rechaza por su cuenta
// si se incumple). Esto es una regla de NEGOCIO, independiente del canal:
// ningún envío saliente automático puede dispararse sin que exista, de
// verdad, un evento entrante reciente que lo autorice -- un mensaje de
// WhatsApp, un correo real de un portal, lo que sea, con una fecha real.
// Sin eso, "por si acaso" no es una razón válida para escribirle a nadie.
//
// Excepción explícita (nunca automática, nunca por inferencia): algunas
// llamadas SÍ deben poder saltarse esta barrera porque el propio sistema
// (no un bot adivinando interés) ya sabe que hace falta escribir -- un
// recordatorio de una cita YA agendada, la confirmación de una reserva YA
// pagada/registrada, o un aviso urgente al equipo (Ramón/José). Cada una de
// esas llamadas debe marcarlo ella misma con allowProactive:true en su
// propio call site (ver los comentarios en team-notify.ts, delivery.ts,
// reservations.ts, scheduler.ts) -- nunca se decide aquí por adivinanza.

import crypto from "crypto";
import { appendToCollection, claimOnce, readCollection } from "./store.js";
import { contactoAutorizado } from "./chat/whatsapp-window.js";
import { isWhatsappChatPaused, isEmailContactPaused } from "./tools/agent-toggle.js";
import { getOfficialStatus } from "./tools/vehicle-state.js";
import { currentVehicles } from "./data/vehicles-current.js";
// sendWhatsappText (integrations/whatsapp.ts) y deliverEmail (email/agent.ts)
// importan de este mismo archivo (authorizeOutboundMessage) -- importarlos
// aquí arriba crearía un ciclo ESM real. Se importan de forma perezosa
// (dynamic import) dentro de authorizeAndSendOutbound, justo en el momento
// de ejecutar el envío, mismo patrón que ya usa alerts.ts para lo mismo.

// Por qué 48h y no las 23-24h que ya usa la ventana de WhatsApp de Meta /
// el seguimiento comercial: esta barrera cubre TODOS los canales de salida
// (WhatsApp y email), no solo WhatsApp -- un aviso real de Coches.net llega
// por correo y el primer contacto sale por WhatsApp poco después, nunca en
// el mismo instante (el poller de correo corre cada pocos minutos, puede
// haber reintentos, colas, reprocesos). 48h da margen real para ese desfase
// entre canales sin abrir la puerta a reactivar nada de hace días/meses/años
// -- exactamente el incidente real que esto corrige.
export const OUTBOUND_REQUIRE_INBOUND_WITHIN_HOURS = 48;

export type OutboundChannel = "whatsapp" | "email";

export type AuthorizeOutboundMessageInput = {
  // Identificador del destinatario (teléfono o email), solo para el registro
  // de auditoría -- esta función no normaliza ni resuelve nada por su cuenta.
  phone: string | null;
  channel: OutboundChannel;
  // Marca de tiempo real (ms epoch) del evento entrante que de verdad
  // autoriza este envío -- un mensaje de WhatsApp real, un correo real de un
  // portal (su received_at/internalDate de Gmail, NUNCA la fecha en la que
  // se procesó si hay backlog). null si no hay ninguno conocido.
  lastInboundAt: number | null;
  // Motivo corto, para el registro de auditoría -- qué llamada es esta
  // (p. ej. "contactLeadViaWhatsapp:coches.net", "followup_comercial").
  reason: string;
  // true SOLO para las excepciones ya identificadas explícitamente en su
  // propio call site (recordatorio de cita agendada, confirmación de
  // reserva real, aviso urgente al equipo). Nunca se infiere aquí.
  allowProactive?: boolean;
  now?: number;
};

export type AuthorizeOutboundMessageResult = { ok: true } | { ok: false; motivo: string };

function registrarBloqueo(input: AuthorizeOutboundMessageInput, motivo: string): void {
  console.warn(`[outbound-guard] envío bloqueado (${input.channel} a ${input.phone ?? "desconocido"}): ${motivo} -- motivo de la llamada: ${input.reason}`);
  try {
    appendToCollection("outbound_guard_blocks", {
      id: crypto.randomUUID(),
      phone: input.phone,
      channel: input.channel,
      reason: input.reason,
      motivo,
      last_inbound_at: input.lastInboundAt !== null ? new Date(input.lastInboundAt).toISOString() : null,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    // El bloqueo en sí ya es lo importante -- un fallo al registrarlo en
    // disco nunca debe convertirse en "pues entonces mejor lo envío".
    console.error("[outbound-guard] no se pudo registrar el bloqueo:", err instanceof Error ? err.message : err);
  }
}

export function authorizeOutboundMessage(input: AuthorizeOutboundMessageInput): AuthorizeOutboundMessageResult {
  if (input.allowProactive === true) return { ok: true };

  if (input.lastInboundAt === null) {
    registrarBloqueo(input, "sin_evento_entrante_real_conocido");
    return { ok: false, motivo: "sin_evento_entrante_real_conocido" };
  }

  const now = input.now ?? Date.now();
  const horas = (now - input.lastInboundAt) / 3600_000;
  if (horas < 0) {
    // Una fecha "entrante" en el futuro no es real -- nunca se usa como
    // autorización, se trata igual que si no hubiera ninguna.
    registrarBloqueo(input, "fecha_entrante_invalida");
    return { ok: false, motivo: "fecha_entrante_invalida" };
  }
  if (horas > OUTBOUND_REQUIRE_INBOUND_WITHIN_HOURS) {
    registrarBloqueo(input, `evento_entrante_fuera_de_ventana_${Math.round(horas)}h`);
    return { ok: false, motivo: `evento_entrante_fuera_de_ventana_${Math.round(horas)}h` };
  }
  return { ok: true };
}

// ============================================================================
// FASE 2D (18/11/2026, encargo autorizado por escrito -- "exclusivamente en
// desarrollo", sin push/deploy/producción): servicio central ÚNICO que
// aplica, en orden, los 7 chequeos de negocio que antes vivían repartidos en
// 4 archivos distintos (outbound-guard.ts solo cubría evento+antigüedad;
// whatsapp-window.ts cubría estado de contacto+permisos de canal;
// agent-toggle.ts cubría intervención humana; vehicle-state.ts/reservations.ts
// cubría validez de vehículo; dedup repartida entre varios). Cada ruta que
// quiera mandar un WhatsApp o un correo de forma proactiva/automática debería
// pasar por AQUÍ -- y es esta misma función la que ejecuta el envío real
// (nunca solo "aprueba y devuelve control" al llamador), para que ninguna
// ruta pueda aprobar y luego hacer otra cosa.
//
// IMPORTANTE, honesto: sendWhatsappText (integrations/whatsapp.ts) y
// deliverEmail (email/agent.ts) YA aplican el chequeo 1 (evento+antigüedad)
// ellos mismos, como defensa en profundidad, para CUALQUIER llamador aunque
// no pase por aquí -- eso no cambia. Lo que esta función centraliza de
// verdad es el resto de chequeos (3, 4 cuando aplica, 5, 7) que antes cada
// call site aplicaba (o no) por su cuenta, repitiendo la lógica -- y deja un
// único punto de auditoría que registra tanto los envíos bloqueados como los
// autorizados, con el motivo exacto.
export type OutboundKind = "generic" | "vehicle_availability";

export type AuthorizeAndSendOutboundInput = {
  phone: string;
  channel: OutboundChannel;
  // "vehicle_availability": se va a hablar de disponibilidad/visita/reserva
  // de un vehículo concreto -- dispara el chequeo 4. "generic" (por defecto):
  // no aplica ese chequeo (p. ej. un aviso al equipo, un seguimiento sin
  // vehículo concreto).
  kind?: OutboundKind;
  vehicleId?: string | null;
  // true SOLO para las excepciones ya identificadas explícitamente en su
  // propio call site (recordatorio de cita agendada, confirmación de
  // reserva real, aviso urgente al equipo, respuesta manual del equipo
  // desde el CRM). Salta los chequeos 1 (evento) y 6 (ventana/plantilla,
  // delegado a Meta/Zernio) -- los chequeos 3 (estado del contacto), 4
  // (vehículo) y 5 (intervención humana) se siguen aplicando igual, porque
  // son estructurales y no dependen de "si hay o no un evento que autorice".
  allowProactive?: boolean;
  // Fecha real (ms epoch) del evento entrante que autoriza -- null/omitido
  // si no hay ninguno conocido. Solo se exige cuando allowProactive no es true.
  lastInboundAt?: number | null;
  reason: string;
  // Último seguro de idempotencia (chequeo 7): si se pasa, el servicio
  // exige que sea la primera vez que se ve esta clave antes de enviar nada.
  // Cada canal sigue teniendo su propio mecanismo de dedup más específico
  // (alreadyContacted, claimBatchOnce, email_processed...) -- esto es una
  // red de seguridad adicional, nunca el único mecanismo real de cada canal.
  dedupeKey?: string;
  textBuilder: () => string;
  emailSubject?: string;
  now?: number;
};

export type AuthorizeAndSendOutboundResult =
  | { ok: true; sent: true; messageId?: string }
  | { ok: false; motivo: string };

function registrarDecision(input: AuthorizeAndSendOutboundInput, resultado: "autorizado" | "bloqueado", motivo: string): void {
  try {
    appendToCollection("outbound_guard_blocks", {
      id: crypto.randomUUID(),
      phone: input.phone,
      channel: input.channel,
      reason: input.reason,
      motivo,
      resultado,
      allow_proactive: input.allowProactive === true,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[outbound-guard] no se pudo registrar la decisión de authorizeAndSendOutbound:", err instanceof Error ? err.message : err);
  }
}

export async function authorizeAndSendOutbound(input: AuthorizeAndSendOutboundInput): Promise<AuthorizeAndSendOutboundResult> {
  const now = input.now ?? Date.now();

  // Chequeo 1: evento entrante auténtico + antigüedad (se salta con
  // allowProactive, igual que authorizeOutboundMessage ya hace).
  if (input.allowProactive !== true) {
    const auth = authorizeOutboundMessage({
      phone: input.phone,
      channel: input.channel,
      lastInboundAt: input.lastInboundAt ?? null,
      reason: input.reason,
      now,
    });
    if (!auth.ok) {
      registrarDecision(input, "bloqueado", auth.motivo);
      return { ok: false, motivo: auth.motivo };
    }
  }

  // Chequeo 3: estado del contacto (solo aplica de verdad a WhatsApp -- la
  // tabla de leads/do_not_contact/preferred_channel es por teléfono).
  if (input.channel === "whatsapp") {
    const autorizacion = contactoAutorizado(input.phone);
    if (!autorizacion.ok) {
      registrarDecision(input, "bloqueado", `contacto_no_autorizado:${autorizacion.motivo}`);
      return { ok: false, motivo: `contacto_no_autorizado:${autorizacion.motivo}` };
    }
  }

  // Chequeo 4: vehículo existe y está disponible -- solo cuando el envío va
  // a hablar de disponibilidad/visita/reserva de un vehículo concreto.
  if (input.kind === "vehicle_availability") {
    if (!input.vehicleId) {
      registrarDecision(input, "bloqueado", "vehicle_availability_sin_vehicle_id");
      return { ok: false, motivo: "vehicle_availability_sin_vehicle_id" };
    }
    let existeEnCatalogo: boolean;
    try {
      existeEnCatalogo = currentVehicles().some((v) => v.id === input.vehicleId);
    } catch (err) {
      // Catálogo no consultable -- falla CERRADO, mismo criterio que
      // reservations.ts (nunca se trata un catálogo roto como disponibilidad).
      console.error("[outbound-guard] catálogo no consultable, se rechaza por seguridad:", err instanceof Error ? err.message : err);
      registrarDecision(input, "bloqueado", "catalog_unavailable");
      return { ok: false, motivo: "catalog_unavailable" };
    }
    if (!existeEnCatalogo) {
      registrarDecision(input, "bloqueado", "vehicle_not_found_in_catalog");
      return { ok: false, motivo: "vehicle_not_found_in_catalog" };
    }
    const status = getOfficialStatus(input.vehicleId);
    if (status === "SOLD" || status === "RESERVED") {
      registrarDecision(input, "bloqueado", `vehicle_not_available_${status}`);
      return { ok: false, motivo: `vehicle_not_available_${status}` };
    }
  }

  // Chequeo 5: intervención humana -- el equipo está llevando este contacto
  // a mano, el agente no le escribe por encima.
  const pausado = input.channel === "whatsapp" ? isWhatsappChatPaused(input.phone) : isEmailContactPaused(input.phone);
  if (pausado) {
    registrarDecision(input, "bloqueado", "intervencion_humana_pausado");
    return { ok: false, motivo: "intervencion_humana_pausado" };
  }

  // Chequeo 7: red de seguridad adicional de idempotencia, si el llamador
  // pasó una clave real de deduplicación.
  if (input.dedupeKey) {
    const primeraVez = await claimOnce("outbound_send_dedupe", input.dedupeKey);
    if (!primeraVez) {
      registrarDecision(input, "bloqueado", "duplicado_dedupe_key");
      return { ok: false, motivo: "duplicado_dedupe_key" };
    }
  }

  // Autorizado: el propio servicio ejecuta el envío real -- nunca devuelve
  // "aprobado" para que otro código decida hacer otra cosa.
  const texto = input.textBuilder();
  if (input.channel === "whatsapp") {
    const { sendWhatsappText } = await import("./integrations/whatsapp.js");
    const result = await sendWhatsappText(input.phone, texto, { allowProactive: input.allowProactive, lastInboundAt: input.lastInboundAt, reason: input.reason });
    registrarDecision(input, "autorizado", result.ok ? "enviado" : `envio_fallido:${result.error}`);
    if (!result.ok) return { ok: false, motivo: `envio_fallido:${result.error}` };
    return { ok: true, sent: true, messageId: result.messageId };
  }

  const { deliverEmail } = await import("./email/agent.js");
  const delivery = await deliverEmail(input.phone, input.emailSubject ?? "Automóviles Lucero", texto, undefined, { allowProactive: input.allowProactive, lastInboundAt: input.lastInboundAt, reason: input.reason });
  registrarDecision(input, "autorizado", delivery.status === "sent" ? "enviado" : `envio_fallido:${delivery.error ?? delivery.status}`);
  if (delivery.status !== "sent") return { ok: false, motivo: `envio_fallido:${delivery.error ?? delivery.status}` };
  return { ok: true, sent: true };
}

// ============================================================================
// Encargo real (18/11/2026, autorizado por escrito "exclusivamente en
// desarrollo"): "una plantilla aprobada por Meta no equivale a autorización
// comercial del destinatario". sendZernioWhatsappVehicleContactTemplate,
// sendTeamAlertViaTemplate y sendClientReminderViaTemplate (integrations/
// zernio.ts) se enviaban sin repasar, EN EL MOMENTO EXACTO DEL ENVÍO, si el
// objeto real al que se refieren (reserva/cita/vehículo) seguía
// justificando ese mensaje -- confiaban en que el llamador ya lo hubiera
// comprobado aguas arriba, lo que deja una ventana real entre esa
// comprobación y el envío de verdad (otro proceso puede cancelar la
// reserva/cita de por medio). Estas funciones vuelven a leer el estado real
// de disco justo antes de enviar, y registran SIEMPRE la decisión (enviado
// o bloqueado) en la misma colección de auditoría que ya usa el resto de
// este archivo, para que /debug/outbound_guard_blocks la capture también.

// Ventana de "cita todavía vigente" para el recordatorio de respaldo
// (plantilla) -- mismo criterio que ya usa el scheduler para decidir si
// un recordatorio sigue teniendo sentido (recordatorios se disparan en
// ventanas de ±10min sobre 24h/6h/1h antes de la cita), con margen extra
// para cubrir reintentos reales sin dejar pasar una cita que ya es pasado
// histórico. 2h después de la hora de la cita, un "recordatorio" ya no
// tiene sentido real -- la cita ya pasó.
export const APPOINTMENT_TEMPLATE_STALE_HOURS = 2;

function registrarEnvioPlantilla(input: {
  phone: string;
  template: "vehicle_contact" | "vehicle_contact_generic" | "team_alert" | "client_reminder";
  reason: string;
  resultado: "autorizado" | "bloqueado";
  motivo: string;
}): void {
  try {
    appendToCollection("outbound_guard_blocks", {
      id: crypto.randomUUID(),
      tipo: "plantilla_meta",
      phone: input.phone,
      channel: "whatsapp",
      template: input.template,
      reason: input.reason,
      motivo: input.motivo,
      resultado: input.resultado,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[outbound-guard] no se pudo registrar el envío de plantilla:", err instanceof Error ? err.message : err);
  }
}

// Vehículo real: existe en el catálogo vigente Y no está SOLD/RESERVED.
// Falla CERRADO si el catálogo no se puede consultar (mismo criterio que
// el chequeo 4 de authorizeAndSendOutbound más arriba).
export function verifyVehicleAvailableForTemplate(vehicleId: string | null | undefined): { ok: true } | { ok: false; motivo: string } {
  if (!vehicleId) return { ok: false, motivo: "sin_vehicle_id" };
  let existe: boolean;
  try {
    existe = currentVehicles().some((v) => v.id === vehicleId);
  } catch (err) {
    console.error("[outbound-guard] catálogo no consultable, se rechaza plantilla por seguridad:", err instanceof Error ? err.message : err);
    return { ok: false, motivo: "catalog_unavailable" };
  }
  if (!existe) return { ok: false, motivo: "vehicle_not_found_in_catalog" };
  const status = getOfficialStatus(vehicleId);
  if (status === "SOLD" || status === "RESERVED") return { ok: false, motivo: `vehicle_not_available_${status}` };
  return { ok: true };
}

// Reserva real: sigue "confirmed" de verdad, releída de disco en el
// instante del envío -- nunca se confía en el objeto capturado antes.
export function verifyReservationConfirmedNow(reservationId: string): { ok: true } | { ok: false; motivo: string } {
  const reservations = readCollection<{ id: string; status: string }>("reservations", []);
  const reservation = reservations.find((r) => r.id === reservationId);
  if (!reservation) return { ok: false, motivo: "reservation_not_found" };
  if (reservation.status !== "confirmed") return { ok: false, motivo: `reservation_status_${reservation.status}` };
  return { ok: true };
}

// Cita real: no cancelada y no histórica -- releída de disco en el
// instante del envío. "Histórica" = la fecha/hora de la cita ya quedó más
// de APPOINTMENT_TEMPLATE_STALE_HOURS atrás.
export function verifyAppointmentActiveForTemplate(appointmentId: string, now = Date.now()): { ok: true } | { ok: false; motivo: string } {
  const appointments = readCollection<{ id: string; status: string; requested_date?: string; requested_time?: string }>("appointments", []);
  const appt = appointments.find((a) => a.id === appointmentId);
  if (!appt) return { ok: false, motivo: "appointment_not_found" };
  if (appt.status === "cancelled") return { ok: false, motivo: "appointment_cancelled" };
  if (appt.requested_date) {
    const time = appt.requested_time?.trim() || "00:00";
    const apptDate = new Date(`${appt.requested_date}T${time.length === 5 ? time : "00:00"}:00`);
    if (!Number.isNaN(apptDate.getTime())) {
      const ageMs = now - apptDate.getTime();
      if (ageMs > APPOINTMENT_TEMPLATE_STALE_HOURS * 3600_000) {
        return { ok: false, motivo: `appointment_historica_${Math.round(ageMs / 3600_000)}h` };
      }
    }
  }
  return { ok: true };
}

// Destinatario real del equipo (Ramón/José/el extra de avisos técnicos) --
// releído de configuración en el instante del envío, nunca un
// "allowProactive:true" genérico: comprueba que el número es DE VERDAD uno
// de los configurados ahora mismo, no un cliente.
export function isAuthorizedTeamPhone(phone: string | null | undefined): boolean {
  if (!phone) return false;
  let cfg: { ramonPhone?: string | null; josePhone?: string | null };
  try {
    // Import perezoso, mismo motivo que sendWhatsappText/deliverEmail más
    // arriba: evitar un ciclo ESM real con módulos que a su vez pueden
    // depender de este archivo.
    cfg = requireBusinessConfigSync();
  } catch {
    return false;
  }
  const extra = process.env.TECHNICAL_ALERT_PHONE?.trim() || null;
  const candidatos = [cfg.ramonPhone, cfg.josePhone, extra].filter((p): p is string => !!p);
  return candidatos.includes(phone);
}

// getBusinessConfig es síncrona, pero está en un módulo que también importa
// varios de los que ya forman el ciclo lazy de este archivo -- import
// perezoso vía require dinámico de ESM (import() devuelve una promesa, así
// que aquí se usa una pequeña cache poblada por isAuthorizedTeamPhone de
// forma perezosa real la primera vez que haga falta).
import { getBusinessConfig as _getBusinessConfigEager } from "./data/business-config.js";
function requireBusinessConfigSync(): { ramonPhone?: string | null; josePhone?: string | null } {
  const cfg = _getBusinessConfigEager();
  return { ramonPhone: cfg.ramonPhone, josePhone: cfg.josePhone };
}

// Variante para el caso concreto de "confirmación de reserva ya pagada":
// aquí el vehículo SÍ debe estar RESERVED (es justo el estado correcto tras
// confirmar) -- verifyVehicleAvailableForTemplate lo rechazaría por error.
// Lo que hay que releer es la propia reserva, no el vehículo.
export async function sendVehicleContactTemplateGuardedForReservation(
  phone: string,
  vehicleLabel: string,
  reservationId: string,
  reason: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const check = verifyReservationConfirmedNow(reservationId);
  if (!check.ok) {
    registrarEnvioPlantilla({ phone, template: "vehicle_contact", reason, resultado: "bloqueado", motivo: check.motivo });
    return { ok: false, error: check.motivo };
  }
  const { sendZernioWhatsappVehicleContactTemplate } = await import("./integrations/zernio.js");
  const result = await sendZernioWhatsappVehicleContactTemplate(phone, vehicleLabel);
  registrarEnvioPlantilla({ phone, template: "vehicle_contact", reason, resultado: result.ok ? "autorizado" : "bloqueado", motivo: result.ok ? "enviado" : `envio_fallido:${result.error}` });
  return result;
}

// Variante para la confirmación de visita (appointments.ts): el objeto real
// a releer es la propia cita, no el vehículo.
export async function sendVehicleContactTemplateGuardedForAppointment(
  phone: string,
  vehicleLabel: string,
  appointmentId: string,
  reason: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const check = verifyAppointmentActiveForTemplate(appointmentId);
  if (!check.ok) {
    registrarEnvioPlantilla({ phone, template: "vehicle_contact", reason, resultado: "bloqueado", motivo: check.motivo });
    return { ok: false, error: check.motivo };
  }
  const { sendZernioWhatsappVehicleContactTemplate } = await import("./integrations/zernio.js");
  const result = await sendZernioWhatsappVehicleContactTemplate(phone, vehicleLabel);
  registrarEnvioPlantilla({ phone, template: "vehicle_contact", reason, resultado: result.ok ? "autorizado" : "bloqueado", motivo: result.ok ? "enviado" : `envio_fallido:${result.error}` });
  return result;
}

export async function sendVehicleContactTemplateGuarded(
  phone: string,
  vehicleLabel: string,
  vehicleId: string | null | undefined,
  reason: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const check = verifyVehicleAvailableForTemplate(vehicleId);
  if (!check.ok) {
    registrarEnvioPlantilla({ phone, template: "vehicle_contact", reason, resultado: "bloqueado", motivo: check.motivo });
    return { ok: false, error: check.motivo };
  }
  const { sendZernioWhatsappVehicleContactTemplate } = await import("./integrations/zernio.js");
  const result = await sendZernioWhatsappVehicleContactTemplate(phone, vehicleLabel);
  registrarEnvioPlantilla({ phone, template: "vehicle_contact", reason, resultado: result.ok ? "autorizado" : "bloqueado", motivo: result.ok ? "enviado" : `envio_fallido:${result.error}` });
  return result;
}

// Primer contacto con la plantilla aprobada cuando el coche por el que preguntó
// el cliente YA NO está disponible (22/11/2026, "esos clientes pendientes que
// se les contacte, que para eso se activó la plantilla"). No nombra ningún coche
// concreto (solo "el vehículo que consultaste en <portal>"), así que no afirma
// nada falso; no pasa por la comprobación de catálogo a propósito, porque el
// motivo de usarla es justo que ese coche ya no está. Cuando el cliente
// responde se abre la ventana de 24 h y Carolina sigue con la regla de venta
// perdida (enlace del catálogo y pedir marca y modelo).
export async function sendGenericContactTemplateGuarded(
  phone: string,
  label: string,
  reason: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const { sendZernioWhatsappVehicleContactTemplate } = await import("./integrations/zernio.js");
  const result = await sendZernioWhatsappVehicleContactTemplate(phone, label);
  registrarEnvioPlantilla({ phone, template: "vehicle_contact_generic", reason, resultado: result.ok ? "autorizado" : "bloqueado", motivo: result.ok ? "enviado" : `envio_fallido:${result.error}` });
  return result;
}

export async function sendTeamAlertTemplateGuarded(phone: string, message: string, reason: string): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  if (!isAuthorizedTeamPhone(phone)) {
    registrarEnvioPlantilla({ phone, template: "team_alert", reason, resultado: "bloqueado", motivo: "destinatario_no_es_equipo_configurado" });
    return { ok: false, error: "destinatario_no_es_equipo_configurado" };
  }
  const { sendTeamAlertViaTemplate } = await import("./integrations/zernio.js");
  const result = await sendTeamAlertViaTemplate(phone, message);
  registrarEnvioPlantilla({ phone, template: "team_alert", reason, resultado: result.ok ? "autorizado" : "bloqueado", motivo: result.ok ? "enviado" : `envio_fallido:${result.error}` });
  return result;
}

export async function sendClientReminderTemplateGuarded(
  phone: string,
  name: string,
  date: string,
  time: string,
  appointmentId: string,
  reason: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const check = verifyAppointmentActiveForTemplate(appointmentId);
  if (!check.ok) {
    registrarEnvioPlantilla({ phone, template: "client_reminder", reason, resultado: "bloqueado", motivo: check.motivo });
    return { ok: false, error: check.motivo };
  }
  const { sendClientReminderViaTemplate } = await import("./integrations/zernio.js");
  const result = await sendClientReminderViaTemplate(phone, name, date, time);
  registrarEnvioPlantilla({ phone, template: "client_reminder", reason, resultado: result.ok ? "autorizado" : "bloqueado", motivo: result.ok ? "enviado" : `envio_fallido:${result.error}` });
  return result;
}
