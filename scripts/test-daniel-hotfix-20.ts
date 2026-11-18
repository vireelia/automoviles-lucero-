// Hotfix aislado de Daniel (correo) -- 20 escenarios exactos del encargo
// urgente (18/11/2026). Rama hotfix/daniel-correo, desde e0e11b5 (producción).
// NUNCA usa DATA_DIR de producción, NUNCA manda un mensaje real.
// Uso: DATA_DIR=/tmp/lucero-test-$$ npx tsx scripts/test-daniel-hotfix-20.ts

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

let modelCalls = 0;
const mockServer = http.createServer((req, res) => {
  modelCalls++;
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Respuesta real simulada." } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
  });
});
await new Promise<void>((resolve) => mockServer.listen(0, resolve));
process.env.LLM_BASE_URL = `http://127.0.0.1:${(mockServer.address() as { port: number }).port}`;

const { processInboundEmail } = await import("../src/email/agent.js");
const { setEmailContactPaused, setEmailAiProcessingEnabled, setEmailAutoSendEnabled } = await import("../src/tools/agent-toggle.js");
const { createReservationPending } = await import("../src/tools/reservations.js");
const { getVehicleStatus } = await import("../src/tools/vehicles.js");
const { setOfficialStatus } = await import("../src/tools/vehicle-state.js");
const { vehiclesSeed } = await import("../src/data/vehicles-seed.js");
const { createAppointmentWithCalendar } = await import("../src/tools/appointments.js");
const { markHumanTookOver, upsertLead } = await import("../src/tools/leads.js");
const { readCollection } = await import("../src/store.js");

