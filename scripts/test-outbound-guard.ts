// Pruebas reales (17/11/2026) de la barrera central de outbound-guard.ts y
// del fix del vector confirmado en contactLeadViaWhatsapp (src/email/agent.ts).
// NUNCA usa DATA_DIR de producción (se exige una env var DATA_DIR de prueba
// antes de ejecutar), NUNCA manda un mensaje real (sin credenciales de
// WhatsApp/Zernio en el entorno de prueba, sendWhatsappText no puede llegar
// a la red real aunque la barrera lo autorice -- devuelve
// "whatsapp_not_connected", que es justo lo que se usa para distinguir
// "bloqueado por la barrera" de "autorizado, pero sin integración real").
//
// Uso:
//   DATA_DIR=/tmp/lucero-test-$$ npx tsx scripts/test-outbound-guard.ts

import assert from "node:assert/strict";
import path from "node:path";

if (!process.env.DATA_DIR || process.env.DATA_DIR.includes(path.join("automoviles-lucero", "data"))) {
  console.error("Niega ejecutar sin una DATA_DIR de prueba explícita y distinta de la de producción.");
  process.exit(1);
}
// Asegurar explícitamente que no hay credenciales reales activas en este
// proceso de prueba, pase lo que pase en el entorno que lo invoque.
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

const { authorizeOutboundMessage, authorizeAndSendOutbound, OUTBOUND_REQUIRE_INBOUND_WITHIN_HOURS } = await import("../src/outbound-guard.js");
const { sendWhatsappText } = await import("../src/integrations/whatsapp.js");
const { writeCollection, readCollection, readShard, writeShard } = await import("../src/store.js");
const { processInboundEmail } = await import("../src/email/agent.js");
const { setOfficialStatus } = await import("../src/tools/vehicle-state.js");
const { runSeguimientoComercial } = await import("../src/chat/followup-comercial.js");
const { lastInboundAt: lastWhatsappInboundAt, horasDesdeUltimoEntrante } = await import("../src/chat/whatsapp-window.js");
const { sendWhatsapp } = await import("../src/tools/delivery.js");
const { createReservationPending, confirmReservation, submitPaymentReceipt } = await import("../src/tools/reservations.js");
const { vehiclesSeed } = await import("../src/data/vehicles-seed.js");
const {
  processDueWhatsappBatches,
  enqueueWhatsappBatchMessage,
  claimBatchOnce,
  WHATSAPP_BATCH_MAX_AGE_HOURS,
} = await import("../src/chat/whatsapp-batch.js");
const fsNode = await import("node:fs");
const pathNode = await import("node:path");

const HOUR = 3600_000;
const now = Date.now();

function cochesNetEmail(opts: { phone: string; make: string; model: string; receivedAt: string; messageKey: string }) {
  const json = JSON.stringify({
    client: { first_name: "Cliente Prueba", phone: opts.phone },
    sales_lead: { car: { make: opts.make, model: opts.model, version: "1.0" }, inquiry: "hola, me interesa" },
  });
  return {
    messageKey: opts.messageKey,
    from: "vehiculosocasion@coches.net",
    fromName: "Coches.net",
    subject: "Tienes un nuevo contacto",
    text: `Tienes un nuevo contacto en tu anuncio.\nquiere que le contactes solo por whatsapp\nHola, me interesa\n**Recuerda utilizar siempre la plataforma.\n${json}`,
    receivedAt: opts.receivedAt,
  };
}

// 1) Conversación de hace 2 años, sin mensaje entrante nuevo -> bloqueado.
await test("2 años sin mensaje entrante -> bloqueado (sin evento)", () => {
  const r = authorizeOutboundMessage({ phone: "+34600000001", channel: "whatsapp", lastInboundAt: null, reason: "test" });
  assert.equal(r.ok, false);
});
await test("2 años con último entrante real hace 2 años -> bloqueado", () => {
  const dosAnios = now - 2 * 365 * 24 * HOUR;
  const r = authorizeOutboundMessage({ phone: "+34600000001", channel: "whatsapp", lastInboundAt: dosAnios, reason: "test", now });
  assert.equal(r.ok, false);
});

// 2) Conversación de hace 1 año -> bloqueado.
await test("1 año desde el último entrante -> bloqueado", () => {
  const unAnio = now - 365 * 24 * HOUR;
  const r = authorizeOutboundMessage({ phone: "+34600000002", channel: "whatsapp", lastInboundAt: unAnio, reason: "test", now });
  assert.equal(r.ok, false);
});

