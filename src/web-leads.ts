import crypto from "crypto";
import path from "path";
import { mkdirSync, writeFileSync } from "fs";
import express from "express";
import multer from "multer";
import { upsertLead, isRealName, markLeadRealIntent } from "./tools/leads.js";
import { createPurchaseRequest } from "./tools/requests.js";

// Endpoints públicos del formulario "vende tu coche/furgoneta" de la web
// vendenostufurgoneta.es (22/11/2026). La web real es una exportación estática
// alojada en Hostinger que manda el formulario a este backend (/api/leads y
// /api/leads/upload) -- esas rutas no existían aquí (404), así que ningún
// cliente podía enviar nada. Es lo ÚNICO público de este backend, así que
// cuida lo mínimo imprescindible: CORS solo para los dominios de esa web,
// validación en servidor, honeypot, límite de frecuencia, nombre real
// obligatorio y archivos solo de imagen/vídeo con extensión decidida aquí.

const ALLOWED_ORIGINS = new Set(["https://vendenostufurgoneta.es", "https://www.vendenostufurgoneta.es"]);

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const UPLOADS_DIR = path.join(DATA_DIR, "web-uploads");

const MAX_FILES = 8;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
};

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
const hitsByIp = new Map<string, number[]>();
const seenKeys = new Map<string, number>();
const KEY_TTL_MS = 10 * 60_000;

function withinLimit(ip: string): boolean {
  const now = Date.now();
  const recent = (hitsByIp.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hitsByIp.set(ip, recent);
  return recent.length <= RATE_MAX;
}

function clientIp(req: express.Request): string {
  return req.header("x-forwarded-for")?.split(",")[0]?.trim() || req.ip || "desconocida";
}

type Body = {
  tipoVehiculo?: string;
  marca?: string;
  modelo?: string;
  anio?: string;
  kilometraje?: string;
  precioPedido?: string;
  nombre?: string;
  telefono?: string;
  email?: string;
  estado?: string;
  combustible?: string;
  matricula?: string;
  comentarios?: string;
  disponibleLlamada?: boolean;
  sitioWeb?: string;
  renderedAt?: number;
  idempotencyKey?: string;
  origen?: { pagina?: string };
  fotosUrls?: string[];
};

const str = (v: unknown) => (typeof v === "string" ? v : "");

function validate(d: Body): Record<string, string> {
  const e: Record<string, string> = {};
  const year = new Date().getFullYear();
  if (d.tipoVehiculo !== "coche" && d.tipoVehiculo !== "furgoneta") e.tipoVehiculo = "Elige si es un coche o una furgoneta.";
  if (!str(d.marca).trim() || str(d.marca).length > 60) e.marca = "Indica la marca.";
  if (!str(d.modelo).trim() || str(d.modelo).length > 60) e.modelo = "Indica el modelo.";
  const anio = Number(str(d.anio));
  if (!str(d.anio).trim() || !Number.isInteger(anio) || anio < 1970 || anio > year + 1) e.anio = "Introduce un año real.";
  const km = Number(str(d.kilometraje));
  if (!str(d.kilometraje).trim() || !Number.isFinite(km) || km < 0 || km > 1_500_000) e.kilometraje = "Introduce un kilometraje real, en números.";
  if (str(d.precioPedido).trim()) {
    const precio = Number(str(d.precioPedido).replace(/[.\s€]/g, "").replace(",", "."));
    if (!Number.isFinite(precio) || precio <= 0 || precio > 3_000_000) e.precioPedido = "Introduce el precio en euros, solo números.";
  }
  // Regla del dueño (22/11/2026): ninguna solicitud sin nombre real.
  if (!isRealName(str(d.nombre)) || str(d.nombre).length > 80) e.nombre = "Indica tu nombre real.";
  if (!/^(\+?\d{9,15})$/.test(str(d.telefono).replace(/[\s-]/g, ""))) e.telefono = "Introduce un teléfono válido.";
  if (str(d.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(d.email))) e.email = "Introduce un email válido, o déjalo en blanco.";
  if (str(d.matricula).length > 15) e.matricula = "La matrícula no puede ser tan larga.";
  if (str(d.comentarios).length > 1000) e.comentarios = "Los comentarios no pueden superar los 1000 caracteres.";
  return e;
}

function publicBase(req: express.Request): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const host = req.header("x-forwarded-host") ?? req.header("host") ?? "";
  return `https://${host}`;
}

