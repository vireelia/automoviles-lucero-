import crypto from "crypto";
import { readCollection, writeCollection } from "../store.js";
import { createAutoTask } from "../tools/tasks.js";

// Reenvía el análisis de una llamada de voz a n8n, que es quien crea el lead
// con origen VOZ.
//
// FIABILIDAD (09/11/2026, auditoría de automatizaciones): esto era "disparar
// y olvidar" sin reintento ni rastro. El análisis de la llamada sí quedaba
// guardado en call_analyses, pero el LEAD lo crea n8n -- así que si n8n
// estaba caído o la petición fallaba, ese cliente real nunca aparecía en el
// CRM y nadie le llamaba. El fallo solo se veía en console.error, invisible
// desde fuera del contenedor.
//
// Ahora el envío se persiste antes de intentarlo y se reintenta con backoff
// desde el ciclo del programador. No se duplica la arquitectura: sigue
// siendo n8n quien crea el lead, solo se garantiza que el aviso le llega.

type OutboxItem = {
  id: string;
  call_id: string | null;
  body: Record<string, unknown>;
  intentos: number;
  next_retry_at: string;
  last_error?: string;
  created_at: string;
};

const COLLECTION = "n8n_voz_outbox";
const BACKOFF_MINUTOS = [1, 5, 15, 60, 180];
const MAX_INTENTOS = BACKOFF_MINUTOS.length;

function construirCuerpo(payload: Record<string, any>): { call_id: string | null; body: Record<string, unknown> } {
  const call = payload.call ?? {};
  const analysis = call.call_analysis ?? {};
  const custom = analysis.custom_analysis_data ?? {};
  return {
    call_id: call.call_id ?? null,
    body: {
      event: payload.event,
      call_id: call.call_id ?? null,
      from_number: call.from_number ?? null,
      summary: analysis.call_summary ?? null,
      customer_name: custom.customer_name ?? null,
      vehicle_of_interest: custom.vehicle_of_interest ?? null,
      intent: custom.intent ?? null,
      outcome: custom.outcome ?? null,
      lead_temperature: custom.lead_temperature ?? null,
    },
  };
}

async function enviar(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const url = process.env.N8N_VOZ_WEBHOOK_URL;
  if (!url) return { ok: false, error: "n8n_url_no_configurada" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `http_${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function encolar(item: OutboxItem): void {
  const all = readCollection<OutboxItem>(COLLECTION);
  // Idempotencia por call_id: un webhook repetido de Retell no encola dos veces.
  if (item.call_id && all.some((i) => i.call_id === item.call_id)) return;
  all.push(item);
  writeCollection(COLLECTION, all.slice(-500));
}

// Sigue siendo "no bloquea la respuesta a Retell": se intenta en segundo
// plano y, si falla, queda en la cola para el siguiente ciclo.
export function forwardVoiceAnalysis(payload: Record<string, any>): void {
  if (!process.env.N8N_VOZ_WEBHOOK_URL || payload?.event !== "call_analyzed") return;
  const { call_id, body } = construirCuerpo(payload);
  void enviar(body).then((r) => {
    if (r.ok) return;
    console.error(`[n8n] voz: fallo al reenviar (${r.error}) -- queda en cola para reintentar.`);
    encolar({
      id: crypto.randomUUID(),
      call_id,
      body,
      intentos: 1,
      next_retry_at: new Date(Date.now() + BACKOFF_MINUTOS[0] * 60_000).toISOString(),
      last_error: r.error,
      created_at: new Date().toISOString(),
    });
  });
}

// Lo llama el ciclo del programador, que ya va con bloqueo entre procesos.
export async function drainN8nVozOutbox(now = Date.now()): Promise<number> {
  const all = readCollection<OutboxItem>(COLLECTION);
  const listos = all.filter((i) => new Date(i.next_retry_at).getTime() <= now);
  if (listos.length === 0) return 0;
  let enviados = 0;
  for (const item of listos) {
    const r = await enviar(item.body);
    const fresco = readCollection<OutboxItem>(COLLECTION);
    const idx = fresco.findIndex((i) => i.id === item.id);
    if (idx < 0) continue;
    if (r.ok) {
      fresco.splice(idx, 1);
      enviados++;
    } else {
      const intentos = fresco[idx].intentos + 1;
      fresco[idx].intentos = intentos;
      fresco[idx].last_error = r.error;
      if (intentos >= MAX_INTENTOS) {
        // Nunca se descarta en silencio: el cliente de esa llamada no tiene
        // lead en el CRM, así que lo tiene que ver una persona.
        fresco.splice(idx, 1);
        createAutoTask({
          lead_phone: (item.body.from_number as string | null) ?? null,
          type: "llamar",
          reason: `Llamada de voz que no llegó a n8n tras ${intentos} intentos (${r.error}): no hay lead creado para ${item.body.from_number ?? "número desconocido"}. Vehículo: ${item.body.vehicle_of_interest ?? "no consta"}. Resumen: ${String(item.body.summary ?? "").slice(0, 300)}`,
          source_ref: `n8n_voz_${item.call_id ?? item.id}`,
          channel: "VOICE",
          priority: "alta",
        });
      } else {
        fresco[idx].next_retry_at = new Date(now + BACKOFF_MINUTOS[intentos] * 60_000).toISOString();
      }
    }
    writeCollection(COLLECTION, fresco);
  }
  return enviados;
}

export function listN8nVozOutbox(): OutboxItem[] {
  return readCollection<OutboxItem>(COLLECTION);
}