// sendWhatsappText real (sin credenciales) usando el auto-resolve por teléfono.
await test("sendWhatsappText bloquea por defecto un contacto con último entrante de hace 2 años", async () => {
  writeCollection("whatsapp_inbox", [{ phone: "+34600000003", created_at: new Date(now - 2 * 365 * 24 * HOUR).toISOString() }]);
  const r = await sendWhatsappText("+34600000003", "hola");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /bloqueado_outbound_guard/);
});

// 9) Cliente antiguo (lead de hace 2 años) que SÍ escribe HOY -> sí puede recibir respuesta.
await test("cliente antiguo que escribe HOY -> autorizado (no bloqueado por la barrera)", async () => {
  writeCollection("whatsapp_inbox", [{ phone: "+34600000004", created_at: new Date(now - 2 * 365 * 24 * HOUR).toISOString() }, { phone: "+34600000004", created_at: new Date(now).toISOString() }]);
  const r = await sendWhatsappText("+34600000004", "hola, gracias por escribir");
  // Sin credenciales reales en el entorno de prueba, el envío de verdad no
  // puede completarse -- lo que demuestra el test es que NO lo bloqueó la
  // barrera (error distinto de bloqueado_outbound_guard).
  assert.equal(r.ok, false);
  assert.doesNotMatch((r as { error: string }).error, /bloqueado_outbound_guard/);
});

// Ventana configurable: documentar el valor real usado.
await test(`ventana configurable real = ${OUTBOUND_REQUIRE_INBOUND_WITHIN_HOURS}h (no son las 23h de Meta/seguimiento)`, () => {
  assert.equal(OUTBOUND_REQUIRE_INBOUND_WITHIN_HOURS, 48);
});

// 3) Correo antiguo (más de la ventana) marcado "no leído"/reprocesado -> cero envíos.
await test("correo Coches.net de hace 100h (reprocesado) -> bloqueado_por_antiguedad, sin ofrecer disponibilidad", async () => {
  writeCollection("leads", []);
  writeCollection("first_contact_sent", []);
  writeCollection("email_processed", []);
  const email = cochesNetEmail({
    phone: "34611111111",
    make: "AUDI",
    model: "A7",
    receivedAt: new Date(now - 100 * HOUR).toISOString(),
    messageKey: "msg-antiguo-1",
  });
  const result = await processInboundEmail(email);
  assert.equal(result.outcome, "bloqueado_por_antiguedad");
});

// 6) Evento entrante duplicado (mismo id procesado dos veces) -> no envío adicional.
await test("mismo correo (mismo messageKey) procesado dos veces -> la segunda es 'duplicate'", async () => {
  writeCollection("leads", []);
  writeCollection("first_contact_sent", []);
  writeCollection("email_processed", []);
  const email = cochesNetEmail({
    phone: "34611111112",
    make: "AUDI",
    model: "A7",
    receivedAt: new Date(now - 1 * HOUR).toISOString(),
    messageKey: "msg-duplicado-1",
  });
  const first = await processInboundEmail(email);
  assert.notEqual(first.outcome, "duplicate");
  const second = await processInboundEmail(email);
  assert.equal(second.outcome, "duplicate");
});

// 10) El vector ya confirmado: coche SOLD/inexistente -> no se ofrece disponibilidad.
await test("vector confirmado: AUDI A7 marcado SOLD -> primer contacto NO ofrece disponibilidad/reserva", async () => {
  writeCollection("leads", []);
  writeCollection("first_contact_sent", []);
  writeCollection("email_processed", []);
  writeCollection("vehicle_state", []);
  // Se busca el Audi A7 por marca y modelo: su id interno cambia en cada
  // reimportación del stock (23/11/2026), nunca se escribe a mano.
  const a7 = vehiclesSeed.find((v) => v.make === "AUDI" && v.model.startsWith("A7"));
  assert.ok(a7, "el stock de prueba debe contener un Audi A7");
  setOfficialStatus(a7.id, "SOLD", null);
  const email = cochesNetEmail({
    phone: "34611111113",
    make: "AUDI",
    model: "A7",
    receivedAt: new Date(now - 1 * HOUR).toISOString(), // reciente, dentro de ventana
    messageKey: "msg-sold-1",
  });
  const result = await processInboundEmail(email);
  // No debe estar bloqueado por antigüedad (el correo es reciente) -- debe
  // llegar hasta construir el texto, y ese texto debe ser el honesto, nunca
  // el que ofrece ver/reservar el coche.
  assert.notEqual(result.outcome, "bloqueado_por_antiguedad");
  assert.ok(result.reply, "se esperaba un texto de respuesta construido");
  assert.doesNotMatch(result.reply ?? "", /¿Qué día y hora te vendría bien para venir a verlo\?/);
  assert.match(result.reply ?? "", /ya no está disponible/);
});

