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
