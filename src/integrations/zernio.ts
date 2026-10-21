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
import { Zernio, ZernioApiError, type SocialAccount } from "@zernio/node";
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

export type ZernioAccount = { id: string; platform: string; displayName?: string };

// La API de Zernio identifica cada cuenta por `_id` (confirmado contra la
// API real 19/10/2026 -- la cuenta de WhatsApp recién conectada venía con
// `id: undefined` hasta corregir esto), nunca `id` -- se normaliza aquí para
// que el resto del código (crm/app.ts, ZERNIO_WHATSAPP_ACCOUNT_ID) solo
// tenga que conocer `id`.
function toZernioAccount(a: SocialAccount): ZernioAccount {
  return { id: a._id, platform: a.platform, displayName: a.displayName };
}

export async function listZernioAccounts(): Promise<
  { ok: true; accounts: ZernioAccount[] } | { ok: false; error: string }
> {
  const zernio = getClient();
  if (!zernio) return { ok: false, error: "zernio_no_configurado" };
  try {
    const { data } = await zernio.accounts.listAccounts();
    return { ok: true, accounts: (data?.accounts ?? []).map(toZernioAccount) };
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

// Backlog real de WhatsApp (19/10/2026, "mira los 100 mensajes reales de
// los clientes y ve respondiendo, pero verifica que son clientes"):
// conversaciones reales importadas del historial de coexistencia al
// conectar el número, de antes de que existiera este webhook -- hay que
// leerlas y responderlas con el mismo agente de siempre, nunca inventando
// una respuesta aparte.
export type WhatsappConversationSummary = {
  conversationId: string;
  phone: string;
  name: string | null;
  lastMessage: string | null;
  updatedTime: string | null;
  unreadCount: number;
};

// Mismo criterio que el webhook (server.ts): un cliente real es un número
// individual (solo dígitos, 8-15 -- el máximo real de E.164), nunca un
// grupo ni un id con otra forma.
function looksLikeRealCustomerPhone(phone: string): boolean {
  return /^\d{8,15}$/.test(phone);
}

export async function listRecentWhatsappConversations(limit = 100): Promise<
  { ok: true; conversations: WhatsappConversationSummary[] } | { ok: false; error: string }
> {
  const zernio = getClient();
  const accountId = process.env.ZERNIO_WHATSAPP_ACCOUNT_ID;
  if (!zernio || !accountId) return { ok: false, error: "zernio_whatsapp_no_configurado" };
  try {
    const { data } = await zernio.messages.listInboxConversations({ query: { accountId, platform: "whatsapp", limit, sortOrder: "desc" } });
    const rows = (data?.data ?? []) as Array<{
      id: string;
      participantUsername?: string;
      participantId?: string;
      participantName?: string;
      lastMessage?: string;
      updatedTime?: string;
      unreadCount?: number | null;
    }>;
    const conversations = rows.map((r) => ({
      conversationId: r.id,
      phone: normalizeParticipantId(r.participantId ?? r.participantUsername ?? ""),
      name: r.participantName && !/^\d+$/.test(r.participantName) ? r.participantName : null,
      lastMessage: r.lastMessage ?? null,
      updatedTime: r.updatedTime ?? null,
      unreadCount: r.unreadCount ?? 0,
    }));
    return { ok: true, conversations };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function isRealCustomerConversation(c: WhatsappConversationSummary): boolean {
  return looksLikeRealCustomerPhone(c.phone);
}

// Últimos mensajes de una conversación, del más reciente al más antiguo --
// para ver de verdad qué preguntó el cliente, no solo el resumen corto de
// listRecentWhatsappConversations.
export async function getRecentWhatsappMessages(
  conversationId: string,
  limit = 10,
): Promise<{ ok: true; messages: { text: string | null; direction: "incoming" | "outgoing"; createdAt: string }[] } | { ok: false; error: string }> {
  const zernio = getClient();
  const accountId = process.env.ZERNIO_WHATSAPP_ACCOUNT_ID;
  if (!zernio || !accountId) return { ok: false, error: "zernio_whatsapp_no_configurado" };
  try {
    const { data } = await zernio.messages.getInboxConversationMessages({ path: { conversationId }, query: { accountId, limit, sortOrder: "desc" } });
    const messages = (data.messages ?? []).map((m: { message?: string | null; direction: "incoming" | "outgoing"; createdAt: string }) => ({
      text: m.message ?? null,
      direction: m.direction,
      createdAt: m.createdAt,
    }));
    return { ok: true, messages };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
// FALLO REAL detectado (21/10/2026, prueba real contra la API de Zernio):
// una conversación recordada de hace más de 24h se trataba igual que una
// abierta -- se intentaba sendInboxMessage sobre ella, Meta la rechazaba en
// silencio (sin excepción, solo sin messageId) y nunca se probaba el camino
// de Direct Send de verdad. Ahora solo se usa la conversación existente si
// su último mensaje real es de menos de 24h; en cualquier otro caso (sin
// conversación, caducada, o el intento sobre ella no da messageId) se cae a
// Direct Send como último intento real antes de rendirse.
const WHATSAPP_WINDOW_HOURS = 24;

export async function sendZernioWhatsappText(phone: string, body: string): Promise<ZernioWhatsappSendResult> {
  const zernio = getClient();
  const accountId = process.env.ZERNIO_WHATSAPP_ACCOUNT_ID;
  if (!zernio || !accountId) return { ok: false, error: "zernio_whatsapp_no_configurado" };

  const existing = findWhatsappConversation(phone);
  const withinWindow = Boolean(existing) && Date.now() - new Date(existing!.updated_at).getTime() < WHATSAPP_WINDOW_HOURS * 60 * 60 * 1000;

  if (existing && withinWindow) {
    try {
      const { data } = await zernio.messages.sendInboxMessage({
        path: { conversationId: existing.conversation_id },
        body: { accountId, message: body },
      });
      const messageId = data.messageId ?? data.messageIds?.[0];
      if (messageId) return { ok: true, messageId };
    } catch {
      // Sigue al intento de Direct Send en vez de rendirse aquí -- puede ser
      // que la ventana ya se hubiera cerrado justo en el lado de Meta.
    }
  }

  // Petición real (20/10/2026, auditoría de llamadas de voz: "el agente no
  // debería ofrecer [WhatsApp] en voz... busquemos la manera de que el
  // agente... le envíe cogiendo el número de la llamada"): en vez de
  // rendirse, se intenta iniciar la conversación de verdad con Meta Direct
  // Send (categoría "utility", sin plantilla aprobada). Si la cuenta no es
  // elegible, Meta/Zernio lo rechaza con un error real (nunca se finge un
  // envío) y aquí se devuelve tal cual.
  return sendZernioWhatsappNewConversation(zernio, accountId, phone, body);
}

// Inicia una conversación de WhatsApp nueva con un número que nunca escribió
// antes, usando Meta Direct Send (mensaje de categoría "utility", sin
// plantilla aprobada -- Meta la empareja o la crea sola de forma asíncrona).
// Requiere que la cuenta de WhatsApp Business del negocio sea elegible para
// Direct Send; si no lo es, Meta devuelve DIRECT_SEND_NOT_ELIGIBLE (u otro
// código de la lista) y aquí se propaga el error real, nunca se asume
// entregado. Solo para contenido realmente "utility" (ubicación, horarios,
// confirmaciones) -- nunca para enlaces de vehículos ni nada promocional,
// eso arriesgaría que Meta reclasifique o restrinja el número del negocio.
async function sendZernioWhatsappNewConversation(zernio: Zernio, accountId: string, phone: string, body: string): Promise<ZernioWhatsappSendResult> {
  try {
    const { data, error } = await zernio.messages.createInboxConversation({
      body: { accountId, participantId: normalizeParticipantId(phone), message: body, category: "utility" },
    });
    if (error) {
      const code = (error as { code?: string })?.code;
      const message = (error as { error?: string })?.error;
      return { ok: false, error: `zernio_direct_send_rechazado${code ? `: ${code}` : ""}${message ? ` (${message})` : ""}` };
    }
    const messageId = data?.messageId;
    const conversationId = data?.conversationId;
    if (!messageId || !conversationId) return { ok: false, error: "zernio_sin_message_id_direct_send" };
    rememberWhatsappConversation(phone, conversationId, accountId);
    return { ok: true, messageId };
  } catch (err) {
    if (err instanceof ZernioApiError) {
      return { ok: false, error: `${err.code ?? "zernio_api_error"}: ${err.message}` };
    }
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