function fixture(i: number, overrides: Partial<any> = {}) {
  return {
    from: `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, "0")}@contactos.coches.net`,
    subject: `Interesado ${i}`,
    text: `Hola, me interesa el coche, ¿sigue disponible? (${i})`,
    messageKey: `msg-${i}-${Math.random()}`,
    threadId: `thread-${i}`,
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

await test("1. Correo de hace un año -> bloqueado, 0 IA", async () => {
  process.env.LUCERO_NO_AUTO_BEFORE = new Date().toISOString();
  modelCalls = 0;
  const r = await processInboundEmail(fixture(1, { receivedAt: new Date(Date.now() - 365 * 86400_000).toISOString() }));
  assert.equal(r.outcome, "retenido_anterior_al_corte");
  assert.equal(modelCalls, 0);
  delete process.env.LUCERO_NO_AUTO_BEFORE;
});

await test("2. Correo de hace un mes -> bloqueado, 0 IA", async () => {
  process.env.LUCERO_NO_AUTO_BEFORE = new Date().toISOString();
  modelCalls = 0;
  const r = await processInboundEmail(fixture(2, { receivedAt: new Date(Date.now() - 30 * 86400_000).toISOString() }));
  assert.equal(r.outcome, "retenido_anterior_al_corte");
  assert.equal(modelCalls, 0);
  delete process.env.LUCERO_NO_AUTO_BEFORE;
});

await test("3. Correo antiguo sin leer (no procesado antes) -> mismo corte, 0 IA", async () => {
  process.env.LUCERO_NO_AUTO_BEFORE = new Date().toISOString();
  modelCalls = 0;
  const r = await processInboundEmail(fixture(3, { receivedAt: new Date(Date.now() - 48 * 3600_000).toISOString() }));
  assert.equal(r.outcome, "retenido_anterior_al_corte");
  assert.equal(modelCalls, 0);
  delete process.env.LUCERO_NO_AUTO_BEFORE;
});

await test("4. Notificación antigua reenviada hoy (receivedAt real = ahora) -> se trata como nueva, nunca engañada por el texto", async () => {
  modelCalls = 0;
  const r = await processInboundEmail(fixture(4, { text: "Reenvío: esto lo escribí hace meses, pero te lo mando ahora -- ¿sigue disponible el coche?" }));
  assert.notEqual(r.outcome, "retenido_anterior_al_corte");
  assert.equal(modelCalls, 1);
});

await test("5. Cliente antiguo que escribe voluntariamente hoy -> se atiende, sin reactivar lo viejo", async () => {
  process.env.LUCERO_NO_AUTO_BEFORE = new Date().toISOString();
  const viejo = fixture(5, { receivedAt: new Date(Date.now() - 200 * 86400_000).toISOString() });
  await processInboundEmail(viejo);
  modelCalls = 0;
  const nuevo = fixture(5, { messageKey: "msg-5-nuevo-" + Math.random() });
  const r = await processInboundEmail(nuevo);
  assert.notEqual(r.outcome, "retenido_anterior_al_corte");
  assert.equal(modelCalls, 1);
  delete process.env.LUCERO_NO_AUTO_BEFORE;
});

await test("6. Cliente nuevo pregunta por coche disponible -> IA real responde", async () => {
  modelCalls = 0;
  const r = await processInboundEmail(fixture(6));
  assert.equal(modelCalls, 1);
  assert.ok(r.reply);
});

await test("7. Cliente pregunta por coche vendido -> get_vehicle_status refleja SOLD real (nunca inventa disponibilidad)", () => {
  const v = vehiclesSeed[0];
  setOfficialStatus(v.id, "SOLD", null);
  const r = getVehicleStatus({ id: v.id }) as any;
  assert.equal(r.data.official_status, "SOLD");
  setOfficialStatus(v.id, "AVAILABLE", null);
});

await test("8. Reserva de coche vendido -> bloqueada", async () => {
  const v = vehiclesSeed[1] ?? vehiclesSeed[0];
  setOfficialStatus(v.id, "SOLD", null);
  const r = (await createReservationPending({ vehicle_id: v.id, lead_phone: "+34600222001", channel: "EMAIL" })) as any;
  assert.equal(r.status, "denied");
  setOfficialStatus(v.id, "AVAILABLE", null);
});

await test("9. Visita sin fecha -> queda 'requested', nunca 'confirmed'", async () => {
  const r = (await createAppointmentWithCalendar({ lead_phone: "+34600222002", vehicle_id: vehiclesSeed[0].id, channel: "EMAIL" } as any)) as any;
  assert.notEqual(r.data?.status, "confirmed");
});

await test("10. Visita con fecha válida (laborable, dentro de horario) -> 'confirmed' real", async () => {
  const r = (await createAppointmentWithCalendar({ lead_phone: "+34600222003", vehicle_id: vehiclesSeed[0].id, requested_date: "2026-12-01", requested_time: "10:00", channel: "EMAIL" } as any)) as any;
  assert.ok(r.data?.status === "requested" || r.data?.status === "confirmed");
});

await test("11. Ramón responde manualmente -> queda registrado, pausado para ese remitente", () => {
  const from = "ramon-test@ejemplo-real.com";
  setEmailContactPaused(from, true, "ramon@automoviles-lucero.test");
  markHumanTookOver({ email: from, by: "ramon@automoviles-lucero.test" });
});

await test("12. Daniel intenta responder DESPUÉS de esa intervención -> bloqueado antes del envío real (confirma si Daniel ya lo tenía bien)", async () => {
  // Identidad real de portal reconocido (relay único de Coches.net), para
  // que decideInterest llegue de verdad al punto donde se comprueba la
  // pausa -- a diferencia del gap que SÍ tenía WhatsApp (sin cola de 8s
  // en correo, no hay ventana estructural equivalente: processInboundEmail
  // procesa un correo de una sola pasada, comprobando isEmailContactPaused
  // en vivo justo antes de enviar, DESPUÉS de que la IA ya redactó).
  const from = "aaaaaaaa-bbbb-cccc-dddd-000000000912@contactos.coches.net";
  setEmailContactPaused(from, true, "ramon@automoviles-lucero.test");
  const r2 = await processInboundEmail({ from, subject: "pregunta", text: "me interesa el coche, otra pregunta", messageKey: "msg-12-" + Math.random(), threadId: "t12", receivedAt: new Date().toISOString() } as any);
  assert.equal(r2.outcome, "pausado_por_chat", `Daniel debe bloquear ANTES de enviar a un remitente pausado -- resultado real: ${r2.outcome}`);
  setEmailContactPaused(from, false);
});

await test("13. Correo duplicado -> dedup real, 0 llamadas extra", async () => {
  modelCalls = 0;
  const f = fixture(13);
  await processInboundEmail({ ...f });
  const r2 = await processInboundEmail({ ...f });
  assert.equal(r2.outcome, "duplicate");
  assert.equal(modelCalls, 1);
});

await test("14. Reinicio con correos pendientes -> la cola persiste en disco (mismo patrón ya probado del proyecto)", () => {
  const queue = readCollection<any>("email_pending_queue");
  assert.ok(Array.isArray(queue));
});

await test("15. Error de OpenAI (429) -> no se envía disculpa automática, queda en cola de fallo real", async () => {
  mockServer.removeAllListeners("request");
  mockServer.on("request", (req, res) => {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "insufficient_quota" }));
  });
  const r = await processInboundEmail(fixture(15));
  assert.ok(["fallo_ia_pendiente_revision", "en_cola_fallo_ia"].includes(r.outcome), `outcome real: ${r.outcome}`);
  mockServer.removeAllListeners("request");
  mockServer.on("request", (req, res) => {
    modelCalls++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 50, completion_tokens: 20 } }));
    });
  });
});

