import { appendToCollection } from "../store.js";

// Receptor de webhooks de Retell (call_analyzed / chat_analyzed). Guarda el
// análisis automático (custom_analysis_data) que configuramos en el agente
// -- nombre, vehículo de interés, intención, resultado, temperatura -- para
// que el panel interno (Sección "panel para Ramón/José") lo pueda mostrar
// sin que nadie tenga que leer transcripts a mano. No verificamos la firma
// del webhook todavía (pendiente si hace falta más adelante) -- por ahora
// solo registra, no ejecuta ninguna acción sensible a partir del payload.
export function handleRetellWebhook(payload: any) {
  const event = payload?.event;
  if (event !== "call_analyzed" && event !== "chat_analyzed") {
    return { received: true, ignored: true, event };
  }

  const call = payload.call ?? payload.chat ?? {};
  const analysis = call.call_analysis ?? call.chat_analysis ?? {};
  const record = {
    id: crypto.randomUUID(),
    event,
    channel: event === "call_analyzed" ? "VOICE" : "CHAT",
    call_id: call.call_id ?? call.chat_id ?? null,
    from_number: call.from_number ?? null,
    duration_ms: call.duration_ms ?? null,
    call_successful: analysis.call_successful ?? null,
    summary: analysis.call_summary ?? null,
    // issues_detected (Sección "registro de incidencias", 01/10/2026): campo
    // aplanado desde custom_analysis_data para que el panel lo pueda filtrar
    // directamente, sin que Ramón/José tengan que abrir el JSON completo.
    issues_detected: analysis.custom_analysis_data?.issues_detected ?? null,
    // security_event (endurecimiento de seguridad, 01/10/2026): igual que
    // arriba pero para intentos de ataque/abuso (prompt injection, falsa
    // autoridad, etc.) -- aplanado para el panel.
    security_event: analysis.custom_analysis_data?.security_event ?? null,
    custom_analysis_data: analysis.custom_analysis_data ?? {},
    created_at: new Date().toISOString(),
  };
  appendToCollection("call_analyses", record);
  return { received: true, stored: record.id };
}
