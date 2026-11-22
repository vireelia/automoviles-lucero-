import { envelope } from "../response.js";
import { isRealName, knownRealName } from "./leads.js";

// Regla del dueño (22/11/2026, "te dije que no subas ningún cliente sin
// nombre al sistema"): una cita o una reserva solo se registra si se conoce
// el nombre real del cliente -- porque lo dijo en esta conversación
// (lead_name) o porque ya consta en su ficha. Si no, la herramienta se
// niega y le dice al agente que se lo pregunte, en vez de dejar una visita
// o reserva "Sin nombre" en el CRM.
export function resolveClientName(args: { lead_phone?: string; lead_name?: string }): string | null {
  if (isRealName(args.lead_name)) return args.lead_name!.trim();
  return knownRealName(args.lead_phone);
}

export function nameRequiredEnvelope() {
  return envelope({
    status: "denied",
    error_code: "name_required",
    data: {
      message:
        "No se puede registrar todavía: falta el nombre del cliente. Pregúntale cómo se llama (nombre real, nunca inventado ni 'cliente') y vuelve a llamar a esta herramienta con lead_name. Mientras no lo diga, no confirmes la cita ni la reserva.",
    },
    source: "regla del negocio 22/11/2026: no se registra ningún cliente sin nombre",
  });
}

export function withRequiredName<A extends { lead_phone?: string; lead_name?: string }, R>(fn: (a: A) => R | Promise<R>) {
  return async (a: A) => {
    const name = resolveClientName(a);
    if (!name) return nameRequiredEnvelope();
    return fn({ ...a, lead_name: name });
  };
}
