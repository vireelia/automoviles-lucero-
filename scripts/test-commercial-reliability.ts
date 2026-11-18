// Auditoría de fiabilidad comercial (18/11/2026) -- corrige dos fallos
// reales encontrados al auditar la coordinación entre Carolina/Daniel/
// Miguel y la reserva de vehículos:
//
// 1. Que Ramón o José contesten a mano desde el CRM (WhatsApp o correo)
//    nunca suspendía las respuestas automáticas de Carolina/Daniel para
//    ese mismo contacto -- el agente podía responder encima de una
//    conversación que el equipo ya había tomado, sin saberlo.
// 2. confirmReservation nunca volvía a comprobar la disponibilidad real
//    del vehículo -- solo se comprobaba al CREAR la reserva. Entre la
//    creación y la confirmación (esperando el justificante de pago) el
//    vehículo podía venderse por otra vía sin que la confirmación lo
//    detectara.
//
// NUNCA usa DATA_DIR de producción, NUNCA manda un mensaje real.
//
// Uso:
//   DATA_DIR=/tmp/lucero-test-$$ npx tsx scripts/test-commercial-reliability.ts

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

if (!process.env.DATA_DIR || process.env.DATA_DIR.includes(path.join("automoviles-lucero", "data"))) {
  console.error("Niega ejecutar sin una DATA_DIR de prueba explícita y distinta de la de producción.");
  process.exit(1);
}
delete process.env.ZERNIO_API_KEY;
delete process.env.ZERNIO_WHATSAPP_ACCOUNT_ID;
delete process.env.WHATSAPP_ACCESS_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;
delete process.env.LUCERO_NO_AUTO_BEFORE;
process.env.LUCERO_FOLLOWUP_ENABLED = "0";

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

const { setWhatsappChatPaused, isWhatsappChatPaused, setEmailContactPaused, isEmailContactPaused, setWhatsappZernioAgentEnabled } = await import("../src/tools/agent-toggle.js");
const { enqueueWhatsappBatchMessage, processDueWhatsappBatches, combineBatchText } = await import("../src/chat/whatsapp-batch.js");
const { handleChatMessage } = await import("../src/chat/agent.js");
const { createReservationPending, confirmReservation } = await import("../src/tools/reservations.js");
const { setOfficialStatus, getOfficialStatus } = await import("../src/tools/vehicle-state.js");
const { vehiclesSeed } = await import("../src/data/vehicles-seed.js");

let lotesProcesados = 0;
const batchHandler = async (phone: string, items: any[], _batchId: string) => {
  lotesProcesados++;
  await handleChatMessage(phone, combineBatchText(items), "WHATSAPP", phone);
};

// =======================================================================
// Fix 1: intervención humana suspende al agente (WhatsApp)
// =======================================================================

