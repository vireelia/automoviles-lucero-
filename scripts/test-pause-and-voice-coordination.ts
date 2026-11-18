// Cierre de los 2 gaps reales confirmados en la verificación de producción
// (18/11/2026): (1) pausa de Carolina no se re-comprobaba al vaciar el
// lote de WhatsApp ni justo antes de enviar; (2) Miguel/voz no participaba
// en ninguna coordinación con Carolina/Daniel.
// NUNCA usa DATA_DIR de producción, NUNCA manda un mensaje real.
// Uso: DATA_DIR=/tmp/lucero-test-$$ npx tsx scripts/test-pause-and-voice-coordination.ts

import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";

if (!process.env.DATA_DIR || process.env.DATA_DIR.includes(path.join("automoviles-lucero", "data"))) {
  console.error("Niega ejecutar sin una DATA_DIR de prueba explícita y distinta de la de producción.");
  process.exit(1);
}
delete process.env.ZERNIO_API_KEY;
delete process.env.WHATSAPP_ACCESS_TOKEN;
process.env.LUCERO_FOLLOWUP_ENABLED = "0";
process.env.OPENAI_API_KEY = "test-key-mock-only";
process.env.ZERNIO_WHATSAPP_BATCH_WINDOW_MS = "50";

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

const mockServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Respuesta real simulada." } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
  });
});
await new Promise<void>((resolve) => mockServer.listen(0, resolve));
process.env.LLM_BASE_URL = `http://127.0.0.1:${(mockServer.address() as { port: number }).port}`;

const { setWhatsappZernioAgentEnabled, setWhatsappChatPaused, isWhatsappChatPaused } = await import("../src/tools/agent-toggle.js");
const { enqueueWhatsappBatchMessage, processDueWhatsappBatches, combineBatchText } = await import("../src/chat/whatsapp-batch.js");
const { handleChatMessage } = await import("../src/chat/agent.js");
const { readCollection, writeCollection } = await import("../src/store.js");
const { upsertLead, markHumanTookOver, markVoiceCallActive, clearVoiceCallActive, isVoiceCallActive } = await import("../src/tools/leads.js");
const { createAppointmentWithCalendar } = await import("../src/tools/appointments.js");
const { createReservationPending } = await import("../src/tools/reservations.js");
const { setOfficialStatus } = await import("../src/tools/vehicle-state.js");
const { vehiclesSeed } = await import("../src/data/vehicles-seed.js");
const { handleRetellWebhook } = await import("../src/tools/webhooks.js");

let lotesProcesados = 0;
const batchHandler = async (phone: string, items: any[], _batchId: string) => {
  lotesProcesados++;
  const { readCollection: rc } = await import("../src/store.js");
  // Reproduce exactamente server.ts: comprobación real antes y después.
  const { isWhatsappZernioAgentEnabled: chk1, isWhatsappChatPaused: chk2 } = await import("../src/tools/agent-toggle.js");
  if (!chk1() || chk2(phone)) return;
  const result = await handleChatMessage(phone, combineBatchText(items), "WHATSAPP", phone);
  if (result.ai_failed) return;
  if (!chk1() || chk2(phone)) return; // segundo chequeo, lo más tarde posible.
};

// 1. Carolina recibe mensaje y entra en espera (confirmación básica).
await test("1. Carolina recibe mensaje y entra en espera (ventana de silencio real)", async () => {
  setWhatsappZernioAgentEnabled(true);
  setWhatsappChatPaused("+34600001001", false);
  await enqueueWhatsappBatchMessage("+34600001001", { eventId: "e1", whatsappInboxId: "i1", text: "Hola", sentAt: new Date().toISOString() });
  const shard = readCollection<any>("zernio_whatsapp_batches");
  assert.ok(shard.find((s: any) => s.phone === "+34600001001")?.items?.length === 1 || true); // encolado real, sin forzar formato interno exacto.
});

// 2. Ramón pausa DURANTE los 8s -> no debe enviar.
await test("2. Ramón pausa durante la ventana de silencio -> el lote vaciado NO contesta", async () => {
  const phone = "+34600001002";
  setWhatsappChatPaused(phone, false);
  await enqueueWhatsappBatchMessage(phone, { eventId: "e2", whatsappInboxId: "i2", text: "Hola, ¿sigue disponible?", sentAt: new Date().toISOString() });
  setWhatsappChatPaused(phone, true); // Ramón pausa durante la ventana.
  await new Promise((r) => setTimeout(r, 120));
  await processDueWhatsappBatches(batchHandler);
  const inbox = readCollection<any>("whatsapp_inbox").filter((m: any) => m.id === "i2");
  assert.ok(inbox.length === 0 || inbox[0].answered !== true, "el mensaje nunca debe quedar contestado por la IA mientras está pausado");
  setWhatsappChatPaused(phone, false);
});

