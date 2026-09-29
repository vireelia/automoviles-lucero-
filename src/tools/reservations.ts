import { appendToCollection, readCollection, writeCollection } from "../store.js";
import { envelope } from "../response.js";
import { businessInfo } from "../data/business-info.js";
import { getOfficialStatus, setOfficialStatus } from "./vehicle-state.js";

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
};

function now() {
  return new Date();
}

function readReservations() {
  return readCollection<Reservation>("reservations", []);
}

export function createReservationPending(args: { vehicle_id: string; lead_phone?: string }) {
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
    amount_eur: amount,
    status: "pending_payment",
    payment_receipt_note: null,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    verified_by: null,
    verified_at: null,
  };
  appendToCollection("reservations", reservation);
  setOfficialStatus(args.vehicle_id, "RESERVATION_PENDING", reservation.id);

  const conflicts = [
    "Datos bancarios/Bizum para el pago de la señal NO están configurados en este sistema todavía -- deriva con create_handoff para que el equipo le pase las instrucciones de pago reales. No inventes un número de cuenta ni un enlace de pago.",
  ];
  if (alreadyPending) {
    conflicts.push("Ya había otra reserva en curso para este mismo vehículo -- es válido, gana quien primero pague Y envíe justificante (Sección 27). Dile al cliente que conviene darse prisa si quiere asegurarlo, sin inventar quién más lo está pidiendo.");
  }

  return envelope({ status: "ok", data: reservation, source: "registro interno", conflicts });
}

export function submitPaymentReceipt(args: { reservation_id: string; note?: string }) {
  const reservations = readReservations();
  const reservation = reservations.find((r) => r.id === args.reservation_id);
  if (!reservation) return envelope({ status: "not_found", error_code: "reservation_not_found" });
  if (reservation.status !== "pending_payment") {
    return envelope({ status: "denied", error_code: "reservation_not_pending_payment", data: reservation });
  }
  reservation.status = "pending_verification";
  reservation.payment_receipt_note = args.note ?? "Cliente indica haber enviado justificante -- sin verificar todavía.";
  writeCollection("reservations", reservations);

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
export function confirmReservation(args: { reservation_id: string; verified_by: string }) {
  const reservations = readReservations();
  const reservation = reservations.find((r) => r.id === args.reservation_id);
  if (!reservation) return envelope({ status: "not_found", error_code: "reservation_not_found" });

  reservation.status = "confirmed";
  reservation.verified_by = args.verified_by;
  reservation.verified_at = now().toISOString();

  // Si había otras reservas pendientes en paralelo para el mismo vehículo
  // (Sección 27: puede pasar), esta es la que ganó -- las demás quedan
  // canceladas automáticamente, nunca se confirman dos para el mismo coche.
  const superseded: string[] = [];
  for (const other of reservations) {
    if (other.id !== reservation.id && other.vehicle_id === reservation.vehicle_id && (other.status === "pending_payment" || other.status === "pending_verification")) {
      other.status = "cancelled";
      superseded.push(other.id);
    }
  }

  writeCollection("reservations", reservations);
  setOfficialStatus(reservation.vehicle_id, "RESERVED", reservation.id);

  return envelope({
    status: "ok",
    data: reservation,
    source: "confirmación manual del equipo",
    conflicts: superseded.length ? [`Otras ${superseded.length} reserva(s) pendiente(s) del mismo vehículo quedaron canceladas automáticamente.`] : [],
  });
}

export function cancelReservation(args: { reservation_id: string; reason?: string }) {
  const reservations = readReservations();
  const reservation = reservations.find((r) => r.id === args.reservation_id);
  if (!reservation) return envelope({ status: "not_found", error_code: "reservation_not_found" });

  reservation.status = "cancelled";
  writeCollection("reservations", reservations);
  setOfficialStatus(reservation.vehicle_id, "AVAILABLE", null);

  return envelope({ status: "ok", data: { ...reservation, cancel_reason: args.reason ?? null }, source: "acción manual del equipo" });
}
