import { isGoogleConnected, gmailListUnread, gmailGet, gmailMarkRead } from "../integrations/google.js";
import { processInboundEmail, drainPendingEmailQueue } from "./agent.js";
import { detectPortal } from "./interest.js";
import { readCollection, writeCollection } from "../store.js";
import { withPersistentLockOrSkip } from "../locks.js";
import { raiseAlert } from "../alerts/alerts.js";

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

// 23/11/2026 -- dos caídas reales del lector de Gmail: 17/11 "invalid_grant"
// (token de Google caducado) y 20/11 "Quota exceeded", 25 fallos seguidos cada
// una (uno cada 30 s durante ~12 min). Insistir cada 30 s no arregla ninguna
// de las dos y la de cuota la agrava. Ahora: cuota -> pausa de 15 min con
// espera creciente; token caducado -> pausa de 30 min y un aviso claro al
// equipo (reconectar Google en Integraciones), una sola vez.
let googleCooldownUntil = 0;
let quotaStrikes = 0;
function googleFailureCooldown(message: string): { ms: number; kind: "token" | "cuota" } | null {
  if (/invalid_grant|google_token_refresh_failed/i.test(message)) return { ms: 30 * 60 * 1000, kind: "token" };
  if (/google_api_(403|429)|quota|rate.?limit/i.test(message)) {
    quotaStrikes = Math.min(quotaStrikes + 1, 4);
    return { ms: 5 * 60 * 1000 * quotaStrikes, kind: "cuota" };
  }
  return null;
}
function looksLikeQuotaError(message: string | undefined): boolean {
  return Boolean(message) && /llm_http_429|insufficient_quota|rate_limit|daily_llm_budget_exceeded/i.test(message!);
}

// Revisa la bandeja del negocio cada 30 segundos. Sin Google conectado no hace nada.
// La deduplicación la lleva processInboundEmail, porque Gmail no nos deja marcar
// los correos como leídos sin el ámbito gmail.modify.
export function startEmailPoller() {
  setInterval(async () => {
    if (running || !isGoogleConnected()) return;
    if (Date.now() < quotaCooldownUntil || Date.now() < googleCooldownUntil) return;
    running = true;
    // Bloqueo en disco además de la bandera de memoria (09/11/2026): con dos
    // procesos, los dos sondearían Gmail a la vez y podrían procesar el mismo
    // correo. Si otro ya está sondeando, este ciclo se salta.
    const tomado = await withPersistentLockOrSkip("email_poller", async () => {
    try {
      // REGLA DE RAMÓN: Daniel solo abre correos de Coches.net y Wallapop.
      // Gmail ni siquiera lista los demás -> nunca se tocan.
      const list = await gmailListUnread("(from:coches.net OR from:wallapop.com)");
      quotaStrikes = 0;
      const items = list.slice(0, BATCH);
      for (let i = 0; i < items.length; i++) {
        const m = await gmailGet(items[i].id);
        // REGLA DE RAMÓN (26/11/2026, queja real del cliente): Daniel SOLO
        // abre/lee/marca y responde correos de Coches.net y Wallapop. Cualquier
        // otro correo (privado del concesionario, cliente directo, proveedor...)
        // NO se toca: ni se procesa, ni se marca como leído -- se deja intacto y
        // sin leer para que lo gestione el equipo. Doble barrera: la consulta de
        // gmailListUnread ya filtra por esos remitentes; aquí se reconfirma por
        // si algo se colara (gmailGet no marca como leído, así que comprobar el
        // remitente aquí nunca "abre" el correo).
        const portalDelRemitente = detectPortal({ from: m.from, subject: m.subject, text: m.text }).portal;
        if (portalDelRemitente !== "Coches.net" && portalDelRemitente !== "Wallapop") {
          continue;
        }
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
        if (result.outcome === "en_cola_fallo_ia" || (result.outcome === "fallo_ia_pendiente_revision" && looksLikeQuotaError(result.error))) {
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
      // Cola real de correos frenados por tope diario (Opción A, 05/11/2026):
      // se drena al final de cada ciclo, después de la bandeja nueva --
      // mismo "running" de arriba ya evita que dos ciclos se solapen.
      await drainPendingEmailQueue();
    } catch (err) {
      // (el bloqueo en disco se libera solo al salir del callback)
      // Fallo real detectado (03/11/2026, incidente real: el sondeo fallaba
      // en silencio -- un error aquí (lectura de Gmail, no solo el envío de
      // la respuesta) solo se veía en console.error, invisible desde fuera
      // del contenedor. No había forma de confirmar desde el CRM si el
      // sondeo seguía vivo o lleva horas fallando siempre igual.
      const message = err instanceof Error ? err.message : String(err);
      console.error("[email] poll:", err);
      const frenar = googleFailureCooldown(message);
      if (frenar) {
        googleCooldownUntil = Date.now() + frenar.ms;
        console.warn(`[email] Google falló (${frenar.kind}) -- pausa de ${Math.round(frenar.ms / 60000)} min en vez de reintentar cada 30 s.`);
        try {
          raiseAlert({
            kind: "fallo_tecnico",
            reason:
              frenar.kind === "token"
                ? "Gmail dejó de leer correos: el permiso de Google caducó. Hay que reconectar Google en CRM > Integraciones; hasta entonces los correos de Coches.net y Wallapop no se atienden."
                : "Gmail alcanzó su límite de consultas; el lector de correo se pausa unos minutos y reintenta solo.",
          });
        } catch { /* un aviso fallido no debe romper el sondeo */ }
      }
      try {
        const errors = readCollection<{ id: string; message: string; at: string }>("email_poller_errors");
        writeCollection("email_poller_errors", [...errors, { id: crypto.randomUUID(), message, at: new Date().toISOString() }].slice(-50));
      } catch {
        // Si ni esto se puede escribir, no hay nada más que hacer aquí --
        // el console.error de arriba ya se intentó, no se vuelve a fallar
        // en cascada por culpa del propio registro del fallo.
      }
    }
    });
    if (tomado === null) console.log("[email] otro proceso ya está sondeando, se salta este ciclo.");
    running = false;
  }, INTERVAL_MS);
}
