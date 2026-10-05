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

type ConversationRecord = { id: string; messages: ChatMessage[]; updated_at: string };

const MODEL = process.env.LUCERO_CHAT_MODEL ?? "gpt-4.1-mini";
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
const MAX_TURNS_KEPT = 20;
const MAX_TOOL_ROUNDS = 6;
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

async function callLlm(messages: ChatMessage[]): Promise<{ message: ChatMessage }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new LlmNotConfigured();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, temperature: 0.3, messages, tools: llmTools(), tool_choice: "auto" }),
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

export async function handleChatMessage(sessionId: string, userText: string): Promise<{ reply: string; tool_runs: number }> {
  const conversation = loadConversation(sessionId);
  // El identificador de sesión del canal es el teléfono del cliente. Se registra
  // el lead en el primer contacto: sin él no se pueden hacer seguimientos ni
  // consultar el historial del cliente.
  if (/^\+?\d{6,15}$/.test(sessionId)) {
    await dispatchTool("create_lead", { phone: sessionId, channel: "CHAT" });
  }
  const history = trimToTurns(conversation.messages);
  const turn: ChatMessage[] = [{ role: "user", content: userText }];
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt() }, ...history, ...turn];

  let toolRuns = 0;
  let reply: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS && reply === null; round++) {
    const { message } = await callLlm(messages);
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
        const result = await dispatchTool(call.function.name, args);
        toolRuns++;
        appendToCollection("tool_call_logs", {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          tool: call.function.name,
          channel: "chat-propio",
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
