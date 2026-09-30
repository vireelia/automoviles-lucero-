// Script operativo (no forma parte del backend desplegado): sincroniza el
// prompt + herramientas confirmados con Retell -- actualiza el LLM/Agente de
// VOZ ya en vivo (+16512880094) y crea/actualiza el LLM/Agente de CHAT.
// Uso: node --env-file=.env scripts/sync-retell.mjs [--publish]
//
// Arquitectura (Sección 1 del encargo): un único "cerebro" de reglas
// comerciales (prompt-core.md) + un addendum por canal (voz/chat) + UNA
// sola capa de herramientas apuntando siempre al mismo backend -- así no se
// crean "dos sistemas de lógica independientes" aunque haya dos objetos
// LLM en Retell (uno por canal, porque Retell no permite bifurcar un mismo
// general_prompt por canal dentro del mismo objeto).

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const API_KEY = process.env.RETELL_API_KEY;
if (!API_KEY) throw new Error("Falta RETELL_API_KEY (usa: node --env-file=.env scripts/sync-retell.mjs)");
const BASE = "https://api.retellai.com";
const TOOLS_BASE = "https://virelia-hub-lucero.lzc0bh.easypanel.host/tools";
const WEBHOOK_URL = "https://virelia-hub-lucero.lzc0bh.easypanel.host/webhooks/retell";
const SHOULD_PUBLISH = process.argv.includes("--publish");

// Extracción automática post-llamada/chat -- para el panel interno de
// Ramón/José, sin depender de que el agente lo diga en la conversación.
const POST_CALL_ANALYSIS_DATA = [
  { type: "string", name: "customer_name", description: "Nombre del cliente, si lo dio." },
  { type: "string", name: "vehicle_of_interest", description: "Marca y modelo del vehículo por el que preguntó, si quedó claro." },
  {
    type: "enum", name: "intent", description: "Intención principal de la conversación.",
    choices: ["comprar", "vender_o_tasar", "tramite", "consulta_general", "reclamacion", "otro"],
  },
  {
    type: "enum", name: "outcome", description: "Resultado al terminar la conversación.",
    choices: ["cita_solicitada", "reserva_derivada_a_equipo", "escalado_a_persona", "sin_avance"],
  },
  {
    type: "enum", name: "lead_temperature", description: "Temperatura del lead según la conversación (coincide con score_lead si se usó).",
    choices: ["COLD", "WARM", "HOT"],
  },
];

