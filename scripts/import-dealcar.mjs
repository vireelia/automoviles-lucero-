// Importador real del feed de Dealcar para Automóviles Lucero.
//
// Uso: node scripts/import-dealcar.mjs <ruta-al-export.xml>
//
// Mismo formato real que Dealcar ya confirmó para Rivero Motors (un
// <cliente> con muchos <anuncio>) -- ver ese repo si aparece un export con
// una estructura distinta. Regenera src/data/vehicles-seed.ts por completo:
// no se edita ese archivo a mano, se vuelve a ejecutar este script cada vez
// que llegue un nuevo export de Dealcar.
//
// Principio "no inventes información": cualquier campo que el feed no dé se
// refleja como tal, nunca se adivina. Cualquier carrocería que no
// reconozcamos se mapea a "Otro" y queda registrada en conflicts para
// revisión manual, en vez de forzarla a una categoría que podría ser
// incorrecta.
//
// Nota sobre codificación: si el export llega con la misma codificación
// rota que tuvo el de Rivero Motors (U+FFFD en vez de "á/é/í/ó/ú/ñ"),
// fixMojibake() cubre los mismos valores exactos ya vistos en campos
// estructurados -- no repara texto libre arbitrario.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, "..", "src", "data", "vehicles-seed.ts");

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Uso: node scripts/import-dealcar.mjs <ruta-al-export.xml>");
  process.exit(1);
}

const xml = readFileSync(inputPath, "utf-8");
const sourceFileName = basename(inputPath);

const REPL = "�"; // carácter de reemplazo que deja una codificación rota del export

function fixMojibake(s) {
  if (!s) return s;
  let out = s;
  out = out.split(`Autom${REPL}tico`).join("Automático");
  out = out.split(`El${REPL}ctrico / H${REPL}brido`).join("Eléctrico / Híbrido");
  out = out.split(`Coup${REPL}`).join("Coupé");
  out = out.split(`a${REPL}os`).join("años");
  out = out.split(`a${REPL}o`).join("año");
  out = out.split(`Autom${REPL}vil`).join("Automóvil");
  out = out.split(`Veh${REPL}culos Industriales`).join("Vehículos Industriales");
  return out;
}

const CATEGORY_MAP = {
  "Berlina": "Berlina",
  "4x4": "4x4",
  "Monovolumen": "Monovolumen",
  "Industriales": "Industriales",
  "Familiar": "Familiar",
  "Coupé": "Coupé",
  "Cabrio": "Cabrio",
};

function getTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : "";
}

function parseFechaToISO(fecha) {
  // formato Dealcar: "DD/MM/YYYY HH:MM:SS"
  const m = fecha.match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return new Date().toISOString();
  const [, d, mo, y, h, mi, s] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).toISOString();
}

const blocks = xml.split("<anuncio>").slice(1).map((b) => b.split("</anuncio>")[0]);

const vehicles = [];
const warnings = [];

for (const block of blocks) {
  const idvehiculo = getTag(block, "idvehiculo");
  const referencia = getTag(block, "referencia");
  const fechapublicacion = getTag(block, "fechapublicacion");
  const marca = getTag(block, "marca");
  const modelo = getTag(block, "modelo");
  const version = getTag(block, "version");
  const anyoRaw = getTag(block, "anyo");
  const carroceriaRaw = fixMojibake(getTag(block, "carroceria"));
  const combustibleRaw = fixMojibake(getTag(block, "combustible"));
  const potenciaRaw = getTag(block, "potencia");
  const precioRaw = getTag(block, "precio");
  const kmRaw = getTag(block, "km");
  const garantiaRaw = fixMojibake(getTag(block, "garantia"));
  const cambioRaw = fixMojibake(getTag(block, "cambio"));
  const gearbox = /autom/i.test(cambioRaw) ? "Automático" : /manual/i.test(cambioRaw) ? "Manual" : null;

  const conflicts = [];
  let category = CATEGORY_MAP[carroceriaRaw];
  if (!category) {
    category = "Otro";
    conflicts.push(`Carrocería no reconocida en el mapeo del importador: "${carroceriaRaw}" (valor original de Dealcar) -- revisar manualmente.`);
    warnings.push(`idvehiculo ${idvehiculo}: carrocería desconocida "${carroceriaRaw}"`);
  }

  const fuel = combustibleRaw ? combustibleRaw : "Sin especificar en el feed de Dealcar";

  vehicles.push({
    id: `lucero-dealcar-${idvehiculo}`,
    ref_cochesnet: null,
    ref_wallapop: null,
    ref_dealcar: referencia || null,
    category,
    make: marca,
    model: modelo,
    version,
    year: anyoRaw ? Number(anyoRaw) : null,
    year_note: null,
    km: Number(kmRaw) || 0,
    fuel,
    gearbox,
    power_cv: Number(potenciaRaw) || 0,
    price_eur: Number(precioRaw) || 0,
    stock_status: "available",
    validation_status: "document_verified",
    known_defects: null,
    warranty_note: garantiaRaw || null,
    conflicts,
    source: `Feed Dealcar (XML, ${sourceFileName}), anuncio ${idvehiculo}, ref. interna ${referencia}, publicado ${fechapublicacion}.`,
    source_updated_at: parseFechaToISO(fechapublicacion),
  });
}

const header = `// Inventario REAL de Automóviles Lucero, importado del feed de Dealcar.
//
// NO EDITAR A MANO. Este archivo se genera con:
//   node scripts/import-dealcar.mjs <ruta-al-export-de-dealcar.xml>
// Cada vez que Automóviles Lucero mande un export nuevo de Dealcar, se vuelve
// a ejecutar el importador y se sobrescribe este archivo entero.
//
// Los vehículos con category: "Otro" tienen una carrocería que el importador
// no reconoció -- revisar conflicts para el valor original de Dealcar antes
// de confiar en esa categoría para búsquedas por tipo de coche.

export type Vehicle = {
  id: string;
  ref_cochesnet: string | null;
  ref_wallapop: string | null;
  ref_dealcar?: string | null;
  category: "Monovolumen" | "Berlina" | "Industriales" | "4x4" | "Familiar" | "Coupé" | "Cabrio" | "Otro";
  make: string;
  model: string;
  version: string;
  year: number | null;
  year_note: string | null;
  km: number;
  fuel: string;
  gearbox?: "Automático" | "Manual" | null; // campo <cambio> del feed (23/11/2026)
  power_cv: number;
  price_eur: number;
  stock_status: "available" | "reserved" | "sold" | "workshop" | "not_roadworthy" | "unknown";
  validation_status: "owner_confirmed" | "document_verified" | "observed_public" | "conflict" | "expired";
  known_defects: string | null;
  warranty_note: string | null;
  conflicts: string[];
  source: string;
  source_updated_at: string;
};

export const vehiclesSeed: Vehicle[] = `;

const body = JSON.stringify(vehicles, null, 2);
writeFileSync(OUT_FILE, header + body + ";\n", "utf-8");

console.log(`Importados ${vehicles.length} vehículos de ${sourceFileName} -> ${OUT_FILE}`);
if (warnings.length > 0) {
  console.log(`\nAvisos (${warnings.length}):`);
  for (const w of warnings) console.log(`  - ${w}`);
} else {
  console.log("Sin avisos -- todas las carrocerías se reconocieron.");
}
