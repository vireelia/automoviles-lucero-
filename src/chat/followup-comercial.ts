import crypto from "crypto";
import { readCollection, writeCollection } from "../store.js";
import { sendWhatsappText, isWhatsappConnected } from "../integrations/whatsapp.js";
import { conversationStage, appointmentsFor, normalizePhone, esComercial } from "./conversion.js";
import { lastInboundAt, contactoAutorizado } from "./whatsapp-window.js";

// LUCERO_SEGUIMIENTO_COMERCIAL. Reemplaza a checkStaleFollowups, que Eliud
// desactivó el 28/10/2026 ("elimínalos por ahora") porque escribía "nos han
// entrado coches nuevos" a CUALQUIER lead inactivo, hubiera comprado o no.
// Diferencias reales: solo clientes con intención comercial comprobada, como
// máximo 2 seguimientos, texto fijo sin IA, y nunca si ya hay visita o
// reserva. Apagado salvo LUCERO_FOLLOWUP_ENABLED=1.

type Seguimiento = {
  id: string;
  phone: string;
  intento: number; // 1 o 2
  enviado_at: string;
  vehiculo: string | null;
};

type Conversacion = { id: string; messages: { role: string; content: string | null }[]; updated_at: string };
type Lead = { phone?: string | null; name?: string | null; vehicle_interest?: string | null; do_not_contact?: boolean };

const COLLECTION = "followups_comerciales";
// Primer seguimiento a las 4h, segundo a las 24h del último mensaje real.
const HORAS = [4, 24];
export const MAX_SEGUIMIENTOS = HORAS.length;
// WhatsApp solo deja texto libre dentro de las 24h del último mensaje del
// cliente. sendWhatsappText ya lo rechaza por su cuenta, pero no tiene
// sentido ni intentarlo pasado ese punto.
const VENTANA_WHATSAPP_HORAS = 23;

function esEnabled(): boolean {
  return process.env.LUCERO_FOLLOWUP_ENABLED === "1";
}

function textoSeguimiento(nombre: string | null, vehiculo: string | null, intento: number): string {
  const saludo = nombre ? `Hola ${nombre}` : "Hola";
  const coche = vehiculo?.trim() ? `el ${vehiculo.trim()}` : "el vehículo que te interesaba";
  if (intento === 1) {
    return `${saludo}, soy Carolina, de Automóviles Lucero. Me quedé a la espera de tu respuesta sobre ${coche}. ¿Quieres que te reserve un hueco para verlo?`;
  }
  return `${saludo}, te escribo por última vez desde Automóviles Lucero sobre ${coche}. Si sigues interesado, dime y organizamos la visita. Si no, no te molesto más.`;
}

// El último mensaje de la conversación es del agente, es decir, el cliente
// dejó de responder. Si el último es del cliente, está esperándonos a
// nosotros y eso no es un seguimiento, es una respuesta pendiente.
function clienteDejoDeResponder(c: Conversacion): boolean {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const r = c.messages[i].role;
    if (r === "assistant") return true;
    if (r === "user") return false;
  }
  return false;
}

export async function runSeguimientoComercial(now = Date.now()): Promise<{ enviados: number; saltados: string[] }> {
  const saltados: string[] = [];
  if (!esEnabled()) return { enviados: 0, saltados: ["desactivado"] };
  if (!isWhatsappConnected()) return { enviados: 0, saltados: ["whatsapp_no_conectado"] };

  const convs = readCollection<Conversacion>("chat_conversations");
  const leads = readCollection<Lead>("leads");
  const previos = readCollection<Seguimiento>(COLLECTION);
  let enviados = 0;

  for (const c of convs) {
    const phone = c.id;
    if (phone.includes("@") || phone.startsWith("mail:")) continue; // el seguimiento es solo por WhatsApp
    // La ventana se mide desde el último mensaje ENTRANTE real del cliente
    // (updated_at también se movía al contestar nosotros, lo que daba una
    // ventana más larga de la real y provocaba envíos que Meta rechaza).
    const entrante = lastInboundAt(phone);
    if (entrante === null) continue; // sin ningún mensaje real suyo, no hay ventana que usar
    const horas = (now - entrante) / 3600_000;
    if (horas > VENTANA_WHATSAPP_HORAS) continue; // fuera de la ventana de WhatsApp
    if (!clienteDejoDeResponder(c)) continue;
    const auth = contactoAutorizado(phone);
    if (!auth.ok) {
      saltados.push(`${phone}: ${auth.motivo}`);
      continue;
    }

    const hechos = previos.filter((p) => normalizePhone(p.phone) === normalizePhone(phone));
    if (hechos.length >= MAX_SEGUIMIENTOS) continue;
    const intento = hechos.length + 1;
    if (horas < HORAS[intento - 1]) continue;
    // Nunca dos seguimientos sin que el cliente haya vuelto a escribir en medio.
    if (hechos.some((p) => new Date(p.enviado_at).getTime() >= new Date(c.updated_at).getTime())) continue;

    const lead = leads.find((l) => normalizePhone(l.phone) === normalizePhone(phone));
    // Solo si hay intención comercial de verdad, y nunca si ya hay cita o reserva.
    const stage = conversationStage(phone, "", c.messages);
    if (!esComercial(stage)) {
      saltados.push(`${phone}: ${stage}`);
      continue;
    }
    if (stage !== "INTERES_DETECTADO" || appointmentsFor(phone).length > 0) {
      saltados.push(`${phone}: ya_en_curso_${stage}`);
      continue;
    }

    const texto = textoSeguimiento(lead?.name ?? null, lead?.vehicle_interest ?? null, intento);
    const sent = await sendWhatsappText(phone, texto);
    if (!sent.ok) {
      saltados.push(`${phone}: envio_fallido_${sent.error}`);
      continue;
    }
    previos.push({ id: crypto.randomUUID(), phone, intento, enviado_at: new Date(now).toISOString(), vehiculo: lead?.vehicle_interest ?? null });
    writeCollection(COLLECTION, previos.slice(-5000));
    enviados++;
  }
  return { enviados, saltados };
}

export function listSeguimientos(): Seguimiento[] {
  return readCollection<Seguimiento>(COLLECTION);
}