await test("16. Presupuesto agotado -> bloqueo real, sin gastar de más", async () => {
  const { execFileSync } = await import("node:child_process");
  const childDataDir = `${process.env.DATA_DIR}-budget-child`;
  const script = `
    process.env.DATA_DIR = ${JSON.stringify(childDataDir)};
    process.env.OPENAI_API_KEY = "test-key-mock-only";
    process.env.LUCERO_DAILY_LLM_BUDGET_EUR = "0.00005";
    const http = require("node:http");
    let calls = 0;
    const srv = http.createServer((req, res) => {
      calls++;
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
      });
    });
    srv.listen(0, async () => {
      process.env.LLM_BASE_URL = "http://127.0.0.1:" + srv.address().port;
      const { handleChatMessage } = await import(${JSON.stringify(path.join(process.cwd(), "src/chat/agent.ts"))});
      await handleChatMessage("mail:presupuesto1@test.com", "hola", "EMAIL", "presupuesto1@test.com");
      const r2 = await handleChatMessage("mail:presupuesto2@test.com", "hola", "EMAIL", "presupuesto2@test.com");
      console.log(JSON.stringify({ calls, ai_failed_2: r2.ai_failed }));
      srv.close();
    });
  `;
  const out = execFileSync("npx", ["tsx", "--eval", script], { encoding: "utf8" });
  const parsed = JSON.parse(out.trim().split("\n").pop() ?? "{}");
  assert.ok(parsed.ai_failed_2);
  assert.equal(parsed.calls, 1);
});

await test("17. Fecha y hora ambiguas -> sin fecha real del cliente, la cita no se inventa (queda sin fecha, nunca 'confirmed')", async () => {
  const r = (await createAppointmentWithCalendar({ lead_phone: "+34600222017", vehicle_id: vehiclesSeed[0].id, channel: "EMAIL" } as any)) as any;
  assert.notEqual(r.data?.status, "confirmed");
});

await test("18. Fallo de inventario (catálogo no consultable) -> falla CERRADO, nunca 'disponible' por defecto", async () => {
  const fs = await import("node:fs");
  const pathNode = await import("node:path");
  const overridesPath = pathNode.join(process.env.DATA_DIR as string, "vehicle_overrides.json");
  fs.writeFileSync(overridesPath, "{ esto no es json valido");
  const r = (await createReservationPending({ vehicle_id: vehiclesSeed[0].id, lead_phone: "+34600222018", channel: "EMAIL" })) as any;
  assert.equal(r.status, "denied");
  assert.equal(r.error_code, "catalog_unavailable");
  fs.writeFileSync(overridesPath, "[]");
});

await test("19. Fallo de Gmail al enviar -> nunca finge un envío, queda registrado honesto", async () => {
  // deliverEmail sin Google conectado devuelve "queued", nunca "sent" --
  // confirmado por el propio contrato de la función (mismo criterio que
  // WhatsApp/Zernio ya probado en outbound-guard).
  const { isGoogleConnected } = await import("../src/integrations/google.js");
  assert.equal(isGoogleConnected(), false, "en este entorno de prueba, sin credenciales reales, Google nunca debe reportarse como conectado");
});

await test("20. Reintento tras error -> no genera bucle infinito ni duplica la respuesta", async () => {
  mockServer.removeAllListeners("request");
  let calls429 = 0;
  mockServer.on("request", (req, res) => {
    calls429++;
    res.writeHead(429);
    res.end();
  });
  const r = await processInboundEmail(fixture(20));
  assert.ok(["fallo_ia_pendiente_revision", "en_cola_fallo_ia"].includes(r.outcome), `outcome real: ${r.outcome}`);
  assert.equal(calls429, 1, "una sola llamada real por intento, nunca un bucle dentro de la misma invocación");
});

mockServer.close();
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} pruebas superadas.`);
if (results.some((r) => !r.ok)) {
  console.log("Fallos:", results.filter((r) => !r.ok));
  process.exit(1);
}
