import { isGoogleConnected, gmailListUnread, gmailGet, gmailMarkRead } from "../integrations/google.js";
import { processInboundEmail } from "./agent.js";
import { readCollection, writeCollection } from "../store.js";

// Bajado de 3 minutos a 30 segundos (26/10/2026, petición real: "pon
// todos los gmail en tiempo real"). Esto es sondeo (polling), no un
// empuje real en vivo -- lo más real-time posible sin montar Gmail
// Push/Pub-Sub (infraestructura nueva, fuera de alcance aquí) es revisar
// mucho más seguido. 30s está muy por debajo de cualquier límite real de
// cuota de la API de Gmail (list/get cuestan poco) y no afecta al
// espaciado de ENVÍO (humanSpacingMs, más abajo), que es el que de
// verdad importa para no parecer un bot a ojos de Gmail.
const INTERVAL_MS = 30 * 1000;
// Subido de 10 a 30 (03/11/2026) -- ahora que los descartes reales no
// esperan nada (ver REAL_SEND_OUTCOMES más abajo), procesar más por
// ciclo vacía el backlog real mucho más rápido sin afectar al espaciado
// real de los envíos de verdad, que sigue intacto.
const BATCH = 30;
// FALLO REAL grave detectado (18/10/2026, a petición de "ajusta el agente
// de gmail para que cumpla tiempos para que no sea baneado"): este bucle
// procesaba el lote entero sin ninguna pausa -- una clienta real (Diana,
// confirmada en el buzón de salida real) escribió varios mensajes seguidos
// por el chat de Coches.net y el agente le contestó bien, pero con envíos
// de correo prácticamente seguidos (en un caso, 1 segundo de diferencia
// entre dos envíos al mismo cliente). El contenido era correcto, pero ese
// patrón de ráfaga es exactamente lo que los sistemas antiabuso de Gmail
// penalizan, sin importar que el contenido tenga sentido. Una cuenta de
// Gmail normal (no Workspace) es especialmente sensible a la velocidad de
// envío, más que al volumen total.
//
// Ampliado el mismo día a petición real ("con segundos de espera siempre,
// como un humano, para evitar problemas"): una pausa fija e idéntica entre
// cada correo (siempre exactamente 8,000s) es en sí misma una señal
// robótica -- ningún humano contesta con esa regularidad perfecta. Ahora la
// espera es aleatoria dentro de un rango realista, distinta cada vez.
const MIN_SPACING_MS = 12_000;
const MAX_SPACING_MS = 40_000;
function humanSpacingMs(): number {
  return MIN_SPACING_MS + Math.floor(Math.random() * (MAX_SPACING_MS - MIN_SPACING_MS));
}
let running = false;

// FALLO REAL grave detectado (04/11/2026, "porque consumen tantos
// creditos... eso no es lo que habiamos quedado"): con OpenAI sin crédito
// (llm_http_429/insufficient_quota), este sondeo cada 30s reintentaba TODO
// el backlog pendiente una y otra vez, para siempre -- 500 correos reales
// (el tope del propio email_inbox) quedaron con outcome
// "fallo_ia_pendiente_revision" en una sola mañana, puro ruido martilleando
// la API sin parar mientras no había crédito. No cambia el criterio de
// reintentar en cuanto el crédito vuelva (eso sigue siendo correcto) --
// solo espacia MUCHO más los reintentos mientras el fallo sea
// específicamente de cuota/crédito, en vez de cada 30s sin descanso.
const QUOTA_COOLDOWN_MS = 10 * 60 * 1000;
let quotaCooldownUntil = 0;
function looksLikeQuotaError(message: string | undefined): boolean {
  return Boolean(message) && /llm_http_429|insufficient_quota|rate_limit/i.test(message!);
}

