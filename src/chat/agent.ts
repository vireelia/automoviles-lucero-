import { readFileSync } from "fs";
import path from "path";
import crypto from "crypto";
import { readCollection, writeCollection, appendToCollection, readShard, writeShard } from "../store.js";
import { dispatchTool } from "./dispatch.js";
import { getBusinessConfig } from "../data/business-config.js";
import { businessInfo } from "../data/business-info.js";
import { conversationStage, maxUserTurnsFor, esComercial, type Stage } from "./conversion.js";
import { withPersistentLock, markOncePerWindow } from "../locks.js";

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
// FASE 1 (09/11/2026): 4,8 llamadas reales de media por mensaje con ~21k
// tokens cada una -- tope a 3 rondas (la última ya fuerza texto, forceText).
const MAX_TOOL_ROUNDS = Number(process.env.LUCERO_MAX_TOOL_ROUNDS ?? 3);
const MAX_TOOL_ROUNDS_BY_CHANNEL: Record<Channel, number> = { EMAIL: MAX_TOOL_ROUNDS, CHAT: MAX_TOOL_ROUNDS, WHATSAPP: MAX_TOOL_ROUNDS, FACEBOOK: MAX_TOOL_ROUNDS };
// Modelo económico para turnos simples (sin intención de cita/reserva/
// financiación). Desactivado si la variable no está puesta.
// El modelo capaz se reserva para lo que cierra ventas (citas, reservas,
// financiación); una consulta de horario o dirección no lo necesita.
const SIMPLE_MODEL = process.env.LUCERO_CHAT_MODEL_SIMPLE;
export function pickModel(stage: Stage): string {
  if (!SIMPLE_MODEL) return MODEL;
  return esComercial(stage) ? MODEL : SIMPLE_MODEL;
}
// Exportado (05/11/2026, opción B aprobada para la cola de correo
// pendiente): permite que email/agent.ts distinga, SOLO al reprocesar
// desde su propia cola, una respuesta real de un fallo real de la IA
// disfrazado de respuesta -- sin tocar este cerebro compartido ni su
// comportamiento para WhatsApp/chat/correo directo, que sigue exactamente
// igual (nunca se deja a un cliente real sin ninguna respuesta).
export const FALLBACK_REPLY = "Disculpa, ahora mismo no puedo responderte bien. Te paso con el equipo para que te atiendan en persona.";

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

// Cortafuegos de coste real (05/11/2026, "se esta gastando demasiado
// dinero" -- gasto real confirmado del día: 18,47 USD, 8.165 solicitudes,
// causa real identificada: pruebas en vivo contra producción, no un bug).
// Mismo cálculo orientativo que /debug/llm_usage_resumen (precio público
// de gpt-4.1-mini) -- nunca el cobro real de OpenAI, pero sí sirve para
// cortar ANTES de seguir gastando si algo se descontrola. Tope diario
// GLOBAL (todos los canales juntos), en euros, variable de entorno --
// nunca hardcodeado. Por defecto 15 € (dentro del objetivo real de
// "10-20 € mensuales" -- este es el tope de UN SOLO día, deliberadamente
// amplio para no cortar un día real ajetreado, solo un descontrol real).
const DAILY_BUDGET_EUR = Number(process.env.LUCERO_DAILY_LLM_BUDGET_EUR ?? 15);
const PRECIO_INPUT_POR_1M = 0.4;
const PRECIO_CACHED_POR_1M = 0.1;
const PRECIO_OUTPUT_POR_1M = 1.6;

function estimatedSpendTodayEur(): number {
  try {
    const log = readCollection<LlmUsage & { at: string }>("llm_usage_logs");
    const today = new Date().toISOString().slice(0, 10);
    let total = 0;
    for (const r of log) {
      if (!r.at.startsWith(today)) continue;
      const sinCache = Math.max(0, r.prompt_tokens - r.cached_tokens);
      total += (sinCache / 1_000_000) * PRECIO_INPUT_POR_1M + (r.cached_tokens / 1_000_000) * PRECIO_CACHED_POR_1M + (r.completion_tokens / 1_000_000) * PRECIO_OUTPUT_POR_1M;
    }
    return total;
  } catch {
    return 0; // Nunca bloquear una respuesta real por no poder leer el propio registro de coste.
  }
}

