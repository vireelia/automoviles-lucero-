import { isGoogleConnected, gmailListUnread, gmailGet } from "../integrations/google.js";
import { processInboundEmail } from "./agent.js";

// Bajado de 3 minutos a 30 segundos (26/10/2026, petición real: "pon
// todos los gmail en tiempo real"). Esto es sondeo (polling), no un
// empuje real en vivo -- lo más real-time posible sin montar Gmail
// Push/Pub-Sub (infraestructura nueva, fuera de alcance aquí) es revisar
// mucho más seguido. 30s está muy por debajo de cualquier límite real de
// cuota de la API de Gmail (list/get cuestan poco) y no afecta al
// espaciado de ENVÍO (humanSpacingMs, más abajo), que es el que de
// verdad importa para no parecer un bot a ojos de Gmail.
const INTERVAL_MS = 30 * 1000;
const BATCH = 10;
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

// Revisa la bandeja del negocio cada 30 segundos. Sin Google conectado no hace nada.
// La deduplicación la lleva processInboundEmail, porque Gmail no nos deja marcar
// los correos como leídos sin el ámbito gmail.modify.
export function startEmailPoller() {
  setInterval(async () => {
    if (running || !isGoogleConnected()) return;
    running = true;
    try {
      const list = await gmailListUnread();
      const items = list.slice(0, BATCH);
      for (let i = 0; i < items.length; i++) {
        const m = await gmailGet(items[i].id);
        await processInboundEmail({
          messageKey: m.id,
          from: m.from,
          fromName: m.fromName,
          subject: m.subject,
          text: m.text,
          threadId: m.threadId,
          inReplyTo: m.messageId,
          automated: m.automated,
        });
        if (i < items.length - 1) await new Promise((r) => setTimeout(r, humanSpacingMs()));
      }
    } catch (err) {
      console.error("[email] poll:", err);
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
}