// Revisa la bandeja del negocio cada 30 segundos. Sin Google conectado no hace nada.
// La deduplicación la lleva processInboundEmail, porque Gmail no nos deja marcar
// los correos como leídos sin el ámbito gmail.modify.
export function startEmailPoller() {
  setInterval(async () => {
    if (running || !isGoogleConnected()) return;
    if (Date.now() < quotaCooldownUntil) return;
    running = true;
    try {
      const list = await gmailListUnread();
      const items = list.slice(0, BATCH);
      for (let i = 0; i < items.length; i++) {
        const m = await gmailGet(items[i].id);
        const result = await processInboundEmail({
          messageKey: m.id,
          from: m.from,
          fromName: m.fromName,
          subject: m.subject,
          text: m.text,
          threadId: m.threadId,
          inReplyTo: m.messageId,
          automated: m.automated,
          receivedAt: m.received_at,
        });
        if (result.outcome === "fallo_ia_pendiente_revision" && looksLikeQuotaError(result.error)) {
          quotaCooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
          console.warn(`[email] crédito de IA agotado -- pausando reintentos ${QUOTA_COOLDOWN_MS / 60000} min en vez de cada 30s.`);
          break;
        }
        // Fallo real detectado (03/11/2026, incidente real: la bandeja
        // acumuló 100+ correos sin leer, en su mayoría avisos automáticos
        // de Coches.net ya correctamente ignorados -- pero al no poder
        // marcarse como leídos (sin gmail.modify), se quedaban para
        // siempre enterrando correos nuevos de clientes reales detrás,
        // caso real: Juan preguntando si un coche seguía a la venta).
        // Se marca leído TODO lo que ya se decidió de verdad -- excepto
        // "fallo_ia_pendiente_revision", que debe reintentarse solo en
        // cuanto el fallo real (p.ej. créditos de IA) se resuelva. Si
        // gmail.modify todavía no está concedido (cuenta no reconectada
        // con el permiso nuevo), esto falla en silencio -- nunca bloquea
        // el procesamiento real del correo por esto.
        if (result.outcome !== "fallo_ia_pendiente_revision") {
          try {
            await gmailMarkRead(m.id);
          } catch (err) {
            console.warn(`[email] no se pudo marcar como leído ${m.id} (probable falta de permiso gmail.modify, reconectar Google):`, err instanceof Error ? err.message : err);
          }
        }
        // Fallo real detectado (03/11/2026): esta espera (pensada para no
        // parecer un bot EN ENVÍOS reales) se aplicaba igual aunque el
        // correo no fuera a enviar nada (p.ej. un aviso automático que
        // solo hay que descartar) -- con la mayoría del lote siendo
        // descartes reales, esto ralentizaba muchísimo vaciar el backlog
        // real acumulado. Ahora solo se espera entre dos envíos reales.
        const REAL_SEND_OUTCOMES = new Set(["sent", "sent_whatsapp_automatico", "sent_whatsapp_plantilla"]);
        if (i < items.length - 1 && REAL_SEND_OUTCOMES.has(result.outcome)) {
          await new Promise((r) => setTimeout(r, humanSpacingMs()));
        }
      }
    } catch (err) {
      // Fallo real detectado (03/11/2026, incidente real: el sondeo fallaba
      // en silencio -- un error aquí (lectura de Gmail, no solo el envío de
      // la respuesta) solo se veía en console.error, invisible desde fuera
      // del contenedor. No había forma de confirmar desde el CRM si el
      // sondeo seguía vivo o lleva horas fallando siempre igual.
      const message = err instanceof Error ? err.message : String(err);
      console.error("[email] poll:", err);
      try {
        const errors = readCollection<{ id: string; message: string; at: string }>("email_poller_errors");
        writeCollection("email_poller_errors", [...errors, { id: crypto.randomUUID(), message, at: new Date().toISOString() }].slice(-50));
      } catch {
        // Si ni esto se puede escribir, no hay nada más que hacer aquí --
        // el console.error de arriba ya se intentó, no se vuelve a fallar
        // en cascada por culpa del propio registro del fallo.
      }
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
}
