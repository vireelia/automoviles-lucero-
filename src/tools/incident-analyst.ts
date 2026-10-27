import { readCollection, appendToCollection } from "../store.js";

// Agente de calidad real (27/10/2026, "un agente de ia que lo resuelva de
// verdad... y me de los informes para arreglarlo"): revisa las incidencias
// REALES ya detectadas por el propio análisis automático de Retell
// (issues_detected/security_event en call_analyses, nunca inventadas aquí)
// y las razona de verdad con un LLM -- agrupa por causa probable,
// prioriza, y dice qué tocar. Bajo demanda (botón en Informes, admin), no
// automático: cada análisis es una llamada real a la IA, con coste real.
type CallAnalysisRow = {
  channel: string;
  created_at: string;
  issues_detected?: string | null;
  security_event?: string | null;
};

export type IncidentAnalysis = {
  id: string;
  created_at: string;
  incident_count: number;
  report: string;
};

const MODEL = process.env.LUCERO_CHAT_MODEL ?? "gpt-4.1-mini";
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";

function realIncidents(): { created_at: string; channel: string; text: string }[] {
  const calls = readCollection<CallAnalysisRow>("call_analyses");
  const out: { created_at: string; channel: string; text: string }[] = [];
  for (const c of calls) {
    if (c.issues_detected && c.issues_detected !== "ninguno") out.push({ created_at: c.created_at, channel: c.channel, text: c.issues_detected });
    if (c.security_event && c.security_event !== "ninguno") out.push({ created_at: c.created_at, channel: c.channel, text: `[seguridad] ${c.security_event}` });
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function lastIncidentAnalysis(): IncidentAnalysis | null {
  const all = readCollection<IncidentAnalysis>("incident_analyses");
  return all.length ? all[all.length - 1] : null;
}

export async function analyzeIncidents(): Promise<{ ok: true; analysis: IncidentAnalysis } | { ok: false; error: string }> {
  const incidents = realIncidents();
  if (incidents.length === 0) return { ok: false, error: "sin_incidencias" };
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "llm_no_configurado" };

  const listado = incidents.map((i, idx) => `${idx + 1}. [${i.created_at}, ${i.channel}] ${i.text}`).join("\n");
  const prompt = `Eres un analista de calidad real para el agente de IA de un concesionario de coches (Automóviles Lucero: Miguel por voz, Carolina por WhatsApp, Daniel por correo). Te paso TODAS las incidencias reales que el propio análisis automático de cada llamada/chat ya detectó -- nunca inventes ninguna que no esté en la lista.

Tu trabajo:
1. Agrupa las incidencias que sean el mismo problema real repetido (di cuántas veces pasó cada una).
2. Ordena los grupos de más grave a menos grave (afecta a datos/dinero/confianza del cliente > confusión menor que se autocorrigió).
3. Para cada grupo: una frase de causa probable real (basada solo en el texto dado) y una frase de qué revisar o corregir (en el prompt, en una herramienta, o en datos del inventario).
4. Si una incidencia ya parece corregida en el propio texto (p. ej. dice "se corrigió"), dilo, no la trates como pendiente.

Responde en español, en una lista clara con títulos cortos por grupo, sin relleno ni disculpas.

Incidencias reales (${incidents.length} en total):
${listado}`;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, temperature: 0.2, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) return { ok: false, error: `llm_http_${res.status}` };
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const report = data.choices?.[0]?.message?.content?.trim();
  if (!report) return { ok: false, error: "llm_sin_respuesta" };

  const analysis: IncidentAnalysis = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    incident_count: incidents.length,
    report,
  };
  appendToCollection("incident_analyses", analysis);
  return { ok: true, analysis };
}