const STATE_PATH = path.join(ROOT, ".retell-state.json");
function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}
function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${method} ${urlPath} -> HTTP ${res.status}, respuesta no JSON: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`${method} ${urlPath} -> HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function readMd(name) {
  return readFileSync(path.join(ROOT, "src", "data", name), "utf8").trim();
}

const CORE = readMd("prompt-core.md");
const VOICE_ADDENDUM = readMd("prompt-voice.md");
const CHAT_ADDENDUM = readMd("prompt-chat.md");

const voicePrompt = `${CORE}\n\n${VOICE_ADDENDUM}`;
const chatPrompt = `${CORE}\n\n${CHAT_ADDENDUM}`;

writeFileSync(path.join(ROOT, "src", "data", "voice-prompt.generated.md"), voicePrompt);
writeFileSync(path.join(ROOT, "src", "data", "chat-prompt.generated.md"), chatPrompt);

const S = { type: "string" };
const N = { type: "number" };
const B = { type: "boolean" };

function tool(name, description, properties, required = []) {
  return {
    type: "custom",
    name,
    description,
    url: `${TOOLS_BASE}/${name}`,
    speak_during_execution: true,
    speak_after_execution: true,
    timeout_ms: 8000,
    parameters: { type: "object", properties, required },
  };
}

// Herramientas compartidas por voz y chat (Sección 43 + utilidades
// defensivas ya probadas en producción: get_business_info/get_appointment_slots
// evitan que el agente invente datos cuando no hay fuente conectada).
// Quedan fuera deliberadamente: confirm_reservation/cancel_reservation
// (Sección 26: exigen validación humana, no son tool del agente) y
// sync_inventory (Sección 46: automatización, no una acción de conversación).
// transfer_call SÍ está activo (ver transferTools en syncVoice) -- solo en
// voz, con Ramón y José ya confirmados.
const AGENT_TOOLS = [
  tool("get_business_info", "Devuelve políticas confirmadas del negocio (horarios, financiación, garantía, reserva, ubicación, WhatsApp).", {}, []),
  tool("search_vehicle", "Busca vehículos por texto libre, marca, modelo, tipo de carrocería, combustible o rango de precio/km.", {
    query: S, make: S, model: S,
    category: { type: "string", enum: ["SUV", "Berlina", "Compacto", "Monovolumen", "Familiar", "Urbano", "Furgoneta"] },
    fuel: S, max_price_eur: N, min_price_eur: N, max_km: N, page: N,
  }),
  tool("get_vehicle", "Devuelve la ficha completa de una unidad por su id interno.", { id: S }, ["id"]),
  tool("get_vehicle_status", "Consulta el estado oficial interno de un vehículo (AVAILABLE/RESERVATION_PENDING/RESERVED/SOLD).", { id: S }, ["id"]),
  tool("find_similar_vehicles", "Busca alternativas similares a un vehículo (mismo rango de precio/km, prioridad misma categoría). Máximo 3.", { vehicle_id: S }, ["vehicle_id"]),
  tool("create_lead", "Crea el registro del interesado si no existe (teléfono, nombre, intención, vehículo de interés, presupuesto, momento de compra).", {
    phone: S, name: S, intent: S, notes: S, channel: S, vehicle_interest: S, budget: S, purchase_timing: S,
  }),
  tool("update_lead", "Actualiza el registro de un interesado ya existente.", {
    phone: S, name: S, intent: S, notes: S, channel: S, vehicle_interest: S, budget: S, purchase_timing: S,
  }),
  tool("update_contact_preferences", "Guarda preferencias de contacto (ej. no volver a contactar, canal preferido).", { phone: S, do_not_contact: B, preferred_channel: S }, ["phone"]),
  tool("get_customer_history", "Recupera el historial de un cliente que ya contactó antes, para no repetirle preguntas.", { phone: S }, ["phone"]),
  tool("score_lead", "Clasifica internamente al lead (COLD/WARM/HOT) según la conversación. Nunca reveles la clasificación al cliente.", {
    phone: S, temperature: { type: "string", enum: ["COLD", "WARM", "HOT"] }, objection: S,
  }, ["phone", "temperature"]),
  tool("create_followup", "Registra un seguimiento programado para el lead (máximo 3 automáticos).", { phone: S, reason: S }, ["phone"]),
  tool("stop_followups", "Detiene los seguimientos de un lead (ej. pidió no ser contactado más).", { phone: S }, ["phone"]),
  tool("get_appointment_slots", "Comprueba huecos reales de agenda (hoy siempre confirma que no hay agenda conectada -- no inventes huecos).", {}, []),
  tool("create_appointment", "Registra una solicitud de cita (visita, prueba, tasación o reserva comercial). Nunca queda confirmada automáticamente.", {
    lead_phone: S, vehicle_id: S,
    appointment_type: { type: "string", enum: ["visita", "prueba", "tasacion", "reserva_comercial"] },
    requested_date: S, requested_time: S, notes: S,
  }),
  tool("update_appointment", "Modifica fecha/hora de una cita ya solicitada.", { appointment_id: S, requested_date: S, requested_time: S, notes: S }, ["appointment_id"]),
  tool("cancel_appointment", "Cancela una cita ya solicitada.", { appointment_id: S, reason: S }, ["appointment_id"]),
  // create_reservation_pending / submit_payment_receipt quedaron FUERA de las
  // tools del agente a propósito (decisión del usuario): la reserva y el
  // pago de la señal de 500€ los gestiona siempre un comercial directamente,
  // nunca el agente -- basta con create_handoff urgente. El backend sigue
  // teniendo esas funciones por si se necesitan desde una herramienta
  // interna del equipo más adelante, pero no se le declaran a Retell.
  tool("request_financing", "Registra una solicitud de financiación y comprueba los criterios orientativos confirmados. Nunca aprueba ni calcula cuota.", { lead_phone: S, vehicle_id: S }),
  tool("create_vehicle_valuation", "Registra una solicitud de tasación/compra de un vehículo que trae el cliente (venta a particular). Nunca tasa automáticamente.", {
    lead_phone: S, make: S, model: S, year: N, km: N, condition: S, known_issues: S, expected_price_eur: N, trade_in_vehicle_id: S,
  }),
  tool("create_service_request", "Registra una solicitud de trámite (transferencia, cambio de titularidad, baja, informe DGT) sin dar precios no confirmados.", { lead_phone: S, procedure_type: S, notes: S }),
  tool("create_handoff", "Registra una solicitud de atención humana o devolución de llamada. Úsalo para escalar cualquier caso de la Sección 40.", {
    lead_phone: S, reason: S, urgency: { type: "string", enum: ["normal", "alta"] }, notes: S,
  }),
  tool("send_vehicle_link", "Registra el envío del enlace individual de un vehículo (coches.net) a un canal del cliente. Nunca inventes la URL.", { lead_phone: S, vehicle_id: S, channel: S }),
  tool("send_location", "Devuelve la dirección y referencias de metro confirmadas del concesionario.", {}, []),
  tool("send_whatsapp", "Registra el envío de un mensaje de WhatsApp al cliente (queda en cola, sin integración de envío real todavía).", { lead_phone: S, message: S }),
  tool("notify_salesperson", "Notifica al vendedor (Ramón/José) de un lead caliente o incidencia urgente. Queda en cola hasta conectar el destino real.", {
    name: S, phone: S, vehicle: S, channel: { type: "string", enum: ["VOICE", "CHAT"] }, intent: S, objection: S, last_action: S, summary: S, urgency: { type: "string", enum: ["normal", "alta"] },
  }),
  tool("save_conversation", "Guarda la conversación (transcripción/resumen/intención/vehículo/resultado) al terminar la gestión.", {
    phone: S, channel: { type: "string", enum: ["VOICE", "CHAT"] }, transcript: S, summary: S, intent: S, vehicle_id: S, outcome: S,
  }, ["channel"]),
  tool("create_conversation_summary", "Guarda un resumen corto de la conversación para el historial del lead.", { phone: S, summary: S }, ["summary"]),
];

async function syncVoice(state) {
  console.log("== Actualizando LLM de VOZ en vivo ==");
  const llmId = state.voice_llm_id ?? "llm_1160238e920c112c159f5a6768db";
  const agentId = state.voice_agent_id ?? "agent_283e9ab2882dc0e65b85db9945";

  // Transferencia real de llamada, SOLO en voz (no aplica a chat). Orden
  // confirmado por el usuario 30/09/2026: Ramón primero, José si no
  // contesta -- son dos tools de transfer_call separadas porque Retell no
  // encadena varios destinos en una sola; el prompt decide cuál probar.
  function warmTransferOption(name) {
    return {
      type: "warm_transfer",
      agent_detection_timeout_ms: 20000,
      public_handoff_option: { type: "static_message", message: `Un momento, te paso con ${name}.` },
    };
  }
  const transferTools = [
    {
      type: "transfer_call",
      name: "transfer_to_ramon",
      description: "Transfiere la llamada a Ramón (responsable principal). Probar siempre primero para cualquier transferencia a una persona.",
      transfer_destination: { type: "predefined", number: "+34622177052" },
      transfer_option: warmTransferOption("Ramón"),
    },
    {
      type: "transfer_call",
      name: "transfer_to_jose",
      description: "Transfiere la llamada a José (hermano de Ramón). Usar SOLO si ya se intentó transfer_to_ramon y no contestó.",
      transfer_destination: { type: "predefined", number: "+34624807069" },
      transfer_option: warmTransferOption("José"),
    },
  ];

  const generalTools = [
    { type: "end_call", name: "end_call", description: "Termina la llamada cuando la conversación ha concluido de forma natural.", speak_after_execution: true },
    ...transferTools,
    ...AGENT_TOOLS,
  ];

  try {
    await api("PATCH", `/update-retell-llm/${llmId}`, {
      general_prompt: voicePrompt,
      general_tools: generalTools,
      begin_message: "Hola, has llamado a Automóviles Lucero. Soy Miguel, el asistente de inteligencia artificial. ¿En qué puedo ayudarte?",
    });
    console.log("LLM de voz actualizado:", llmId);
  } catch (err) {
    if (!String(err.message).includes("Cannot update published LLM")) throw err;
    // La versión publicada quedó inmutable -- hay que crear un nuevo draft
    // de agente (mismo llm_id, nueva versión editable) antes de poder tocar
    // el prompt/tools otra vez.
    const current = await api("GET", `/get-agent/${agentId}`);
    console.log(`LLM publicado e inmutable -- creando nuevo draft a partir de la version ${current.version}...`);
    await api("POST", `/create-agent-version/${agentId}`, { base_version: current.version });
    await api("PATCH", `/update-retell-llm/${llmId}`, {
      general_prompt: voicePrompt,
      general_tools: generalTools,
      begin_message: "Hola, has llamado a Automóviles Lucero. Soy Miguel, el asistente de inteligencia artificial. ¿En qué puedo ayudarte?",
    });
    console.log("LLM de voz actualizado en el nuevo draft:", llmId);
  }

  // Pronunciación real: Cartesia decía "Carabangel" en vez de "Carabanchel".
  // pronunciation_dictionary vive en el objeto AGENTE (no en el LLM) -- para
  // esta fecha, el draft ya está desbloqueado por el bloque de arriba, así
  // que esto debería aplicar directo. Sin garantía de que Cartesia soporte
  // IPA -- solo se confirma probando con audio real.
  await api("PATCH", `/update-agent/${agentId}`, {
    pronunciation_dictionary: [{ word: "Carabanchel", alphabet: "ipa", phoneme: "kaɾaβanˈtʃel" }],
    webhook_url: WEBHOOK_URL,
    post_call_analysis_data: POST_CALL_ANALYSIS_DATA,
  });
  console.log("Diccionario de pronunciación + webhook + análisis post-llamada actualizados.");

  const agent = await api("GET", `/get-agent/${agentId}`);
  console.log(`Draft del agente de voz ahora en version ${agent.version} (is_published=${agent.is_published})`);

  if (SHOULD_PUBLISH) {
    await api("POST", `/publish-agent-version/${agentId}`, {
      version: agent.version,
      version_title: "Especificación maestra 29/09/2026 + humanización",
    });
    console.log(`Publicado: version ${agent.version} del agente de voz es ahora la versión en vivo.`);
  } else {
    console.log("No publicado todavía (pasa --publish para hacerlo en vivo en +16512880094).");
  }

  state.voice_llm_id = llmId;
  state.voice_agent_id = agentId;
  return state;
}

async function syncChat(state) {
  console.log("== Creando/actualizando LLM + Agente de CHAT ==");
  let chatLlmId = state.chat_llm_id;
  if (!chatLlmId) {
    const llm = await api("POST", "/create-retell-llm", {
      model: "gpt-4.1-mini",
      model_temperature: 0.3,
      general_prompt: chatPrompt,
      general_tools: AGENT_TOOLS,
      begin_message: "Hola, soy Miguel, el asistente de inteligencia artificial de Automóviles Lucero. ¿En qué puedo ayudarte?",
    });
    chatLlmId = llm.llm_id;
    console.log("LLM de chat creado:", chatLlmId);
  } else {
    try {
      await api("PATCH", `/update-retell-llm/${chatLlmId}`, {
        general_prompt: chatPrompt,
        general_tools: AGENT_TOOLS,
        begin_message: "Hola, soy Miguel, el asistente de inteligencia artificial de Automóviles Lucero. ¿En qué puedo ayudarte?",
      });
      console.log("LLM de chat actualizado:", chatLlmId);
    } catch (err) {
      if (!String(err.message).includes("Cannot update published LLM")) throw err;
      const current = await api("GET", `/get-chat-agent/${state.chat_agent_id}`);
      console.log(`LLM de chat publicado e inmutable -- creando nuevo draft a partir de la version ${current.version}...`);
      await api("POST", `/create-agent-version/${state.chat_agent_id}`, { base_version: current.version });
      await api("PATCH", `/update-retell-llm/${chatLlmId}`, {
        general_prompt: chatPrompt,
        general_tools: AGENT_TOOLS,
        begin_message: "Hola, soy Miguel, el asistente de inteligencia artificial de Automóviles Lucero. ¿En qué puedo ayudarte?",
      });
      console.log("LLM de chat actualizado en el nuevo draft:", chatLlmId);
    }
  }

  let chatAgentId = state.chat_agent_id;
  if (!chatAgentId) {
    const agent = await api("POST", "/create-chat-agent", {
      response_engine: { type: "retell-llm", llm_id: chatLlmId },
      agent_name: "Automóviles Lucero - Chat",
      language: "es-ES",
      data_storage_setting: "everything",
    });
    chatAgentId = agent.agent_id;
    console.log("Chat agent creado:", chatAgentId, "(version", agent.version, ", is_published:", agent.is_published, ")");
  } else {
    console.log("Chat agent ya existente:", chatAgentId, "-- LLM actualizado, no hace falta tocar el agente.");
  }

  // Endpoint distinto al de voz (/update-chat-agent, no /update-agent) y
  // campo distinto (post_chat_analysis_data, no post_call_analysis_data) --
  // confirmado contra la documentación real, no adivinado.
  try {
    await api("PATCH", `/update-chat-agent/${chatAgentId}`, {
      webhook_url: WEBHOOK_URL,
      post_chat_analysis_data: POST_CALL_ANALYSIS_DATA,
    });
    console.log("Webhook + análisis post-chat actualizados.");
  } catch (err) {
    if (!String(err.message).includes("Cannot update published agent")) throw err;
    const current = await api("GET", `/get-chat-agent/${chatAgentId}`);
    await api("POST", `/create-agent-version/${chatAgentId}`, { base_version: current.version });
    await api("PATCH", `/update-chat-agent/${chatAgentId}`, {
      webhook_url: WEBHOOK_URL,
      post_chat_analysis_data: POST_CALL_ANALYSIS_DATA,
    });
    console.log("Webhook + análisis post-chat actualizados en nuevo draft.");
  }

  if (SHOULD_PUBLISH) {
    const agent = await api("GET", `/get-chat-agent/${chatAgentId}`);
    // Mismo endpoint que los agentes de voz -- Retell no tiene una ruta
    // separada de publish para chat agents, pese a lo que sugiere el índice
    // de su documentación.
    await api("POST", `/publish-agent-version/${chatAgentId}`, { version: agent.version });
    console.log(`Publicado: version ${agent.version} del chat agent es ahora la versión activa.`);
  } else {
    console.log("No publicado todavía (pasa --publish para activarlo).");
  }

  state.chat_llm_id = chatLlmId;
  state.chat_agent_id = chatAgentId;
  return state;
}

let state = loadState();
state = await syncVoice(state);
state = await syncChat(state);
saveState(state);
console.log("\nEstado guardado en", STATE_PATH);