export function registerWebLeadsRoutes(app: express.Express): void {
  // CORS acotado a la web real; el resto del backend sigue sin CORS.
  app.use(["/api/leads"], (req, res, next) => {
    const origin = req.header("origin");
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "86400");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Fotos y vídeos subidos por clientes: carpeta propia, sin listado, con la
  // extensión elegida por el servidor (nunca la del cliente) y sin que el
  // navegador intente adivinar el tipo.
  app.use(
    "/uploads/web",
    express.static(UPLOADS_DIR, {
      index: false,
      dotfiles: "deny",
      setHeaders: (res) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "private, max-age=3600");
      },
    }),
  );

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
    fileFilter: (_req, file, cb) => cb(null, Object.prototype.hasOwnProperty.call(EXT_BY_MIME, file.mimetype)),
  });

  app.post("/api/leads/upload", (req, res) => {
    if (!withinLimit(clientIp(req))) {
      res.status(429).json({ ok: false, error: "Demasiadas solicitudes. Inténtalo de nuevo en un minuto." });
      return;
    }
    upload.array("archivos", MAX_FILES)(req, res, (err) => {
      if (err) {
        res.status(400).json({ ok: false, error: err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE" ? "Un archivo supera el tamaño máximo (25 MB)." : "No se pudieron subir los archivos." });
        return;
      }
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) {
        res.status(400).json({ ok: false, error: "No se recibió ningún archivo válido (solo fotos o vídeos)." });
        return;
      }
      const day = new Date().toISOString().slice(0, 10);
      const dir = path.join(UPLOADS_DIR, day);
      mkdirSync(dir, { recursive: true });
      const base = publicBase(req);
      const urls: string[] = [];
      for (const f of files) {
        const name = `${crypto.randomUUID()}${EXT_BY_MIME[f.mimetype]}`;
        writeFileSync(path.join(dir, name), f.buffer);
        urls.push(`${base}/uploads/web/${day}/${name}`);
      }
      res.json({ ok: true, urls });
    });
  });

  app.post("/api/leads", (req, res) => {
    const d = (req.body ?? {}) as Body;
    // Honeypot y tiempo mínimo de relleno: respuesta normal, nunca se delata al bot.
    if (str(d.sitioWeb).trim() !== "") {
      res.json({ ok: true });
      return;
    }
    if (typeof d.renderedAt === "number" && Date.now() - d.renderedAt < 2000) {
      res.json({ ok: true });
      return;
    }
    if (!withinLimit(clientIp(req))) {
      res.status(429).json({ ok: false, error: "Demasiadas solicitudes. Inténtalo de nuevo en un minuto." });
      return;
    }
    const now = Date.now();
    for (const [k, t] of seenKeys) if (now - t > KEY_TTL_MS) seenKeys.delete(k);
    if (d.idempotencyKey) {
      if (seenKeys.has(d.idempotencyKey)) {
        res.json({ ok: true });
        return;
      }
      seenKeys.set(d.idempotencyKey, now);
    }
    const errores = validate(d);
    if (Object.keys(errores).length > 0) {
      res.status(400).json({ ok: false, error: "Revisa los datos del formulario.", errores });
      return;
    }
    const photoUrls = Array.isArray(d.fotosUrls) ? d.fotosUrls.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u)).slice(0, MAX_FILES) : [];
    const tipo = d.tipoVehiculo === "furgoneta" ? "furgoneta" : "coche";
    const notes = [
      `Quiere vender su ${tipo}: ${str(d.marca)} ${str(d.modelo)} (${str(d.anio)}), ${str(d.kilometraje)} km.`,
      str(d.precioPedido).trim() ? `Pide: ${str(d.precioPedido).trim()} €.` : null,
      str(d.comentarios) ? `Comentarios del propietario: ${str(d.comentarios)}` : null,
      photoUrls.length > 0 ? `Fotos/vídeo adjuntos: ${photoUrls.join(" | ")}` : null,
    ].filter(Boolean).join(" ");
    try {
      upsertLead({
        phone: str(d.telefono),
        name: str(d.nombre).trim(),
        email: str(d.email) || undefined,
        channel: "WEB",
        intent: "vender_vehiculo",
        notes,
      });
      markLeadRealIntent(str(d.telefono));
      const precio = str(d.precioPedido).trim() ? Number(str(d.precioPedido).replace(/[.\s€]/g, "").replace(",", ".")) : undefined;
      createPurchaseRequest({
        lead_phone: str(d.telefono),
        lead_name: str(d.nombre).trim(),
        email: str(d.email) || undefined,
        vehicle_type: tipo,
        make: str(d.marca).trim(),
        model: str(d.modelo).trim(),
        year: Number(str(d.anio)),
        km: Number(str(d.kilometraje)),
        condition: str(d.estado) || undefined,
        fuel: str(d.combustible) || undefined,
        plate: str(d.matricula) || undefined,
        comments: str(d.comentarios) || undefined,
        expected_price_eur: precio && Number.isFinite(precio) ? precio : undefined,
        photo_urls: photoUrls.length > 0 ? photoUrls : undefined,
        available_for_call: d.disponibleLlamada === true ? true : undefined,
        channel: "WEB",
        origin_page: d.origen?.pagina,
        source: "web_form",
      });
      res.json({ ok: true });
    } catch (err) {
      console.error("[web-leads] no se pudo registrar la solicitud:", err instanceof Error ? err.message : err);
      res.status(500).json({ ok: false, error: "No se pudo registrar la solicitud. Inténtalo de nuevo." });
    }
  });
}
