// Llamada de voz saliente para avisos urgentes al equipo (22/10/2026, caso
// real de Ramón): el número de WhatsApp del negocio ES el número personal
// de Ramón -- avisarle a él por WhatsApp desde esa misma cuenta no tiene
// sentido técnico (se estaría enviando un mensaje de su cuenta a su propia
// cuenta), así que ese canal nunca puede funcionar para él, apruebe Meta lo
// que apruebe. La llamada de voz no depende de ninguna ventana de 24h ni
// de ninguna cuenta -- suena el teléfono, punto. Se usa solo para lo
// genuinamente urgente (ver URGENT_ALERT_KINDS en team-notify.ts), nunca
// para recordatorios rutinarios -- nadie quiere que le llame un robot cada
// vez que se agenda una visita cualquiera.
import twilio from "twilio";

export type VoiceCallResult = { ok: true; callSid: string } | { ok: false; error: string };

export async function callUrgentAlert(toPhone: string, message: string): Promise<VoiceCallResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_VOICE_FROM_NUMBER;
  if (!accountSid || !authToken || !fromNumber) {
    return { ok: false, error: "twilio_voz_no_configurado" };
  }
  try {
    const client = twilio(accountSid, authToken);
    // <Say> en español, se repite dos veces por si se pierde el principio
    // (alguien que contesta y tarda en coger el teléfono del todo).
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="es-ES">${escapeXml(message)}</Say><Pause length="1"/><Say language="es-ES">${escapeXml(message)}</Say></Response>`;
    const call = await client.calls.create({ to: toPhone, from: fromNumber, twiml });
    return { ok: true, callSid: call.sid };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
