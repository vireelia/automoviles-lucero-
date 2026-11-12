import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { randomBytes } from "crypto";
import path from "path";
import { withPersistentLock, withPersistentLockSync } from "./locks.js";

// Almacén mínimo por archivos JSON. Suficiente para la fase de validación
// (Sección 25.2 del encargo: "algo ligero, solo para validar con Retell")
// -- se sustituirá por una base real cuando se confirme la fuente maestra
// de inventario (Sección 5). Escritura atómica: se escribe a un .tmp y se
// renombra, para no dejar el archivo a medias si el proceso muere a mitad
// de escritura (SQLite/Postgres lo dan gratis; un JSON plano no).
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function filePath(collection: string) {
  return path.join(DATA_DIR, `${collection}.json`);
}

export function readCollection<T>(collection: string, seed: T[] = []): T[] {
  const p = filePath(collection);
  if (!existsSync(p)) {
    writeCollection(collection, seed);
    return seed;
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

// FALLO REAL detectado probando con DOS instancias (09/11/2026): el archivo
// temporal tenía un nombre FIJO ("<colección>.json.tmp"), así que dos
// procesos escribiendo la misma colección a la vez usaban el mismo temporal
// -- el primero lo renombraba y el segundo se caía con ENOENT, tirando el
// proceso entero (traza real: rename whatsapp_processed.json.tmp -> ENOENT).
// Con un solo proceso nunca se veía. El temporal ahora lleva pid y un
// aleatorio, así que cada escritura tiene el suyo y el renombrado sigue
// siendo atómico.
export function writeCollection<T>(collection: string, data: T[]): void {
  const p = filePath(collection);
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, p);
}

// Reclamo atómico entre procesos de una clave de deduplicación: devuelve
// true solo UNA vez para la misma clave, aunque dos instancias lo pidan a la
// vez. Lo usan los webhooks (WhatsApp, Zernio, Facebook) para no procesar el
// mismo mensaje dos veces: leer-comprobar-escribir por separado no basta
// cuando hay más de un proceso.
export async function claimOnce(collection: string, key: string, maxKept = 500): Promise<boolean> {
  return withPersistentLock(`col_${collection}`, () => {
    const items = readCollection<{ key: string; at: string }>(collection);
    if (items.some((i) => i.key === key)) return false;
    items.push({ key, at: new Date().toISOString() });
    writeCollection(collection, items.slice(-maxKept));
    return true;
  }, 15_000);
}

// Leer-añadir-escribir bajo bloqueo entre procesos (09/11/2026, auditoría de
// concurrencia): sin esto, dos añadidos casi simultáneos a la misma
// colección se pisaban y uno se perdía. Afecta a lo que de verdad importa
// (citas, avisos al equipo, tareas, registros de llamadas).
export function appendToCollection<T>(collection: string, item: T, seed: T[] = []): T[] {
  return withPersistentLockSync(`col_${collection}`, () => {
    const items = readCollection<T>(collection, seed);
    items.push(item);
    writeCollection(collection, items);
    return items;
  });
}

// Misma idea que mutateCollection pero síncrona, para las funciones que ya
// eran síncronas y cuya firma no conviene cambiar. Ver la nota de
// withPersistentLockSync: solo para modificar un JSON, nunca con red dentro.
export function mutateCollectionSync<T>(collection: string, mutate: (items: T[]) => T[] | void, seed: T[] = []): T[] {
  return withPersistentLockSync(`col_${collection}`, () => {
    const items = readCollection<T>(collection, seed);
    const result = mutate(items) ?? items;
    writeCollection(collection, result);
    return result;
  });
}

// Cola de escritura por colección (25/10/2026, encargo de fiabilidad: "dos
// peticiones casi simultáneas no deben pisarse"). Dentro de este mismo
// proceso Node, dos llamadas a mutateCollection sobre LA MISMA colección
// ahora se ejecutan en orden, nunca en paralelo -- cierra la carrera real
// de leer-modificar-escribir que existía (lectura de A, lectura de B,
// escritura de A, escritura de B pisando los cambios de A). Límite
// honesto: esto NO es una transacción de base de datos real ni protege
// entre varias instancias del servicio si algún día se replica -- es la
// mejora real posible sobre archivos JSON planos, sin añadir ninguna
// tecnología nueva al stack.
// ACTUALIZADO (09/11/2026): la cola en memoria seguía siendo correcta dentro
// de un proceso, pero no sobrevivía a un reinicio ni protegía entre dos
// instancias. Ahora encadena igual dentro del proceso (barato, sin tocar el
// disco en el caso normal) Y además toma un bloqueo en disco, atómico entre
// procesos (ver locks.ts). Si el bloqueo no se consigue, se escribe de todas
// formas antes que perder el dato de un cliente real -- se deja constancia.
const writeQueues = new Map<string, Promise<unknown>>();
export function mutateCollection<T>(collection: string, mutate: (items: T[]) => T[] | void, seed: T[] = []): Promise<T[]> {
  const prior = writeQueues.get(collection) ?? Promise.resolve();
  const next = prior
    .catch(() => {})
    .then(async () => {
      const aplicar = () => {
        const items = readCollection<T>(collection, seed);
        const result = mutate(items) ?? items;
        writeCollection(collection, result);
        return result;
      };
      try {
        return await withPersistentLock(`col_${collection}`, aplicar, 10_000);
      } catch (err) {
        console.error(`[store] sin bloqueo para "${collection}" (${err instanceof Error ? err.message : err}); se escribe igualmente para no perder el dato.`);
        return aplicar();
      }
    });
  writeQueues.set(collection, next);
  return next;
}

// FALLO REAL grave encontrado 12/11/2026 (auditoría de rendimiento):
// chat_conversations.json creció a 99,5 MB y luego 53,8 MB (6.885
// conversaciones en un único archivo) -- readCollection/writeCollection
// leen y escriben el archivo ENTERO en cada mensaje real de cualquier
// cliente, bloqueando el event loop bajo tráfico simultáneo y causando
// caídas reales confirmadas (/health sin responder, Ramón sin poder
// entrar). "Almacén por fragmentos": un archivo pequeño POR CLAVE (por
// ejemplo, por teléfono de cliente) dentro de una carpeta, en vez de todos
// mezclados en un único archivo. Escribir el mensaje de un cliente ya solo
// toca SU archivo, nunca el de los otros miles -- mismo patrón de archivo
// JSON de siempre (atómico, sin tecnología nueva), solo organizado por
// clave en vez de por colección entera.
function shardKeyToFilename(key: string): string {
  // Los teléfonos reales (+34...) y los "mail:..." ya son seguros como
  // nombre de archivo salvo por un posible "/" interno (no debería
  // ocurrir nunca en un teléfono o correo reales, pero se neutraliza por
  // si acaso en vez de asumirlo).
  return encodeURIComponent(key).replace(/%2F/g, "_");
}

function shardDir(collection: string): string {
  const dir = path.join(DATA_DIR, collection);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function readShard<T>(collection: string, key: string): T | null {
  const p = path.join(shardDir(collection), `${shardKeyToFilename(key)}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function writeShard<T>(collection: string, key: string, data: T): void {
  const dir = shardDir(collection);
  const p = path.join(dir, `${shardKeyToFilename(key)}.json`);
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, p);
}

export function deleteShard(collection: string, key: string): void {
  const p = path.join(shardDir(collection), `${shardKeyToFilename(key)}.json`);
  if (existsSync(p)) unlinkSync(p);
}

// Para trabajos puntuales/admin que de verdad necesitan ver todo (el
// seguimiento comercial, migraciones) -- no para el camino en caliente de
// un mensaje real, que siempre debe usar readShard/writeShard de una sola
// clave.
export function listShardKeys(collection: string): string[] {
  const dir = shardDir(collection);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.includes(".tmp"))
    .map((f) => decodeURIComponent(f.replace(/\.json$/, "")));
}

export function readAllShards<T>(collection: string): T[] {
  return listShardKeys(collection)
    .map((k) => readShard<T>(collection, k))
    .filter((x): x is T => x !== null);
}
