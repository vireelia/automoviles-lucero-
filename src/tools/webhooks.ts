import { mutateCollection } from "../store.js";

// Receptor de webhooks de Retell (call_analyzed / chat_analyzed). Guarda el
// análisis automático (custom_analysis_data) que configuramos en el agente
// -- nombre, vehículo de interés, intención, resultado, temperatura -- para
// que el panel interno (Sección "panel para Ramón/José") lo pueda mostrar
// sin que nadie tenga que leer transcripts a mano. No verificamos la firma
// del webhook todavía (pendiente si hace falta más adelante) -- por ahora
// solo registra, no ejecuta ninguna acción sensible a partir del payload.
// "Cerebro" de calidad de llamadas (15/10/2026, a petición real: "construye
// un cerebro para mejorar la calidad de las llamadas"). En vez de depender
// de analizar transcripts a mano cada vez, cada llamada real queda marcada
// aquí mismo con la pausa más larga detectada y si hace falta revisarla --
// así el equipo (o quien retome este proyecto) ve de un vistazo qué
// llamadas reales merece la pena escuchar, en vez de tener que pedir la API
// de Retell cada vez.
function maxPauseSeconds(transcriptObject: any): number | null {
  if (!Array.isArray(transcriptObject) || transcriptObject.length < 2) return null;
  let max = 0;
  for (let i = 1; i < transcriptObject.length; i++) {
    const prevWords = transcriptObject[i - 1]?.words;
    const curWords = transcriptObject[i]?.words;
    if (!Array.isArray(prevWords) || prevWords.length === 0) continue;
    if (!Array.isArray(curWords) || curWords.length === 0) continue;
    const prevEnd = prevWords[prevWords.length - 1]?.end;
    const curStart = curWords[0]?.start;
    if (typeof prevEnd !== "number" || typeof curStart !== "number") continue;
    const gap = curStart - prevEnd;
    if (gap > max) max = gap;
  }
  return max;
}

export async function handleRetellWebhook(payload: any) {
  const event = payload?.event;
  if (event !== "call_analyzed" && event !== "chat_analyzed") {
    return { received: true, ignored: true, event };
  }

  const call = payload.call ?? payload.chat ?? {};
  const analysis = call.call_analysis ?? call.chat_analysis ?? {};
  const maxPauseSec = event === "call_analyzed" ? maxPauseSeconds(call.transcript_object) : null;
  const issues = analysis.custom_analysis_data?.issues_detected ?? null;
  const security = analysis.custom_analysis_data?.security_event ?? null;
  const needsReview = Boolean(
    analysis.call_successful === false ||
      (maxPauseSec != null && maxPauseSec > 6) ||
      (issues && issues !== "ninguno") ||
      (security && security !== "ninguno"),
  );
  const record = {
    id: crypto.randomUUID(),
    event,
    channel: event === "call_analyzed" ? "VOICE" : "CHAT",
    call_id: call.call_id ?? call.chat_id ?? null,
    from_number: call.from_number ?? null,
    duration_ms: call.duration_ms ?? null,
    disconnection_reason: call.disconnection_reason ?? null,
    // combined_cost viene en céntimos de dólar reales (confirmado contra la
    // API de Retell, 13/10/2026) -- se guarda tal cual, el panel lo divide
    // entre 100 para mostrar euros/dólares.
    cost_cents: call.call_cost?.combined_cost ?? null,
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
    // transfer_outcome (13/10/2026, transferencias reales a Ramón/José):
    // igual que arriba, aplanado para que el panel lo muestre sin abrir el
    // JSON. Lo rellena el propio análisis de Retell leyendo la llamada
    // real -- no es un evento en vivo por cada intento.
    transfer_outcome: analysis.custom_analysis_data?.transfer_outcome ?? null,
    // Motivo real de la llamada (25/10/2026, encargo: "6.3. Motivo de la
    // llamada" tiene que ser distinto de "6.4. Resumen" y nunca
    // sobrescribirse entre llamadas) -- Retell YA analiza esto en cada
    // llamada (post_call_analysis_data, scripts/sync-retell.mjs) pero nunca
    // se guardaba. intent es un enum real (comprar/vender_o_tasar/trámite/
    // consulta_general/reclamación/otro); vehicle_of_interest es lo que
    // Retell entendió en ESA llamada concreta (puede ser distinto del
    // vehicle_interest guardado en el lead, que es acumulado). Ninguno de
    // los dos se inventa aquí: si Retell no los da, quedan en null y el
    // CRM no muestra "Motivo" para esa llamada.
    intent: analysis.custom_analysis_data?.intent ?? null,
    call_vehicle_of_interest: analysis.custom_analysis_data?.vehicle_of_interest ?? null,
    outcome: analysis.custom_analysis_data?.outcome ?? null,
    custom_analysis_data: analysis.custom_analysis_data ?? {},
    max_pause_sec: maxPauseSec,
    needs_review: needsReview,
    // Grabación/transcripción reales (25/10/2026, Contactos Pro): Retell ya
    // las manda en este mismo payload pero nunca se guardaban -- sin esto,
    // cualquier reproductor/transcripción en el CRM sería un adorno sin
    // datos detrás. Se guardan tal cual vienen, nunca inventadas; si
    // Retell no las manda (plan/config distinto), quedan en null y el CRM
    // simplemente no muestra esa sección para esa llamada.
    recording_url: call.recording_url ?? null,
    transcript: call.transcript ?? null,
    direction: call.direction ?? null,
    created_at: new Date().toISOString(),
  };
  // Deduplicación real por call_id (25/10/2026, encargo de fiabilidad: "un
  // webhook repetido no debe crear una segunda llamada") -- mismo patrón ya
  // probado en Zernio/Gmail (zernio_whatsapp_processed/email_processed),
  // ahora también aquí. Si Retell reintenta el mismo evento (corte de red,
  // timeout), se actualiza el registro ya existente en vez de duplicarlo.
  // Sin call_id real no hay nada con qué deduplicar -- se guarda tal cual,
  // como siempre.
  let storedId = record.id;
  await mutateCollection<typeof record>("call_analyses", (items) => {
    const existingIdx = record.call_id ? items.findIndex((c) => c.call_id === record.call_id) : -1;
    if (existingIdx >= 0) {
      storedId = items[existingIdx].id;
      items[existingIdx] = { ...record, id: storedId };
      return items;
    }
    items.push(record);
    return items;
  });
  return { received: true, stored: storedId };
}
