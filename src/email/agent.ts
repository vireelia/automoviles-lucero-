import crypto from "crypto";
import dns from "dns";
import { readCollection, writeCollection } from "../store.js";
import { handleChatMessage } from "../chat/agent.js";
import { isGoogleConnected, sendGmail, googleStatus } from "../integrations/google.js";
import { decideInterest, detectPortal, WHATSAPP_ONLY_REQUEST, extractCochesNetContact, extractCochesNetClientIdentity, isCochesNetSharedSender } from "./interest.js";
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
};

type Processed = { key: string; at: string; outcome: string; threadId?: string };
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
  created_at: string;
};

function recordInbox(
  email: InboundEmail,
  outcome: string,
  extra?: { portal?: string | null; draftNote?: string; answered?: boolean; answeredBy?: "ia" | "equipo" },
) {
  const inbox = readCollection<InboxItem>("email_inbox");
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
    created_at: new Date().toISOString(),
  });
  writeCollection("email_inbox", inbox.slice(-500));
}

export async function processInboundEmail(email: InboundEmail): Promise<{ outcome: string; reply?: string; error?: string }> {
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
  if (processed.some((p) => p.key === `${email.from}|${email.messageKey}`)) {
    return { outcome: "duplicate" };
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
      const waPhone = contact.phone.startsWith("+") ? contact.phone : `+${contact.phone}`;
      const vehicleLabel = [contact.make, contact.model, contact.version].filter(Boolean).join(" ");
      upsertLead({
        phone: waPhone,
        name: contact.name ?? undefined,
        channel: "WHATSAPP",
        vehicle_interest: vehicleLabel || undefined,
        notes: "Pidió explícitamente que le contacten por WhatsApp (aviso real de Coches.net).",
      });
      // A petición real (16/10/2026, "que también le diga el coche por el
      // cual le estamos escribiendo"): este es un contacto que iniciamos
      // nosotros (el cliente no ha escrito nada todavía en esta conversación
      // de WhatsApp) -- si el vehículo queda solo como nota al margen, el
      // modelo puede confirmarlo sin nombrarlo ("sí, lo tenemos disponible")
      // y el cliente no sabe de qué coche se habla. Se deja clarísimo como
      // el dato central, no como apunte.
      const userText = vehicleLabel
        ? `Hola, escribí en Coches.net preguntando por este vehículo: ${vehicleLabel}.${contact.inquiry ? ` ${contact.inquiry}` : ""}`
        : contact.inquiry || "Me interesa un vehículo, pero no se especificó cuál.";
      const { reply } = await handleChatMessage(waPhone, userText, "WHATSAPP", waPhone);
      const sent = isWhatsappConnected() ? await sendWhatsappText(waPhone, reply) : { ok: false as const, error: "whatsapp_not_connected" };

      if (sent.ok) {
        recordInbox(email, "sent_whatsapp_automatico", { portal: "Coches.net" });
        writeCollection("email_processed", [...processed, { key: `${email.from}|${email.messageKey}`, at: new Date().toISOString(), outcome: "sent_whatsapp_automatico", threadId: email.threadId }].slice(-MAX_PROCESSED_KEPT));
        return { outcome: "sent_whatsapp_automatico", reply };
      }

      // Plantilla real aprobada por Meta como segundo intento real (27/10/2026,
      // caso real de Robert Leonardo) -- solo si hay un vehículo real que
      // poner como parámetro y la plantilla ya está aprobada de verdad (se
      // comprueba cada vez, nunca se asume). Si esto funciona, se abre la
      // ventana de 24h y Carolina ya puede seguir la conversación real
      // después con la respuesta que ya tenía redactada.
      if (vehicleLabel && (await isContactoInicialTemplateApproved())) {
        const templateSent = await sendZernioWhatsappVehicleContactTemplate(waPhone, vehicleLabel);
        if (templateSent.ok) {
          recordInbox(email, "sent_whatsapp_plantilla", { portal: "Coches.net" });
          writeCollection("email_processed", [...processed, { key: `${email.from}|${email.messageKey}`, at: new Date().toISOString(), outcome: "sent_whatsapp_plantilla", threadId: email.threadId }].slice(-MAX_PROCESSED_KEPT));
          return { outcome: "sent_whatsapp_plantilla" };
        }
      }

      const failReason = explainWhatsappSendError(sent.error);
      const draftNote = `El envío automático por WhatsApp falló: ${failReason} -- escribirle a mano: https://wa.me/${contact.phone}\n\nRespuesta ya redactada, lista para copiar:\n${reply}`;
      recordInbox(email, "pendiente_whatsapp_manual", { portal: "Coches.net", draftNote });
      writeCollection("email_processed", [...processed, { key: `${email.from}|${email.messageKey}`, at: new Date().toISOString(), outcome: "pendiente_whatsapp_manual", threadId: email.threadId }].slice(-MAX_PROCESSED_KEPT));
      raiseAlert({ kind: "gestion_portal", lead_phone: waPhone, name: contact.name, reason: `Coches.net: cliente pidió contacto SOLO por WhatsApp -- el envío automático falló: ${failReason}. Escribirle a mano: https://wa.me/${contact.phone}`, draft_note: draftNote });
      return { outcome: "pendiente_whatsapp_manual" };
    }
  }

  const looksAutomated = /no-?reply|mailer-daemon|postmaster|do-?not-?reply/i.test(email.from);
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
    // Especificación formal (15/10/2026, sección 10: "sin almacenar
    // contenido sensible innecesario"): si el motivo de no contestar es que
    // el correo trae datos sensibles (DNI, IBAN, contraseñas...), el texto
    // real ya cumplió su única función (decidir no responder) -- guardarlo
    // tal cual sería acumular justo el dato que no hace falta conservar.
    const sensitive = decision.reason === "documento_sensible_revision_humana";
    recordInbox(sensitive ? { ...email, text: "[contenido sensible -- no almacenado]" } : email, "automated_no_reply", { portal: portalInfo.portal });
    writeCollection("email_processed", [...processed, { key: `${email.from}|${email.messageKey}`, at: new Date().toISOString(), outcome: "automated_no_reply", threadId: email.threadId }].slice(-MAX_PROCESSED_KEPT));
    // FALLO REAL detectado (27/10/2026, "contestaba mal, ni siquiera lo
    // contesta"): un cliente real (Opel Mokka, hilo previo real) escribió
    // mencionando de pasada una palabra de la lista de SENSITIVE_DOCS (DNI,
    // factura, contrato...) en una pregunta normal de compra -- no un
    // documento sensible de verdad -- y se descartó en silencio, sin
    // contestar NI avisar a nadie. No se cambia la cautela de no
    // responder sola (sigue siendo lo correcto ante la duda), pero ya
    // nunca se pierde en silencio: para los dos motivos donde sí podría
    // ser un cliente real de verdad (documento_sensible/sin_tema_claro,
    // a diferencia de marketing/banco/b2b/interno, que nunca lo son), se
    // avisa al equipo igual que cualquier otra gestión manual real.
    if (decision.reason === "documento_sensible_revision_humana" || decision.reason === "sin_tema_claro_revision_humana") {
      raiseAlert({
        kind: "gestion_portal",
        reason: `Correo de ${email.from} ("${email.subject || "sin asunto"}") no se contestó solo -- ${decision.reason === "documento_sensible_revision_humana" ? "puede traer un dato sensible, revísalo a mano" : "no quedó claro que fuera un cliente, revísalo a mano"}. Si es un cliente real, contéstale desde Correos.`,
      });
    }
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

  const userText = `Asunto: ${email.subject || "(sin asunto)"}\n\n${email.text}`.trim();
  const { reply } = await handleChatMessage(`mail:${identityKey}`, userText, "EMAIL", identityKey);
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
    writeCollection("email_processed", [...processed, { key: `${email.from}|${email.messageKey}`, at: new Date().toISOString(), outcome: "pendiente_gestion_portal", threadId: email.threadId }].slice(-MAX_PROCESSED_KEPT));
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
    writeCollection("email_processed", [...processed, { key: `${email.from}|${email.messageKey}`, at: new Date().toISOString(), outcome: "modo_prueba_sin_envio", threadId: email.threadId }].slice(-MAX_PROCESSED_KEPT));
    return { outcome: "modo_prueba_sin_envio", reply: body };
  }

  // Pausa por contacto individual (27/10/2026, "en correos, pon la misma
  // sección que se pueda escribir" -- mismo botón que ya existe en
  // WhatsApp): el canal sigue encendido para todos los demás remitentes,
  // solo este en concreto lo lleva el equipo a mano hasta que lo
  // reactiven desde su ficha en Contactos.
  if (isEmailContactPaused(email.from)) {
    recordInbox(email, "pausado_por_chat", { portal: portalInfo.portal, draftNote: body });
    writeCollection("email_processed", [...processed, { key: `${email.from}|${email.messageKey}`, at: new Date().toISOString(), outcome: "pausado_por_chat", threadId: email.threadId }].slice(-MAX_PROCESSED_KEPT));
    raiseAlert({ kind: "gestion_portal", reason: `Correo: Daniel está pausado para este remitente en concreto -- "${email.subject}" no se respondió. Reactívalo desde su ficha en Contactos cuando quieras.`, draft_note: body });
    return { outcome: "pausado_por_chat", reply: body };
  }

  if (sentTodayCount() >= DAILY_SEND_CAP) {
    recordInbox(email, "tope_diario_alcanzado", { portal: portalInfo.portal, draftNote: body });
    writeCollection("email_processed", [...processed, { key: `${email.from}|${email.messageKey}`, at: new Date().toISOString(), outcome: "tope_diario_alcanzado", threadId: email.threadId }].slice(-MAX_PROCESSED_KEPT));
    raiseAlert({ kind: "gestion_portal", reason: `Se alcanzó el tope diario de ${DAILY_SEND_CAP} correos automáticos -- "${email.subject}" quedó sin enviar, respuesta ya redactada.`, draft_note: body });
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
  writeCollection("email_processed", [...processed, { key: `${email.from}|${email.messageKey}`, at: new Date().toISOString(), outcome, threadId: email.threadId }].slice(-MAX_PROCESSED_KEPT));

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
export async function sendPendingDailyCapEmails(): Promise<number> {
  if (!isEmailAutoSendEnabled()) return 0; // mismo interruptor de pruebas que el resto del envío automático.
  const inbox = readCollection<InboxItem>("email_inbox");
  const pending = inbox
    .filter((m) => m.outcome === "tope_diario_alcanzado" && !m.answered && m.draft_note)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  let sentCount = 0;
  for (const m of pending) {
    if (sentTodayCount() >= DAILY_SEND_CAP) break;
    const delivery = await deliverEmail(
      m.from,
      replySubject(m.subject),
      m.draft_note!,
      m.thread_id && m.in_reply_to ? { threadId: m.thread_id, inReplyTo: m.in_reply_to } : undefined,
    );
    if (delivery.status !== "sent") break; // Google desconectado u otro fallo real -- no tiene sentido seguir intentando esta pasada.
    m.outcome = "sent";
    m.answered = true;
    m.answered_by = "ia";
    sentCount++;
  }
  if (sentCount > 0) writeCollection("email_inbox", inbox);
  return sentCount;
}
