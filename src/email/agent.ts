import crypto from "crypto";
import { readCollection, writeCollection } from "../store.js";
import { handleChatMessage } from "../chat/agent.js";
import { isGoogleConnected, sendGmail } from "../integrations/google.js";
import { decideInterest } from "./interest.js";

export type InboundEmail = {
  messageKey: string;
  from: string;
  fromName: string;
  subject: string;
  text: string;
  threadId?: string;
  inReplyTo?: string;
  automated?: boolean;
};

type Processed = { key: string; at: string; outcome: string };
type Outbox = {
  id: string;
  to: string;
  subject: string;
  body: string;
  status: "sent" | "queued" | "failed";
  thread_id?: string;
  error?: string;
  created_at: string;
};

const MAX_PROCESSED_KEPT = 2000;
const SIGNATURE = "Automóviles Lucero";

function replySubject(subject: string): string {
  if (!subject.trim()) return "Re: su consulta";
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

export type EmailDelivery = { status: Outbox["status"]; error?: string };

// Envía por Gmail si está conectado; si no, deja el correo en cola sin darlo por enviado.
export async function deliverEmail(
  to: string,
  subject: string,
  body: string,
  thread?: { threadId: string; inReplyTo: string },
): Promise<EmailDelivery> {
  let delivery: EmailDelivery = { status: "queued" };
  if (isGoogleConnected()) {
    try {
      await sendGmail(to, subject, body, thread);
      delivery = { status: "sent" };
    } catch (err) {
      delivery = { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
  const outbox = readCollection<Outbox>("email_outbox");
  outbox.push({
    id: crypto.randomUUID(),
    to,
    subject,
    body,
    status: delivery.status,
    thread_id: thread?.threadId,
    error: delivery.error,
    created_at: new Date().toISOString(),
  });
  writeCollection("email_outbox", outbox.slice(-500));
  return delivery;
}

export async function processInboundEmail(email: InboundEmail): Promise<{ outcome: string; reply?: string; error?: string }> {
  const looksAutomated = /no-?reply|mailer-daemon|postmaster|do-?not-?reply/i.test(email.from);
  if (email.automated || looksAutomated || !email.from.includes("@")) {
    return { outcome: "skipped_automated" };
  }
  const processed = readCollection<Processed>("email_processed");
  if (processed.some((p) => p.key === `${email.from}|${email.messageKey}`)) {
    return { outcome: "duplicate" };
  }

  const priorThread = processed.some((p) => p.key.startsWith(`${email.from}|`) && p.outcome !== "automated_no_reply");
  const decision = decideInterest({ subject: email.subject, text: email.text, hasPriorThread: priorThread });
  if (!decision.interested) {
    const review = readCollection<{ id: string; from: string; subject: string; reason: string; created_at: string }>("email_review");
    review.push({ id: crypto.randomUUID(), from: email.from, subject: email.subject, reason: decision.reason, created_at: new Date().toISOString() });
    writeCollection("email_review", review.slice(-500));
    writeCollection("email_processed", [...processed, { key: `${email.from}|${email.messageKey}`, at: new Date().toISOString(), outcome: "automated_no_reply" }].slice(-MAX_PROCESSED_KEPT));
    return { outcome: "automated_no_reply" };
  }

  const userText = `Asunto: ${email.subject || "(sin asunto)"}\n\n${email.text}`.trim();
  const { reply } = await handleChatMessage(`mail:${email.from}`, userText, "EMAIL", email.from);
  const body = `${reply}\n\n${SIGNATURE}`;
  const subject = replySubject(email.subject);

  const delivery = await deliverEmail(
    email.from,
    subject,
    body,
    email.threadId && email.inReplyTo ? { threadId: email.threadId, inReplyTo: email.inReplyTo } : undefined,
  );
  const status = delivery.status;
  const error = delivery.error;

  const outcome = status === "failed" ? "send_failed" : status === "sent" ? "sent" : "queued_no_google";
  writeCollection("email_processed", [...processed, { key: `${email.from}|${email.messageKey}`, at: new Date().toISOString(), outcome }].slice(-MAX_PROCESSED_KEPT));

  return { outcome, reply: body, error };
}
