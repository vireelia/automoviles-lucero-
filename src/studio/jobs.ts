// Ciclo de vida de los trabajos de Lucero Studio AI (16/10/2026, ampliado
// el mismo día a petición real: "que puedan elegir el tipo de vídeo... el
// tipo de modelo... una sección para prompt manual"). Mismo patrón de
// almacenamiento que el resto del proyecto: una colección JSON sobre el
// volumen persistente real (store.ts), nada de base de datos nueva solo
// para esto.
//
// Control de coste ANTES de llamar a Higgsfield, no después (a petición
// explícita): tope mensual y tope de generaciones simultáneas. Desde el
// 17/10/2026 el coste estimado usa el precio real publicado por Higgsfield
// para cada motor (ver templates.ts, VIDEO_ENGINES/IMAGE_ENGINES) más un
// margen de seguridad fijo -- algunos precios son "desde" (pueden ser algo
// mayores según duración/resolución elegida), de ahí el margen.
import crypto from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { readCollection, writeCollection } from "../store.js";
import { submitHiggsfieldJob, getHiggsfieldStatus, outputUrls, isHiggsfieldConnected, type HiggsfieldStatus } from "./higgsfield.js";
import { findTemplate, findVideoEngine, findVideoStyle, findImageEngine, VIDEO_ENGINES, VIDEO_STYLES, IMAGE_ENGINES, IMAGE_ASPECT_RATIOS, type StudioTemplate, type VideoEngine, type ImageEngine } from "./templates.js";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const UPLOADS_DIR = path.join(DATA_DIR, "studio_uploads");
const OUTPUTS_DIR = path.join(DATA_DIR, "studio_outputs");
for (const dir of [UPLOADS_DIR, OUTPUTS_DIR]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

export const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ?? "https://virelia-hub-lucero.lzc0bh.easypanel.host";

const MONTHLY_BUDGET_EUR = Number(process.env.HIGGSFIELD_MONTHLY_BUDGET_EUR ?? 60);
const MAX_CONCURRENT = Number(process.env.HIGGSFIELD_MAX_CONCURRENT ?? 2);

const DEFAULT_ASPECT_RATIO = "4:3";
const DEFAULT_ENGINE_ID = "kling_3";
const DEFAULT_STYLE_ID = "normal";
const DEFAULT_IMAGE_ENGINE_ID = "soul_v2";

// Margen de seguridad fijo encima del precio real -- nunca la factura
// exacta, que se revisa en el panel de Higgsfield.
function estimateVideoCostEur(engine: VideoEngine, durationSec: number): number {
  return Math.round((engine.pricePerSecondEur * durationSec + 0.03) * 100) / 100;
}
function estimateImageCostEur(engine: ImageEngine): number {
  return Math.round((engine.pricePerImageEur + 0.01) * 1000) / 1000;
}

export type StudioJobStatus =
  | "submitted" // enviado a Higgsfield, esperando
  | "in_progress"
  | "completed"
  | "failed"
  | "nsfw"
  | "canceled"
  | "rejected_budget"
  | "rejected_concurrency";

export type StudioJob = {
  id: string;
  template_id: string;
  vehicle_label: string;
  extra: string | null;
  manual_prompt: string | null;
  engine_id: string | null; // motor de vídeo o de imagen, según la plantilla
  style_id: string | null; // solo para vídeo
  duration_sec: number | null; // solo para vídeo
  aspect_ratio: string | null; // solo para imagen
  final_prompt: string | null;
  photo_path: string | null; // ruta relativa dentro de DATA_DIR, o null si la plantilla no necesita foto
  status: StudioJobStatus;
  higgsfield_request_id: string | null;
  output_paths: string[]; // rutas relativas dentro de DATA_DIR, ya descargadas
  error: string | null;
  estimated_cost_eur: number;
  created_by: string;
  created_at: string;
  updated_at: string;
};

function now(): string {
  return new Date().toISOString();
}

function list(): StudioJob[] {
  return readCollection<StudioJob>("studio_jobs");
}
function save(rows: StudioJob[]) {
  writeCollection("studio_jobs", rows);
}

export function listStudioJobs(): StudioJob[] {
  return list().sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function getStudioJob(id: string): StudioJob | undefined {
  return list().find((j) => j.id === id);
}

function currentMonthKey(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" }).slice(0, 7); // "2026-10"
}

export function monthSpendEur(): number {
  const month = currentMonthKey();
  return list()
    .filter((j) => j.created_at.slice(0, 7) === month && !j.status.startsWith("rejected_"))
    .reduce((sum, j) => sum + j.estimated_cost_eur, 0);
}

export function activeJobCount(): number {
  return list().filter((j) => j.status === "submitted" || j.status === "in_progress").length;
}

export function budgetInfo() {
  return { monthlyBudgetEur: MONTHLY_BUDGET_EUR, spentEur: monthSpendEur(), maxConcurrent: MAX_CONCURRENT, activeNow: activeJobCount() };
}

// Guarda la foto subida en el volumen persistente y devuelve su ruta
// pública real (necesaria porque la API de Higgsfield recibe una URL que
// ELLA misma descarga, no el archivo -- nunca un binario subido directo).
export function saveUploadedPhoto(buffer: Buffer, originalName: string): { relPath: string; publicUrl: string } {
  const ext = path.extname(originalName).toLowerCase() || ".jpg";
  const fileName = `${crypto.randomUUID()}${ext}`;
  writeFileSync(path.join(UPLOADS_DIR, fileName), buffer);
  const relPath = `studio_uploads/${fileName}`;
  return { relPath, publicUrl: `${PUBLIC_BASE_URL}/crm/studio/archivo/${relPath}` };
}

export function absolutePathFor(relPath: string): string {
  return path.join(DATA_DIR, relPath);
}

export type CreateJobInput = {
  templateId: string;
  vehicleLabel: string;
  extra?: string;
  manualPrompt?: string;
  engineId?: string; // motor de vídeo (plantillas de vídeo) o de imagen (plantillas de imagen)
  styleId?: string; // solo aplica a plantillas de vídeo
  durationChoice?: "corta" | "larga"; // solo aplica a plantillas de vídeo
  aspectRatio?: string; // solo aplica a plantillas de imagen
  photo?: { relPath: string; publicUrl: string } | null;
  createdBy: string;
};

export type CreateJobResult = { ok: true; job: StudioJob } | { ok: false; error: string };

export async function createStudioJob(input: CreateJobInput): Promise<CreateJobResult> {
  const template = findTemplate(input.templateId);
  if (!template) return { ok: false, error: "plantilla_desconocida" };
  if (template.needsPhoto && !input.photo) return { ok: false, error: "esta_plantilla_necesita_foto" };
  if (!isHiggsfieldConnected()) return { ok: false, error: "higgsfield_no_conectado" };

  let modelPath: string;
  let body: Record<string, unknown>;
  let engineId: string | null = null;
  let styleId: string | null = null;
  let durationSec: number | null = null;
  let aspectRatio: string | null = null;

  const basePrompt = template.buildPrompt(input.vehicleLabel, input.extra);

  if (template.kind === "video") {
    const engine = findVideoEngine(input.engineId ?? DEFAULT_ENGINE_ID) ?? VIDEO_ENGINES[0];
    const style = findVideoStyle(input.styleId ?? DEFAULT_STYLE_ID) ?? VIDEO_STYLES[0];
    engineId = engine.id;
    styleId = style.id;
    durationSec = input.durationChoice === "larga" ? engine.durations[1] : engine.durations[0];

    const path_ = input.photo ? engine.imageToVideoPath : engine.textToVideoPath;
    if (!path_) return { ok: false, error: `el_motor_${engine.id}_no_ofrece_texto_a_video` };
    modelPath = path_;

    const finalPrompt = [basePrompt, style.promptSuffix, input.manualPrompt?.trim()].filter(Boolean).join(". ");
    body = { prompt: finalPrompt, duration: durationSec };
    if (input.photo) {
      if (engine.imageField === "image_urls") body.image_urls = [input.photo.publicUrl];
      else body.image_url = input.photo.publicUrl;
    }
    if (engine.supportsCfgScale) body.cfg_scale = style.cfgScale;

    const cost = estimateVideoCostEur(engine, durationSec);
    if (monthSpendEur() + cost > MONTHLY_BUDGET_EUR) {
      return makeRejected(input, template, cost, "rejected_budget", `Se pararía el gasto mensual estimado (tope ${MONTHLY_BUDGET_EUR} €). Pide que se amplíe el tope si quieres seguir generando este mes.`, { engineId, styleId, durationSec, aspectRatio, finalPrompt });
    }
    if (activeJobCount() >= MAX_CONCURRENT) {
      return makeRejected(input, template, cost, "rejected_concurrency", `Ya hay ${MAX_CONCURRENT} generaciones en marcha a la vez. Espera a que termine alguna antes de lanzar otra.`, { engineId, styleId, durationSec, aspectRatio, finalPrompt });
    }
    return submitAndSave(input, template, modelPath, body, cost, { engineId, styleId, durationSec, aspectRatio, finalPrompt });
  }

  // imagen
  const imageEngine = findImageEngine(input.engineId ?? DEFAULT_IMAGE_ENGINE_ID) ?? IMAGE_ENGINES[0];
  engineId = imageEngine.id;
  aspectRatio = IMAGE_ASPECT_RATIOS.some((r) => r.id === input.aspectRatio) ? input.aspectRatio! : DEFAULT_ASPECT_RATIO;
  const finalPrompt = [basePrompt, input.manualPrompt?.trim()].filter(Boolean).join(". ");
  modelPath = imageEngine.path;
  body = { prompt: finalPrompt, aspect_ratio: aspectRatio };
  const cost = estimateImageCostEur(imageEngine);
  if (monthSpendEur() + cost > MONTHLY_BUDGET_EUR) {
    return makeRejected(input, template, cost, "rejected_budget", `Se pararía el gasto mensual estimado (tope ${MONTHLY_BUDGET_EUR} €). Pide que se amplíe el tope si quieres seguir generando este mes.`, { engineId, styleId, durationSec, aspectRatio, finalPrompt });
  }
  if (activeJobCount() >= MAX_CONCURRENT) {
    return makeRejected(input, template, cost, "rejected_concurrency", `Ya hay ${MAX_CONCURRENT} generaciones en marcha a la vez. Espera a que termine alguna antes de lanzar otra.`, { engineId, styleId, durationSec, aspectRatio, finalPrompt });
  }
  return submitAndSave(input, template, modelPath, body, cost, { engineId, styleId, durationSec, aspectRatio, finalPrompt });
}

type JobExtras = { engineId: string | null; styleId: string | null; durationSec: number | null; aspectRatio: string | null; finalPrompt: string };

function baseJobFields(input: CreateJobInput, template: StudioTemplate, cost: number, extras: JobExtras) {
  const nowIso = now();
  return {
    id: crypto.randomUUID(),
    template_id: template.id,
    vehicle_label: input.vehicleLabel,
    extra: input.extra ?? null,
    manual_prompt: input.manualPrompt?.trim() || null,
    engine_id: extras.engineId,
    style_id: extras.styleId,
    duration_sec: extras.durationSec,
    aspect_ratio: extras.aspectRatio,
    final_prompt: extras.finalPrompt,
    photo_path: input.photo?.relPath ?? null,
    output_paths: [] as string[],
    estimated_cost_eur: cost,
    created_by: input.createdBy,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

async function submitAndSave(input: CreateJobInput, template: StudioTemplate, modelPath: string, body: Record<string, unknown>, cost: number, extras: JobExtras): Promise<CreateJobResult> {
  const submitted = await submitHiggsfieldJob(modelPath, body);
  const job: StudioJob = {
    ...baseJobFields(input, template, cost, extras),
    status: submitted.ok ? "submitted" : "failed",
    higgsfield_request_id: submitted.ok ? submitted.state.request_id : null,
    error: submitted.ok ? null : submitted.error,
  };
  save([...list(), job]);
  return { ok: true, job };
}

function makeRejected(input: CreateJobInput, template: StudioTemplate, cost: number, status: StudioJobStatus, error: string, extras: JobExtras): CreateJobResult {
  const job: StudioJob = {
    ...baseJobFields(input, template, cost, extras),
    status,
    higgsfield_request_id: null,
    error,
  };
  save([...list(), job]);
  return { ok: true, job };
}

const TERMINAL: HiggsfieldStatus[] = ["completed", "failed", "nsfw", "canceled"];

// Comprueba el estado real en Higgsfield y, si ya terminó, descarga el
// resultado al volumen persistente -- nunca se depende de la URL temporal
// de Higgsfield (caduca en días), se copia en cuanto está lista.
export async function pollStudioJob(id: string): Promise<StudioJob | undefined> {
  const rows = list();
  const job = rows.find((j) => j.id === id);
  if (!job) return undefined;
  if (job.status !== "submitted" && job.status !== "in_progress") return job;
  if (!job.higgsfield_request_id) return job;

  const result = await getHiggsfieldStatus(job.higgsfield_request_id);
  if (!result.ok) {
    job.error = result.error;
    job.updated_at = now();
    save(rows);
    return job;
  }

  const status = result.state.status;
  if (!TERMINAL.includes(status)) {
    job.status = status === "queued" ? "submitted" : "in_progress";
    job.updated_at = now();
    save(rows);
    return job;
  }

  if (status === "completed") {
    const urls = outputUrls(result.state);
    const downloaded: string[] = [];
    for (let i = 0; i < urls.length; i++) {
      try {
        downloaded.push(await downloadOutput(job.id, i, urls[i]));
      } catch (err) {
        job.error = `descarga_fallida: ${err instanceof Error ? err.message : err}`;
      }
    }
    job.output_paths = downloaded;
    job.status = downloaded.length > 0 ? "completed" : "failed";
  } else if (status === "failed" || status === "nsfw" || status === "canceled") {
    job.status = status;
    job.error = result.state.error ?? job.error;
  }
  job.updated_at = now();
  save(rows);
  return job;
}

async function downloadOutput(jobId: string, index: number, url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`descarga_${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = guessExt(url, res.headers.get("content-type"));
  const dir = path.join(OUTPUTS_DIR, jobId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const fileName = `${index}${ext}`;
  writeFileSync(path.join(dir, fileName), buf);
  return `studio_outputs/${jobId}/${fileName}`;
}

function guessExt(url: string, contentType: string | null): string {
  if (contentType?.includes("video")) return ".mp4";
  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("jpeg") || contentType?.includes("jpg")) return ".jpg";
  const fromUrl = path.extname(new URL(url).pathname);
  return fromUrl || ".jpg";
}
