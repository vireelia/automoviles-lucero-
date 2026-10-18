// Integración con Zernio (https://zernio.com): API unificada de mensajería
// y publicación en redes. Aquí cubrimos dos usos reales del negocio:
//
// 1) WhatsApp Business sin pasar por la verificación de negocio de Meta
//    (Embedded Signup de Zernio) -- sustituye a integrations/whatsapp.ts
//    cuando ZERNIO_API_KEY + ZERNIO_WHATSAPP_ACCOUNT_ID están puestos.
// 2) Publicar en redes el contenido que genera el Studio (ver crm/app.ts).
//
// Mismo patrón honesto que el resto de integraciones: sin credenciales no
// se intenta nada, y un error de la API nunca se traduce en "enviado".
import { Zernio } from "@zernio/node";
import crypto from "crypto";
import { readCollection, writeCollection } from "../store.js";

let client: Zernio | null = null;

function getClient(): Zernio | null {
  if (!process.env.ZERNIO_API_KEY) return null;
  if (!client) client = new Zernio({ apiKey: process.env.ZERNIO_API_KEY });
  return client;
}

export function isZernioConnected(): boolean {
  return Boolean(process.env.ZERNIO_API_KEY);
}

// ---------- Publicación en redes (Studio) ----------

export type ZernioAccount = { id: string; platform: string; [key: string]: unknown };

export async function listZernioAccounts(): Promise<
  { ok: true; accounts: ZernioAccount[] } | { ok: false; error: string }
> {
  const zernio = getClient();
  if (!zernio) return { ok: false, error: "zernio_no_configurado" };
  try {
    const { data } = await zernio.accounts.listAccounts();
    return { ok: true, accounts: (data?.accounts ?? data ?? []) as ZernioAccount[] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type PublishPostInput = {
  content: string;
  mediaUrls?: string[];
  platforms: { platform: string; accountId: string }[];
  scheduledFor?: string; // ISO; si se omite y publishNow no es true, queda como borrador
  publishNow?: boolean;
};

export async function publishZernioPost(
  input: PublishPostInput
): Promise<{ ok: true; postId: string; status: string } | { ok: false; error: string }> {
  const zernio = getClient();
  if (!zernio) return { ok: false, error: "zernio_no_configurado" };
  if (!input.platforms.length) return { ok: false, error: "sin_cuentas_destino" };
  try {
    const { data } = await zernio.posts.createPost({
      body: {
        content: input.content,
        mediaUrls: input.mediaUrls,
        platforms: input.platforms,
        ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
        ...(input.publishNow ? { publishNow: true } : {}),
      },
    });
    return { ok: true, postId: data.post._id, status: data.post.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- WhatsApp Business (inbox unificado) ----------

export function isZernioWhatsappConfigured(): boolean {
  return Boolean(process.env.ZERNIO_API_KEY && process.env.ZERNIO_WHATSAPP_ACCOUNT_ID);
}

// Embedded Signup de Meta, pero gestionado por Zernio: un clic, sin la
// verificación de negocio de Meta ni la revisión de app (según Zernio).
// profileId es el "workspace" de Zernio -- ZERNIO_PROFILE_ID en el .env.
export async function getWhatsappConnectUrl(redirectUrl: string): Promise<
  { ok: true; authUrl: string } | { ok: false; error: string }
> {
  const zernio = getClient();
  if (!zernio) return { ok: false, error: "zernio_no_configurado" };
  const profileId = process.env.ZERNIO_PROFILE_ID;
  if (!profileId) return { ok: false, error: "falta_zernio_profile_id" };
  try {
    const { data } = await zernio.connect.getConnectUrl({
      path: { platform: "whatsapp" },
      query: { profileId, redirect_url: redirectUrl, onboarding: "api" },
    });
    return { ok: true, authUrl: data.authUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function normalizeParticipantId(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

// Recuerda qué conversationId de Zernio corresponde a cada número de
// teléfono, para poder responder dentro de la ventana de 24h sin tener
// que crear una conversación nueva (que en WhatsApp exige plantilla).
// Se rellena sola al recibir mensajes por el webhook (server.ts).
type ConversationMapping = { phone: string; conversation_id: string; account_id: string; updated_at: string };
const CONVERSATIONS_COLLECTION = "zernio_whatsapp_conversations";

export function rememberWhatsappConversation(phone: string, conversationId: string, accountId: string): void {
  const rows = readCollection<ConversationMapping>(CONVERSATIONS_COLLECTION);
  const key = normalizeParticipantId(phone);
  const next = rows.filter((r) => r.phone !== key);
  next.push({ phone: key, conversation_id: conversationId, account_id: accountId, updated_at: new Date().toISOString() });
  writeCollection(CONVERSATIONS_COLLECTION, next);
}

export function findWhatsappConversation(phone: string): ConversationMapping | undefined {
  const key = normalizeParticipantId(phone);
  return readCollection<ConversationMapping>(CONVERSATIONS_COLLECTION).find((r) => r.phone === key);
}

export type ZernioWhatsappSendResult = { ok: true; messageId: string } | { ok: false; error: string };

// Envío real a un número con el que ya hay conversación abierta (respuesta
// dentro de las 24h desde su último mensaje). Si no hay conversación
// conocida, Zernio exige una plantilla aprobada -- eso no se intenta aquí
// (ver nota en whatsapp.ts), igual que la API de Meta directa tampoco
// permite texto libre a un contacto nuevo.
export async function sendZernioWhatsappText(phone: string, body: string): Promise<ZernioWhatsappSendResult> {
  const zernio = getClient();
  const accountId = process.env.ZERNIO_WHATSAPP_ACCOUNT_ID;
  if (!zernio || !accountId) return { ok: false, error: "zernio_whatsapp_no_configurado" };

  const existing = findWhatsappConversation(phone);
  if (!existing) {
    return { ok: false, error: "sin_conversacion_abierta: el cliente no ha escrito antes por este canal, hace falta una plantilla aprobada para iniciar" };
  }

  try {
    const { data } = await zernio.messages.sendInboxMessage({
      path: { conversationId: existing.conversation_id },
      body: { accountId, message: body },
    });
    const messageId = data.messageId ?? data.messageIds?.[0];
    if (!messageId) return { ok: false, error: "zernio_sin_message_id" };
    return { ok: true, messageId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Verificación de la firma del webhook (HMAC-SHA256 sobre el cuerpo crudo,
// hex, sin prefijo) -- igual que retell-signature.ts/twilio-signature.ts:
// si no coincide, nunca se procesa el evento.
export function verifyZernioSignature(rawBody: string, signatureHeader: string | undefined | null, secret: string | undefined): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  if (expected.length !== signatureHeader.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}
