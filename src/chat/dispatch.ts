import { getBusinessInfo } from "../tools/business.js";
import { searchVehicles, getVehicle, getVehicleStatus, findSimilarVehicles } from "../tools/vehicles.js";
import { upsertLead, updateContactPreferences, getCustomerHistory, scoreLead, createFollowup, stopFollowups } from "../tools/leads.js";
import { createServiceRequest, createHandoff, createVehicleValuation } from "../tools/requests.js";
import { getAppointmentSlots, createAppointmentWithCalendar, updateAppointment, cancelAppointment } from "../tools/appointments.js";
import { sendVehicleLink, sendLocation, sendWhatsapp, notifySalesperson, saveConversation, createConversationSummary } from "../tools/delivery.js";
import { requestFinancing } from "../tools/financing.js";

// Mismo mapeo que las rutas /tools/* del servidor, pero llamado en proceso:
// así el agente de chat no necesita que las herramientas estén expuestas por HTTP.
const HANDLERS: Record<string, (args: any) => unknown> = {
  get_business_info: () => getBusinessInfo(),
  search_vehicle: (a) => searchVehicles(a),
  get_vehicle: (a) => getVehicle(a),
  get_vehicle_status: (a) => getVehicleStatus(a),
  find_similar_vehicles: (a) => findSimilarVehicles(a),
  create_lead: (a) => upsertLead(a),
  update_lead: (a) => upsertLead(a),
  update_contact_preferences: (a) => updateContactPreferences(a),
  get_customer_history: (a) => getCustomerHistory(a),
  score_lead: (a) => scoreLead(a),
  create_followup: (a) => createFollowup(a),
  stop_followups: (a) => stopFollowups(a),
  get_appointment_slots: () => getAppointmentSlots(),
  create_appointment: (a) => createAppointmentWithCalendar(a),
  update_appointment: (a) => updateAppointment(a),
  cancel_appointment: (a) => cancelAppointment(a),
  request_financing: (a) => requestFinancing(a),
  create_vehicle_valuation: (a) => createVehicleValuation(a),
  create_service_request: (a) => createServiceRequest(a),
  create_handoff: (a) => createHandoff(a),
  // En el chat el enlace viaja dentro de la respuesta, así que sí se entrega.
  send_vehicle_link: (a) => {
    const r = sendVehicleLink(a) as unknown as { data: { url: string; is_individual_url: boolean }; conflicts: string[] };
    return {
      status: "ok",
      data: { url: r.data.url, is_individual_url: r.data.is_individual_url },
      source: "enlace incluido en la respuesta del chat",
      conflicts: r.conflicts,
    };
  },
  send_location: () => sendLocation(),
  send_whatsapp: (a) => sendWhatsapp(a),
  notify_salesperson: (a) => notifySalesperson(a),
  save_conversation: (a) => saveConversation(a),
  create_conversation_summary: (a) => createConversationSummary(a),
};

export const AGENT_TOOL_NAMES = Object.keys(HANDLERS);

export async function dispatchTool(name: string, args: unknown): Promise<unknown> {
  const handler = HANDLERS[name];
  if (!handler) return { status: "error", error_code: "unknown_tool" };
  try {
    return await handler(args ?? {});
  } catch (err) {
    return { status: "error", error_code: err instanceof Error ? err.message : "unknown_error" };
  }
}
