import crypto from "crypto";
import dns from "dns";
import { readCollection, writeCollection, mutateCollection, mutateCollectionSync } from "../store.js";
import { esAnteriorAlCorte } from "../deploy-safety.js";
import { handleChatMessage, recordAssistantMessage, FALLBACK_REPLY } from "../chat/agent.js";
import { buildFirstContactText, alreadyContacted, markContacted } from "../chat/first-contact.js";
import { dentroDeVentana, contactoAutorizado } from "../chat/whatsapp-window.js";
import { withPersistentLock } from "../locks.js";
import { createAutoTask } from "../tools/tasks.js";

// Interruptor del primer contacto automático: apagado salvo autorización
// explícita (LUCERO_FIRST_CONTACT_ENABLED=1). Apagado, deja el texto como nota.
function isFirstContactEnabled(): boolean {
  return process.env.LUCERO_FIRST_CONTACT_ENABLED === "1";
}
import { isGoogleConnected, sendGmail, googleStatus } from "../integrations/google.js";
import { decideInterest, detectPortal, WHATSAPP_ONLY_REQUEST, extractCochesNetContact, extractCochesNetClientIdentity, isCochesNetSharedSender, extractWallapopContact } from "./interest.js";
import { raiseAlert } from "../alerts/alerts.js";
import { isEmailAutoSendEnabled, isEmailContactPaused } from "../tools/agent-toggle.js";
import { upsertLead } from "../tools/leads.js";
import { sendWhatsappText, isWhatsappConnected, explainWhatsappSendError } from "../integrations/whatsapp.js";
import { isContactoInicialTemplateApproved, sendZernioWhatsappVehicleContactTemplate } from "../integrations/zernio.js";

export type InboundEmail = {
  messageKey: string;
  from: string;
  fromName: string;
  subject: string;
  text: string;
  threadId?: string;
  inReplyTo?: string;
  automated?: boolean;
  // Fecha real de recepción (internalDate de Gmail) -- distinta de cuándo lo
  // procesó el sistema. Ver received_at en recordInbox más abajo.
  receivedAt?: string;
};

type Processed = { key: string; at: string; outcome: string; threadId?: string };
// Cola real de correos que no se pudieron redactar por tope diario (Opción A
// aprobada, 05/11/2026 -- "se esta gastando demasiado dinero" + hallazgo real:
// 618 correos de un solo día llamaban a la IA SABIENDO que no se iban a poder
// enviar por tope). Guarda el correo original, SIN llamar a la IA todavía --
// se reintenta solo (vía drainPendingEmailQueue, llamado por el poller) en
// cuanto vuelve a haber cupo real de envío. No se marca en "email_processed"
// al encolar (a propósito: así processInboundEmail puede reprocesarlo desde
// cero más tarde sin que el propio dedupe lo descarte como "duplicate").
type PendingQueueItem = {
  key: string;
  email: InboundEmail;
  priority: number;
  enqueued_at: string;
  // Opción B aprobada (05/11/2026): reintentos con backoff ante un fallo
  // real de la IA al reprocesar -- nunca al encolar por tope diario (eso no
  // es un fallo, es simplemente esperar cupo).
  ai_failure_attempts: number;
  last_ai_error?: string;
  next_retry_at: string; // Siempre <= ahora si no hay fallos de IA todavía.
};
const PENDING_QUEUE_COLLECTION = "email_pending_queue";
const MAX_QUEUE_KEPT = 2000;
// Backoff exponencial real, con tope (nunca un bucle infinito de reintentos
// instantáneos): 1, 2, 4, 8, 16 minutos, luego siempre 30 min.
const RETRY_BACKOFF_MINUTES = [1, 2, 4, 8, 16, 30];
// A partir de este número de fallos consecutivos de IA seguidos para el
// MISMO correo, se avisa al equipo (una vez, con el dedup real que ya tiene
// raiseAlert) -- el correo sigue pendiente, nunca se descarta.
const AI_FAILURE_ALERT_THRESHOLD = 3;
const MAX_AI_FAILURE_ATTEMPTS = 6;

// Prioridad real (petición: "prioriza reservas, citas, financiación y
// clientes con intención real de compra") -- heurística por palabras clave,
// deliberadamente sin IA (encolar no puede depender de lo que precisamente
// no se puede llamar todavía). 2 = prioridad alta, 1 = normal.
// Marca un correo como procesado de forma transaccional (09/11/2026,
// auditoría de concurrencia). Antes había 14 sitios haciendo
// `writeCollection("email_processed", [...processed, nuevo])` con un
// `processed` leído al principio de la función: si entre la lectura y la
// escritura otro correo se marcaba, esa marca se perdía -- y un correo sin
// marca se vuelve a procesar y se le CONTESTA OTRA VEZ al cliente.
// mutateCollection relee dentro del bloqueo, así que ninguna marca se pierde.
async function marcarProcesado(email: InboundEmail, outcome: string): Promise<void> {
  await mutateCollection<Processed>("email_processed", (items) => {
    const key = `${email.from}|${email.messageKey}`;
    const sinEsta = items.filter((p) => p.key !== key);
    sinEsta.push({ key, at: new Date().toISOString(), outcome, threadId: email.threadId });
    return sinEsta.slice(-MAX_PROCESSED_KEPT);
  });
}

function pendingEmailPriority(email: InboundEmail): number {
  return /reserva|reservar|cita|visita|financiaci[oó]n|señal|pagar|comprar|interesad[oa]/i.test(`${email.subject}\n${email.text}`) ? 2 : 1;
}

function enqueuePendingEmail(email: InboundEmail): void {
  const key = `${email.from}|${email.messageKey}`;
  const queue = readCollection<PendingQueueItem>(PENDING_QUEUE_COLLECTION);
  if (queue.some((q) => q.key === key)) return; // Idempotencia real: ya está en cola, no se duplica.
  queue.push({ key, email, priority: pendingEmailPriority(email), enqueued_at: new Date().toISOString(), ai_failure_attempts: 0, next_retry_at: new Date().toISOString() });
  writeCollection(PENDING_QUEUE_COLLECTION, queue.slice(-MAX_QUEUE_KEPT));
}

