import { readCollection } from "../store.js";
import { vehiclesSeed, type Vehicle } from "./vehicles-seed.js";

// Inventario tal como lo ve el equipo: la semilla del export de Coches.net con los
// precios que el equipo haya cambiado desde el CRM. Miguel y el CRM leen de aquí.
export function currentVehicles(): Vehicle[] {
  const overrides = readCollection<{ vehicle_id: string; price_eur: number }>("vehicle_overrides");
  if (overrides.length === 0) return vehiclesSeed;
  return vehiclesSeed.map((v) => {
    const o = overrides.find((x) => x.vehicle_id === v.id);
    return o ? { ...v, price_eur: o.price_eur } : v;
  });
}
