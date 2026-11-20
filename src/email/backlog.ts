// Candidatos reales sin responder (20/11/2026): el poller normal solo ve
// correos "is:unread" -- uno que un humano abrio y leyo en Gmail antes de
// que Daniel lo viera queda invisible para siempre con ese mecanismo, aunque
// nunca se haya contestado. Esta funcion es la parte PURA y testeable del
// endpoint /admin/email/candidatos_sin_responder: recibe mensajes ya
// obtenidos de Gmail (leidos o no) y decide cuales son candidatos reales,
// sin tocar la red. La llamada real a Gmail (gmailSearch/gmailGet) vive en
// server.ts y, como el resto de funciones de Gmail de este proyecto, no
// tiene test directo porque requeriria red real -- aqui se prueba la parte
// que de verdad decide, con datos reales de disco (email_processed).

import { readCollection } from "../store.js";
import { esAnteriorAlCorte } from "../deploy-safety.js";

export type MensajeGmailCrudo = {
  id: string;
  from: string;
  fromName: string;
  subject: string;
  received_at: string;
  text: string;
  automated: boolean;
};

export type CandidatoSinResponder = {
  id: string;
  from: string;
  from_name: string;
  subject: string;
  received_at: string;
  extracto: string;
  automated: boolean;
};

type Processed = { key: string };

// Nunca reprocesa uno que ya este en email_processed (mismo criterio de
// clave que usa processInboundEmail: `${from}|${messageKey}`), y respeta el
// mismo corte historico vigente (LUCERO_NO_AUTO_BEFORE) que ya protege al
// poller normal -- un candidato anterior al corte nunca se ofrece, aunque
// nunca se haya procesado.
export function filtrarCandidatosSinResponder(mensajes: MensajeGmailCrudo[]): CandidatoSinResponder[] {
  const processed = readCollection<Processed>("email_processed");
  const processedKeys = new Set(processed.map((p) => p.key));
  const candidatos: CandidatoSinResponder[] = [];
  for (const m of mensajes) {
    if (esAnteriorAlCorte(m.received_at)) continue;
    const key = `${m.from}|${m.id}`;
    if (processedKeys.has(key)) continue;
    candidatos.push({
      id: m.id,
      from: m.from,
      from_name: m.fromName,
      subject: m.subject,
      received_at: m.received_at,
      extracto: m.text.slice(0, 220),
      automated: m.automated,
    });
  }
  return candidatos;
}