// Re-encola tras un fallo REAL de la IA (distinto de encolar por tope
// diario): sube el contador de intentos, calcula el próximo reintento con
// backoff exponencial real, y avisa al equipo una sola vez al cruzar el
// umbral -- el correo sigue en la cola, nunca se marca como resuelto.
function requeueAfterAiFailure(item: PendingQueueItem, error: string | undefined): void {
  const attempts = item.ai_failure_attempts + 1;
  const minutes = RETRY_BACKOFF_MINUTES[Math.min(attempts - 1, RETRY_BACKOFF_MINUTES.length - 1)];
  const nextRetryAt = new Date(Date.now() + minutes * 60_000).toISOString();
  const queue = readCollection<PendingQueueItem>(PENDING_QUEUE_COLLECTION);
  if (attempts >= MAX_AI_FAILURE_ATTEMPTS) {
    raiseAlert({ kind: "gestion_portal", reason: `Correo de ${item.email.from} ("${item.email.subject}") sin respuesta tras ${attempts} fallos de la IA -- se saca de la cola, contéstalo a mano.` });
    return;
  }
  queue.push({ ...item, ai_failure_attempts: attempts, last_ai_error: error ?? "desconocido", next_retry_at: nextRetryAt });
  writeCollection(PENDING_QUEUE_COLLECTION, queue.slice(-MAX_QUEUE_KEPT));
  console.warn(`[email-queue] fallo real de IA #${attempts} para ${item.key} -- próximo reintento en ${minutes} min.`);
  if (attempts >= AI_FAILURE_ALERT_THRESHOLD) {
    raiseAlert({
      kind: "gestion_portal",
      reason: `Correo en cola (tope diario) lleva ${attempts} fallos reales seguidos de la IA al reprocesarse -- sigue pendiente de verdad, revisa si el crédito/servicio de OpenAI está caído.`,
    });
  }
}

// Llamado por el poller de correo (ver email/poller.ts) en cada ciclo, DESPUÉS
// de procesar la bandeja nueva -- drena la cola real mientras quede cupo de
// envío de verdad hoy. Un solo correo a la vez, reintenta el siguiente ciclo
// si algo falla real (nunca se pierde el correo original: se vuelve a
// encolar en vez de descartarlo). Control de concurrencia real: el poller ya
// serializa sus propios ciclos con su bandera "running" (ver poller.ts) -- un
// único proceso Node, nunca dos llamadas a esto a la vez.
export async function drainPendingEmailQueue(): Promise<void> {
  for (;;) {
    if (sentTodayCount() >= DAILY_SEND_CAP) return;
    const now = Date.now();
    // Solo candidatos cuyo backoff ya pasó -- un correo con fallos reales
    // recientes se salta hasta que le toque, nunca se reintenta a lo loco.
    const queue = readCollection<PendingQueueItem>(PENDING_QUEUE_COLLECTION);
    // Barrera de activación (10/11/2026, LUCERO_NO_AUTO_BEFORE): nunca
    // reenviar solo nada encolado antes del corte.
    const ready = queue.filter((q) => new Date(q.next_retry_at).getTime() <= now && !esAnteriorAlCorte(q.enqueued_at));
    if (ready.length === 0) return;
    ready.sort((a, b) => b.priority - a.priority || (a.enqueued_at < b.enqueued_at ? -1 : a.enqueued_at > b.enqueued_at ? 1 : 0));
    const next = ready[0];
    // Se saca de la cola ANTES de procesar -- si falla a mitad, se vuelve a
    // encolar explícitamente abajo (con el contador de intentos ya subido),
    // nunca se queda duplicado en la cola.
    writeCollection(PENDING_QUEUE_COLLECTION, queue.filter((q) => q.key !== next.key));
    try {
      const result = await processInboundEmail(next.email, { detectAiFailureForQueue: true });
      // FALLO REAL detectado en pruebas locales (05/11/2026): un fallo de la
      // IA aquí NUNCA lanza una excepción -- processInboundEmail lo captura
      // por su cuenta y devuelve el resultado como si fuera normal (ver su
      // propio try/catch alrededor de handleChatMessage, mismo criterio que
      // el correo directo). Un try/catch aquí nunca lo veía, así que el
      // correo se perdía de la cola sin reintentarse jamás. Hay que mirar
      // también el "outcome" devuelto, no solo las excepciones reales.
      if (result.outcome === "fallo_ia_pendiente_revision") {
        requeueAfterAiFailure(next, result.error);
        return; // Evita un bucle rápido de reintento si el fallo es persistente (p. ej. IA caída).
      }
    } catch (err) {
      requeueAfterAiFailure(next, err instanceof Error ? err.message : String(err));
      return; // Evita un bucle rápido de reintento si el fallo es persistente (p. ej. IA caída).
    }
  }
}
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

// Tope diario de correos automáticos (18/10/2026, mismo encargo que el
// espaciado del poller: "que cumpla tiempos para que no sea baneado por
// Gmail"). Una cuenta de Gmail normal (no Workspace) no tiene un límite
// publicado tan generoso como Workspace -- un pico real de correos (una
// avería del feed, una promoción que dispara contactos) podría mandar
// decenas de respuestas casi idénticas en poco tiempo. Por encima de este
// tope, el correo se redacta igual mente pero se deja en Pendientes para
// que el equipo lo revise y lo mande a mano, igual que ya hace el modo de
// prueba -- nunca se bloquea al cliente, solo se frena el automatismo.
const DAILY_SEND_CAP = Number(process.env.GMAIL_DAILY_SEND_CAP ?? 60);

function sentTodayCount(): number {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
  return readCollection<Outbox>("email_outbox").filter(
    (o) => o.status === "sent" && o.created_at.slice(0, 10) === today,
  ).length;
}

function replySubject(subject: string): string {
  if (!subject.trim()) return "Re: su consulta";
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

export type EmailDelivery = { status: Outbox["status"]; error?: string };

// Comprueba que el dominio del destinatario admite correo real antes de
// intentar un envío (26/10/2026, "estan saliendo muchos errores de
// correos" -- rebote real confirmado por Eliud: "Tu mensaje no se ha
// entregado a mail@info.auto1.com porque no se ha encontrado el dominio").
// Gmail SÍ acepta el envío (no lanza error aquí), pero el rebote real llega
// después al buzón del negocio, invisible para esta app -- de ahí que
// pareciera un fallo sin explicación. Mismo fallback que usa el propio
// SMTP (RFC 5321): si no hay MX, se admite por A/AAAA -- comprobar solo MX
// daría falsos negativos en dominios pequeños sin MX explícito.
async function hasMailServer(email: string): Promise<boolean> {
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain) return false;
  try {
    const mx = await dns.promises.resolveMx(domain);
    if (mx.length > 0) return true;
  } catch {
    // Sin MX -- se prueba el resto de abajo antes de rendirse.
  }
  try {
    await dns.promises.resolve(domain);
    return true;
  } catch {
    return false;
  }
}

