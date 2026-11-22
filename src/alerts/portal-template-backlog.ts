import crypto from "crypto";
import { readCollection, writeCollection } from "../store.js";
import { withPersistentLockOrSkip } from "../locks.js";
import { markAlertDone } from "./alerts.js";
import type { Alert } from "./alerts.js";
import { isWhatsappConnected, explainWhatsappSendError } from "../integrations/whatsapp.js";
import { isContactoInicialTemplateApproved } from "../integrations/zernio.js";
import { sendGenericContactTemplateGuarded } from "../outbound-guard.js";
import { recordAssistantMessage } from "../chat/agent.js";
import { normalizePhone } from "../tools/leads.js";

// Contacto con la plantilla aprobada de los clientes de portal (Coches.net,
// Wallapop) que se quedaron en "Pendiente" porque su coche ya no está
// disponible y el envío automático nunca se intentaba (22/11/2026, "esos
// clientes pendientes, que se les contacte, que para eso se activó la
// plantilla"). Solo lo dispara un admin a mano; por defecto solo lista.

type InboxRow = { id: string; from: string; subject: string; text: string; outcome: string; portal?: string | null; draft_note?: string; answered?: boolean; answered_by?: string };

export type BacklogCandidate = { inbox_id: string; phone: string; portal: string; vehiculo: string };

export function portalTemplateBacklogCandidates(): BacklogCandidate[] {
  const rows = readCollection<InboxRow>("email_inbox").filter((m) => m.outcome === "pendiente_whatsapp_manual" && !m.answered);
  const seen = new Set<string>();
  const out: BacklogCandidate[] = [];
  for (const m of rows) {
    const wa = /wa\.me\/(\d{9,15})/.exec(m.draft_note ?? "");
    if (!wa) continue;
    const phone = normalizePhone("+" + wa[1]);
    if (seen.has(phone)) continue; // una sola vez por cliente
    seen.add(phone);
    const veh = /interés en el (.+?) a través/.exec(m.draft_note ?? "");
    out.push({ inbox_id: m.id, phone, portal: m.portal ?? "Coches.net", vehiculo: veh ? veh[1].slice(0, 70) : "(sin identificar)" });
  }
  return out;
}

export type BacklogJob = { id: string; total: number; enviados: number; fallidos: number; terminado: boolean; started_at: string; finished_at: string | null; fallos: { phone: string; error: string }[] };
const JOBS = "portal_template_backlog_jobs";
let running = false;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Mismo espaciado humano que el poller de correo (12-40 s) para no parecer una ráfaga.
const spacing = () => 12_000 + Math.floor(Math.random() * 28_000);

function save(job: BacklogJob) {
  const jobs = readCollection<BacklogJob>(JOBS);
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i === -1) jobs.push(job);
  else jobs[i] = job;
  writeCollection(JOBS, jobs.slice(-20));
}

async function run(job: BacklogJob, items: BacklogCandidate[]): Promise<void> {
  running = true;
  await withPersistentLockOrSkip("portal_template_backlog", async () => {
    try {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        try {
          const sent = await sendGenericContactTemplateGuarded(it.phone, `vehículo que consultaste en ${it.portal}`, "portal_template_backlog_admin");
          if (sent.ok) {
            recordAssistantMessage(
              it.phone,
              `(plantilla de primer contacto enviada. IMPORTANTE: el ${it.vehiculo} por el que preguntó en ${it.portal} YA NO está disponible. Si responde, díselo con naturalidad y aplica la regla de VENTA PERDIDA: enseña 2-3 opciones reales, envía el enlace del catálogo y pídele marca y modelo para concertarle una visita o reserva.)`,
            );
            const inbox = readCollection<InboxRow>("email_inbox");
            for (const m of inbox) {
              if (m.id === it.inbox_id || (m.outcome === "pendiente_whatsapp_manual" && !m.answered && new RegExp(`wa\\.me/${it.phone.replace("+", "")}`).test(m.draft_note ?? ""))) {
                m.outcome = "sent_whatsapp_plantilla";
                m.answered = true;
                m.answered_by = "ia";
              }
            }
            writeCollection("email_inbox", inbox);
            for (const a of readCollection<Alert>("alerts")) {
              if (a.status === "pendiente" && a.kind === "gestion_portal" && a.lead_phone && normalizePhone(a.lead_phone) === it.phone) markAlertDone(a.id);
            }
            job.enviados++;
          } else {
            job.fallidos++;
            job.fallos.push({ phone: it.phone, error: explainWhatsappSendError(sent.error ?? "desconocido") });
          }
        } catch (err) {
          job.fallidos++;
          job.fallos.push({ phone: it.phone, error: err instanceof Error ? err.message : String(err) });
        }
        save(job);
        if (i < items.length - 1) await sleep(spacing());
      }
    } finally {
      job.terminado = true;
      job.finished_at = new Date().toISOString();
      save(job);
    }
  });
  running = false;
}

export async function startPortalTemplateBacklog(): Promise<{ started: true; total: number; job_id: string } | { started: false; reason: string }> {
  if (running) return { started: false, reason: "ya_hay_una_tanda_en_curso" };
  if (!isWhatsappConnected()) return { started: false, reason: "whatsapp_no_conectado" };
  if (!(await isContactoInicialTemplateApproved())) return { started: false, reason: "plantilla_contacto_inicial_no_aprobada" };
  const items = portalTemplateBacklogCandidates();
  if (items.length === 0) return { started: false, reason: "no_hay_pendientes" };
  const job: BacklogJob = { id: crypto.randomUUID(), total: items.length, enviados: 0, fallidos: 0, terminado: false, started_at: new Date().toISOString(), finished_at: null, fallos: [] };
  save(job);
  void run(job, items);
  return { started: true, total: items.length, job_id: job.id };
}
