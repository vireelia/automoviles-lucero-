// Uso: DATA_DIR=/tmp/lucero-test-$$ npx tsx scripts/test-busqueda-barato-automatico.ts
// Caso real 21/11/2026 (+34 613204024): "automático barato" y "manual barato"
// devolvían 0 resultados y Carolina dijo que no había coches baratos.
import path from "path";
if (!process.env.DATA_DIR || process.env.DATA_DIR.includes(path.join("automoviles-lucero", "data"))) {
  console.error("Niega ejecutar sin una DATA_DIR de prueba explícita y distinta de la de producción.");
  process.exit(1);
}
const { searchVehicles, PORTAL_URL, normalizeSpoken } = await import("../src/tools/vehicles.js");
type R = { status: string; data: { results: { price_eur: number; version: string; make: string }[]; search_notes?: string[]; no_match_guidance?: { portal_url: string; cheapest_available: unknown[]; instruction: string } } };
const run = (a: Parameters<typeof searchVehicles>[0]) => searchVehicles(a) as unknown as R;

let ok = 0, total = 0;
function check(name: string, cond: boolean) { total++; if (cond) { ok++; console.log("  ✓", name); } else console.log("  ✗ FALLA:", name); }

const r1 = run({ query: "automático barato" });
check('"automático barato" ya no da 0 resultados', r1.data.results.length > 0);
check("...y están ordenados del más barato al más caro", r1.data.results.every((v, i, a) => i === 0 || a[i - 1].price_eur <= v.price_eur));
check("...solo coches con cambio automático (campo real del feed)", r1.data.results.every((v) => v.gearbox === "Automático"));
check("...con nota para el agente", (r1.data.search_notes ?? []).length > 0);

const r2 = run({ query: "algo barato para primer coche" });
check('"algo barato para primer coche" devuelve coches, el más barato primero', r2.data.results.length > 0 && r2.data.results[0].price_eur === Math.min(...r2.data.results.map((v) => v.price_eur)));

const r3 = run({ query: "manual barato" });
check('"manual barato" ya no da 0 resultados', r3.data.results.length > 0);
check("...solo coches con cambio manual (campo real del feed)", r3.data.results.every((v) => v.gearbox === "Manual"));
const r4g = run({ category: "berlina", gearbox: "automatico" });
check("filtro gearbox por parámetro funciona", r4g.data.results.every((v) => v.gearbox === "Automático"));

const r4 = run({ query: "Audi A3" });
check('búsqueda normal "Audi A3" sigue igual (sin notas)', !r4.data.search_notes);
const r5 = run({ query: "furgoneta" });
check('"furgoneta" sigue encontrando por categoría', r5.data.results.length > 0);

const r6 = run({ query: "xyzmarcaquenoexiste" });
check("sin coincidencia real: status not_found", r6.status === "not_found");
check("...con el enlace del portal y los 3 más baratos", r6.data.no_match_guidance?.portal_url === PORTAL_URL && (r6.data.no_match_guidance?.cheapest_available.length ?? 0) === 3);
check("...y la instrucción de no cerrar con 'no tengo'", (r6.data.no_match_guidance?.instruction ?? "").includes("No cierres con 'no tengo'"));

// Modelos dictados por voz (23/11/2026)
check('"Audi Q tres" se normaliza a q3', normalizeSpoken("Audi Q tres").includes("q3"));
check('"equis cinco" -> x5', normalizeSpoken("equis cinco") === "x5");
check('"serie uno" -> serie 1', normalizeSpoken("serie uno") === "serie 1");
check('"Rasp cuatro" -> rav4', normalizeSpoken("Rasp cuatro") === "rav4");

console.log(`\n${ok}/${total} pruebas superadas.`);
process.exit(ok === total ? 0 : 1);

