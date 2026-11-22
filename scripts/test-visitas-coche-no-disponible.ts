// Uso: DATA_DIR=/tmp/lucero-test-$$ npx tsx scripts/test-visitas-coche-no-disponible.ts
// Regla 23/11/2026: sin visitas de coches que ya no están en el stock.
import path from "path";
if (!process.env.DATA_DIR || process.env.DATA_DIR.includes(path.join("automoviles-lucero", "data"))) {
  console.error("Niega ejecutar sin una DATA_DIR de prueba explícita y distinta de la de producción.");
  process.exit(1);
}
const { writeCollection, readCollection } = await import("../src/store.js");
const { createAppointmentWithCalendar, closeAppointmentsForUnavailableVehicles } = await import("../src/tools/appointments.js");
const { vehiclesSeed } = await import("../src/data/vehicles-seed.js");
const { setOfficialStatus } = await import("../src/tools/vehicle-state.js");

let ok = 0, total = 0;
const check = (n: string, c: boolean) => { total++; if (c) { ok++; console.log("  ✓", n); } else console.log("  ✗ FALLA:", n); };
const R = (x: unknown) => x as { status: string; error_code?: string; data?: any };

writeCollection("appointments", []); writeCollection("tasks", []); writeCollection("vehicle_state", []); writeCollection("leads", []);

const real = vehiclesSeed[0];
const r1 = R(await createAppointmentWithCalendar({ lead_phone: "+34600000901", lead_name: "Marta Gómez", vehicle_id: "lucero-dealcar-id-viejo-que-ya-no-existe", requested_date: "2030-01-15", requested_time: "10:30", channel: "WHATSAPP" } as any));
check("coche que ya no está en el stock -> denied vehicle_not_available", r1.status === "denied" && r1.error_code === "vehicle_not_available");
check("...con el enlace del portal y la orden de volver a buscarlo", !!r1.data?.portal_url && String(r1.data?.message).includes("search_vehicles"));
check("...y no se crea ninguna visita ni ficha", readCollection("appointments").length === 0 && readCollection("leads").length === 0);

const r2 = R(await createAppointmentWithCalendar({ lead_phone: "+34600000902", lead_name: "Juan Pérez", vehicle_id: real.id, requested_date: "2030-01-15", requested_time: "10:30", channel: "WHATSAPP" } as any));
check("coche que sí está en el stock -> se agenda", r2.status === "ok");

setOfficialStatus(vehiclesSeed[1].id, "SOLD", null);
const r3 = R(await createAppointmentWithCalendar({ lead_phone: "+34600000903", lead_name: "Ana Ruiz", vehicle_id: vehiclesSeed[1].id, requested_date: "2030-01-15", requested_time: "11:30", channel: "WHATSAPP" } as any));
check("coche marcado como vendido -> denied", r3.status === "denied" && r3.error_code === "vehicle_not_available");

const r4 = R(await createAppointmentWithCalendar({ lead_phone: "+34600000904", lead_name: "Luis Mora", requested_date: "2030-01-16", requested_time: "10:30", channel: "WHATSAPP" } as any));
check("visita sin coche concreto sigue permitida", r4.status === "ok");

// cierre silencioso de las existentes
const base = readCollection<any>("appointments");
writeCollection("appointments", [
  ...base,
  { id: "v-hoy", lead_phone: "+34600000911", vehicle_id: "id-viejo-1", status: "confirmed", requested_date: "2026-11-23", requested_time: "09:30", created_at: "x" },
  { id: "v-fut", lead_phone: "+34600000912", vehicle_id: "id-viejo-2", status: "requested", requested_date: "2026-11-30", created_at: "x" },
  { id: "v-pas", lead_phone: "+34600000913", vehicle_id: "id-viejo-3", status: "confirmed", requested_date: "2026-10-30", created_at: "x" },
]);
const seco = await closeAppointmentsForUnavailableVehicles({ dryRun: true, today: "2026-11-23" });
check("en seco: lista 2 visitas (hoy y futura), 1 pasada sin tocar, no cambia nada", seco.visitas_a_cerrar.length === 2 && seco.pasadas_sin_tocar === 1 && readCollection<any>("appointments").find((a) => a.id === "v-hoy").status === "confirmed");
await closeAppointmentsForUnavailableVehicles({ dryRun: false, today: "2026-11-23" });
const tras = readCollection<any>("appointments");
check("aplicado: hoy y futura quedan canceladas con motivo", tras.find((a) => a.id === "v-hoy").status === "cancelled" && tras.find((a) => a.id === "v-fut").cancel_reason?.includes("coche_ya_no_disponible"));
check("...la pasada y la del coche que sí está NO se tocan", tras.find((a) => a.id === "v-pas").status === "confirmed" && tras.filter((a) => a.vehicle_id === real.id)[0].status !== "cancelled");
const tareas = readCollection<any>("tasks").filter((t) => String(t.source_ref).startsWith("coche_no_disponible:"));
check("...y quedan 2 tareas 'llamar' prioridad alta para el equipo", tareas.length === 2 && tareas.every((t) => t.type === "llamar" && t.priority === "alta"));
console.log(`\n${ok}/${total} pruebas superadas.`);
process.exit(ok === total ? 0 : 1);
