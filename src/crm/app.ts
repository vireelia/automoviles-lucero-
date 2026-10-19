import express from "express";
import multer from "multer";
import crypto from "crypto";
import { readCollection, writeCollection } from "../store.js";
import { userForSession, createSession, destroySession, verifyPassword, hashPassword, listUsers, saveUsers, type CrmUser } from "./auth.js";
import { vehiclesSeed } from "../data/vehicles-seed.js";
import { currentVehicles } from "../data/vehicles-current.js";
import { createReservationPending, confirmReservation, cancelReservation } from "../tools/reservations.js";
import { getOfficialStatus, setOfficialStatus, type OfficialVehicleStatus } from "../tools/vehicle-state.js";
import { deliverEmail } from "../email/agent.js";
import { pendingAlerts, markAlertDone, deleteAlert } from "../alerts/alerts.js";
import { moveToTrash, listTrash, restoreFromTrash, purgeFromTrash } from "./trash.js";
import { tryAutoCreateReservation } from "../tools/requests.js";
import { isVoiceAgentEnabled, setVoiceAgentEnabled, isEmailAutoSendEnabled, setEmailAutoSendEnabled, isWhatsappZernioAgentEnabled, setWhatsappZernioAgentEnabled } from "../tools/agent-toggle.js";
import { STUDIO_TEMPLATES, findTemplate, VIDEO_ENGINES, VIDEO_STYLES, IMAGE_ENGINES, IMAGE_ASPECT_RATIOS, findVideoEngine, findVideoStyle, findImageEngine } from "../studio/templates.js";
import { createStudioJob, listStudioJobs, getStudioJob, pollStudioJob, saveUploadedPhoto, absolutePathFor, budgetInfo, PUBLIC_BASE_URL, type StudioJob } from "../studio/jobs.js";
import { isHiggsfieldConnected } from "../studio/higgsfield.js";
import { isZernioConnected, listZernioAccounts, publishZernioPost, isZernioWhatsappConfigured, getWhatsappConnectUrl, type ZernioAccount } from "../integrations/zernio.js";
import { existsSync as fileExists } from "fs";
import path from "path";
import {
  googleStatus,
  googleConfigMissing,
  createAuthUrl,
  disconnectGoogle,
  sendGmail,
  calendarCreateEvent,
  calendarDeleteEvent,
  describeGoogleError,
} from "../integrations/google.js";

export const crm = express.Router();
crm.use(express.urlencoded({ extended: false, limit: "100kb" }));

// ---------- datos ----------
type Lead = {
  id: string;
  phone: string | null;
  name: string | null;
  notes: string | null;
  channel: string | null;
  origin?: string | null;
  vehicle_interest: string | null;
  temperature: string;
  followup_count: number;
  do_not_contact: boolean;
  // Limpieza de clientes de poco interés (19/10/2026, a petición real:
  // "ocultar/archivar, no borrar"): nunca se borra nada aquí, solo deja de
  // salir en la lista principal.
  archived?: boolean;
  updated_at?: string;
  created_at: string;
};
type Reservation = {
  id: string;
  vehicle_id: string;
  lead_phone: string | null;
  amount_eur: number;
  status: "pending_payment" | "pending_verification" | "confirmed" | "expired" | "cancelled";
  created_at: string;
  verified_by: string | null;
};
type Appointment = {
  id: string;
  lead_phone: string | null;
  vehicle_id?: string;
  appointment_type?: string;
  requested_date?: string;
  requested_time?: string;
  notes?: string;
  status: string;
  created_at: string;
};
type Handoff = { id: string; lead_phone: string | null; lead_name?: string | null; reason?: string; urgency?: string; notes?: string; reason_type?: string; status: string; created_at: string };
// Especificación formal del agente de chat (16/10/2026, sección CRM: "...y
// resumen de conversación"): el agente ya llamaba a save_conversation/
// create_conversation_summary, pero esos datos no se veían en ningún sitio
// del CRM -- se guardaban y ahí se quedaban. Se muestran ahora en la ficha
// del cliente.
type ConversationSummary = { id: string; phone?: string | null; summary: string; created_at: string };
type InboxMail = { id: string; from: string; subject: string; text: string; outcome: string; portal?: string | null; draft_note?: string; thread_id?: string; in_reply_to?: string; answered?: boolean; answered_by?: "ia" | "equipo"; read?: boolean; archived?: boolean; created_at: string };
// Mensajes de WhatsApp entrantes (módulo CRM mensajes/clientes, 18/10/2026).
// Solo registra lo que escribe el cliente y si la IA respondió -- esta
// bandeja NO tiene botón de responder: el envío real de WhatsApp sigue
// desactivado hasta verificar la conexión (a petición expresa: "preparar la
// interfaz y la lógica, pero no activar el envío hasta verificar la
// conexión prevista para mañana").
type WhatsappMessage = {
  id: string;
  phone: string;
  text: string;
  reply_text?: string | null;
  delivered?: boolean;
  read?: boolean;
  answered?: boolean;
  answered_by?: "ia" | "equipo";
  archived?: boolean;
  created_at: string;
};
type CallAnalysis = {
  id: string;
  channel: string;
  from_number?: string | null;
  duration_ms?: number | null;
  call_successful?: boolean | null;
  summary?: string | null;
  issues_detected?: string | null;
  security_event?: string | null;
  needs_review?: boolean;
  read?: boolean;
  archived?: boolean;
  created_at: string;
};
type VehicleOverride = { vehicle_id: string; price_eur: number };

const RESERVATION_TEXT: Record<string, string> = {
  pending_payment: "Espera el pago de 500 €",
  pending_verification: "Dice que ha pagado: falta comprobarlo",
  confirmed: "Reserva confirmada",
  expired: "Caducada",
  cancelled: "Cancelada",
};
const APPOINTMENT_TEXT: Record<string, string> = {
  requested: "Pendiente de confirmar",
  confirmed: "Confirmada",
  cancelled: "Cancelada",
};
const VEHICLE_TEXT: Record<OfficialVehicleStatus, string> = {
  AVAILABLE: "Disponible",
  RESERVATION_PENDING: "Reserva en curso",
  RESERVED: "Reservado",
  SOLD: "Vendido",
};
const TEMP: Record<string, { label: string; cls: string; help: string; letter: string }> = {
  HOT: { label: "Caliente · quiere comprar ya", cls: "t-hot", help: "caliente", letter: "C" },
  WARM: { label: "Tibio · interesado, sin prisa", cls: "t-warm", help: "tibio", letter: "T" },
  COLD: { label: "Frío · solo está mirando", cls: "t-cold", help: "frío", letter: "F" },
};
// Agente/canal por el que entró el cliente. El texto va en la tarjeta; la letra solo indica temperatura.
// FALLO REAL detectado en la auditoría del 18/10/2026: a los leads reales
// con origin "WHATSAPP" (confirmado en data/leads.json de producción) les
// faltaba entrada aquí -- se mostraban como "Origen sin registrar" aunque
// el dato correcto SÍ estaba guardado. Lo mismo le faltaba a "FACEBOOK".
// "coches.net" (en minúsculas, el nombre del portal) añadido tras ver datos
// reales de producción (18/10/2026): algún lead real tiene ese valor exacto
// en `channel`/`origin` en vez de un canal real -- se muestra honestamente
// tal cual está guardado, sin tocar de dónde viene ese dato.
const ORIGIN: Record<string, string> = { VOICE: "Voz", CHAT: "Chat", EMAIL: "Correo", WHATSAPP: "WhatsApp", FACEBOOK: "Facebook", MANUAL: "Añadido a mano", "coches.net": "Coches.net" };
// Plataforma que originó el contacto (distinta del canal): Coches.net,
// Wallapop... Antes de mostrar un dato de origen hay que decir
// "Origen desconocido" en vez de inventarlo (encargo del cliente, Fase 2).
function platformLabel(portal: string | null | undefined): string {
  return portal && portal.trim() ? portal : "Origen desconocido";
}
// Etiqueta de plataforma EN COLOR (a petición real, 18/10/2026: "que salga
// también como una tarjeta de color") -- un color real y reconocible por
// portal en vez del tag gris neutro que usa el resto del CRM.
const PORTAL_TAG_STYLE: Record<string, string> = {
  "coches.net": "background:#dbeafe;color:#1e3a8a",
  wallapop: "background:#dcfce7;color:#14532d",
  milanuncios: "background:#ffe4d6;color:#7c2d12",
};
function platformTag(portal: string | null | undefined): string {
  const label = platformLabel(portal);
  const style = PORTAL_TAG_STYLE[(portal ?? "").trim().toLowerCase()] ?? "background:#e2e8f0;color:#1e293b";
  return `<span class="tag" style="${style}">${esc(label)}</span>`;
}
// Identificador útil para mostrar cuando falta el nombre (encargo real,
// Fase 2: "si no se conoce el nombre, mostrar un identificador útil, como
// su número de teléfono, sin inventar datos"). Dato real de producción
// (18/10/2026): varios leads de Coches.net no tienen ni nombre ni un
// teléfono real -- su "phone" es un correo-relay anónimo del propio portal
// (tipo bec672e7-...@contactos.coches.net), que no identifica a nadie para
// una persona. Para esos casos concretos se prioriza el coche de interés,
// que sí dice algo útil; nunca se inventa un nombre.
function isCochesNetRelay(contact: string | null | undefined): boolean {
  return Boolean(contact && contact.includes("@") && /coches\.net$/i.test(contact));
}
function leadDisplayName(l: Lead): string {
  if (l.name) return l.name;
  if (l.phone && !isCochesNetRelay(l.phone)) return l.phone;
  if (l.vehicle_interest) return `Interesado/a en ${l.vehicle_interest}`;
  return "Sin datos de contacto";
}
// Limpieza automática de clientes de poco interés (19/10/2026, a petición
// real: "ocultar/archivar, no borrar" + "Fría + sin contacto reciente").
// Nunca borra nada -- solo deja de salir en la lista principal de
// Clientes. Reversible con un clic ("Desarchivar"). Configurable por si
// el tope de días hace falta ajustarlo sin tocar código.
const LEAD_ARCHIVE_INACTIVE_DAYS = Number(process.env.LEAD_ARCHIVE_INACTIVE_DAYS ?? 45);
function autoArchiveColdLeads(): void {
  const leads = list<Lead>("leads");
  const cutoff = Date.now() - LEAD_ARCHIVE_INACTIVE_DAYS * 24 * 60 * 60 * 1000;
  let changed = false;
  for (const l of leads) {
    if (l.archived || l.temperature !== "COLD") continue;
    const lastActivity = new Date(l.updated_at ?? l.created_at).getTime();
    if (Number.isFinite(lastActivity) && lastActivity < cutoff) {
      l.archived = true;
      changed = true;
    }
  }
  if (changed) save("leads", leads);
}
// Igual que leadDisplayName, pero para sitios que solo tienen phone/name
// sueltos (Avisos, Pendientes) y no el Lead completo -- a petición real,
// 18/10/2026: "eliminar estos códigos raros que salen en cliente, mejor
// pon el nombre, no quiero códigos que confundan". Busca en Clientes por
// el mismo contacto antes de rendirse; nunca inventa un nombre.
function findLeadByContact(contact: string): Lead | undefined {
  if (contact.includes("@")) return list<Lead>("leads").find((l) => l.phone === contact);
  const digits = normalizePhoneDigits(contact);
  if (!digits) return undefined;
  return list<Lead>("leads").find((l) => normalizePhoneDigits(l.phone) === digits);
}
function contactLabel(phone: string | null | undefined, name: string | null | undefined): string {
  if (name) return name;
  if (!phone) return "Cliente sin contacto";
  // Se mira primero si ya hay un nombre real guardado en Clientes para este
  // mismo contacto (19/10/2026, "pon toda la información") -- antes solo se
  // miraba en los casos de correo-relay de Coches.net, así que un teléfono
  // normal con nombre ya conocido (p. ej. añadido a mano en una reserva) se
  // seguía mostrando como número suelto en vez de su nombre real.
  const lead = findLeadByContact(phone);
  if (lead?.name) return lead.name;
  if (!isCochesNetRelay(phone)) return phone;
  if (lead?.vehicle_interest) return `Interesado/a en ${lead.vehicle_interest}`;
  return "Cliente de Coches.net (sin nombre)";
}

// Frase con lo que quiere el cliente, sacada de sus visitas y reservas reales.
function situation(l: Lead): string {
  const key = l.phone ?? "";
  const car = (id?: string) => vehicleName(id);
  const appt = list<Appointment>("appointments").filter((a) => a.lead_phone === key && a.status !== "cancelled").sort((x, y) => (x.requested_date ?? "").localeCompare(y.requested_date ?? ""))[0];
  if (appt) {
    const d = dayLabel(appt.requested_date);
    return `Quiere ir ${d.weekday === "Día por fijar" ? "a una fecha por fijar" : `el ${d.weekday} ${d.day} de ${d.month}`} a las ${appt.requested_time ?? "?"} a ver ${car(appt.vehicle_id)}`;
  }
  const res = list<Reservation>("reservations").find((r) => r.lead_phone === key && r.status !== "cancelled" && r.status !== "expired");
  if (res) {
    return res.status === "confirmed" ? `Tiene reservado ${car(res.vehicle_id)}` : `Quiere reservar ${car(res.vehicle_id)}: espera el pago de 500 €`;
  }
  if (l.vehicle_interest) return `Pregunta por ${l.vehicle_interest}`;
  return l.temperature === "HOT" ? "Quiere comprar ya" : "Todavía está informándose";
}
const DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

// Solo el comercial (y el administrador) confirma pagos y marca ventas.
function canConfirmPayments(user: CrmUser): boolean {
  return user.role === "admin" || user.role === "comercial";
}
const ROLE_NAME: Record<string, string> = { admin: "Puede todo", comercial: "Confirma pagos y ventas", equipo: "Ver y trabajar" };

function list<T>(name: string): T[] {
  return readCollection<T>(name);
}
function save<T>(name: string, rows: T[]) {
  writeCollection(name, rows);
}
function now() {
  return new Date().toISOString();
}
function todayMadrid(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
}
function vehicleName(id: string | undefined | null): string {
  const v = currentVehicles().find((x) => x.id === id);
  return v ? `${v.make} ${v.model} ${v.year ?? ""}`.trim() : "Coche sin nombre";
}
function priceOf(vehicleId: string): number {
  const override = list<VehicleOverride>("vehicle_overrides").find((o) => o.vehicle_id === vehicleId);
  return override?.price_eur ?? vehiclesSeed.find((v) => v.id === vehicleId)?.price_eur ?? 0;
}
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function fmtDate(iso: string | undefined | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
// "lunes 7 oct" a partir de 2026-10-07
function dayLabel(isoDate: string | undefined): { weekday: string; day: string; month: string } {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return { weekday: "Día por fijar", day: "--", month: "" };
  const d = new Date(`${isoDate}T12:00:00`);
  return { weekday: DAYS[d.getDay()], day: String(d.getDate()).padStart(2, "0"), month: MONTHS[d.getMonth()] };
}
function phoneLink(contact: string | null | undefined): string {
  if (!contact || contact.includes("@") || !/\d{6,}/.test(contact)) return "";
  return `<a class="btn light" href="tel:${esc(contact)}">Llamar</a>`;
}
function option(value: string, label: string, selected: string | undefined) {
  return `<option value="${esc(value)}"${selected === value ? " selected" : ""}>${esc(label)}</option>`;
}
// Número listo para WhatsApp (España por defecto): solo cifras, con 34 delante si hace falta.
function waNumber(contact: string | null | undefined): string | null {
  if (!contact || contact.includes("@")) return null;
  let digits = contact.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 9) digits = `34${digits}`;
  return digits.length >= 11 ? digits : null;
}
function waButton(contact: string | null | undefined, message: string): string {
  const num = waNumber(contact);
  if (!num) return "";
  return `<a class="btn ok" target="_blank" rel="noopener" href="https://wa.me/${num}?text=${encodeURIComponent(message)}">Escribir por WhatsApp</a>`;
}
// El borrador de "pendiente_whatsapp_manual" ya trae el enlace wa.me real
// incrustado en el texto (email/agent.ts) -- se extrae solo para mostrarlo
// como botón real, en vez de obligar a leer/copiar el enlace a mano.
function extractWaLink(note: string | null | undefined): string | null {
  const m = note?.match(/https:\/\/wa\.me\/\d+/);
  return m ? m[0] : null;
}
// El motivo de la alerta siempre empieza con "Coches.net: "/"Wallapop: "
// cuando lo genera email/agent.ts -- se separa para mostrar el portal como
// etiqueta en color (a petición real, 18/10/2026: "que salga en color
// como una tarjeta igual que urgente"), igual que ya se hace en Correos.
function extractLeadingPortal(reason: string): { portal: string | null; rest: string } {
  const m = reason.match(/^(Coches\.net|Wallapop|Milanuncios):\s*/i);
  if (!m) return { portal: null, rest: reason };
  return { portal: m[1] ?? null, rest: reason.slice(m[0].length) };
}
function normalizePhoneDigits(p: string | null | undefined): string {
  return (p ?? "").replace(/\D/g, "");
}
// Si la alerta no trae nombre, se busca en Clientes por el mismo teléfono
// (normalizado, con o sin "+") -- a petición real (18/10/2026: "que salga
// el nombre"). Nunca se inventa: si tampoco hay lead con nombre, se queda
// en el teléfono, nunca un nombre puesto a mano.
function alertDisplayName(a: { name: string | null; lead_phone: string | null }): string {
  if (a.name) return a.name;
  if (a.lead_phone) {
    const digits = normalizePhoneDigits(a.lead_phone);
    const lead = digits ? list<Lead>("leads").find((l) => normalizePhoneDigits(l.phone) === digits) : undefined;
    if (lead?.name) return lead.name;
  }
  return a.lead_phone || "Cliente sin nombre";
}
function confirmButton(label: string, action: string, extra: string, question: string): string {
  return `<button class="btn ${extra}" name="accion" value="${esc(action)}" onclick="return confirm('${esc(question)}')">${esc(label)}</button>`;
}
function button(label: string, action: string, extra = "") {
  return `<button class="btn ${extra}" name="accion" value="${esc(action)}">${esc(label)}</button>`;
}

// ---------- pantalla ----------
const MENU: [string, string][] = [
  ["/crm", "Hoy"],
  ["/crm/citas", "Visitas"],
  ["/crm/reservas", "Reservas"],
  ["/crm/pendientes", "Pendientes"],
  ["/crm/correos", "Correos"],
  ["/crm/whatsapp", "WhatsApp"],
  ["/crm/llamadas", "Llamadas"],
  ["/crm/clientes", "Clientes"],
  ["/crm/coches", "Coches"],
];

