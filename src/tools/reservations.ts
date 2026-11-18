import { appendToCollection, readCollection, writeCollection } from "../store.js";
import { withPersistentLockSync, withPersistentLock } from "../locks.js";
import { envelope } from "../response.js";
import { businessInfo } from "../data/business-info.js";
import { getOfficialStatus, setOfficialStatus } from "./vehicle-state.js";
import { notifyReservation } from "./team-notify.js";
import { createAutoTask } from "./tasks.js";
import { currentVehicles } from "../data/vehicles-current.js";
import { sendWhatsapp } from "./delivery.js";
import { isGoogleConnected } from "../integrations/google.js";
import { deliverEmail } from "../email/agent.js";
import { getMessageTemplate, renderTemplate } from "../data/message-templates.js";
import { markLeadRealIntent } from "./leads.js";
import { raiseAlert } from "../alerts/alerts.js";
import { isContactoInicialTemplateApproved } from "../integrations/zernio.js";
import { sendVehicleContactTemplateGuardedForReservation } from "../outbound-guard.js";

function vehicleLabel(vehicleId: string): string {
  const v = currentVehicles().find((x) => x.id === vehicleId);
  return v ? `${v.make} ${v.model} ${v.version}` : vehicleId;
}

// Aviso real al cliente cuando se confirma su reserva (27/10/2026, "avisos
// automaticos desde el crm a cada cliente") -- antes confirmReservation
// solo cambiaba el estado interno, nadie avisaba al cliente salvo que el
// equipo le escribiera a mano. Mismo patrón honesto que el resto de envíos:
// si falla, se registra el error, nunca se finge entregado.
// FALLO REAL grave detectado (04/11/2026, "que se les envíe una
// confirmación real por WhatsApp a cada cliente que no sea falso"): mismo
// fallo que en appointments.ts -- sendWhatsapp no lanza excepción si Meta
// rechaza el envío, devuelve {status:"denied"} con éxito HTTP normal. Esta
// función solo capturaba excepciones reales, así que una reserva podía
// quedar "confirmada" sin que el cliente hubiera recibido nunca el aviso.
async function sendReservationConfirmedMessage(contact: string | null, vehicleId: string, reservationId: string): Promise<boolean> {
  if (!contact) return false;
  const message = renderTemplate(getMessageTemplate("reserva_confirmada"), { vehiculo: vehicleLabel(vehicleId) });
  try {
    if (contact.includes("@")) {
      if (!isGoogleConnected()) return false;
      // Excepción explícita (18/11/2026, outbound-guard.ts, mismo criterio que
      // la rama de WhatsApp más abajo): confirmación de una reserva REAL ya
      // registrada (señal pagada/comprometida), nunca bloqueada por falta de
      // un correo entrante reciente.
      const result = await deliverEmail(contact, "Reserva confirmada -- Automóviles Lucero", message, undefined, { allowProactive: true, reason: "confirmacion_reserva_real" });
      return result.status === "sent";
    }
    // Excepción explícita (17/11/2026, outbound-guard.ts): esto es la
    // confirmación de una reserva REAL ya registrada (señal pagada/
    // comprometida) -- nunca debe bloquearse por falta de un mensaje
    // entrante reciente.
    const result = await sendWhatsapp({ lead_phone: contact, message, allowProactive: true, outboundReason: "confirmacion_reserva_real" });
    if (result.status === "ok") return true;
    // FALLO REAL detectado (04/11/2026, "pero la plantilla no estaba
    // activa?" -- mismo fallo que en appointments.ts, sendWhatsapp nunca
    // cae en la plantilla aprobada como respaldo).
    if (!(await isContactoInicialTemplateApproved())) return false;
    // FASE 2D (18/11/2026): releída de la reserva en el instante del envío
    // -- solo se abre la conversación con la plantilla si la reserva SIGUE
    // confirmada ahora mismo (verifyReservationConfirmedNow), no la que
    // había en memoria al llamar a esta función.
    const templateSent = await sendVehicleContactTemplateGuardedForReservation(contact, vehicleLabel(vehicleId), reservationId, "confirmacion_reserva_real");
    if (!templateSent.ok) return false;
    const retrySent = await sendWhatsapp({ lead_phone: contact, message, allowProactive: true, outboundReason: "confirmacion_reserva_real" });
    return retrySent.status === "ok";
  } catch (err) {
    console.error("[reservations] no se pudo enviar la confirmación de reserva al cliente:", err instanceof Error ? err.message : err);
    return false;
  }
}

