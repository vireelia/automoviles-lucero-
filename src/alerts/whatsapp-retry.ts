// Reintento real del backlog de WhatsApp (03/11/2026, petición real del
// dueño): bug ya corregido en src/email/agent.ts (commit 7a0a32e) -- la
// plantilla de WhatsApp aprobada por Meta ("contacto_inicial_vehiculo")
// solo se intentaba como respaldo cuando había un vehículo identificado
// (vehicleLabel); si no, se saltaba la plantilla entera y el cliente se
// quedaba sin contactar. El arreglo ya cubre los casos NUEVOS, pero deja
// 199 alertas reales pendientes de HOY, de ANTES del arreglo, cada una con
// un draft_note que ya trae la respuesta real redactada y un lead_phone
// real. El dueño confirmó explícitamente: contactar a TODOS por igual (no
// filtrar por intención), con la plantilla ya aprobada + el texto ya
// redactado, con el mismo espaciado humano real que ya usa el poller de
// correo (src/email/poller.ts, MIN/MAX_SPACING_MS) para no parecer un
// patrón de ráfaga ante Meta ni ante los propios clientes.
import { readCollection, writeCollection } from "../store.js";
import { markAlertDone } from "./alerts.js";
import type { Alert } from "./alerts.js";
import { isWhatsappConnected, sendWhatsappText, explainWhatsappSendError } from "../integrations/whatsapp.js";
import { isContactoInicialTemplateApproved, sendZernioWhatsappVehicleContactTemplate } from "../integrations/zernio.js";

export type WhatsappRetryJob = {
  id: string;
  total: number;
  enviados: number;
  fallidos: number;
  terminado: boolean;
  started_at: string;
  finished_at: string | null;
  // Motivo real de cada fallo, por teléfono -- para que el equipo pueda ver
  // SIN adivinar por qué un cliente concreto no recibió el reintento
  // (p. ej. "whatsapp_not_connected" a media tanda, o un error real de Meta).
  fallos: { lead_phone: string | null; name: string | null; error: string }[];
};

const JOBS_COLLECTION = "whatsapp_retry_jobs";

// Mismo rango real que src/email/poller.ts (18/10/2026, "que cumpla
// tiempos para que no sea baneado" + "con segundos de espera siempre, como
// un humano") -- reutilizado tal cual, no se inventa un espaciado nuevo.
const MIN_SPACING_MS = 12_000;
const MAX_SPACING_MS = 40_000;
function humanSpacingMs(): number {
  return MIN_SPACING_MS + Math.floor(Math.random() * (MAX_SPACING_MS - MIN_SPACING_MS));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Texto real tras "Respuesta ya redactada, lista para copiar:\n" en el
// draft_note (ver el patrón exacto en src/email/agent.ts,
// contactLeadViaWhatsapp). Si el patrón exacto no está (no debería pasar en
// estos 199 reales, pero nunca se asume), se usa el draft_note completo
// como respaldo -- nunca se inventa ni se recorta el texto real del
// cliente.
const DRAFT_MARKER = "Respuesta ya redactada, lista para copiar:\n";
export function extractRealDraftText(draftNote: string | null): string {
  if (!draftNote) return "";
  const idx = draftNote.indexOf(DRAFT_MARKER);
  if (idx === -1) return draftNote;
  return draftNote.slice(idx + DRAFT_MARKER.length).trim();
}

// Filtro real exacto pedido por el dueño: status "pendiente", kind
// "gestion_portal", reason incluye "Meta todavía no permite" -- el motivo
// real que deja explainWhatsappSendError() cuando DIRECT_SEND_NOT_ELIGIBLE
// (ver integrations/whatsapp.ts). Contactar a TODOS por igual, sin filtrar
// por intención (confirmado explícitamente por el dueño 03/11/2026).
export function pendingMetaBacklogAlerts(): Alert[] {
  return readCollection<Alert>("alerts").filter(
    (a) => a.status === "pendiente" && a.kind === "gestion_portal" && (a.reason ?? "").includes("Meta todavía no permite"),
  );
}

let running = false;
export function isWhatsappRetryRunning(): boolean {
  return running;
}

function readJobs(): WhatsappRetryJob[] {
  return readCollection<WhatsappRetryJob>(JOBS_COLLECTION);
}
function saveJob(job: WhatsappRetryJob): void {
  const jobs = readJobs();
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx === -1) jobs.push(job);
  else jobs[idx] = job;
  writeCollection(JOBS_COLLECTION, jobs.slice(-20));
}

