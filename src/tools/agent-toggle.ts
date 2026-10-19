import { readCollection, writeCollection } from "../store.js";

// Interruptor real de Miguel por teléfono (Fase 2 del encargo de conexión
// telefónica, 13/10/2026). Solo controla si las llamadas al número de
// Twilio entran al agente de voz o se desvían directamente a Ramón/José --
// nunca toca Yoigo, eso es un desvío aparte que gestiona el propio negocio.
type ToggleRecord = { id: "voice_agent"; enabled: boolean; updated_at: string; updated_by: string | null };

export function isVoiceAgentEnabled(): boolean {
  const row = readCollection<ToggleRecord>("agent_toggles").find((r) => r.id === "voice_agent");
  return row?.enabled ?? true;
}

export function setVoiceAgentEnabled(enabled: boolean, updatedBy: string | null = null): void {
  const rows = readCollection<ToggleRecord>("agent_toggles").filter((r) => r.id !== "voice_agent");
  rows.push({ id: "voice_agent", enabled, updated_at: new Date().toISOString(), updated_by: updatedBy });
  writeCollection("agent_toggles", rows);
}

// Interruptor del envío automático de correo (15/10/2026, especificación
// formal del agente de Gmail, sección 10: "incorporar un modo de prueba...
// sin enviarlos" y "permitir activar o desactivar el envío automático").
// Desactivado: el agente sigue clasificando y redactando la respuesta igual
// que siempre, pero nunca la envía -- queda como nota en Pendientes para que
// el equipo la revise y la mande a mano, igual que ya pasa con los portales
// que exigen gestión manual.
type EmailToggleRecord = { id: "email_auto_send"; enabled: boolean; updated_at: string; updated_by: string | null };

export function isEmailAutoSendEnabled(): boolean {
  const row = readCollection<EmailToggleRecord>("agent_toggles").find((r) => r.id === "email_auto_send");
  return row?.enabled ?? true;
}

export function setEmailAutoSendEnabled(enabled: boolean, updatedBy: string | null = null): void {
  const rows = readCollection<EmailToggleRecord>("agent_toggles").filter((r) => r.id !== "email_auto_send");
  rows.push({ id: "email_auto_send", enabled, updated_at: new Date().toISOString(), updated_by: updatedBy });
  writeCollection("agent_toggles", rows);
}

// Interruptor del agente en WhatsApp vía Zernio (19/10/2026, a petición real
// justo al dejar el canal conectado: "todavía no actives Miguel"). A
// diferencia de voice_agent/email_auto_send -- que ya llevaban tiempo en
// marcha y por eso su valor por defecto es "activado" -- este canal es
// nuevo de verdad, así que por defecto está APAGADO: hay que encenderlo a
// propósito desde Integraciones, nunca queda activo solo por desplegar el
// código o conectar el número.
type WhatsappZernioToggleRecord = { id: "whatsapp_zernio_agent"; enabled: boolean; updated_at: string; updated_by: string | null };

export function isWhatsappZernioAgentEnabled(): boolean {
  const row = readCollection<WhatsappZernioToggleRecord>("agent_toggles").find((r) => r.id === "whatsapp_zernio_agent");
  return row?.enabled ?? false;
}

export function setWhatsappZernioAgentEnabled(enabled: boolean, updatedBy: string | null = null): void {
  const rows = readCollection<WhatsappZernioToggleRecord>("agent_toggles").filter((r) => r.id !== "whatsapp_zernio_agent");
  rows.push({ id: "whatsapp_zernio_agent", enabled, updated_at: new Date().toISOString(), updated_by: updatedBy });
  writeCollection("agent_toggles", rows);
}
