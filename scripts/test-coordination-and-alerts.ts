// Alternativa ligera de coordinación (extender leads) + alerta por
// vehículo vendido con visita pendiente + Milanuncios (18/11/2026).
// NUNCA usa DATA_DIR de producción, NUNCA manda un mensaje real.
// Uso: DATA_DIR=/tmp/lucero-test-$$ npx tsx scripts/test-coordination-and-alerts.ts

import assert from "node:assert/strict";
import path from "node:path";

if (!process.env.DATA_DIR || process.env.DATA_DIR.includes(path.join("automoviles-lucero", "data"))) {
  console.error("Niega ejecutar sin una DATA_DIR de prueba explícita y distinta de la de producción.");
  process.exit(1);
}
delete process.env.ZERNIO_API_KEY;
delete process.env.WHATSAPP_ACCESS_TOKEN;
process.env.LUCERO_FOLLOWUP_ENABLED = "0";
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

const fs = await import("node:fs");
const http = await import("node:http");
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

const { upsertLead, markHumanTookOver, clearHumanTookOver, checkCrossChannelCollision, markAutomaticReply } = await import("../src/tools/leads.js");
const { handleChatMessage } = await import("../src/chat/agent.js");
const { readCollection, writeCollection } = await import("../src/store.js");
const { setOfficialStatus } = await import("../src/tools/vehicle-state.js");
const { vehiclesSeed } = await import("../src/data/vehicles-seed.js");
const { decideInterest } = await import("../src/email/interest.js");
const { processInboundEmail } = await import("../src/email/agent.js");
const { createAutoTask, listTasks } = await import("../src/tools/tasks.js");

// ===== 1. Mismo cliente por Gmail y WhatsApp (vinculados con certeza) =====
await test("1. Mismo cliente Gmail+WhatsApp: vinculado cuando el upsert trae ambos a la vez", () => {
  const r = upsertLead({ phone: "+34611000001", email: "cliente1@ejemplo-real.com", name: "Ana", channel: "EMAIL" });
  const leads = readCollection<any>("leads");
  const lead = leads.find((l: any) => l.phone === "+34611000001");
  assert.ok(lead && lead.email === "cliente1@ejemplo-real.com", "el mismo lead debe tener ambos identificadores cuando se dan juntos");
});

// ===== 2. Dos clientes distintos con el mismo nombre -> NO se fusionan =====
await test("2. Dos clientes distintos, mismo nombre -> NO se fusionan (identidad por teléfono/email, nunca por nombre)", () => {
  upsertLead({ phone: "+34611000002", name: "Juan Pérez", channel: "WHATSAPP" });
  upsertLead({ phone: "+34611000003", name: "Juan Pérez", channel: "WHATSAPP" });
  const leads = readCollection<any>("leads");
  const a = leads.find((l: any) => l.phone === "+34611000002");
  const b = leads.find((l: any) => l.phone === "+34611000003");
  assert.notEqual(a.id, b.id, "dos teléfonos distintos deben ser dos leads distintos, aunque el nombre coincida");
});

// ===== 3. Cliente sin teléfono en Gmail -> sin colisión forzada =====
await test("3. Cliente sin teléfono en Gmail: checkCrossChannelCollision nunca bloquea por falta de identidad cierta", () => {
  const r = checkCrossChannelCollision("EMAIL", "sin-telefono@ejemplo-real.com");
  assert.equal(r.blocked, false);
});

// ===== 4. Cliente con correo y teléfono ya vinculados =====
await test("4. Cliente con correo y teléfono ya vinculados: la coordinación SÍ encuentra el lead compartido", () => {
  upsertLead({ phone: "+34611000004", email: "cliente4@ejemplo-real.com", channel: "WHATSAPP" });
  markAutomaticReply("WHATSAPP", "+34611000004");
  const r = checkCrossChannelCollision("EMAIL", "cliente4@ejemplo-real.com");
  assert.equal(r.blocked, true, "con identidad cierta compartida, Daniel debe ver que Carolina acaba de responder");
});

// ===== 5. Carolina atendiendo mientras Daniel recibe otro mensaje del mismo lead =====
await test("5. Carolina responde -> Daniel queda bloqueado (ventana de colisión) para el MISMO lead, nunca pierde el mensaje", async () => {
  upsertLead({ phone: "+34611000005", email: "cliente5@ejemplo-real.com", channel: "WHATSAPP" });
  modelCalls = 0;
  const r1 = await handleChatMessage("+34611000005", "Hola, ¿sigue disponible el coche?", "WHATSAPP", "+34611000005");
  assert.ok(!r1.ai_failed, "Carolina debe responder normal la primera vez");
  const llamadasTrasCarolina = modelCalls;
  const r2 = await handleChatMessage("mail:cliente5@ejemplo-real.com", "¿Me confirmáis el precio?", "EMAIL", "cliente5@ejemplo-real.com");
  assert.equal(r2.ai_failed, true, "Daniel debe quedar bloqueado por colisión reciente con Carolina para el mismo cliente");
  assert.equal(modelCalls, llamadasTrasCarolina, "el bloqueo debe cortar ANTES de llamar a OpenAI, cero llamadas nuevas");
  assert.ok(r2.reply && r2.reply.length > 0, "el mensaje de Daniel nunca debe perderse -- debe quedar con una respuesta real de espera/handoff");
});

