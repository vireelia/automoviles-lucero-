import { type Vehicle } from "../data/vehicles-seed.js";
import { currentVehicles } from "../data/vehicles-current.js";
import { businessInfo } from "../data/business-info.js";
import { envelope } from "../response.js";
import { getOfficialStatus } from "./vehicle-state.js";

const PAGE_SIZE = 10;

function normalize(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// El cliente dice "SUV", "todoterreno", "furgoneta", "coche familiar", etc.
// -- el feed real de Coches.net PRO usa solo 5 valores de carrocería. Este
// mapa traduce el lenguaje natural a esos 5 valores reales.
const CATEGORY_SYNONYMS: Record<string, string> = {
  suv: normalize("4x4"),
  todoterreno: normalize("4x4"),
  "todo terreno": normalize("4x4"),
  furgoneta: normalize("Industriales"),
  furgon: normalize("Industriales"),
  comercial: normalize("Industriales"),
  compacto: normalize("Berlina"),
  urbano: normalize("Berlina"),
  sedan: normalize("Berlina"),
  familiar: normalize("Familiar"),
  monovolumen: normalize("Monovolumen"),
};

// Todas las marcas reales del inventario cargado, para el aviso de "quizá
// quisiste decir" de más abajo (Sección FALLO REAL 14/10/2026: la voz
// transcribe fatal los nombres de modelo -- "Rav4" como "Rasp cuatro",
// "Aygo" como "Aigo" -- así que una búsqueda de texto libre falla aunque el
// coche exista. Esto no depende de que el agente se acuerde de reintentar:
// el propio resultado de la búsqueda ya lleva la pista).
function knownMakes(): string[] {
  return [...new Set(currentVehicles().map((v) => v.make))];
}

// Búsqueda de texto libre (22/11/2026, caso real: una clienta pidió "algo
// barato para primer coche y que sea automático" y la búsqueda literal de
// "automático barato" devolvió 0 resultados -- esas palabras no están en
// marca, modelo ni versión -- así que el agente le dijo que no había coches
// baratos ni automáticos, con 38 coches disponibles y 10 por debajo de
// 9.000 €). Las palabras de "cualidad" (barato, automático, manual) no se
// buscan como texto: se interpretan.
const CHEAP_WORDS = new Set(["barato", "barata", "baratos", "baratas", "economico", "economica", "economicos", "economicas", "asequible", "asequibles"]);
const AUTO_WORDS = new Set(["automatico", "automatica", "automaticos", "automaticas", "automatic"]);
const MANUAL_WORDS = new Set(["manual", "manuales"]);
const FILLER_WORDS = new Set([
  "coche", "coches", "carro", "vehiculo", "vehiculos", "primer", "primero", "algo", "para", "un", "una", "unos", "unas", "que",
  "sea", "y", "o", "de", "del", "el", "la", "los", "las", "con", "mi", "busco", "quiero", "necesito", "buscar", "tipo", "cambio", "me", "interesa", "en",
]);
// Solo cuenta como automático el que lo dice en su versión; el feed no trae
// el tipo de cambio como campo, así que nunca se afirma lo que no consta.
const EXPLICIT_AUTO = /\b(aut\.?|automatic[oa]?|dsg|s[\s-]?tronic|tiptronic|steptronic|multitronic|edc|cvt|xtronic|[789]g-?tronic|g-?tronic|powershift|robotizado|easytronic|dualogic|speedshift)(?=\W|$)/i;
export const PORTAL_URL = "https://www.coches.net/concesionario/autolunaslagunamadrid/";

export function searchVehicles(args: {
  query?: string;
  make?: string;
  model?: string;
  category?: string;
  max_price_eur?: number;
  min_price_eur?: number;
  max_km?: number;
  fuel?: string;
  page?: number;
}) {
  let results: Vehicle[] = currentVehicles();

  // FALLO REAL detectado (21/11/2026, llamada real: "una furgoneta de unos
  // 11.000 euros" -- el agente no la encontró aunque existían 2 reales en
  // ese rango de precio): query solo comparaba contra marca/modelo/versión,
  // nunca contra la categoría -- ningún coche tiene literalmente
  // "furgoneta" en su marca o modelo, así que una búsqueda de texto libre
  // con solo el tipo de vehículo (sin marca/modelo concretos) siempre
  // devolvía 0 resultados, aunque category si lo habría encontrado. Ahora
  // también compara contra la categoría normalizada (mismos sinónimos ya
  // reales de CATEGORY_SYNONYMS), sin tocar el resto del comportamiento.
  let q = args.query ? normalize(args.query) : null;
  const searchNotes: string[] = [];
  let wantsCheap = false;
  let wantsAuto = false;
  let wantsManual = false;
  if (q) {
    const words = q.split(/[^a-z0-9]+/).filter(Boolean);
    wantsCheap = words.some((w) => CHEAP_WORDS.has(w));
    wantsAuto = words.some((w) => AUTO_WORDS.has(w));
    wantsManual = words.some((w) => MANUAL_WORDS.has(w));
    if (wantsCheap || wantsAuto || wantsManual) {
      const residual = words.filter((w) => !CHEAP_WORDS.has(w) && !AUTO_WORDS.has(w) && !MANUAL_WORDS.has(w) && !FILLER_WORDS.has(w) && !/^\d+$/.test(w));
      q = residual.length > 0 ? residual.join(" ") : null;
    }
  }
  if (q) {
    // La consulta puede traer más palabras que solo el tipo de vehículo
    // ("furgoneta de unos 11000 euros") -- se busca cualquier sinónimo de
    // categoría conocido como palabra suelta dentro de la consulta, nunca
    // una igualdad exacta de la frase completa.
    const qWords = q.split(/[^a-z0-9]+/).filter(Boolean);
    const categoryFromQuery = qWords.map((w) => CATEGORY_SYNONYMS[w]).find(Boolean) ?? null;
    results = results.filter((v) => {
      if (normalize(`${v.make} ${v.model} ${v.version}`).includes(q)) return true;
      return categoryFromQuery !== null && normalize(v.category) === categoryFromQuery;
    });
  }
  if (args.make) results = results.filter((v) => normalize(v.make) === normalize(args.make!));
  if (args.model) results = results.filter((v) => normalize(v.model).includes(normalize(args.model!)));
  // category es la carrocería real del feed de Coches.net PRO: Monovolumen,
  // Berlina, Industriales, 4x4, Familiar. "SUV"/"todoterreno" (lenguaje
  // natural del cliente) se normaliza a "4x4" antes de llegar aquí -- ver
  // CATEGORY_SYNONYMS.
  if (args.category) {
    const wanted = CATEGORY_SYNONYMS[normalize(args.category)] ?? normalize(args.category);
    results = results.filter((v) => normalize(v.category) === wanted);
  }
  if (args.fuel) results = results.filter((v) => normalize(v.fuel) === normalize(args.fuel!));
  if (typeof args.max_price_eur === "number") results = results.filter((v) => v.price_eur <= args.max_price_eur!);
  if (typeof args.min_price_eur === "number") results = results.filter((v) => v.price_eur >= args.min_price_eur!);
  if (typeof args.max_km === "number") results = results.filter((v) => v.km <= args.max_km!);

  if (wantsAuto) {
    const autos = results.filter((v) => EXPLICIT_AUTO.test(v.version));
    if (autos.length > 0) {
      results = autos;
      searchNotes.push("Automáticos: solo se pueden identificar los que lo indican en su versión (Aut., DSG, S tronic...); puede haber más -- la ficha de cada coche o el equipo lo confirma. No digas que no hay otros.");
    } else {
      searchNotes.push("El catálogo no indica el tipo de cambio de estos coches: NO digas que no hay automáticos. Di que lo confirma el equipo y ofrece el catálogo.");
    }
  }
  if (wantsManual) {
    searchNotes.push("El catálogo no indica el tipo de cambio de la mayoría de coches: NO digas que no hay manuales. Di que lo confirma el equipo y ofrece el catálogo.");
  }
  if (wantsCheap) {
    results = [...results].sort((a, b) => a.price_eur - b.price_eur);
    searchNotes.push("\"Barato\" se ha interpretado como ordenar de menor a mayor precio (sin tope de presupuesto): enseña los más baratos con su precio real y pregunta el presupuesto aproximado.");
  }

  const page = args.page && args.page > 0 ? args.page : 1;
  const start = (page - 1) * PAGE_SIZE;
  const pageResults = results.slice(start, start + PAGE_SIZE);

  const confirmedAvailable = results.filter((v) => v.stock_status === "available").length;

  const pageResultsWithStatus = pageResults.map((v) => ({ ...v, official_status: getOfficialStatus(v.id) }));

  // Si la búsqueda de texto libre no encontró nada, pero el texto menciona
  // una marca real del inventario, se adjuntan TODOS los modelos de esa
  // marca como sugerencia -- así el agente no depende de acordarse de
  // reintentar manualmente cuando el modelo viene mal transcrito por voz.
  let sameMakeSuggestions: (Vehicle & { official_status: string })[] = [];
  if (results.length === 0 && q) {
    // Coincide por palabra significativa de la marca, no por el nombre
    // completo -- "Mercedes-Benz" hay que reconocerlo si el cliente solo
    // dice "Mercedes" (nadie dice "Mercedes-Benz" entero hablando).
    const matchedMake = knownMakes().find((make) =>
      normalize(make)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3)
        .some((word) => q.includes(word)),
    );
    if (matchedMake) {
      sameMakeSuggestions = currentVehicles()
        .filter((v) => v.make === matchedMake)
        .map((v) => ({ ...v, official_status: getOfficialStatus(v.id) }));
    }
  }

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
      // Si "results" viene vacío pero esto no, el cliente mencionó una marca
      // real -- compara estos modelos con lo que dijo (fonéticamente, la voz
      // transcribe mal) antes de decir que no lo tenemos.
      same_make_suggestions: sameMakeSuggestions,
      ...(searchNotes.length > 0 ? { search_notes: searchNotes } : {}),
      // Venta perdida (22/11/2026, "cuando pase esto, que Carolina le envíe el
      // link del portal y le diga que mire algún coche que le interese y le
      // diga marca y modelo para concertarle una visita o reserva"): sin
      // coincidencia exacta NUNCA se cierra con "no tengo" -- se ofrece el
      // catálogo completo y los más baratos reales.
      ...(results.length === 0
        ? {
            no_match_guidance: {
              portal_url: PORTAL_URL,
              cheapest_available: currentVehicles()
                .filter((v) => v.stock_status === "available")
                .sort((a, b) => a.price_eur - b.price_eur)
                .slice(0, 3)
                .map((v) => ({ make: v.make, model: v.model, version: v.version, year: v.year, km: v.km, price_eur: v.price_eur })),
              instruction:
                "No cierres con 'no tengo'. Envía el enlace del catálogo, pídele que mire cualquier coche que le interese y te diga marca y modelo para concertarle una visita o una reserva, y ofrécele los más baratos de cheapest_available.",
            },
          }
        : {}),
    },
    source: "Coches.net PRO (exportación oficial del negocio, feed XML) -- refrescado 14/10/2026. NO es un feed en vivo todavía.",
    source_updated_at: "2026-10-14",
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
    data: { provider: "cochesnet_pro_export_manual", vehicle_count: currentVehicles().length, last_observed_at: "2026-10-01" },
    source: "INVENTORY_PROVIDER -- import manual del feed XML de Coches.net PRO (sin API en vivo todavía). Wallapop sigue PENDING_INTEGRATION (Sección 49).",
  });
}

export function getVehicle(args: { id: string }) {
  const vehicle = currentVehicles().find((v) => v.id === args.id);
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
  const vehicle = currentVehicles().find((v) => v.id === args.id);
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
  const base = currentVehicles().find((v) => v.id === args.vehicle_id);
  if (!base) return envelope({ status: "not_found", error_code: "vehicle_id_not_found" });

  const range = businessInfo.similar_vehicles_match;
  // Antes usaba make/model como proxy de "categoría" (mal: un BMW Serie 3
  // nunca es similar a un Tiguan solo por no compartir marca, y sí lo sería
  // un Tiguan y un Q3 aunque sean marcas distintas). Ahora usa la carrocería
  // real (Vehicle.category).
  const sameCategory = (v: Vehicle) => v.category === base.category;

  const candidates = currentVehicles()
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
    source: "Coches.net PRO (exportación oficial del negocio, feed XML) -- refrescado 14/10/2026. NO es un feed en vivo todavía.",
    conflicts: candidates.flatMap((v) => (v.conflicts.length ? [`${v.make} ${v.model} (${v.id}): ${v.conflicts.join(" / ")}`] : [])),
  });
}