// Flujo de reserva (Secciones 25-28 del encargo). SIEMPRE requiere
// validación humana antes de RESERVED -- ninguna herramienta de este
// archivo puede confirmarla sola a partir de lo que diga el cliente.

type Reservation = {
  id: string;
  vehicle_id: string;
  lead_phone: string | null;
  amount_eur: number;
  status: "pending_payment" | "pending_verification" | "confirmed" | "expired" | "cancelled";
  payment_receipt_note: string | null;
  created_at: string;
  expires_at: string;
  verified_by: string | null;
  verified_at: string | null;
  // Canal de origen (20/10/2026, mejora integral del CRM, sección 12.1) --
  // nunca se sobrescribe. Ausente en reservas históricas.
  channel?: string | null;
};

function now() {
  return new Date();
}

function readReservations() {
  return readCollection<Reservation>("reservations", []);
}

async function createReservationPending_sinBloqueo(args: { vehicle_id: string; lead_phone?: string; channel?: string }) {
  // Fase 2B (17/11/2026, auditoría de las 8 reservas reales que apuntaban a
  // vehicle_id inexistentes): getOfficialStatus NUNCA basta por sí sola para
  // decidir si se puede reservar -- un vehicle_id inventado, o huérfano tras
  // una reimportación de Dealcar que le cambió el id, también devuelve
  // "AVAILABLE" por defecto (es justo el fallo que causó esas 8 reservas).
  // Antes de nada, se exige que el vehicle_id exista DE VERDAD en el
  // catálogo actual real (currentVehicles(), no vehicle_state). Si
  // currentVehicles() falla (feed roto, archivo corrupto, lo que sea), se
  // falla CERRADO -- nunca se trata un catálogo no consultable como
  // disponibilidad confirmada.
  let catalogVehicle;
  try {
    catalogVehicle = currentVehicles().find((v) => v.id === args.vehicle_id);
  } catch (err) {
    console.error("[reservations] no se pudo consultar el catálogo actual, se rechaza la reserva por seguridad:", err instanceof Error ? err.message : err);
    return envelope({
      status: "denied",
      error_code: "catalog_unavailable",
      data: { vehicle_id: args.vehicle_id },
      source: "catálogo actual (currentVehicles).",
    });
  }
  if (!catalogVehicle) {
    return envelope({
      status: "denied",
      error_code: "vehicle_not_found_in_catalog",
      data: { vehicle_id: args.vehicle_id },
      source: "catálogo actual (currentVehicles) -- este vehicle_id no existe en el inventario real vigente. Puede haber sido reimportado con otro id, vendido y retirado, o ser un id inventado -- en ningún caso se trata como disponible.",
    });
  }

  const currentStatus = getOfficialStatus(args.vehicle_id);
  if (currentStatus === "RESERVED" || currentStatus === "SOLD") {
    return envelope({
      status: "denied",
      error_code: "vehicle_not_available",
      data: { official_status: currentStatus },
      source: "Estado interno de reservas.",
    });
  }
  // Confirmado en llamada real 29/09/2026: pueden existir varias reservas
  // pendientes EN PARALELO para el mismo coche (varias personas intentando
  // pagar a la vez) -- no se bloquea la segunda, solo se avisa. El vehículo
  // solo pasa a RESERVED de verdad cuando el equipo confirma la primera que
  // llega con justificante válido (confirmReservation cancela las demás
  // pendientes de ese vehículo en ese momento).
  const alreadyPending = currentStatus === "RESERVATION_PENDING";

  const amount = businessInfo.reservation.amount_eur;
  const durationDays = businessInfo.reservation.duration_days;
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + durationDays * 24 * 60 * 60 * 1000);

  const reservation: Reservation = {
    id: crypto.randomUUID(),
    vehicle_id: args.vehicle_id,
    lead_phone: args.lead_phone ?? null,
    channel: args.channel ?? null,
    amount_eur: amount,
    status: "pending_payment",
    payment_receipt_note: null,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    verified_by: null,
    verified_at: null,
  };
  // Mismo fallo real que en upsertLead (09/11/2026, auditoría de
  // concurrencia): esta función ya corre bajo el bloqueo "col_reservations"
  // (ver el wrapper exportado abajo) -- appendToCollection volvería a
  // pedirlo, autodeadlock no reentrante. Push + writeCollection directo, sin
  // tomar lock de nuevo.
  const reservations = readCollection<Reservation>("reservations");
  reservations.push(reservation);
  writeCollection("reservations", reservations);
  setOfficialStatus(args.vehicle_id, "RESERVATION_PENDING", reservation.id);
  markLeadRealIntent(args.lead_phone ?? null); // 03/11/2026: una reserva real es la intención real por excelencia.
  await notifyReservation({ lead_phone: args.lead_phone, vehicle_id: args.vehicle_id, amount_eur: amount, channel: args.channel ?? null });

  const conflicts = [
    "Datos bancarios/Bizum para el pago de la señal NO están configurados en este sistema todavía -- deriva con create_handoff para que el equipo le pase las instrucciones de pago reales. No inventes un número de cuenta ni un enlace de pago.",
  ];
  if (alreadyPending) {
    conflicts.push("Ya había otra reserva en curso para este mismo vehículo -- es válido, gana quien primero pague Y envíe justificante (Sección 27). Dile al cliente que conviene darse prisa si quiere asegurarlo, sin inventar quién más lo está pidiendo.");
  }

  return envelope({ status: "ok", data: reservation, source: "registro interno", conflicts });
}