function page(section: string, user: CrmUser, body: string, msg?: string): string {
  // Studio IA gasta dinero real en cada generación (16-17/10/2026) -- a
  // petición real ("a esa seccion, solo puedo acceder yo y el correo de
  // automoviles lucero o administradores") queda reservada a admins, igual
  // que Papelera/Integraciones/Equipo.
  const menu: [string, string][] = [
    ...MENU,
    ...(user.role === "admin" ? ([["/crm/studio", "Studio IA"], ["/crm/papelera", "Papelera"], ["/crm/integraciones", "Integraciones"], ["/crm/equipo", "Equipo"]] as [string, string][]) : []),
  ];
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(section)} · Lucero</title>
<link rel="manifest" href="/crm/manifest.json"><meta name="theme-color" content="#1d2b44">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Lucero"><link rel="apple-touch-icon" href="/crm/icono.svg">
<style>
*{box-sizing:border-box}
body{margin:0;font:20px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f3f4f6;color:#1d1f24}
header{background:#1d2b44;color:#fff;padding:14px 18px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
header strong{font-size:24px}
nav{display:flex;flex-wrap:wrap;gap:8px}
nav a{color:#fff;text-decoration:none;background:#2e4166;padding:12px 16px;border-radius:12px;font-size:19px}
nav a.on{background:#f0b429;color:#1d2b44;font-weight:700}
/* Menú plegado (19/10/2026, a petición real de Ramón: "que en vez de
   salir en línea, que salga Hoy y al pinchar en Hoy salgan todas las
   demás") -- antes el <nav> enseñaba los 13 enlaces siempre; ahora solo
   se ve "Hoy", y al pulsarlo se despliega el resto debajo. <details> es
   nativo del navegador (sin JS, funciona igual en el móvil) y conserva
   el resaltado de la sección activa dentro de la lista desplegada. */
.navmenu{position:relative}
.navmenu summary{list-style:none;cursor:pointer;color:#fff;background:#2e4166;padding:12px 16px;border-radius:12px;font-size:19px;font-weight:700}
.navmenu summary::-webkit-details-marker{display:none}
.navmenu summary::after{content:" ▾"}
.navmenu[open] summary{background:#f0b429;color:#1d2b44}
.navmenu[open] summary::after{content:" ▴"}
.navmenu-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
main{max-width:980px;margin:0 auto;padding:18px}
h1{font-size:34px;margin:6px 0 4px}
h2{font-size:24px;margin:22px 0 10px}
.sub{color:#4b5563;margin:0 0 16px;font-size:20px}
.msg{background:#e3f6e8;border:3px solid #2e9e55;padding:14px 18px;border-radius:14px;margin-bottom:16px;font-size:21px;font-weight:600}
.card{background:#fff;border-radius:16px;padding:18px 20px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.08);display:flex;gap:16px;flex-wrap:wrap;position:relative}
.card .info{flex:1;min-width:220px}
.card h3{margin:0 0 6px;font-size:23px}
.card p{margin:4px 0;font-size:20px}
.when{background:#1d2b44;color:#fff;border-radius:14px;padding:12px 16px;text-align:center;min-width:112px}
.when b{display:block;font-size:40px;line-height:1}
.when span{font-size:18px;display:block}
.when em{font-style:normal;font-size:26px;font-weight:700;display:block;margin-top:4px}
.tag{display:inline-block;padding:6px 12px;border-radius:999px;font-size:18px;margin:4px 6px 4px 0;background:#e8ebf1}
.todo{background:#fff8e6;border:3px solid #d9a22b;border-radius:16px;padding:16px 18px;margin-bottom:20px}
.todo a{display:block;font-size:21px;padding:10px 0;color:#1d2b44;font-weight:600;text-decoration:none}
.allok{background:#e3f6e8;border:3px solid #2e9e55;border-radius:16px;padding:18px;margin-bottom:20px;font-size:22px;font-weight:700}
.empty{background:#fff;border-radius:16px;padding:20px;color:#4b5563;font-size:20px}
.urgent{border-left:10px solid #b3261e}.pending{border-left:10px solid #d9a22b}.done{border-left:10px solid #2e9e55}.off{border-left:10px solid #9aa1ad;opacity:.75}
/* Módulo mensajes/clientes (18/10/2026): "leído" y "respondido" son estados
   distintos -- sin responder resalta (fondo claro, texto en negrita);
   respondido se apaga (fondo gris, sin perder legibilidad); sin leer lleva
   además el texto en negrita. No confundir con .urgent/.pending/.done, que
   son el borde de color de Pendientes/Reservas/Visitas. */
.msg-unanswered{background:#fffaf0}
.msg-answered{background:#f3f4f6;opacity:.82}
.msg-unread h3,.msg-unread .meta{font-weight:800}
.msg-read h3,.msg-read .meta{font-weight:400}
.estado-ia{background:#e0ecff;color:#1d3a8a}
.estado-equipo{background:#e3f6e8;color:#1d6b3d}
.bulkbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;background:#fff;border-radius:16px;padding:14px 18px;margin:0 0 16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.bulkbar label{font-size:17px;font-weight:600;display:flex;align-items:center;gap:6px}
.msgsel{width:22px;height:22px;margin:0}
.filterbar{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}
.filterbar a{text-decoration:none}
.btn{font:inherit;font-size:20px;padding:14px 20px;border:0;border-radius:14px;background:#1d2b44;color:#fff;cursor:pointer;margin:6px 8px 6px 0;text-decoration:none;display:inline-block}
.btn.ok{background:#2e9e55}.btn.warn{background:#d9822b}.btn.danger{background:#b3261e}.btn.light{background:#e4e7ec;color:#1d2b44}
input,select,textarea{font:inherit;font-size:20px;padding:12px 14px;border:2px solid #c3c9d4;border-radius:12px;width:100%;margin:6px 0 14px;background:#fff}
label{font-size:20px;font-weight:700}
.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:640px){.row{grid-template-columns:1fr}h1{font-size:28px}}
.box{background:#fff;border-radius:16px;padding:18px 20px;margin-bottom:18px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:18px}
.stat{background:#fff;border-radius:16px;padding:16px;text-decoration:none;color:inherit;border-left:10px solid #1d2b44;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.stat b{display:block;font-size:44px;line-height:1}
.stat span{font-size:20px}
.t-hot{background:#dc2626;color:#fff;font-weight:700}
.t-warm{background:#f97316;color:#fff;font-weight:700}
.t-cold{background:#2563eb;color:#fff;font-weight:700}
.tletra{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;font-weight:800;margin-right:8px;flex-shrink:0}
.origen{display:inline-block;background:#e2e8f0;color:#1e293b;font-size:15px;font-weight:600;padding:4px 10px;border-radius:999px;margin-right:6px}
.legend{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}
a.link{color:#1d4ed8;font-weight:700;font-size:20px}
.search{display:flex;gap:10px;margin:0 0 16px}.search input{margin:0}
.pick-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px;margin:0 0 20px}
.pick-grid.compact{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.pick-card{display:flex;flex-direction:column;gap:6px;background:#fff;border:3px solid #e4e7ec;border-radius:16px;padding:14px;cursor:pointer;position:relative;transition:border-color .12s,transform .12s,box-shadow .12s}
.pick-card input{position:absolute;opacity:0;pointer-events:none}
.pick-card:hover{transform:translateY(-2px);box-shadow:0 4px 14px rgba(0,0,0,.08)}
.pick-card:has(input:checked){border-color:#1d2b44;box-shadow:0 0 0 3px rgba(29,43,68,.15)}
.pick-icon-badge{width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;color:#fff;background:#1d2b44}
.pick-label{font-weight:700;font-size:18px}
.pick-desc{font-size:14px;color:#4b5563;margin:0}
.pill-group{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px}
.pill-choice{display:inline-flex;align-items:center;gap:6px;background:#e8ebf1;border:3px solid transparent;border-radius:999px;padding:10px 16px;font-size:17px;cursor:pointer;font-weight:600;position:relative}
.pill-choice input{position:absolute;opacity:0;pointer-events:none}
.pill-choice:has(input:checked){background:#1d2b44;color:#fff}
/* Lucero Studio AI: mundo propio, más colorido que el resto del CRM (a
   petición real, 17/10/2026: "mas colorido, mas tarjetas y mejor orden") --
   vídeo en azul, imagen en ámbar, para que se distinga de un vistazo qué
   grupo de plantillas/opciones aplica a cuál. */
.studio-section{border-radius:18px;padding:18px 20px;margin:0 0 20px}
.studio-section.sec-video{background:linear-gradient(135deg,#eef4ff,#f7faff)}
.studio-section.sec-image{background:linear-gradient(135deg,#fff4e6,#fffaf2)}
.studio-section.sec-tune{background:linear-gradient(135deg,#f3f0ff,#faf8ff)}
.studio-section h2{margin:0 0 4px;font-size:22px}
.studio-section .sub{margin:0 0 14px}
.pick-card.kind-video{background:#fff;border-color:#c7dbff}
.pick-card.kind-video:has(input:checked){border-color:#2563eb;background:#eaf1ff;box-shadow:0 0 0 3px rgba(37,99,235,.18)}
.pick-card.kind-video .pick-icon-badge{background:#2563eb}
.pick-card.kind-image{background:#fff;border-color:#f3d9ad}
.pick-card.kind-image:has(input:checked){border-color:#d9822b;background:#fff1dc;box-shadow:0 0 0 3px rgba(217,130,43,.18)}
.pick-card.kind-image .pick-icon-badge{background:#d9822b}
.pick-card.kind-tune{background:#fff;border-color:#ddd0fb}
.pick-card.kind-tune:has(input:checked){border-color:#7c3aed;background:#f3ecff;box-shadow:0 0 0 3px rgba(124,58,237,.18)}
.pick-card.kind-tune .pick-icon-badge{background:#7c3aed}
.studio-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:0 0 20px}
.studio-ribbon{display:inline-block;padding:5px 12px;border-radius:999px;font-size:14px;font-weight:700;color:#fff;margin-bottom:6px}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
.gallery .card{display:block;margin:0;position:relative}
@media print{header,nav,.noprint,.btn{display:none!important}body{background:#fff}main{max-width:none}.card{box-shadow:none;border:1px solid #999}}
</style></head><body>
<header><strong>Automóviles Lucero</strong>
<nav><details class="navmenu"><summary>Hoy</summary><div class="navmenu-list">${menu.map(([href, label]) => `<a href="${href}" class="${section === label ? "on" : ""}">${label}</a>`).join("")}</div></details></nav>
<form method="post" action="/crm/salir" style="margin:0"><button class="btn light" type="submit">Salir</button></form></header>
<main>${msg ? `<div class="msg">${esc(msg)}</div>` : ""}${body}</main>
<script>
// Mantiene el scroll al enviar un formulario (14/10/2026, a petición real:
// "cada vez que elimino un cliente la página vuelve al principio"). Cualquier
// acción con botón (eliminar, confirmar, cancelar...) hace un POST normal que
// recarga la página entera -- el navegador vuelve arriba por defecto. Se
// guarda la posición justo antes de enviar cualquier formulario de esta
// página, y se restaura al cargar la misma URL base (sin la query de
// mensaje) después del redirect. Genérico: funciona en cualquier lista del
// CRM, no solo en Clientes.
(function () {
  var KEY = "lucero_scroll:" + location.pathname;
  var saved = sessionStorage.getItem(KEY);
  if (saved) {
    sessionStorage.removeItem(KEY);
    var y = parseInt(saved, 10);
    if (!isNaN(y)) window.scrollTo(0, y);
  }
  document.addEventListener("submit", function () {
    try { sessionStorage.setItem(KEY, String(window.scrollY)); } catch (e) {}
  }, true);
})();
// Selección masiva de mensajes (módulo mensajes/clientes, 18/10/2026):
// la casilla "Seleccionar todos" marca/desmarca todas las de su misma
// bandeja de un golpe. Genérico, lo usan Correos/WhatsApp/Llamadas.
window.toggleAllMsgs = function (master, name) {
  document.querySelectorAll('input[type=checkbox][name="' + name + '"]').forEach(function (cb) {
    cb.checked = master.checked;
  });
};
// Timbre real (13/10/2026, corregido tras probarlo en vivo): avisa con un
// sonido tipo "ding" y refresca la página sola cuando aparece una alerta
// urgente nueva (lead caliente, reserva, escalado) -- comprueba cada 15s en
// cualquier página del CRM. Dos fallos reales detectados en la primera
// versión, ya arreglados:
// 1) Los navegadores bloquean el audio hasta que haya una interacción real
//    (clic, tecla, toque) -- el AudioContext se crea una sola vez y se
//    "desbloquea" en la primera interacción, no al cargar la página.
// 2) No bastaba con sonar -- había que recargar sola la página para ver la
//    reserva/alerta sin que nadie tenga que pulsar F5 a mano.
(function () {
  var KEY = "lucero_seen_alerts";
  // El AudioContext se crea YA (al cargar la página, no espera a nada) --
  // nace "suspended" hasta que algo real lo reanude. El botón visible
  // "Activar y probar el sonido" llama a resume() directamente dentro de
  // su propio clic, que es la forma más fiable de desbloquearlo (mejor
  // que esperar un clic cualquiera en cualquier sitio, que es más fácil
  // que falle o pase desapercibido).
  var ctx = null;
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  ["click", "keydown", "touchstart"].forEach(function (evt) {
    document.addEventListener(evt, function () { if (ctx && ctx.state === "suspended") ctx.resume(); }, { passive: true });
  });
  window.lucerosonar = ding;
  function seen() { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; } }
  function saveSeen(a) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) {} }
  function playTones() {
    try {
      [1046.5, 1318.5, 1568].forEach(function (freq, i) {
        var delay = i * 0.11;
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "triangle"; o.frequency.value = freq;
        o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
        g.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + delay + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.22);
        o.start(ctx.currentTime + delay); o.stop(ctx.currentTime + delay + 0.22);
      });
    } catch (e) {}
  }
  function ding() {
    // Estilo "Tri-tone" de iPhone (13/10/2026, a petición): tres notas
    // cortas, brillantes y ascendentes en rápida sucesión -- no es el
    // archivo exacto de Apple (no se puede ni se debe copiar), pero sí el
    // mismo estilo general.
    //
    // Arreglo real (13/10/2026): sonar justo después de resume() sin
    // esperar a que la promesa termine podía perderse en algunos
    // navegadores (el contexto seguía "despertando" cuando se programaban
    // los tonos). Ahora se espera de verdad a que resume() resuelva antes
    // de sonar.
    if (!ctx) return; // sin soporte de audio en este navegador
    if (ctx.state === "suspended") {
      ctx.resume().then(playTones).catch(function () {});
    } else {
      playTones();
    }
  }
  // Quitado el aviso visual en pantalla (13/10/2026, a petición real): si
  // Ramón/José están lejos del ordenador no lo van a leer -- lo único que
  // de verdad avisa ahí es el sonido, así que el timbre suena igual en
  // cualquier página, sin depender de un aviso visual que nadie va a ver.
  // En la propia página Hoy: sustituye el contenido por el nuevo sin
  // navegar de verdad -- así el AudioContext nunca se destruye y no hace
  // falta tocar nada para verlo ni para que el timbre siga funcionando.
  function softRefreshHoy() {
    // Se extrae con indexOf/substring, no con un regex -- un regex aquí
    // dentro de esta plantilla de TypeScript necesita las barras
    // invertidas escapadas dos veces (una para TS, otra para el propio
    // regex), y un fallo exacto en ese escapado rompió TODO este script
    // la primera vez (13/10/2026) -- ni sonaba ni refrescaba nada, un
    // error de sintaxis silencioso. Así no hay barras invertidas que
    // puedan romperse.
    fetch("/crm").then(function (r) { return r.text(); }).then(function (html) {
      var start = html.indexOf("<main>");
      var end = html.lastIndexOf("</main>");
      var main = document.querySelector("main");
      if (start !== -1 && end !== -1 && main) {
        main.innerHTML = html.slice(start + 6, end);
      }
    }).catch(function () {});
  }
  function check() {
    fetch("/crm/alertas-activas.json").then(function (r) { return r.json(); }).then(function (d) {
      var prev = seen();
      var ids = d.ids || [];
      var fresh = ids.filter(function (id) { return prev.indexOf(id) === -1; });
      saveSeen(ids);
      if (fresh.length > 0) {
        ding();
        if (location.pathname === "/crm" || location.pathname === "/crm/") softRefreshHoy();
      }
    }).catch(function () {});
  }
  check();
  setInterval(check, 15000);
})();
</script>
</body></html>`;
}

// Campo de contraseña con un botón para ver u ocultar el texto.
function pwInput(attrs: string, id: string): string {
  return `<div style="position:relative"><input id="${id}" type="password" ${attrs} style="padding-right:72px"><button type="button" onclick="var i=document.getElementById('${id}');var s=i.type==='password';i.type=s?'text':'password';this.textContent=s?'Ocultar':'Ver'" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);width:auto;margin:0;padding:6px 10px;font-size:15px;background:none;color:#1d2b44;font-weight:600;cursor:pointer;border:0">Ver</button></div>`;
}

function loginPage(error?: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Entrar · Lucero</title>
<style>body{margin:0;font:18px system-ui;background:#1d2b44;display:flex;min-height:100vh;align-items:center;justify-content:center}
.box{background:#fff;border-radius:16px;padding:28px;width:min(420px,92vw)}h1{margin:0 0 14px}
input{font:inherit;font-size:18px;padding:12px;width:100%;margin:6px 0 14px;border:2px solid #c9ced8;border-radius:10px;box-sizing:border-box}
button{font:inherit;font-size:20px;padding:14px;width:100%;border:0;border-radius:12px;background:#1d2b44;color:#fff;cursor:pointer}
.err{background:#fde2df;color:#8a1f0c;padding:10px;border-radius:10px;margin-bottom:12px}</style></head>
<body><form class="box" method="post" action="/crm/entrar"><h1>Entrar</h1>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<label>Correo</label><input name="email" type="email" required autofocus>
<label>Contraseña</label>${pwInput('name="password" required', 'pw-entrar')}
<button type="submit">Entrar</button></form></body></html>`;
}

// ---------- sesión ----------
function cookieValue(req: express.Request, name: string): string | undefined {
  const raw = req.headers.cookie ?? "";
  const found = raw.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : undefined;
}
function setSessionCookie(res: express.Response, token: string, req: express.Request) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `crm_session=${encodeURIComponent(token)}; Path=/crm; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`);
}
function clearSessionCookie(res: express.Response) {
  res.setHeader("Set-Cookie", "crm_session=; Path=/crm; HttpOnly; SameSite=Strict; Max-Age=0");
}

crm.get("/entrar", (_req, res) => {
  res.type("html").send(loginPage());
});

crm.post("/entrar", (req, res) => {
  const email = String(req.body.email ?? "").trim().toLowerCase();
  const password = String(req.body.password ?? "");
  const user = listUsers().find((u) => u.email === email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    res.status(401).type("html").send(loginPage("Correo o contraseña incorrectos."));
    return;
  }
  setSessionCookie(res, createSession(user.id), req);
  res.redirect("/crm");
});

crm.post("/salir", (req, res) => {
  destroySession(cookieValue(req, "crm_session"));
  clearSessionCookie(res);
  res.redirect("/crm/entrar");
});

crm.get("/manifest.json", (_req, res) => {
  res.type("application/manifest+json").send(JSON.stringify({
    name: "Lucero: clientes y reservas",
    short_name: "Lucero",
    start_url: "/crm",
    scope: "/crm",
    display: "standalone",
    background_color: "#1d2b44",
    theme_color: "#1d2b44",
    icons: [{ src: "/crm/icono.svg", sizes: "any", type: "image/svg+xml" }],
  }));
});
crm.get("/icono.svg", (_req, res) => {
  res.type("image/svg+xml").send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#1d2b44"/><text x="256" y="350" font-family="Arial,sans-serif" font-size="300" font-weight="700" fill="#f0b429" text-anchor="middle">L</text></svg>');
});

crm.use((req, res, next) => {
  // La propia API de Higgsfield necesita descargar la foto subida desde
  // fuera, sin cookie de sesión del CRM -- por eso esta única ruta queda
  // pública (sirve solo archivos de coches para anuncios, nada sensible).
  if (req.path === "/entrar" || req.path.startsWith("/studio/archivo/")) return next();
  const user = userForSession(cookieValue(req, "crm_session"));
  if (!user) {
    res.redirect("/crm/entrar");
    return;
  }
  (res.locals as { user: CrmUser }).user = user;
  next();
});

function me(res: express.Response): CrmUser {
  return (res.locals as { user: CrmUser }).user;
}
function back(res: express.Response, to: string, msg: string) {
  res.redirect(`${to}${to.includes("?") ? "&" : "?"}msg=${encodeURIComponent(msg)}`);
}
function msgOf(req: express.Request): string | undefined {
  return typeof req.query.msg === "string" ? req.query.msg : undefined;
}

// ---------- tarjetas reutilizables ----------
function apptCard(a: Appointment): string {
  const d = dayLabel(a.requested_date);
  const tone = a.status === "requested" ? "pending" : a.status === "confirmed" ? "done" : "off";
  const veh = vehicleName(a.vehicle_id);
  const whatsapp = waButton(a.lead_phone, `Hola, le escribe Automóviles Lucero. Le esperamos el ${d.weekday} ${d.day} de ${d.month} a las ${a.requested_time ?? ""} para ver el ${veh}. ¿Le viene bien?`);
  const actions = [
    a.status === "requested" ? button("Confirmar la visita", "confirmar", "ok") : "",
    a.status !== "cancelled" ? confirmButton("Cancelar la visita", "cancelar", "danger", "¿Seguro que quieres cancelar esta visita?") : "",
    // A petición real (16/10/2026, "en esta sección quiero que añadas la
    // papelera, para borrar consultas antiguas"): disponible siempre, no
    // solo cuando está cancelada -- una consulta vieja pendiente de
    // confirmar también hay que poder limpiarla sin cancelarla antes.
    confirmButton("🗑️", "eliminar", "light", "¿Eliminar esta visita para siempre? Se puede restaurar luego desde la Papelera."),
  ].join("");
  return `<div class="card ${tone}" id="c-${esc(a.id)}" style="position:relative">
${simpleCheckbox("citas-bulk", a.id)}
<div class="when"><span>${esc(d.weekday)}</span><b>${esc(d.day)}</b><span>${esc(d.month)}</span><em>${esc(a.requested_time ?? "")}</em></div>
<div class="info"><h3>${esc(veh)}</h3>
<p><span class="tag">${esc(APPOINTMENT_TEXT[a.status] ?? a.status)}</span>${a.appointment_type ? `<span class="tag">${esc(a.appointment_type)}</span>` : ""}</p>
<p>Cliente: <b>${esc(contactLabel(a.lead_phone, null))}</b></p>
${a.notes ? `<p>${esc(a.notes)}</p>` : ""}
<form method="post" action="/crm/citas/${esc(a.id)}">${actions}
${phoneLink(a.lead_phone)}${whatsapp}
<div class="row"><div><label>Otro día</label><input type="date" name="fecha" value="${esc(a.requested_date ?? "")}"></div>
<div><label>Otra hora</label><input type="time" name="hora" value="${esc(a.requested_time ?? "")}"></div></div>
<button class="btn light" type="submit" name="accion" value="cambiar">Cambiar día y hora</button>
</form></div></div>`;
}

function reservationCard(r: Reservation, user: CrmUser): string {
  const sold = getOfficialStatus(r.vehicle_id) === "SOLD";
  const tone = sold ? "off" : r.status === "pending_verification" ? "urgent" : r.status === "pending_payment" ? "pending" : r.status === "confirmed" ? "done" : "off";
  const veh = vehicleName(r.vehicle_id);
  const actions: string[] = [];
  if (r.status === "pending_payment") actions.push(button("Ha pagado", "pagado", "warn"));
  if (r.status === "pending_verification") {
    if (canConfirmPayments(user)) actions.push(confirmButton("Confirmar la reserva", "confirmar", "ok", "¿Has comprobado el justificante de los 500 €?"));
    else actions.push(`<span class="tag">El pago lo confirma el comercial</span>`);
  }
  if (r.status === "confirmed" && !sold && canConfirmPayments(user)) actions.push(confirmButton("Coche vendido y entregado", "vendido", "ok", "¿Seguro que el coche ya está vendido y entregado?"));
  if (sold) actions.unshift(`<span class="tag" style="background:#e5e7eb">Coche vendido y entregado</span>`);
  if (r.status === "pending_payment" || r.status === "pending_verification") actions.push(confirmButton("Cancelar la reserva", "cancelar", "danger", "¿Seguro que quieres cancelar esta reserva?"));
  // Papelera real (13/10/2026): solo para reservas ya cerradas (canceladas o
  // caducadas) y solo el administrador -- una reserva viva nunca se borra
  // sin pasar antes por cancelar/confirmar, para no perder el rastro de un
  // pago real a medio gestionar.
  if ((r.status === "cancelled" || r.status === "expired") && user.role === "admin") {
    actions.push(confirmButton("Eliminar", "eliminar", "danger", `"${veh}" se borra para siempre del registro, no se puede deshacer.`));
  }
  const whatsapp = r.status === "pending_payment"
    ? waButton(r.lead_phone, `Hola, le escribe Automóviles Lucero. Para apartar el ${veh} necesitamos 500 €. Cuando haga el pago, envíenos el justificante por aquí. Gracias.`)
    : "";
  const canBulkDelete = (r.status === "cancelled" || r.status === "expired") && user.role === "admin";
  return `<div class="card ${tone}" id="r-${esc(r.id)}" style="position:relative"><div class="info">
${canBulkDelete ? simpleCheckbox("reservas-bulk", r.id) : ""}
<h3>${esc(veh)}</h3>
<p><span class="tag">${esc(sold ? "Vendido" : RESERVATION_TEXT[r.status] ?? r.status)}</span><span class="tag">${r.amount_eur} €</span></p>
<p>Cliente: <b>${esc(contactLabel(r.lead_phone, null))}</b></p>
<p>Desde el ${esc(fmtDate(r.created_at))}${r.verified_by ? ` · confirmada por ${esc(r.verified_by)}` : ""}</p>
<form method="post" action="/crm/reservas/${esc(r.id)}">${actions.join("")}${phoneLink(r.lead_phone)}${whatsapp}
<div class="row"><div><label>✏️ Teléfono del cliente</label><input name="telefono" value="${esc(r.lead_phone ?? "")}"></div>
<div><label>✏️ Importe (€)</label><input type="number" name="importe" value="${r.amount_eur}" min="0"></div></div>
<button class="btn light" type="submit" name="accion" value="editar">Guardar cambios</button>
</form>
</div></div>`;
}

function leadCard(l: Lead, user: CrmUser): string {
  const t = TEMP[l.temperature] ?? TEMP.COLD;
  const whatsapp = waButton(l.phone, "Hola, le escribe Automóviles Lucero. ¿En qué le podemos ayudar?");
  const del = user.role === "admin"
    ? `<form method="post" action="/crm/clientes/${esc(l.id)}" style="display:inline">${confirmButton("Eliminar", "eliminar", "danger", `¿Eliminar a "${l.name || l.phone || "este cliente"}"? Se puede restaurar luego desde la Papelera.`)}</form>`
    : "";
  const archiveBtn = `<form method="post" action="/crm/clientes/${esc(l.id)}" style="display:inline"><button class="btn light" type="submit" name="accion" value="${l.archived ? "desarchivar" : "archivar"}">${l.archived ? "Desarchivar" : "Archivar"}</button></form>`;
  const sel = user.role === "admin" ? `<input class="msgsel" type="checkbox" name="ids" value="${esc(l.id)}" form="clientes-bulk" style="position:absolute;top:18px;right:20px">` : "";
  return `<div class="card" style="position:relative"><div class="info">
${sel}
<h3>${esc(leadDisplayName(l))}</h3>
<p><span class="tletra ${t.cls}">${t.letter}</span><span class="tag ${t.cls}">${esc(t.label)}</span> <span class="origen">${esc(ORIGIN[l.origin ?? l.channel ?? ""] ?? "Origen sin registrar")}</span>${!l.name ? `<span class="tag" style="background:#fde2e1;color:#7a1c17">Sin nombre</span>` : ""}${l.do_not_contact ? `<span class="tag">No volver a escribir</span>` : ""}${l.archived ? `<span class="tag">Archivado</span>` : ""}</p>
<p><b>${esc(situation(l))}</b></p>
<p>Último contacto: ${esc(fmtDate(l.updated_at ?? l.created_at))}</p>
<a class="btn" href="/crm/clientes/${esc(l.id)}">✏️ Editar / ver ficha</a>${phoneLink(l.phone)}${whatsapp}${archiveBtn}${del}
</div></div>`;
}

// ---------- Hoy ----------
function todaySummary(today: string): string {
  const list2 = list<Appointment>("appointments").filter((a) => a.status !== "cancelled" && a.requested_date === today).sort((x, y) => (x.requested_time ?? "").localeCompare(y.requested_time ?? ""));
  if (list2.length === 0) return "Hoy no tienes visitas.";
  const parts = list2.map((a) => `a las ${a.requested_time ?? "?"} ${vehicleName(a.vehicle_id)} (${a.lead_phone ?? "sin contacto"})`);
  return `Hoy tienes ${list2.length} ${list2.length === 1 ? "visita" : "visitas"}: ${parts.join("; ")}.`;
}

crm.get("/", (req, res) => {
  const today = todayMadrid();
  const appts = list<Appointment>("appointments").filter((a) => a.status !== "cancelled");
  const reservations = list<Reservation>("reservations");
  const handoffs = list<Handoff>("handoffs").filter((h) => h.status === "requested");
  const mails = list<InboxMail>("email_inbox").filter((m) => m.outcome !== "automated_no_reply" && !m.answered);
  const todayAppts = appts.filter((a) => a.requested_date === today).sort((x, y) => (x.requested_time ?? "").localeCompare(y.requested_time ?? ""));
  const upcoming = appts.filter((a) => (a.requested_date ?? "") > today).sort((x, y) => (x.requested_date ?? "").localeCompare(y.requested_date ?? "")).slice(0, 6);
  const toAttend = reservations.filter((r) => r.status === "pending_payment" || r.status === "pending_verification");
  const todo: { href: string; text: string }[] = [
    ...toAttend.filter((r) => r.status === "pending_verification").map((r) => ({ href: "/crm/reservas", text: `Confirmar la reserva de ${vehicleName(r.vehicle_id)}` })),
    ...todayAppts.filter((a) => a.status === "requested").map((a) => ({ href: "/crm/citas", text: `Confirmar la visita de hoy a las ${a.requested_time ?? "?"}` })),
    ...handoffs.map((h) => ({ href: "/crm/pendientes", text: `Atender: ${h.reason ?? "un cliente necesita una persona"}` })),
    ...mails.map((m) => ({ href: "/crm/pendientes", text: `Contestar a ${m.from}` })),
  ];
  const d = dayLabel(today);
  const alerts = pendingAlerts();
  const emailLabels: Record<string, string> = {
    enviado: "sí",
    pendiente: "en curso",
    sin_correo_conectado: "no, falta conectar Google",
    sin_destinatarios: "no hay destinatarios",
    error: "error al enviar",
  };
  const alertBlock = alerts.length
    ? `<div class="msg" style="background:#fdecea;border-color:#c62828"><b>Llamar ya (${alerts.length})</b></div>` +
      (me(res).role === "admin" ? simpleBulkBar("alertas-bulk", "/crm/alertas-masivo", alerts.length, "¿Eliminar las alertas seleccionadas? Úsalo solo para pruebas; se pueden recuperar luego desde la Papelera.") : "") +
      alerts
        .map(
          (a) => {
            // La razón a veces trae un enlace wa.me incrustado como texto
            // plano (encargo real, 18/10/2026: "esto se ve feo porque sale
            // asi") -- se extrae y se muestra como botón real de WhatsApp,
            // en vez de una URL suelta dentro del párrafo.
            const waLink = extractWaLink(a.reason);
            const afterWaStrip = waLink ? a.reason.replace(waLink, "").replace(/\s*[:.]\s*$/, "").trim() : a.reason;
            const { portal, rest: reasonClean } = extractLeadingPortal(afterWaStrip);
            return `<div class="card" style="position:relative"><div class="info">
${me(res).role === "admin" ? simpleCheckbox("alertas-bulk", a.id) : ""}
<h3>${esc(alertDisplayName(a))}</h3>
<p><span class="tletra t-hot">${a.kind === "lead_caliente" ? "C" : a.kind === "reserva_pendiente" ? "R" : "!"}</span><span class="tag t-hot">${a.kind === "lead_caliente" ? "Caliente" : a.kind === "reserva_pendiente" ? "RESERVA 500€" : "Urgente"}</span> ${portal ? platformTag(portal) : ""} ${esc(fmtDate(a.created_at))}</p>
<p>${esc(reasonClean)}</p>
<p>Aviso por correo: ${esc(emailLabels[a.email_status] ?? a.email_status)}</p>
${phoneLink(a.lead_phone)}${waLink ? waButton(waLink.replace("https://wa.me/", ""), "") : ""}
<form method="post" action="/crm/alertas/${esc(a.id)}" style="display:inline"><button class="btn ok" type="submit">Ya le he llamado</button></form>
${me(res).role === "admin" ? `<form method="post" action="/crm/alertas/${esc(a.id)}" style="display:inline"><button class="btn danger" type="submit" name="accion" value="eliminar" onclick="return confirm('¿Eliminar esta alerta para siempre? Úsalo solo para pruebas.')">Eliminar</button></form>` : ""}
</div></div>`;
          },
        )
        .join("")
    : "";
  const todoBlock = todo.length
    ? `<div class="todo"><h2 style="margin-top:0">Lo que tienes que hacer</h2>${todo.slice(0, 8).map((t) => `<a href="${t.href}">→ ${esc(t.text)}</a>`).join("")}</div>`
    : `<div class="allok">Todo hecho. No hay nada pendiente.</div>`;
  const body = `<h1>Hoy</h1><p class="sub">${esc(d.weekday)} ${esc(d.day)} de ${esc(d.month)}</p>
<div class="box noprint"><button class="btn ok" type="button" onclick="window.lucerosonar && window.lucerosonar()">🔔 Activar y probar el sonido de avisos</button><p class="sub" style="margin:8px 0 0">Púlsalo una vez al abrir el CRM cada día -- oirás un pitido de prueba ahora mismo. A partir de ahí, sonará solo cuando llegue un aviso urgente, sin que tengas que hacer nada más.</p></div>
<form class="search noprint" method="get" action="/crm/buscar"><input name="q" placeholder="Buscar: nombre, teléfono o coche" required><button class="btn" type="submit">Buscar</button></form>
<div class="box"><p style="margin:0;font-size:22px"><b>${esc(todaySummary(today))}</b></p></div>
<div class="stats">
<a class="stat" href="/crm/citas"><b>${todayAppts.length}</b><span>visitas hoy</span></a>
<a class="stat" href="/crm/reservas"><b>${toAttend.length}</b><span>reservas por atender</span></a>
<a class="stat" href="/crm/pendientes"><b>${handoffs.length + mails.length}</b><span>pendientes</span></a>
</div>
${alertBlock}
${todoBlock}
${me(res).role === "admin" && todayAppts.length + upcoming.length > 0 ? simpleBulkBar("citas-bulk", "/crm/citas-masivo", todayAppts.length + upcoming.length, "¿Eliminar las visitas seleccionadas? Se pueden recuperar luego desde la Papelera.") : ""}
<h2>Visitas de hoy</h2>${todayAppts.length === 0 ? `<div class="empty">Hoy no hay visitas.</div>` : todayAppts.map(apptCard).join("")}
<h2>Próximas visitas</h2>${upcoming.length === 0 ? `<div class="empty">No hay visitas próximas.</div>` : upcoming.map(apptCard).join("")}
<h2>Reservas que hay que atender</h2>${toAttend.length === 0 ? `<div class="empty">No hay reservas esperando.</div>` : toAttend.map((r) => reservationCard(r, me(res))).join("")}`;
  res.type("html").send(page("Hoy", me(res), body, msgOf(req)));
});

// ---------- Buscar ----------
crm.get("/buscar", (req, res) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  const match = (...values: (string | null | undefined)[]) => values.some((v) => v && v.toLowerCase().includes(q));
  const leads = q ? list<Lead>("leads").filter((l) => match(l.name, l.phone, l.vehicle_interest) || (digits.length >= 4 && (l.phone ?? "").replace(/\D/g, "").includes(digits))) : [];
  const appts = q ? list<Appointment>("appointments").filter((a) => match(a.lead_phone, vehicleName(a.vehicle_id))) : [];
  const resv = q ? list<Reservation>("reservations").filter((r) => match(r.lead_phone, vehicleName(r.vehicle_id))) : [];
  const cars = q ? currentVehicles().filter((v) => match(vehicleName(v.id))) : [];
  const found = leads.length + appts.length + resv.length + cars.length;
  const body = `<h1>Buscar</h1><p class="sub">${q ? `Resultados para "${esc(q)}": ${found}` : "Escribe algo arriba."}</p>
${leads.map((l) => leadCard(l, me(res))).join("")}
${appts.map(apptCard).join("")}
${resv.map((r) => reservationCard(r, me(res))).join("")}
${cars.map((v) => `<div class="card"><div class="info"><h3>${esc(vehicleName(v.id))}</h3><p>${esc(priceOf(v.id).toLocaleString("es-ES"))} €</p><a class="btn" href="/crm/coches/${esc(v.id)}">Ver coche</a></div></div>`).join("")}
${q && found === 0 ? `<div class="empty">No encuentro nada con eso.</div>` : ""}`;
  res.type("html").send(page("Hoy", me(res), body));
});

// ---------- Semana para imprimir ----------
crm.get("/semana", (req, res) => {
  const start = new Date(`${todayMadrid()}T12:00:00`);
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d.toLocaleDateString("sv-SE"));
  }
  const appts = list<Appointment>("appointments").filter((a) => a.status !== "cancelled" && days.includes(a.requested_date ?? ""))
    .sort((x, y) => `${x.requested_date}${x.requested_time}`.localeCompare(`${y.requested_date}${y.requested_time}`));
  const body = `<div class="noprint" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h1 style="margin:0">Visitas de esta semana</h1><button class="btn ok" onclick="window.print()">Imprimir</button></div>
<p class="sub">Próximos siete días.</p>
${appts.length === 0 ? `<div class="empty">No hay visitas esta semana.</div>` : appts.map(apptCard).join("")}`;
  res.type("html").send(page("Visitas", me(res), body));
});

// ---------- Visitas ----------
crm.get("/citas", (req, res) => {
  const f = typeof req.query.f === "string" ? req.query.f : "todas";
  let items = list<Appointment>("appointments");
  if (f === "pendientes") items = items.filter((a) => a.status === "requested");
  if (f === "confirmadas") items = items.filter((a) => a.status === "confirmed");
  items.sort((x, y) => `${x.requested_date ?? ""}${x.requested_time ?? ""}`.localeCompare(`${y.requested_date ?? ""}${y.requested_time ?? ""}`));
  const pill = (k: string, label: string) => `<a href="/crm/citas?f=${k}" class="tag" style="text-decoration:none;${f === k ? "background:#1d2b44;color:#fff" : ""}">${label}</a>`;
  const body = `<h1>Visitas</h1>
<p class="sub">Aquí ves los días y las horas en que vendrán los clientes a ver un coche.</p>
<p>${pill("todas", "Todas")} ${pill("pendientes", "Por confirmar")} ${pill("confirmadas", "Confirmadas")} <a class="link noprint" href="/crm/semana">Ver la semana para imprimir</a></p>
${items.length > 0 ? simpleBulkBar("citas-bulk", "/crm/citas-masivo", items.length, "¿Eliminar las visitas seleccionadas? Se pueden recuperar luego desde la Papelera.") : ""}
${items.length === 0 ? `<div class="empty">No hay visitas en esta lista.</div>` : items.map(apptCard).join("")}`;
  res.type("html").send(page("Visitas", me(res), body, msgOf(req)));
});

crm.post("/citas/:id", (req, res) => {
  const accion = String(req.body.accion ?? "");
  const appts = list<Appointment>("appointments");
  const a = appts.find((x) => x.id === req.params.id);
  if (!a) return back(res, "/crm/citas", "No encuentro esa visita");
  if (accion === "eliminar") {
    // A petición real (16/10/2026, "en esta sección quiero que añadas la
    // papelera, para borrar consultas antiguas"): antes solo se podía
    // eliminar una visita ya cancelada -- pero una consulta vieja sin fecha
    // fijada (pendiente de confirmar) también hay que poder limpiarla sin
    // tener que cancelarla primero. Se puede restaurar desde la Papelera
    // igual que cualquier otra cosa, así que quitar esta restricción no
    // pierde nada.
    if (me(res).role !== "admin") return back(res, "/crm/citas", "Solo el administrador puede eliminar visitas");
    moveToTrash("appointments", a, `Visita: ${vehicleName(a.vehicle_id)} (${a.lead_phone ?? "sin contacto"})`, me(res).email);
    save("appointments", appts.filter((x) => x.id !== a.id));
    return back(res, "/crm/citas", "Visita movida a la papelera");
  }
  if (accion === "confirmar") a.status = "confirmed";
  else if (accion === "cancelar") a.status = "cancelled";
  else if (accion === "cambiar") {
    const fecha = String(req.body.fecha ?? "").trim();
    const hora = String(req.body.hora ?? "").trim();
    if (fecha) a.requested_date = fecha;
    if (hora) a.requested_time = hora;
  }
  save("appointments", appts);
  back(res, "/crm/citas", accion === "confirmar" ? "Visita confirmada" : accion === "cancelar" ? "Visita cancelada" : "Día y hora cambiados");
});

// Borrado masivo (a petición real, 18/10/2026: "el borrar masivo lo quiero
// en todas las secciones"). Mismas reglas que el borrado individual: solo
// administrador, papelera recuperable.
crm.post("/citas-masivo", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm/citas", "Solo el administrador puede eliminar visitas");
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  if (ids.length === 0) return back(res, "/crm/citas", "No seleccionaste ninguna visita");
  const appts = list<Appointment>("appointments");
  const targets = appts.filter((a) => ids.includes(a.id));
  for (const a of targets) moveToTrash("appointments", a, `Visita: ${vehicleName(a.vehicle_id)} (${a.lead_phone ?? "sin contacto"})`, me(res).email);
  save("appointments", appts.filter((a) => !ids.includes(a.id)));
  back(res, "/crm/citas", targets.length === 0 ? "No había nada que hacer" : `${targets.length} visita(s) movida(s) a la papelera`);
});

// ---------- Reservas ----------
crm.get("/reservas", (req, res) => {
  const reservations = list<Reservation>("reservations").sort((a, b) => b.created_at.localeCompare(a.created_at));
  const available = currentVehicles().filter((v) => getOfficialStatus(v.id) === "AVAILABLE");
  // Solo las cerradas (canceladas/caducadas) se pueden borrar -- mismo
  // criterio que el borrado individual, ninguna reserva viva se cuenta.
  const bulkEligible = me(res).role === "admin" ? reservations.filter((r) => r.status === "cancelled" || r.status === "expired").length : 0;
  const body = `<h1>Reservas</h1>
<p class="sub">Una reserva aparta un coche con 500 €. Cuando el cliente paga, compruébalo y pulsa "Confirmar la reserva".</p>
<div class="box"><h3 style="margin-top:0">Hacer una reserva a mano</h3>
<form method="post" action="/crm/reservas">
<label>Nombre del cliente</label><input name="nombre" placeholder="Si no lo escribes, queda sin nombre en el CRM">
<label>Coche</label><select name="vehicle_id">${available.map((v) => option(v.id, `${vehicleName(v.id)} · ${priceOf(v.id)} €`, "")).join("")}</select>
<label>Teléfono o correo del cliente</label><input name="contacto" required>
<button class="btn ok" type="submit">Crear la reserva</button></form></div>
${bulkEligible > 0 ? simpleBulkBar("reservas-bulk", "/crm/reservas-masivo", bulkEligible, "¿Eliminar las reservas canceladas/caducadas seleccionadas? Se pueden recuperar luego desde la Papelera.") : ""}
${reservations.length === 0 ? `<div class="empty">Todavía no hay reservas.</div>` : reservations.map((r) => reservationCard(r, me(res))).join("")}`;
  res.type("html").send(page("Reservas", me(res), body, msgOf(req)));
});

crm.post("/reservas", async (req, res) => {
  const vehicleId = String(req.body.vehicle_id ?? "");
  const contacto = String(req.body.contacto ?? "").trim();
  const nombre = String(req.body.nombre ?? "").trim();
  if (!vehicleId || !contacto) return back(res, "/crm/reservas", "Elige un coche y escribe el contacto del cliente");
  // A petición real (19/10/2026, "pon toda la información para crear una
  // reserva"): si se escribe un nombre, se guarda en Clientes (nuevo o
  // completando uno ya existente que no lo tuviera) -- así la reserva no
  // se queda con un contacto sin nombre en ningún sitio del CRM, igual
  // que ya hace el alta manual de Clientes.
  if (nombre) {
    const leads = list<Lead>("leads");
    const existing = leads.find((l) => l.phone === contacto);
    if (existing) {
      if (!existing.name) {
        existing.name = nombre;
        existing.updated_at = now();
        save("leads", leads);
      }
    } else {
      leads.push({
        id: crypto.randomUUID(),
        phone: contacto,
        name: nombre,
        notes: null,
        channel: "MANUAL",
        origin: "MANUAL",
        vehicle_interest: vehicleId ? vehicleName(vehicleId) : null,
        temperature: "WARM",
        followup_count: 0,
        do_not_contact: false,
        created_at: now(),
      });
      save("leads", leads);
    }
  }
  const result = (await createReservationPending({ vehicle_id: vehicleId, lead_phone: contacto })) as unknown as { status: string };
  if (result.status !== "ok") return back(res, "/crm/reservas", "Ese coche no está disponible para reservar");
  back(res, "/crm/reservas", "Reserva creada. Espera el pago de 500 €");
});

crm.post("/reservas/:id", (req, res) => {
  const accion = String(req.body.accion ?? "");
  const reservations = list<Reservation>("reservations");
  const r = reservations.find((x) => x.id === req.params.id);
  if (!r) return back(res, "/crm/reservas", "No encuentro esa reserva");
  if (accion === "pagado") {
    r.status = "pending_verification";
    save("reservations", reservations);
    return back(res, "/crm/reservas", "Anotado: falta comprobar el justificante");
  }
  if ((accion === "confirmar" || accion === "vendido") && !canConfirmPayments(me(res))) {
    return back(res, "/crm/reservas", "Solo el comercial puede confirmar pagos y ventas");
  }
  if (accion === "confirmar") {
    confirmReservation({ reservation_id: r.id, verified_by: me(res).name });
    return back(res, "/crm/reservas", "Reserva confirmada: el coche queda reservado");
  }
  if (accion === "cancelar") {
    cancelReservation({ reservation_id: r.id, reason: "cancelada desde el CRM" });
    return back(res, "/crm/reservas", "Reserva cancelada: el coche vuelve a estar disponible");
  }
  if (accion === "vendido") {
    setOfficialStatus(r.vehicle_id, "SOLD", r.id);
    return res.redirect(`/crm/reservas?msg=${encodeURIComponent("Anotado: coche vendido")}#r-${r.id}`);
  }
  if (accion === "eliminar") {
    if (me(res).role !== "admin") return back(res, "/crm/reservas", "Solo el administrador puede eliminar reservas");
    if (r.status !== "cancelled" && r.status !== "expired") {
      return back(res, "/crm/reservas", "Solo se pueden eliminar reservas ya canceladas o caducadas");
    }
    moveToTrash("reservations", r, `Reserva: ${vehicleName(r.vehicle_id)} (${r.lead_phone ?? "sin contacto"})`, me(res).email);
    save("reservations", reservations.filter((x) => x.id !== r.id));
    return back(res, "/crm/reservas", "Reserva movida a la papelera");
  }
  if (accion === "editar") {
    const telefono = String(req.body.telefono ?? "").trim();
    const importe = Number(req.body.importe);
    if (telefono) r.lead_phone = telefono;
    if (Number.isFinite(importe) && importe >= 0) r.amount_eur = importe;
    save("reservations", reservations);
    return back(res, "/crm/reservas", "Cambios guardados");
  }
  back(res, "/crm/reservas", "No entendí esa acción");
});

// Borrado masivo (18/10/2026, "el borrar masivo lo quiero en todas las
// secciones") -- mismo criterio que el individual: solo canceladas o
// caducadas, nunca una reserva viva, solo administrador.
crm.post("/reservas-masivo", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm/reservas", "Solo el administrador puede eliminar reservas");
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  if (ids.length === 0) return back(res, "/crm/reservas", "No seleccionaste ninguna reserva");
  const reservations = list<Reservation>("reservations");
  const targets = reservations.filter((r) => ids.includes(r.id) && (r.status === "cancelled" || r.status === "expired"));
  for (const r of targets) moveToTrash("reservations", r, `Reserva: ${vehicleName(r.vehicle_id)} (${r.lead_phone ?? "sin contacto"})`, me(res).email);
  const targetIds = new Set(targets.map((t) => t.id));
  save("reservations", reservations.filter((r) => !targetIds.has(r.id)));
  back(res, "/crm/reservas", targets.length === 0 ? "No había nada que hacer (solo se pueden borrar canceladas o caducadas)" : `${targets.length} reserva(s) movida(s) a la papelera`);
});

// ---------- Pendientes (avisos de Miguel y correos) ----------
// Para el timbre (ver script en page()): lista de IDs de alertas urgentes
// activas ahora mismo, para que el navegador detecte cuáles son nuevas.
crm.get("/alertas-activas.json", (_req, res) => {
  res.json({ ids: pendingAlerts().map((a) => a.id) });
});

crm.get("/pendientes", async (req, res) => {
  const isAdmin = me(res).role === "admin";
  const handoffs = list<Handoff>("handoffs").filter((h) => h.status === "requested").sort((a, b) => b.created_at.localeCompare(a.created_at));
  // Backfill automático (18/10/2026, "es una automatizacion, no nada para
  // hacer a mano"): cualquier aviso de reserva ya existente que se quedara
  // sin su reserva real (de antes de este arreglo) se completa solo la
  // próxima vez que alguien abra Pendientes -- nadie tiene que pulsar nada.
  // Idempotente (tryAutoCreateReservation no duplica si ya existe), barato
  // (pocos avisos reales a la vez), y nunca rompe la carga de la página.
  for (const h of handoffs) {
    if (h.reason_type === "reserva" && h.lead_phone) {
      const lead = list<Lead>("leads").find((l) => l.phone === h.lead_phone);
      await tryAutoCreateReservation(h.lead_phone, lead?.vehicle_interest ?? null);
    }
  }
  const mails = list<InboxMail>("email_inbox").filter((m) => m.outcome !== "automated_no_reply" && !m.answered).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const body = `<h1>Pendientes</h1>
<p class="sub">Aquí aparece lo que Miguel no puede resolver solo. Cuando lo hayas atendido, pulsa el botón.</p>
<h2>Avisos de Miguel (${handoffs.length})</h2>
${isAdmin && handoffs.length > 0 ? simpleBulkBar("avisos-bulk", "/crm/avisos-masivo", handoffs.length, "¿Eliminar los avisos seleccionados? Úsalo solo para avisos ya atendidos; se pueden recuperar luego desde la Papelera.") : ""}
${handoffs.length === 0 ? `<div class="empty">No hay avisos.</div>` : handoffs.map((h) => {
  // Misma limpieza ya aplicada a las alertas de Hoy (18/10/2026, "estas
  // fichas de pendiente organizalas bien"): el motivo a veces trae el
  // portal y un enlace wa.me incrustados como texto plano -- se separan
  // en su propia etiqueta/botón en vez de un título larguísimo con una
  // URL suelta dentro.
  const reasonRaw = h.reason ?? "Aviso";
  const waLink = extractWaLink(reasonRaw);
  const afterWaStrip = waLink ? reasonRaw.replace(waLink, "").replace(/\s*[:.]\s*$/, "").trim() : reasonRaw;
  const { portal, rest: reasonClean } = extractLeadingPortal(afterWaStrip);
  return `<div class="card ${h.reason_type === "reserva" ? "urgent" : h.urgency === "alta" ? "urgent" : "pending"}" style="position:relative"><div class="info">
${isAdmin ? simpleCheckbox("avisos-bulk", h.id) : ""}
<h3>${esc(reasonClean || "Aviso")}</h3>
<p><span class="tag ${h.reason_type === "reserva" || h.reason_type === "compra_inmediata" || h.urgency === "alta" ? "t-hot" : ""}">${h.reason_type === "reserva" ? "RESERVA 500€" : h.reason_type === "compra_inmediata" ? "Compra inmediata" : h.urgency === "alta" ? "Urgente" : "Normal"}</span> ${portal ? platformTag(portal) : ""}</p>
<p>Cliente: <b>${esc(contactLabel(h.lead_phone, h.lead_name))}${h.lead_name && h.lead_phone && !isCochesNetRelay(h.lead_phone) ? ` (${esc(h.lead_phone)})` : ""}</b> · ${esc(fmtDate(h.created_at))}</p>${h.notes ? `<p>${esc(h.notes)}</p>` : ""}
<form method="post" action="/crm/avisos/${esc(h.id)}"><button class="btn ok" type="submit">Ya lo he atendido</button>${phoneLink(h.lead_phone)}${waLink ? waButton(waLink.replace("https://wa.me/", ""), "") : ""}${isAdmin ? `<button class="btn danger" type="submit" name="accion" value="eliminar" onclick="return confirm('¿Eliminar este aviso para siempre? Úsalo solo para pruebas, no para avisos reales ya atendidos.')">Eliminar</button>` : ""}</form>
</div></div>`;
}).join("")}
<h2>Correos para contestar (${mails.length})</h2>
${mails.length === 0 ? `<div class="empty">No hay correos por contestar.</div>` : mails.map((m) => `<div class="card ${m.outcome === "pendiente_gestion_portal" ? "urgent" : "pending"}"><div class="info">
<h3>${esc(m.subject || "(sin asunto)")}</h3>
<p>De: <b>${esc(m.from)}</b>${m.portal ? ` · <span class="tag">${esc(m.portal)}</span>` : ""} · ${esc(fmtDate(m.created_at))}</p>
${m.outcome === "pendiente_gestion_portal" ? `<p><b>Hay que responder desde ${esc(m.portal ?? "el portal")}, no por correo</b> -- este correo es solo un aviso, al comprador no le llega una respuesta aquí.</p>` : ""}
${m.outcome === "tope_diario_alcanzado" ? `<p><b>Hoy ya se alcanzó el tope de correos automáticos</b> -- por seguridad (para que Gmail no bloquee la cuenta por enviar de más), esta respuesta no se mandó sola. Revísala y envíala tú.</p>` : ""}
${m.outcome === "pendiente_whatsapp_manual" ? `<p><b>Este cliente pidió que le escriban solo por WhatsApp</b> -- el envío automático falló (todavía no hay un número real conectado y verificado), hace falta escribirle a mano.${extractWaLink(m.draft_note) ? ` ${waButton(extractWaLink(m.draft_note)!.replace("https://wa.me/", ""), "")}` : ""}</p>` : ""}
<div class="box" style="background:#f7f8fa;white-space:pre-wrap;font-size:19px">${esc(m.text)}</div>
${m.draft_note ? `<p style="margin-top:10px"><b>${m.outcome === "tope_diario_alcanzado" ? "Respuesta ya redactada" : `Borrador para copiar en ${esc(m.portal ?? "el portal")}`}:</b></p><div class="box" style="background:#eef6ec;white-space:pre-wrap;font-size:19px">${esc(m.draft_note)}</div>` : ""}
<form method="post" action="/crm/correos/${esc(m.id)}">
<label>Tu respuesta (si no escribes nada, no se envía nada)</label>
<textarea name="respuesta" rows="4"></textarea>
<button class="btn ok" type="submit" name="accion" value="responder">Enviar mi respuesta</button>
<button class="btn light" type="submit" name="accion" value="ya">No hace falta</button>
</form></div></div>`).join("")}`;
  res.type("html").send(page("Pendientes", me(res), body, msgOf(req)));
});

crm.post("/avisos/:id", (req, res) => {
  const accion = String(req.body.accion ?? "atendido");
  const items = list<Handoff>("handoffs");
  const h = items.find((x) => x.id === req.params.id);
  if (!h) return back(res, "/crm/pendientes", "No encuentro ese aviso");
  if (accion === "eliminar") {
    if (me(res).role !== "admin") return back(res, "/crm/pendientes", "Solo el administrador puede eliminar avisos");
    moveToTrash("handoffs", h, `Aviso: ${h.reason ?? "sin motivo"} (${h.lead_name ?? h.lead_phone ?? "sin contacto"})`, me(res).email);
    save("handoffs", items.filter((x) => x.id !== h.id));
    return back(res, "/crm/pendientes", "Aviso movido a la papelera");
  }
  h.status = "done";
  save("handoffs", items);
  back(res, "/crm/pendientes", "Aviso atendido");
});

// Borrado masivo de avisos (18/10/2026, "el borrar masivo lo quiero en
// todas las secciones") -- solo administrador, papelera recuperable.
crm.post("/avisos-masivo", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm/pendientes", "Solo el administrador puede eliminar avisos");
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  if (ids.length === 0) return back(res, "/crm/pendientes", "No seleccionaste ningún aviso");
  const items = list<Handoff>("handoffs");
  const targets = items.filter((h) => ids.includes(h.id));
  for (const h of targets) moveToTrash("handoffs", h, `Aviso: ${h.reason ?? "sin motivo"} (${h.lead_name ?? h.lead_phone ?? "sin contacto"})`, me(res).email);
  save("handoffs", items.filter((h) => !ids.includes(h.id)));
  back(res, "/crm/pendientes", targets.length === 0 ? "No había nada que hacer" : `${targets.length} aviso(s) movido(s) a la papelera`);
});

crm.post("/correos/:id", async (req, res) => {
  const accion = String(req.body.accion ?? "");
  const inbox = list<InboxMail>("email_inbox");
  const m = inbox.find((x) => x.id === req.params.id);
  if (!m) return back(res, "/crm/pendientes", "No encuentro ese correo");
  // Acciones nuevas del módulo mensajes/clientes (18/10/2026), solo
  // alcanzables desde /crm/correos -- Pendientes no tiene botones para
  // ellas, así que no cambia nada de lo que ya funcionaba ahí.
  if (accion === "marcar_leido") {
    m.read = true;
    save("email_inbox", inbox);
    return back(res, "/crm/correos", "Marcado como leído");
  }
  if (accion === "archivar") {
    m.archived = true;
    save("email_inbox", inbox);
    return back(res, "/crm/correos", "Correo archivado");
  }
  if (accion === "ya") {
    // Responde una persona, no la IA -- se registra así (Fase 4 del encargo:
    // "Respondido por IA" vs "Respondido por equipo").
    m.answered = true;
    m.answered_by = "equipo";
    save("email_inbox", inbox);
    return back(res, "/crm/pendientes", "Hecho");
  }
  const text = String(req.body.respuesta ?? "").trim();
  if (!text) return back(res, "/crm/pendientes", "Escribe la respuesta antes de enviarla");
  const subject = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject || "su consulta"}`;
  const thread = m.thread_id && m.in_reply_to ? { threadId: m.thread_id, inReplyTo: m.in_reply_to } : undefined;
  const delivery = await deliverEmail(m.from, subject, `${text}\n\nAutomóviles Lucero`, thread);
  m.answered = true;
  m.answered_by = "equipo";
  save("email_inbox", inbox);
  if (delivery.status === "sent") back(res, "/crm/pendientes", "Respuesta enviada");
  else if (delivery.status === "queued") back(res, "/crm/pendientes", "Respuesta guardada: se enviará cuando Gmail esté conectado");
  else back(res, "/crm/pendientes", "No se pudo enviar. Inténtalo otra vez");
});

crm.get("/avisos", (_req, res) => res.redirect("/crm/pendientes"));

// ---------- Mensajes: filtros, estados y acciones masivas compartidas ----------
// Módulo CRM mensajes/clientes (18/10/2026). Las tres bandejas (Correos,
// WhatsApp, Llamadas) comparten exactamente la misma idea de estado y las
// mismas acciones masivas -- este bloque es el único sitio donde vive esa
// lógica, para que las tres se comporten igual y no haya que mantenerla
// tres veces.
type MsgFilter = "todos" | "pendientes" | "respondidos" | "sin_leer" | "archivados";
const MSG_FILTERS: MsgFilter[] = ["todos", "pendientes", "respondidos", "sin_leer", "archivados"];
function msgFilterFromQuery(req: express.Request): MsgFilter {
  const f = String(req.query.f ?? "todos");
  return (MSG_FILTERS as string[]).includes(f) ? (f as MsgFilter) : "todos";
}
// "Pendiente"/"Respondido" no aplica a llamadas (no se puede "contestar" una
// llamada ya ocurrida) -- para esas, hasAnswered=false y el filtro
// correspondiente simplemente no se ofrece en su barra.
function matchesMsgFilter(f: MsgFilter, m: { answered?: boolean; read?: boolean; archived?: boolean }): boolean {
  if (f === "archivados") return Boolean(m.archived);
  if (m.archived) return false;
  if (f === "pendientes") return !m.answered;
  if (f === "respondidos") return Boolean(m.answered);
  if (f === "sin_leer") return !m.read;
  return true;
}
function answeredTag(m: { answered?: boolean; answered_by?: "ia" | "equipo" }): string {
  if (!m.answered) return `<span class="tag" style="background:#fff3cd;color:#7a5b00">Pendiente de respuesta</span>`;
  // No inventar quién respondió: antes de este módulo (18/10/2026) solo el
  // equipo podía marcar un correo como respondido (la IA nunca lo hacía),
  // así que un registro antiguo sin `answered_by` corresponde a una persona
  // -- pero por si acaso no se puede asegurar al 100%, si falta el dato se
  // muestra neutral en vez de adivinar.
  if (m.answered_by === "ia") return `<span class="tag estado-ia">Respondido por IA</span>`;
  if (m.answered_by === "equipo") return `<span class="tag estado-equipo">Respondido por equipo</span>`;
  return `<span class="tag">Respondido</span>`;
}
function msgRowClass(m: { answered?: boolean; read?: boolean }, hasAnswered: boolean): string {
  const estado = hasAnswered ? (m.answered ? "msg-answered" : "msg-unanswered") : "";
  const leido = m.read ? "msg-read" : "msg-unread";
  return `card ${estado} ${leido}`.trim();
}
function filterPills(base: string, f: MsgFilter, q: string, withAnswered: boolean): string {
  const labels: [MsgFilter, string][] = withAnswered
    ? [["todos", "Todos"], ["pendientes", "Pendientes"], ["respondidos", "Respondidos"], ["sin_leer", "Sin leer"], ["archivados", "Archivados"]]
    : [["todos", "Todas"], ["sin_leer", "Sin leer"], ["archivados", "Archivadas"]];
  const qs = q ? `&q=${encodeURIComponent(q)}` : "";
  return `<div class="filterbar">${labels.map(([k, label]) => `<a class="tag" href="${base}?f=${k}${qs}" style="${f === k ? "outline:4px solid #1d2b44" : ""}">${esc(label)}</a>`).join("")}</div>`;
}
function searchBox(base: string, f: MsgFilter, q: string, placeholder: string): string {
  return `<form class="search" method="get" action="${base}">${f !== "todos" ? `<input type="hidden" name="f" value="${esc(f)}">` : ""}<input name="q" placeholder="${esc(placeholder)}" value="${esc(q)}"><button class="btn" type="submit">Buscar</button>${q ? `<a class="btn light" href="${base}${f !== "todos" ? `?f=${f}` : ""}">Quitar filtro</a>` : ""}</form>`;
}
function bulkBar(base: string, f: MsgFilter, q: string, count: number, withAnswered: boolean): string {
  const scope = f === "todos" ? "todos los mensajes de esta vista" : f === "sin_leer" ? "los mensajes sin leer de esta vista" : f === "archivados" ? "los mensajes archivados de esta vista" : f === "pendientes" ? "los mensajes pendientes de esta vista" : "los mensajes respondidos de esta vista";
  return `<form id="${base}-bulk" method="post" action="${base}-masivo"><input type="hidden" name="f" value="${esc(f)}"><input type="hidden" name="q" value="${esc(q)}"></form>
<div class="bulkbar">
<label><input class="msgsel" type="checkbox" onchange="toggleAllMsgs(this,'ids')"> Seleccionar todos (${count})</label>
<button class="btn light" type="submit" form="${base}-bulk" name="accion" value="marcar_leido">Marcar leído</button>
<button class="btn light" type="submit" form="${base}-bulk" name="accion" value="archivar">Archivar</button>
<button class="btn danger" type="submit" form="${base}-bulk" name="accion" value="eliminar_seleccionados" onclick="return confirm('¿Eliminar los mensajes seleccionados? Se pueden recuperar luego desde la Papelera.')">Eliminar seleccionados</button>
<button class="btn danger" type="submit" form="${base}-bulk" name="accion" value="eliminar_todos" onclick="return confirm('¿Eliminar ${scope.replace(/'/g, "")} (' + document.querySelectorAll(\`input[type=checkbox][name=ids]\`).length + ' en pantalla)? Se pueden recuperar luego desde la Papelera.')">Eliminar todos los de esta vista</button>
</div>`;
}
function msgCheckbox(base: string, id: string): string {
  return `<input class="msgsel" type="checkbox" name="ids" value="${esc(id)}" form="${base}-bulk" style="position:absolute;top:18px;right:20px">`;
}
// Versión simple del bulkbar para secciones sin estados de leído/archivado
// (Visitas, Reservas, Avisos, Clientes) -- a petición real, 18/10/2026:
// "el borrar masivo lo quiero en todas las secciones". Solo seleccionar
// todos + eliminar seleccionados (papelera recuperable), nada de filtros.
function simpleBulkBar(formId: string, action: string, count: number, confirmMsg: string): string {
  return `<form id="${formId}" method="post" action="${action}"></form>
<div class="bulkbar">
<label><input class="msgsel" type="checkbox" onchange="toggleAllMsgs(this,'ids')"> Seleccionar todos (${count})</label>
<button class="btn danger" type="submit" form="${formId}" name="accion" value="eliminar_seleccionados" onclick="return confirm('${esc(confirmMsg).replace(/'/g, "\\'")}')">Eliminar seleccionados</button>
</div>`;
}
function simpleCheckbox(formId: string, id: string): string {
  return `<input class="msgsel" type="checkbox" name="ids" value="${esc(id)}" form="${formId}" style="position:absolute;top:18px;right:20px">`;
}
// Ejecuta la acción masiva sobre una colección genérica -- compartido por
// Correos/WhatsApp/Llamadas. `label` sirve para la Papelera.
function runBulkAction<T extends { id: string; read?: boolean; archived?: boolean; answered?: boolean }>(
  collection: string,
  accion: string,
  ids: string[],
  filterScope: { f: MsgFilter; q: string; search: (m: T) => boolean },
  labelOf: (m: T) => string,
  deletedBy: string,
): number {
  const items = list<T>(collection);
  const targets = accion === "eliminar_todos" ? items.filter((m) => matchesMsgFilter(filterScope.f, m) && filterScope.search(m)) : items.filter((m) => ids.includes(m.id));
  if (targets.length === 0) return 0;
  const targetIds = new Set(targets.map((t) => t.id));
  if (accion === "marcar_leido") {
    for (const m of items) if (targetIds.has(m.id)) m.read = true;
    save(collection, items);
  } else if (accion === "archivar") {
    for (const m of items) if (targetIds.has(m.id)) m.archived = true;
    save(collection, items);
  } else if (accion === "eliminar_seleccionados" || accion === "eliminar_todos") {
    for (const m of targets) moveToTrash(collection, m, labelOf(m), deletedBy);
    save(collection, items.filter((m) => !targetIds.has(m.id)));
  }
  return targets.length;
}
function searchMatches(q: string, ...fields: (string | null | undefined)[]): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  return fields.some((f) => (f ?? "").toLowerCase().includes(needle));
}

// ---------- Correos (bandeja completa) ----------
crm.get("/correos", (req, res) => {
  const f = msgFilterFromQuery(req);
  const q = String(req.query.q ?? "").trim();
  const all = list<InboxMail>("email_inbox").filter((m) => m.outcome !== "automated_no_reply");
  const items = all.filter((m) => matchesMsgFilter(f, m) && searchMatches(q, m.from, m.subject, m.portal, m.text)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const body = `<h1>Correos</h1>
<p class="sub">Todo lo que ha llegado por correo: lo que ya contestó Miguel solo y lo que espera respuesta humana.</p>
${filterPills("/crm/correos", f, q, true)}
${searchBox("/crm/correos", f, q, "Buscar por remitente, asunto o portal")}
${items.length > 0 ? bulkBar("/crm/correos", f, q, items.length, true) : ""}
${items.length === 0 ? `<div class="empty">No hay correos en esta vista.</div>` : items.map((m) => `<div class="${msgRowClass(m, true)}" style="position:relative"><div class="info">
${msgCheckbox("/crm/correos", m.id)}
<h3>${esc(m.subject || "(sin asunto)")}</h3>
<p class="meta">De: <b>${esc(m.from)}</b> · ${platformTag(m.portal)} · ${esc(fmtDate(m.created_at))}</p>
<p>${answeredTag(m)}${m.archived ? ` <span class="tag">Archivado</span>` : ""}</p>
${m.outcome === "pendiente_gestion_portal" ? `<p><b>Hay que responder desde ${esc(platformLabel(m.portal))}, no por correo</b> -- este correo es solo un aviso, al comprador no le llega una respuesta aquí.</p>` : ""}
${m.outcome === "tope_diario_alcanzado" ? `<p><b>Hoy ya se alcanzó el tope de correos automáticos</b> -- por seguridad (para que Gmail no bloquee la cuenta por enviar de más), esta respuesta no se mandó sola. Revísala y envíala tú.</p>` : ""}
${m.outcome === "pendiente_whatsapp_manual" ? `<p><b>Este cliente pidió que le escriban solo por WhatsApp</b> -- el envío automático falló (todavía no hay un número real conectado y verificado), hace falta escribirle a mano.${extractWaLink(m.draft_note) ? ` ${waButton(extractWaLink(m.draft_note)!.replace("https://wa.me/", ""), "")}` : ""}</p>` : ""}
<div class="box" style="background:#f7f8fa;white-space:pre-wrap;font-size:19px">${esc(m.text)}</div>
${m.draft_note ? `<p style="margin-top:10px"><b>${m.outcome === "tope_diario_alcanzado" ? "Respuesta ya redactada" : `Borrador para copiar en ${esc(platformLabel(m.portal))}`}:</b></p><div class="box" style="background:#eef6ec;white-space:pre-wrap;font-size:19px">${esc(m.draft_note)}</div>` : ""}
<form method="post" action="/crm/correos/${esc(m.id)}">
${!m.answered ? `<label>Tu respuesta (si no escribes nada, no se envía nada)</label><textarea name="respuesta" rows="4"></textarea><button class="btn ok" type="submit" name="accion" value="responder">Enviar mi respuesta</button><button class="btn light" type="submit" name="accion" value="ya">No hace falta</button>` : ""}
${!m.read ? `<button class="btn light" type="submit" name="accion" value="marcar_leido">Marcar leído</button>` : ""}
${!m.archived ? `<button class="btn light" type="submit" name="accion" value="archivar">Archivar</button>` : ""}
</form></div></div>`).join("")}`;
  res.type("html").send(page("Correos", me(res), body, msgOf(req)));
});

crm.post("/correos-masivo", (req, res) => {
  const f = msgFilterFromQuery(req);
  const q = String(req.body.q ?? "").trim();
  const accion = String(req.body.accion ?? "");
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  const n = runBulkAction<InboxMail>(
    "email_inbox",
    accion,
    ids,
    { f, q, search: (m) => searchMatches(q, m.from, m.subject, m.portal, m.text) },
    (m) => `Correo: ${m.subject || "(sin asunto)"} (${m.from})`,
    me(res).email,
  );
  back(res, "/crm/correos", n === 0 ? "No había nada que hacer" : accion.startsWith("eliminar") ? `${n} correo(s) movido(s) a la papelera` : accion === "archivar" ? `${n} correo(s) archivado(s)` : `${n} correo(s) marcado(s) como leído`);
});

// ---------- WhatsApp (bandeja completa -- solo lectura, sin responder) ----------
// A petición expresa: "preparar la interfaz y la lógica, pero no activar el
// envío hasta verificar la conexión prevista para mañana". Por eso esta
// bandeja NO tiene ningún formulario de respuesta -- solo leer, marcar
// leído, archivar y eliminar, igual que las demás.
crm.get("/whatsapp", (req, res) => {
  const f = msgFilterFromQuery(req);
  const q = String(req.query.q ?? "").trim();
  const all = list<WhatsappMessage>("whatsapp_inbox");
  const items = all.filter((m) => matchesMsgFilter(f, m) && searchMatches(q, m.phone, m.text)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const body = `<h1>WhatsApp</h1>
<p class="sub">Mensajes entrantes por WhatsApp. El envío automático sigue desactivado hasta verificar la conexión -- aquí solo se lee y se ordena.</p>
${filterPills("/crm/whatsapp", f, q, true)}
${searchBox("/crm/whatsapp", f, q, "Buscar por número de teléfono")}
${items.length > 0 ? bulkBar("/crm/whatsapp", f, q, items.length, true) : ""}
${items.length === 0 ? `<div class="empty">No hay mensajes de WhatsApp en esta vista.</div>` : items.map((m) => `<div class="${msgRowClass(m, true)}" style="position:relative"><div class="info">
${msgCheckbox("/crm/whatsapp", m.id)}
<h3>${esc(m.phone)}</h3>
<p class="meta"><span class="tag">WhatsApp directo</span> · ${esc(fmtDate(m.created_at))}</p>
<p>${answeredTag(m)}${m.answered && m.delivered === false ? ` <span class="tag" style="background:#fde2e1;color:#7a1c17">No entregado (WhatsApp no conectado)</span>` : ""}${m.archived ? ` <span class="tag">Archivado</span>` : ""}</p>
<div class="box" style="background:#f7f8fa;white-space:pre-wrap;font-size:19px">${esc(m.text)}</div>
${m.reply_text ? `<p style="margin-top:10px"><b>Respuesta de la IA:</b></p><div class="box" style="background:#eef6ec;white-space:pre-wrap;font-size:19px">${esc(m.reply_text)}</div>` : ""}
<form method="post" action="/crm/whatsapp/${esc(m.id)}">${phoneLink(m.phone)}
${!m.read ? `<button class="btn light" type="submit" name="accion" value="marcar_leido">Marcar leído</button>` : ""}
${!m.archived ? `<button class="btn light" type="submit" name="accion" value="archivar">Archivar</button>` : ""}
${confirmButton("Eliminar", "eliminar", "danger", "¿Eliminar este mensaje? Se puede recuperar luego desde la Papelera.")}
</form></div></div>`).join("")}`;
  res.type("html").send(page("WhatsApp", me(res), body, msgOf(req)));
});

crm.post("/whatsapp/:id", (req, res) => {
  const accion = String(req.body.accion ?? "");
  const items = list<WhatsappMessage>("whatsapp_inbox");
  const m = items.find((x) => x.id === req.params.id);
  if (!m) return back(res, "/crm/whatsapp", "No encuentro ese mensaje");
  if (accion === "eliminar") {
    moveToTrash("whatsapp_inbox", m, `WhatsApp: ${m.phone}`, me(res).email);
    save("whatsapp_inbox", items.filter((x) => x.id !== m.id));
    return back(res, "/crm/whatsapp", "Mensaje movido a la papelera");
  }
  if (accion === "marcar_leido") m.read = true;
  else if (accion === "archivar") m.archived = true;
  save("whatsapp_inbox", items);
  back(res, "/crm/whatsapp", "Hecho");
});

crm.post("/whatsapp-masivo", (req, res) => {
  const f = msgFilterFromQuery(req);
  const q = String(req.body.q ?? "").trim();
  const accion = String(req.body.accion ?? "");
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  const n = runBulkAction<WhatsappMessage>(
    "whatsapp_inbox",
    accion,
    ids,
    { f, q, search: (m) => searchMatches(q, m.phone, m.text) },
    (m) => `WhatsApp: ${m.phone}`,
    me(res).email,
  );
  back(res, "/crm/whatsapp", n === 0 ? "No había nada que hacer" : accion.startsWith("eliminar") ? `${n} mensaje(s) movido(s) a la papelera` : accion === "archivar" ? `${n} mensaje(s) archivado(s)` : `${n} mensaje(s) marcado(s) como leído`);
});

// ---------- Llamadas (bandeja completa -- solo lectura, sin "respondido") ----------
crm.get("/llamadas", (req, res) => {
  const f = msgFilterFromQuery(req);
  const q = String(req.query.q ?? "").trim();
  const all = list<CallAnalysis>("call_analyses");
  const items = all.filter((m) => matchesMsgFilter(f, m) && searchMatches(q, m.from_number, m.summary)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const dur = (ms: number | null | undefined) => (ms == null ? "—" : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`);
  const body = `<h1>Llamadas</h1>
<p class="sub">Llamadas atendidas por Miguel, con el resultado del análisis automático.</p>
${filterPills("/crm/llamadas", f, q, false)}
${searchBox("/crm/llamadas", f, q, "Buscar por número de teléfono")}
${items.length > 0 ? bulkBar("/crm/llamadas", f, q, items.length, false) : ""}
${items.length === 0 ? `<div class="empty">No hay llamadas en esta vista.</div>` : items.map((m) => `<div class="card ${m.needs_review ? "urgent" : ""} ${m.read ? "msg-read" : "msg-unread"}" style="position:relative"><div class="info">
${msgCheckbox("/crm/llamadas", m.id)}
<h3>${esc(m.from_number || "Número desconocido")}</h3>
<p class="meta"><span class="tag">${esc(m.channel === "VOICE" ? "Voz" : "Chat")}</span> · Duración ${dur(m.duration_ms)} · ${esc(fmtDate(m.created_at))}</p>
<p>${m.call_successful === false ? `<span class="tag" style="background:#fde2e1;color:#7a1c17">Con problemas</span>` : m.call_successful === true ? `<span class="tag" style="background:#e3f6e8;color:#1d6b3d">Correcta</span>` : `<span class="tag">Sin valorar</span>`}${m.needs_review ? ` <span class="tag" style="background:#fde2e1;color:#7a1c17">Revisar</span>` : ""}${m.archived ? ` <span class="tag">Archivada</span>` : ""}</p>
${m.summary ? `<div class="box" style="background:#f7f8fa;white-space:pre-wrap;font-size:19px">${esc(m.summary)}</div>` : `<p class="empty" style="padding:10px 0">Sin resumen disponible.</p>`}
<form method="post" action="/crm/llamadas/${esc(m.id)}">${phoneLink(m.from_number)}
${!m.read ? `<button class="btn light" type="submit" name="accion" value="marcar_leido">Marcar leído</button>` : ""}
${!m.archived ? `<button class="btn light" type="submit" name="accion" value="archivar">Archivar</button>` : ""}
${confirmButton("Eliminar", "eliminar", "danger", "¿Eliminar esta llamada? Se puede recuperar luego desde la Papelera.")}
</form></div></div>`).join("")}`;
  res.type("html").send(page("Llamadas", me(res), body, msgOf(req)));
});

crm.post("/llamadas/:id", (req, res) => {
  const accion = String(req.body.accion ?? "");
  const items = list<CallAnalysis>("call_analyses");
  const m = items.find((x) => x.id === req.params.id);
  if (!m) return back(res, "/crm/llamadas", "No encuentro esa llamada");
  if (accion === "eliminar") {
    moveToTrash("call_analyses", m, `Llamada: ${m.from_number ?? "sin número"}`, me(res).email);
    save("call_analyses", items.filter((x) => x.id !== m.id));
    return back(res, "/crm/llamadas", "Llamada movida a la papelera");
  }
  if (accion === "marcar_leido") m.read = true;
  else if (accion === "archivar") m.archived = true;
  save("call_analyses", items);
  back(res, "/crm/llamadas", "Hecho");
});

crm.post("/llamadas-masivo", (req, res) => {
  const f = msgFilterFromQuery(req);
  const q = String(req.body.q ?? "").trim();
  const accion = String(req.body.accion ?? "");
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  const n = runBulkAction<CallAnalysis>(
    "call_analyses",
    accion,
    ids,
    { f, q, search: (m) => searchMatches(q, m.from_number, m.summary) },
    (m) => `Llamada: ${m.from_number ?? "sin número"}`,
    me(res).email,
  );
  back(res, "/crm/llamadas", n === 0 ? "No había nada que hacer" : accion.startsWith("eliminar") ? `${n} llamada(s) movida(s) a la papelera` : accion === "archivar" ? `${n} llamada(s) archivada(s)` : `${n} llamada(s) marcada(s) como leída`);
});

// ---------- Clientes (solo lectura de la segmentación de Miguel) ----------
crm.get("/clientes", (req, res) => {
  autoArchiveColdLeads();
  const t = typeof req.query.t === "string" && (TEMP[req.query.t] || req.query.t === "archivados") ? req.query.t : "todos";
  const all = list<Lead>("leads");
  const archivedCount = all.filter((l) => l.archived).length;
  const leads = all
    .filter((l) => (t === "archivados" ? l.archived : !l.archived && (t === "todos" || l.temperature === t)))
    .sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at));
  const pill = (k: string, label: string, cls = "") => `<a href="/crm/clientes?t=${k}" class="tag ${cls}" style="text-decoration:none;padding:10px 16px;${t === k ? "outline:4px solid #1d2b44" : ""}">${label}</a>`;
  const isAdmin = me(res).role === "admin";
  const bulk = isAdmin && leads.length > 0
    ? `<form id="clientes-bulk" method="post" action="/crm/clientes-masivo"><input type="hidden" name="t" value="${esc(t)}"></form>
<div class="bulkbar">
<label><input class="msgsel" type="checkbox" onchange="toggleAllMsgs(this,'ids')"> Seleccionar todos (${leads.length})</label>
${t === "archivados"
  ? `<button class="btn ok" type="submit" form="clientes-bulk" name="accion" value="desarchivar_seleccionados">Desarchivar seleccionados</button>`
  : `<button class="btn light" type="submit" form="clientes-bulk" name="accion" value="archivar_seleccionados">Archivar seleccionados</button>`}
<button class="btn danger" type="submit" form="clientes-bulk" name="accion" value="eliminar_seleccionados" onclick="return confirm('¿Eliminar los clientes seleccionados? Se pueden recuperar luego desde la Papelera.')">Eliminar seleccionados</button>
</div>`
    : "";
  const body = `<h1>Clientes</h1>
<p class="sub">Miguel anota solo lo que quiere cada cliente. Tú solo lo lees y llamas si hace falta. Los clientes fríos sin contacto en ${LEAD_ARCHIVE_INACTIVE_DAYS} días se archivan solos -- nunca se borran, solo dejan de aparecer aquí.</p>
<div class="box"><h3 style="margin-top:0">Añadir un cliente a mano</h3>
<form method="post" action="/crm/clientes">
<div class="row"><div><label>Nombre</label><input name="nombre"></div>
<div><label>Teléfono</label><input name="telefono" required></div></div>
<label>Coche de interés</label><input name="vehicle_interest">
<button class="btn ok" type="submit">Añadir cliente</button></form></div>
<div class="legend">${pill("todos", "Todos")} ${pill("HOT", "Caliente", "t-hot")} ${pill("WARM", "Tibio", "t-warm")} ${pill("COLD", "Frío", "t-cold")} ${pill("archivados", `Archivados (${archivedCount})`)}</div>
${bulk}
${leads.length === 0 ? `<div class="empty">${t === "archivados" ? "No hay clientes archivados." : "Todavía no hay clientes en esta lista."}</div>` : leads.map((l) => leadCard(l, me(res))).join("")}`;
  res.type("html").send(page("Clientes", me(res), body, msgOf(req)));
});

crm.post("/clientes", (req, res) => {
  const telefono = String(req.body.telefono ?? "").trim();
  if (!telefono) return back(res, "/crm/clientes", "Escribe el teléfono del cliente");
  const leads = list<Lead>("leads");
  if (leads.some((l) => l.phone === telefono)) return back(res, "/crm/clientes", "Ya existe un cliente con ese teléfono");
  leads.push({
    id: crypto.randomUUID(),
    phone: telefono,
    name: String(req.body.nombre ?? "").trim() || null,
    notes: null,
    channel: "MANUAL",
    origin: "MANUAL",
    vehicle_interest: String(req.body.vehicle_interest ?? "").trim() || null,
    temperature: "COLD",
    followup_count: 0,
    do_not_contact: false,
    created_at: now(),
  });
  save("leads", leads);
  back(res, "/crm/clientes", "Cliente añadido");
});

crm.get("/clientes/:id", (req, res) => {
  const lead = list<Lead>("leads").find((l) => l.id === req.params.id);
  if (!lead) return back(res, "/crm/clientes", "No encuentro ese cliente");
  const key = lead.phone ?? "";
  const appts = list<Appointment>("appointments").filter((a) => a.lead_phone === key);
  const resv = list<Reservation>("reservations").filter((r) => r.lead_phone === key);
  const summaries = list<ConversationSummary>("conversation_summaries")
    .filter((c) => c.phone === key)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const t = TEMP[lead.temperature] ?? TEMP.COLD;
  const body = `<p><a class="link" href="/crm/clientes">← Volver a clientes</a></p>
<h1>${esc(lead.name || lead.phone || "Cliente")}</h1>
<p><span class="tag ${t.cls}">${esc(t.label)}</span></p>
<div class="box"><p><b>Lo que quiere:</b> ${esc(situation(lead))}</p>
<p><b>Contacto:</b> ${esc(lead.phone ?? "—")}</p>
<p><b>Visitas:</b> ${appts.length === 0 ? "ninguna" : appts.map((a) => `${esc(a.requested_date ?? "")} ${esc(a.requested_time ?? "")} (${esc(APPOINTMENT_TEXT[a.status] ?? a.status)})`).join(" · ")}</p>
<p><b>Reservas:</b> ${resv.length === 0 ? "ninguna" : resv.map((r) => `${esc(vehicleName(r.vehicle_id))}: ${esc(RESERVATION_TEXT[r.status] ?? r.status)}`).join(" · ")}</p>
${phoneLink(lead.phone)}</div>
${summaries.length > 0 ? `<div class="box"><h3 style="margin-top:0">Resumen de conversaciones</h3>${summaries.map((s) => `<p class="sub">${esc(fmtDate(s.created_at))}</p><p>${esc(s.summary)}</p>`).join("<hr>")}</div>` : ""}
<form class="box" method="post" action="/crm/clientes/${esc(lead.id)}">
<label>✏️ Nombre</label><input name="nombre" value="${esc(lead.name ?? "")}">
<label>✏️ Coche de interés</label><input name="vehicle_interest" value="${esc(lead.vehicle_interest ?? "")}">
<label>Notas para el equipo</label><textarea name="notes" rows="3">${esc(lead.notes ?? "")}</textarea>
<button class="btn ok" type="submit" name="accion" value="guardar">Guardar cambios</button>
${lead.do_not_contact ? button("Volver a escribirle", "reactivar", "light") : button("No volver a escribirle", "no_contactar", "danger")}
${me(res).role === "admin" ? confirmButton("Eliminar cliente", "eliminar", "danger", `¿Eliminar a "${lead.name || lead.phone || "este cliente"}"? Se puede restaurar luego desde la Papelera.`) : ""}
</form>`;
  res.type("html").send(page("Clientes", me(res), body, msgOf(req)));
});

crm.post("/clientes/:id", (req, res) => {
  const leads = list<Lead>("leads");
  const lead = leads.find((l) => l.id === req.params.id);
  if (!lead) return back(res, "/crm/clientes", "No encuentro ese cliente");
  const accion = String(req.body.accion ?? "guardar");
  if (accion === "eliminar") {
    if (me(res).role !== "admin") return back(res, `/crm/clientes/${lead.id}`, "Solo el administrador puede eliminar clientes");
    moveToTrash("leads", lead, `Cliente: ${lead.name || lead.phone || "sin nombre"}`, me(res).email);
    save("leads", leads.filter((x) => x.id !== lead.id));
    return back(res, "/crm/clientes", "Cliente movido a la papelera");
  }
  if (accion === "no_contactar") lead.do_not_contact = true;
  else if (accion === "reactivar") lead.do_not_contact = false;
  else if (accion === "archivar") lead.archived = true;
  else if (accion === "desarchivar") lead.archived = false;
  else {
    // El teléfono NO se edita aquí a propósito: es la clave con la que
    // casan las visitas y reservas de este cliente (situation(), la propia
    // ficha), y cambiarlo a mano las dejaría huérfanas sin que nadie se dé
    // cuenta.
    lead.name = String(req.body.nombre ?? "").trim() || null;
    lead.vehicle_interest = String(req.body.vehicle_interest ?? "").trim() || null;
    lead.notes = String(req.body.notes ?? "").trim() || null;
  }
  lead.updated_at = now();
  save("leads", leads);
  back(
    res,
    `/crm/clientes/${lead.id}`,
    accion === "guardar"
      ? "Cambios guardados"
      : accion === "no_contactar"
        ? "Listo: no le escribiremos más"
        : accion === "archivar"
          ? "Cliente archivado"
          : accion === "desarchivar"
            ? "Cliente desarchivado"
            : "Listo: sí se le puede escribir",
  );
});

// Eliminar varios clientes a la vez (a petición real, 18/10/2026: "la
// selección... donde selecciona cada tarjeta de cada cliente para poder
// borrar todo"). Mismo patrón que Correos/WhatsApp/Llamadas: papelera
// recuperable, nunca borrado directo -- y solo el administrador, igual que
// ya exigía el borrado individual de clientes.
crm.post("/clientes-masivo", (req, res) => {
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  if (ids.length === 0) return back(res, "/crm/clientes", "No seleccionaste ningún cliente");
  const accion = String(req.body.accion ?? "eliminar_seleccionados");

  if (accion === "archivar_seleccionados" || accion === "desarchivar_seleccionados") {
    const leads = list<Lead>("leads");
    const targets = leads.filter((l) => ids.includes(l.id));
    for (const l of targets) l.archived = accion === "archivar_seleccionados";
    save("leads", leads);
    const verbo = accion === "archivar_seleccionados" ? "archivado(s)" : "desarchivado(s)";
    return back(res, "/crm/clientes", targets.length === 0 ? "No había nada que hacer" : `${targets.length} cliente(s) ${verbo}`);
  }

  if (me(res).role !== "admin") return back(res, "/crm/clientes", "Solo el administrador puede eliminar clientes");
  const leads = list<Lead>("leads");
  const targets = leads.filter((l) => ids.includes(l.id));
  for (const l of targets) moveToTrash("leads", l, `Cliente: ${l.name || l.phone || "sin nombre"}`, me(res).email);
  save("leads", leads.filter((l) => !ids.includes(l.id)));
  back(res, "/crm/clientes", targets.length === 0 ? "No había nada que hacer" : `${targets.length} cliente(s) movido(s) a la papelera`);
});

// ---------- Coches ----------
const STATUS_TAG: Record<OfficialVehicleStatus, string> = {
  AVAILABLE: "background:#dcfce7;color:#166534",
  RESERVATION_PENDING: "background:#ffedd5;color:#9a3412",
  RESERVED: "background:#ffedd5;color:#9a3412",
  SOLD: "background:#e5e7eb;color:#374151",
};

crm.get("/coches", (req, res) => {
  const body = `<h1>Coches</h1>
<p class="sub">Toca un coche para cambiar si está disponible, reservado o vendido, y su precio.</p>
${currentVehicles().map((v) => {
  const st = getOfficialStatus(v.id);
  return `<div class="card"><div class="info"><h3>${esc(vehicleName(v.id))}</h3>
<p>${esc(v.km.toLocaleString("es-ES"))} km · ${esc(v.fuel)} · ${esc(v.power_cv)} CV</p>
<p><span class="tag" style="${STATUS_TAG[st]}">${esc(VEHICLE_TEXT[st])}</span><b>${esc(priceOf(v.id).toLocaleString("es-ES"))} €</b></p>
<a class="btn" href="/crm/coches/${esc(v.id)}">Cambiar</a></div></div>`;
}).join("")}`;
  res.type("html").send(page("Coches", me(res), body, msgOf(req)));
});

crm.get("/coches/:id", (req, res) => {
  const v = currentVehicles().find((x) => x.id === req.params.id);
  if (!v) return back(res, "/crm/coches", "No encuentro ese coche");
  const st = getOfficialStatus(v.id);
  const body = `<p><a class="link" href="/crm/coches">← Volver a coches</a></p>
<h1>${esc(vehicleName(v.id))}</h1>
<p>${esc(v.km.toLocaleString("es-ES"))} km · ${esc(v.fuel)} · ${esc(v.power_cv)} CV</p>
<p>${v.known_defects ? `Detalle conocido: <b>${esc(v.known_defects)}</b>` : "Sin averías conocidas"}</p>
<form class="box" method="post" action="/crm/coches/${esc(v.id)}">
<label>Estado</label><select name="estado">
${(["AVAILABLE", "RESERVED", "SOLD"] as OfficialVehicleStatus[]).map((s) => option(s, VEHICLE_TEXT[s], st)).join("")}</select>
<label>Precio (€)</label><input name="precio" type="number" value="${esc(priceOf(v.id))}" min="0">
<button class="btn ok" type="submit">Guardar</button></form>`;
  res.type("html").send(page("Coches", me(res), body, msgOf(req)));
});

crm.post("/coches/:id", (req, res) => {
  const v = vehiclesSeed.find((x) => x.id === req.params.id);
  if (!v) return back(res, "/crm/coches", "No encuentro ese coche");
  const estado = String(req.body.estado ?? "") as OfficialVehicleStatus;
  if (["AVAILABLE", "RESERVED", "SOLD"].includes(estado)) setOfficialStatus(v.id, estado, null);
  const precio = Number(req.body.precio);
  if (Number.isFinite(precio) && precio >= 0) {
    const overrides = list<VehicleOverride>("vehicle_overrides").filter((o) => o.vehicle_id !== v.id);
    overrides.push({ vehicle_id: v.id, price_eur: precio });
    save("vehicle_overrides", overrides);
  }
  back(res, `/crm/coches/${v.id}`, "Coche guardado");
});

// ---------- Equipo (solo administrador) ----------
crm.get("/equipo", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Esta sección es solo para el administrador");
  const users = listUsers();
  const body = `<h1>Equipo</h1>
<p class="sub">Aquí das de alta a Ramón y a José, y cambias las contraseñas.</p>
<div class="box"><h3 style="margin-top:0">Dar de alta a alguien</h3>
<form method="post" action="/crm/equipo">
<div class="row"><div><label>Nombre</label><input name="nombre" required></div>
<div><label>Correo para entrar</label><input name="correo" type="email" required></div>
<div><label>Contraseña (mínimo 8)</label>${pwInput('name="clave" minlength="8" required', 'pw-alta')}</div>
<div><label>Puede…</label><select name="rol"><option value="equipo">Ver y trabajar (no confirma pagos)</option><option value="comercial">Comercial: confirma pagos y ventas</option><option value="admin">Todo, incluido el equipo</option></select></div></div>
<button class="btn ok" type="submit">Dar de alta</button></form></div>
${users.map((u) => `<div class="card"><div class="info"><h3>${esc(u.name)}</h3><p>${esc(u.email)} · ${esc(ROLE_NAME[u.role] ?? u.role)}</p>
<form method="post" action="/crm/equipo/${esc(u.id)}">
<label>Nueva contraseña</label>${pwInput('name="clave" minlength="8"', `pw-${esc(u.id)}`)}
<button class="btn light" type="submit" name="accion" value="clave">Cambiar contraseña</button>
${u.id !== me(res).id ? button("Quitar el acceso", "quitar", "danger") : ""}
</form></div></div>`).join("")}`;
  res.type("html").send(page("Equipo", me(res), body, msgOf(req)));
});

crm.post("/equipo", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Solo el administrador");
  const email = String(req.body.correo ?? "").trim().toLowerCase();
  const clave = String(req.body.clave ?? "");
  if (clave.length < 8) return back(res, "/crm/equipo", "La contraseña tiene que tener al menos 8 caracteres");
  const users = listUsers();
  if (users.some((u) => u.email === email)) return back(res, "/crm/equipo", "Ese correo ya tiene acceso");
  users.push({
    id: crypto.randomUUID(),
    name: String(req.body.nombre ?? "").trim(),
    email,
    password_hash: hashPassword(clave),
    role: req.body.rol === "admin" ? "admin" : req.body.rol === "comercial" ? "comercial" : "equipo",
    created_at: now(),
  });
  saveUsers(users);
  back(res, "/crm/equipo", "Persona dada de alta");
});

crm.post("/equipo/:id", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Solo el administrador");
  const users = listUsers();
  const u = users.find((x) => x.id === req.params.id);
  if (!u) return back(res, "/crm/equipo", "No encuentro a esa persona");
  if (String(req.body.accion) === "quitar") {
    if (u.id === me(res).id) return back(res, "/crm/equipo", "No puedes quitarte el acceso a ti mismo");
    saveUsers(users.filter((x) => x.id !== u.id));
    return back(res, "/crm/equipo", "Acceso quitado");
  }
  const clave = String(req.body.clave ?? "");
  if (clave.length < 8) return back(res, "/crm/equipo", "La contraseña tiene que tener al menos 8 caracteres");
  u.password_hash = hashPassword(clave);
  saveUsers(users);
  back(res, "/crm/equipo", "Contraseña cambiada");
});

// ---------- Integraciones: Google (solo administrador) ----------
const GOOGLE_SCOPE_NAMES: Record<string, string> = {
  "https://www.googleapis.com/auth/gmail.send": "Enviar correo",
  "https://www.googleapis.com/auth/gmail.readonly": "Leer correo",
  "https://www.googleapis.com/auth/calendar": "Calendario completo",
};
type GoogleTest = { id: string; event_id: string; link: string; created_at: string };

// Hora local de Madrid de mañana, sin desfase: Google recibe la zona horaria aparte.
function tomorrowAt(hour: number, minutes: number): string {
  const day = new Date(Date.now() + 24 * 3600 * 1000).toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
  return `${day}T${String(hour).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
}
function onlyAdmin(res: express.Response): boolean {
  return me(res).role === "admin";
}

crm.get("/integraciones", (req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Esta sección es solo para el administrador");
  const st = googleStatus();
  const missing = googleConfigMissing();
  const test = readCollection<GoogleTest>("google_test_events")[0];
  const scopes = (st.scopes ?? "").split(" ").filter(Boolean);
  const scopesHtml = scopes.length
    ? `<ul>${scopes.map((s) => `<li>${esc(GOOGLE_SCOPE_NAMES[s] ?? s)}</li>`).join("")}</ul>`
    : "<p>Todavía no hay permisos concedidos.</p>";
  const config = missing.length
    ? `<div class="msg" style="background:#fdecea;border-color:#c62828">Falta en EasyPanel: ${esc(missing.join(", "))}. Añádelo y pulsa Implementar.</div>`
    : "";
  const connectButton = st.connected
    ? `<a class="btn light" href="/crm/integraciones/google/conectar">Reconectar Google</a>`
    : `<a class="btn ok" href="/crm/integraciones/google/conectar">Conectar Google</a>`;
  const disconnectButton = st.connected
    ? `<form method="post" action="/crm/integraciones/google/desconectar" style="display:inline"><button class="btn danger" type="submit" onclick="return confirm('¿Desconectar Google? Miguel dejará de enviar correos y crear citas.')">Desconectar Google</button></form>`
    : "";
  const tests = st.connected
    ? `<div class="box"><h3 style="margin-top:0">Pruebas</h3>
<form method="post" action="/crm/integraciones/google/probar-gmail" style="display:inline"><button class="btn light" type="submit">Probar Gmail</button></form>
<form method="post" action="/crm/integraciones/google/probar-calendar" style="display:inline"><button class="btn light" type="submit">Probar Calendar</button></form>
${test ? `<p>Evento de prueba creado: <a href="${esc(test.link)}" target="_blank" rel="noopener">abrir en Google Calendar</a></p>
<form method="post" action="/crm/integraciones/google/borrar-prueba" style="display:inline"><button class="btn danger" type="submit">Borrar evento de prueba</button></form>` : ""}
</div>`
    : "";
  const emailSendOn = isEmailAutoSendEnabled();
  const emailModeBox = `<div class="box"><h3 style="margin-top:0">Correo -- envío automático</h3>
<p>Estado: <strong>${emailSendOn ? "Activado -- envía respuestas reales" : "Modo de prueba -- clasifica y redacta, pero no envía nada"}</strong></p>
<form method="post" action="/crm/integraciones/correo/${emailSendOn ? "desactivar-envio" : "activar-envio"}" style="display:inline">
<button class="btn ${emailSendOn ? "danger" : "ok"}" type="submit" onclick="return confirm('${emailSendOn ? "¿Pasar a modo de prueba? El agente seguirá leyendo y redactando respuestas, pero ninguna saldrá de verdad -- se quedan en Pendientes para revisar." : "¿Activar el envío automático? Las respuestas que redacte el agente empezarán a salir de verdad."}')">${emailSendOn ? "Pasar a modo de prueba" : "Activar envío automático"}</button>
</form>
<p class="sub">En modo de prueba, cada correo se clasifica y se redacta igual que siempre -- solo cambia que la respuesta se queda como nota en Pendientes en vez de enviarse. Útil para probar cambios sin arriesgar un envío real.</p>
</div>`;
  const voiceOn = isVoiceAgentEnabled();
  const recentCalls = readCollection<{
    channel: string;
    call_id?: string | null;
    from_number?: string | null;
    created_at: string;
    duration_ms: number | null;
    cost_cents: number | null;
    transfer_outcome?: string | null;
    custom_analysis_data?: { outcome?: string; issues_detected?: string };
    max_pause_sec?: number | null;
    needs_review?: boolean;
    summary?: string | null;
  }>("call_analyses").filter((c) => c.channel === "VOICE");
  const lastCall = recentCalls.length ? recentCalls[recentCalls.length - 1] : null;
  const totalCostEur = recentCalls.reduce((sum, c) => sum + (c.cost_cents ?? 0), 0) / 100;
  const escalatedCount = recentCalls.filter((c) => c.custom_analysis_data?.outcome === "escalado_a_persona").length;
  const transferRamon = recentCalls.filter((c) => c.transfer_outcome === "transferido_ramon").length;
  const transferJose = recentCalls.filter((c) => c.transfer_outcome === "transferido_jose").length;
  const transferNadie = recentCalls.filter((c) => c.transfer_outcome === "ninguno_respondio_registrado").length;
  const voiceBox = `<div class="box"><h3 style="margin-top:0">Teléfono -- agente de voz Miguel</h3>
<p>Número: +34 919 58 88 87. Estado: <strong>${voiceOn ? "Miguel está respondiendo" : "Desactivado -- suenan Ramón y José directamente"}</strong></p>
<form method="post" action="/crm/integraciones/telefono/${voiceOn ? "desactivar" : "activar"}" style="display:inline">
<button class="btn ${voiceOn ? "danger" : "ok"}" type="submit" onclick="return confirm('${voiceOn ? "¿Desactivar a Miguel? Las llamadas nuevas sonarán directamente en los móviles de Ramón y José." : "¿Activar a Miguel? Volverá a responder él las llamadas nuevas."}')">${voiceOn ? "Desactivar a Miguel" : "Activar a Miguel"}</button>
</form>
<p class="sub">Esto NO toca el desvío de Yoigo -- solo decide si las llamadas que ya llegan al número de Twilio las contesta Miguel o van directas a Ramón/José.</p>
<p>Llamadas registradas: <strong>${recentCalls.length}</strong> -- Última: <strong>${lastCall ? esc(fmtDate(lastCall.created_at)) : "ninguna todavía"}</strong></p>
<p>Escaladas a persona: <strong>${escalatedCount}</strong> -- Coste estimado acumulado: <strong>${totalCostEur.toFixed(2)} $</strong></p>
<p>Transferencias -- a Ramón: <strong>${transferRamon}</strong> · a José: <strong>${transferJose}</strong> · nadie respondió: <strong>${transferNadie}</strong></p>
<p class="sub">El coste y las transferencias son los reales que reporta Retell al terminar cada llamada (sumado desde el 13/10/2026) -- no incluye llamadas anteriores a esa fecha, y no hay un evento en vivo por cada intento, solo el resultado final de la llamada.</p>
</div>`;
  // Calidad de llamadas (15/10/2026, el "cerebro" pedido): cada llamada real
  // queda marcada sola (ver tools/webhooks.ts) si tuvo una pausa larga, un
  // fallo o un incidente de seguridad -- así se ve de un vistazo cuáles
  // merece la pena escuchar, en vez de pedir la API de Retell cada vez.
  const toReview = recentCalls.filter((c) => c.needs_review).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 10);
  const qualityBox = `<div class="box"><h3 style="margin-top:0">Calidad de llamadas (automático)</h3>
<p class="sub">Cada llamada real se revisa sola al terminar -- aquí aparecen las que tuvieron una pausa larga (más de 6s), no salieron bien, o tuvieron algún incidente. Útil para detectar fallos reales sin tener que escuchar todas.</p>
${toReview.length === 0
  ? `<p>Ninguna llamada marcada para revisar por ahora.</p>`
  : toReview.map((c) => `<p>${esc(fmtDate(c.created_at))} -- ${esc(c.from_number ?? "número desconocido")}${c.max_pause_sec ? ` -- pausa de ${c.max_pause_sec.toFixed(1)}s` : ""}${c.custom_analysis_data?.issues_detected && c.custom_analysis_data.issues_detected !== "ninguno" ? ` -- ${esc(c.custom_analysis_data.issues_detected)}` : ""}${c.summary ? `<br><span class="sub">${esc(c.summary)}</span>` : ""}</p>`).join("")}
</div>`;
  const body = `<h1>Integraciones</h1>
<p class="sub">Conexión con la cuenta de Google del negocio: correo y calendario de citas.</p>
${config}
<div class="box"><h3 style="margin-top:0">Google</h3>
<p>Estado: <strong>${st.connected ? "Conectado" : "No conectado"}</strong></p>
<p>Cuenta conectada: <strong>${esc(st.connected_email ?? (st.connected ? "(no leída)" : "ninguna"))}</strong></p>
${st.connected_at ? `<p>Conectada desde: ${esc(fmtDate(st.connected_at))}</p>` : ""}
<p>Permisos concedidos:</p>${scopesHtml}
<p>${connectButton} ${disconnectButton}</p>
</div>
${tests}
${emailModeBox}
${whatsappZernioBox(req)}
${voiceBox}
${qualityBox}`;
  res.type("html").send(page("Integraciones", me(res), body, msgOf(req)));
});

// Inicia el consentimiento de Google desde el propio CRM (sin cabeceras ni curl).
crm.get("/integraciones/google/conectar", (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  try {
    res.redirect(createAuthUrl());
  } catch (err) {
    back(res, "/crm/integraciones", describeGoogleError(err));
  }
});

crm.post("/integraciones/correo/activar-envio", (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  setEmailAutoSendEnabled(true, me(res).email);
  back(res, "/crm/integraciones", "Envío automático de correo activado.");
});

crm.post("/integraciones/correo/desactivar-envio", (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  setEmailAutoSendEnabled(false, me(res).email);
  back(res, "/crm/integraciones", "Modo de prueba activado -- el correo ya no envía respuestas reales.");
});

// WhatsApp vía Zernio (18/10/2026, para no depender de la verificación de
// negocio de Meta): el accountId que devuelve el Embedded Signup se muestra
// aquí para copiarlo a ZERNIO_WHATSAPP_ACCOUNT_ID en EasyPanel -- es config
// estática, igual de sitio que el resto de variables ZERNIO_*, no un token
// que cambie solo como los de Google.
function whatsappZernioBox(req: express.Request): string {
  const configured = isZernioWhatsappConfigured();
  const callbackAccountId = typeof req.query.wa_account_id === "string" ? req.query.wa_account_id : null;
  const callbackError = typeof req.query.error === "string" ? req.query.error : null;
  const result = callbackAccountId
    ? `<div class="msg" style="background:#eaf6ea;border-color:#2e9e55">Cuenta conectada en Zernio: <code>${esc(callbackAccountId)}</code>. Copia este valor en <code>ZERNIO_WHATSAPP_ACCOUNT_ID</code> (EasyPanel) y vuelve a implementar para activarlo.</div>`
    : callbackError
      ? `<div class="msg" style="background:#fdecea;border-color:#c62828">Zernio no pudo conectar el número: ${esc(callbackError)}</div>`
      : "";
  const agentOn = isWhatsappZernioAgentEnabled();
  const agentToggle = configured
    ? `<p>Miguel en este canal: <strong>${agentOn ? "Respondiendo" : "Pausado -- los mensajes avisan al equipo, nadie los contesta solo"}</strong></p>
<form method="post" action="/crm/integraciones/whatsapp/agente/${agentOn ? "desactivar" : "activar"}" style="display:inline">
<button class="btn ${agentOn ? "danger" : "ok"}" type="submit" onclick="return confirm('${agentOn ? "¿Pausar a Miguel en WhatsApp? Los mensajes nuevos seguirán avisando al equipo, pero nadie los contestará solo." : "¿Activar a Miguel en WhatsApp? Empezará a contestar él solo los mensajes nuevos de este número."}')">${agentOn ? "Pausar a Miguel aquí" : "Activar a Miguel aquí"}</button>
</form>`
    : "";
  return `<div class="box"><h3 style="margin-top:0">WhatsApp -- vía Zernio</h3>
<p>Estado: <strong>${configured ? "Configurado" : "No configurado"}</strong></p>
<p class="sub">Alternativa a la WhatsApp Cloud API directa de Meta: conecta el número con un clic (Embedded Signup gestionado por Zernio), sin el proceso de verificación de negocio de Meta.</p>
${result}
<p><a class="btn ${configured ? "light" : "ok"}" href="/crm/integraciones/whatsapp/conectar">${configured ? "Reconectar" : "Conectar"} WhatsApp con Zernio</a></p>
<p class="sub">Requiere <code>ZERNIO_API_KEY</code> y <code>ZERNIO_PROFILE_ID</code> ya puestos en el servidor.</p>
${agentToggle}
</div>`;
}

crm.get("/integraciones/whatsapp/conectar", async (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  const redirectUrl = `${PUBLIC_BASE_URL}/crm/integraciones/whatsapp/callback`;
  const result = await getWhatsappConnectUrl(redirectUrl);
  if (!result.ok) return back(res, "/crm/integraciones", `No se pudo iniciar la conexión con Zernio: ${result.error}`);
  res.redirect(result.authUrl);
});

// Zernio vuelve aquí tras el Embedded Signup con accountId (éxito) o error
// en la query string -- lo mostramos para que el admin lo copie a la
// variable de entorno, no hay sitio en disco donde guardarlo solo.
crm.get("/integraciones/whatsapp/callback", (req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  const accountId = typeof req.query.accountId === "string" ? req.query.accountId : null;
  const error = typeof req.query.error === "string" ? req.query.error : null;
  const qs = accountId ? `wa_account_id=${encodeURIComponent(accountId)}` : error ? `error=${encodeURIComponent(error)}` : "";
  res.redirect(`/crm/integraciones${qs ? `?${qs}` : ""}`);
});

crm.post("/integraciones/whatsapp/agente/activar", (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  setWhatsappZernioAgentEnabled(true, me(res).email);
  back(res, "/crm/integraciones", "Miguel activado en WhatsApp -- ya contesta él solo los mensajes nuevos de este número.");
});

crm.post("/integraciones/whatsapp/agente/desactivar", (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  setWhatsappZernioAgentEnabled(false, me(res).email);
  back(res, "/crm/integraciones", "Miguel pausado en WhatsApp -- los mensajes nuevos avisan al equipo, nadie los contesta solo.");
});

crm.post("/integraciones/telefono/activar", (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  setVoiceAgentEnabled(true, me(res).email);
  back(res, "/crm/integraciones", "Miguel activado -- vuelve a contestar las llamadas nuevas.");
});

crm.post("/integraciones/telefono/desactivar", (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  setVoiceAgentEnabled(false, me(res).email);
  back(res, "/crm/integraciones", "Miguel desactivado -- las llamadas nuevas sonarán en los móviles de Ramón y José.");
});

crm.post("/integraciones/google/desconectar", async (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  try {
    await disconnectGoogle();
    writeCollection("google_test_events", []);
    back(res, "/crm/integraciones", "Google desconectado");
  } catch (err) {
    back(res, "/crm/integraciones", describeGoogleError(err));
  }
});

crm.post("/integraciones/google/probar-gmail", async (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  const to = googleStatus().connected_email;
  if (!to) return back(res, "/crm/integraciones", "No sé a qué cuenta enviar la prueba. Reconecta Google.");
  try {
    await sendGmail(to, "Prueba de conexión del CRM", `Este correo confirma que el CRM de Automóviles Lucero puede enviar correo desde ${to}. Puedes borrarlo.`);
    back(res, "/crm/integraciones", `Correo de prueba enviado a ${to}`);
  } catch (err) {
    console.error("[google] prueba gmail:", err);
    back(res, "/crm/integraciones", `Gmail: ${describeGoogleError(err)}`);
  }
});

crm.post("/integraciones/google/probar-calendar", async (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  try {
    const event = await calendarCreateEvent({
      summary: "PRUEBA CRM - borrar",
      description: "Evento de prueba creado desde el CRM para comprobar Google Calendar. Se borra con el botón del CRM.",
      startLocal: tomorrowAt(10, 0),
      endLocal: tomorrowAt(10, 30),
    });
    writeCollection<GoogleTest>("google_test_events", [
      { id: crypto.randomUUID(), event_id: event.id, link: event.htmlLink, created_at: now() },
    ]);
    back(res, "/crm/integraciones", "Evento de prueba creado para mañana a las 10:00");
  } catch (err) {
    console.error("[google] prueba calendar:", err);
    back(res, "/crm/integraciones", `Calendar: ${describeGoogleError(err)}`);
  }
});

crm.post("/integraciones/google/borrar-prueba", async (_req, res) => {
  if (!onlyAdmin(res)) return back(res, "/crm", "Solo el administrador");
  const test = readCollection<GoogleTest>("google_test_events")[0];
  if (!test) return back(res, "/crm/integraciones", "No hay evento de prueba que borrar");
  try {
    await calendarDeleteEvent(test.event_id);
  } catch (err) {
    // Si alguien ya lo borró a mano en Google, no hay nada que hacer: limpiamos el registro.
    const gone = err instanceof Error && /google_api_(404|410)/.test(err.message);
    if (!gone) return back(res, "/crm/integraciones", `Calendar: ${describeGoogleError(err)}`);
  }
  writeCollection("google_test_events", []);
  back(res, "/crm/integraciones", "Evento de prueba borrado");
});

// ---------- Avisos para llamar (cualquier usuario del CRM) ----------
type AlertRow = { id: string; kind: string; lead_phone: string | null; name: string | null; reason: string };
crm.post("/alertas/:id", (req, res) => {
  const accion = String(req.body.accion ?? "atendido");
  if (accion === "eliminar") {
    if (me(res).role !== "admin") return back(res, "/crm", "Solo el administrador puede eliminar alertas");
    const alert = list<AlertRow>("alerts").find((a) => a.id === req.params.id);
    if (!alert) return back(res, "/crm", "No encuentro esa alerta");
    if (!deleteAlert(req.params.id)) return back(res, "/crm", "No encuentro esa alerta");
    moveToTrash("alerts", alert, `Alerta: ${alert.reason} (${alert.name ?? alert.lead_phone ?? "sin contacto"})`, me(res).email);
    return back(res, "/crm", "Alerta movida a la papelera");
  }
  if (!markAlertDone(req.params.id)) return back(res, "/crm", "No encuentro ese aviso");
  back(res, "/crm", "Aviso marcado como atendido");
});

// Borrado masivo de alertas (18/10/2026, "el borrar masivo lo quiero en
// todas las secciones") -- mismo patrón que el individual: se quita de
// alerts y se guarda en la papelera, nunca se pierde de verdad.
crm.post("/alertas-masivo", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Solo el administrador puede eliminar alertas");
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  if (ids.length === 0) return back(res, "/crm", "No seleccionaste ninguna alerta");
  const rows = list<AlertRow>("alerts");
  const targets = rows.filter((a) => ids.includes(a.id));
  for (const a of targets) {
    if (deleteAlert(a.id)) moveToTrash("alerts", a, `Alerta: ${a.reason} (${a.name ?? a.lead_phone ?? "sin contacto"})`, me(res).email);
  }
  back(res, "/crm", targets.length === 0 ? "No había nada que hacer" : `${targets.length} alerta(s) movida(s) a la papelera`);
});

// ---------- Papelera (solo administrador) ----------
const TRASH_LABELS: Record<string, string> = {
  reservations: "Reserva",
  appointments: "Visita",
  handoffs: "Aviso",
  alerts: "Alerta",
  leads: "Cliente",
  email_inbox: "Correo",
  whatsapp_inbox: "WhatsApp",
  call_analyses: "Llamada",
};

crm.get("/papelera", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Esta sección es solo para el administrador");
  const items = listTrash();
  const bulk = items.length > 0
    ? `<form id="papelera-bulk" method="post" action="/crm/papelera-masivo"></form>
<div class="bulkbar">
<label><input class="msgsel" type="checkbox" onchange="toggleAllMsgs(this,'ids')"> Seleccionar todos (${items.length})</label>
<button class="btn ok" type="submit" form="papelera-bulk" name="accion" value="restaurar_seleccionados">Restaurar seleccionados</button>
<button class="btn danger" type="submit" form="papelera-bulk" name="accion" value="eliminar_seleccionados" onclick="return confirm('¿Eliminar para siempre los seleccionados? Ya no se podrán recuperar.')">Eliminar definitivamente los seleccionados</button>
</div>`
    : "";
  const body = `<h1>Papelera</h1>
<p class="sub">Aquí quedan las reservas, visitas, avisos y alertas que se eliminaron -- nada se borra para siempre hasta que lo confirmes aquí.</p>
${bulk}
${items.length === 0 ? `<div class="empty">La papelera está vacía.</div>` : items.map((t) => `<div class="card" style="position:relative"><div class="info">
${simpleCheckbox("papelera-bulk", t.id)}
<h3>${esc(t.label)}</h3>
<p><span class="tag">${esc(TRASH_LABELS[t.collection] ?? t.collection)}</span></p>
<p>Eliminado por ${esc(t.deleted_by)} el ${esc(fmtDate(t.deleted_at))}</p>
<form method="post" action="/crm/papelera/${esc(t.id)}">
<button class="btn ok" type="submit" name="accion" value="restaurar">Restaurar</button>
<button class="btn danger" type="submit" name="accion" value="eliminar" onclick="return confirm('¿Eliminar esto para siempre? Ya no se podrá recuperar.')">Eliminar definitivamente</button>
</form>
</div></div>`).join("")}`;
  res.type("html").send(page("Papelera", me(res), body, msgOf(req)));
});

crm.post("/papelera/:id", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Solo el administrador puede gestionar la papelera");
  const accion = String(req.body.accion ?? "");
  if (accion === "restaurar") {
    if (!restoreFromTrash(req.params.id)) return back(res, "/crm/papelera", "No encuentro eso en la papelera");
    return back(res, "/crm/papelera", "Restaurado");
  }
  if (accion === "eliminar") {
    if (!purgeFromTrash(req.params.id)) return back(res, "/crm/papelera", "No encuentro eso en la papelera");
    return back(res, "/crm/papelera", "Eliminado para siempre");
  }
  back(res, "/crm/papelera", "No entendí esa acción");
});

// Acciones masivas de Papelera (18/10/2026, "el borrar masivo lo quiero en
// todas las secciones") -- restaurar o eliminar definitivamente varios a la
// vez, mismas reglas que una por una.
crm.post("/papelera-masivo", (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Solo el administrador puede gestionar la papelera");
  const accion = String(req.body.accion ?? "");
  const ids = ([] as string[]).concat(req.body.ids ?? []);
  if (ids.length === 0) return back(res, "/crm/papelera", "No seleccionaste nada");
  let done = 0;
  for (const id of ids) {
    if (accion === "restaurar_seleccionados") {
      if (restoreFromTrash(id)) done++;
    } else if (accion === "eliminar_seleccionados") {
      if (purgeFromTrash(id)) done++;
    }
  }
  back(res, "/crm/papelera", done === 0 ? "No había nada que hacer" : accion === "restaurar_seleccionados" ? `${done} elemento(s) restaurado(s)` : `${done} elemento(s) eliminado(s) para siempre`);
});

// ---------- Lucero Studio AI (16/10/2026) ----------
// Módulo independiente: si Higgsfield falla, no afecta a Miguel, al chat ni
// al resto del CRM. Fotos y vídeos se suben/descargan al mismo volumen
// persistente que el resto de datos del negocio.
const studioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const STUDIO_STATUS_TEXT: Record<string, string> = {
  submitted: "Enviado, esperando a Higgsfield",
  in_progress: "Generando…",
  completed: "Listo",
  failed: "Falló",
  nsfw: "Rechazado por contenido",
  canceled: "Cancelado",
  rejected_budget: "No enviado: se pasaría del tope mensual",
  rejected_concurrency: "No enviado: demasiadas generaciones a la vez, espera a que termine alguna",
};

const STUDIO_RIBBON_COLOR: Record<string, string> = {
  completed: "#2e9e55",
  submitted: "#d9a22b",
  in_progress: "#d9a22b",
  failed: "#b3261e",
  nsfw: "#b3261e",
  canceled: "#9aa1ad",
  rejected_budget: "#b3261e",
  rejected_concurrency: "#b3261e",
};

function studioJobCard(j: StudioJob, zernioAccounts: ZernioAccount[] = []): string {
  const template = findTemplate(j.template_id);
  const tone = j.status === "completed" ? "done" : j.status === "submitted" || j.status === "in_progress" ? "pending" : j.status === "canceled" ? "off" : "urgent";
  const outputs = j.output_paths
    .map((p) => {
      const src = `/crm/studio/archivo/${esc(p)}`;
      const media = p.endsWith(".mp4")
        ? `<video controls style="width:100%;border-radius:12px;display:block" src="${src}"></video>`
        : `<img style="width:100%;border-radius:12px;display:block" src="${src}">`;
      return `<div style="margin:8px 0">${media}<a class="btn light" href="${src}" download style="margin-top:6px;width:100%;text-align:center">⬇️ Descargar</a></div>`;
    })
    .join("");
  const publishBlock =
    j.status === "completed" && j.output_paths.length > 0 && zernioAccounts.length > 0
      ? `<form method="post" action="/crm/studio/publicar" style="margin-top:10px">
<input type="hidden" name="job_id" value="${esc(j.id)}">
<label>Publicar en</label>
<select name="account_id">${zernioAccounts.map((a) => `<option value="${esc(a.id)}">${esc(String(a.platform))} (${esc(a.id)})</option>`).join("")}</select>
<input name="caption" placeholder="Texto de la publicación" value="${esc(j.vehicle_label)}">
<button class="btn ok" type="submit">📣 Publicar en redes</button>
</form>`
      : "";
  const engine = j.engine_id ? (template?.kind === "image" ? findImageEngine(j.engine_id) : findVideoEngine(j.engine_id)) : undefined;
  const style = j.style_id ? findVideoStyle(j.style_id) : undefined;
  const detailTags = [
    engine ? `<span class="tag">${engine.icon} ${esc(engine.label)}</span>` : "",
    style ? `<span class="tag">${style.icon} ${esc(style.label)}</span>` : "",
    j.duration_sec ? `<span class="tag">${j.duration_sec}s</span>` : "",
    j.aspect_ratio ? `<span class="tag">${esc(j.aspect_ratio)}</span>` : "",
  ].join("");
  const ribbonColor = STUDIO_RIBBON_COLOR[j.status] ?? "#9aa1ad";
  return `<div class="card ${tone}"><div class="info">
<span class="studio-ribbon" style="background:${ribbonColor}">${esc(STUDIO_STATUS_TEXT[j.status] ?? j.status)}</span>
<h3>${template ? `${template.icon} ` : ""}${esc(template?.label ?? j.template_id)} · ${esc(j.vehicle_label)}</h3>
<p><span class="tag">~${j.estimated_cost_eur.toFixed(2)} €</span>${detailTags}</p>
<p>Pedido por ${esc(j.created_by)} el ${esc(fmtDate(j.created_at))}</p>
${j.manual_prompt ? `<p>Pedido extra: "${esc(j.manual_prompt)}"</p>` : ""}
${j.error && j.status !== "completed" ? `<p>${esc(j.error)}</p>` : ""}
${outputs}
${publishBlock}
</div></div>`;
}

crm.get("/studio", async (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Esta sección es solo para administradores");
  const jobs = listStudioJobs();
  const active = jobs.filter((j) => j.status === "submitted" || j.status === "in_progress");
  await Promise.all(active.map((j) => pollStudioJob(j.id)));
  const fresh = listStudioJobs();
  const budget = budgetInfo();

  if (!isHiggsfieldConnected()) {
    const body = `<h1>Studio IA</h1>
<p class="sub">Genera vídeos e imágenes publicitarias de los coches con IA.</p>
<div class="todo"><h2 style="margin-top:0">Falta conectar Higgsfield</h2><p>Todavía no hay una clave de API de Higgsfield puesta en el servidor. Avisa al administrador para que la añada antes de poder generar nada.</p></div>`;
    return res.type("html").send(page("Studio IA", me(res), body, msgOf(req)));
  }

  const pickCard = (kindClass: string, name: string, value: string, icon: string, label: string, desc: string, checked: boolean, required = false) =>
    `<label class="pick-card ${kindClass}"><input type="radio" name="${name}" value="${esc(value)}" ${required ? "required" : ""} ${checked ? "checked" : ""}>
<span class="pick-icon-badge">${icon}</span><span class="pick-label">${esc(label)}</span>${desc ? `<p class="pick-desc">${esc(desc)}</p>` : ""}</label>`;

  const videoTemplateCards = STUDIO_TEMPLATES.filter((t) => t.kind === "video")
    .map((t, i) => pickCard("kind-video", "template_id", t.id, t.icon, t.label, t.description, i === 0, true))
    .join("");
  const imageTemplateCards = STUDIO_TEMPLATES.filter((t) => t.kind === "image")
    .map((t) => pickCard("kind-image", "template_id", t.id, t.icon, t.label, t.description, false))
    .join("");
  const vehicleOptions = currentVehicles()
    .map((v) => `<option value="${esc(v.id)}">${esc(vehicleName(v.id))}</option>`)
    .join("");
  const videoEngineCards = VIDEO_ENGINES.map((e, i) =>
    pickCard("kind-tune", "video_engine_id", e.id, e.icon, e.label, `~${e.pricePerSecondEur.toFixed(3)} €/s · ${e.description}`, i === 0),
  ).join("");
  const imageEngineCards = IMAGE_ENGINES.map((e, i) =>
    pickCard("kind-tune", "image_engine_id", e.id, e.icon, e.label, `~${e.pricePerImageEur.toFixed(3)} €/imagen · ${e.description}`, i === 0),
  ).join("");
  const styleCards = VIDEO_STYLES.map((s, i) => pickCard("kind-tune", "style_id", s.id, s.icon, s.label, s.description, i === 0)).join("");
  const durationCards =
    pickCard("kind-tune", "duration_choice", "corta", "⏱️", "Corta", "", true) + pickCard("kind-tune", "duration_choice", "larga", "⏳", "Larga", "", false);
  const aspectCards = IMAGE_ASPECT_RATIOS.map((r, i) => pickCard("kind-tune", "aspect_ratio", r.id, r.icon, r.label, "", i === 0)).join("");

  const pendingJobs = fresh.filter((j) => j.status === "submitted" || j.status === "in_progress");
  const doneJobs = fresh.filter((j) => j.status !== "submitted" && j.status !== "in_progress");
  const spentRatio = budget.monthlyBudgetEur > 0 ? budget.spentEur / budget.monthlyBudgetEur : 0;
  const spentColor = spentRatio >= 1 ? "#b3261e" : spentRatio >= 0.8 ? "#d9822b" : "#2e9e55";

  const zernioAccounts = isZernioConnected() ? await listZernioAccounts() : { ok: false as const, error: "zernio_no_configurado" };
  const accounts = zernioAccounts.ok ? zernioAccounts.accounts : [];
  const zernioNotice = isZernioConnected()
    ? !zernioAccounts.ok
      ? `<p class="sub">⚠️ No se pudo conectar con Zernio: ${esc(zernioAccounts.error)}</p>`
      : accounts.length === 0
        ? `<p class="sub">⚠️ Zernio está conectado pero no hay ninguna cuenta de red social enlazada todavía (hazlo desde el panel de Zernio).</p>`
        : ""
    : "";

  const body = `<h1>Studio IA</h1>
<p class="sub">Genera vídeos e imágenes publicitarias de los coches con IA (Higgsfield). Los resultados aparecen abajo del todo, en "Resultados" -- ahí se ven y se descargan.</p>
<div class="studio-stats">
<div class="stat" style="border-left-color:${spentColor}"><b>${budget.spentEur.toFixed(2)} €</b><span>gastado este mes (tope ${budget.monthlyBudgetEur} €)</span></div>
<div class="stat" style="border-left-color:#2563eb"><b>${budget.activeNow} / ${budget.maxConcurrent}</b><span>generando ahora mismo</span></div>
</div>
<form method="post" action="/crm/studio/generar" enctype="multipart/form-data">

<div class="studio-section sec-video">
<h2>🎬 Plantillas de vídeo</h2>
<p class="sub">Necesitan la foto real del coche. La cámara se mueve sola según la plantilla.</p>
<div class="pick-grid">${videoTemplateCards}</div>
</div>

<div class="studio-section sec-image">
<h2>🖼️ Plantillas de imagen</h2>
<p class="sub">No necesitan foto -- la IA genera la escena entera a partir del texto.</p>
<div class="pick-grid">${imageTemplateCards}</div>
</div>

<div class="box">
<label>Coche (del stock)</label>
<select name="vehicle_id"><option value="">-- o escríbelo abajo a mano --</option>${vehicleOptions}</select>
<label>O escribe el coche a mano (si no está en el stock)</label>
<input name="vehicle_label_manual" placeholder="Ej: Peugeot 3008 2020">
<label>Detalle extra (solo para "Temporada / evento": qué ambiente quieres)</label>
<input name="extra" placeholder="Ej: Navidad, verano en la playa...">
<label>Foto real del coche (obligatoria en las plantillas de vídeo)</label>
<input type="file" name="foto" accept="image/*">
</div>

<div class="studio-section sec-tune">
<h2>⚙️ Cómo lo quieres</h2>
<p class="sub">Precios reales publicados por Higgsfield (algunos son precio "desde": la factura real puede ser algo mayor según duración/resolución). Estas opciones solo cambian algo según el tipo de plantilla que hayas elegido arriba.</p>
<label>Motor de vídeo</label>
<div class="pick-grid compact">${videoEngineCards}</div>
<label>Estilo de vídeo</label>
<div class="pick-grid compact">${styleCards}</div>
<label>Duración de vídeo</label>
<div class="pick-grid compact">${durationCards}</div>
<label>Motor de imagen</label>
<div class="pick-grid compact">${imageEngineCards}</div>
<label>Formato de imagen</label>
<div class="pick-grid compact">${aspectCards}</div>
<label>¿Algo más en concreto que quieras pedir? (opcional -- se añade a lo que ya genera la plantilla, no lo sustituye)</label>
<textarea name="manual_prompt" rows="3" placeholder="Ej: que el cielo esté nublado, que la cámara empiece desde más abajo..."></textarea>
</div>

<button class="btn ok" type="submit" style="font-size:24px;padding:18px 28px">✨ Generar</button>
</form>

${zernioNotice}
<h2>⏳ En curso</h2>${pendingJobs.length === 0 ? `<div class="empty">Nada generándose ahora mismo.</div>` : `<div class="gallery">${pendingJobs.map((j) => studioJobCard(j, accounts)).join("")}</div>`}
<h2>🎞️ Resultados</h2>${doneJobs.length === 0 ? `<div class="empty">Todavía no has generado nada. En cuanto generes algo, aparecerá aquí -- se puede ver y descargar directamente desde esta página.</div>` : `<div class="gallery">${doneJobs.map((j) => studioJobCard(j, accounts)).join("")}</div>`}`;
  res.type("html").send(page("Studio IA", me(res), body, msgOf(req)));
});

crm.post("/studio/generar", studioUpload.single("foto"), async (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Esta sección es solo para administradores");
  const templateId = String(req.body.template_id ?? "");
  const template = findTemplate(templateId);
  if (!template) return back(res, "/crm/studio", "Elige una plantilla válida");
  const vehicleId = String(req.body.vehicle_id ?? "").trim();
  const manual = String(req.body.vehicle_label_manual ?? "").trim();
  const vehicleLabel = vehicleId ? vehicleName(vehicleId) : manual;
  if (!vehicleLabel) return back(res, "/crm/studio", "Dime qué coche es: elígelo del stock o escríbelo a mano");
  if (template.needsPhoto && !req.file) return back(res, "/crm/studio", `La plantilla "${template.label}" necesita que subas antes la foto real del coche`);

  const photo = req.file ? saveUploadedPhoto(req.file.buffer, req.file.originalname) : null;
  const extra = String(req.body.extra ?? "").trim() || undefined;
  const manualPrompt = String(req.body.manual_prompt ?? "").trim() || undefined;
  const engineId = String((template.kind === "video" ? req.body.video_engine_id : req.body.image_engine_id) ?? "").trim() || undefined;
  const styleId = String(req.body.style_id ?? "").trim() || undefined;
  const durationChoice = req.body.duration_choice === "larga" ? "larga" : "corta";
  const aspectRatio = String(req.body.aspect_ratio ?? "").trim() || undefined;
  const result = await createStudioJob({ templateId, vehicleLabel, extra, manualPrompt, engineId, styleId, durationChoice, aspectRatio, photo, createdBy: me(res).email });
  if (!result.ok) return back(res, "/crm/studio", `No se pudo crear el encargo: ${result.error}`);
  if (result.job.status === "rejected_budget" || result.job.status === "rejected_concurrency" || result.job.status === "failed") {
    return back(res, "/crm/studio", result.job.error ?? "No se pudo enviar el encargo");
  }
  back(res, "/crm/studio", "Encargo enviado a Higgsfield. Tardará un rato -- vuelve a esta página para ver el resultado.");
});

// Publica un resultado ya generado del Studio en una red social conectada
// vía Zernio. Solo admin, igual que el resto del Studio -- gasta cuota de
// publicación real y queda visible en público, nunca se expone al agente.
crm.post("/studio/publicar", async (req, res) => {
  if (me(res).role !== "admin") return back(res, "/crm", "Esta sección es solo para administradores");
  if (!isZernioConnected()) return back(res, "/crm/studio", "Zernio no está configurado en el servidor");
  const jobId = String(req.body.job_id ?? "");
  const job = getStudioJob(jobId);
  if (!job) return back(res, "/crm/studio", "Encargo no encontrado");
  if (job.status !== "completed" || job.output_paths.length === 0) return back(res, "/crm/studio", "Este encargo todavía no tiene resultado para publicar");

  const accountId = String(req.body.account_id ?? "").trim();
  if (!accountId) return back(res, "/crm/studio", "Elige una cuenta de destino");
  const accountsResult = await listZernioAccounts();
  const account = accountsResult.ok ? accountsResult.accounts.find((a) => a.id === accountId) : undefined;
  if (!account) return back(res, "/crm/studio", "Esa cuenta ya no está disponible en Zernio");

  const caption = String(req.body.caption ?? "").trim() || job.vehicle_label;
  const mediaUrls = job.output_paths.map((p) => `${PUBLIC_BASE_URL}/crm/studio/archivo/${p}`);
  const result = await publishZernioPost({
    content: caption,
    mediaUrls,
    platforms: [{ platform: String(account.platform), accountId }],
    publishNow: true,
  });
  if (!result.ok) return back(res, "/crm/studio", `No se pudo publicar: ${result.error}`);
  back(res, "/crm/studio", `Publicado en ${String(account.platform)} (estado: ${result.status}).`);
});

// Ruta pública (sin sesión, ver excepción más arriba): Higgsfield descarga
// desde aquí la foto que se sube, y aquí mismo se ven/descargan los
// resultados ya generados. Solo sirve archivos dentro de las dos carpetas
// de Studio, nunca cualquier ruta del volumen de datos.
crm.get("/studio/archivo/*", (req, res) => {
  const rel = String((req.params as Record<string, string>)[0] ?? "");
  const safe = path.normalize(rel);
  if (!safe.startsWith("studio_uploads/") && !safe.startsWith("studio_outputs/")) return res.status(404).end();
  const abs = absolutePathFor(safe);
  if (!fileExists(abs)) return res.status(404).end();
  res.sendFile(abs);
});