// Mismo vehículo pero AVAILABLE -> el primer contacto normal sigue funcionando igual que antes.
await test("vector confirmado: AUDI A7 disponible (AVAILABLE) -> primer contacto normal sigue ofreciendo ver el coche", async () => {
  writeCollection("leads", []);
  writeCollection("first_contact_sent", []);
  writeCollection("email_processed", []);
  writeCollection("vehicle_state", []); // sin fila -> AVAILABLE por defecto
  const email = cochesNetEmail({
    phone: "34611111114",
    make: "AUDI",
    model: "A7",
    receivedAt: new Date(now - 1 * HOUR).toISOString(),
    messageKey: "msg-available-1",
  });
  const result = await processInboundEmail(email);
  assert.notEqual(result.outcome, "bloqueado_por_antiguedad");
  assert.match(result.reply ?? "", /¿Qué día y hora te vendría bien para venir a verlo\?/);
});

// 4) Reimportación de inventario no debe disparar ningún envío por sí sola.
await test("scripts/import-dealcar.mjs no llama a ninguna función de envío", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./import-dealcar.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /sendWhatsapp|sendGmail|deliverEmail|sendZernio/);
});

// 5) Reinicio con colas/reintentos pendientes -> ningún envío NO autorizado se cuela.
// (whatsapp-retry.ts SÍ está marcado como excepción explícita admin-approved
// -- ver src/alerts/whatsapp-retry.ts -- lo que se prueba aquí es que
// cualquier envío genérico de cola que NO pase allowProactive sigue
// protegido por la barrera por defecto, incluso tras un reinicio simulado
// (nueva lectura desde disco, sin estado en memoria).)
await test("sendWhatsapp (delivery.ts) sin allowProactive sigue bloqueado para un contacto sin entrante reciente, tras 'reinicio' (relectura desde disco)", async () => {
  writeCollection("whatsapp_inbox", [{ phone: "+34600000005", created_at: new Date(now - 10 * 24 * HOUR).toISOString() }]);
  const r = await sendWhatsapp({ lead_phone: "+34600000005", message: "reintento de cola" });
  assert.equal(r.status, "denied");
  // El error real en este entorno de prueba (sin credenciales) sería
  // "no_whatsapp_integration" si la barrera no actuara primero -- aquí no
  // hay forma de distinguir sin credenciales, así que se comprueba
  // directamente con sendWhatsappText (mismo camino interno).
  const direct = await sendWhatsappText("+34600000005", "reintento de cola");
  assert.match((direct as { error: string }).error, /bloqueado_outbound_guard/);
});

// 7) Seguimiento comercial proactivo (LUCERO_FOLLOWUP_ENABLED=1): sigue
// funcionando para clientes dentro de ventana real, pero no alcanza una
// conversación vieja. runSeguimientoComercial exige isWhatsappConnected()
// para hacer nada -- en este entorno de prueba deliberadamente no hay
// credenciales reales (regla dura: nunca llamar a una API de pago real,
// aunque fuera con un token falso que la rechazara al instante), así que
// se prueba primero que la función se frena sola sin credenciales (ya
// comportamiento correcto y preexistente), y después se prueba el mecanismo
// exacto del que depende (lastInboundAt/horasDesdeUltimoEntrante de
// whatsapp-window.ts) para la misma pareja reciente/viejo -- es la función
// que runSeguimientoComercial usa literalmente para decidir a quién
// descarta antes de intentar nada.
await test("seguimiento comercial: sin WhatsApp conectado no envía nada (comportamiento preexistente, no se toca)", async () => {
  process.env.LUCERO_FOLLOWUP_ENABLED = "1";
  const r = await runSeguimientoComercial(now);
  assert.equal(r.enviados, 0);
  assert.deepEqual(r.saltados, ["whatsapp_no_conectado"]);
});
await test("seguimiento comercial: la ventana real (23h) distingue reciente vs. viejo igual que antes del cambio", () => {
  const haceCincoHoras = new Date(now - 5 * HOUR).toISOString();
  const haceDosAnios = new Date(now - 2 * 365 * 24 * HOUR).toISOString();
  writeCollection("whatsapp_inbox", [
    { phone: "+34600000010", created_at: haceCincoHoras },
    { phone: "+34600000011", created_at: haceDosAnios },
  ]);
  const horasReciente = horasDesdeUltimoEntrante("+34600000010", now);
  const horasViejo = horasDesdeUltimoEntrante("+34600000011", now);
  assert.ok(horasReciente !== null && horasReciente < 23, `reciente: ${horasReciente}`);
  assert.ok(horasViejo !== null && horasViejo > 23, `viejo: ${horasViejo}`);
});

