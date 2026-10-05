import crypto from "crypto";
import { readCollection, writeCollection } from "../store.js";

export type CrmRole = "admin" | "comercial" | "equipo";
export type CrmUser = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: CrmRole;
  created_at: string;
};
type Session = { token: string; user_id: string; expires_at: number };

const SESSION_HOURS = 12;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const ref = Buffer.from(hash, "hex");
  return ref.length === test.length && crypto.timingSafeEqual(ref, test);
}

export function listUsers(): CrmUser[] {
  return readCollection<CrmUser>("crm_users");
}

export function saveUsers(users: CrmUser[]) {
  writeCollection("crm_users", users);
}

// Primer administrador: se crea la primera vez que arranca el sistema, con las
// variables CRM_ADMIN_EMAIL y CRM_ADMIN_PASSWORD configuradas en EasyPanel.
export function bootstrapAdmin() {
  const email = process.env.CRM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.CRM_ADMIN_PASSWORD;
  if (!email || !password) return;
  const users = listUsers();
  if (users.some((u) => u.email === email)) return;
  users.push({
    id: crypto.randomUUID(),
    name: "Administrador",
    email,
    password_hash: hashPassword(password),
    role: "admin",
    created_at: new Date().toISOString(),
  });
  saveUsers(users);
}

export function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const sessions = readCollection<Session>("crm_sessions").filter((s) => s.expires_at > now);
  sessions.push({ token, user_id: userId, expires_at: now + SESSION_HOURS * 3600 * 1000 });
  writeCollection("crm_sessions", sessions);
  return token;
}

export function userForSession(token: string | undefined): CrmUser | null {
  if (!token) return null;
  const now = Date.now();
  const session = readCollection<Session>("crm_sessions").find((s) => s.token === token && s.expires_at > now);
  if (!session) return null;
  return listUsers().find((u) => u.id === session.user_id) ?? null;
}

export function destroySession(token: string | undefined) {
  if (!token) return;
  writeCollection("crm_sessions", readCollection<Session>("crm_sessions").filter((s) => s.token !== token));
}
