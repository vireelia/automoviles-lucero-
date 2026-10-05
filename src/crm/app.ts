import express from "express";
import crypto from "crypto";
import { readCollection, writeCollection } from "../store.js";
import { userForSession, createSession, destroySession, verifyPassword, hashPassword, listUsers, saveUsers, type CrmUser } from "./auth.js";
import { vehiclesSeed } from "../data/vehicles-seed.js";
import { currentVehicles } from "../data/vehicles-current.js";
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
const TEMP: Record<string, { label: string; cls: string; help: string }> = {
  HOT: { label: "Quiere comprar ya", cls: "t-hot", help: "caliente" },
  WARM: { label: "Interesado, sin prisa", cls: "t-warm", help: "templado" },
  COLD: { label: "Solo está mirando", cls: "t-cold", help: "frío" },
};

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
function button(label: string, action: string, extra = "") {
  return `<button class="btn ${extra}" name="accion" value="${esc(action)}">${esc(label)}</button>`;
}

// ---------- pantalla ----------
const MENU: [string, string][] = [
  ["/crm", "Hoy"],
  ["/crm/citas", "Visitas"],
  ["/crm/reservas", "Reservas"],
  ["/crm/pendientes", "Pendientes"],
  ["/crm/clientes", "Clientes"],
  ["/crm/coches", "Coches"],
];