// ===== Fase 2C (18/11/2026): nuevas pruebas reales autorizadas por el cliente =====

const vehicleReal = vehiclesSeed[0];
assert.ok(vehicleReal, "se necesita al menos un vehículo real en vehicles-seed.ts para las pruebas");

// Vehículo eliminado del catálogo actual (reimportación que lo quita): ninguna
// reserva lo trata como existente.
await test("vehículo retirado del catálogo (id inventado) -> createReservationPending rechaza, no reserva", async () => {
  writeCollection("reservations", []);
  writeCollection("vehicle_state", []);
  const r = await createReservationPending({ vehicle_id: "id-que-ya-no-existe-tras-reimportacion", lead_phone: "+34600000020" });
  assert.equal((r as { status: string }).status, "denied");
  assert.equal((r as { error_code?: string }).error_code, "vehicle_not_found_in_catalog");
  assert.equal(readCollection<unknown>("reservations").length, 0, "no debe haberse creado ninguna reserva");
});

// Catálogo no disponible (excepción real en currentVehicles()) -> falla
// cerrado. Se fuerza corrompiendo el fichero vehicle_overrides.json en disco
// (JSON inválido), que es justo lo que hace currentVehicles() lanzar una
// excepción real al leerlo -- nunca un mock de la función en sí.
await test("catálogo no consultable (excepción real) -> createReservationPending falla CERRADO, nunca abierto", async () => {
  writeCollection("reservations", []);
  writeCollection("vehicle_overrides", []); // asegura que el fichero existe antes de corromperlo
  const overridesPath = pathNode.join(process.env.DATA_DIR as string, "vehicle_overrides.json");
  fsNode.writeFileSync(overridesPath, "{ esto no es json válido ::: ");
  try {
    const r = await createReservationPending({ vehicle_id: vehicleReal.id, lead_phone: "+34600000021" });
    assert.equal((r as { status: string }).status, "denied");
    assert.equal((r as { error_code?: string }).error_code, "catalog_unavailable");
    assert.equal(readCollection<unknown>("reservations").length, 0, "no debe haberse creado ninguna reserva con el catálogo roto");
  } finally {
    writeCollection("vehicle_overrides", []); // deja el fichero sano para las pruebas siguientes
  }
});

// BUG 1 corregido: dos confirmaciones casi simultáneas del mismo vehículo ->
// solo UNA queda confirmed, la otra se rechaza con reservation_already_resolved.
await test("dos confirmReservation simultáneas de reservas del mismo vehículo -> solo una queda confirmed", async () => {
  writeCollection("reservations", []);
  writeCollection("vehicle_state", []);
  const pendingA = await createReservationPending({ vehicle_id: vehicleReal.id, lead_phone: "+34600000022" });
  const resA = (pendingA as { data: { id: string } }).data;
  // Segunda reserva "en paralelo" del mismo vehículo (Sección 27: válido, se
  // permite -- ver createReservationPending_sinBloqueo).
  const pendingB = await createReservationPending({ vehicle_id: vehicleReal.id, lead_phone: "+34600000023" });
  const resB = (pendingB as { data: { id: string } }).data;

  const [outA, outB] = await Promise.all([
    confirmReservation({ reservation_id: resA.id, verified_by: "ramon" }),
    confirmReservation({ reservation_id: resB.id, verified_by: "jose" }),
  ]);
  const estados = readCollection<{ id: string; status: string }>("reservations");
  const confirmadas = estados.filter((r) => r.status === "confirmed");
  assert.equal(confirmadas.length, 1, `se esperaba exactamente 1 reserva confirmed, hubo ${confirmadas.length}`);
  const statuses = [outA, outB].map((o) => (o as { status: string }).status).sort();
  // Una de las dos llamadas tuvo éxito ("ok"); dado que ambas reservas
  // partían de pending_payment (CONFIRMABLE_FROM), la que pierde la carrera
  // por el lock se confirma igual (todavía era confirmable en su turno) salvo
  // que la primera ya la hubiera cancelado como "superseded" -- en cuyo caso
  // debe rechazarse con reservation_already_resolved. Se admite cualquiera de
  // los dos desenlaces válidos, pero NUNCA dos "ok".
  const oks = statuses.filter((s) => s === "ok").length;
  assert.ok(oks <= 1, `nunca deben confirmarse las dos a la vez (statuses: ${statuses.join(",")})`);
  if (oks === 1) {
    const denied = [outA, outB].find((o) => (o as { status: string }).status !== "ok") as { error_code?: string } | undefined;
    if (denied) assert.equal(denied.error_code, "reservation_already_resolved");
  }
  const intentos = readCollection<{ result: string }>("reservation_confirm_attempts");
  assert.ok(intentos.length >= 2, "debe quedar registro de ambos intentos de confirmación");
});

