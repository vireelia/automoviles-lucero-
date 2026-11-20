// Candidatos reales sin responder (20/11/2026) -- prueba aislada de la
// parte pura y testeable (filtrarCandidatosSinResponder): dedup real contra
// email_processed en disco + corte historico real, SIN red, SIN Gmail real.
// Uso: DATA_DIR=/tmp/lucero-test-$$ npx tsx scripts/test-email-backlog.ts

import path from "node:path";

if (!process.env.DATA_DIR || process.env.DATA_DIR.includes(path.join("automoviles-lucero", "data"))) {
  console.error("Niega ejecutar sin una DATA_DIR de prueba explícita y distinta de la de producción.");
  process.exit(1);
}

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

const assert = await import("node:assert/strict");
const { writeCollection } = await import("../src/store.js");
const { filtrarCandidatosSinResponder } = await import("../src/email/backlog.js");

function mensaje(over: Partial<Parameters<typeof filtrarCandidatosSinResponder>[0][number]> = {}) {
  return {
    id: "msg-1",
    from: "cliente@example.com",
    fromName: "Cliente Real",
    subject: "¿Sigue disponible el coche?",
    received_at: new Date().toISOString(),
    text: "Hola, quería saber si el Toyota RAV4 sigue disponible.",
    automated: false,
    ...over,
  };
}

await test("Correo real de ayer, ya LEÍDO por un humano, nunca procesado -> aparece como candidato", () => {
  process.env.LUCERO_NO_AUTO_BEFORE = new Date(Date.now() - 48 * 3600_000).toISOString();
  writeCollection("email_processed", []);
  const out = filtrarCandidatosSinResponder([mensaje({ id: "msg-leido-ayer" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "msg-leido-ayer");
  delete process.env.LUCERO_NO_AUTO_BEFORE;
});

await test("Correo que YA está en email_processed -> nunca se ofrece de nuevo (no duplica)", () => {
  process.env.LUCERO_NO_AUTO_BEFORE = new Date(Date.now() - 48 * 3600_000).toISOString();
  const from = "cliente2@example.com";
  const id = "msg-ya-procesado";
  writeCollection("email_processed", [{ key: `${from}|${id}`, at: new Date().toISOString(), outcome: "sent" }]);
  const out = filtrarCandidatosSinResponder([mensaje({ id, from })]);
  assert.equal(out.length, 0);
  delete process.env.LUCERO_NO_AUTO_BEFORE;
});

await test("Correo anterior al corte histórico -> nunca se ofrece, aunque no esté procesado", () => {
  process.env.LUCERO_NO_AUTO_BEFORE = new Date().toISOString();
  writeCollection("email_processed", []);
  const out = filtrarCandidatosSinResponder([mensaje({ id: "msg-viejo", received_at: new Date(Date.now() - 200 * 86400_000).toISOString() })]);
  assert.equal(out.length, 0);
  delete process.env.LUCERO_NO_AUTO_BEFORE;
});

await test("Dos mensajes: uno ya procesado, otro real sin responder -> solo el real aparece", () => {
  process.env.LUCERO_NO_AUTO_BEFORE = new Date(Date.now() - 48 * 3600_000).toISOString();
  writeCollection("email_processed", [{ key: "a@x.com|msg-A", at: new Date().toISOString(), outcome: "sent" }]);
  const out = filtrarCandidatosSinResponder([
    mensaje({ id: "msg-A", from: "a@x.com" }),
    mensaje({ id: "msg-B", from: "b@x.com", subject: "Interesado en el BMW" }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "msg-B");
  delete process.env.LUCERO_NO_AUTO_BEFORE;
});

const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} pruebas superadas.`);
if (fails.length > 0) process.exit(1);
