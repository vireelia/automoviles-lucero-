import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import path from "path";
import { withPersistentLock } from "./locks.js";

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

export function appendToCollection<T>(collection: string, item: T, seed: T[] = []): T[] {
  const items = readCollection<T>(collection, seed);
  items.push(item);
  writeCollection(collection, items);
  return items;
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