// El envío real, en segundo plano -- igual que el poller de correo, esto
// NUNCA bloquea la petición HTTP que lo arrancó (ver startGestionPortal...
// más abajo, que no espera a esta función). Progreso real persistido en
// whatsapp_retry_jobs en cada envío, consultable sin adivinar vía
// GET /debug/whatsapp_retry_jobs.
async function runRetryBatch(job: WhatsappRetryJob, alerts: Alert[]): Promise<void> {
  running = true;
  try {
    for (let i = 0; i < alerts.length; i++) {
      const alert = alerts[i];
      try {
        const phone = alert.lead_phone;
        if (!phone) {
          job.fallidos++;
          job.fallos.push({ lead_phone: null, name: alert.name, error: "alerta_sin_telefono_real" });
          saveJob(job);
          continue;
        }
        const texto = extractRealDraftText(alert.draft_note);
        const templateSent = await sendZernioWhatsappVehicleContactTemplate(phone, "el vehículo que consultaste");
        if (!templateSent.ok) {
          job.fallidos++;
          job.fallos.push({ lead_phone: phone, name: alert.name, error: explainWhatsappSendError(templateSent.error) });
          saveJob(job);
        } else {
          const textSent = texto ? await sendWhatsappText(phone, texto) : { ok: false as const, error: "draft_note_vacio" };
          if (textSent.ok) {
            markAlertDone(alert.id);
            job.enviados++;
            saveJob(job);
          } else {
            job.fallidos++;
            job.fallos.push({ lead_phone: phone, name: alert.name, error: explainWhatsappSendError(textSent.error) });
            saveJob(job);
          }
        }
      } catch (err) {
        // Un fallo real e inesperado en UN cliente nunca debe tumbar el
        // resto del lote -- se cuenta como fallo honesto y se sigue con el
        // siguiente, igual que el poller de correo (catch por iteración).
        job.fallidos++;
        job.fallos.push({ lead_phone: alert.lead_phone, name: alert.name, error: err instanceof Error ? err.message : String(err) });
        saveJob(job);
      }
      if (i < alerts.length - 1) {
        await sleep(humanSpacingMs());
      }
    }
  } finally {
    job.terminado = true;
    job.finished_at = new Date().toISOString();
    saveJob(job);
    running = false;
  }
}

export type StartRetryResult =
  | { started: true; total: number; job_id: string }
  | { started: false; reason: string };

// Arranca la tanda real -- responde YA (nunca mantiene la petición HTTP
// abierta durante las hasta ~2h que puede tardar el lote completo). Antes
// de arrancar NADA, comprueba que WhatsApp está conectado y que la
// plantilla sigue aprobada -- si no, no se intenta ni un solo envío y se
// dice con claridad por qué.
// onlyPhones (03/11/2026, petición real: "filtra clientes con intención
// real, no gastemos dinero en tonterías... a esos dales prioridad") -- el
// dueño decidió NO contactar a los 199 por igual, sino solo a los que
// tienen intención real confirmada (cita/reserva/handoff de reserva ya
// registrado) -- 10 de los 199 en la comprobación real de ese momento.
// Filtro opcional por teléfono exacto, nunca cambia el comportamiento por
// defecto (sin el parámetro, sigue procesando todos los pendientes).
export async function startGestionPortalWhatsappRetry(onlyPhones?: string[]): Promise<StartRetryResult> {
  if (running) return { started: false, reason: "ya_hay_una_tanda_en_curso" };
  if (!isWhatsappConnected()) return { started: false, reason: "whatsapp_no_conectado" };
  if (!(await isContactoInicialTemplateApproved())) return { started: false, reason: "plantilla_contacto_inicial_no_aprobada" };

  const allAlerts = pendingMetaBacklogAlerts();
  const normalize = (p: string | null) => (p ?? "").replace(/[+\s]/g, "");
  const alerts = onlyPhones ? allAlerts.filter((a) => onlyPhones.map(normalize).includes(normalize(a.lead_phone))) : allAlerts;
  if (alerts.length === 0) return { started: false, reason: "no_hay_alertas_pendientes_de_este_tipo" };

  const job: WhatsappRetryJob = {
    id: crypto.randomUUID(),
    total: alerts.length,
    enviados: 0,
    fallidos: 0,
    terminado: false,
    started_at: new Date().toISOString(),
    finished_at: null,
    fallos: [],
  };
  saveJob(job);
  void runRetryBatch(job, alerts); // fire-and-forget real -- sigue en segundo plano, nunca se espera aquí.
  return { started: true, total: alerts.length, job_id: job.id };
}
