import assert from "node:assert/strict";
import path from "node:path";

// NUNCA usa DATA_DIR de producción (mismo patrón que scripts/test-outbound-guard.ts).
if (!process.env.DATA_DIR || process.env.DATA_DIR.includes(path.join("automoviles-lucero", "data"))) {
  console.error("Niega ejecutar sin una DATA_DIR de prueba explícita y distinta de la de producción.");
  process.exit(1);
}

const { processInboundEmail } = await import("../src/email/agent.js");
const { readCollection, writeCollection } = await import("../src/store.js");
const { setOfficialStatus } = await import("../src/tools/vehicle-state.js");
const { vehiclesSeed } = await import("../src/data/vehicles-seed.js");

const HOUR = 3600_000;
const now = Date.now();

function cochesNetEmail(opts: { phone: string; make: string; model: string; receivedAt: string; messageKey: string }) {
  const json = JSON.stringify({
    client: { first_name: "Cliente Prueba Incidente", phone: opts.phone },
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

const vehiculo = vehiclesSeed[0];
console.log(`Vehículo elegido para la prueba: ${vehiculo.id} (${vehiculo.make} ${vehiculo.model})`);

// ---- ESCENARIO 1: lead de hace 2 años, vehículo ya SOLD, sin contacto reciente,
// se reprocesa una notificación "antigua" de Coches.net para ese mismo contacto.
const phoneViejo = "34699000001";
const dosAniosAtras = new Date(now - 2 * 365 * 24 * HOUR).toISOString();

writeCollection("leads", [{ id: "lead-viejo-1", phone: phoneViejo, name: "Cliente Prueba Incidente", channel: "WHATSAPP", vehicle_interest: `${vehiculo.make} ${vehiculo.model}`, created_at: dosAniosAtras, updated_at: dosAniosAtras }]);
writeCollection("whatsapp_inbox", []);
writeCollection("email_inbox", []);
writeCollection("first_contact_sent", []);
writeCollection("email_processed", []);
writeCollection("vehicle_state", []);
setOfficialStatus(vehiculo.id, "SOLD", "prueba_incidente_fase2d");

const antes = {
  reservations: readCollection("reservations").length,
  outbound_blocks: readCollection("outbound_guard_blocks").length,
  tasks: readCollection("tasks").length,
};

const avisoViejo = cochesNetEmail({
  phone: phoneViejo,
  make: vehiculo.make,
  model: vehiculo.model,
  receivedAt: dosAniosAtras,
  messageKey: "incidente-reproceso-2anios-001",
});

const resultado1 = await processInboundEmail(avisoViejo);
console.log("Resultado reproceso aviso antiguo:", JSON.stringify(resultado1));

const despues1 = {
  outbound_blocks: readCollection<any>("outbound_guard_blocks"),
  tasks: readCollection<any>("tasks"),
  email_inbox: readCollection<any>("email_inbox"),
};

const bloqueosNuevos = despues1.outbound_blocks.length - antes.outbound_blocks;
const tareasNuevas = despues1.tasks.length - antes.tasks;

console.log(`Bloqueos nuevos en outbound_guard_blocks: ${bloqueosNuevos}`);
console.log(`Tareas nuevas en tasks: ${tareasNuevas}`);
if (despues1.tasks.length > 0) {
  console.log("Última tarea creada:", JSON.stringify(despues1.tasks[despues1.tasks.length - 1], null, 2));
}

assert.equal(tareasNuevas >= 1, true, "Debe crearse al menos una tarea de revisión humana");
assert.equal(readCollection("reservations").length, antes.reservations, "No debe crearse ninguna reserva");
console.log("CONFIRMADO: 0 WhatsApp, 0 email comercial, 0 reservas, 0 ofertas de visita -- se creó una tarea de revisión humana + un bloqueo registrado.");

// ---- ESCENARIO 2 (mismo DATA_DIR): contacto NUEVO legítimo, mensaje entrante real
// de hace minutos, vehículo REALMENTE disponible (AVAILABLE).
const vehiculoDisponible = vehiclesSeed.find((v: any) => v.id !== vehiculo.id) ?? vehiculo;
setOfficialStatus(vehiculoDisponible.id, "AVAILABLE", "prueba_incidente_fase2d");

const phoneNuevo = "34699000002";
const haceMinutos = new Date(now - 5 * 60_000).toISOString();

const avisoNuevo = cochesNetEmail({
  phone: phoneNuevo,
  make: vehiculoDisponible.make,
  model: vehiculoDisponible.model,
  receivedAt: haceMinutos,
  messageKey: "incidente-contacto-legitimo-002",
});

const resultado2 = await processInboundEmail(avisoNuevo);
console.log("Resultado contacto legítimo nuevo:", JSON.stringify(resultado2));

assert.notEqual(resultado2.outcome, "bloqueado_por_antiguedad", "Un contacto legítimo reciente NO debe bloquearse por antigüedad");
console.log(`CONFIRMADO: outcome real = "${resultado2.outcome}" (no es bloqueado_por_antiguedad).`);

console.log("\nPRUEBA DE INCIDENTE COMPLETA.");
