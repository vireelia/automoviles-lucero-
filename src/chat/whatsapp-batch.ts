import crypto from "crypto";
import { readShard, writeShard, listShardKeys, claimOnce, appendToCollection } from "../store.js";
import { withPersistentLock, withPersistentLockOrSkip } from "../locks.js";

// FALLO REAL detectado en auditoría (17/11/2026, "7 fotos seguidas -> 7
// respuestas de Carolina"): el webhook de Zernio (/webhooks/zernio-whatsapp)
// deduplica cada evento por eventId, pero cada FOTO de un envío múltiple es
// un eventId distinto -- así que un cliente mandando 7 fotos consecutivas
// disparaba 7 llamadas independientes a handleChatMessage y 7 respuestas
// reales del agente. Esta cola agrupa por teléfono: cada mensaje entrante
// reinicia una ventana de silencio (por defecto 8s); solo cuando pasan esos
// 8s sin que llegue nada nuevo de ESE cliente se procesa el lote completo en
// una sola llamada a handleChatMessage. La dedup por eventId (claimOnce
// sobre "zernio_whatsapp_processed") sigue intacta en el webhook -- esto es
// una capa ADICIONAL por encima, nunca un reemplazo.
//
// Persistencia: un fragmento JSON por teléfono (mismo patrón writeShard/
// readShard que chat_conversations), para sobrevivir a un reinicio del
// servidor sin perder ni duplicar mensajes a medio agrupar. El "lock" de
// disco (locks.ts) por teléfono asegura que nunca hay dos ejecuciones
// concurrentes del lote de un mismo cliente, y que agrupar/leer no se
// pisan entre el webhook (que añade mensajes) y el sondeo (que los procesa).

const COLLECTION = "zernio_whatsapp_batches";
const DONE_COLLECTION = "zernio_whatsapp_batch_done";
const DISCARDED_COLLECTION = "whatsapp_batch_discarded";

// Tope de antigüedad (PUNTO 3 del encargo, 18/11/2026, Fase 2C autorizada por
// el cliente): tras una caída larga del servidor, el sondeo no debe disparar
// una respuesta automática a un mensaje de hace horas/días como si acabara de
// llegar -- ese contexto ya puede ser irrelevante o directamente incorrecto
// (precio/disponibilidad cambiados, el cliente ya resolvió por otra vía).
// 8h por defecto: suficiente para absorber un despliegue/reinicio normal o un
// pico de tráfico nocturno sin descartar nada real, pero corta mucho antes de
// que "ayer" se confunda con "ahora" -- coherente con el criterio ya usado en
// outbound-guard.ts (48h) para la ventana más laxa de "evento entrante que
// autoriza un envío proactivo"; aquí la ventana es más corta a propósito,
// porque esto es una respuesta automática a algo que el cliente cree que
// acaba de mandar, no un contacto proactivo nuevo.
export const WHATSAPP_BATCH_MAX_AGE_HOURS = Number(process.env.WHATSAPP_BATCH_MAX_AGE_HOURS) > 0 ? Number(process.env.WHATSAPP_BATCH_MAX_AGE_HOURS) : 8;
const WHATSAPP_BATCH_MAX_AGE_MS = WHATSAPP_BATCH_MAX_AGE_HOURS * 3600_000;

// Ventana configurable (PUNTO 2 del encargo): por defecto 8s desde el
// ÚLTIMO mensaje recibido de ese cliente, no desde el primero.
export const BATCH_WINDOW_MS = Number(process.env.ZERNIO_WHATSAPP_BATCH_WINDOW_MS) > 0 ? Number(process.env.ZERNIO_WHATSAPP_BATCH_WINDOW_MS) : 8_000;
// Frecuencia del sondeo: tiene que ser bastante más fina que la ventana para
// no añadir una demora perceptible al cliente.
const POLL_INTERVAL_MS = Number(process.env.ZERNIO_WHATSAPP_BATCH_POLL_MS) > 0 ? Number(process.env.ZERNIO_WHATSAPP_BATCH_POLL_MS) : 1_000;
// Tope generoso de espera por el lock de un teléfono al encolar un mensaje
// nuevo: tiene que cubrir el peor caso real de un lote anterior procesándose
// (varias rondas de IA + envío), nunca menos que el propio timeout de
// handleChatMessage.
const ENQUEUE_LOCK_TIMEOUT_MS = 150_000;

export type BatchItem = {
  eventId: string;
  whatsappInboxId: string;
  text: string;
  media_path?: string;
  media_type?: "audio" | "image";
  sentAt?: string;
};