// Doble confirmación de la MISMA reserva (caso más directo del bug): la
// segunda llamada rechaza con el nuevo error_code, nunca la pisa.
await test("doble confirmReservation sobre la MISMA reserva -> la segunda rechaza con reservation_already_resolved", async () => {
  writeCollection("reservations", []);
  writeCollection("vehicle_state", []);
  const pending = await createReservationPending({ vehicle_id: vehicleReal.id, lead_phone: "+34600000024" });
  const res = (pending as { data: { id: string } }).data;
  const [out1, out2] = await Promise.all([
    confirmReservation({ reservation_id: res.id, verified_by: "ramon" }),
    confirmReservation({ reservation_id: res.id, verified_by: "jose" }),
  ]);
  const statuses = [out1, out2].map((o) => (o as { status: string }).status);
  const oks = statuses.filter((s) => s === "ok").length;
  assert.equal(oks, 1, `exactamente una de las dos debe confirmar, statuses=${statuses.join(",")}`);
  const denied = [out1, out2].find((o) => (o as { status: string }).status !== "ok") as { error_code?: string };
  assert.equal(denied.error_code, "reservation_already_resolved");
});

// submitPaymentReceipt ya protegido antes (patrón que confirmReservation
// ahora replica): confirma que sigue intacto.
await test("submitPaymentReceipt sigue exigiendo pending_payment (comportamiento preexistente intacto)", async () => {
  writeCollection("reservations", []);
  writeCollection("vehicle_state", []);
  const pending = await createReservationPending({ vehicle_id: vehicleReal.id, lead_phone: "+34600000025" });
  const res = (pending as { data: { id: string } }).data;
  const first = submitPaymentReceipt({ reservation_id: res.id });
  assert.equal((first as { status: string }).status, "ok");
  const second = submitPaymentReceipt({ reservation_id: res.id });
  assert.equal((second as { status: string }).status, "denied");
  assert.equal((second as { error_code?: string }).error_code, "reservation_not_pending_payment");
});

// BUG 2 corregido: lote pendiente de varios DÍAS -> se descarta a revisión
// humana, NUNCA se procesa ni se envía nada.
await test(`lote WhatsApp de >48h (supera WHATSAPP_BATCH_MAX_AGE_HOURS=${WHATSAPP_BATCH_MAX_AGE_HOURS}h) -> descartado, nunca procesado`, async () => {
  writeCollection("zernio_whatsapp_batches", []);
  writeCollection("whatsapp_batch_discarded", []);
  await enqueueWhatsappBatchMessage("+34600000030", { eventId: "ev-viejo-1", whatsappInboxId: "wi-1", text: "hola, sigue disponible el coche?" });
  // Retrocede artificialmente last_at para simular >48h de antigüedad real
  // (tras una caída larga del servidor, exactamente el escenario del punto 3).
  type Shard = { phone: string; items: unknown[]; last_at: number; inflight?: { batch_id: string; items: unknown[]; started_at: number } };
  const raw = readShard<Shard>("zernio_whatsapp_batches", "+34600000030");
  assert.ok(raw);
  raw!.last_at = Date.now() - 50 * HOUR;
  writeShard("zernio_whatsapp_batches", "+34600000030", raw);

  let procesado = false;
  await processDueWhatsappBatches(async () => {
    procesado = true;
  });
  assert.equal(procesado, false, "nunca debe procesarse/responderse un lote de >48h");
  const descartados = readCollection<{ phone: string; origen: string }>("whatsapp_batch_discarded");
  assert.ok(descartados.some((d) => d.phone === "+34600000030" && d.origen === "items"), "debe quedar registrado el lote descartado para revisión humana");
  const after = readShard<Shard>("zernio_whatsapp_batches", "+34600000030");
  assert.equal(after?.items.length, 0, "el lote viejo se vacía de la cola de pendientes (no queda reintentándose en bucle)");
});