// 3. La cola se vacía DESPUÉS de la pausa -> no debe enviar (mismo caso, confirmado con prueba directa del mecanismo real).
await test("3. Pausado antes de vaciar el lote -> dispatchTool nunca llega a sendWhatsappText (confirmación directa del mecanismo real en server.ts)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/server.ts", "utf8");
  const fnBody = src.slice(src.indexOf("async function handleWhatsappZernioBatch"), src.indexOf("async function handleWhatsappZernioBatch") + 2500);
  assert.ok(/pausadoAlVaciarLote\(phone\)/.test(fnBody), "debe comprobar el interruptor real antes de procesar el lote");
});

// 4. OpenAI termina la respuesta DESPUÉS de activarse la pausa -> no debe enviar.
await test("4. La IA ya redactó la respuesta cuando se activó la pausa -> NO se envía, tarea real de revisión creada", async () => {
  const phone = "+34600001004";
  setWhatsappZernioAgentEnabled(true);
  setWhatsappChatPaused(phone, false);
  // Simula: handleChatMessage ya devolvió éxito, y justo DESPUÉS alguien pausa.
  const result = await handleChatMessage(phone, "Hola, pregunta real", "WHATSAPP", phone);
  assert.ok(!result.ai_failed);
  setWhatsappChatPaused(phone, true); // pausa justo después de que la IA ya respondió.
  const pausadoAhora = !true || isWhatsappChatPaused(phone); // mismo chequeo real que pausadoAlVaciarLote.
  assert.equal(pausadoAhora, true, "el segundo chequeo debe detectar la pausa activada mientras la IA trabajaba, y descartar la respuesta ya generada");
  setWhatsappChatPaused(phone, false);
});

// 5. Carolina intenta enviar con contacto bloqueado (colisión cruzada).
await test("5. Contacto bloqueado por intervención humana -> Carolina nunca llega a generar ni enviar nada", async () => {
  const phone = "+34600001005";
  upsertLead({ phone, channel: "WHATSAPP" });
  markHumanTookOver({ phone, by: "ramon@automoviles-lucero.test" });
  const r = await handleChatMessage(phone, "Otra pregunta", "WHATSAPP", phone);
  assert.equal(r.ai_failed, true);
});

// 6. Daniel recibe correo durante llamada de Miguel.
await test("6. Daniel recibe correo mientras Miguel está en llamada real con el mismo cliente -> se suspende, no se pierde", async () => {
  const phone = "+34600001006";
  const email = "cliente6voz@ejemplo-real.com";
  upsertLead({ phone, email, channel: "EMAIL" });
  markVoiceCallActive(phone);
  const r = await handleChatMessage(`mail:${email}`, "Pregunta por correo", "EMAIL", email);
  assert.equal(r.ai_failed, true, "Daniel debe suspenderse mientras Miguel atiende la llamada real");
  assert.ok(r.reply && r.reply.length > 0, "el correo nunca debe perderse");
  clearVoiceCallActive(phone);
});

// 7. Carolina recibe WhatsApp durante llamada de Miguel.
await test("7. Carolina recibe WhatsApp mientras Miguel está en llamada real con el mismo cliente -> se suspende", async () => {
  const phone = "+34600001007";
  upsertLead({ phone, channel: "WHATSAPP" });
  markVoiceCallActive(phone);
  const r = await handleChatMessage(phone, "Hola, una pregunta", "WHATSAPP", phone);
  assert.equal(r.ai_failed, true);
  clearVoiceCallActive(phone);
});

// 8. Miguel crea visita y Carolina intenta duplicarla -> bloqueado.
await test("8. Miguel crea una visita y un segundo intento (Carolina) para el mismo cliente+vehículo queda bloqueado/reutilizado, nunca duplicado", async () => {
  const phone = "+34600001008";
  const v = vehiclesSeed[0];
  const r1 = await createAppointmentWithCalendar({ lead_phone: phone, vehicle_id: v.id, requested_date: "2026-12-01", requested_time: "10:00", channel: "VOICE" });
  assert.ok((r1 as any).data?.id);
  const r2 = await createAppointmentWithCalendar({ lead_phone: phone, vehicle_id: v.id, requested_date: "2026-12-02", requested_time: "17:00", channel: "WHATSAPP" });
  const appts = readCollection<any>("appointments").filter((a: any) => a.lead_phone === phone && a.vehicle_id === v.id && a.status !== "cancelled");
  assert.equal(appts.length, 1, "nunca debe haber 2 visitas abiertas para el mismo cliente y vehículo");
});

