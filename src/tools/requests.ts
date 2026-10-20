import { appendToCollection, readCollection } from "../store.js";
import { envelope } from "../response.js";
import { raiseAlert } from "../alerts/alerts.js";
import { currentVehicles } from "../data/vehicles-current.js";
import { createReservationPending } from "./reservations.js";

function now() {
  return new Date().toISOString();
}

function normalizeText(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

// Auto-crea la reserva real a partir de "reason_type:reserva" (18/10/2026,
// "es una automatizacion, no nada para hacer a mano" -- causa real
// confirmada en producción: varios clientes de chat/correo/WhatsApp
// confirmaron que querían reservar y solo quedó el aviso, nunca la reserva
// de verdad, porque nadie -- ni el agente, ni una persona -- llamaba
// después a create_reservation_pending). Vive aquí, no en n8n ni en un
// canal concreto, porque las tres vías (voz, chat, WhatsApp, correo)
// pasan todas por este mismo create_handoff -- es el único sitio que las
// cubre todas a la vez sin duplicar lógica por canal.
//
// Solo actúa cuando está seguro: el coche tiene que identificarse con una
// coincidencia única contra el catálogo real a partir de lo que ya tenía
// guardado el propio lead (vehicle_interest) -- nunca inventa ni adivina
// un vehicle_id. Si hay cero o varias coincidencias, no hace nada y el
// aviso humano sigue su curso normal (de ahí puede resolverse a mano).
// Tampoco duplica: si ya hay una reserva viva para ese mismo coche y
// contacto, no crea otra.
export async function tryAutoCreateReservation(leadPhone: string, vehicleInterest: string | null | undefined, channel?: string | null): Promise<void> {
  try {
    if (!vehicleInterest || !vehicleInterest.trim()) return;
    const wanted = normalizeText(vehicleInterest);
    const matches = currentVehicles().filter((v) => {
      const full = normalizeText(`${v.make} ${v.model} ${v.version}`);
      return full.includes(wanted) || wanted.includes(full);
    });
    if (matches.length !== 1) return; // ambiguo o sin match -- no se adivina
    const vehicleId = matches[0].id;

    const existing = readCollection<{ vehicle_id: string; lead_phone: string | null; status: string }>("reservations");
    const alreadyPending = existing.some(
      (r) => r.vehicle_id === vehicleId && r.lead_phone === leadPhone && (r.status === "pending_payment" || r.status === "pending_verification" || r.status === "confirmed"),
    );
    if (alreadyPending) return; // ya está, no duplicar

    await createReservationPending({ vehicle_id: vehicleId, lead_phone: leadPhone, channel: channel ?? undefined });
  } catch (err) {
    // Nunca debe romper la creación del aviso -- si esto falla, el aviso
    // humano ya quedó registrado de todas formas y el equipo lo resuelve.
    console.error("[requests] no se pudo auto-crear la reserva desde el aviso:", err instanceof Error ? err.message : err);
  }
}

// create_purchase_request: registra una solicitud de tasación (Sección 11).
// NUNCA calcula ni promete un valor, oferta, recogida gratuita o pago
// inmediato -- solo deja constancia para que el equipo lo revise.
export function createPurchaseRequest(args: {
  lead_phone?: string;
  make?: string;
  model?: string;
  year?: number;
  km?: number;
  condition?: string;
  known_issues?: string;
  expected_price_eur?: number;
  trade_in_vehicle_id?: string;
}) {
  const request = {
    id: crypto.randomUUID(),
    type: "purchase_request" as const,
    ...args,
    status: "pending_review",
    created_at: now(),
  };
  appendToCollection("purchase_requests", request);
  return envelope({ status: "ok", data: request, source: "registro interno", source_updated_at: now() });
}

// create_vehicle_valuation es el mismo flujo (Sección 34/43 usa este nombre
// para el tool de Retell) -- misma tabla purchase_requests, sin tasación
// automática nunca.
export const createVehicleValuation = createPurchaseRequest;

// create_service_request: registra un trámite o incidencia (Sección 12/14).
// No incluye precio -- el importe de trámites sigue sin aprobar (23/09/2026).
export function createServiceRequest(args: { lead_phone?: string; procedure_type?: string; notes?: string }) {
  const request = {
    id: crypto.randomUUID(),
    type: "service_request" as const,
    ...args,
    status: "pending_review",
    created_at: now(),
  };
  appendToCollection("service_requests", request);
  return envelope({ status: "ok", data: request, source: "registro interno", source_updated_at: now() });
}

// create_handoff: solicitud de atención humana o devolución de llamada
// (Sección 14). No hay transferencia en vivo conectada todavía (números y
// responsables pendientes de confirmar, Sección 23) -- por eso esto solo
// registra la petición en vez de intentar transferir la llamada.
export async function createHandoff(args: {
  lead_phone?: string;
  reason?: string;
  urgency?: "normal" | "alta";
  notes?: string;
  // 13/10/2026: para que una reserva quede notificada de forma visible y
  // distinta de cualquier otro aviso urgente (no mezclada en un "Urgente"
  // genérico) -- ver Sección "el agente debería dejar notificada la
  // reserva para que se pueda ver".
  reason_type?: "reserva" | "compra_inmediata" | "otro";
  // Canal de origen (20/10/2026) -- inyectado por handleChatMessage/markVoiceOrigin,
  // nunca lo manda el modelo por su cuenta. Se guarda en el propio handoff
  // (vía el spread de abajo) y se hereda a la reserva automática si aplica.
  channel?: string;
}) {
  // El nombre nunca lo manda quien llama a create_handoff -- se recupera del
  // lead ya guardado por su teléfono (FALLO REAL detectado 13/10/2026: un
  // aviso real -- Ángel, Nissan Qashqai -- se quedó sin nombre en la ficha
  // porque create_handoff nunca lo guardaba, aunque create_lead sí lo tenía
  // bien registrado un segundo antes en la misma llamada).
  const lead = readCollection<{ phone: string | null; name: string | null; vehicle_interest?: string | null }>("leads").find((l) => l.phone === args.lead_phone);
  const handoff = {
    id: crypto.randomUUID(),
    ...args,
    lead_name: lead?.name ?? null,
    status: "requested",
    created_at: now(),
  };
  appendToCollection("handoffs", handoff);
  // Una derivación urgente (reserva de 500 € o compra inmediata) avisa a Ramón y José.
  if (args.urgency === "alta") {
    raiseAlert({
      kind: args.reason_type === "reserva" ? "reserva_pendiente" : "handoff_urgente",
      lead_phone: args.lead_phone ?? null,
      name: lead?.name ?? null,
      reason: args.reason ?? "Atención urgente",
    });
  }
  if (args.reason_type === "reserva" && args.lead_phone) {
    await tryAutoCreateReservation(args.lead_phone, lead?.vehicle_interest, args.channel);
  }
  return envelope({
    status: "ok",
    data: handoff,
    source: "registro interno",
    source_updated_at: now(),
    conflicts: ["No hay transferencia en vivo configurada todavía -- esto queda como solicitud pendiente, no como llamada transferida."],
  });
}
