import { readCollection } from "../store.js";
import { normalizePhone } from "./conversion.js";

// Ventana de atención de WhatsApp (Meta): solo se puede responder con texto
// libre dentro de las 24h desde el ÚLTIMO MENSAJE ENTRANTE del cliente.
// Antes se usaba updated_at de la conversación, que también se mueve cuando
// contestamos nosotros: eso daba una ventana más larga de la real y hacía
// intentar envíos que Meta rechaza.
//
// Fuente de verdad: whatsapp_inbox, donde cada mensaje entrante real queda
// con su created_at. Se cruza con el mapa de conversaciones de Zernio solo
// como respaldo, nunca al revés.

const VENTANA_HORAS = 24;
// Margen de seguridad: no intentar un envío que caduca mientras va de camino.
const MARGEN_HORAS = 1;

type InboxRecord = { phone?: string | null; created_at?: string };
type ConversationMapping = { phone: string; updated_at: string };

// Momento (ms) del último mensaje entrante real del cliente, o null si no
// consta ninguno.
export function lastInboundAt(contact: string): number | null {
  const key = normalizePhone(contact);
  if (!key) return null;
  let ultimo = 0;
  for (const m of readCollection<InboxRecord>("whatsapp_inbox")) {
    if (normalizePhone(m.phone) !== key) continue;
    const t = new Date(m.created_at ?? 0).getTime();
    if (Number.isFinite(t) && t > ultimo) ultimo = t;
  }
  if (ultimo > 0) return ultimo;
  // Respaldo: el mapa de Zernio. Menos preciso (se actualiza al guardar la
  // conversación), así que solo se usa cuando no hay ningún entrante registrado.
  const conv = readCollection<ConversationMapping>("zernio_whatsapp_conversations").find((c) => normalizePhone(c.phone) === key);
  const t = conv ? new Date(conv.updated_at).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

export function horasDesdeUltimoEntrante(contact: string, now = Date.now()): number | null {
  const at = lastInboundAt(contact);
  return at === null ? null : (now - at) / 3600_000;
}

// true solo si de verdad se puede mandar texto libre ahora mismo.
export function dentroDeVentana(contact: string, now = Date.now()): boolean {
  const horas = horasDesdeUltimoEntrante(contact, now);
  return horas !== null && horas < VENTANA_HORAS - MARGEN_HORAS;
}

// PUNTO 10: autorización real del contacto antes de cualquier envío
// proactivo. No basta con que la plantilla esté aprobada: el contacto puede
// haber pedido no recibir mensajes.
type Lead = { phone?: string | null; do_not_contact?: boolean; preferred_channel?: string | null };

export function contactoAutorizado(contact: string): { ok: boolean; motivo?: string } {
  const key = normalizePhone(contact);
  if (!key) return { ok: false, motivo: "telefono_no_valido" };
  const lead = readCollection<Lead>("leads").find((l) => normalizePhone(l.phone) === key);
  if (lead?.do_not_contact) return { ok: false, motivo: "do_not_contact" };
  if (lead?.preferred_channel && lead.preferred_channel !== "WHATSAPP") return { ok: false, motivo: `prefiere_${lead.preferred_channel}` };
  return { ok: true };
}