type BatchState = {
  phone: string;
  // Mensajes todavía acumulando silencio -- no se han procesado.
  items: BatchItem[];
  last_at: number;
  // Lote ya "cerrado" (ventana de silencio cumplida) y en curso de
  // procesarse -- persistido ANTES de tocar la IA, para poder recuperarlo
  // intacto si el proceso se reinicia a mitad.
  inflight?: {
    batch_id: string;
    items: BatchItem[];
    started_at: number;
  };
};

function emptyState(phone: string): BatchState {
  return { phone, items: [], last_at: 0 };
}

// PUNTOS 1 y 3: añade un mensaje a la cola persistente de ese teléfono y
// reinicia la ventana de silencio. Si llega mientras el lote anterior de
// ESE mismo teléfono se está procesando (bloqueo tomado por el sondeo), el
// mensaje se encola igual en cuanto el lock se libera -- nunca se mezcla con
// el lote que ya está en curso (PUNTO 10: ese lote ya quedó "desenganchado"
// en `inflight` antes de empezar a procesarse, así que `items` siempre
// recibe un lote nuevo y limpio).
export async function enqueueWhatsappBatchMessage(phone: string, item: BatchItem): Promise<void> {
  try {
    await withPersistentLock(
      `wa_batch_${phone}`,
      () => {
        const state = readShard<BatchState>(COLLECTION, phone) ?? emptyState(phone);
        state.items.push(item);
        state.last_at = Date.now();
        writeShard(COLLECTION, phone, state);
      },
      ENQUEUE_LOCK_TIMEOUT_MS,
    );
  } catch (err) {
    // Mejor escribir sin el lock (riesgo mínimo de pisar un `last_at` casi
    // simultáneo) que perder una foto real del cliente -- mismo criterio que
    // ya usa mutateCollection en store.ts para este mismo tipo de fallo.
    console.error(`[wa-batch] sin bloqueo para encolar mensaje de ${phone}, se escribe igualmente:`, err instanceof Error ? err.message : err);
    const state = readShard<BatchState>(COLLECTION, phone) ?? emptyState(phone);
    state.items.push(item);
    state.last_at = Date.now();
    writeShard(COLLECTION, phone, state);
  }
}

export type BatchHandler = (phone: string, items: BatchItem[], batchId: string) => Promise<void>;

// Registro para revisión humana (PUNTO 3): nunca borra el historial real de
// mensajes del cliente (whatsapp_inbox sigue intacto) -- esto es solo sobre
// si se dispara o no una respuesta automática tardía. El lote completo queda
// aquí, con el teléfono y el motivo, para que el equipo decida a mano si
// hace falta contestar algo ya.
function registrarLoteDescartadoPorAntiguedad(phone: string, batchId: string, items: BatchItem[], ageMs: number, origen: "items" | "inflight"): void {
  console.warn(`[wa-batch] lote de ${phone} descartado por antigüedad (${origen}, ${(ageMs / 3600_000).toFixed(1)}h) -- no se envía respuesta automática, queda para revisión humana`);
  try {
    appendToCollection(DISCARDED_COLLECTION, {
      id: crypto.randomUUID(),
      phone,
      batch_id: batchId,
      origen,
      age_hours: Math.round((ageMs / 3600_000) * 10) / 10,
      items,
      discarded_at: new Date().toISOString(),
      motivo: "antiguedad_supera_limite",
    });
  } catch (err) {
    console.error("[wa-batch] no se pudo registrar el lote descartado:", err instanceof Error ? err.message : err);
  }
}

// Combina el texto/medios de todos los mensajes del lote en un único texto
// coherente para el agente (PUNTO 7): texto intercalado en el orden real de
// llegada, fotos/notas de voz marcadas como "[imagen N]"/"[nota de voz N]"
// para que el agente sepa que hubo varios adjuntos aunque no pueda "verlos".
export function combineBatchText(items: BatchItem[]): string {
  let imgN = 0;
  let audN = 0;
  return items
    .map((it) => {
      if (it.media_type === "image") {
        imgN += 1;
        return it.text && it.text !== "📷 Foto" ? `[imagen ${imgN}] ${it.text}` : `[imagen ${imgN}]`;
      }
      if (it.media_type === "audio") {
        audN += 1;
        return it.text && it.text !== "🎤 Nota de voz" ? `[nota de voz ${audN}] ${it.text}` : `[nota de voz ${audN}]`;
      }
      return it.text;
    })
    .join("\n")
    .slice(0, 4000);
}

