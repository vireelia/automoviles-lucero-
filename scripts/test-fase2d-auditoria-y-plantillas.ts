// Pruebas reales (18/11/2026, Fase 2D -- encargo autorizado por escrito
// "exclusivamente en desarrollo") de:
//   Paso 2: las tres rutas nuevas de auditoría de solo lectura
//           (/debug/outbound_guard_blocks, /debug/whatsapp_batch_discarded,
//           /debug/reservation_confirm_attempts).
//   Paso 3: la revalidación en el instante del envío para las plantillas
//           de Zernio (vehicle_contact / team_alert / client_reminder).
//
// NUNCA usa DATA_DIR de producción (misma barrera que test-outbound-guard.ts),
// levanta el servidor real en un puerto de prueba contra ese DATA_DIR, y NUNCA
// manda un mensaje real (sin credenciales de Zernio/WhatsApp en el entorno).
//
// Uso:
//   DATA_DIR=/tmp/lucero-test-$$ PORT=8099 ADMIN_TOKEN=test-token \
//     npx tsx scripts/test-fase2d-auditoria-y-plantillas.ts

import assert from "node:assert/strict";
import path from "node:path";

if (!process.env.DATA_DIR || process.env.DATA_DIR.includes(path.join("automoviles-lucero", "data"))) {
  console.error("Niega ejecutar sin una DATA_DIR de prueba explícita y distinta de la de producción.");
  process.exit(1);
}
delete process.env.ZERNIO_API_KEY;
delete process.env.ZERNIO_WHATSAPP_ACCOUNT_ID;
delete process.env.WHATSAPP_ACCESS_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || "test-token-fase2d";
const PORT = Number(process.env.PORT ?? 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.ADMIN_TOKEN;

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

async function main() {
  // Importar server.ts arranca el servidor real en PORT (escucha definida
  // al final del propio archivo) -- mismo patrón que usa el proyecto, nunca
  // se reimplementa un servidor de pruebas aparte.
  await import("../src/server.js");
  await new Promise((r) => setTimeout(r, 400));

  const { appendToCollection, writeCollection, readCollection } = await import("../src/store.js");
  const { setOfficialStatus } = await import("../src/tools/vehicle-state.js");
  const { currentVehicles } = await import("../src/data/vehicles-current.js");
  const outboundGuard = await import("../src/outbound-guard.js");

  // ---- Paso 2: rutas de auditoría ----

  await test("GET /debug/outbound_guard_blocks sin token -> 401", async () => {
    const res = await fetch(`${BASE}/debug/outbound_guard_blocks`);
    assert.equal(res.status, 401);
  });

  await test("GET /debug/outbound_guard_blocks con token -> 200 + array", async () => {
    const res = await fetch(`${BASE}/debug/outbound_guard_blocks`, { headers: { "x-admin-token": TOKEN } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
  });

  await test("POST /debug/outbound_guard_blocks -> no existe esa ruta/método (solo GET)", async () => {
    const res = await fetch(`${BASE}/debug/outbound_guard_blocks`, { method: "POST", headers: { "x-admin-token": TOKEN } });
    assert.ok(res.status === 404 || res.status === 405, `esperaba 404/405, fue ${res.status}`);
  });
  await test("PUT /debug/whatsapp_batch_discarded -> rechazado (solo GET)", async () => {
    const res = await fetch(`${BASE}/debug/whatsapp_batch_discarded`, { method: "PUT", headers: { "x-admin-token": TOKEN } });
    assert.ok(res.status === 404 || res.status === 405, `esperaba 404/405, fue ${res.status}`);
  });
  await test("DELETE /debug/reservation_confirm_attempts -> rechazado (solo GET)", async () => {
    const res = await fetch(`${BASE}/debug/reservation_confirm_attempts`, { method: "DELETE", headers: { "x-admin-token": TOKEN } });
    assert.ok(res.status === 404 || res.status === 405, `esperaba 404/405, fue ${res.status}`);
  });

  await test("GET /debug/whatsapp_batch_discarded respeta ADMIN_TOKEN incorrecto -> 401", async () => {
    const res = await fetch(`${BASE}/debug/whatsapp_batch_discarded`, { headers: { "x-admin-token": "token-incorrecto" } });
    assert.equal(res.status, 401);
  });

  await test("?limit= funciona en /debug/outbound_guard_blocks", async () => {
    for (let i = 0; i < 10; i++) {
      appendToCollection("outbound_guard_blocks", { id: `test-${i}`, phone: "+34600000900", created_at: new Date().toISOString() });
    }
    const res = await fetch(`${BASE}/debug/outbound_guard_blocks?limit=3`, { headers: { "x-admin-token": TOKEN } });
    const data = (await res.json()) as unknown[];
    assert.equal(data.length, 3);
  });

  await test("?phone= filtra /debug/outbound_guard_blocks por teléfono exacto", async () => {
    appendToCollection("outbound_guard_blocks", { id: "phone-match", phone: "+34611122233", created_at: new Date().toISOString() });
    const res = await fetch(`${BASE}/debug/outbound_guard_blocks?phone=%2B34611122233&limit=all`, { headers: { "x-admin-token": TOKEN } });
    const data = (await res.json()) as { phone?: string }[];
    assert.ok(data.length > 0 && data.every((r) => r.phone === "+34611122233"));
  });

  await test("/debug/reservation_confirm_attempts refleja intentos reales (ya probados en test-outbound-guard.ts)", async () => {
    appendToCollection("reservation_confirm_attempts", { id: "r1", reservation_id: "res-x", verified_by: "ramon", result: "confirmed", created_at: new Date().toISOString() });
    const res = await fetch(`${BASE}/debug/reservation_confirm_attempts?limit=all`, { headers: { "x-admin-token": TOKEN } });
    const data = (await res.json()) as { reservation_id: string }[];
    assert.ok(data.some((r) => r.reservation_id === "res-x"));
  });

  // ---- Paso 3: revalidación en el instante del envío ----

  const vehiculoReal = currentVehicles()[0];
  assert.ok(vehiculoReal, "el seed de catálogo de prueba necesita al menos un vehículo");

  await test("sendVehicleContactTemplateGuarded: vehículo SOLD ahora mismo -> bloqueado, nunca llega a zernio", async () => {
    setOfficialStatus(vehiculoReal.id, "SOLD", null);
    const result = await outboundGuard.sendVehicleContactTemplateGuarded("+34600000777", "Coche de prueba", vehiculoReal.id, "test_vehicle_sold");
    assert.equal(result.ok, false);
    assert.equal((result as { error?: string }).error, "vehicle_not_available_SOLD");
    setOfficialStatus(vehiculoReal.id, "AVAILABLE", null);
  });

  await test("sendVehicleContactTemplateGuarded: vehicle_id inexistente -> bloqueado", async () => {
    const result = await outboundGuard.sendVehicleContactTemplateGuarded("+34600000778", "Coche inventado", "id-que-no-existe-en-catalogo", "test_vehicle_missing");
    assert.equal(result.ok, false);
    assert.equal((result as { error?: string }).error, "vehicle_not_found_in_catalog");
  });

  await test("sendVehicleContactTemplateGuardedForReservation: reserva cancelada justo antes -> bloqueado", async () => {
    writeCollection("reservations", [
      { id: "res-cancelada", vehicle_id: vehiculoReal.id, lead_phone: "+34600000779", amount_eur: 300, status: "cancelled", payment_receipt_note: null, created_at: new Date().toISOString(), expires_at: new Date().toISOString(), verified_by: null, verified_at: null },
    ]);
    const result = await outboundGuard.sendVehicleContactTemplateGuardedForReservation("+34600000779", "Coche de prueba", "res-cancelada", "test_reservation_cancelled");
    assert.equal(result.ok, false);
    assert.equal((result as { error?: string }).error, "reservation_status_cancelled");
  });

  await test("sendVehicleContactTemplateGuardedForReservation: reserva SÍ confirmed -> intenta enviar (falla solo por falta de credenciales reales, no por el guard)", async () => {
    writeCollection("reservations", [
      { id: "res-confirmada", vehicle_id: vehiculoReal.id, lead_phone: "+34600000780", amount_eur: 300, status: "confirmed", payment_receipt_note: null, created_at: new Date().toISOString(), expires_at: new Date().toISOString(), verified_by: "ramon", verified_at: new Date().toISOString() },
    ]);
    const result = await outboundGuard.sendVehicleContactTemplateGuardedForReservation("+34600000780", "Coche de prueba", "res-confirmada", "test_reservation_confirmed");
    // Sin ZERNIO_API_KEY en el entorno de prueba, sendZernioWhatsappVehicleContactTemplate
    // devuelve {ok:false, error:"zernio_whatsapp_no_configurado"} -- nunca el motivo del
    // guard, que es justo lo que distingue "bloqueado por el guard" de "autorizado, pero
    // sin integración real".
    assert.equal(result.ok, false);
    assert.equal((result as { error?: string }).error, "zernio_whatsapp_no_configurado");
  });

  await test("verifyAppointmentActiveForTemplate: cita cancelada -> bloqueado", async () => {
    writeCollection("appointments", [{ id: "cita-cancelada", lead_phone: "+34600000781", vehicle_id: vehiculoReal.id, status: "cancelled", requested_date: new Date().toISOString().slice(0, 10), requested_time: "10:00", created_at: new Date().toISOString() }]);
    const check = outboundGuard.verifyAppointmentActiveForTemplate("cita-cancelada");
    assert.equal(check.ok, false);
    assert.equal((check as { motivo?: string }).motivo, "appointment_cancelled");
  });

  await test("verifyAppointmentActiveForTemplate: cita histórica (hace 3h) -> bloqueado", async () => {
    const hace3h = new Date(Date.now() - 3 * 3600_000);
    writeCollection("appointments", [{ id: "cita-vieja", lead_phone: "+34600000782", vehicle_id: vehiculoReal.id, status: "confirmed", requested_date: hace3h.toISOString().slice(0, 10), requested_time: `${String(hace3h.getHours()).padStart(2, "0")}:${String(hace3h.getMinutes()).padStart(2, "0")}`, created_at: new Date().toISOString() }]);
    const check = outboundGuard.verifyAppointmentActiveForTemplate("cita-vieja");
    assert.equal(check.ok, false);
    assert.ok((check as { motivo?: string }).motivo?.startsWith("appointment_historica_"));
  });

  await test("verifyAppointmentActiveForTemplate: cita activa y reciente -> autorizado", async () => {
    const enUnaHora = new Date(Date.now() + 3600_000);
    writeCollection("appointments", [{ id: "cita-activa", lead_phone: "+34600000783", vehicle_id: vehiculoReal.id, status: "confirmed", requested_date: enUnaHora.toISOString().slice(0, 10), requested_time: `${String(enUnaHora.getHours()).padStart(2, "0")}:${String(enUnaHora.getMinutes()).padStart(2, "0")}`, created_at: new Date().toISOString() }]);
    const check = outboundGuard.verifyAppointmentActiveForTemplate("cita-activa");
    assert.equal(check.ok, true);
  });

  await test("isAuthorizedTeamPhone: número del propio equipo (Ramón) -> true", async () => {
    const { getBusinessConfig } = await import("../src/data/business-config.js");
    const cfg = getBusinessConfig();
    if (cfg.ramonPhone) {
      assert.equal(outboundGuard.isAuthorizedTeamPhone(cfg.ramonPhone), true);
    } else {
      // Sin ramonPhone configurado en este DATA_DIR de prueba, comprobamos
      // igual que un número arbitrario de cliente nunca pasa.
      assert.equal(outboundGuard.isAuthorizedTeamPhone("+34699999999"), false);
    }
  });

  await test("isAuthorizedTeamPhone: número de un cliente cualquiera -> false (nunca un allowProactive genérico)", async () => {
    assert.equal(outboundGuard.isAuthorizedTeamPhone("+34611119999"), false);
  });

  await test("sendTeamAlertTemplateGuarded: destinatario que NO es del equipo -> bloqueado antes de tocar zernio", async () => {
    const result = await outboundGuard.sendTeamAlertTemplateGuarded("+34611119999", "texto de prueba", "test_no_team");
    assert.equal(result.ok, false);
    assert.equal((result as { error?: string }).error, "destinatario_no_es_equipo_configurado");
  });

  await test("Cada envío (autorizado o bloqueado) del Paso 3 queda auditado en outbound_guard_blocks (tipo plantilla_meta)", async () => {
    const all = readCollection<{ tipo?: string; template?: string }>("outbound_guard_blocks");
    const plantillas = all.filter((r) => r.tipo === "plantilla_meta");
    assert.ok(plantillas.length > 0, "deberían existir registros tipo=plantilla_meta de las pruebas anteriores");
    assert.ok(plantillas.some((r) => r.template === "vehicle_contact"));
    assert.ok(plantillas.some((r) => r.template === "team_alert"));
  });

  await test("Esas mismas plantillas son visibles vía /debug/outbound_guard_blocks (la ruta del Paso 2 las captura)", async () => {
    const res = await fetch(`${BASE}/debug/outbound_guard_blocks?limit=all`, { headers: { "x-admin-token": TOKEN } });
    const data = (await res.json()) as { tipo?: string }[];
    assert.ok(data.some((r) => r.tipo === "plantilla_meta"));
  });

  const total = results.length;
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${total} pruebas superadas.`);
  process.exit(ok === total ? 0 : 1);
}

main().catch((err) => {
  console.error("Fallo general ejecutando las pruebas:", err);
  process.exit(1);
});
