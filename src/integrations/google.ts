import crypto from "crypto";
import { readCollection, writeCollection } from "../store.js";

// Scopes mínimos para lo que hace Miguel: enviar correo desde la cuenta del
// negocio, leer su bandeja (para no contestar dos veces) y gestionar su
// calendario de citas. calendar (completo) lo ha pedido el negocio.
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
];

const REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ??
  "https://virelia-hub-lucero.lzc0bh.easypanel.host/oauth/google/callback";

type TokenRecord = { id: "main"; refresh_token: string; scope: string; connected_at: string };
type StateRecord = { state: string; created_at: string };

function tokenRecord(): TokenRecord | null {
  return readCollection<TokenRecord>("google_tokens").find((t) => t.id === "main") ?? null;
}

export function isGoogleConnected(): boolean {
  return Boolean(tokenRecord());
}

export function googleStatus() {
  const t = tokenRecord();
  return {
    configured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    connected: Boolean(t),
    connected_at: t?.connected_at ?? null,
    scopes: t?.scope ?? null,
  };
}

export function createAuthUrl(): string {
  if (!process.env.GOOGLE_CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID no configurado");
  const state = crypto.randomBytes(24).toString("hex");
  const states = readCollection<StateRecord>("google_oauth_states").filter(
    (s) => Date.now() - new Date(s.created_at).getTime() < 15 * 60 * 1000,
  );
  states.push({ state, created_at: new Date().toISOString() });
  writeCollection("google_oauth_states", states);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function consumeState(state: string): boolean {
  const states = readCollection<StateRecord>("google_oauth_states");
  const found = states.some((s) => s.state === state);
  writeCollection("google_oauth_states", states.filter((s) => s.state !== state));
  return found;
}

export async function exchangeCodeAndStore(code: string): Promise<void> {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as { refresh_token?: string; scope?: string; error?: string };
  if (!res.ok || !data.refresh_token) {
    throw new Error(`Google no devolvió refresh_token: ${data.error ?? res.status}`);
  }
  const others = readCollection<TokenRecord>("google_tokens").filter((t) => t.id !== "main");
  writeCollection<TokenRecord>("google_tokens", [
    ...others,
    { id: "main", refresh_token: data.refresh_token, scope: data.scope ?? "", connected_at: new Date().toISOString() },
  ]);
}

async function accessToken(): Promise<string> {
  const t = tokenRecord();
  if (!t) throw new Error("google_not_connected");
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    refresh_token: t.refresh_token,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !data.access_token) throw new Error(`google_token_refresh_failed: ${data.error ?? res.status}`);
  return data.access_token;
}

async function googleFetch(url: string, init: RequestInit = {}) {
  const token = await accessToken();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`google_api_${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

export async function sendGmail(to: string, subject: string, text: string) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${encodedSubject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${text}`,
    "utf8",
  ).toString("base64url");
  return googleFetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw }),
  }) as Promise<{ id: string; threadId: string }>;
}

export async function calendarBusy(timeMin: string, timeMax: string): Promise<{ start: string; end: string }[]> {
  const data = (await googleFetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    body: JSON.stringify({ timeMin, timeMax, timeZone: "Europe/Madrid", items: [{ id: "primary" }] }),
  })) as { calendars?: { primary?: { busy?: { start: string; end: string }[] } } };
  return data.calendars?.primary?.busy ?? [];
}

export async function calendarCreateEvent(input: {
  summary: string;
  description: string;
  startLocal: string;
  endLocal: string;
}) {
  return googleFetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    body: JSON.stringify({
      summary: input.summary,
      description: input.description,
      start: { dateTime: input.startLocal, timeZone: "Europe/Madrid" },
      end: { dateTime: input.endLocal, timeZone: "Europe/Madrid" },
    }),
  }) as Promise<{ id: string; htmlLink: string }>;
}