export class DailyBudgetExceeded extends Error {
  constructor() {
    super("daily_llm_budget_exceeded");
  }
}

async function callLlm(messages: ChatMessage[], channel: Channel, forceText = false, model: string = MODEL): Promise<{ message: ChatMessage; usage: LlmUsage | null }> {
  if (DAILY_BUDGET_EUR > 0 && estimatedSpendTodayEur() >= DAILY_BUDGET_EUR) {
    throw new DailyBudgetExceeded();
  }
  const apiKey = apiKeyForChannel(channel);
  if (!apiKey) throw new LlmNotConfigured();
  const body: Record<string, unknown> = { model, temperature: 0.3, messages, tools: llmTools(), tool_choice: forceText ? "none" : "auto" };
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
  // Sin recorte no hay riesgo de cortar una herramienta: se conserva un primer
  // mensaje enviado sin IA (plantilla de primer contacto).
  if (messages.length <= MAX_TURNS_KEPT * 4) return messages;
  const kept = messages.slice(-MAX_TURNS_KEPT * 4);
  const start = kept.findIndex((m) => m.role === "user");
  return start > 0 ? kept.slice(start) : kept;
}

function loadConversation(sessionId: string): ConversationRecord {
  const found = readShard<ConversationRecord>("chat_conversations", sessionId);
  return found ?? { id: sessionId, messages: [], updated_at: new Date().toISOString() };
}

// FALLO REAL grave encontrado 12/11/2026 (auditoría de rendimiento,
// chat_conversations.json a 99,5 MB bloqueando el event loop de store.ts):
// los mensajes "tool" guardan JSON.stringify(result) completo (resultados
// de búsqueda de vehículos, hasta ~140 KB cada uno) para siempre en el
// historial. El modelo ya usó ese resultado completo para responder EN SU
// turno -- guardarlo íntegro no aporta nada una vez pasado el turno, solo
// pesa en disco y en los tokens de contexto de turnos futuros. Se recorta
// SOLO al persistir (nunca durante el razonamiento del turno en curso, que
// sigue usando el resultado completo desde `messages`/`turn` en memoria).
const TOOL_CONTENT_MAX_CHARS = 600;
export function shrinkForStorage(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== "tool" || !m.content || m.content.length <= TOOL_CONTENT_MAX_CHARS) return m;
    return { ...m, content: `${m.content.slice(0, TOOL_CONTENT_MAX_CHARS)}… [recortado al guardar, resultado completo ya usado en su turno]` };
  });
}

function saveConversation(record: ConversationRecord) {
  writeShard("chat_conversations", record.id, { ...record, messages: shrinkForStorage(record.messages) });
}

export type Channel = "CHAT" | "EMAIL" | "WHATSAPP" | "FACEBOOK";

const CHANNEL_LABEL: Record<Channel, string> = {
  CHAT: "chat",
  EMAIL: "correo electrónico",
  WHATSAPP: "WhatsApp",
  FACEBOOK: "Messenger de Facebook",
};

// Mensajes simultáneos del mismo cliente se procesan uno detrás de otro: si
// no, cada uno lee el historial antiguo y al guardar se pisan (probado: 1 de
// 3 mensajes sobrevivía). El bloqueo es en disco (locks.ts), así que también
// protege entre dos procesos y sobrevive a un reinicio, y la cola en memoria
// evita tocar el disco en el caso normal de un solo proceso.
const sessionQueues = new Map<string, Promise<unknown>>();
export function handleChatMessage(...args: Parameters<typeof handleChatMessageUnlocked>): ReturnType<typeof handleChatMessageUnlocked> {
  const sessionId = args[0];
  const prev = sessionQueues.get(sessionId) ?? Promise.resolve();
  // Espera generosa: un turno con hasta 3 rondas de IA puede tardar.
  const run = prev.catch(() => undefined).then(() => withPersistentLock(`chat_${sessionId}`, () => handleChatMessageUnlocked(...args), 120_000));
  sessionQueues.set(sessionId, run);
  run.finally(() => {
    if (sessionQueues.get(sessionId) === run) sessionQueues.delete(sessionId);
  }).catch(() => undefined);
  return run;
}

