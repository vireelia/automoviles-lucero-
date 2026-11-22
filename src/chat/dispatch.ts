import { withRequiredName } from "../tools/client-name.js";
import { getBusinessInfo } from "../tools/business.js";
import { searchVehicles, getVehicle, getVehicleStatus, findSimilarVehicles } from "../tools/vehicles.js";
import { upsertLead, updateContactPreferences, getCustomerHistory, scoreLead, createFollowup, stopFollowups } from "../tools/leads.js";
import { createServiceRequest, createHandoff, createVehicleValuation } from "../tools/requests.js";
import { getAppointmentSlots, createAppointmentWithCalendar, updateAppointment, cancelAppointment } from "../tools/appointments.js";
import { createReservationPending } from "../tools/reservations.js";
import { sendVehicleLink, sendLocation, sendWhatsapp, notifySalesperson, getResponsableContact, saveConversation, createConversationSummary } from "../tools/delivery.js";
import { requestFinancing } from "../tools/financing.js";

// Mismo mapeo que las rutas /tools/* del servidor, pero llamado en proceso:
// así el agente de chat no necesita que las herramientas estén expuestas por HTTP.
const HANDLERS: Record<string, (args: any) => unknown> = {
  get_business_info: () => getBusinessInfo(),
  // FALLO REAL CRÍTICO detectado en auditoría (18/11/2026): esta clave
  // estaba en singular ("search_vehicle") pero el prompt (prompt-core.md,
  // compartido por voz y chat) y Retell (sync-retell.mjs) siempre
  // llamaron a "search_vehicles" (plural) -- y esa tool ni siquiera
  // estaba declarada en tool-schemas.json para WhatsApp/correo/chat web,
  // así que la IA en esos 3 canales JAMÁS pudo buscar vehículos: cada
  // intento habría devuelto { error_code: "unknown_tool" } si el nombre
  // llegaba a declararse alguna vez, o ni siquiera habría podido
  // intentarlo (la API de OpenAI solo permite llamar a tools declaradas).
  // Mismo fallo exacto que create_reservation_pending, mismo origen: el
  // chat propio (fuera de Retell) nunca llegó a sincronizar su lista de
  // tools con la intención real documentada ("herramientas compartidas
  // por voz y chat", sync-retell.mjs:156).
  search_vehicles: (a) => searchVehicles(a),
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
  create_appointment: (a) => withRequiredName(createAppointmentWithCalendar)(a),
  update_appointment: (a) => updateAppointment(a),
  cancel_appointment: (a) => cancelAppointment(a),
  request_financing: (a) => requestFinancing(a),
  create_vehicle_valuation: (a) => createVehicleValuation(a),
  // FALLO REAL CRÍTICO detectado en auditoría (18/11/2026): prompt-chat.md
  // instruye explícitamente a Carolina/Daniel a llamar a
  // create_reservation_pending en cuanto el cliente confirma que quiere
  // reservar -- pero esta tool nunca estuvo en este mapa (solo existía la
  // ruta HTTP /tools/create_reservation_pending para Retell/voz). Cada
  // intento real de esta herramienta desde WhatsApp/correo/chat web
  // devolvía { status: "error", error_code: "unknown_tool" } en silencio
  // -- la reserva JAMÁS se creaba de verdad en esos tres canales, solo el
  // create_handoff (aviso suelto) llegaba al equipo. Coincide exactamente
  // con el incidente ya documentado el 18/10/2026 ("jamás apareció la
  // reserva de verdad en el sistema") -- la causa raíz real de ese
  // incidente era esta, no solo un fallo de seguimiento del prompt.
  create_reservation_pending: (a) => withRequiredName(createReservationPending)(a),
  create_service_request: (a) => createServiceRequest(a),
  create_handoff: (a) => createHandoff(a),
  // En el chat el enlace viaja dentro de la respuesta, así que sí se entrega.
  send_vehicle_link: async (a) => {
    const r = (await sendVehicleLink(a)) as unknown as { data: { url: string; is_individual_url: boolean }; conflicts: string[] };
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
  get_responsable_contact: (a) => getResponsableContact(a),
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
