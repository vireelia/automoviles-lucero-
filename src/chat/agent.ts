import { readFileSync } from "fs";
import path from "path";
import crypto from "crypto";
import { readCollection, writeCollection, appendToCollection } from "../store.js";
import { dispatchTool } from "./dispatch.js";

// Agente de chat propio (fuera de Retell). Usa el mismo prompt (núcleo
// común + addendum de chat) y las mismas 26 herramientas que el agente de
// Retell, ejecutadas en proceso. Cualquier proveedor compatible con la API
// de chat completions sirve: LLM_BASE_URL y LUCERO_CHAT_MODEL lo configuran.

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

// known_facts (04/11/2026, auditoría real: "el fix de ayer... solo fue
// texto de prompt, no protección de código -- sigue pasando en el 30% de
// las conversaciones, casi la misma tasa que antes del fix"). Pedirle al
// modelo por texto que no repita get_business_info/get_responsable_contact
// no basta -- se le puede olvidar, o la conversación puede recortarse
// (trimToTurns) y perder el mensaje de la herramienta de una ronda vieja.
// Esto persiste el dato real ya obtenido en el propio registro de la
// conversación (no en `messages`, que sí se recorta) para poder
// inyectarlo directo en el contexto en cada turno futuro -- el modelo ya
// tiene el dato delante, sin depender de que decida "acordarse" de no
// pedirlo otra vez.
type ConversationRecord = {
  id: string;
  messages: ChatMessage[];
  updated_at: string;
  user_turn_count?: number;
  known_facts?: { business_info?: unknown; responsable_contact?: unknown };
};

const MODEL = process.env.LUCERO_CHAT_MODEL ?? "gpt-4.1-mini";
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
const MAX_TURNS_KEPT = 20;
// Tope real de turnos por conversación (19/10/2026, "seguridad de baneos" +
// "seguridad de no gastar tantos créditos y no excedernos de ellos" --
// nunca basta con pedírselo solo al prompt: eso ya está en prompt-core.md,
// pero aquí hay un límite duro que no depende de que el modelo lo respete).
// Se cuenta por mensaje de USUARIO (no por ronda de herramientas, que ya
// tiene su propio tope en MAX_TOOL_ROUNDS_BY_CHANNEL), independiente del
// recorte de historial (trimToTurns) -- así sigue contando bien aunque la
// conversación ya se haya recortado. Al llegar al tope, la conversación se
// cierra con naturalidad -- nunca se corta en silencio sin que el cliente
// sepa qué pasa, pero tampoco avisa a Ramón/José: llegar al tope no es por
// sí solo "algo importante" (a petición real, 19/10/2026 -- solo lo son
// una visita o una reserva, y esas siguen avisando donde ya avisaban).
const MAX_USER_TURNS_BEFORE_HANDOFF = Number(process.env.LUCERO_MAX_CONVO_TURNS ?? 24);
// FALLO REAL detectado (27/10/2026, "le dije a carolina que tenia una
// consulta y me responde esta tonteria, deberia de ser mas amable"): el
// texto original ("para no darte más vueltas") sonaba brusco, como si el
// cliente molestara. El límite en sí es real y se queda (seguridad de
// coste/baneos, ver arriba) -- solo se reescribe el tono: agradecer,
// nunca sonar impaciente, y dejar un paso siguiente concreto.
const LIMIT_REACHED_REPLY = "Llevamos ya un buen rato con esto -- para darte la mejor atención, prefiero que lo veas en persona en el concesionario o que lo retomemos con calma más adelante. ¡Gracias por tu paciencia!";
// Estructura por canal (15/10/2026, a petición real: "mismo cerebro, pero
// diferente para cada agente"): el correo es de un solo disparo -- nadie
// espera en línea, así que puede permitirse más rondas de herramientas para
// verificar bien antes de contestar una única vez. Chat/WhatsApp son
// conversación en vivo -- el cliente sigue ahí, así que no hace falta tanto
// margen (y responder antes es mejor que tardar de más).
const MAX_TOOL_ROUNDS_BY_CHANNEL: Record<Channel, number> = { EMAIL: 10, CHAT: 6, WHATSAPP: 6, FACEBOOK: 6 };
const FALLBACK_REPLY = "Disculpa, ahora mismo no puedo responderte bien. Te paso con el equipo para que te atiendan en persona.";

