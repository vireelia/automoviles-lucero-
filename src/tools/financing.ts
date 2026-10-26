import { appendToCollection } from "../store.js";
import { envelope } from "../response.js";
import { businessInfo } from "../data/business-info.js";
import { getBusinessConfig } from "../data/business-config.js";
import { vehiclesSeed } from "../data/vehicles-seed.js";

function now() {
  return new Date().toISOString();
}

// request_financing (Sección 16): solo comprueba los criterios orientativos
// confirmados y registra la solicitud. NUNCA aprueba, NUNCA calcula cuota,
// TIN o TAE -- eso lo hace la entidad financiera. El agente solo debe
// mencionar esto si el cliente pregunta, nunca espontáneamente (regla
// explícita de la Sección 16).
export function requestFinancing(args: { lead_phone?: string; vehicle_id?: string; vehicle_age_years?: number }) {
  // min_price_eur/max_km/max_age_years pueden venir editados desde Ajustes
  // (26/10/2026) -- el resto (inclusive flags, plazo, sin entrada) se queda
  // fijo en business-info.ts, no está narrado en ningún prompt de todas formas.
  const cfg = getBusinessConfig();
  const criteria = { ...businessInfo.financing.criteria, min_price_eur: cfg.financingMinPriceEur, max_km: cfg.financingMaxKm, max_age_years: cfg.financingMaxAgeYears };
  const vehicle = args.vehicle_id ? vehiclesSeed.find((v) => v.id === args.vehicle_id) : undefined;

  let meets_orientative_criteria: boolean | "unknown" = "unknown";
  const notes: string[] = [];

  if (vehicle) {
    const priceOk = criteria.min_price_inclusive ? vehicle.price_eur >= criteria.min_price_eur : vehicle.price_eur > criteria.min_price_eur;
    const kmOk = criteria.max_km_inclusive ? vehicle.km <= criteria.max_km : vehicle.km < criteria.max_km;
    if (!priceOk) notes.push(`Precio (${vehicle.price_eur}€) por debajo del mínimo orientativo (${criteria.min_price_eur}€).`);
    if (!kmOk) notes.push(`Kilometraje (${vehicle.km} km) igual o por encima del máximo orientativo (${criteria.max_km} km).`);

    if (vehicle.year == null) {
      // Sin año conocido no se puede comprobar el criterio de antigüedad -- "unknown"
      // en vez de asumir que cumple, para no fabricar una elegibilidad que no se comprobó.
      meets_orientative_criteria = "unknown";
      notes.push(`Año del vehículo no disponible -- no se puede comprobar el criterio de antigüedad máxima (${criteria.max_age_years} años).`);
    } else {
      const vehicleAgeYears = new Date().getFullYear() - vehicle.year;
      const ageOk = criteria.max_age_inclusive ? vehicleAgeYears <= criteria.max_age_years : vehicleAgeYears < criteria.max_age_years;
      if (!ageOk) notes.push(`Antigüedad (${vehicleAgeYears} años) por encima del máximo orientativo (${criteria.max_age_years} años).`);
      if (vehicleAgeYears === criteria.max_age_years) notes.push("Caso límite exacto de antigüedad -- no decidir, dejar que el equipo lo confirme.");
      meets_orientative_criteria = priceOk && kmOk && ageOk;
    }
    if (vehicle.km === criteria.max_km || vehicle.price_eur === criteria.min_price_eur) {
      notes.push("Caso límite exacto -- no decidir, dejar que el equipo lo confirme.");
    }
  }

  const request = {
    id: crypto.randomUUID(),
    ...args,
    meets_orientative_criteria,
    status: "pending_review",
    created_at: now(),
  };
  appendToCollection("financing_requests", request);

  return envelope({
    status: "ok",
    data: request,
    source: "Criterios orientativos confirmados 29/09/2026 -- no sustituyen estudio real de la entidad financiera.",
    conflicts: notes,
  });
}