function page(section: string, user: CrmUser, body: string, msg?: string): string {
  const menu = [...MENU, ...(user.role === "admin" ? [["/crm/equipo", "Equipo"] as [string, string]] : [])];
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(section)} · Lucero</title>
<style>
*{box-sizing:border-box}
body{margin:0;font:20px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f3f4f6;color:#1d1f24}
header{background:#1d2b44;color:#fff;padding:14px 18px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
header strong{font-size:24px}
nav{display:flex;flex-wrap:wrap;gap:8px}
nav a{color:#fff;text-decoration:none;background:#2e4166;padding:12px 16px;border-radius:12px;font-size:19px}
nav a.on{background:#f0b429;color:#1d2b44;font-weight:700}
main{max-width:980px;margin:0 auto;padding:18px}
h1{font-size:34px;margin:6px 0 4px}
h2{font-size:24px;margin:22px 0 10px}
.sub{color:#4b5563;margin:0 0 16px;font-size:20px}
.msg{background:#e3f6e8;border:3px solid #2e9e55;padding:14px 18px;border-radius:14px;margin-bottom:16px;font-size:21px;font-weight:600}
.card{background:#fff;border-radius:16px;padding:18px 20px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.08);display:flex;gap:16px;flex-wrap:wrap}
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
.legend{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}
a.link{color:#1d4ed8;font-weight:700;font-size:20px}
</style></head><body>
<header><strong>Automóviles Lucero</strong>
<nav>${menu.map(([href, label]) => `<a href="${href}" class="${section === label ? "on" : ""}">${label}</a>`).join("")}</nav>
<form method="post" action="/crm/salir" style="margin:0"><button class="btn light" type="submit">Salir</button></form></header>
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

// ---------- tarjetas reutilizables ----------
function apptCard(a: Appointment): string {
  const d = dayLabel(a.requested_date);
  const tone = a.status === "requested" ? "pending" : a.status === "confirmed" ? "done" : "off";
  const actions = [
    a.status === "requested" ? button("Confirmar la visita", "confirmar", "ok") : "",
    a.status !== "cancelled" ? button("Cancelar la visita", "cancelar", "danger") : "",
  ].join("");
  return `<div class="card ${tone}">
<div class="when"><span>${esc(d.weekday)}</span><b>${esc(d.day)}</b><span>${esc(d.month)}</span><em>${esc(a.requested_time ?? "")}</em></div>
<div class="info"><h3>${esc(vehicleName(a.vehicle_id))}</h3>
<p><span class="tag">${esc(APPOINTMENT_TEXT[a.status] ?? a.status)}</span>${a.appointment_type ? `<span class="tag">${esc(a.appointment_type)}</span>` : ""}</p>
<p>Cliente: <b>${esc(a.lead_phone ?? "sin contacto")}</b></p>
${a.notes ? `<p>${esc(a.notes)}</p>` : ""}
<form method="post" action="/crm/citas/${esc(a.id)}">${actions}
${phoneLink(a.lead_phone)}
<div class="row"><div><label>Otro día</label><input type="date" name="fecha" value="${esc(a.requested_date ?? "")}"></div>
<div><label>Otra hora</label><input type="time" name="hora" value="${esc(a.requested_time ?? "")}"></div></div>
<button class="btn light" type="submit" name="accion" value="cambiar">Cambiar día y hora</button>
</form></div></div>`;
}

function reservationCard(r: Reservation, user: CrmUser): string {
  const sold = getOfficialStatus(r.vehicle_id) === "SOLD";
  const tone = sold ? "off" : r.status === "pending_verification" ? "urgent" : r.status === "pending_payment" ? "pending" : r.status === "confirmed" ? "done" : "off";
  const actions: string[] = [];
  if (r.status === "pending_payment") actions.push(button("Ha pagado", "pagado", "warn"));
  if (r.status === "pending_verification") {
    if (canConfirmPayments(user)) actions.push(button("Confirmar la reserva", "confirmar", "ok"));
    else actions.push(`<span class="tag">El pago lo confirma el comercial</span>`);
  }
  if (r.status === "confirmed" && !sold && canConfirmPayments(user)) actions.push(button("Coche vendido y entregado", "vendido", "ok"));
  if (sold) actions.unshift(`<span class="tag" style="background:#e5e7eb">Coche vendido y entregado</span>`);
  if (r.status === "pending_payment" || r.status === "pending_verification") actions.push(button("Cancelar la reserva", "cancelar", "danger"));
  return `<div class="card ${tone}" id="r-${esc(r.id)}"><div class="info">
<h3>${esc(vehicleName(r.vehicle_id))}</h3>
<p><span class="tag">${esc(sold ? "Vendido" : RESERVATION_TEXT[r.status] ?? r.status)}</span><span class="tag">${r.amount_eur} €</span></p>
<p>Cliente: <b>${esc(r.lead_phone ?? "sin contacto")}</b></p>
<p>Desde el ${esc(fmtDate(r.created_at))}${r.verified_by ? ` · confirmada por ${esc(r.verified_by)}` : ""}</p>
<form method="post" action="/crm/reservas/${esc(r.id)}">${actions.join("")}${phoneLink(r.lead_phone)}</form>
</div></div>`;
}

function leadCard(l: Lead): string {
  const t = TEMP[l.temperature] ?? TEMP.COLD;
  return `<div class="card"><div class="info">
<h3>${esc(l.name || l.phone || "Sin nombre")}</h3>
<p><span class="tag ${t.cls}">${esc(t.label)}</span>${l.do_not_contact ? `<span class="tag">No volver a escribir</span>` : ""}</p>
<p><b>${esc(situation(l))}</b></p>
<p>Último contacto: ${esc(fmtDate(l.updated_at ?? l.created_at))}</p>
<a class="btn" href="/crm/clientes/${esc(l.id)}">Ver ficha</a>${phoneLink(l.phone)}
</div></div>`;
}

// ---------- Hoy ----------
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
  const todoBlock = todo.length
    ? `<div class="todo"><h2 style="margin-top:0">Lo que tienes que hacer</h2>${todo.slice(0, 8).map((t) => `<a href="${t.href}">→ ${esc(t.text)}</a>`).join("")}</div>`
    : `<div class="allok">Todo hecho. No hay nada pendiente.</div>`;
  const body = `<h1>Hoy</h1><p class="sub">${esc(d.weekday)} ${esc(d.day)} de ${esc(d.month)}</p>
<div class="stats">
<a class="stat" href="/crm/citas"><b>${todayAppts.length}</b><span>visitas hoy</span></a>
<a class="stat" href="/crm/reservas"><b>${toAttend.length}</b><span>reservas por atender</span></a>
<a class="stat" href="/crm/pendientes"><b>${handoffs.length + mails.length}</b><span>pendientes</span></a>
</div>
${todoBlock}
<h2>Visitas de hoy</h2>${todayAppts.length === 0 ? `<div class="empty">Hoy no hay visitas.</div>` : todayAppts.map(apptCard).join("")}
<h2>Próximas visitas</h2>${upcoming.length === 0 ? `<div class="empty">No hay visitas próximas.</div>` : upcoming.map(apptCard).join("")}
<h2>Reservas que hay que atender</h2>${toAttend.length === 0 ? `<div class="empty">No hay reservas esperando.</div>` : toAttend.map((r) => reservationCard(r, me(res))).join("")}`;
  res.type("html").send(page("Hoy", me(res), body, msgOf(req)));
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
<p>${pill("todas", "Todas")} ${pill("pendientes", "Por confirmar")} ${pill("confirmadas", "Confirmadas")}</p>
${items.length === 0 ? `<div class="empty">No hay visitas en esta lista.</div>` : items.map(apptCard).join("")}`;
  res.type("html").send(page("Visitas", me(res), body, msgOf(req)));
});

crm.post("/citas/:id", (req, res) => {
  const accion = String(req.body.accion ?? "");
  const appts = list<Appointment>("appointments");
  const a = appts.find((x) => x.id === req.params.id);
  if (!a) return back(res, "/crm/citas", "No encuentro esa visita");
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

// ---------- Reservas ----------
crm.get("/reservas", (req, res) => {
  const reservations = list<Reservation>("reservations").sort((a, b) => b.created_at.localeCompare(a.created_at));
  const available = currentVehicles().filter((v) => getOfficialStatus(v.id) === "AVAILABLE");
  const body = `<h1>Reservas</h1>
<p class="sub">Una reserva aparta un coche con 500 €. Cuando el cliente paga, compruébalo y pulsa "Confirmar la reserva".</p>
<div class="box"><h3 style="margin-top:0">Hacer una reserva a mano</h3>
<form method="post" action="/crm/reservas">
<label>Coche</label><select name="vehicle_id">${available.map((v) => option(v.id, `${vehicleName(v.id)} · ${priceOf(v.id)} €`, "")).join("")}</select>
<label>Teléfono o correo del cliente</label><input name="contacto" required>
<button class="btn ok" type="submit">Crear la reserva</button></form></div>
${reservations.length === 0 ? `<div class="empty">Todavía no hay reservas.</div>` : reservations.map((r) => reservationCard(r, me(res))).join("")}`;
  res.type("html").send(page("Reservas", me(res), body, msgOf(req)));
});

crm.post("/reservas", (req, res) => {
  const vehicleId = String(req.body.vehicle_id ?? "");
  const contacto = String(req.body.contacto ?? "").trim();
  if (!vehicleId || !contacto) return back(res, "/crm/reservas", "Elige un coche y escribe el contacto del cliente");
  const result = createReservationPending({ vehicle_id: vehicleId, lead_phone: contacto }) as unknown as { status: string };
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
  back(res, "/crm/reservas", "No entendí esa acción");
});

// ---------- Pendientes (avisos de Miguel y correos) ----------
crm.get("/pendientes", (req, res) => {
  const handoffs = list<Handoff>("handoffs").filter((h) => h.status === "requested").sort((a, b) => b.created_at.localeCompare(a.created_at));
  const mails = list<InboxMail>("email_inbox").filter((m) => m.outcome !== "automated_no_reply" && !m.answered).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const body = `<h1>Pendientes</h1>
<p class="sub">Aquí aparece lo que Miguel no puede resolver solo. Cuando lo hayas atendido, pulsa el botón.</p>
<h2>Avisos de Miguel (${handoffs.length})</h2>
${handoffs.length === 0 ? `<div class="empty">No hay avisos.</div>` : handoffs.map((h) => `<div class="card ${h.urgency === "alta" ? "urgent" : "pending"}"><div class="info">
<h3>${esc(h.reason ?? "Aviso")}</h3>
<p><span class="tag ${h.urgency === "alta" ? "t-hot" : ""}">${h.urgency === "alta" ? "Urgente" : "Normal"}</span></p>
<p>Cliente: <b>${esc(h.lead_phone ?? "sin contacto")}</b> · ${esc(fmtDate(h.created_at))}</p>${h.notes ? `<p>${esc(h.notes)}</p>` : ""}
<form method="post" action="/crm/avisos/${esc(h.id)}"><button class="btn ok" type="submit">Ya lo he atendido</button>${phoneLink(h.lead_phone)}</form>
</div></div>`).join("")}
<h2>Correos para contestar (${mails.length})</h2>
${mails.length === 0 ? `<div class="empty">No hay correos por contestar.</div>` : mails.map((m) => `<div class="card pending"><div class="info">
<h3>${esc(m.subject || "(sin asunto)")}</h3>
<p>De: <b>${esc(m.from)}</b> · ${esc(fmtDate(m.created_at))}</p>
<div class="box" style="background:#f7f8fa;white-space:pre-wrap;font-size:19px">${esc(m.text)}</div>
<form method="post" action="/crm/correos/${esc(m.id)}">
<label>Tu respuesta (si no escribes nada, no se envía nada)</label>
<textarea name="respuesta" rows="4"></textarea>
<button class="btn ok" type="submit" name="accion" value="responder">Enviar mi respuesta</button>
<button class="btn light" type="submit" name="accion" value="ya">No hace falta</button>
</form></div></div>`).join("")}`;
  res.type("html").send(page("Pendientes", me(res), body, msgOf(req)));
});

crm.post("/avisos/:id", (req, res) => {
  const items = list<Handoff>("handoffs");
  const h = items.find((x) => x.id === req.params.id);
  if (!h) return back(res, "/crm/pendientes", "No encuentro ese aviso");
  h.status = "done";
  save("handoffs", items);
  back(res, "/crm/pendientes", "Aviso atendido");
});

crm.post("/correos/:id", async (req, res) => {
  const accion = String(req.body.accion ?? "");
  const inbox = list<InboxMail>("email_inbox");
  const m = inbox.find((x) => x.id === req.params.id);
  if (!m) return back(res, "/crm/pendientes", "No encuentro ese correo");
  if (accion === "ya") {
    m.answered = true;
    save("email_inbox", inbox);
    return back(res, "/crm/pendientes", "Hecho");
  }
  const text = String(req.body.respuesta ?? "").trim();
  if (!text) return back(res, "/crm/pendientes", "Escribe la respuesta antes de enviarla");
  const subject = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject || "su consulta"}`;
  const thread = m.thread_id && m.in_reply_to ? { threadId: m.thread_id, inReplyTo: m.in_reply_to } : undefined;
  const delivery = await deliverEmail(m.from, subject, `${text}\n\nAutomóviles Lucero`, thread);
  m.answered = true;
  save("email_inbox", inbox);
  if (delivery.status === "sent") back(res, "/crm/pendientes", "Respuesta enviada");
  else if (delivery.status === "queued") back(res, "/crm/pendientes", "Respuesta guardada: se enviará cuando Gmail esté conectado");
  else back(res, "/crm/pendientes", "No se pudo enviar. Inténtalo otra vez");
});

crm.get("/avisos", (_req, res) => res.redirect("/crm/pendientes"));
crm.get("/correos", (_req, res) => res.redirect("/crm/pendientes"));

// ---------- Clientes (solo lectura de la segmentación de Miguel) ----------
crm.get("/clientes", (req, res) => {
  const t = typeof req.query.t === "string" && TEMP[req.query.t] ? req.query.t : "todos";
  const leads = list<Lead>("leads").filter((l) => t === "todos" || l.temperature === t).sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at));
  const pill = (k: string, label: string, cls = "") => `<a href="/crm/clientes?t=${k}" class="tag ${cls}" style="text-decoration:none;padding:10px 16px;${t === k ? "outline:4px solid #1d2b44" : ""}">${label}</a>`;
  const body = `<h1>Clientes</h1>
<p class="sub">Miguel anota solo lo que quiere cada cliente. Tú solo lo lees y llamas si hace falta.</p>
<div class="legend">${pill("todos", "Todos")} ${pill("HOT", "Quieren comprar ya", "t-hot")} ${pill("WARM", "Interesados, sin prisa", "t-warm")} ${pill("COLD", "Solo miran", "t-cold")}</div>
${leads.length === 0 ? `<div class="empty">Todavía no hay clientes en esta lista.</div>` : leads.map(leadCard).join("")}`;
  res.type("html").send(page("Clientes", me(res), body, msgOf(req)));
});

crm.get("/clientes/:id", (req, res) => {
  const lead = list<Lead>("leads").find((l) => l.id === req.params.id);
  if (!lead) return back(res, "/crm/clientes", "No encuentro ese cliente");
  const key = lead.phone ?? "";
  const appts = list<Appointment>("appointments").filter((a) => a.lead_phone === key);
  const resv = list<Reservation>("reservations").filter((r) => r.lead_phone === key);
  const t = TEMP[lead.temperature] ?? TEMP.COLD;
  const body = `<p><a class="link" href="/crm/clientes">← Volver a clientes</a></p>
<h1>${esc(lead.name || lead.phone || "Cliente")}</h1>
<p><span class="tag ${t.cls}">${esc(t.label)}</span></p>
<div class="box"><p><b>Lo que quiere:</b> ${esc(situation(lead))}</p>
<p><b>Contacto:</b> ${esc(lead.phone ?? "—")}</p>
<p><b>Visitas:</b> ${appts.length === 0 ? "ninguna" : appts.map((a) => `${esc(a.requested_date ?? "")} ${esc(a.requested_time ?? "")} (${esc(APPOINTMENT_TEXT[a.status] ?? a.status)})`).join(" · ")}</p>
<p><b>Reservas:</b> ${resv.length === 0 ? "ninguna" : resv.map((r) => `${esc(vehicleName(r.vehicle_id))}: ${esc(RESERVATION_TEXT[r.status] ?? r.status)}`).join(" · ")}</p>
${phoneLink(lead.phone)}</div>
<form class="box" method="post" action="/crm/clientes/${esc(lead.id)}">
<label>Notas para el equipo</label><textarea name="notes" rows="3">${esc(lead.notes ?? "")}</textarea>
<button class="btn ok" type="submit" name="accion" value="guardar">Guardar notas</button>
${lead.do_not_contact ? button("Volver a escribirle", "reactivar", "light") : button("No volver a escribirle", "no_contactar", "danger")}
</form>`;
  res.type("html").send(page("Clientes", me(res), body, msgOf(req)));
});

crm.post("/clientes/:id", (req, res) => {
  const leads = list<Lead>("leads");
  const lead = leads.find((l) => l.id === req.params.id);
  if (!lead) return back(res, "/crm/clientes", "No encuentro ese cliente");
  const accion = String(req.body.accion ?? "guardar");
  if (accion === "no_contactar") lead.do_not_contact = true;
  else if (accion === "reactivar") lead.do_not_contact = false;
  else lead.notes = String(req.body.notes ?? "").trim() || null;
  lead.updated_at = now();
  save("leads", leads);
  back(res, `/crm/clientes/${lead.id}`, accion === "guardar" ? "Notas guardadas" : accion === "no_contactar" ? "Listo: no le escribiremos más" : "Listo: sí se le puede escribir");
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
<div><label>Contraseña (mínimo 8)</label><input name="clave" type="password" minlength="8" required></div>
<div><label>Puede…</label><select name="rol"><option value="equipo">Ver y trabajar (no confirma pagos)</option><option value="comercial">Comercial: confirma pagos y ventas</option><option value="admin">Todo, incluido el equipo</option></select></div></div>
<button class="btn ok" type="submit">Dar de alta</button></form></div>
${users.map((u) => `<div class="card"><div class="info"><h3>${esc(u.name)}</h3><p>${esc(u.email)} · ${esc(ROLE_NAME[u.role] ?? u.role)}</p>
<form method="post" action="/crm/equipo/${esc(u.id)}">
<label>Nueva contraseña</label><input name="clave" type="password" minlength="8">
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