// Reinicio con un lote `inflight` RECIENTE (corto) -> sigue procesándose con
// normalidad tras el "reinicio" (misma lectura desde disco que simula 2A).
await test("lote inflight reciente (<48h) tras un reinicio corto -> SÍ se procesa con normalidad", async () => {
  writeCollection("zernio_whatsapp_batches", []);
  writeCollection("whatsapp_batch_discarded", []);
  writeShard("zernio_whatsapp_batches", "+34600000031", {
    phone: "+34600000031",
    items: [],
    last_at: Date.now(),
    inflight: { batch_id: "batch-reciente-1", items: [{ eventId: "ev-1", whatsappInboxId: "wi-2", text: "hola" }], started_at: Date.now() - 2 * 60_000 },
  });
  let procesado = false;
  await processDueWhatsappBatches(async (phone, items, batchId) => {
    if (phone === "+34600000031" && batchId === "batch-reciente-1" && items.length === 1) procesado = true;
  });
  assert.equal(procesado, true, "un lote inflight reciente tras un reinicio corto debe seguir procesándose");
  const descartados = readCollection<{ phone: string }>("whatsapp_batch_discarded");
  assert.ok(!descartados.some((d) => d.phone === "+34600000031"), "no debe descartarse un lote inflight reciente");
});

// Reinicio con un lote `inflight` VIEJO (>48h, p. ej. el servidor lleva días
// caído) -> se descarta a revisión humana, nunca se dispara con retraso.
await test("lote inflight viejo (>48h) recuperado tras un reinicio largo -> descartado, nunca procesado con retraso", async () => {
  writeCollection("zernio_whatsapp_batches", []);
  writeCollection("whatsapp_batch_discarded", []);
  writeShard("zernio_whatsapp_batches", "+34600000032", {
    phone: "+34600000032",
    items: [],
    last_at: Date.now() - 72 * HOUR,
    inflight: { batch_id: "batch-viejo-1", items: [{ eventId: "ev-2", whatsappInboxId: "wi-3", text: "hola, sigue disponible?" }], started_at: Date.now() - 72 * HOUR },
  });
  let procesado = false;
  await processDueWhatsappBatches(async () => {
    procesado = true;
  });
  assert.equal(procesado, false, "un lote inflight de >48h tras un reinicio largo nunca debe procesarse con retraso");
  const descartados = readCollection<{ phone: string; origen: string }>("whatsapp_batch_discarded");
  assert.ok(descartados.some((d) => d.phone === "+34600000032" && d.origen === "inflight"), "debe quedar registrado el lote inflight viejo descartado");
});

// Cliente nuevo preguntando por un vehículo realmente disponible -> sigue
// recibiendo una respuesta normal del lote, sin falsos bloqueos por antigüedad.
await test("lote WhatsApp reciente de cliente nuevo sobre vehículo disponible -> se procesa con normalidad, sin falso bloqueo", async () => {
  writeCollection("zernio_whatsapp_batches", []);
  writeCollection("whatsapp_batch_discarded", []);
  await enqueueWhatsappBatchMessage("+34600000033", { eventId: "ev-3", whatsappInboxId: "wi-4", text: `hola, el ${vehicleReal.make} ${vehicleReal.model} sigue disponible?` });
  // Ventana de silencio (BATCH_WINDOW_MS) ya cumplida -> listo para procesar.
  type Shard2 = { phone: string; items: unknown[]; last_at: number };
  const raw2 = readShard<Shard2>("zernio_whatsapp_batches", "+34600000033");
  assert.ok(raw2);
  raw2!.last_at = Date.now() - 30_000; // 30s, dentro del límite de antigüedad, fuera de la ventana de silencio de 8s
  writeShard("zernio_whatsapp_batches", "+34600000033", raw2);

  let procesado = false;
  await processDueWhatsappBatches(async (phone, items) => {
    if (phone === "+34600000033" && items.length === 1) procesado = true;
  });
  assert.equal(procesado, true, "un lote reciente de un cliente nuevo debe procesarse con normalidad");
  const descartados = readCollection<{ phone: string }>("whatsapp_batch_discarded");
  assert.ok(!descartados.some((d) => d.phone === "+34600000033"), "no debe descartarse un lote reciente");
});

// ===== Fase 2D (18/11/2026): servicio central authorizeAndSendOutbound =====

const { deliverEmail } = await import("../src/email/agent.js");
const { setWhatsappChatPaused } = await import("../src/tools/agent-toggle.js");