async function handleChatMessageUnlocked(
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
): Promise<{ reply: string; tool_runs: number; ai_failed: boolean }> {
  // FALLO REAL de producción (10/11/2026, caída repetida con la CPU al
  // ~105% sostenido): con el presupuesto diario agotado por una avalancha
  // real de mensajes, cada uno todavía hacía TODO el trabajo pesado
  // (leer y analizar la conversación completa, leer leads/citas/reservas
  // para clasificar el estado comercial) antes de llegar al único punto
  // donde se comprobaba el presupuesto, ya dentro de callLlm. Multiplicado
  // por decenas de mensajes casi simultáneos, eso es lo que agotaba la
  // CPU -- no una sola llamada cara, sino muchísimas haciendo trabajo de
  // sobra para acabar rechazadas igual. Comprobarlo aquí, lo primero de
  // todo, antes de tocar ninguna colección, hace que un rechazo cueste
  // casi nada en vez de todo el trabajo previo.
  if (DAILY_BUDGET_EUR > 0 && estimatedSpendTodayEur() >= DAILY_BUDGET_EUR) {
    console.error(`[chat] presupuesto diario agotado, rechazo inmediato sin trabajo previo (${channel}, sesión ${sessionId})`);
    await createHandoffFallback(sessionId);
    return { reply: FALLBACK_REPLY, tool_runs: 0, ai_failed: true };
  }
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
    return { reply: LIMIT_REACHED_REPLY, tool_runs: 0, ai_failed: false };
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
  // FALLO REAL detectado el mismo día probándolo (05/11/2026, "carolina me
  // escribio... no tan seca"): el contador contaba TODO el historial
  // guardado, sin importar cuántos días habían pasado -- un cliente real
  // que ya habló con Carolina hace días y vuelve a escribir se encontraba
  // el corte en su primer mensaje nuevo, aunque esta conversación de hoy
  // recién empezara. "4 mensajes" es por conversación real, no de por
  // vida -- si pasó más de HORAS_NUEVA_CONVERSACION desde la última vez,
  // se trata como una conversación nueva para este límite (el historial
  // sigue guardado igual para que recuerde el contexto, solo no cuenta
  // para el tope de brevedad).
  // FASE 2 (09/11/2026): el tope fijo de 4 cortaba también las
  // conversaciones que iban camino de una visita -- 149 conversaciones
  // reales cortadas y 134 de 202 citas quedaron sin día ni hora. El tope de
  // 4 se mantiene para consultas informativas (ahí es donde se iba el
  // gasto); con intención comercial real se amplía (ver conversion.ts).
  const HORAS_NUEVA_CONVERSACION = 3;
  const esConversacionNueva = Date.now() - new Date(conversation.updated_at).getTime() > HORAS_NUEVA_CONVERSACION * 3600 * 1000;
  const stage = conversationStage(contact, userText, conversation.messages);
  const MAX_RESPUESTAS_BREVEDAD = maxUserTurnsFor(stage);
  if (!esConversacionNueva && (channel === "WHATSAPP" || channel === "EMAIL")) {
    // FALLO REAL detectado probándolo en real (05/11/2026, captura de
    // pantalla real: "ni me dio fechas... envió el mismo mensaje dos
    // veces"): contar mensajes de "assistant" con contenido cuenta TAMBIÉN
    // las frases de relleno antes de una herramienta ("Dame un segundo,
    // déjame revisarlo.", "Un momento, que compruebo los huecos
    // disponibles.") como si fueran respuestas reales -- con solo 2
    // mensajes reales del cliente ya había 4 "respuestas" contadas (2
    // reales + 2 de relleno), cortando la conversación antes de que
    // Carolina llegara a proponer fecha, y repitiendo el mismo cierre en
    // el siguiente mensaje real (porque el contador nunca bajaba). Contar
    // turnos reales del CLIENTE (role "user") es robusto de verdad: cada
    // mensaje real que manda el cliente es un turno, sin importar cuántas
    // rondas de relleno/herramientas haya por dentro.
    const respuestasReales = conversation.messages.filter((m) => m.role === "user").length;
    if (respuestasReales >= MAX_RESPUESTAS_BREVEDAD) {
      // Cierre enriquecido con datos reales (05/11/2026, "que ponga
      // direccion de la tienda... el como llegar, numero de telefono de
      // ramon y jose, y tambien el link del portal de automoviles lucero
      // en coches.net") -- igual que el cierre normal de la BREVEDAD REAL
      // de más abajo, pero este es el cierre DURO (tope por código), así
      // que los datos van fijos aquí, tomados en el momento real
      // (getBusinessConfig/businessInfo), nunca inventados.
      const cfg = getBusinessConfig();
      const cierre = [
        "¡Qué tal! Para no alargar mucho más la conversación, lo mejor es que te atienda directamente el equipo -- ahora mismo les aviso para que te escriban.",
        `También puedes visitarnos en ${businessInfo.location.address.value} (${businessInfo.location.how_to_arrive}).`,
        `Teléfonos: Ramón ${cfg.ramonPhone} · José ${cfg.josePhone}.`,
        "Todo nuestro catálogo: https://www.coches.net/concesionario/autolunaslagunamadrid/",
      ].join("\n");
      await dispatchTool("create_handoff", {
        reason: `Conversación cortada al llegar al tope de ${MAX_RESPUESTAS_BREVEDAD} respuestas (estado comercial: ${stage}) -- revisar si el cliente sigue necesitando algo.`,
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
      return { reply: cierre, tool_runs: 0, ai_failed: false };
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
  // Texto original sin recortar, a propósito: la propuesta de reducción de
  // prompt está preparada pero SIN activar (ver propuestas/). Lo único que
  // cambia respecto a antes es que el número de mensajes ya no va fijo a 4
  // -- lo pone el tope real de este estado comercial, para que el texto
  // nunca contradiga al tope que de verdad aplica el código.
  const brevityNote =
    channel === "WHATSAPP" || channel === "EMAIL"
      ? `\n\nBREVEDAD REAL -- AMABLE PERO AL GRANO, MÁXIMO ${MAX_RESPUESTAS_BREVEDAD} MENSAJES (petición real, 05/11/2026: "solo 4 mensajes joder"; hay además un tope DURO por código, ver MAX_RESPUESTAS_BREVEDAD más arriba, que corta la conversación aunque este texto se ignore -- ese tope se amplía solo cuando ya hay una visita o reserva en marcha): sigue siendo cercano y amable como siempre -- esto no es sonar cortante ni seco -- pero cada conversación real tiene que resolverse en ${MAX_RESPUESTAS_BREVEDAD} mensajes tuyos como máximo, y tu único objetivo real es cerrar una visita o una reserva, nunca charla de más. Flujo real pedido (mismo para WhatsApp y correo): (1) en cuanto el cliente te diga qué coche le interesa, responde con calidez y pregunta directamente "¿qué día y hora te viene bien para la visita?" -- no esperes a que él lo pida; (2) FALLO REAL detectado probándolo (05/11/2026): NUNCA propongas ni escribas una hora o día concretos (ni siquiera uno "razonable" como las 09:30) sin haberlo visto antes en el array "slots" de una respuesta real de get_appointment_slots EN ESTA MISMA CONVERSACIÓN -- inventar una hora a ojo hace que create_appointment la rechace por "slot_busy" y gasta una ronda de IA entera por nada. Así que: llama a get_appointment_slots UNA SOLA VEZ por conversación (te devuelve varios huecos reales ya ordenados); si el cliente dio un día/hora que coincide con uno de esos slots reales, confírmalo con create_appointment; si no coincide, o si dijo "dime tú"/"no sé", elige tú el PRIMER slot real de esa misma lista que ya tienes y propónlo ("Tengo hueco el [día] a las [hora] de esa lista, ¿te viene bien?"); (3) si create_appointment devuelve "slot_busy" (puede pasar si otro cliente se adelantó), NO vuelvas a llamar a get_appointment_slots otra vez -- usa el SIGUIENTE slot de la misma lista que ya tenías y agenda ese directamente, sin preguntar más vueltas; (4) en el último mensaje, cierra con naturalidad confirmando la cita e incluye siempre estos tres datos reales: la dirección del concesionario, el enlace del catálogo de Coches.net (https://www.coches.net/concesionario/autolunaslagunamadrid/, ver sección ENLACES) y un teléfono de contacto (Ramón o José). No alargues con preguntas de cortesía innecesarias ni repitas lo mismo con otras palabras -- la amabilidad va en el tono de cada mensaje, no en alargar la conversación. IMPORTANTE para no gastar de más: si ya llamaste a get_business_info o a get_responsable_contact antes EN ESTA MISMA CONVERSACIÓN, usa esos mismos datos reales que ya tienes -- no los vuelvas a llamar solo para el cierre, eso gasta una ronda entera de IA por nada. Solo llama a la herramienta que te falte si de verdad no la pediste todavía en esta conversación. No repitas los tres datos de cierre en cada mensaje, solo en el de cierre real.`
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
  // Señal estructurada real (05/11/2026, a petición explícita: "prefiero
  // una señal de error estructurada y fiable, sin comparar textos") --
  // true SOLO en los dos casos reales en que esta función cae a la
  // disculpa de reserva (fallo real de la IA, o el modelo no devolvió
  // contenido). Campo nuevo, puramente aditivo -- WhatsApp/Facebook/chat/
  // correo directo siguen leyendo solo "reply" como siempre, nunca se les
  // obliga a mirar este campo ni cambia su comportamiento.
  let aiFailed = false;
  const maxToolRounds = MAX_TOOL_ROUNDS_BY_CHANNEL[channel];
  const model = pickModel(stage);

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
    const { message, usage } = await callLlm(callInput, channel, isLastRound, model);
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
    aiFailed = true;
    await createHandoffFallback(sessionId);
  }

  if (reply === null) {
    reply = FALLBACK_REPLY;
    aiFailed = true;
    await createHandoffFallback(sessionId);
  }

  // Un fallo de la IA no se guarda en el historial: el mensaje queda en la
  // cola de pendientes y se reprocesa desde cero, sin duplicar el turno.
  if (aiFailed) return { reply, tool_runs: toolRuns, ai_failed: true };

  saveConversation({
    id: sessionId,
    messages: trimToTurns([...history, ...turn]),
    updated_at: new Date().toISOString(),
    user_turn_count: userTurnCount,
    known_facts: knownFacts,
  });
  return { reply, tool_runs: toolRuns, ai_failed: aiFailed };
}

// Guarda un mensaje enviado sin IA (primer contacto por plantilla) para que
// Carolina tenga el contexto cuando el cliente conteste.
export function recordAssistantMessage(sessionId: string, text: string): void {
  const conversation = loadConversation(sessionId);
  saveConversation({ ...conversation, messages: trimToTurns([...conversation.messages, { role: "assistant", content: text }]), updated_at: new Date().toISOString() });
}

// Marca en disco, no en memoria: tras un reinicio no vuelve a inundar
// Pendientes con el mismo aviso (el apagón del 05/11 generó 5.511).
async function createHandoffFallback(sessionId: string) {
  if (!markOncePerWindow(`handoff_fallback_${sessionId}`, 24 * 3600 * 1000)) return;
  await dispatchTool("create_handoff", {
    reason: "El agente de chat no pudo cerrar la respuesta en el número de intentos",
    notes: `Conversación de chat ${sessionId}`,
    urgency: "alta",
  });
}
