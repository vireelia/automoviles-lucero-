import express from "express";
import crypto from "crypto";
import { readCollection, writeCollection } from "../store.js";
import { userForSession, createSession, destroySession, verifyPassword, hashPassword, listUsers, saveUsers, type CrmUser } from "./auth.js";
import { vehiclesSeed } from "../data/vehicles-seed.js";
import { createReservationPending, confirmReservation, cancelReservation } from "../tools/reservations.js";
import { getOfficialStatus, setOfficialStatus, type OfficialVehicleStatus } from "../tools/vehicle-state.js";
import { deliverEmail } from "../email/agent.js";

export const crm = express.Router();
crm.use(express.urlencoded({ extended: false, limit: "100kb" }));

// ---------- datos ----------
type Lead = {
  id: string;
  phone: string | null;
  name: string | null;
  notes: string | null;
  channel: string | null;
  vehicle_interest: string | null;
  temperature: string;
  followup_count: number;
  do_not_contact: boolean;
  crm_status?: string;
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
type Handoff = { id: string; lead_phone: string | null; reason?: string; urgency?: string; notes?: string; status: string; created_at: string };
type InboxMail = { id: string; from: string; subject: string; text: string; outcome: string; thread_id?: string; in_reply_to?: string; answered?: boolean; created_at: string };
type Outbox = { id: string; to: string; subject: string; body: string; status: string; created_at: string };
type VehicleOverride = { vehicle_id: string; price_eur: number };

const CRM_STATUS: Record<string, string> = {
  nuevo: "Nuevo",
  en_contacto: "En contacto",
  cita: "Tiene cita",
  reserva: "Reserva en curso",
  cliente: "Ha comprado",
  perdido: "Ya no interesa",
};
const TEMPERATURE: Record<string, { label: string; cls: string }> = {
  HOT: { label: "Muy interesado", cls: "hot" },
  WARM: { label: "Interesado", cls: "warm" },
  COLD: { label: "Poco interesado", cls: "cold" },
};
const RESERVATION_STATUS: Record<string, string> = {
  pending_payment: "Esperando el pago de 500 €",
  pending_verification: "Dice que ha pagado: falta comprobar el justificante",
  confirmed: "Confirmada",
  expired: "Caducada",
  cancelled: "Cancelada",
};
const APPOINTMENT_STATUS: Record<string, string> = {
  requested: "Por confirmar",
  confirmed: "Confirmada",
  cancelled: "Cancelada",
};
const VEHICLE_STATUS_LABEL: Record<OfficialVehicleStatus, string> = {
  AVAILABLE: "Disponible",
  RESERVATION_PENDING: "Reserva en curso",
  RESERVED: "Reservado",
  SOLD: "Vendido",
};

function list<T>(name: string): T[] {
  return readCollection<T>(name);
}
function save<T>(name: string, rows: T[]) {
  writeCollection(name, rows);
}
function now() {
  return new Date().toISOString();
}
function vehicleName(id: string | undefined | null): string {
  const v = vehiclesSeed.find((x) => x.id === id);
  return v ? `${v.make} ${v.model} ${v.year ?? ""}`.trim() : "Coche sin nombre";
}
function priceOf(vehicleId: string): number {
  const override = list<VehicleOverride>("vehicle_overrides").find((o) => o.vehicle_id === vehicleId);
  return override?.price_eur ?? vehiclesSeed.find((v) => v.id === vehicleId)?.price_eur ?? 0;
}
function leadStatus(l: Lead): string {
  return l.crm_status ?? "nuevo";
}
function contactOf(l: Lead | null | undefined): string {
  return l?.name ? `${l.name} (${l.phone ?? "sin contacto"})` : l?.phone ?? "Sin contacto";
}
function isEmail(s: string | null | undefined): boolean {
  return Boolean(s && s.includes("@"));
}
function daysSince(iso: string | undefined): number {
  if (!iso) return 999;
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}

// ---------- utilidades de pantalla ----------
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function fmtDate(iso: string | undefined | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function option(value: string, label: string, selected: string | undefined) {
  return `<option value="${esc(value)}"${selected === value ? " selected" : ""}>${esc(label)}</option>`;
}
function button(label: string, action: string, extra = "") {
  return `<button class="btn ${extra}" name="accion" value="${esc(action)}">${esc(label)}</button>`;
}

function page(title: string, user: CrmUser, body: string, msg?: string): string {
  const nav = [
    ["/crm", "Inicio"],
    ["/crm/clientes", "Clientes"],
    ["/crm/reservas", "Reservas"],
    ["/crm/citas", "Citas"],
    ["/crm/avisos", "Avisos"],
    ["/crm/correos", "Correos"],
    ["/crm/coches", "Coches"],
    ...(user.role === "admin" ? [["/crm/equipo", "Equipo"]] : []),
  ] as const;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Lucero</title>
<style>
*{box-sizing:border-box}
body{margin:0;font:18px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f5f7;color:#1d1f24}
header{background:#1d2b44;color:#fff;padding:14px 20px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
header strong{font-size:22px}
nav{display:flex;flex-wrap:wrap;gap:8px}
nav a{color:#fff;text-decoration:none;background:#2e4166;padding:10px 14px;border-radius:10px;font-size:17px}
nav a.on{background:#f0b429;color:#1d2b44;font-weight:700}
main{max-width:1000px;margin:0 auto;padding:20px}
h1{font-size:30px;margin:8px 0 6px}
.sub{color:#555;margin:0 0 18px}
.msg{background:#e3f6e8;border:2px solid #2e9e55;padding:12px 16px;border-radius:12px;margin-bottom:16px;font-size:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px;margin-bottom:22px}
.stat{background:#fff;border-radius:14px;padding:18px;text-decoration:none;color:inherit;box-shadow:0 1px 3px rgba(0,0,0,.08);border-left:8px solid #1d2b44}
.stat b{display:block;font-size:40px;line-height:1}
.card{background:#fff;border-radius:14px;padding:18px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card h3{margin:0 0 6px;font-size:21px}
.card p{margin:4px 0}
.tag{display:inline-block;padding:4px 10px;border-radius:999px;font-size:15px;margin-right:6px;background:#e8ebf1}
.hot{background:#ffd9d2;color:#8a1f0c}.warm{background:#fff0c2;color:#7a5600}.cold{background:#dce9ff;color:#1b3f8a}
.btn{font:inherit;font-size:18px;padding:12px 18px;border:0;border-radius:12px;background:#1d2b44;color:#fff;cursor:pointer;margin:4px 6px 4px 0}
.btn.ok{background:#2e9e55}.btn.warn{background:#d9822b}.btn.danger{background:#b3261e}.btn.light{background:#e8ebf1;color:#1d2b44}
input,select,textarea{font:inherit;font-size:18px;padding:10px 12px;border:2px solid #c9ced8;border-radius:10px;width:100%;margin:4px 0 12px;background:#fff}
label{font-size:17px;font-weight:600}
form.inline{display:inline}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:640px){.row{grid-template-columns:1fr}header{padding:12px}}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.filters a{padding:10px 14px;border-radius:999px;background:#fff;text-decoration:none;color:#1d2b44;border:2px solid #c9ced8;font-size:17px}
.filters a.on{background:#1d2b44;color:#fff;border-color:#1d2b44}
.empty{background:#fff;border-radius:14px;padding:22px;color:#555}
a.link{color:#1d4ed8;font-weight:600}
.box{background:#fff;border-radius:14px;padding:18px;margin-bottom:18px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card.urgent{border-left:8px solid #b3261e}.card.pending{border-left:8px solid #d9a22b}.card.done{border-left:8px solid #2e9e55;opacity:.85}.card.off{border-left:8px solid #9aa1ad;opacity:.7}
.stat.urgent{border-left-color:#b3261e}.stat.pending{border-left-color:#d9a22b}.stat.done{border-left-color:#2e9e55}
.todo{background:#fff8e6;border:2px solid #d9a22b;border-radius:14px;padding:16px 18px;margin-bottom:22px}
.todo h2{margin:0 0 8px;font-size:22px}.todo a{display:block;font-size:19px;padding:8px 0;color:#1d2b44;font-weight:600}
.allok{background:#e3f6e8;border:2px solid #2e9e55;border-radius:14px;padding:16px 18px;margin-bottom:22px;font-size:20px;font-weight:600}
</style></head><body>
<header><strong>Automóviles Lucero</strong>
<nav>${nav.map(([href, label]) => `<a href="${href}"${href === "/crm" ? "" : ""} class="${(title === label || (label === "Inicio" && title === "Inicio")) ? "on" : ""}">${label}</a>`).join("")}</nav>
<form method="post" action="/crm/salir" style="margin:0"><button class="btn light" type="submit">Salir (${esc(user.name)})</button></form></header>
<main>${msg ? `<div class="msg">${esc(msg)}</div>` : ""}${body}</main></body></html>`;
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
<label>Contraseña</label><input name="password" type="password" required>
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

crm.use((req, res, next) => {
  if (req.path === "/entrar") return next();
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

// ---------- Inicio ----------
crm.get("/", (req, res) => {
  const leads = list<Lead>("leads");
  const reservations = list<Reservation>("reservations");
  const appointments = list<Appointment>("appointments");
  const handoffs = list<Handoff>("handoffs");
  const inbox = list<InboxMail>("email_inbox");
  const hot = leads.filter((l) => l.temperature === "HOT" && leadStatus(l) !== "cliente");
  const newLeads = leads.filter((l) => leadStatus(l) === "nuevo");
  const resToDo = reservations.filter((r) => r.status === "pending_payment" || r.status === "pending_verification");
  const apptToDo = appointments.filter((a) => a.status === "requested");
  const handToDo = handoffs.filter((h) => h.status === "requested");
  const mailToDo = inbox.filter((m) => m.outcome !== "automated_no_reply" && !m.answered);
  const stats = [
    { href: "/crm/clientes?f=muy", label: "Clientes muy interesados", n: hot.length, tone: hot.length ? "urgent" : "done" },
    { href: "/crm/clientes?f=nuevo", label: "Clientes nuevos sin atender", n: newLeads.length, tone: newLeads.length ? "pending" : "done" },
    { href: "/crm/reservas", label: "Reservas por resolver", n: resToDo.length, tone: resToDo.some((r) => r.status === "pending_verification") ? "urgent" : resToDo.length ? "pending" : "done" },
    { href: "/crm/citas", label: "Citas por confirmar", n: apptToDo.length, tone: apptToDo.length ? "pending" : "done" },
    { href: "/crm/avisos", label: "Avisos sin hacer", n: handToDo.length, tone: handToDo.length ? "urgent" : "done" },
    { href: "/crm/correos", label: "Correos de personas sin contestar", n: mailToDo.length, tone: mailToDo.length ? "pending" : "done" },
  ];
  const todo: { href: string; text: string }[] = [
    ...handToDo.slice(0, 3).map((h) => ({ href: "/crm/avisos", text: `Atender aviso: ${h.reason ?? "cliente"} (${h.lead_phone ?? "sin contacto"})` })),
    ...resToDo.filter((r) => r.status === "pending_verification").slice(0, 3).map((r) => ({ href: "/crm/reservas", text: `Comprobar el justificante de ${vehicleName(r.vehicle_id)}` })),
    ...apptToDo.slice(0, 3).map((a) => ({ href: "/crm/citas", text: `Confirmar cita del ${a.requested_date ?? "día por fijar"} a las ${a.requested_time ?? "?"}` })),
    ...hot.slice(0, 3).map((l) => ({ href: `/crm/clientes/${l.id}`, text: `Llamar a ${l.name || l.phone || "cliente muy interesado"}` })),
    ...mailToDo.slice(0, 3).map((m) => ({ href: "/crm/correos", text: `Contestar a ${m.from}` })),
  ];
  const todoBlock = todo.length
    ? `<div class="todo"><h2>Lo primero que tienes que hacer</h2>${todo.slice(0, 8).map((t) => `<a href="${t.href}">→ ${esc(t.text)}</a>`).join("")}</div>`
    : `<div class="allok">Todo al día. No hay nada urgente.</div>`;
  const body = `<h1>Inicio</h1><p class="sub">Toca un cuadro para ver lo que hay que hacer. El color te dice la prioridad: rojo urgente, amarillo pendiente, verde al día.</p>
${todoBlock}
<div class="grid">${stats.map((s2) => `<a class="stat ${s2.tone}" href="${s2.href}"><b>${s2.n}</b>${esc(s2.label)}</a>`).join("")}</div>`;
  res.type("html").send(page("Inicio", me(res), body, msgOf(req)));
});

// ---------- Clientes ----------
const FILTERS: Record<string, { label: string; test: (l: Lead) => boolean }> = {
  todos: { label: "Todos", test: () => true },
  muy: { label: "Calientes (muy interesados)", test: (l) => l.temperature === "HOT" },
  interesado: { label: "Templados (interesados)", test: (l) => l.temperature === "WARM" },
  poco: { label: "Fríos (poco interesados)", test: (l) => l.temperature === "COLD" },
  nuevo: { label: "Nuevos", test: (l) => leadStatus(l) === "nuevo" },
  sin_contestar: { label: "Sin contestar en 3 días", test: (l) => ["nuevo", "en_contacto"].includes(leadStatus(l)) && daysSince(l.updated_at ?? l.created_at) >= 3 },
  cita: { label: "Con cita", test: (l) => leadStatus(l) === "cita" },
  reserva: { label: "Con reserva", test: (l) => leadStatus(l) === "reserva" },
  cliente: { label: "Han comprado", test: (l) => leadStatus(l) === "cliente" },
};

crm.get("/clientes", (req, res) => {
  const f = typeof req.query.f === "string" && FILTERS[req.query.f] ? req.query.f : "todos";
  const leads = list<Lead>("leads").filter(FILTERS[f].test).sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at));
  const body = `<h1>Clientes</h1>
<p class="sub">Elige un grupo para ver solo esos clientes. Toca "Abrir" para cambiar sus datos o su estado.</p>
<div class="box"><h3>Añadir un cliente nuevo</h3>
<form method="post" action="/crm/clientes">
<div class="row"><div><label>Nombre</label><input name="nombre"></div>
<div><label>Teléfono o correo (obligatorio)</label><input name="contacto" required></div>
<div><label>Qué le interesa</label><input name="vehicle_interest"></div>
<div><label>Cómo de interesado está</label><select name="temperature">
<option value="HOT">Caliente (muy interesado)</option><option value="WARM" selected>Templado (interesado)</option><option value="COLD">Frío (poco interesado)</option></select></div></div>
<label>Notas</label><textarea name="notes" rows="2"></textarea>
<button class="btn ok" type="submit">Añadir cliente</button></form></div>
<div class="filters">${Object.entries(FILTERS).map(([k, v]) => `<a href="/crm/clientes?f=${k}" class="${k === f ? "on" : ""}">${esc(v.label)}</a>`).join("")}</div>
${leads.length === 0 ? `<div class="empty">No hay clientes en este grupo.</div>` : leads.map((l) => {
  const t = TEMPERATURE[l.temperature] ?? TEMPERATURE.COLD;
  const tone = l.temperature === "HOT" && leadStatus(l) !== "cliente" ? "urgent" : leadStatus(l) === "cliente" ? "done" : leadStatus(l) === "perdido" ? "off" : "pending";
  return `<div class="card ${tone}"><h3>${esc(l.name || l.phone || "Sin nombre")}</h3>
<p><span class="tag ${t.cls}">${esc(t.label)}</span><span class="tag">${esc(CRM_STATUS[leadStatus(l)])}</span></p>
<p>Contacto: ${esc(l.phone ?? "—")} · Llegó por: ${esc(l.channel ?? "—")}</p>
<p>Le interesa: ${esc(l.vehicle_interest ?? "todavía no lo sabemos")}</p>
<p>Último contacto: ${esc(fmtDate(l.updated_at ?? l.created_at))}</p>
<a class="btn" href="/crm/clientes/${esc(l.id)}">Abrir</a>
${!isEmail(l.phone) && l.phone ? `<a class="btn light" href="tel:${esc(l.phone)}">Llamar</a>` : ""}
</div>`;
}).join("")}`;
  res.type("html").send(page("Clientes", me(res), body, msgOf(req)));
});

crm.post("/clientes", (req, res) => {
  const contacto = String(req.body.contacto ?? "").trim();
  if (!contacto) return back(res, "/crm/clientes", "Escribe el teléfono o el correo del cliente");
  const leads = list<Lead>("leads");
  const existing = leads.find((l) => l.phone === contacto);
  if (existing) return back(res, `/crm/clientes/${existing.id}`, "Ese cliente ya existe: lo tienes abierto aquí");
  const temp = ["HOT", "WARM", "COLD"].includes(String(req.body.temperature)) ? String(req.body.temperature) : "WARM";
  const lead: Lead = {
    id: crypto.randomUUID(),
    phone: contacto,
    name: String(req.body.nombre ?? "").trim() || null,
    notes: String(req.body.notes ?? "").trim() || null,
    channel: "CRM",
    vehicle_interest: String(req.body.vehicle_interest ?? "").trim() || null,
    temperature: temp,
    followup_count: 0,
    do_not_contact: false,
    crm_status: "nuevo",
    created_at: now(),
    updated_at: now(),
  };
  leads.push(lead);
  save("leads", leads);
  back(res, `/crm/clientes/${lead.id}`, "Cliente añadido");
});

crm.get("/clientes/:id", (req, res) => {
  const lead = list<Lead>("leads").find((l) => l.id === req.params.id);
  if (!lead) {
    res.redirect("/crm/clientes?msg=No%20encuentro%20ese%20cliente");
    return;
  }
  const key = lead.phone ?? "";
  const appts = list<Appointment>("appointments").filter((a) => a.lead_phone === key);
  const resv = list<Reservation>("reservations").filter((r) => r.lead_phone === key);
  const handoffs = list<Handoff>("handoffs").filter((h) => h.lead_phone === key);
  const mails = list<Outbox>("email_outbox").filter((m) => m.to === key);
  const t = TEMPERATURE[lead.temperature] ?? TEMPERATURE.COLD;
  const body = `<p><a class="link" href="/crm/clientes">← Volver a clientes</a></p>
<h1>${esc(lead.name || lead.phone || "Cliente")}</h1>
<p><span class="tag ${t.cls}">${esc(t.label)}</span><span class="tag">${esc(CRM_STATUS[leadStatus(lead)])}</span></p>
<form class="box" method="post" action="/crm/clientes/${esc(lead.id)}">
<div class="row">
<div><label>Nombre</label><input name="name" value="${esc(lead.name ?? "")}"></div>
<div><label>Teléfono o correo</label><input name="contacto" value="${esc(lead.phone ?? "")}"></div>
<div><label>Qué le interesa</label><input name="vehicle_interest" value="${esc(lead.vehicle_interest ?? "")}"></div>
<div><label>Cómo de interesado está</label><select name="temperature">
${option("HOT", "Muy interesado", lead.temperature)}${option("WARM", "Interesado", lead.temperature)}${option("COLD", "Poco interesado", lead.temperature)}</select></div>
<div><label>En qué punto está</label><select name="crm_status">
${Object.entries(CRM_STATUS).map(([k, v]) => option(k, v, leadStatus(lead))).join("")}</select></div>
</div>
<label>Notas (lo que quieras recordar)</label><textarea name="notes" rows="3">${esc(lead.notes ?? "")}</textarea>
<button class="btn ok" type="submit" name="accion" value="guardar">Guardar cambios</button>
${lead.do_not_contact ? button("Volver a contactar", "reactivar", "light") : button("No volver a escribirle", "no_contactar", "danger")}
</form>
<div class="box"><h3>Qué ha pasado con este cliente</h3>
<p><b>Citas:</b> ${appts.length === 0 ? "ninguna" : appts.map((a) => `${esc(a.requested_date ?? "")} ${esc(a.requested_time ?? "")} (${esc(APPOINTMENT_STATUS[a.status] ?? a.status)})`).join(" · ")}</p>
<p><b>Reservas:</b> ${resv.length === 0 ? "ninguna" : resv.map((r) => `${esc(vehicleName(r.vehicle_id))}: ${esc(RESERVATION_STATUS[r.status] ?? r.status)}`).join(" · ")}</p>
<p><b>Avisos:</b> ${handoffs.length === 0 ? "ninguno" : handoffs.map((h) => esc(h.reason ?? "aviso")).join(" · ")}</p>
<p><b>Correos que le hemos enviado:</b> ${mails.length === 0 ? "ninguno" : mails.slice(-3).map((m) => esc(m.subject)).join(" · ")}</p>
</div>`;
  res.type("html").send(page("Clientes", me(res), body, msgOf(req)));
});

crm.post("/clientes/:id", (req, res) => {
  const leads = list<Lead>("leads");
  const lead = leads.find((l) => l.id === req.params.id);
  if (!lead) return back(res, "/crm/clientes", "No encuentro ese cliente");
  const accion = String(req.body.accion ?? "guardar");
  if (accion === "no_contactar") lead.do_not_contact = true;
  else if (accion === "reactivar") lead.do_not_contact = false;
  else {
    lead.name = String(req.body.name ?? "").trim() || null;
    const contacto = String(req.body.contacto ?? "").trim();
    lead.phone = contacto || null;
    lead.vehicle_interest = String(req.body.vehicle_interest ?? "").trim() || null;
    const temp = String(req.body.temperature ?? "");
    if (["HOT", "WARM", "COLD"].includes(temp)) lead.temperature = temp;
    const st = String(req.body.crm_status ?? "");
    if (CRM_STATUS[st]) lead.crm_status = st;
    lead.notes = String(req.body.notes ?? "").trim() || null;
  }
  lead.updated_at = now();
  save("leads", leads);
  back(res, `/crm/clientes/${lead.id}`, accion === "guardar" ? "Cambios guardados" : accion === "no_contactar" ? "Listo: no le escribiremos más" : "Listo: sí se le puede escribir");
});

// ---------- Reservas ----------
crm.get("/reservas", (req, res) => {
  const reservations = list<Reservation>("reservations").sort((a, b) => b.created_at.localeCompare(a.created_at));
  const available = vehiclesSeed.filter((v) => getOfficialStatus(v.id) === "AVAILABLE");
  const body = `<h1>Reservas</h1>
<p class="sub">Una reserva es 500 € para apartar un coche. Cuando el cliente paga, comprueba el justificante y pulsa "Confirmar".</p>
<div class="box"><h3>Nueva reserva</h3>
<form method="post" action="/crm/reservas">
<label>Coche</label><select name="vehicle_id">${available.map((v) => option(v.id, `${vehicleName(v.id)} · ${priceOf(v.id)} €`, "")).join("")}</select>
<label>Teléfono o correo del cliente</label><input name="contacto" required>
<button class="btn ok" type="submit">Crear reserva</button></form></div>
${reservations.length === 0 ? `<div class="empty">Todavía no hay reservas.</div>` : reservations.map((r) => {
  const actions: string[] = [];
  if (r.status === "pending_payment") actions.push(button("El cliente ya ha pagado", "pagado", "warn"));
  if (r.status === "pending_payment" || r.status === "pending_verification") {
    actions.unshift(r.status === "pending_verification" ? button("Confirmar: el justificante está bien", "confirmar", "ok") : "");
    actions.push(button("Cancelar la reserva", "cancelar", "danger"));
  }
  const tone = r.status === "pending_verification" ? "urgent" : r.status === "pending_payment" ? "pending" : r.status === "confirmed" ? "done" : "off";
  return `<div class="card ${tone}"><h3>${esc(vehicleName(r.vehicle_id))}</h3>
<p><span class="tag">${esc(RESERVATION_STATUS[r.status] ?? r.status)}</span></p>
<p>Cliente: ${esc(r.lead_phone ?? "sin contacto")} · Importe: ${r.amount_eur} €</p>
<p>Fecha: ${esc(fmtDate(r.created_at))}${r.verified_by ? ` · Confirmada por ${esc(r.verified_by)}` : ""}</p>
<form method="post" action="/crm/reservas/${esc(r.id)}">${actions.filter(Boolean).join("")}</form></div>`;
}).join("")}`;
  res.type("html").send(page("Reservas", me(res), body, msgOf(req)));
});

crm.post("/reservas", (req, res) => {
  const vehicleId = String(req.body.vehicle_id ?? "");
  const contacto = String(req.body.contacto ?? "").trim();
  if (!vehicleId || !contacto) return back(res, "/crm/reservas", "Elige un coche y escribe el contacto del cliente");
  const result = createReservationPending({ vehicle_id: vehicleId, lead_phone: contacto }) as unknown as { status: string; error_code?: string };
  if (result.status !== "ok") return back(res, "/crm/reservas", "Ese coche no está disponible para reservar");
  back(res, "/crm/reservas", "Reserva creada. El cliente tiene que pagar los 500 €");
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
  if (accion === "confirmar") {
    confirmReservation({ reservation_id: r.id, verified_by: me(res).name });
    return back(res, "/crm/reservas", "Reserva confirmada. El coche queda reservado");
  }
  if (accion === "cancelar") {
    cancelReservation({ reservation_id: r.id, reason: "cancelada desde el CRM" });
    return back(res, "/crm/reservas", "Reserva cancelada. El coche vuelve a estar disponible");
  }
  back(res, "/crm/reservas", "No entendí esa acción");
});

// ---------- Citas ----------
crm.get("/citas", (req, res) => {
  const appts = list<Appointment>("appointments").sort((a, b) => `${a.requested_date ?? ""}${a.requested_time ?? ""}`.localeCompare(`${b.requested_date ?? ""}${b.requested_time ?? ""}`));
  const body = `<h1>Citas</h1>
<p class="sub">Miguel ha apuntado estas citas. Confírmalas cuando hables con el cliente, o cámbiales la hora.</p>
${appts.length === 0 ? `<div class="empty">Todavía no hay citas.</div>` : appts.map((a) => `<div class="card ${a.status === "requested" ? "pending" : a.status === "confirmed" ? "done" : "off"}"><h3>${esc(vehicleName(a.vehicle_id))}</h3>
<p><span class="tag">${esc(APPOINTMENT_STATUS[a.status] ?? a.status)}</span>${a.appointment_type ? `<span class="tag">${esc(a.appointment_type)}</span>` : ""}</p>
<p>Día: <b>${esc(a.requested_date ?? "sin día")}</b> · Hora: <b>${esc(a.requested_time ?? "sin hora")}</b></p>
<p>Cliente: ${esc(a.lead_phone ?? "sin contacto")}</p>${a.notes ? `<p>Notas: ${esc(a.notes)}</p>` : ""}
<form method="post" action="/crm/citas/${esc(a.id)}">
${a.status === "requested" ? button("Confirmar la cita", "confirmar", "ok") : ""}
${a.status !== "cancelled" ? button("Cancelar la cita", "cancelar", "danger") : ""}
<div class="row"><div><label>Cambiar el día</label><input type="date" name="fecha" value="${esc(a.requested_date ?? "")}"></div>
<div><label>Cambiar la hora</label><input type="time" name="hora" value="${esc(a.requested_time ?? "")}"></div></div>
<button class="btn light" type="submit" name="accion" value="cambiar">Guardar el nuevo día y hora</button>
</form></div>`).join("")}`;
  res.type("html").send(page("Citas", me(res), body, msgOf(req)));
});

crm.post("/citas/:id", (req, res) => {
  const accion = String(req.body.accion ?? "");
  const appts = list<Appointment>("appointments");
  const a = appts.find((x) => x.id === req.params.id);
  if (!a) return back(res, "/crm/citas", "No encuentro esa cita");
  if (accion === "confirmar") a.status = "confirmed";
  else if (accion === "cancelar") a.status = "cancelled";
  else if (accion === "cambiar") {
    const fecha = String(req.body.fecha ?? "").trim();
    const hora = String(req.body.hora ?? "").trim();
    if (fecha) a.requested_date = fecha;
    if (hora) a.requested_time = hora;
  }
  save("appointments", appts);
  back(res, "/crm/citas", accion === "confirmar" ? "Cita confirmada" : accion === "cancelar" ? "Cita cancelada" : "Día y hora cambiados");
});

// ---------- Avisos ----------
crm.get("/avisos", (req, res) => {
  const items = list<Handoff>("handoffs").sort((a, b) => b.created_at.localeCompare(a.created_at));
  const body = `<h1>Avisos</h1>
<p class="sub">Miguel te avisa aquí cuando un cliente necesita a una persona. Cuando lo hayas atendido, pulsa "Hecho".</p>
${items.length === 0 ? `<div class="empty">No hay avisos.</div>` : items.map((h) => `<div class="card ${h.status !== "requested" ? "done" : h.urgency === "alta" ? "urgent" : "pending"}"><h3>${esc(h.reason ?? "Aviso")}</h3>
<p><span class="tag ${h.urgency === "alta" ? "hot" : ""}">${h.urgency === "alta" ? "Urgente" : "Normal"}</span><span class="tag">${h.status === "requested" ? "Pendiente" : "Hecho"}</span></p>
<p>Cliente: ${esc(h.lead_phone ?? "sin contacto")} · ${esc(fmtDate(h.created_at))}</p>${h.notes ? `<p>${esc(h.notes)}</p>` : ""}
${h.status === "requested" ? `<form method="post" action="/crm/avisos/${esc(h.id)}"><button class="btn ok" type="submit">Hecho: ya lo he atendido</button></form>` : ""}
</div>`).join("")}`;
  res.type("html").send(page("Avisos", me(res), body, msgOf(req)));
});

crm.post("/avisos/:id", (req, res) => {
  const items = list<Handoff>("handoffs");
  const h = items.find((x) => x.id === req.params.id);
  if (!h) return back(res, "/crm/avisos", "No encuentro ese aviso");
  h.status = "done";
  save("handoffs", items);
  back(res, "/crm/avisos", "Aviso marcado como hecho");
});

// ---------- Correos ----------
const OUTCOME_LABEL: Record<string, string> = {
  sent: "Miguel ya contestó",
  queued_no_google: "Miguel preparó la respuesta: se enviará cuando Gmail esté conectado",
  send_failed: "Miguel no pudo enviar la respuesta",
  automated_no_reply: "Correo automático: no hace falta contestar",
};

crm.get("/correos", (req, res) => {
  const inbox = list<InboxMail>("email_inbox").sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 60);
  const body = `<h1>Correos</h1>
<p class="sub">Aquí ves los correos que han llegado al negocio y lo que hizo Miguel con cada uno. Si quieres contestar tú, escribe abajo.</p>
${inbox.length === 0 ? `<div class="empty">Todavía no ha llegado ningún correo.</div>` : inbox.map((m) => `<div class="card ${m.outcome === "automated_no_reply" ? "off" : m.answered ? "done" : "pending"}"><h3>${esc(m.subject || "(sin asunto)")}</h3>
<p>De: <b>${esc(m.from)}</b> · ${esc(fmtDate(m.created_at))}</p>
<p><span class="tag">${esc(OUTCOME_LABEL[m.outcome] ?? m.outcome)}</span>${m.answered ? `<span class="tag">Contestado por el equipo</span>` : ""}</p>
<div class="box" style="background:#f7f8fa;white-space:pre-wrap">${esc(m.text)}</div>
${m.outcome !== "automated_no_reply" && !m.answered ? `<form method="post" action="/crm/correos/${esc(m.id)}">
<label>Tu respuesta (opcional: si no escribes nada, Miguel sigue con lo suyo)</label><textarea name="respuesta" rows="4"></textarea>
<button class="btn ok" type="submit" name="accion" value="responder">Enviar mi respuesta</button>
<button class="btn light" type="submit" name="accion" value="marcar">Ya está atendido</button>
</form>` : ""}
</div>`).join("")}`;
  res.type("html").send(page("Correos", me(res), body, msgOf(req)));
});

crm.post("/correos/:id", async (req, res) => {
  const accion = String(req.body.accion ?? "");
  const inbox = list<InboxMail>("email_inbox");
  const m = inbox.find((x) => x.id === req.params.id);
  if (!m) return back(res, "/crm/correos", "No encuentro ese correo");
  if (accion === "marcar") {
    m.answered = true;
    save("email_inbox", inbox);
    return back(res, "/crm/correos", "Marcado como atendido");
  }
  const text = String(req.body.respuesta ?? "").trim();
  if (!text) return back(res, "/crm/correos", "Escribe la respuesta antes de enviarla");
  const subject = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject || "su consulta"}`;
  const thread = m.thread_id && m.in_reply_to ? { threadId: m.thread_id, inReplyTo: m.in_reply_to } : undefined;
  const delivery = await deliverEmail(m.from, subject, `${text}\n\nAutomóviles Lucero`, thread);
  m.answered = true;
  save("email_inbox", inbox);
  if (delivery.status === "sent") back(res, "/crm/correos", "Respuesta enviada");
  else if (delivery.status === "queued") back(res, "/crm/correos", "Respuesta guardada: se enviará cuando Gmail esté conectado");
  else back(res, "/crm/correos", "No se pudo enviar la respuesta. Inténtalo otra vez");
});

// ---------- Coches ----------
crm.get("/coches", (req, res) => {
  const body = `<h1>Coches</h1>
<p class="sub">Aquí cambias si un coche está disponible, reservado o vendido, y su precio.</p>
<div class="grid">${vehiclesSeed.map((v) => {
  const st = getOfficialStatus(v.id);
  return `<div class="card"><h3>${esc(vehicleName(v.id))}</h3>
<p>${esc(v.km.toLocaleString("es-ES"))} km · ${esc(v.fuel)} · ${esc(v.power_cv)} CV</p>
<p><span class="tag">${esc(VEHICLE_STATUS_LABEL[st])}</span><b>${esc(priceOf(v.id).toLocaleString("es-ES"))} €</b></p>
<a class="btn" href="/crm/coches/${esc(v.id)}">Abrir</a></div>`;
}).join("")}</div>`;
  res.type("html").send(page("Coches", me(res), body, msgOf(req)));
});

crm.get("/coches/:id", (req, res) => {
  const v = vehiclesSeed.find((x) => x.id === req.params.id);
  if (!v) return back(res, "/crm/coches", "No encuentro ese coche");
  const st = getOfficialStatus(v.id);
  const body = `<p><a class="link" href="/crm/coches">← Volver a coches</a></p>
<h1>${esc(vehicleName(v.id))}</h1>
<p>${esc(v.km.toLocaleString("es-ES"))} km · ${esc(v.fuel)} · ${esc(v.power_cv)} CV · ${esc(v.category)}</p>
<p>${v.known_defects ? `Avería o detalle conocido: <b>${esc(v.known_defects)}</b>` : "Sin averías conocidas"}</p>
<form class="box" method="post" action="/crm/coches/${esc(v.id)}">
<label>Estado del coche</label><select name="estado">
${(["AVAILABLE", "RESERVED", "SOLD"] as OfficialVehicleStatus[]).map((s) => option(s, VEHICLE_STATUS_LABEL[s], st)).join("")}</select>
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
<p class="sub">Aquí das de alta a Ramón y a José, y cambias sus contraseñas.</p>
<div class="box"><h3>Dar de alta a alguien</h3>
<form method="post" action="/crm/equipo">
<div class="row"><div><label>Nombre</label><input name="nombre" required></div>
<div><label>Correo para entrar</label><input name="correo" type="email" required></div>
<div><label>Contraseña (mínimo 8 letras o números)</label><input name="clave" type="password" minlength="8" required></div>
<div><label>Puede…</label><select name="rol"><option value="equipo">Ver y trabajar (sin cambiar el equipo)</option><option value="admin">Todo, incluido el equipo</option></select></div></div>
<button class="btn ok" type="submit">Dar de alta</button></form></div>
${users.map((u) => `<div class="card"><h3>${esc(u.name)}</h3><p>${esc(u.email)} · ${u.role === "admin" ? "Puede todo" : "Ver y trabajar"}</p>
<form method="post" action="/crm/equipo/${esc(u.id)}">
<label>Nueva contraseña</label><input name="clave" type="password" minlength="8">
<button class="btn light" type="submit" name="accion" value="clave">Cambiar contraseña</button>
${u.id !== me(res).id ? button("Quitar el acceso", "quitar", "danger") : ""}
</form></div>`).join("")}`;
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
    role: req.body.rol === "admin" ? "admin" : "equipo",
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
