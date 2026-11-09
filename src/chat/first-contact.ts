import { readCollection, writeCollection } from "../store.js";

// Primer contacto con leads de portal SIN IA: texto fijo, solo variables
// verificadas del aviso del portal (nombre, vehículo, portal). Nunca se
// inventan datos del coche. Un único primer contacto por teléfono+vehículo.

export type FirstContactInput = {
  leadId: string;
  phone: string;
  name: string | null;
  vehicle: string | null;
  portal: "Coches.net" | "Wallapop" | string;
};

type SentRecord = { key: string; lead_id: string; phone: string; portal: string; vehicle: string | null; at: string };
const COLLECTION = "first_contact_sent";

function cleanName(name: string | null): string | null {
  const n = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ'-]{2,30}$/.test(n) ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : null;
}

export function buildFirstContactText(input: FirstContactInput): string {
  const nombre = cleanName(input.name);
  const saludo = nombre ? `Hola ${nombre}` : "Hola";
  const vehiculo = input.vehicle?.trim() ? `el ${input.vehicle.trim()}` : "el vehículo que consultaste";
  return `${saludo}, soy Carolina, de Automóviles Lucero. Hemos recibido tu consulta en ${input.portal} sobre ${vehiculo}. ¿Qué día y hora te vendría bien para venir a verlo? Si prefieres, te resuelvo cualquier duda por aquí.`;
}

function dedupKey(phone: string, vehicle: string | null): string {
  return `${phone}|${(vehicle ?? "").trim().toLowerCase()}`;
}

export function alreadyContacted(phone: string, vehicle: string | null): boolean {
  const key = dedupKey(phone, vehicle);
  return readCollection<SentRecord>(COLLECTION).some((r) => r.key === key);
}

export function markContacted(input: FirstContactInput): void {
  const all = readCollection<SentRecord>(COLLECTION);
  all.push({ key: dedupKey(input.phone, input.vehicle), lead_id: input.leadId, phone: input.phone, portal: input.portal, vehicle: input.vehicle, at: new Date().toISOString() });
  writeCollection(COLLECTION, all.slice(-5000));
}