// Envía por Gmail si está conectado; si no, deja el correo en cola sin darlo por enviado.
export async function deliverEmail(
  to: string,
  subject: string,
  body: string,
  thread?: { threadId: string; inReplyTo: string },
): Promise<EmailDelivery> {
  let delivery: EmailDelivery = { status: "queued" };
  if (isGoogleConnected()) {
    if (!(await hasMailServer(to))) {
      delivery = { status: "failed", error: "El dominio de destino no tiene servidor de correo real -- no se ha intentado enviar, para no generar un rebote en el buzón real." };
    } else {
      try {
        await sendGmail(to, subject, body, thread);
        delivery = { status: "sent" };
      } catch (err) {
        delivery = { status: "failed", error: err instanceof Error ? err.message : String(err) };
      }
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

type InboxItem = {
  id: string;
  from: string;
  subject: string;
  text: string;
  outcome: string;
  portal?: string | null;
  draft_note?: string;
  thread_id?: string;
  in_reply_to?: string;
  // Módulo CRM mensajes/clientes (18/10/2026): "leído" y "respondido" son dos
  // estados distintos -- un correo puede leerse sin que nadie (ni la IA) lo
  // haya contestado. `answered_by` distingue si respondió la IA sola o una
  // persona del equipo desde /crm/correos.
  read?: boolean;
  answered?: boolean;
  answered_by?: "ia" | "equipo";
  // Añadido (03/11/2026, incidente real: ver fallo_ia_pendiente_revision
  // más abajo) -- solo para poder detectar si ya se avisó de este mismo
  // correo en un reintento anterior del sondeo, sin tocar el resto de
  // registros existentes (opcional, nunca se asume presente).
  message_key?: string;
  created_at: string;
  received_at?: string | null;
};

function recordInbox(
  email: InboundEmail,
  outcome: string,
  extra?: { portal?: string | null; draftNote?: string; answered?: boolean; answeredBy?: "ia" | "equipo"; messageKey?: string },
) {
  // Bajo bloqueo (09/11/2026, auditoría de concurrencia): recordInbox,
  // sendPendingDailyCapEmails y la ruta de contención de disculpas escriben
  // los tres "email_inbox" desde ciclos distintos (sondeo de correo,
  // programador, admin). Sin un bloqueo compartido, uno podía reescribir
  // encima de un correo que el otro acababa de añadir o retener.
  mutateCollectionSync<InboxItem>("email_inbox", (inbox) => {
  inbox.push({
    id: crypto.randomUUID(),
    from: email.from,
    subject: email.subject,
    // FALLO REAL detectado (27/10/2026, "esto se ve así... no solo en una
    // conversación, en todas"): 2000 caracteres parecía de sobra, pero las
    // notificaciones reales de "nueva solicitud por WhatsApp" de Coches.net
    // llevan un enlace wa.me larguísimo ANTES del bloque JSON real -- 17 de
    // 19 correos reales de ese tipo ya llegaban exactos a 2000, cortando el
    // bloque JSON a la mitad y rompiendo parseCochesNetJsonBlock, así que
    // se mostraban en bruto en vez de limpios. Subido a un límite real que
    // sí cubre esos correos completos.
    text: email.text.slice(0, 8000),
    outcome,
    portal: extra?.portal ?? null,
    draft_note: extra?.draftNote,
    thread_id: email.threadId,
    in_reply_to: email.inReplyTo,
    answered: extra?.answered ?? false,
    answered_by: extra?.answered ? (extra?.answeredBy ?? "ia") : undefined,
    message_key: extra?.messageKey,
    created_at: new Date().toISOString(),
    // "de donde sacaste tantos correos" (03/11/2026): created_at es cuándo
    // el sistema PROCESÓ el correo, no cuándo llegó de verdad -- si hay
    // backlog real de correos viejos, se procesan hoy pero no llegaron hoy.
    // received_at es la fecha real (internalDate de Gmail), para no volver a
    // confundir "procesado hoy" con "llegado hoy".
    received_at: email.receivedAt ?? null,
  });
  return inbox.slice(-500);
  });
}

// Factorizado (28/10/2026, "que Daniel coja ese número y los datos del
// coche y Carolina le contacte por WhatsApp directamente"): este era el
// cuerpo real de la rama "SOLO por WhatsApp" de Coches.net (16/10/2026),
// ahora reutilizado también para Wallapop -- mismo camino real probado
// (abrir con la plantilla aprobada si hace falta, mandar la respuesta
// real después), solo cambia el portal y el texto de la nota del lead.
async function contactLeadViaWhatsapp(
  email: InboundEmail,
  processed: Processed[],
  contact: { phone: string; name: string | null; make: string | null; model: string | null; version: string | null; inquiry: string | null },
  portal: string,
): Promise<{ outcome: string; reply?: string; error?: string }> {
  const waPhone = contact.phone.startsWith("+") ? contact.phone : `+${contact.phone}`;
  const vehicleLabel = [contact.make, contact.model, contact.version].filter(Boolean).join(" ");
  const leadRes = upsertLead({
    phone: waPhone,
    name: contact.name ?? undefined,
    channel: "WHATSAPP",
    vehicle_interest: vehicleLabel || undefined,
    notes: `Pidió explícitamente que le contacten por WhatsApp (aviso real de ${portal}).`,
  }) as { data?: { id?: string } };
  // FASE 1 (09/11/2026): primer contacto con plantilla fija, sin IA. Antes
  // cada aviso de portal lanzaba una conversación completa de la IA (720
  // leads el 05/11 = la mayor parte del gasto) y, sin crédito, enviaba la
  // disculpa genérica al cliente.
  if (alreadyContacted(waPhone, vehicleLabel || null)) {
    recordInbox(email, "duplicado_primer_contacto", { portal });
    await marcarProcesado(email, "duplicado_primer_contacto");
    return { outcome: "duplicado_primer_contacto" };
  }
  const firstContact = { leadId: leadRes.data?.id ?? waPhone, phone: waPhone, name: contact.name, vehicle: vehicleLabel || null, portal };
  const reply = buildFirstContactText(firstContact);

  // PUNTO 10 (09/11/2026): que la plantilla esté aprobada no autoriza a
  // escribir a cualquiera. Si el contacto pidió no recibir mensajes o
  // prefiere otro canal, no se le escribe: pasa a revisión humana.
  const autorizacion = contactoAutorizado(waPhone);
  if (!autorizacion.ok) {
    recordInbox(email, "contacto_no_autorizado", { portal, draftNote: `No se le escribe por WhatsApp (${autorizacion.motivo}). Texto que se habría enviado:\n${reply}` });
    await marcarProcesado(email, "contacto_no_autorizado");
    createAutoTask({
      lead_phone: waPhone,
      type: "contactar_whatsapp",
      reason: `${portal}: pidió contacto por WhatsApp pero no está autorizado automáticamente (${autorizacion.motivo}). Decide tú si escribirle: https://wa.me/${contact.phone}`,
      source_ref: `no_autorizado_${email.messageKey}`,
      channel: "WHATSAPP",
    });
    return { outcome: "contacto_no_autorizado" };
  }

  if (!isFirstContactEnabled()) {
    recordInbox(email, "modo_prueba_sin_envio", { portal, draftNote: reply });
    await marcarProcesado(email, "modo_prueba_sin_envio");
    return { outcome: "modo_prueba_sin_envio", reply };
  }

  // PUNTO 4 (09/11/2026): antes, cuando hacía falta la plantilla, salían DOS
  // mensajes casi idénticos seguidos -- la plantilla de Meta ya dice "Hola,
  // le escribe Automóviles Lucero. Vimos su interés en el {{1}}. Escríbanos
  // por aquí... para agendar una visita", y justo detrás iba nuestro primer
  // contacto diciendo lo mismo. Ahora se elige UNA sola vía:
  //   - ventana de 24h abierta -> texto libre propio (más concreto)
  //   - ventana cerrada        -> solo la plantilla (es la única que Meta deja)
  // Nunca las dos.
  const ventanaAbierta = dentroDeVentana(waPhone);
  const sent = ventanaAbierta && isWhatsappConnected() ? await sendWhatsappText(waPhone, reply) : { ok: false as const, error: ventanaAbierta ? "whatsapp_not_connected" : "sin_conversacion_abierta" };
  if (sent.ok) {
    markContacted(firstContact);
    recordAssistantMessage(waPhone, reply);
  }

  if (sent.ok) {
    // Fallo real detectado (03/11/2026, petición real: "cuando los agentes
    // se vayan quitando los leads o respondiendo, que se marquen en el CRM
    // como respondidos"): este envío SÍ llegó de verdad al cliente por
    // WhatsApp, pero recordInbox nunca recibía answered/answered_by -- el
    // mensaje se quedaba para siempre como si nadie lo hubiera contestado,
    // aunque Carolina ya lo hizo. Mismo criterio que el envío directo por
    // correo más abajo (outcome "sent"): solo se marca cuando de verdad se
    // entregó, nunca al fallar.
    recordInbox(email, "sent_whatsapp_automatico", { portal, answered: true, answeredBy: "ia" });
    await marcarProcesado(email, "sent_whatsapp_automatico");
    return { outcome: "sent_whatsapp_automatico", reply };
  }

  // FALLO REAL detectado (03/11/2026, "hay varios clientes así" -- varios
  // clientes reales se quedaban sin la plantilla aunque SÍ estaba aprobada):
  // esto exigía vehicleLabel no vacío para intentar la plantilla -- si el
  // aviso del portal no traía marca/modelo claros (vacío), se saltaba la
  // plantilla del todo y caía directo al aviso de "escribir a mano", aunque
  // la plantilla habría funcionado igual con un texto genérico. Ya no exige
  // vehicleLabel -- usa un texto genérico cuando no hay uno real.
  if (await isContactoInicialTemplateApproved()) {
    const templateSent = await sendZernioWhatsappVehicleContactTemplate(waPhone, vehicleLabel || "el vehículo que consultaste");
    if (templateSent.ok) {
      // La plantilla YA es el primer contacto completo (se presenta, nombra
      // el vehículo e invita a escribir para agendar la visita), así que no
      // se manda nada más detrás. Cuando el cliente responda, se abre la
      // ventana de 24h y Carolina sigue la conversación con normalidad.
      markContacted(firstContact);
      recordAssistantMessage(waPhone, `(plantilla de primer contacto enviada sobre ${vehicleLabel || "el vehículo consultado"})`);
      recordInbox(email, "sent_whatsapp_plantilla", { portal, answered: true, answeredBy: "ia" });
      await marcarProcesado(email, "sent_whatsapp_plantilla");
      return { outcome: "sent_whatsapp_plantilla" };
    }
  }

  const failReason = explainWhatsappSendError(sent.error);
  const draftNote = `El envío automático por WhatsApp falló: ${failReason} -- escribirle a mano: https://wa.me/${contact.phone}\n\nRespuesta ya redactada, lista para copiar:\n${reply}`;
  recordInbox(email, "pendiente_whatsapp_manual", { portal, draftNote });
  await marcarProcesado(email, "pendiente_whatsapp_manual");
  raiseAlert({ kind: "gestion_portal", lead_phone: waPhone, name: contact.name, reason: `${portal}: cliente pidió contacto SOLO por WhatsApp -- el envío automático falló: ${failReason}. Escribirle a mano: https://wa.me/${contact.phone}`, draft_note: draftNote });
  return { outcome: "pendiente_whatsapp_manual" };
}

// Segundo parámetro (opcional, 05/11/2026, opción B aprobada): SOLO lo usa
// drainPendingEmailQueue (ver más abajo) al reprocesar un correo que ya
// estaba en la cola real por tope diario. El correo directo normal (el
// camino de siempre, sin este flag) se comporta EXACTAMENTE igual que
// antes -- nunca se toca ese caso.
export async function processInboundEmail(
  email: InboundEmail,
  opts?: { detectAiFailureForQueue?: boolean },
): Promise<{ outcome: string; reply?: string; error?: string }> {
  // FALLO REAL grave detectado (15/10/2026): el correo de prueba "Probar
  // Gmail" (que se envía desde la propia cuenta conectada A SÍ MISMA) se
  // coló como si fuera un cliente nuevo, y cada respuesta automática volvía
  // a aparecer como correo "nuevo" en la siguiente pasada del poller (cada 3
  // minutos) -- bucle infinito de autorespuestas, confirmado en producción
  // real. Guarda de seguridad obligatoria: un correo que viene de la propia
  // cuenta del negocio NUNCA se procesa ni se contesta, pase lo que pase.
  const ownEmail = googleStatus().connected_email;
  if (ownEmail && email.from.toLowerCase() === ownEmail.toLowerCase()) {
    return { outcome: "skipped_self_email" };
  }
  const processed = readCollection<Processed>("email_processed");
  const fromQueue = opts?.detectAiFailureForQueue === true;
  // Reclamo atómico entre procesos (09/11/2026): si dos sondeos coinciden
  // (dos instancias), leer-comprobar-escribir por separado dejaba procesar y
  // CONTESTAR el mismo correo dos veces. El bloqueo cubre la comprobación y
  // la marca juntas. Un reproceso desde la cola sí puede volver a entrar.
  const yaProcesado = await withPersistentLock(
    "col_email_processed",
    () => readCollection<Processed>("email_processed").some((p) => p.key === `${email.from}|${email.messageKey}` && !(fromQueue && p.outcome === "en_cola_fallo_ia")),
    15_000,
  ).catch(() => processed.some((p) => p.key === `${email.from}|${email.messageKey}` && !(fromQueue && p.outcome === "en_cola_fallo_ia")));
  if (yaProcesado) {
    return { outcome: "duplicate" };
  }
  // Barrera de activación (10/11/2026, LUCERO_NO_AUTO_BEFORE): antes de
  // cualquier respuesta o primer contacto automático, usando la fecha REAL
  // de recepción del correo (receivedAt, internalDate de Gmail) -- nunca la
  // fecha en que el poller lo procesó. Un correo anterior al corte nunca se
  // contesta solo ni dispara un primer contacto -- queda registrado para
  // revisión humana, nunca se pierde ni se borra.
  if (esAnteriorAlCorte(email.receivedAt)) {
    recordInbox(email, "retenido_anterior_al_corte", { draftNote: "No contestado automáticamente: este correo es anterior a la fecha de corte de activación (LUCERO_NO_AUTO_BEFORE). Revísalo y respóndelo a mano si corresponde." });
    await marcarProcesado(email, "retenido_anterior_al_corte");
    return { outcome: "retenido_anterior_al_corte" };
  }
  // FALLO REAL grave detectado (16/10/2026): esto va ANTES del filtro de
  // automáticos a propósito -- la dirección de origen de este tipo de aviso
  // de Coches.net puede parecer un no-reply (o llegar recortada por el bug
  // ya corregido), y precisamente por eso se estaba descartando en silencio
  // un cliente real que pidió explícitamente que le contactaran por
  // WhatsApp. Nunca se responde por CORREO aquí -- se registra el teléfono
  // real (viene en el propio JSON del aviso) y, a petición real (16/10/2026,
  // "que el agente de Gmail coja el número y conectado con el agente de
  // WhatsApp, se le envíe un mensaje en automático"), se intenta mandarle un
  // WhatsApp real de verdad con el mismo cerebro que cualquier otro canal.
  // Si el envío real falla (hoy: WhatsApp todavía no está conectado de
  // verdad, número sin verificar -- ver integrations/whatsapp.ts), cae en el
  // mismo aviso manual de siempre para el equipo, pero ya con la respuesta
  // redactada lista para copiar, en vez de una nota en blanco.
  if (WHATSAPP_ONLY_REQUEST.test(email.text)) {
    const contact = extractCochesNetContact(email.text);
    if (contact?.phone) {
      return await contactLeadViaWhatsapp(email, processed, { ...contact, phone: contact.phone }, "Coches.net");
    }
  }

  // Fallo real detectado (03/11/2026, caso real: facturaciononline@adevinta.com
  // -- un documento/factura automática de Adevinta Motor S.L., no un cliente --
  // se trató como consulta real y se le contestó, lo que rebotó con "address
  // not found" porque ese buzón de facturación no acepta respuestas). "factura"
  // en la parte local del remitente nunca es un cliente real escribiendo.
  const looksAutomated = /no-?reply|mailer-daemon|postmaster|do-?not-?reply|factura/i.test(email.from);
  if (email.automated || looksAutomated || !email.from.includes("@")) {
    return { outcome: "skipped_automated" };
  }

  const portalInfo = detectPortal({ from: email.from, subject: email.subject, text: email.text });
  // Decisión real del negocio (15/10/2026, tras el fallo del bucle, y
  // actualizada el mismo día tras desactivar Wallapop -- ver decideInterest
  // en interest.ts para el detalle exacto): el agente de correo SOLO
  // contesta automáticamente consultas reales de Coches.net o de clientes
  // que escriben directo mostrando interés real -- nunca Wallapop (rebota
  // cualquier respuesta), ni bancos, datos personales, publicidad, ni ningún
  // otro tipo de correo sin interés claro. Todo lo demás se registra para
  // revisión humana (/crm/pendientes), nunca se contesta solo.
  // FALLO REAL detectado (15/10/2026): esto comparaba por DIRECCIÓN de
  // remitente -- pero Wallapop/Coches.net mandan TODOS sus avisos (una
  // consulta real, un aviso de seguridad, lo que sea) desde la misma
  // dirección genérica. En cuanto había una conversación real con esa
  // dirección, cualquier correo futuro -- aunque fuera un aviso de cuenta
  // sin relación ninguna -- se trataba como continuación. Ahora se compara
  // por el hilo real de correo (threadId): solo cuenta como "hilo previo"
  // si es literalmente el mismo hilo, nunca por compartir remitente.
  const priorThread = Boolean(email.threadId) && processed.some((p) => p.threadId === email.threadId && p.outcome !== "automated_no_reply");
  const decision = decideInterest({
    from: email.from,
    subject: email.subject,
    text: email.text,
    hasPriorThread: priorThread,
    portal: portalInfo.portal,
  });
  if (!decision.interested) {
    // Sección de Wallapop (28/10/2026, "que Daniel coja ese número y los
    // datos del coche y Carolina le contacte por WhatsApp directamente"):
    // nunca se intenta responder por correo (rebota siempre, confirmado
    // real) -- pero el bloque JSON real del aviso SÍ trae el teléfono, el
    // coche y el mensaje real del cliente (confirmado real tras arreglar
    // plainText en google.ts, que antes lo descartaba entero). Mismo
    // camino real ya probado con Coches.net: Carolina le escribe por
    // WhatsApp directamente. Solo si de verdad no se puede extraer el
    // teléfono (p. ej. un aviso de seguridad de Wallapop, no un cliente)
    // se queda como aviso para gestionar a mano, nunca se inventa nada.
    if (decision.reason === "wallapop_gestionar_en_portal") {
      const contact = extractWallapopContact(email.text);
      if (contact?.phone) {
        return await contactLeadViaWhatsapp(email, processed, { ...contact, phone: contact.phone }, "Wallapop");
      }
      recordInbox(email, "pendiente_gestion_portal", { portal: portalInfo.portal });
      await marcarProcesado(email, "pendiente_gestion_portal");
      raiseAlert({
        kind: "gestion_portal",
        reason: `Wallapop: nuevo aviso sobre "${email.subject || "tu anuncio"}" sin teléfono real detectado -- revísalo y gestiónalo directamente en Wallapop.`,
      });
      return { outcome: "pendiente_gestion_portal" };
    }
    // Especificación formal (15/10/2026, sección 10: "sin almacenar
    // contenido sensible innecesario"): si el motivo de no contestar es que
    // el correo trae datos sensibles (DNI, IBAN, contraseñas...), el texto
    // real ya cumplió su única función (decidir no responder) -- guardarlo
    // tal cual sería acumular justo el dato que no hace falta conservar.
    const sensitive = decision.reason === "documento_sensible_revision_humana";
    recordInbox(sensitive ? { ...email, text: "[contenido sensible -- no almacenado]" } : email, "automated_no_reply", { portal: portalInfo.portal });
    await marcarProcesado(email, "automated_no_reply");
    // Decisión real (03/11/2026, "solo se tiene que responder mensajes de
    // clientes y enviar avisos de reservas o visitas, no de todoooo"):
    // antes (27/10/2026, caso real del Opel Mokka) esto avisaba al equipo
    // por correo cada vez que un correo ambiguo no se contestaba solo, para
    // no perder un cliente real en silencio -- pero generaba demasiado
    // ruido real (la mayoría de estos casos no son clientes). Se mantiene
    // la cautela de no responder sola ante la duda, y el registro sigue
    // quedando visible en Pendientes dentro del CRM (nada se pierde del
    // todo) -- pero ya no manda un correo de aviso por cada uno.
    return { outcome: "automated_no_reply" };
  }

  // Enriquece el lead con el nombre/correo real que Coches.net ya manda en
  // su propio bloque "client", antes de que corra el agente -- nunca se
  // toca el "phone" del lead (sigue siendo el relay, la clave real), solo
  // se añaden name/email si faltaban. Ver extractCochesNetClientIdentity.
  // FALLO REAL GRAVE detectado (27/10/2026, caso real: Sandra y Fran
  // mezclados en la misma ficha): "email.from" solo es una clave de
  // identidad válida cuando es un relay único por conversación -- cuando
  // es un remitente compartido (isCochesNetSharedSender), usarlo mezcla a
  // TODOS los clientes reales que hayan escrito alguna vez por ahí en una
  // sola ficha y una sola memoria de conversación. En ese caso se usa el
  // correo real del cliente (del propio bloque "client") como clave real
  // -- nunca el remitente compartido.
  // FALLO REAL GRAVE detectado (28/10/2026, captura real de un rebote de
  // Gmail: "Address not found... vehiculosocasion@coches.net... the
  // address couldn't be found"): el comentario de arriba decía que la
  // respuesta por correo "sigue yendo siempre a email.from" -- eso era el
  // propio fallo. Un remitente compartido no es una bandeja real que
  // reciba respuestas (solo sirve para AVISAR al concesionario), así que
  // contestarle ahí rebota siempre, y encima se contaba como "enviado" de
  // verdad porque Gmail sí acepta el envío (el rebote llega después, aparte).
  // Si hay un correo real del cliente en el propio bloque "client", la
  // respuesta va ahí -- nunca al remitente compartido.
  let identityKey = email.from;
  let replyToAddress = email.from;
  let cochesNetIdentity: { name: string | null; email: string | null } | null = null;
  if (portalInfo.portal === "Coches.net") {
    cochesNetIdentity = extractCochesNetClientIdentity(email.text);
    if (isCochesNetSharedSender(email.from) && cochesNetIdentity?.email) {
      identityKey = cochesNetIdentity.email;
      replyToAddress = cochesNetIdentity.email;
    }
    if (cochesNetIdentity?.name || cochesNetIdentity?.email) {
      upsertLead({ phone: identityKey, name: cochesNetIdentity.name ?? undefined, email: cochesNetIdentity.email ?? undefined, channel: "EMAIL" });
    }
  }

  // FALLO REAL grave detectado (05/11/2026, auditoría real de consumo de
  // OpenAI -- "se esta gastando demasiado dinero"): el tope diario se
  // comprobaba SOLO después de llamar a la IA (ver el bloque idéntico más
  // abajo, que se queda como red de seguridad ante una carrera real entre
  // dos correos casi simultáneos) -- confirmado con datos reales: 618
  // correos de un solo día (05/11) llamaron a la IA sabiendo ya que no se
  // iban a poder enviar. Ahora se comprueba ANTES -- si no hay cupo real
  // hoy, el correo original se guarda en una cola real (nunca se pierde,
  // nunca se redacta nada) y se reprocesa solo en cuanto vuelva a haber
  // cupo (ver drainPendingEmailQueue, llamado por el poller).
  if (sentTodayCount() >= DAILY_SEND_CAP) {
    enqueuePendingEmail(email);
    recordInbox(email, "en_cola_tope_diario", { portal: portalInfo.portal });
    raiseAlert({
      kind: "gestion_portal",
      reason: `Se alcanzó el tope diario de ${DAILY_SEND_CAP} correos automáticos -- los correos nuevos quedan en cola real y se redactan/envían solos en cuanto haya cupo, sin gastar de más mientras tanto.`,
    });
    return { outcome: "en_cola_tope_diario" };
  }

  const userText = `Asunto: ${email.subject || "(sin asunto)"}\n\n${email.text}`.trim();
  // FALLO REAL detectado (03/11/2026, incidente real: un correo directo de
  // un cliente real -- no un aviso de portal -- se quedó invisible para
  // siempre mientras el proveedor de IA fallaba (créditos de OpenAI
  // agotados, llm_http_429)) -- hasta aquí, recordInbox() SOLO se llamaba
  // DESPUÉS de generar la respuesta con éxito, así que si handleChatMessage
  // lanzaba un error, el correo nunca se registraba en email_inbox NI en
  // email_processed. El sondeo (cada 30s) lo reintentaba en silencio para
  // siempre, sin que el equipo se enterara nunca -- a diferencia de
  // WhatsApp (zernio-whatsapp en server.ts), que SÍ registra el mensaje
  // ANTES de llamar al agente. Mismo criterio aquí: si falla la IA, se
  // deja constancia honesta ya mismo con el error real y se avisa al
  // equipo -- sin marcar email_processed, a propósito, para que si el
  // fallo es pasajero (p. ej. créditos repuestos) el siguiente sondeo lo
  // intente de verdad y, si sale bien, añada la respuesta real de verdad.
  let reply: string;
  let aiFailedStructured = false;
  try {
    const chatResult = await handleChatMessage(`mail:${identityKey}`, userText, "EMAIL", identityKey);
    reply = chatResult.reply;
    aiFailedStructured = chatResult.ai_failed;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // Aviso de este fallo desactivado (03/11/2026, "quita esa mierda del
    // aviso" -- mismo motivo que arriba: con la IA fallando por créditos
    // agotados, el remitente/asunto cambia en cada correo real y nunca
    // deduplicaba, inundando el correo del equipo). Queda constancia igual
    // en Pendientes vía recordInbox, solo se deja de avisar por este canal.
    recordInbox(email, "fallo_ia_pendiente_revision", { portal: portalInfo.portal, messageKey: email.messageKey });
    return { outcome: "fallo_ia_pendiente_revision", error: errorMessage };
  }
  // Opción B aprobada (05/11/2026), SOLO para reprocesos desde la cola real.
  // Corregido el mismo día a petición explícita ("prefiero una señal de
  // error estructurada y fiable, sin comparar textos"): ya no se compara el
  // texto de la respuesta contra FALLBACK_REPLY (frágil -- cambiaría si se
  // reescribe esa frase, o coincidiría por casualidad) -- se usa el campo
  // real "ai_failed" que handleChatMessage ya devuelve, puesto a propósito
  // (ver chat/agent.ts) SOLO en sus dos casos reales de fallo. Campo
  // puramente aditivo: WhatsApp/Facebook/chat/correo directo (que no pasan
  // este flag) ignoran "ai_failed" y siguen mandando esa misma disculpa de
  // reserva como siempre -- esto no cambia su comportamiento en nada.
  // FASE 1 (09/11/2026): Daniel envió la disculpa genérica 4 veces a clientes
  // reales con OpenAI sin crédito. Ahora un fallo de la IA nunca se envía:
  // el correo directo también entra en la cola de pendientes.
  if (aiFailedStructured) {
    recordInbox(email, "fallo_ia_pendiente_revision", { portal: portalInfo.portal, messageKey: email.messageKey });
    if (opts?.detectAiFailureForQueue) return { outcome: "fallo_ia_pendiente_revision", error: "fallback_detectado_en_cola" };
    enqueuePendingEmail(email);
    await marcarProcesado(email, "en_cola_fallo_ia");
    return { outcome: "en_cola_fallo_ia", error: "ai_failed" };
  }
  const body = `${reply}\n\n${SIGNATURE}`;
  const subject = replySubject(email.subject);

  // Encargo real (14/10/2026, sección 4): si el propio portal (Coches.net,
  // Milanuncios, Wallapop...) exige responder desde su chat/app, contestar
  // por correo a esa notificación no le llega de verdad al comprador --
  // el lead/interés ya queda registrado igual (handleChatMessage ya lo
  // hizo arriba), pero no se envía un correo que nadie va a leer. Se deja
  // la respuesta que se habría mandado como nota, para que el equipo solo
  // tenga que copiarla en el portal en vez de redactarla de cero.
  // FALLO REAL (28/10/2026): si el remitente es compartido y no hay correo
  // real del cliente en el bloque "client" (pasa en los avisos genéricos
  // de "alguien está interesado", que no siempre lo traen), no hay NINGUNA
  // dirección real a la que contestar por correo -- mismo caso que "hay
  // que gestionarlo desde el portal", nunca se envía a ciegas al
  // remitente compartido (rebota siempre, confirmado real).
  const sinDireccionRealDeCliente = portalInfo.portal === "Coches.net" && isCochesNetSharedSender(email.from) && !cochesNetIdentity?.email;
  if (portalInfo.mustManageOnPortal || sinDireccionRealDeCliente) {
    recordInbox(email, "pendiente_gestion_portal", { portal: portalInfo.portal, draftNote: body });
    await marcarProcesado(email, "pendiente_gestion_portal");
    // Mejora real (15/10/2026, a petición de "qué podemos hacer para mejorar
    // eso"): no hay API de mensajería de Wallapop para responder sin más --
    // así que la mejora posible es que el equipo se entere al instante y ya
    // tenga el texto listo para copiar, en vez de depender de que alguien
    // mire Pendientes por su cuenta. Mismo aviso urgente (correo + CRM) que
    // usa el resto del negocio, con el texto de respuesta ya incluido.
    raiseAlert({
      kind: "gestion_portal",
      reason: sinDireccionRealDeCliente
        ? `Coches.net: "${email.subject}" -- aviso genérico sin correo real del cliente, no se puede contestar por correo (rebotaría). Revísalo desde la herramienta profesional de Coches.net.`
        : `${portalInfo.portal ?? "Portal"}: "${email.subject}" -- responde desde la propia app, el correo no le llega al cliente.`,
      draft_note: body,
    });
    return { outcome: "pendiente_gestion_portal", reply: body };
  }

  // Modo de prueba / interruptor de envío automático (15/10/2026,
  // especificación formal, sección 10): con el envío desactivado, el agente
  // sigue clasificando y redactando igual que siempre, pero la respuesta se
  // queda como nota en Pendientes en vez de salir de verdad -- útil para
  // probar cambios de prompt/reglas sin arriesgar un envío real a un cliente.
  if (!isEmailAutoSendEnabled()) {
    recordInbox(email, "modo_prueba_sin_envio", { portal: portalInfo.portal, draftNote: body });
    await marcarProcesado(email, "modo_prueba_sin_envio");
    return { outcome: "modo_prueba_sin_envio", reply: body };
  }

  // Pausa por contacto individual (27/10/2026, "en correos, pon la misma
  // sección que se pueda escribir" -- mismo botón que ya existe en
  // WhatsApp): el canal sigue encendido para todos los demás remitentes,
  // solo este en concreto lo lleva el equipo a mano hasta que lo
  // reactiven desde su ficha en Contactos.
  if (isEmailContactPaused(email.from)) {
    recordInbox(email, "pausado_por_chat", { portal: portalInfo.portal, draftNote: body });
    await marcarProcesado(email, "pausado_por_chat");
    raiseAlert({ kind: "gestion_portal", reason: `Correo: Daniel está pausado para este remitente en concreto -- "${email.subject}" no se respondió. Reactívalo desde su ficha en Contactos cuando quieras.`, draft_note: body });
    return { outcome: "pausado_por_chat", reply: body };
  }

  if (sentTodayCount() >= DAILY_SEND_CAP) {
    recordInbox(email, "tope_diario_alcanzado", { portal: portalInfo.portal, draftNote: body });
    await marcarProcesado(email, "tope_diario_alcanzado");
    // Fallo real detectado (03/11/2026, "arregla eso, me llegó 3 mensajes
    // así"): el motivo incluía el asunto del correo (`"${email.subject}"`),
    // así que cada cliente nuevo que llegaba tras alcanzar el tope
    // generaba un correo DISTINTO (dedup de raiseAlert compara el texto
    // exacto del motivo) -- un aviso por cada cliente atascado, en vez de
    // uno solo avisando que el tope ya se alcanzó hoy. Motivo fijo ahora
    // (sin el asunto) -- el dedup real de 6h de raiseAlert ya colapsa
    // todos los avisos del mismo día en uno. Cada respuesta individual ya
    // queda redactada y visible en Pendientes igualmente, solo deja de
    // generar un correo nuevo por cada una.
    raiseAlert({ kind: "gestion_portal", reason: `Se alcanzó el tope diario de ${DAILY_SEND_CAP} correos automáticos -- hay respuestas ya redactadas esperando en Pendientes. Revísalas en el CRM.`, draft_note: body });
    return { outcome: "tope_diario_alcanzado", reply: body };
  }

  const delivery = await deliverEmail(
    replyToAddress,
    subject,
    body,
    email.threadId && email.inReplyTo ? { threadId: email.threadId, inReplyTo: email.inReplyTo } : undefined,
  );
  const status = delivery.status;
  const error = delivery.error;

  const outcome = status === "failed" ? "send_failed" : status === "sent" ? "sent" : "queued_no_google";
  // FALLO REAL detectado en la auditoría del 18/10/2026 (Fase 3/6: "no
  // considerar un correo contestado solo porque el agente intentó
  // procesarlo"): cuando SÍ se entregó de verdad (outcome "sent"), el correo
  // nunca se marcaba `answered` -- se quedaba para siempre en Pendientes
  // como si nadie hubiera contestado, aunque la IA ya lo hizo y se envió.
  // Solo "sent" cuenta como respondido de verdad; "send_failed" y
  // "queued_no_google" NO se marcan (no llegó al cliente).
  recordInbox(email, outcome, { portal: portalInfo.portal, answered: outcome === "sent", answeredBy: "ia" });
  await marcarProcesado(email, outcome);

  return { outcome, reply: body, error };
}

// FALLO REAL detectado (21/10/2026, "los chicos de Automóviles Lucero no se
// van a poner a enviarles las cosas manuales, créeme"): cuando se alcanza el
// tope diario de correos automáticos, la respuesta ya queda redactada por
// completo -- pero se queda esperando a que alguien entre a Pendientes y
// pulse "Enviar" a mano, uno por uno. En la práctica nadie lo hace, y el
// backlog solo crece (146 correos reales a fecha de hoy).
//
// Esta función recorre ese backlog y los envía ella sola en cuanto hay hueco
// real bajo el tope diario de seguridad (sentTodayCount() sigue mandando --
// nunca se salta el límite que protege la cuenta de Gmail de un bloqueo por
// Google). Se llama desde el scheduler (cada 5 min), así que el backlog se
// vacía solo, un poco cada día, sin que nadie tenga que entrar a hacer clic.
// CONTENCIÓN (09/11/2026). Este proceso vacía solo la cola del tope diario
// enviando el borrador YA GUARDADO, así que no necesita OpenAI: con la IA
// caída el 06/11 se guardaron 386 borradores, 375 de ellos con el texto de
// disculpa, y desde entonces se estaban enviando a clientes reales hasta
// 60/día (confirmado: los "sent" del 7, 8 y 9/11).
//
// La contención es quirúrgica a propósito: NO se apaga el envío (eso dejaría
// también sin enviar los 11 borradores legítimos ni responder a correos
// nuevos). Lo que se hace es no enviar NUNCA un borrador que sea la disculpa
// genérica, ni uno caducado, y pasarlos a revisión humana. No se borra
// ningún correo: cambian de estado y quedan en Pendientes con su texto.
const HORAS_BORRADOR_CADUCADO = 48;

function borradorDefectuoso(m: InboxItem): string | null {
  const draft = m.draft_note ?? "";
  if (draft.includes(FALLBACK_REPLY) || draft.includes("no puedo responderte bien")) return "disculpa_generica_de_ia_caida";
  const horas = (Date.now() - new Date(m.created_at).getTime()) / 3600_000;
  if (horas > HORAS_BORRADOR_CADUCADO) return `borrador_de_hace_${Math.round(horas)}h`;
  return null;
}

export async function sendPendingDailyCapEmails(): Promise<number> {
  if (!isEmailAutoSendEnabled()) return 0; // mismo interruptor de pruebas que el resto del envío automático.

  // Fase 1, retención: solo lectura/escritura de disco (sin red), bajo el
  // mismo bloqueo "col_email_inbox" que usa recordInbox -- ningún correo
  // nuevo que llegue a mitad se pierde ni se pisa.
  let apartados = 0;
  let pendingIds: string[] = [];
  mutateCollectionSync<InboxItem>("email_inbox", (inbox) => {
    const candidatos = inbox.filter((m) => m.outcome === "tope_diario_alcanzado" && !m.answered && m.draft_note);
    for (const m of candidatos) {
      const motivo = borradorDefectuoso(m);
      if (!motivo) continue;
      m.outcome = "retenido_para_revision";
      m.draft_note = `NO ENVIADO (${motivo}). El cliente sigue sin respuesta: contéstale a mano.\n\nTexto que se habría enviado:\n${m.draft_note ?? ""}`;
      apartados++;
      createAutoTask({
        lead_phone: m.from,
        type: "responder_correo",
        reason: `Correo de ${m.from} ("${m.subject || "sin asunto"}") sin responder: el borrador automático era defectuoso (${motivo}). Contéstale a mano.`,
        source_ref: `retenido_${m.id}`,
        channel: "EMAIL",
      });
    }
    pendingIds = candidatos.filter((m) => m.outcome === "tope_diario_alcanzado").sort((a, b) => a.created_at.localeCompare(b.created_at)).map((m) => m.id);
    return inbox;
  });
  if (apartados > 0) {
    raiseAlert({
      kind: "gestion_portal",
      reason: `${apartados} correo(s) en cola tenían un borrador defectuoso (disculpa de la IA caída o caducado) y NO se han enviado -- quedan en Tareas para contestar a mano.`,
    });
  }

  // Fase 2, envío real: hay red por medio (deliverEmail), así que cada envío
  // se marca en su propio bloqueo, releyendo el estado fresco de ESE correo
  // justo antes de mandarlo -- si otro proceso ya lo marcó entretanto
  // (p. ej. una respuesta manual desde el CRM), no se reenvía por duplicado.
  let sentCount = 0;
  for (const id of pendingIds) {
    if (sentTodayCount() >= DAILY_SEND_CAP) break;
    const actual = readCollection<InboxItem>("email_inbox").find((m) => m.id === id);
    if (!actual || actual.outcome !== "tope_diario_alcanzado" || actual.answered) continue; // ya resuelto por otra vía mientras tanto
    const delivery = await deliverEmail(
      actual.from,
      replySubject(actual.subject),
      actual.draft_note!,
      actual.thread_id && actual.in_reply_to ? { threadId: actual.thread_id, inReplyTo: actual.in_reply_to } : undefined,
    );
    if (delivery.status !== "sent") break; // Google desconectado u otro fallo real -- no tiene sentido seguir intentando esta pasada.
    mutateCollectionSync<InboxItem>("email_inbox", (inbox) => {
      const i = inbox.findIndex((m) => m.id === id);
      if (i >= 0) inbox[i] = { ...inbox[i], outcome: "sent", answered: true, answered_by: "ia" };
      return inbox;
    });
    sentCount++;
  }
  return sentCount;
}
