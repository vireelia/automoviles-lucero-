import { readCollection, writeCollection } from "../store.js";

// Plantillas de WhatsApp editables desde Ajustes (26/10/2026, "construyelo"
// sobre el placeholder de Plantillas). Mismo patrón que business-config.ts
// (colección JSON, sin caché -- toma efecto al momento). Solo entran aquí
// los 2 mensajes que de verdad son una plantilla plana con huecos
// ({{variable}}): el saludo general de un cliente (whatsappGreetingFor) se
// queda en código a propósito -- su texto depende de lógica condicional
// real (solo menciona la próxima visita SI existe una real, solo menciona
// el vehículo SI hay interés registrado), no es un simple "rellenar
// huecos" y aplanarlo a una plantilla única perdería esa lógica.
export type MessageTemplateKey = "visita_confirmacion" | "reserva_pago" | "reserva_confirmada";

export const MESSAGE_TEMPLATE_DEFAULTS: Record<MessageTemplateKey, string> = {
  visita_confirmacion: "Hola, le escribe Automóviles Lucero. Le esperamos el {{dia_semana}} {{dia}} de {{mes}} a las {{hora}} para ver el {{vehiculo}}. ¿Le viene bien?",
  reserva_pago: "Hola, le escribe Automóviles Lucero. Para apartar el {{vehiculo}} necesitamos {{importe}} €. Cuando haga el pago, envíenos el justificante por aquí. Gracias.",
  // Aviso real al cliente cuando el equipo confirma que el justificante es
  // válido (27/10/2026, "avisos automaticos desde el crm a cada cliente") --
  // hasta ahora confirmReservation solo cambiaba el estado interno, el
  // cliente nunca se enteraba salvo que alguien le escribiera a mano.
  reserva_confirmada: "Hola, le escribe Automóviles Lucero. Su reserva del {{vehiculo}} queda confirmada. Le esperamos para completar la operación. Gracias por su confianza.",
};

export const MESSAGE_TEMPLATE_VARS: Record<MessageTemplateKey, string[]> = {
  visita_confirmacion: ["dia_semana", "dia", "mes", "hora", "vehiculo"],
  reserva_pago: ["vehiculo", "importe"],
  reserva_confirmada: ["vehiculo"],
};

type TemplateRow = { id: MessageTemplateKey; text: string; updated_at?: string; updated_by?: string | null };

function row(key: MessageTemplateKey): TemplateRow | undefined {
  return readCollection<TemplateRow>("message_templates").find((r) => r.id === key);
}

export function getMessageTemplate(key: MessageTemplateKey): string {
  return row(key)?.text?.trim() || MESSAGE_TEMPLATE_DEFAULTS[key];
}

export function isMessageTemplateOverridden(key: MessageTemplateKey): boolean {
  return Boolean(row(key)?.text?.trim());
}

export function saveMessageTemplate(key: MessageTemplateKey, text: string, updatedBy: string | null): void {
  const rows = readCollection<TemplateRow>("message_templates").filter((r) => r.id !== key);
  rows.push({ id: key, text, updated_at: new Date().toISOString(), updated_by: updatedBy });
  writeCollection("message_templates", rows);
}

export function resetMessageTemplate(key: MessageTemplateKey): void {
  writeCollection(
    "message_templates",
    readCollection<TemplateRow>("message_templates").filter((r) => r.id !== key),
  );
}

// Sustituye {{variable}} por su valor real -- una variable no reconocida
// se deja tal cual en vez de borrarla en silencio, para que un error de
// escritura en la plantilla sea visible, no un hueco invisible.
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in vars ? vars[key] : match));
}