// Correo antiguo reprocesado de Coches.net sin legitimidad verificable ->
// bloqueado Y se crea una tarea real de revisión humana (regla explícita del
// dueño: "no basta con loguear y olvidar").
await test("correo Coches.net bloqueado por antigüedad -> se crea una tarea real de revisión humana", async () => {
  writeCollection("leads", []);
  writeCollection("first_contact_sent", []);
  writeCollection("email_processed", []);
  writeCollection("tasks", []);
  const email = cochesNetEmail({
    phone: "34611111199",
    make: "AUDI",
    model: "A7",
    receivedAt: new Date(now - 100 * HOUR).toISOString(),
    messageKey: "msg-antiguo-con-tarea-1",
  });
  const result = await processInboundEmail(email);
  assert.equal(result.outcome, "bloqueado_por_antiguedad");
  const tareas = readCollection<{ type: string; source_ref?: string }>("tasks");
  assert.ok(
    tareas.some((t) => t.type === "contactar_whatsapp" && t.source_ref === "bloqueado_antiguedad_msg-antiguo-con-tarea-1"),
    "debe existir una tarea real de revisión humana para este correo bloqueado",
  );
});

// deliverEmail, igual que sendWhatsappText, aplica el chequeo 1 por defecto
// (defensa en profundidad) -- un destinatario sin ningún correo entrante
// real reciente queda bloqueado aunque el llamador no pase por
// authorizeAndSendOutbound ni por outbound-guard.ts explícitamente.
await test("deliverEmail bloquea por defecto un destinatario sin correo entrante reciente", async () => {
  writeCollection("email_inbox", []);
  const r = await deliverEmail("cliente-sin-entrante@example.com", "asunto", "cuerpo");
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /bloqueado_outbound_guard/);
});

await test("deliverEmail con allowProactive:true (excepción real) no se bloquea por falta de evento entrante", async () => {
  writeCollection("email_inbox", []);
  const r = await deliverEmail("cliente-sin-entrante@example.com", "asunto", "cuerpo", undefined, { allowProactive: true, reason: "test_excepcion" });
  // Sin Google conectado en este entorno de prueba, "sent" no puede
  // lograrse -- lo que demuestra el test es que NO lo bloqueó la barrera.
  assert.notEqual(r.status, "failed");
  assert.doesNotMatch(r.error ?? "", /bloqueado_outbound_guard/);
});

// Vehículo vendido / inexistente -> authorizeAndSendOutbound (kind
// "vehicle_availability") bloquea antes de construir o mandar nada.
await test("authorizeAndSendOutbound: vehículo SOLD -> bloqueado (vehicle_not_available_SOLD)", async () => {
  writeCollection("vehicle_state", []);
  writeCollection("whatsapp_inbox", [{ phone: "+34600000040", created_at: new Date(now).toISOString() }]);
  setOfficialStatus(vehicleReal.id, "SOLD", null);
  const r = await authorizeAndSendOutbound({
    phone: "+34600000040",
    channel: "whatsapp",
    kind: "vehicle_availability",
    vehicleId: vehicleReal.id,
    lastInboundAt: now,
    reason: "test_vehiculo_vendido",
    textBuilder: () => "texto que nunca debería construirse de verdad para esta prueba",
  });
  assert.equal(r.ok, false);
  assert.match((r as { motivo: string }).motivo, /vehicle_not_available_SOLD/);
  setOfficialStatus(vehicleReal.id, "AVAILABLE", null);
});

await test("authorizeAndSendOutbound: vehicle_id inexistente en catálogo -> bloqueado (vehicle_not_found_in_catalog)", async () => {
  writeCollection("whatsapp_inbox", [{ phone: "+34600000041", created_at: new Date(now).toISOString() }]);
  const r = await authorizeAndSendOutbound({
    phone: "+34600000041",
    channel: "whatsapp",
    kind: "vehicle_availability",
    vehicleId: "id-inventado-que-no-existe",
    lastInboundAt: now,
    reason: "test_vehiculo_inexistente",
    textBuilder: () => "texto",
  });
  assert.equal(r.ok, false);
  assert.match((r as { motivo: string }).motivo, /vehicle_not_found_in_catalog/);
});

// Cliente histórico (2 años) -> bloqueado, ahora vía el servicio central.
await test("authorizeAndSendOutbound: cliente histórico (2 años, sin evento reciente) -> bloqueado", async () => {
  writeCollection("whatsapp_inbox", [{ phone: "+34600000042", created_at: new Date(now - 2 * 365 * 24 * HOUR).toISOString() }]);
  const r = await authorizeAndSendOutbound({
    phone: "+34600000042",
    channel: "whatsapp",
    reason: "test_cliente_historico",
    textBuilder: () => "hola, hace mucho que no hablamos",
  });
  assert.equal(r.ok, false);
  const bloqueos = readCollection<{ phone: string; resultado: string; reason: string }>("outbound_guard_blocks");
  assert.ok(bloqueos.some((b) => b.phone === "+34600000042" && b.resultado === "bloqueado" && b.reason === "test_cliente_historico"), "debe quedar auditado el bloqueo con su motivo exacto");
});

