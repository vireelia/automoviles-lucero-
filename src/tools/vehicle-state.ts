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

type VehicleStateRow = {
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
