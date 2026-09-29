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
  if (currentStatus === "RESERVATION_PENDING") {
    return envelope({
      status: "denied",
      error_code: "reservation_already_pending",
      data: { official_status: currentStatus },
      source: "Estado interno de reservas.",
      conflicts: ["Ya hay una reserva en curso para este vehículo -- prioridad de quien primero pague y envíe justificante (Sección 27)."],
    });
  }

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

  return envelope({
    status: "ok",
    data: reservation,
    source: "registro interno",
    conflicts: [
      "Datos bancarios/Bizum para el pago de la señal NO están configurados en este sistema todavía -- deriva con create_handoff para que el equipo le pase las instrucciones de pago reales. No inventes un número de cuenta ni un enlace de pago.",
    ],
  });
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
  writeCollection("reservations", reservations);
  setOfficialStatus(reservation.vehicle_id, "RESERVED", reservation.id);

  return envelope({ status: "ok", data: reservation, source: "confirmación manual del equipo" });
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
