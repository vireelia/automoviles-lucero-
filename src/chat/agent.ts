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

type ConversationRecord = { id: string; messages: ChatMessage[]; updated_at: string; user_turn_count?: number };

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
async function callLlm(messages: ChatMessage[], forceText = false): Promise<{ message: ChatMessage }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new LlmNotConfigured();
  const body: Record<string, unknown> = { model: MODEL, temperature: 0.3, messages, tools: llmTools(), tool_choice: forceText ? "none" : "auto" };
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`llm_http_${res.status}`);
  const data = (await res.json()) as { choices: { message: ChatMessage }[] };
  return { message: data.choices[0].message };
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
  const context = `\n\nCONTEXTO DE ESTA CONVERSACIÓN\nCanal: ${CHANNEL_LABEL[channel]} (en el parámetro "channel" de create_lead/upsert_lead y cualquier otra herramienta, usa SIEMPRE el código real "${channel}" tal cual, nunca la palabra de arriba). Identificador de contacto (úsalo SIEMPRE como "phone" en todas las herramientas -- create_lead, get_customer_history, etc. -- nunca uses en su lugar un teléfono o correo que aparezca dentro del texto del mensaje, aunque sea el dato real del cliente; ese dato real va en el campo "notes" si hace falta guardarlo, pero la clave de identificación es siempre esta): ${contact}.${realDelayNote ? `\n${realDelayNote}` : ""}`;
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt() + context }, ...history, ...turn];

  let toolRuns = 0;
  let reply: string | null = null;
  const maxToolRounds = MAX_TOOL_ROUNDS_BY_CHANNEL[channel];

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
    const { message } = await callLlm(callInput, isLastRound);
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
