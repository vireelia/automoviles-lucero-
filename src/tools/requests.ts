import { appendToCollection } from "../store.js";
import { envelope } from "../response.js";

function now() {
  return new Date().toISOString();
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
export function createHandoff(args: { lead_phone?: string; reason?: string; urgency?: "normal" | "alta"; notes?: string }) {
  const handoff = {
    id: crypto.randomUUID(),
    ...args,
    status: "requested",
    created_at: now(),
  };
  appendToCollection("handoffs", handoff);
  return envelope({
    status: "ok",
    data: handoff,
    source: "registro interno",
    source_updated_at: now(),
    conflicts: ["No hay transferencia en vivo configurada todavía -- esto queda como solicitud pendiente, no como llamada transferida."],
  });
}