function submitPaymentReceipt_sinBloqueo(args: { reservation_id: string; note?: string }) {
  const reservations = readReservations();
  const reservation = reservations.find((r) => r.id === args.reservation_id);
  if (!reservation) return envelope({ status: "not_found", error_code: "reservation_not_found" });
  if (reservation.status !== "pending_payment") {
    return envelope({ status: "denied", error_code: "reservation_not_pending_payment", data: reservation });
  }
  reservation.status = "pending_verification";
  reservation.payment_receipt_note = args.note ?? "Cliente indica haber enviado justificante -- sin verificar todavía.";
  writeCollection("reservations", reservations);
  // Seguimiento comercial (20/10/2026, sección 14, "llegue un justificante
  // pendiente de verificar"): deduplicada por el id real de la reserva.
  createAutoTask({
    lead_phone: reservation.lead_phone,
    type: "verificar_reserva",
    reason: `Justificante recibido para ${reservation.vehicle_id} -- comprobar y confirmar o rechazar.`,
    source_ref: reservation.id,
    channel: reservation.channel ?? null,
    priority: "alta",
  });

  return envelope({
    status: "ok",
    data: reservation,
    source: "registro interno",
    conflicts: ["NUNCA decir al cliente que la reserva está confirmada. Sigue pendiente de validación humana del ingreso (Sección 26)."],
  });
}

// confirm_reservation y cancel_reservation son ACCIONES HUMANAS, no
// herramientas del agente de voz/chat (Sección 26: "debe existir
// validación"). Se exponen por una ruta administrativa separada, protegida
// por un token simple, para que Ramón/José/el equipo las use manualmente --
// no están en la lista de tools que se declaran a Retell.
// Estados de partida válidos para confirmar una reserva. Igual que
// submitPaymentReceipt_sinBloqueo exige "pending_payment", confirmar exige
// que siga en uno de los dos estados "vivos" previos a confirmed -- nunca
// se fuerza desde confirmed/expired/cancelled.
const CONFIRMABLE_FROM: ReadonlySet<Reservation["status"]> = new Set(["pending_payment", "pending_verification"]);

