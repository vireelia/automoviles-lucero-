// FALLO REAL CRÍTICO corregido (18/11/2026, auditoría "Calidad
// conversacional, coordinación y preproducción"): search_vehicles,
// get_vehicle, get_vehicle_status, find_similar_vehicles y
// create_reservation_pending NUNCA estuvieron declaradas en
// src/chat/tool-schemas.json (el archivo real que usa chat/agent.ts para
// construir las tools que se ofrecen a OpenAI en WhatsApp/correo/chat
// web) -- la API de OpenAI solo permite a un modelo llamar a una función
// si está en esa lista, así que Carolina y Daniel JAMÁS pudieron, en la
// práctica, buscar un vehículo ni crear una reserva real a través de una
// conversación normal, a pesar de que el prompt (compartido con voz) lo
// instruye explícitamente y de que dispatch.ts/reservations.ts sí tenían
// el código real para hacerlo. Coincide con el incidente ya documentado
// el 18/10/2026 ("jamás apareció la reserva de verdad en el sistema").
//
// Esta prueba demuestra el arreglo de punta a punta: una conversación
// simulada donde el modelo (mock) pide estas herramientas, y se confirma
// que de verdad se ejecutan (nunca "unknown_tool") y devuelven datos
// reales del catálogo/reservas.
//
// NUNCA usa DATA_DIR de producción, NUNCA manda un mensaje real.
// Uso: DATA_DIR=/tmp/lucero-test-$$ npx tsx scripts/test-critical-tool-gap.ts

import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";

if (!process.env.DATA_DIR || process.env.DATA_DIR.includes(path.join("automoviles-lucero", "data"))) {
  console.error("Niega ejecutar sin una DATA_DIR de prueba explícita y distinta de la de producción.");
  process.exit(1);
}
process.env.OPENAI_API_KEY = "test-key-mock-only";

const results: { name: string; ok: boolean; detail?: string }[] = [];
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`OK   - ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    console.log(`FAIL - ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const { dispatchTool, AGENT_TOOL_NAMES } = await import("../src/chat/dispatch.js");
const { vehiclesSeed } = await import("../src/data/vehicles-seed.js");
const { setOfficialStatus } = await import("../src/tools/vehicle-state.js");
const toolSchemas = (await import("../src/chat/tool-schemas.json", { with: { type: "json" } })).default as { function: { name: string } }[];

await test("Las 5 tools críticas están declaradas en tool-schemas.json (lo que de verdad ve el modelo)", () => {
  const names = new Set(toolSchemas.map((t) => t.function.name));
  for (const n of ["search_vehicles", "get_vehicle", "get_vehicle_status", "find_similar_vehicles", "create_reservation_pending"]) {
    assert.ok(names.has(n), `falta declarar "${n}" -- si no está aquí, OpenAI nunca permite que el modelo la llame`);
  }
});

await test("Las 5 tools críticas tienen handler real registrado (dispatchTool no devuelve unknown_tool)", async () => {
  for (const n of ["search_vehicles", "get_vehicle", "get_vehicle_status", "find_similar_vehicles", "create_reservation_pending"]) {
    assert.ok(AGENT_TOOL_NAMES.includes(n), `"${n}" debe estar en AGENT_TOOL_NAMES (HANDLERS de dispatch.ts)`);
  }
});

await test("search_vehicles de punta a punta: devuelve un vehículo real del catálogo, nunca unknown_tool", async () => {
  const r = (await dispatchTool("search_vehicles", { query: vehiclesSeed[0].make })) as any;
  assert.notEqual(r?.error_code, "unknown_tool");
  assert.ok(r?.status === "ok" || r?.data, `se esperaba un resultado real de búsqueda, llegó: ${JSON.stringify(r).slice(0, 200)}`);
});

await test("get_vehicle_status de punta a punta: consulta el estado real, nunca unknown_tool", async () => {
  const v = vehiclesSeed[0];
  const r = (await dispatchTool("get_vehicle_status", { id: v.id })) as any;
  assert.notEqual(r?.error_code, "unknown_tool");
  assert.equal(r.status, "ok");
  assert.equal(r.data.official_status, "AVAILABLE");
});

await test("create_reservation_pending de punta a punta -- EL FALLO CRÍTICO: antes devolvía unknown_tool, ahora crea la reserva real", async () => {
  const v = vehiclesSeed[1] ?? vehiclesSeed[0];
  setOfficialStatus(v.id, "AVAILABLE", null);
  const r = (await dispatchTool("create_reservation_pending", { vehicle_id: v.id, lead_phone: "+34699888777", channel: "WHATSAPP" })) as any;
  assert.notEqual(r?.error_code, "unknown_tool", "ESTE es el fallo real que existía: la reserva nunca se creaba desde WhatsApp/correo/chat, solo el aviso suelto llegaba al equipo");
  assert.equal(r.status, "ok", `se esperaba éxito creando la reserva, resultado real: ${JSON.stringify(r)}`);
  assert.equal(r.data.status, "pending_payment");
  setOfficialStatus(v.id, "AVAILABLE", null);
});

await test("GAP cerrado: create_lead/update_lead ahora SÍ pueden pasar email desde WhatsApp -- antes la API ni lo permitía", () => {
  const names = ["create_lead", "update_lead"];
  for (const n of names) {
    const schema = toolSchemas.find((t: any) => t.function.name === n) as any;
    assert.ok(schema.function.parameters.properties.email, `${n} debe aceptar el parámetro email`);
  }
});

await test("Vínculo bidireccional real: email dado por WhatsApp se vincula al mismo lead que ya tenía el teléfono", async () => {
  const { upsertLead } = await import("../src/tools/leads.js");
  const { readCollection } = await import("../src/store.js");
  upsertLead({ phone: "+34688777666", channel: "WHATSAPP", name: "Cliente Bidireccional" });
  await dispatchTool("update_lead", { phone: "+34688777666", email: "bidireccional@ejemplo-real.com" });
  const leads = readCollection<any>("leads");
  const lead = leads.find((l: any) => l.phone === "+34688777666");
  assert.equal(lead.email, "bidireccional@ejemplo-real.com", "el email dado por WhatsApp debe quedar vinculado al mismo lead del teléfono");
});

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} pruebas superadas.`);
if (results.some((r) => !r.ok)) {
  console.log("Fallos:", results.filter((r) => !r.ok));
  process.exit(1);
}
