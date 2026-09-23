import { vehiclesSeed, type Vehicle } from "../data/vehicles-seed.js";
import { envelope } from "../response.js";

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

  return envelope({
    status: results.length === 0 ? "not_found" : "ok",
    data: {
      total_unique_units_matched: results.length,
      confirmed_available_count: confirmedAvailable,
      count_is_complete: true, // la búsqueda recorre todo el catálogo cargado, no es una página parcial de un proveedor externo
      page,
      page_size: PAGE_SIZE,
      total_pages: Math.max(1, Math.ceil(results.length / PAGE_SIZE)),
      results: pageResults,
    },
    source: "Catálogo interno cargado desde observación de coches.net 22/09/2026 -- NO es un feed en vivo.",
    source_updated_at: "2026-09-22",
    conflicts: pageResults.flatMap((v) => (v.conflicts.length ? [`${v.make} ${v.model} (${v.id}): ${v.conflicts.join(" / ")}`] : [])),
  });
}

export function getVehicle(args: { id: string }) {
  const vehicle = vehiclesSeed.find((v) => v.id === args.id);
  if (!vehicle) {
    return envelope({ status: "not_found", error_code: "vehicle_id_not_found" });
  }
  return envelope({
    status: vehicle.validation_status === "conflict" ? "needs_review" : "ok",
    data: vehicle,
    source: vehicle.source,
    source_updated_at: vehicle.source_updated_at,
    conflicts: vehicle.conflicts,
  });
}
