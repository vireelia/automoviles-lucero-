import { vehiclesSeed, type Vehicle } from "../data/vehicles-seed.js";
import { businessInfo } from "../data/business-info.js";
import { envelope } from "../response.js";
import { getOfficialStatus } from "./vehicle-state.js";

const PAGE_SIZE = 10;

function normalize(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function searchVehicles(args: {
  query?: string;
  make?: string;
  model?: string;
  max_price_eur?: number;
  min_price_eur?: number;
  max_km?: number;
  fuel?: string;
  page?: number;
}) {
  let results: Vehicle[] = vehiclesSeed;

  const q = args.query ? normalize(args.query) : null;
  if (q) {
    results = results.filter((v) =>
      normalize(`${v.make} ${v.model} ${v.version}`).includes(q)
    );
  }
  if (args.make) results = results.filter((v) => normalize(v.make) === normalize(args.make!));
  if (args.model) results = results.filter((v) => normalize(v.model).includes(normalize(args.model!)));
  if (args.fuel) results = results.filter((v) => normalize(v.fuel) === normalize(args.fuel!));
  if (typeof args.max_price_eur === "number") results = results.filter((v) => v.price_eur <= args.max_price_eur!);
  if (typeof args.min_price_eur === "number") results = results.filter((v) => v.price_eur >= args.min_price_eur!);
  if (typeof args.max_km === "number") results = results.filter((v) => v.km <= args.max_km!);

  const page = args.page && args.page > 0 ? args.page : 1;
  const start = (page - 1) * PAGE_SIZE;
  const pageResults = results.slice(start, start + PAGE_SIZE);

  // Ninguna unidad tiene stock_status "available" todavía (Sección 6: por
  // defecto "unknown" hasta que el negocio confirme). Esto es intencional,
  // no un error -- el conteo de "disponibles confirmados" es honesto: 0.
  const confirmedAvailable = results.filter((v) => v.stock_status === "available").length;

  const pageResultsWithStatus = pageResults.map((v) => ({ ...v, official_status: getOfficialStatus(v.id) }));

  return envelope({
    status: results.length === 0 ? "not_found" : "ok",
    data: {
      total_unique_units_matched: results.length,
      confirmed_available_count: confirmedAvailable,
      count_is_complete: true, // la búsqueda recorre todo el catálogo cargado, no es una página parcial de un proveedor externo
      page,
      page_size: PAGE_SIZE,
      total_pages: Math.max(1, Math.ceil(results.length / PAGE_SIZE)),
      results: pageResultsWithStatus,
    },
    source: "Catálogo interno cargado desde observación de coches.net 22/09/2026 -- NO es un feed en vivo.",
    source_updated_at: "2026-09-22",
    conflicts: pageResults.flatMap((v) => (v.conflicts.length ? [`${v.make} ${v.model} (${v.id}): ${v.conflicts.join(" / ")}`] : [])),
  });
}

// sync_inventory (Sección 8/46/49): placeholder honesto de la capa
// INVENTORY_PROVIDER. Hoy lee de vehicles-seed.ts (observación estática,
// Sección 49 "puede leer desde DATABASE"); el día que haya acceso
// autorizado a Coches.net/Wallapop, esta función pasa a llamar al
// proveedor real sin que los agentes ni sus tools cambien de forma.
export function syncInventory() {
  return envelope({
    status: "denied",
    error_code: "no_authorized_source_connected",
    data: { provider: "static_seed", vehicle_count: vehiclesSeed.length, last_observed_at: "2026-09-22" },
    source: "INVENTORY_PROVIDER -- Coches.net/Wallapop marcados PENDING_INTEGRATION (Sección 49). No hay sincronización diaria real todavía.",
  });
}

export function getVehicle(args: { id: string }) {
  const vehicle = vehiclesSeed.find((v) => v.id === args.id);
  if (!vehicle) {
    return envelope({ status: "not_found", error_code: "vehicle_id_not_found" });
  }
  return envelope({
    status: vehicle.validation_status === "conflict" ? "needs_review" : "ok",
    data: { ...vehicle, official_status: getOfficialStatus(vehicle.id) },
    source: vehicle.source,
    source_updated_at: vehicle.source_updated_at,
    conflicts: vehicle.conflicts,
  });
}

// get_vehicle_status (Sección 43): SOLO consulta el estado oficial que
// nosotros mismos controlamos (reservas propias) -- nunca inventa
// disponibilidad en vivo del portal, que sigue sin integración (Sección 49).
export function getVehicleStatus(args: { id: string }) {
  const vehicle = vehiclesSeed.find((v) => v.id === args.id);
  if (!vehicle) return envelope({ status: "not_found", error_code: "vehicle_id_not_found" });
  return envelope({
    status: "ok",
    data: {
      vehicle_id: vehicle.id,
      official_status: getOfficialStatus(vehicle.id),
      known_defects: vehicle.known_defects,
    },
    source: "Estado interno de reservas propio -- no es un feed en vivo del portal.",
  });
}

// find_similar_vehicles (Secciones 30-32): mismo rango de precio/km,
// prioriza misma categoría, excluye el propio vehículo y cualquiera que ya
// esté RESERVED/SOLD en nuestro estado interno. Nunca ofrece fuera del
// presupuesto aproximado del original.
export function findSimilarVehicles(args: { vehicle_id: string }) {
  const base = vehiclesSeed.find((v) => v.id === args.vehicle_id);
  if (!base) return envelope({ status: "not_found", error_code: "vehicle_id_not_found" });

  const range = businessInfo.similar_vehicles_match;
  const sameCategory = (v: Vehicle) => v.make === base.make || v.model === base.model;

  const candidates = vehiclesSeed
    .filter((v) => v.id !== base.id)
    .filter((v) => getOfficialStatus(v.id) === "AVAILABLE")
    .filter((v) => v.price_eur >= base.price_eur - range.price_range_eur && v.price_eur <= base.price_eur + range.price_range_eur)
    .filter((v) => v.km >= base.km - range.km_range && v.km <= base.km + range.km_range)
    .sort((a, b) => {
      const catA = sameCategory(a) ? 0 : 1;
      const catB = sameCategory(b) ? 0 : 1;
      if (catA !== catB) return catA - catB;
      const priceDiffA = Math.abs(a.price_eur - base.price_eur);
      const priceDiffB = Math.abs(b.price_eur - base.price_eur);
      if (priceDiffA !== priceDiffB) return priceDiffA - priceDiffB;
      return Math.abs(a.km - base.km) - Math.abs(b.km - base.km);
    })
    .slice(0, range.limit);

  return envelope({
    status: candidates.length === 0 ? "not_found" : "ok",
    data: { base_vehicle_id: base.id, results: candidates },
    source: "Catálogo interno cargado desde observación de coches.net 22/09/2026 -- NO es un feed en vivo.",
    conflicts: candidates.flatMap((v) => (v.conflicts.length ? [`${v.make} ${v.model} (${v.id}): ${v.conflicts.join(" / ")}`] : [])),
  });
}