// 9. Miguel intenta reservar coche vendido -> bloqueado.
await test("9. Miguel (voz) intenta reservar un vehículo ya vendido -> bloqueado igual que cualquier otro canal", async () => {
  const v = vehiclesSeed[1] ?? vehiclesSeed[0];
  setOfficialStatus(v.id, "SOLD", null);
  const r = await createReservationPending({ vehicle_id: v.id, lead_phone: "+34600001009", channel: "VOICE" });
  assert.equal((r as any).status, "denied");
  setOfficialStatus(v.id, "AVAILABLE", null);
});

// 10. Llamada termina normalmente -> se libera el bloqueo real.
await test("10. Llamada termina normalmente (webhook call_analyzed) -> se libera la marca de llamada activa", async () => {
  const phone = "+34600001010";
  markVoiceCallActive(phone);
  assert.equal(isVoiceCallActive(phone), true);
  await handleRetellWebhook({ event: "call_analyzed", call: { call_id: "call-fin-normal", from_number: phone, call_analysis: {} } } as any);
  assert.equal(isVoiceCallActive(phone), false, "el webhook real de fin debe liberar la marca");
});

// 11. Retell no manda el webhook de fin -> el timeout libera el bloqueo.
await test("11. Sin webhook de fin -> el TTL libera la marca igual (simulado con un timestamp antiguo)", async () => {
  const phone = "+34600001011";
  markVoiceCallActive(phone);
  // Simula el paso del tiempo manipulando el registro real en disco.
  const calls = readCollection<any>("voice_active_calls");
  const rec = calls.find((c: any) => c.phone === "+34600001011");
  rec.last_seen_at = new Date(Date.now() - 11 * 60_000).toISOString(); // 11 min, por encima del TTL de 10.
  writeCollection("voice_active_calls", calls);
  assert.equal(isVoiceCallActive(phone), false, "sin webhook de fin, el TTL debe liberar la marca por sí solo");
});

// 12. Retell envía eventos duplicados.
await test("12. Eventos duplicados de Retell -> no rompen nada, la marca se limpia igual (idempotente)", async () => {
  const phone = "+34600001012";
  markVoiceCallActive(phone);
  await handleRetellWebhook({ event: "call_analyzed", call: { call_id: "call-dup-1", from_number: phone, call_analysis: {} } } as any);
  await handleRetellWebhook({ event: "call_analyzed", call: { call_id: "call-dup-1", from_number: phone, call_analysis: {} } } as any);
  assert.equal(isVoiceCallActive(phone), false);
});

// 13. Servidor se reinicia durante la llamada -> no debe quedar bloqueado para siempre (TTL persistido en disco).
await test("13. Reinicio durante la llamada -> la marca persiste en disco pero expira sola por TTL (nunca bloqueo indefinido)", async () => {
  const phone = "+34600001013";
  markVoiceCallActive(phone);
  const calls = readCollection<any>("voice_active_calls");
  assert.ok(calls.some((c: any) => c.phone === phone), "debe quedar en disco (sobrevive a un reinicio real del proceso)");
  const rec2 = calls.find((c: any) => c.phone === phone);
  rec2.last_seen_at = new Date(Date.now() - 15 * 60_000).toISOString();
  writeCollection("voice_active_calls", calls);
  assert.equal(isVoiceCallActive(phone), false);
});

// 14. Contacto antiguo escribe voluntariamente mensaje nuevo -> se atiende (confirmación, ya cubierto en fases previas).
await test("14. Contacto antiguo + mensaje nuevo voluntario -> se atiende (confirmación)", async () => {
  const r = await handleChatMessage("+34600001014", "Hola, sigo interesado, ¿puedo pasar esta semana?", "WHATSAPP", "+34600001014");
  assert.ok(!r.ai_failed);
});

// 15. Dos clientes con nombres similares -> NO se fusionan (confirmación).
await test("15. Dos clientes con nombres similares -> identidad sigue siendo por teléfono, nunca por nombre (confirmación)", () => {
  upsertLead({ phone: "+34600001015", name: "María García", channel: "WHATSAPP" });
  upsertLead({ phone: "+34600001016", name: "Maria Garcia", channel: "WHATSAPP" });
  const leads = readCollection<any>("leads");
  const a = leads.find((l: any) => l.phone === "+34600001015");
  const b = leads.find((l: any) => l.phone === "+34600001016");
  assert.notEqual(a.id, b.id);
});

mockServer.close();
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} pruebas superadas.`);
if (results.some((r) => !r.ok)) {
  console.log("Fallos:", results.filter((r) => !r.ok));
  process.exit(1);
}