// Trazabilidad de cada intento de confirmación (BUG 1, 18/11/2026, Fase 2C
// autorizada por el cliente: "dos confirmaciones casi simultáneas del mismo
// vehículo pueden dejar DOS reservas confirmed para el mismo coche").
// confirmReservation_sinBloqueo nunca comprobaba el estado ACTUAL (leído de
// disco en el instante de escribir, dentro del mismo lock) antes de forzar
// "confirmed" -- dos llamadas casi simultáneas (misma reserva, dos clics, o
// dos reservas del mismo vehículo) podían pisarse. Se registra tanto el
// éxito como el rechazo, mismo patrón que outbound-guard.ts (appendToCollection
// a una colección simple, nunca se inventa una tabla nueva de verdad).
function registrarIntentoConfirmacion(input: { reservation_id: string; verified_by: string; result: "confirmed" | "rejected"; motivo?: string; estado_actual?: string }): void {
  try {
    appendToCollection("reservation_confirm_attempts", {
      id: crypto.randomUUID(),
      reservation_id: input.reservation_id,
      verified_by: input.verified_by,
      result: input.result,
      motivo: input.motivo ?? null,
      estado_actual: input.estado_actual ?? null,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[reservations] no se pudo registrar el intento de confirmación:", err instanceof Error ? err.message : err);
  }
}

async function confirmReservation_sinBloqueo(args: { reservation_id: string; verified_by: string }) {
  // Leído DE NUEVO aquí, dentro del mismo lock ya tomado por el wrapper
  // exportado (withPersistentLock "col_reservations") -- nunca se confía en
  // un estado capturado antes de entrar al lock, que pudo cambiar entre que
  // se leyó para decidir llamar a esta función y el instante de escribir.
  const reservations = readReservations();
  const reservation = reservations.find((r) => r.id === args.reservation_id);
  if (!reservation) return envelope({ status: "not_found", error_code: "reservation_not_found" });

  if (!CONFIRMABLE_FROM.has(reservation.status)) {
    registrarIntentoConfirmacion({
      reservation_id: args.reservation_id,
      verified_by: args.verified_by,
      result: "rejected",
      motivo: "estado_actual_no_confirmable",
      estado_actual: reservation.status,
    });
    return envelope({
      status: "denied",
      error_code: "reservation_already_resolved",
      data: reservation,
      source: "registro interno -- esta reserva ya no estaba en un estado confirmable (posible doble confirmación casi simultánea, o ya resuelta antes).",
    });
  }

  reservation.status = "confirmed";
  reservation.verified_by = args.verified_by;
  reservation.verified_at = now().toISOString();

  // Si había otras reservas pendientes en paralelo para el mismo vehículo
  // (Sección 27: puede pasar), esta es la que ganó -- las demás quedan
  // canceladas automáticamente, nunca se confirman dos para el mismo coche.
  const superseded: string[] = [];
  for (const other of reservations) {
    if (other.id !== reservation.id && other.vehicle_id === reservation.vehicle_id && CONFIRMABLE_FROM.has(other.status)) {
      other.status = "cancelled";
      superseded.push(other.id);
    }
  }

  writeCollection("reservations", reservations);
  registrarIntentoConfirmacion({ reservation_id: args.reservation_id, verified_by: args.verified_by, result: "confirmed" });
  setOfficialStatus(reservation.vehicle_id, "RESERVED", reservation.id);
  const entregado = await sendReservationConfirmedMessage(reservation.lead_phone, reservation.vehicle_id, reservation.id);
  if (!entregado) {
    raiseAlert({
      kind: "gestion_portal",
      lead_phone: reservation.lead_phone,
      reason: `La confirmación automática de la reserva de ${vehicleLabel(reservation.vehicle_id)} no se pudo entregar al cliente de verdad -- avísale a mano.`,
    });
  }

  return envelope({
    status: "ok",
    data: reservation,
    source: "confirmación manual del equipo",
    conflicts: superseded.length ? [`Otras ${superseded.length} reserva(s) pendiente(s) del mismo vehículo quedaron canceladas automáticamente.`] : [],
  });
}

function cancelReservation_sinBloqueo(args: { reservation_id: string; reason?: string }) {
  const reservations = readReservations();
  const reservation = reservations.find((r) => r.id === args.reservation_id);
  if (!reservation) return envelope({ status: "not_found", error_code: "reservation_not_found" });

  reservation.status = "cancelled";
  writeCollection("reservations", reservations);
  setOfficialStatus(reservation.vehicle_id, "AVAILABLE", null);

  return envelope({ status: "ok", data: { ...reservation, cancel_reason: args.reason ?? null }, source: "acción manual del equipo" });
}

// "Devolver" una reserva cancelada por error (22/10/2026, petición real:
// "asi como hayan botones de cancelar... que hayan botones de devolver") --
// la reactiva desde cero (nueva caducidad de 15 días, igual que una
// reserva nueva, nunca el plazo ya vencido de la cancelada). No se puede
// devolver si el coche ya quedó vendido mientras tanto -- no se pisa una
// venta real.
function reopenReservation_sinBloqueo(args: { reservation_id: string }) {
  const reservations = readReservations();
  const reservation = reservations.find((r) => r.id === args.reservation_id);
  if (!reservation) return envelope({ status: "not_found", error_code: "reservation_not_found" });
  if (reservation.status !== "cancelled") {
    return envelope({ status: "denied", error_code: "reservation_not_cancelled", data: reservation });
  }
  if (getOfficialStatus(reservation.vehicle_id) === "SOLD") {
    return envelope({ status: "denied", error_code: "vehicle_already_sold" });
  }

  const durationDays = businessInfo.reservation.duration_days;
  reservation.status = "pending_payment";
  reservation.expires_at = new Date(now().getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();
  writeCollection("reservations", reservations);
  setOfficialStatus(reservation.vehicle_id, "RESERVATION_PENDING", reservation.id);

  return envelope({ status: "ok", data: reservation, source: "acción manual del equipo" });
}

// Bloqueo entre procesos (09/11/2026, auditoría de concurrencia): estas cinco
// funciones leían la lista de reservas, la modificaban y la volvían a
// escribir. Dos operaciones casi simultáneas sobre el mismo vehículo podían
// pisarse -- el caso grave es dos reservas confirmadas del mismo coche, o un
// pago verificado que se pierde. Sin cambiar ninguna firma.
export function submitPaymentReceipt(...a: Parameters<typeof submitPaymentReceipt_sinBloqueo>): ReturnType<typeof submitPaymentReceipt_sinBloqueo> {
  return withPersistentLockSync("col_reservations", () => submitPaymentReceipt_sinBloqueo(...a));
}
export function cancelReservation(...a: Parameters<typeof cancelReservation_sinBloqueo>): ReturnType<typeof cancelReservation_sinBloqueo> {
  return withPersistentLockSync("col_reservations", () => cancelReservation_sinBloqueo(...a));
}
export function reopenReservation(...a: Parameters<typeof reopenReservation_sinBloqueo>): ReturnType<typeof reopenReservation_sinBloqueo> {
  return withPersistentLockSync("col_reservations", () => reopenReservation_sinBloqueo(...a));
}
// Estas dos son async (tocan calendario/avisos), así que usan el bloqueo
// asíncrono, que espera sin bloquear el bucle de eventos.
export function createReservationPending(...a: Parameters<typeof createReservationPending_sinBloqueo>): ReturnType<typeof createReservationPending_sinBloqueo> {
  return withPersistentLock("col_reservations", () => createReservationPending_sinBloqueo(...a), 30_000);
}
export function confirmReservation(...a: Parameters<typeof confirmReservation_sinBloqueo>): ReturnType<typeof confirmReservation_sinBloqueo> {
  return withPersistentLock("col_reservations", () => confirmReservation_sinBloqueo(...a), 30_000);
}
