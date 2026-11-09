import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, mkdtempSync, renameSync } from "fs";
import path from "path";

// Bloqueo persistente entre procesos (09/11/2026). Hasta ahora toda la
// exclusión mutua vivía en Maps y promesas del propio proceso Node: se
// perdía en cada reinicio y no protegía nada si algún día corren dos
// instancias (EasyPanel hoy va con replicas:1, pero el despliegue no lo
// garantiza y un reinicio solapado sí puede dejar dos procesos un instante).
//
// Se apoya en mkdir, que el sistema de ficheros garantiza atómico: solo un
// proceso puede crear el mismo directorio. Dentro se escribe quién lo tiene
// y cuándo, para poder romper un bloqueo huérfano (proceso muerto a mitad)
// en vez de quedarse colgado para siempre.

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const LOCK_DIR = path.join(DATA_DIR, ".locks");
// Un bloqueo más viejo que esto se considera huérfano: ningún trabajo real
// de los que protegemos (una escritura, un turno de IA) tarda tanto.
const STALE_MS = 2 * 60 * 1000;
const WAIT_STEP_MS = 25;
const DEFAULT_TIMEOUT_MS = 30 * 1000;

function lockPath(name: string): string {
  return path.join(LOCK_DIR, name.replace(/[^a-zA-Z0-9_.@+-]/g, "_"));
}

function owner(): string {
  return `${process.pid}@${Date.now()}`;
}

function tryAcquire(name: string): boolean {
  const dir = lockPath(name);
  try {
    mkdirSync(dir, { recursive: false });
    writeFileSync(path.join(dir, "owner"), owner(), "utf8");
    return true;
  } catch {
    // Ya existe: comprobar si está huérfano antes de rendirse.
    try {
      const raw = readFileSync(path.join(dir, "owner"), "utf8");
      const at = Number(raw.split("@")[1] ?? 0);
      if (Number.isFinite(at) && at > 0 && Date.now() - at > STALE_MS) {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: false });
        writeFileSync(path.join(dir, "owner"), owner(), "utf8");
        return true;
      }
    } catch {
      // Sin fichero "owner" legible: o lo acaba de crear otro proceso y
      // todavía no lo ha escrito, o quedó a medias. En ambos casos se cede
      // el turno; el plazo de huérfano lo recuperará.
    }
    return false;
  }
}

function release(name: string): void {
  try {
    rmSync(lockPath(name), { recursive: true, force: true });
  } catch {
    // Nunca tumbar una respuesta real por no poder borrar el bloqueo: el
    // plazo de huérfano lo recupera solo.
  }
}

export class LockTimeout extends Error {
  constructor(name: string) {
    super(`lock_timeout_${name}`);
  }
}

// Ejecuta fn con el bloqueo tomado. Si no lo consigue en timeoutMs, lanza
// LockTimeout -- nunca se ejecuta fn sin el bloqueo, y nunca se espera para
// siempre.
export async function withPersistentLock<T>(name: string, fn: () => Promise<T> | T, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  mkdirSync(LOCK_DIR, { recursive: true });
  const hasta = Date.now() + timeoutMs;
  while (!tryAcquire(name)) {
    if (Date.now() >= hasta) throw new LockTimeout(name);
    await new Promise((r) => setTimeout(r, WAIT_STEP_MS));
  }
  try {
    return await fn();
  } finally {
    release(name);
  }
}

// Variante que no espera: devuelve null si otro proceso lo tiene. Para
// trabajos periódicos (drenar una cola) donde no tiene sentido hacer fila:
// si otro ya está en ello, este ciclo se salta.
export async function withPersistentLockOrSkip<T>(name: string, fn: () => Promise<T> | T): Promise<T | null> {
  mkdirSync(LOCK_DIR, { recursive: true });
  if (!tryAcquire(name)) return null;
  try {
    return await fn();
  } finally {
    release(name);
  }
}

// Marca persistente "esto ya se hizo una vez en esta ventana", en disco en
// vez de un Map que se pierde al reiniciar. Devuelve true solo la primera
// vez dentro de la ventana.
export function markOncePerWindow(name: string, windowMs: number): boolean {
  mkdirSync(LOCK_DIR, { recursive: true });
  const file = `${lockPath(`mark_${name}`)}.json`;
  try {
    if (existsSync(file)) {
      const at = Number(JSON.parse(readFileSync(file, "utf8")).at ?? 0);
      if (Number.isFinite(at) && Date.now() - at < windowMs) return false;
    }
  } catch {
    // Marca ilegible: se trata como si no existiera y se reescribe.
  }
  // Escritura atómica, igual que el resto del almacén: nunca una marca a medias.
  const tmp = mkdtempSync(`${file}.tmp`);
  const tmpFile = path.join(tmp, "m.json");
  writeFileSync(tmpFile, JSON.stringify({ at: Date.now() }), "utf8");
  renameSync(tmpFile, file);
  rmSync(tmp, { recursive: true, force: true });
  return true;
}
