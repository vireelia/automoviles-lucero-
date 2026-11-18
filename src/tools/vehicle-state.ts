import { readCollection, writeCollection } from "../store.js";
import { withPersistentLockSync } from "../locks.js";

// Estado interno de reserva por vehículo (Sección 9 y 25-27 del encargo).
// Independiente del `stock_status` de vehicles-seed.ts, que es una
// observación pública sin confirmar -- esto es lo único que SÍ controlamos
// nosotros mismos (reservas creadas por nuestras propias herramientas), así
// que es la única fuente que puede mover un vehículo a RESERVATION_PENDING/
// RESERVED/SOLD de verdad. Un interés o una cita NUNCA escriben aquí
// (Sección 9: "el interés de un cliente y una cita NO deben bloquear el
// vehículo").
export type OfficialVehicleStatus = "AVAILABLE" | "RESERVATION_PENDING" | "RESERVED" | "SOLD";

export type VehicleStateRow = {
  vehicle_id: string;
  status: OfficialVehicleStatus;
  reservation_id: string | null;
  updated_at: string;
};

function now() {
  return new Date().toISOString();
}

function all(): VehicleStateRow[] {
  return readCollection<VehicleStateRow>("vehicle_state", []);
}

export function getOfficialStatus(vehicleId: string): OfficialVehicleStatus {
  const row = all().find((r) => r.vehicle_id === vehicleId);
  return row?.status ?? "AVAILABLE";
}

// Fase 2B (17/11/2026, auditoría de las 8 reservas huérfanas): getOfficialStatus
// por sí sola NO distingue "sé con certeza que está AVAILABLE" (hay una fila
// en vehicle_state que lo dice) de "no tengo ninguna fila -- ni idea". Eso
// hacía que un vehicle_id inventado, o huérfano tras una reimportación,
// devolviera "AVAILABLE" igual que uno de verdad confirmado, y
// createReservationPending nunca lo distinguía. getOfficialStatus se deja
// intacta (la usan muchas pantallas del CRM solo para pintar un estado sobre
// vehículos que YA sabemos que existen en el catálogo -- no es ahí donde está
// el riesgo real). El riesgo real está en el flujo de creación de reserva,
// que ahora usa esta función nueva junto con la comprobación de catálogo en
// reservations.ts.
export type VerifiedVehicleStatus = {
  status: OfficialVehicleStatus;
  // true solo si existe una fila real en vehicle_state para este vehicle_id.
  // false significa "no tenemos ningún registro propio -- el AVAILABLE de
  // status aquí es un valor por defecto, NUNCA una confirmación".
  verified: boolean;
};

export function getVerifiedStatus(vehicleId: string): VerifiedVehicleStatus {
  const row = all().find((r) => r.vehicle_id === vehicleId);
  if (!row) return { status: "AVAILABLE", verified: false };
  return { status: row.status, verified: true };
}

// Fase 2B, punto 2 (identificadores inestables entre reimportaciones):
// detecta vehicle_state "huérfano" -- una fila con una reserva/venta real en
// curso (RESERVATION_PENDING o RESERVED) cuyo vehicle_id ya NO aparece en el
// catálogo actual (currentVehicles()). Esto es la señal de que una
// reimportación de Dealcar le cambió el id al coche (el idvehiculo del feed
// no está confirmado como estable -- ver informe) y dejó esa reserva
// "flotando" sin vehículo al que atarse. NUNCA se resuelve solo (ni se marca
// SOLD, ni se reasigna a otro id automáticamente) -- solo se expone para que
// el equipo lo revise a mano desde el CRM. No se exporta ningún
// "auto-fix": decidir que un coche reimportado con otro id es el mismo coche
// que uno RESERVED exige comprobar matrícula o hablar con el cliente, nunca
// adivinarlo por marca+modelo (puede haber varias unidades idénticas).
export function getOrphanedVehicleStates(existingVehicleIds: Set<string>): VehicleStateRow[] {
  return all().filter(
    (r) => (r.status === "RESERVATION_PENDING" || r.status === "RESERVED") && !existingVehicleIds.has(r.vehicle_id),
  );
}

function setOfficialStatus_sinBloqueo(vehicleId: string, status: OfficialVehicleStatus, reservationId: string | null) {
  const rows = all();
  const existing = rows.find((r) => r.vehicle_id === vehicleId);
  if (existing) {
    existing.status = status;
    existing.reservation_id = reservationId;
    existing.updated_at = now();
  } else {
    rows.push({ vehicle_id: vehicleId, status, reservation_id: reservationId, updated_at: now() });
  }
  writeCollection("vehicle_state", rows);
}

// Bloqueo entre procesos (09/11/2026): el estado oficial del vehículo es lo
// que impide vender o reservar dos veces el mismo coche. Dos escrituras
// simultáneas podían perder una.
export function setOfficialStatus(...a: Parameters<typeof setOfficialStatus_sinBloqueo>): ReturnType<typeof setOfficialStatus_sinBloqueo> {
  return withPersistentLockSync("col_vehicle_state", () => setOfficialStatus_sinBloqueo(...a));
}
