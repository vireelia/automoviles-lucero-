// Reenvía el análisis de una llamada de voz a n8n, que crea el lead con origen VOZ.
// Es disparar y olvidar: un fallo de n8n nunca debe afectar a la respuesta que
// recibe Retell, y el análisis ya queda guardado en el backend antes de llamar aquí.
export function forwardVoiceAnalysis(payload: any): void {
  const url = process.env.N8N_VOZ_WEBHOOK_URL;
  if (!url || payload?.event !== "call_analyzed") return;
  const call = payload.call ?? {};
  const analysis = call.call_analysis ?? {};
  const custom = analysis.custom_analysis_data ?? {};
  const body = {
    event: payload.event,
    call_id: call.call_id ?? null,
    from_number: call.from_number ?? null,
    summary: analysis.call_summary ?? null,
    customer_name: custom.customer_name ?? null,
    vehicle_of_interest: custom.vehicle_of_interest ?? null,
    intent: custom.intent ?? null,
    outcome: custom.outcome ?? null,
    lead_temperature: custom.lead_temperature ?? null,
  };
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
    .then((res) => {
      if (!res.ok) console.error("[n8n] voz: respuesta", res.status);
    })
    .catch((err) => console.error("[n8n] voz:", err instanceof Error ? err.message : err));
}
