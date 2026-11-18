// Envío real por WhatsApp. Dos backends posibles, elegidos automáticamente
// sin tocar quien llama a sendWhatsappText/isWhatsappConnected (delivery.ts,
// server.ts):
//
// 1) Zernio (ZERNIO_API_KEY + ZERNIO_WHATSAPP_ACCOUNT_ID puestos): mismo
//    número de WhatsApp Business, pero conectado vía Embedded Signup de
//    Zernio -- evita el proceso de verificación de negocio de Meta.
// 2) WhatsApp Cloud API directa (WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID):
//    integración original, se mantiene por si algún día se conecta directo.
//
// Mismo patrón honesto en los dos casos: si no hay credenciales no se
// intenta nada, y si la API devuelve error (p. ej. más de 24h desde el
// último mensaje del cliente, o -- en Zernio -- no hay conversación abierta
// y haría falta una plantilla) se propaga el error tal cual, nunca se
// asume entregado.
import { isZernioWhatsappConfigured, sendZernioWhatsappText } from "./zernio.js";
import { authorizeOutboundMessage } from "../outbound-guard.js";
import { lastInboundAt as lastWhatsappInboundAt } from "../chat/whatsapp-window.js";

const GRAPH_VERSION = "v21.0";

export function isWhatsappConnected(): boolean {
  return isZernioWhatsappConfigured() || Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

function normalizePhone(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

export type WhatsappSendResult = { ok: true; messageId: string } | { ok: false; error: string };

// Opciones de autorización de la barrera central (src/outbound-guard.ts).
// Por defecto (sin pasar nada) se resuelve automáticamente el último
// mensaje ENTRANTE real de WhatsApp de ese contacto -- así cualquier
// llamador que no toque este parámetro queda protegido igual, sin tener que
// acordarse de añadirlo en cada sitio. Solo las llamadas ya identificadas
// como excepción real (recordatorio de cita, confirmación de reserva, aviso
// urgente al equipo) deben pasar allowProactive:true explícitamente, en su
// propio call site -- nunca aquí.
export type OutboundAuthz = { allowProactive?: boolean; lastInboundAt?: number | null; reason?: string };

export async function sendWhatsappText(to: string, body: string, authz: OutboundAuthz = {}): Promise<WhatsappSendResult> {
  const lastInboundAt = authz.lastInboundAt !== undefined ? authz.lastInboundAt : lastWhatsappInboundAt(to);
  const auth = authorizeOutboundMessage({
    phone: to,
    channel: "whatsapp",
    lastInboundAt,
    reason: authz.reason ?? "sendWhatsappText_default",
    allowProactive: authz.allowProactive,
  });
  if (!auth.ok) return { ok: false, error: `bloqueado_outbound_guard:${auth.motivo}` };

  if (isZernioWhatsappConfigured()) return sendZernioWhatsappText(to, body);

  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return { ok: false, error: "whatsapp_not_connected" };

  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: normalizePhone(to),
        type: "text",
        text: { body },
      }),
    });
    const data = (await res.json()) as { messages?: { id: string }[]; error?: { message?: string; code?: number } };
    if (!res.ok || !data.messages?.[0]?.id) {
      return { ok: false, error: data.error?.message ?? `whatsapp_api_${res.status}` };
    }
    return { ok: true, messageId: data.messages[0].id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "whatsapp_network_error" };
  }
}

// Traduce el error real de un envío fallido a una frase que Ramón/José
// entiendan sin saber qué es Zernio o "Direct Send" -- nunca oculta la
// causa real (aviso real confuso detectado 27/10/2026: un aviso urgente
// mostraba tal cual "DIRECT_SEND_NOT_ELIGIBLE: Direct Send is not enabled
// for this WhatsApp account. Use an approved message template instead.").
// Si el error no es ninguno de los conocidos, se muestra tal cual --
// mejor un texto técnico que ocultar algo nuevo que convenga saber.
export function explainWhatsappSendError(error: string): string {
  if (error.includes("DIRECT_SEND_NOT_ELIGIBLE")) {
    return "Meta todavía no permite que este número inicie conversaciones nuevas sin plantilla aprobada (la cuenta no está habilitada para 'Direct Send')";
  }
  if (error === "whatsapp_not_connected" || error === "zernio_whatsapp_no_configurado") {
    return "el número de WhatsApp del negocio no está conectado";
  }
  if (error.startsWith("zernio_direct_send_rechazado")) {
    return `Meta rechazó iniciar la conversación (${error.replace(/^zernio_direct_send_rechazado:\s*/, "")})`;
  }
  return error;
}
