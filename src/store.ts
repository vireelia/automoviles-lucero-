import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";

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

export function writeCollection<T>(collection: string, data: T[]): void {
  const p = filePath(collection);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, p);
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
const writeQueues = new Map<string, Promise<unknown>>();
export function mutateCollection<T>(collection: string, mutate: (items: T[]) => T[] | void, seed: T[] = []): Promise<T[]> {
  const prior = writeQueues.get(collection) ?? Promise.resolve();
  const next = prior
    .catch(() => {})
    .then(() => {
      const items = readCollection<T>(collection, seed);
      const result = mutate(items) ?? items;
      writeCollection(collection, result);
      return result;
    });
  writeQueues.set(collection, next);
  return next;
}