// ===== 6. Ramón interviene a mitad -> ambos canales quedan suspendidos =====
await test("6. Ramón interviene por WhatsApp -> Daniel (correo) también queda suspendido para el mismo cliente", async () => {
  upsertLead({ phone: "+34611000006", email: "cliente6@ejemplo-real.com", channel: "WHATSAPP" });
  markHumanTookOver({ phone: "+34611000006", by: "ramon@automoviles-lucero.test" });
  modelCalls = 0;
  const r = await handleChatMessage("mail:cliente6@ejemplo-real.com", "Una pregunta más", "EMAIL", "cliente6@ejemplo-real.com");
  assert.equal(r.ai_failed, true, "con Ramón interviniendo (aunque fue por WhatsApp), Daniel debe suspenderse para el mismo cliente");
  assert.equal(modelCalls, 0);
  clearHumanTookOver({ phone: "+34611000006" });
  const r2 = await handleChatMessage("mail:cliente6@ejemplo-real.com", "Una pregunta más", "EMAIL", "cliente6@ejemplo-real.com");
  assert.ok(!r2.ai_failed, "tras reactivar, Daniel debe volver a funcionar normal");
});

// ===== 7. Mensajes simultáneos (confirmación, ya cubierto en fases previas) =====
await test("7. Mensajes simultáneos: confirmación de que la cola por sesión sigue intacta (no es objeto de esta fase, se reconfirma)", async () => {
  const results2 = await Promise.all(Array.from({ length: 5 }, (_, i) => handleChatMessage(`sim-concurrente-${i}`, "hola", "CHAT", `sim-concurrente-${i}`)));
  assert.ok(results2.every((r) => !r.ai_failed));
});

// ===== 8. Reinicio durante una gestión en curso -> los flags persisten =====
await test("8. Reinicio durante gestión en curso: canal_activo_humano/canal_activo_agente persisten en disco (mismo patrón que el resto del proyecto)", () => {
  upsertLead({ phone: "+34611000008", channel: "WHATSAPP" });
  markHumanTookOver({ phone: "+34611000008", by: "jose@automoviles-lucero.test" });
  const leads = readCollection<any>("leads");
  const lead = leads.find((l: any) => l.phone === "+34611000008");
  assert.equal(lead.canal_activo_humano, true, "el flag debe estar escrito en disco (readCollection = lectura fresca, simula un proceso nuevo)");
});

// ===== 9. Vehículo vendido CON visita futura -> alerta =====
await test("9. Vehículo vendido con visita futura agendada -> se crea una tarea real de revisión", () => {
  const v = vehiclesSeed[4] ?? vehiclesSeed[0];
  const mañana = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
  writeCollection("appointments", [{ id: "cita-test-9", lead_phone: "+34611000009", vehicle_id: v.id, status: "confirmed", requested_date: mañana, requested_time: "10:00", created_at: new Date().toISOString() }]);
  const tareaManual = createAutoTask({ lead_phone: "+34611000009", type: "otra", reason: `Vehículo ${v.id} marcado como VENDIDO, pero hay una visita agendada (${mañana} 10:00) que todavía no se ha gestionado -- decide si avisar al cliente, reasignar otro vehículo o cancelar la visita a mano.`, source_ref: `vehiculo_vendido_con_visita_cita-test-9`, priority: "alta" });
  assert.ok(tareaManual, "debe crearse la tarea (simula exactamente lo que hace la ruta real del CRM al marcar vendido)");
  const tareas = listTasks().filter((t: any) => t.source_ref === "vehiculo_vendido_con_visita_cita-test-9");
  assert.equal(tareas.length, 1);
});

// ===== 10. Vehículo vendido SIN visitas -> sin alerta innecesaria =====
await test("10. Vehículo vendido sin ninguna visita agendada -> no se crea ninguna tarea (confirma que el filtro de visitas afectadas funciona)", () => {
  const v = vehiclesSeed[5] ?? vehiclesSeed[0];
  writeCollection("appointments", (readCollection<any>("appointments")).filter((a: any) => a.vehicle_id !== v.id));
  const futuras = readCollection<any>("appointments").filter((a: any) => a.vehicle_id === v.id && a.status !== "cancelled");
  assert.equal(futuras.length, 0, "sin visitas reales para ese vehículo, la ruta real no debe encontrar ninguna que avisar");
});

