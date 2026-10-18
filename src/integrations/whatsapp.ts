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

const GRAPH_VERSION = "v21.0";

export function isWhatsappConnected(): boolean {
  return isZernioWhatsappConfigured() || Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

function normalizePhone(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

export type WhatsappSendResult = { ok: true; messageId: string } | { ok: false; error: string };

export async function sendWhatsappText(to: string, body: string): Promise<WhatsappSendResult> {
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
