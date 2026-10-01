import { readCollection } from "./store.js";

// Panel interno mínimo para Ramón/José -- sin build, sin JS framework,
// una sola página HTML generada en el servidor. Protegido con Basic Auth
// (ver requireBasicAuth en server.ts) usando el mismo ADMIN_TOKEN que las
// rutas /admin/*. No es el CRM real (Sección 45 del encargo) -- es una
// ventana de solo lectura sobre lo que ya guarda el backend, para que no
// dependan de que alguien les lea el JSON a mano.

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function table(title: string, rows: Record<string, unknown>[], columns: string[]): string {
  if (rows.length === 0) return `<h2>${esc(title)}</h2><p class="empty">Sin registros todavía.</p>`;
  const head = columns.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = rows
    .slice()
    .reverse()
    .slice(0, 50)
    .map((r) => `<tr>${columns.map((c) => `<td>${esc(typeof r[c] === "object" ? JSON.stringify(r[c]) : r[c])}</td>`).join("")}</tr>`)
    .join("");
  return `<h2>${esc(title)} <span class="count">(${rows.length})</span></h2><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderPanel(): string {
  const leads = readCollection<any>("leads", []);
  const appointments = readCollection<any>("appointments", []);
  const handoffs = readCollection<any>("handoffs", []);
  const purchaseRequests = readCollection<any>("purchase_requests", []);
  const reservations = readCollection<any>("reservations", []);
  const callAnalyses = readCollection<any>("call_analyses", []);
  // Registro de incidencias (Sección "memoria/aprendizaje", 01/10/2026): el
  // propio análisis post-llamada/chat de Retell detecta fallos del agente
  // (pronunciación, repeticiones, quejas del cliente...) sin que nadie tenga
  // que acordarse de reportarlos -- esto es lo que convierte eso en algo
  // revisable sin abrir el JSON completo.
  const issues = callAnalyses.filter((c) => c.issues_detected && c.issues_detected !== "ninguno");

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Automóviles Lucero -- Panel interno</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #f7f7f8; color: #1a1a1a; }
  h1 { font-size: 1.3rem; margin-bottom: 4px; }
  .sub { color: #666; font-size: 0.85rem; margin-bottom: 24px; }
  h2 { font-size: 1rem; margin-top: 28px; margin-bottom: 8px; }
  .count { color: #888; font-weight: normal; font-size: 0.85rem; }
  table { width: 100%; border-collapse: collapse; background: #fff; font-size: 0.82rem; overflow-x: auto; display: block; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; white-space: nowrap; max-width: 280px; overflow: hidden; text-overflow: ellipsis; }
  th { background: #f0f0f0; position: sticky; top: 0; }
  .empty { color: #999; font-size: 0.85rem; }
  .issues-table td:nth-child(3) { color: #a33; font-weight: 600; white-space: normal; }
</style></head>
<body>
<h1>Automóviles Lucero -- Panel interno</h1>
<p class="sub">Solo lectura. Se actualiza al recargar la página. No es el CRM final, es una vista provisional de lo que el agente ya registró.</p>
<div class="issues-table">
${table("Incidencias detectadas por el agente (revisar y corregir)", issues, ["channel", "from_number", "issues_detected", "summary", "created_at"])}
</div>
${table("Leads", leads, ["name", "phone", "vehicle_interest", "temperature", "intent", "updated_at"])}
${table("Citas", appointments, ["vehicle_id", "appointment_type", "requested_date", "requested_time", "status"])}
${table("Solicitudes de atención (handoffs)", handoffs, ["lead_phone", "reason", "urgency", "status", "created_at"])}
${table("Tasaciones / compra a particulares", purchaseRequests, ["make", "model", "year", "km", "expected_price_eur", "status"])}
${table("Reservas", reservations, ["vehicle_id", "amount_eur", "status", "created_at", "expires_at"])}
${table("Análisis automático de llamadas/chats", callAnalyses, ["channel", "from_number", "summary", "custom_analysis_data", "created_at"])}
</body></html>`;
}