// Un único recorrido de sondeo: procesa, como máximo, los lotes de teléfonos
// cuya ventana de silencio ya expiró, y reanuda cualquier lote que quedara
// "inflight" de un reinicio anterior. Cada teléfono bajo su propio lock
// (PUNTO 9: conversaciones de clientes distintos, completamente
// independientes) -- si el lock de un teléfono está tomado (lote en curso o
// un enqueue concurrente), este tick simplemente lo salta, nunca espera.
export async function processDueWhatsappBatches(handler: BatchHandler): Promise<void> {
  const phones = listShardKeys(COLLECTION);
  for (const phone of phones) {
    await withPersistentLockOrSkip(`wa_batch_${phone}`, async () => {
      const state = readShard<BatchState>(COLLECTION, phone);
      if (!state) return;

      // PUNTO 6/8: recuperación tras un reinicio a mitad de un lote ya
      // cerrado -- el lote sigue íntegro en disco (`inflight`), nunca se
      // perdió ni se re-mezcló con mensajes nuevos (esos ya están aparte,
      // en `items`). handler() decide por sí mismo (claimBatchOnce) si de
      // verdad hace falta reprocesar o si la respuesta ya se envió antes
      // del reinicio.
      if (state.inflight && state.inflight.items.length > 0) {
        const inflightAgeMs = Date.now() - state.inflight.started_at;
        if (inflightAgeMs > WHATSAPP_BATCH_MAX_AGE_MS) {
          registrarLoteDescartadoPorAntiguedad(phone, state.inflight.batch_id, state.inflight.items, inflightAgeMs, "inflight");
          const fresh = readShard<BatchState>(COLLECTION, phone);
          if (fresh?.inflight?.batch_id === state.inflight.batch_id) {
            fresh.inflight = undefined;
            writeShard(COLLECTION, phone, fresh);
          }
          return;
        }
        await handler(phone, state.inflight.items, state.inflight.batch_id);
        const fresh = readShard<BatchState>(COLLECTION, phone);
        if (fresh?.inflight?.batch_id === state.inflight.batch_id) {
          fresh.inflight = undefined;
          writeShard(COLLECTION, phone, fresh);
        }
        return;
      }

      if (state.items.length === 0) return;
      if (Date.now() - state.last_at < BATCH_WINDOW_MS) return; // sigue dentro de la ventana de silencio

      // PUNTO 3: antes de desenganchar y procesar, comprueba la antigüedad
      // real del lote (desde el último mensaje recibido de este cliente) --
      // tras una caída larga del servidor, last_at puede llevar horas/días
      // sin que nadie lo sondeara.
      {
        const itemsAgeMs = Date.now() - state.last_at;
        if (itemsAgeMs > WHATSAPP_BATCH_MAX_AGE_MS) {
          const discardedId = crypto.randomUUID();
          registrarLoteDescartadoPorAntiguedad(phone, discardedId, state.items, itemsAgeMs, "items");
          state.items = [];
          writeShard(COLLECTION, phone, state);
          return;
        }
      }

      // Desenganche atómico (PUNTO 10): el lote que se va a procesar se
      // mueve a `inflight` y `items` queda vacío en la MISMA escritura --
      // cualquier mensaje que llegue a partir de aquí (incluso mientras este
      // mismo lote todavía se está procesando) empieza un lote nuevo y
      // limpio, nunca se mezcla con el que ya está en curso.
      const batchId = crypto.randomUUID();
      const detached = state.items;
      state.items = [];
      state.inflight = { batch_id: batchId, items: detached, started_at: Date.now() };
      writeShard(COLLECTION, phone, state);

      await handler(phone, detached, batchId);

      const after = readShard<BatchState>(COLLECTION, phone);
      if (after?.inflight?.batch_id === batchId) {
        after.inflight = undefined;
        writeShard(COLLECTION, phone, after);
      }
    });
  }
}

// Guarda de una sola vez (PUNTO 8), mismo patrón que claimOnce ya usa el
// proyecto para eventId: devuelve true solo la primera vez para este
// batchId, aunque el proceso se reinicie y el sondeo reintente el mismo
// lote `inflight` -- así nunca se manda una segunda respuesta real al
// cliente por el mismo lote.
export async function claimBatchOnce(batchId: string): Promise<boolean> {
  return claimOnce(DONE_COLLECTION, batchId, 2000);
}

let started = false;
export function startWhatsappBatchPoller(handler: BatchHandler): void {
  if (started) return; // nunca dos intervalos reales en el mismo proceso
  started = true;
  setInterval(() => {
    processDueWhatsappBatches(handler).catch((err) => {
      console.error("[wa-batch] fallo en el sondeo de lotes de WhatsApp:", err instanceof Error ? err.message : err);
    });
  }, POLL_INTERVAL_MS);
}