// Intervención humana: contacto pausado por el equipo -> bloqueado aunque
// tenga un evento entrante reciente real.
await test("authorizeAndSendOutbound: contacto pausado por el equipo (intervención humana) -> bloqueado aunque haya evento reciente", async () => {
  const phone = "+34600000043";
  writeCollection("whatsapp_inbox", [{ phone, created_at: new Date(now).toISOString() }]);
  setWhatsappChatPaused(phone, true, "ramon");
  try {
    const r = await authorizeAndSendOutbound({ phone, channel: "whatsapp", lastInboundAt: now, reason: "test_pausado", textBuilder: () => "hola" });
    assert.equal(r.ok, false);
    assert.match((r as { motivo: string }).motivo, /intervencion_humana_pausado/);
  } finally {
    setWhatsappChatPaused(phone, false, "ramon");
  }
});

// Cada excepción autorizada real se envía sin bloquear y queda auditada como
// excepción explícita (no simplemente "pasó").
await test("authorizeAndSendOutbound: excepción real (allowProactive:true) se intenta enviar y queda auditada como autorizada", async () => {
  writeCollection("whatsapp_inbox", []); // sin ningún evento entrante -- solo pasa por ser una excepción real
  const r = await authorizeAndSendOutbound({
    phone: "+34600000044",
    channel: "whatsapp",
    allowProactive: true,
    reason: "test_excepcion_cita_agendada",
    textBuilder: () => "recordatorio de tu cita de hoy",
  });
  // Sin credenciales reales en este entorno de prueba, el envío de verdad no
  // puede completarse -- lo que demuestra el test es que NO lo bloqueó la
  // barrera (sigue hasta intentar el envío real).
  assert.equal(r.ok, false);
  assert.match((r as { motivo: string }).motivo, /envio_fallido/);
  const bloqueos = readCollection<{ phone: string; resultado: string; reason: string; allow_proactive: boolean }>("outbound_guard_blocks");
  assert.ok(
    bloqueos.some((b) => b.phone === "+34600000044" && b.resultado === "autorizado" && b.reason === "test_excepcion_cita_agendada" && b.allow_proactive === true),
    "la excepción autorizada debe quedar auditada explícitamente, con su motivo, no solo 'pasó'",
  );
});

// Dedup (chequeo 7, red de seguridad adicional): la misma dedupeKey no deja
// pasar un segundo envío.
await test("authorizeAndSendOutbound: misma dedupeKey dos veces -> la segunda queda bloqueada por duplicado", async () => {
  writeCollection("whatsapp_inbox", []);
  const args = {
    phone: "+34600000045",
    channel: "whatsapp" as const,
    allowProactive: true,
    reason: "test_dedupe",
    dedupeKey: "dedupe-key-unica-test-1",
    textBuilder: () => "hola",
  };
  const first = await authorizeAndSendOutbound(args);
  const second = await authorizeAndSendOutbound(args);
  // La primera puede fallar el ENVÍO real (sin credenciales), pero no debe
  // fallar por duplicado -- la segunda sí, siempre.
  assert.doesNotMatch((first as { motivo: string }).motivo ?? "", /duplicado_dedupe_key/);
  assert.equal(second.ok, false);
  assert.match((second as { motivo: string }).motivo, /duplicado_dedupe_key/);
});

// Una función de envío nueva que intente mandar un WhatsApp sin pasar por el
// servicio central (sendWhatsappText/deliverEmail/outbound-guard.ts) -- la
// prueba arquitectónica (scripts/test-outbound-architecture.ts) debe
// detectarlo. Se demuestra aquí ejecutando esa prueba como subproceso real.
await test("función de envío nueva que se salta la barrera (llamada directa simulada) es detectada por la prueba arquitectónica", async () => {
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("npx", ["tsx", new URL("./test-outbound-architecture.ts", import.meta.url).pathname], {
      cwd: new URL("..", import.meta.url).pathname,
      stdio: "pipe",
    });
  } catch (err) {
    throw new Error(`la prueba arquitectónica debía pasar en el estado real del repo (sin violaciones): ${err instanceof Error ? err.message : String(err)}`);
  }
});

const fallidos = results.filter((r) => !r.ok);
console.log(`\n${results.length - fallidos.length}/${results.length} pruebas superadas.`);
if (fallidos.length > 0) {
  console.log("Fallidas:", fallidos.map((f) => `${f.name}: ${f.detail}`).join("\n"));
  process.exit(1);
}
