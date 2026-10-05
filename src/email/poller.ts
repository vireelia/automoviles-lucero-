import { isGoogleConnected, gmailListUnread, gmailGet } from "../integrations/google.js";
import { processInboundEmail } from "./agent.js";

const INTERVAL_MS = 3 * 60 * 1000;
const BATCH = 10;
let running = false;

// Revisa la bandeja del negocio cada 3 minutos. Sin Google conectado no hace nada.
// La deduplicación la lleva processInboundEmail, porque Gmail no nos deja marcar
// los correos como leídos sin el ámbito gmail.modify.
export function startEmailPoller() {
  setInterval(async () => {
    if (running || !isGoogleConnected()) return;
    running = true;
    try {
      const list = await gmailListUnread();
      for (const item of list.slice(0, BATCH)) {
        const m = await gmailGet(item.id);
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
      }
    } catch (err) {
      console.error("[email] poll:", err);
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
}