export class LlmNotConfigured extends Error {
  constructor() {
    super("llm_not_configured");
  }
}

function readAsset(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

let systemPromptCache: string | null = null;
function systemPrompt(): string {
  if (!systemPromptCache) {
    systemPromptCache = `${readAsset("src/data/prompt-core.md").trim()}\n\n${readAsset("src/data/prompt-chat.md").trim()}`;
  }
  return systemPromptCache;
}

let toolsCache: unknown[] | null = null;
function llmTools(): unknown[] {
  if (!toolsCache) toolsCache = JSON.parse(readAsset("src/chat/tool-schemas.json"));
  return toolsCache!;
}

// forceText (FALLO REAL detectado 15/10/2026, correo real de Coches.net
// sobre un Opel Astra): el modelo encadenó 6 rondas seguidas de solo
// herramientas (incluyendo reintentos de get_appointment_slots sin que el
// cliente pidiera cita) y nunca llegó a producir ni una frase de texto --
// el cliente se quedó sin respuesta real y solo recibió el mensaje
// genérico de fallback. En la última ronda disponible se le quita la
// opción de llamar a otra herramienta (tool_choice:"none") para obligarlo
// a cerrar con una respuesta de texto real, usando lo que ya averiguó.
// Uso real por llamada (04/11/2026, "a lo mejor cambio de cuentas porque
// tampoco me marca el consumo que tiene cada agente" -- OpenAI no separa
// el gasto por canal/agente en su propio panel; esto sí lo hace, con el
// dato real que ya devuelve la propia API en cada respuesta, nunca
// estimado). cached_tokens viene de prompt_tokens_details, solo presente
// cuando el caché de prompt (ver systemPrompt() más abajo) de verdad
// aplicó -- permite confirmar si el ahorro real está funcionando o no,
// en vez de asumirlo.
export type LlmUsage = { prompt_tokens: number; completion_tokens: number; cached_tokens: number };

// Clave de OpenAI por canal (04/11/2026, "quiero cuentas separadas por
// agente" -- Carolina, Daniel y el resto con su propio crédito, para que
// si una se agota las otras sigan funcionando). Cada canal tiene su
// variable propia; si no está puesta, cae en OPENAI_API_KEY (la
// compartida de siempre) para no romper nada mientras se van añadiendo
// las claves nuevas una a una.
function apiKeyForChannel(channel: Channel): string | undefined {
  const perChannel: Record<Channel, string | undefined> = {
    WHATSAPP: process.env.OPENAI_API_KEY_WHATSAPP,
    FACEBOOK: process.env.OPENAI_API_KEY_WHATSAPP, // Mismo agente (Carolina) que WhatsApp.
    EMAIL: process.env.OPENAI_API_KEY_EMAIL,
    CHAT: process.env.OPENAI_API_KEY_CHAT,
  };
  return perChannel[channel] ?? process.env.OPENAI_API_KEY;
}

async function callLlm(messages: ChatMessage[], channel: Channel, forceText = false): Promise<{ message: ChatMessage; usage: LlmUsage | null }> {
  const apiKey = apiKeyForChannel(channel);
  if (!apiKey) throw new LlmNotConfigured();
  const body: Record<string, unknown> = { model: MODEL, temperature: 0.3, messages, tools: llmTools(), tool_choice: forceText ? "none" : "auto" };
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`llm_http_${res.status}`);
  const data = (await res.json()) as {
    choices: { message: ChatMessage }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  };
  const usage = data.usage
    ? { prompt_tokens: data.usage.prompt_tokens ?? 0, completion_tokens: data.usage.completion_tokens ?? 0, cached_tokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0 }
    : null;
  return { message: data.choices[0].message, usage };
}

function recordLlmUsage(channel: Channel, sessionId: string, usage: LlmUsage): void {
  try {
    const log = readCollection<LlmUsage & { id: string; channel: string; session_id: string; at: string }>("llm_usage_logs");
    log.push({ id: crypto.randomUUID(), channel: channel.toLowerCase(), session_id: sessionId, at: new Date().toISOString(), ...usage });
    writeCollection("llm_usage_logs", log.slice(-5000));
  } catch {
    // El registro de coste nunca debe tumbar una respuesta real al cliente.
  }
}