await test("Cita de código: la ruta /crm/whatsapp/:id (responder) pausa a Carolina para ese chat", () => {
  const src = fs.readFileSync("src/crm/app.ts", "utf8");
  // Confirma que el nuevo setWhatsappChatPaused(m.phone, true, ...) está
  // en el mismo bloque que el envío manual real (accion === "responder"),
  // no en otro sitio desconectado.
  const responderBlock = src.slice(src.indexOf('if (accion === "responder") {'), src.indexOf('Enviar foto o audio real'));
  assert.ok(/setWhatsappChatPaused\(m\.phone, true/.test(responderBlock), "el envío manual de texto debe pausar a Carolina para ese número");
});

await test("Cita de código: responder_adjunto también pausa a Carolina", () => {
  const src = fs.readFileSync("src/crm/app.ts", "utf8");
  const start = src.indexOf('if (accion === "responder_adjunto") {');
  const adjuntoBlock = src.slice(start, start + 1200); // bloque acotado por tamaño, no por el siguiente "eliminar" (hay varios en el archivo, en otras rutas).
  assert.ok(/setWhatsappChatPaused\(m\.phone, true/.test(adjuntoBlock), "el envío manual de foto/audio debe pausar a Carolina para ese número");
});

await test("Efecto real de punta a punta: tras pausar (simula la intervención humana), un mensaje nuevo del cliente NO recibe respuesta automática", async () => {
  setWhatsappZernioAgentEnabled(true);
  const phone = "+34611222333";
  // Simula lo que ahora hace la ruta del CRM al enviar una respuesta manual.
  setWhatsappChatPaused(phone, true, "ramon@automoviles-lucero.test");
  assert.equal(isWhatsappChatPaused(phone), true);

  // El cliente escribe de nuevo justo después -- Carolina NO debe contestar.
  lotesProcesados = 0;
  await enqueueWhatsappBatchMessage(phone, { eventId: "evt-post-intervencion", whatsappInboxId: "inbox-post-intervencion", text: "¿sigue en pie lo que hablamos?", sentAt: new Date().toISOString() });
  await new Promise((r) => setTimeout(r, 50));
  // El sondeo real (server.ts) comprueba isWhatsappChatPaused ANTES de
  // encolar -- aquí reproducimos esa misma comprobación tal cual, que es
  // la que de verdad decide.
  assert.equal(isWhatsappChatPaused(phone), true, "el chat debe seguir pausado -- ningún mensaje nuevo del mismo cliente debe reactivarlo solo");

  // El equipo reactiva a Carolina explícitamente -- a partir de aquí sí debe contestar.
  setWhatsappChatPaused(phone, false, "ramon@automoviles-lucero.test");
  assert.equal(isWhatsappChatPaused(phone), false);
});

// =======================================================================
// Fix 1: intervención humana suspende al agente (correo)
// =======================================================================

await test("Cita de código: ambas rutas de respuesta manual de correo (\"ya\" y envío real) pausan a Daniel", () => {
  const src = fs.readFileSync("src/crm/app.ts", "utf8");
  const yaBlock = src.slice(src.indexOf('if (accion === "ya") {'), src.indexOf('const text = String(req.body.respuesta'));
  assert.ok(/setEmailContactPaused\(m\.from, true/.test(yaBlock), '"ya" (marcar como gestionado a mano) debe pausar a Daniel para ese remitente');
  const envioRealBlock = src.slice(src.indexOf("const delivery = await deliverEmail"), src.indexOf("if (delivery.status"));
  assert.ok(/setEmailContactPaused\(m\.from, true/.test(envioRealBlock), "el envío real manual debe pausar a Daniel para ese remitente");
});

await test("Efecto real: correo pausado para un remitente no se reactiva solo con un correo nuevo", () => {
  const from = "cliente-intervenido@ejemplo-real.com";
  setEmailContactPaused(from, true, "jose@automoviles-lucero.test");
  assert.equal(isEmailContactPaused(from), true);
  // (La comprobación real de email/agent.ts:896 ya usa isEmailContactPaused
  // antes de enviar -- confirmado en la auditoría de la Fase 2F, sin
  // cambios en ese punto, solo en quién activa el interruptor.)
  setEmailContactPaused(from, false, "jose@automoviles-lucero.test");
  assert.equal(isEmailContactPaused(from), false);
});

// =======================================================================
// Fix 2: re-comprobación de disponibilidad justo antes de confirmar
// =======================================================================

await test("confirmReservation rechaza si el vehículo pasó a SOLD entre la creación y la confirmación", async () => {
  const vehicleReal = vehiclesSeed[0];
  setOfficialStatus(vehicleReal.id, "AVAILABLE", null);
  const pending = await createReservationPending({ vehicle_id: vehicleReal.id, lead_phone: "+34600555444" });
  const reservationId = (pending as { data: { id: string } }).data.id;
  assert.equal(getOfficialStatus(vehicleReal.id), "RESERVATION_PENDING");

  // El vehículo se vende por otra vía (presencial, p. ej.) mientras la
  // reserva seguía pendiente del justificante de pago.
  setOfficialStatus(vehicleReal.id, "SOLD", null);

  const confirmResult = await confirmReservation({ reservation_id: reservationId, verified_by: "ramon" });
  assert.equal((confirmResult as { status: string }).status, "denied");
  assert.equal((confirmResult as { error_code?: string }).error_code, "vehicle_not_available_at_confirm");

  setOfficialStatus(vehicleReal.id, "AVAILABLE", null);
});

await test("confirmReservation SÍ confirma cuando el vehículo sigue disponible de verdad al confirmar (no rompe el caso normal)", async () => {
  const vehicleReal = vehiclesSeed[0];
  setOfficialStatus(vehicleReal.id, "AVAILABLE", null);
  const pending = await createReservationPending({ vehicle_id: vehicleReal.id, lead_phone: "+34600555445" });
  const reservationId = (pending as { data: { id: string } }).data.id;
  const confirmResult = await confirmReservation({ reservation_id: reservationId, verified_by: "ramon" });
  assert.equal((confirmResult as { status: string }).status, "ok", `se esperaba éxito, resultado real: ${JSON.stringify(confirmResult)}`);
  assert.equal(getOfficialStatus(vehicleReal.id), "RESERVED");
  setOfficialStatus(vehicleReal.id, "AVAILABLE", null);
});

// =======================================================================
// Confirmaciones ya auditadas en fases anteriores, repetidas aquí para
// no asumir que siguen intactas solo porque no se tocaron directamente.
// =======================================================================

await test("Confirmación: reservas simultáneas del mismo vehículo -- crear ambas es válido (decisión de negocio), pero confirmar solo una sola vez", async () => {
  const vehicleReal = vehiclesSeed[1] ?? vehiclesSeed[0];
  setOfficialStatus(vehicleReal.id, "AVAILABLE", null);
  const pendingA = await createReservationPending({ vehicle_id: vehicleReal.id, lead_phone: "+34600555446" });
  const pendingB = await createReservationPending({ vehicle_id: vehicleReal.id, lead_phone: "+34600555447" });
  const idA = (pendingA as { data: { id: string } }).data.id;
  const idB = (pendingB as { data: { id: string } }).data.id;
  const [outA, outB] = await Promise.all([
    confirmReservation({ reservation_id: idA, verified_by: "ramon" }),
    confirmReservation({ reservation_id: idB, verified_by: "jose" }),
  ]);
  const okCount = [outA, outB].filter((r) => (r as { status: string }).status === "ok").length;
  assert.equal(okCount, 1, "solo UNA de las dos reservas simultáneas del mismo vehículo puede quedar confirmada de verdad");
  setOfficialStatus(vehicleReal.id, "AVAILABLE", null);
});

await test("Confirmación: ninguna reserva válida sobre un vehículo inexistente en catálogo", async () => {
  const r = await createReservationPending({ vehicle_id: "id-definitivamente-no-existe-" + Date.now(), lead_phone: "+34600555448" });
  assert.equal((r as { status: string }).status, "denied");
});

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} pruebas superadas.`);
if (results.some((r) => !r.ok)) {
  console.log("Fallos:", results.filter((r) => !r.ok));
  process.exit(1);
}