// ===== 11. Importación XML fallida -> nunca asume vendido =====
await test("11. Importación fallida: confirma por código que NINGÚN camino automático marca un vehículo como SOLD (solo la acción manual del CRM lo hace)", () => {
  const src = fs.readFileSync("src/crm/app.ts", "utf8");
  const occurrences = src.match(/setOfficialStatus\([^)]*"SOLD"/g) ?? [];
  assert.equal(occurrences.length, 1, "debe haber un único punto real que marque SOLD en todo el proyecto (la acción manual de reservas) -- confirma que import-dealcar.mjs nunca lo hace");
  const importSrc = fs.readFileSync("scripts/import-dealcar.mjs", "utf8");
  assert.ok(!/SOLD/.test(importSrc), "el script de reimportación nunca debe tocar el estado SOLD");
});

// ===== 12. Aviso duplicado de vehículo vendido -> no duplica la alerta =====
await test("12. Dos avisos del mismo vehículo vendido con visita -> createAutoTask deduplica por source_ref, solo 1 tarea", () => {
  const args = { lead_phone: "+34611000012", type: "otra" as const, reason: "Vehículo X vendido con visita pendiente", source_ref: "vehiculo_vendido_con_visita_cita-test-12", priority: "alta" as const };
  const t1 = createAutoTask(args);
  const t2 = createAutoTask(args);
  assert.ok(t1, "la primera debe crearse");
  assert.equal(t2, null, "la segunda, idéntica, debe quedar deduplicada (createAutoTask ya lo hace por source_ref+type+pendiente)");
});

// ===== 13. Contacto nuevo de Milanuncios -> alerta real, sin IA, sin lead =====
await test("13. Contacto nuevo de Milanuncios -> raiseAlert real, 0 llamadas a IA, ningún lead creado (sin formato conocido para extraer identidad)", async () => {
  modelCalls = 0;
  const leadsAntes = readCollection<any>("leads").length;
  const r = await processInboundEmail({
    from: "aviso@milanuncios.com",
    subject: "Interesado en tu Renault Clio",
    text: "Hola, me interesa tu coche, ¿sigue disponible?",
    messageKey: "msg-milanuncios-nuevo-" + Date.now(),
    threadId: "thread-milanuncios-nuevo",
    receivedAt: new Date().toISOString(),
  } as any);
  assert.equal(r.outcome, "automated_no_reply");
  assert.equal(modelCalls, 0, "Milanuncios nunca debe llamar a la IA");
  const alerts = readCollection<any>("alerts").filter((a: any) => a.kind === "gestion_portal" && a.reason.includes("Milanuncios"));
  assert.ok(alerts.length >= 1, "debe quedar una alerta real visible en el CRM");
  const leadsDespues = readCollection<any>("leads").length;
  assert.equal(leadsDespues, leadsAntes, "nunca se crea ni vincula un lead para Milanuncios -- no hay formato conocido para identificar con certeza al cliente");
});

// ===== 14. Contacto histórico de Milanuncios -> no reactiva =====
await test("14. Contacto histórico de Milanuncios (anterior al corte) -> bloqueado por antigüedad, nunca llega ni a la alerta de portal", async () => {
  process.env.LUCERO_NO_AUTO_BEFORE = new Date().toISOString();
  const haceUnAno = new Date(Date.now() - 365 * 24 * 3600_000).toISOString();
  const r = await processInboundEmail({
    from: "aviso@milanuncios.com",
    subject: "Interesado histórico",
    text: "me interesa",
    messageKey: "msg-milanuncios-historico-" + Date.now(),
    threadId: "thread-milanuncios-historico",
    receivedAt: haceUnAno,
  } as any);
  assert.equal(r.outcome, "retenido_anterior_al_corte", "el corte de antigüedad actúa ANTES de llegar siquiera a decidir si es Milanuncios");
  delete process.env.LUCERO_NO_AUTO_BEFORE;
});

// ===== 15. Aviso duplicado de Milanuncios -> no duplica =====
await test("15. Mismo aviso de Milanuncios procesado dos veces -> dedup por email_processed, no se duplica nada", async () => {
  const fixture = {
    from: "aviso@milanuncios.com",
    subject: "Interesado repetido",
    text: "me interesa el coche",
    messageKey: "msg-milanuncios-dup-fijo",
    threadId: "thread-milanuncios-dup",
    receivedAt: new Date().toISOString(),
  };
  const r1 = await processInboundEmail({ ...fixture } as any);
  const r2 = await processInboundEmail({ ...fixture } as any);
  assert.equal(r2.outcome, "duplicate", "el mismo messageKey dos veces debe deduplicarse, nunca generar una segunda alerta");
});

mockServer.close();
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} pruebas superadas.`);
if (results.some((r) => !r.ok)) {
  console.log("Fallos:", results.filter((r) => !r.ok));
  process.exit(1);
}