// Un turno empieza siempre en un mensaje de usuario: así nunca se corta una
// respuesta de herramienta de su llamada original al recortar el historial.
function trimToTurns(messages: ChatMessage[]): ChatMessage[] {
  const kept = messages.slice(-MAX_TURNS_KEPT * 4);
  const start = kept.findIndex((m) => m.role === "user");
  return start > 0 ? kept.slice(start) : kept;
}

function loadConversation(sessionId: string): ConversationRecord {
  const found = readCollection<ConversationRecord>("chat_conversations").find((c) => c.id === sessionId);
  return found ?? { id: sessionId, messages: [], updated_at: new Date().toISOString() };
}

function saveConversation(record: ConversationRecord) {
  const others = readCollection<ConversationRecord>("chat_conversations").filter((c) => c.id !== record.id);
  writeCollection("chat_conversations", [...others, record]);
}

export type Channel = "CHAT" | "EMAIL" | "WHATSAPP" | "FACEBOOK";

const CHANNEL_LABEL: Record<Channel, string> = {
  CHAT: "chat",
  EMAIL: "correo electrónico",
  WHATSAPP: "WhatsApp",
  FACEBOOK: "Messenger de Facebook",
};

export async function handleChatMessage(
  sessionId: string,
  userText: string,
  channel: Channel = "CHAT",
  contact: string = sessionId,
  // Petición real (23/10/2026, tras reenviar 170 mensajes reales atascados
  // 19-23/10 por el webhook caído: "que responda con sentido"): sin esto,
  // el agente respondía a un mensaje de hace días como si acabara de
  // llegar -- ni una disculpa por la tardanza. Dato REAL (el tiempo que de
  // verdad pasó), nunca inventado -- quien llama lo calcula con la fecha
  // real del mensaje original.
  realDelayNote?: string,
): Promise<{ reply: string; tool_runs: number }> {
  const conversation = loadConversation(sessionId);
  const userTurnCount = (conversation.user_turn_count ?? 0) + 1;

  if (userTurnCount > MAX_USER_TURNS_BEFORE_HANDOFF) {
    // A petición real (19/10/2026, corrección directa: "nunca se deriva al
    // equipo si no es algo importante, como una visita o una reserva") --
    // llegar al tope NO es, por sí solo, algo importante, así que esto
    // NUNCA avisa a Ramón/José ni crea un handoff: solo corta la conversación
    // con naturalidad. Los avisos reales siguen viviendo donde ya vivían --
    // create_handoff (visita/reserva) los sigue llamando el propio agente
    // cuando de verdad toca, no este tope.
    // FALLO REAL detectado (27/10/2026, "esa protección es al cerrar, si el
    // cliente vuelve a preguntar que le responda y sea amable"): user_turn_count
    // nunca se reiniciaba -- una vez superado el tope, CUALQUIER mensaje
    // futuro de ese mismo cliente (aunque fuera una pregunta nueva y real,
    // minutos o días después) seguía devolviendo este mismo mensaje fijo
    // para siempre, en vez de volver a ayudar con naturalidad. Esto es un
    // corte puntual de ESTA tanda larga, no un veto permanente -- se
    // reinicia a 0 para que el siguiente mensaje real vuelva a procesarse
    // con el agente como cualquier otro.
    await dispatchTool("create_lead", { phone: contact, channel });
    saveConversation({
      id: sessionId,
      messages: trimToTurns([...conversation.messages, { role: "user", content: userText }, { role: "assistant", content: LIMIT_REACHED_REPLY }]),
      updated_at: new Date().toISOString(),
      user_turn_count: 0,
    });
    return { reply: LIMIT_REACHED_REPLY, tool_runs: 0 };
  }

  // FALLO REAL grave detectado (05/11/2026, "estan enviando por persona
  // unos 20 mensajes y te dije que vaya al grano y que sean 4 mensajes" --
  // comprobado con datos reales: 34 de 2000 conversaciones reales superaban
  // las 4 respuestas, una llegó a 35). El tope de "4-5 mensajes" solo vivía
  // en el texto del prompt (BREVEDAD_REAL más abajo) -- el modelo puede
  // ignorarlo, y de hecho lo ignoraba en el 1,7% de las conversaciones
  // reales. Ahora hay un tope DURO por código, solo para WhatsApp/correo
  // (Carolina/Daniel): al llegar a la 4ª respuesta real del agente, no se
  // vuelve a llamar a la IA en esta conversación -- se corta con un cierre
  // fijo y un aviso real al equipo, en vez de depender de que el modelo
  // "se acuerde" de parar.
  const MAX_RESPUESTAS_BREVEDAD = 4;
  if (channel === "WHATSAPP" || channel === "EMAIL") {
    const respuestasReales = conversation.messages.filter((m) => m.role === "assistant" && m.content?.trim()).length;
    if (respuestasReales >= MAX_RESPUESTAS_BREVEDAD) {
      const cierre =
        "Para no alargarlo más, lo mejor es que hables directo con el equipo -- te paso con ellos. ¡Gracias por escribirnos!";
      await dispatchTool("create_handoff", {
        reason: `Conversación cortada al llegar al tope de ${MAX_RESPUESTAS_BREVEDAD} respuestas (petición real de ir al grano) -- revisar si el cliente sigue necesitando algo.`,
        notes: `Canal ${channel}, sesión ${sessionId}.`,
        urgency: "normal",
        channel,
      });
      saveConversation({
        id: sessionId,
        messages: trimToTurns([...conversation.messages, { role: "user", content: userText }, { role: "assistant", content: cierre }]),
        updated_at: new Date().toISOString(),
        user_turn_count: userTurnCount,
      });
      return { reply: cierre, tool_runs: 0 };
    }
  }

  // El identificador de sesión del canal es el teléfono del cliente. Se registra
  // el lead en el primer contacto: sin él no se pueden hacer seguimientos ni
  // consultar el historial del cliente.
  // En email el identificador de contacto es la dirección del remitente, que se
  // guarda en el campo phone del lead (es la clave de contacto del CRM).
  await dispatchTool("create_lead", { phone: contact, channel });
  const history = trimToTurns(conversation.messages);
  const turn: ChatMessage[] = [{ role: "user", content: userText }];
  // FALLO REAL detectado (15/10/2026, correo real de Coches.net sobre un
  // Opel Astra): el modelo ignoró este identificador y usó en su lugar un
  // correo que aparecía DENTRO del cuerpo del mensaje (el de un portal
  // reenviando los datos de un cliente real) como "phone" en create_lead,
  // creando una ficha de cliente duplicada y fragmentada -- y gastando
  // turnos de herramienta de más intentando corregirlo. Regla reforzada.
  // FALLO REAL detectado (27/10/2026, leads reales con channel:"correo
  // electrónico" en vez de "EMAIL"): esta línea solo daba la etiqueta
  // humana del canal ("correo electrónico") para que el modelo supiera
  // cómo hablar de él -- pero el modelo, al rellenar el parámetro real
  // "channel" de create_lead/upsert_lead, copiaba literalmente esa misma
  // palabra en vez del código real ("EMAIL"), rompiendo cualquier filtro
  // o agrupación que dependa de ese campo en el CRM. Ahora se dan los dos,
  // dejando clarísimo cuál va en cada sitio.
  // Brevedad y cierre reforzado para Carolina/WhatsApp Y Daniel/correo
  // (03/11/2026, petición real de Ramón: "que vaya al grano con unos 4
  // mensajes... así ahorrar coste" -- corregido ese mismo día a "es solo
  // para Carolina" -- y vuelto a ampliar 04/11/2026, transcripción real con
  // Ramón: "Daniel... exactamente lo mismo que Carolina, que en 4 o 5
  // mensajes y que por último envíe directamente la integración" -- ya SÍ
  // quiere esto también en correo). Miguel (voz, prompt-voice.md aparte)
  // sigue sin esto -- no se ha pedido ahí.
  const brevityNote =
    channel === "WHATSAPP" || channel === "EMAIL"
      ? `\n\nBREVEDAD REAL -- AMABLE PERO AL GRANO, MÁXIMO 4 MENSAJES (petición real, 05/11/2026: "solo 4 mensajes joder" -- vuelto a 4 tras un intento a 5; hay además un tope DURO por código, ver MAX_RESPUESTAS_BREVEDAD más arriba, que corta la conversación aunque este texto se ignore): sigue siendo cercano y amable como siempre -- esto no es sonar cortante ni seco -- pero cada conversación real tiene que resolverse en 4 mensajes tuyos como máximo: identificar lo que pide, dar el dato real o la disponibilidad con calidez, y seguir con la cita/reserva si toca, directo a cerrar. No alargues con preguntas de cortesía innecesarias ni repitas lo mismo con otras palabras -- la amabilidad va en el tono de cada mensaje, no en alargar la conversación. ÚLTIMO MENSAJE DE LA CONVERSACIÓN: cuando cierres (porque ya se resolvió, porque ya quedó la cita/reserva, o porque no hay más que añadir), el último mensaje tiene que incluir siempre, con naturalidad, estos tres datos reales: la dirección del concesionario, el enlace del catálogo de Coches.net (https://www.coches.net/concesionario/autolunaslagunamadrid/, ver sección ENLACES) y un teléfono de contacto. IMPORTANTE para no gastar de más: si ya llamaste a get_business_info o a get_responsable_contact antes EN ESTA MISMA CONVERSACIÓN, usa esos mismos datos reales que ya tienes -- no los vuelvas a llamar solo para el cierre, eso gasta una ronda entera de IA por nada. Solo llama a la herramienta que te falte si de verdad no la pediste todavía en esta conversación. No lo repitas en cada mensaje, solo en el de cierre real.`
      : "";
  const knownFacts = conversation.known_facts ?? {};
  const knownFactsNote = [
    knownFacts.business_info ? `\nDato real YA CONOCIDO de get_business_info en esta conversación (no lo vuelvas a pedir): ${JSON.stringify(knownFacts.business_info)}` : "",
    knownFacts.responsable_contact ? `\nDato real YA CONOCIDO de get_responsable_contact en esta conversación (no lo vuelvas a pedir): ${JSON.stringify(knownFacts.responsable_contact)}` : "",
  ].join("");
  const context = `\n\nCONTEXTO DE ESTA CONVERSACIÓN\nCanal: ${CHANNEL_LABEL[channel]} (en el parámetro "channel" de create_lead/upsert_lead y cualquier otra herramienta, usa SIEMPRE el código real "${channel}" tal cual, nunca la palabra de arriba). Identificador de contacto (úsalo SIEMPRE como "phone" en todas las herramientas -- create_lead, get_customer_history, etc. -- nunca uses en su lugar un teléfono o correo que aparezca dentro del texto del mensaje, aunque sea el dato real del cliente; ese dato real va en el campo "notes" si hace falta guardarlo, pero la clave de identificación es siempre esta): ${contact}.${realDelayNote ? `\n${realDelayNote}` : ""}${brevityNote}${knownFactsNote}`;
  // FALLO REAL de coste detectado (03/11/2026, "tenemos 3 dólares hasta
  // recargar mañana" -- el usuario comprobó el gasto real: ~24.000 tokens de
  // prompt estático (prompt-core.md + prompt-chat.md + tool-schemas.json) se
  // reenviaban en CADA ronda de CADA conversación, ~2.200 llamadas reales
  // solo hoy). El "context" (teléfono/canal real, distinto en cada llamada)
  // iba PEGADO al mismo mensaje "system" que el prompt estático -- eso
  // rompe el caché de prompt de OpenAI (que exige que el PREFIJO sea
  // byte a byte idéntico entre llamadas) desde el primer carácter.
  // Separar el contexto dinámico en su propio mensaje deja el bloque
  // estático grande siempre idéntico -- el caché automático de OpenAI
  // (gratis, sin flag que activar, para prompts >=1024 tokens) puede
  // entonces reconocerlo y cobrar la parte cacheada mucho más barata.
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt() }, { role: "system", content: context }, ...history, ...turn];

  let toolRuns = 0;
  let reply: string | null = null;
  const maxToolRounds = MAX_TOOL_ROUNDS_BY_CHANNEL[channel];

  // FALLO REAL grave detectado (04/11/2026, auditoría real: "el cliente se
  // queda sin ninguna respuesta" -- a diferencia del correo, que SÍ captura
  // el fallo de la IA (fallo_ia_pendiente_revision), WhatsApp/Facebook/chat
  // web nunca envuelven este bucle: un error real (llm_http_429, sin
  // crédito) se propagaba sin capturar hasta el webhook, que solo hacía
  // console.error -- el cliente real no recibía ni el FALLBACK_REPLY (ese
  // solo cubre agotar rondas sin texto, nunca una excepción real) y nadie
  // del equipo se enteraba. Ahora todo el bucle queda protegido igual que
  // ya lo estaba el correo.
  try {
  for (let round = 0; round < maxToolRounds && reply === null; round++) {
    const isLastRound = round === maxToolRounds - 1;
    const callInput = isLastRound
      ? [
          ...messages,
          {
            role: "system" as const,
            content:
              "Ya no puedes llamar a ninguna herramienta más. Responde AHORA con una frase real para el cliente, usando los datos que ya te han devuelto las herramientas anteriores en esta conversación -- nunca digas que vas a comprobar, revisar o buscar algo, eso ya no es posible en este turno.",
          },
        ]
      : messages;
    const { message, usage } = await callLlm(callInput, channel, isLastRound);
    if (usage) recordLlmUsage(channel, sessionId, usage);
    messages.push(message);
    turn.push(message);

    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        let args: unknown = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = {};
        }
        // Canal de origen en visitas/reservas/handoffs (20/10/2026, mejora
        // integral del CRM, sección 11.1/12.1): nunca se le pide al modelo
        // que lo incluya él mismo -- ya lo sabemos aquí con certeza (el
        // parámetro "channel" de esta misma función), así que se inyecta
        // directo, igual que ya se hace con el identificador de contacto.
        if (
          (call.function.name === "create_appointment" || call.function.name === "create_reservation_pending" || call.function.name === "create_handoff") &&
          args &&
          typeof args === "object" &&
          !("channel" in args)
        ) {
          (args as Record<string, unknown>).channel = channel;
        }
        const result = await dispatchTool(call.function.name, args);
        toolRuns++;
        if (call.function.name === "get_business_info") knownFacts.business_info = result;
        else if (call.function.name === "get_responsable_contact") knownFacts.responsable_contact = result;
        appendToCollection("tool_call_logs", {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          tool: call.function.name,
          channel: channel.toLowerCase(),
          session_id: sessionId,
          input: args,
          result,
        });
        const toolMessage: ChatMessage = { role: "tool", tool_call_id: call.id, content: JSON.stringify(result) };
        messages.push(toolMessage);
        turn.push(toolMessage);
      }
      continue;
    }

    reply = message.content?.trim() || null;
  }
  } catch (err) {
    // Mismo criterio que createHandoffFallback de abajo -- nunca dejar al
    // cliente real sin ninguna respuesta, y siempre avisar al equipo de un
    // fallo real de la IA (créditos agotados u otro error real), nunca en
    // silencio solo en console.error.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[chat] fallo real de la IA (${channel}, sesión ${sessionId}):`, message);
    reply = FALLBACK_REPLY;
    turn.push({ role: "assistant", content: reply });
    await createHandoffFallback(sessionId);
  }

  if (reply === null) {
    reply = FALLBACK_REPLY;
    turn.push({ role: "assistant", content: reply });
    await createHandoffFallback(sessionId);
  }

  saveConversation({
    id: sessionId,
    messages: trimToTurns([...history, ...turn]),
    updated_at: new Date().toISOString(),
    user_turn_count: userTurnCount,
    known_facts: knownFacts,
  });
  return { reply, tool_runs: toolRuns };
}

async function createHandoffFallback(sessionId: string) {
  await dispatchTool("create_handoff", {
    reason: "El agente de chat no pudo cerrar la respuesta en el número de intentos",
    notes: `Conversación de chat ${sessionId}`,
    urgency: "alta",
  });
}
