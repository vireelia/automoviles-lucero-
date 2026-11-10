import crypto from "crypto";
import { appendToCollection, readCollection, writeCollection } from "../store.js";

// Papelera genérica del CRM (14/10/2026, a petición real: "añade una
// papelera para que puedan borrar reservas o cualquier tipo de cosa que
// haya"). Antes de esto, los botones "Eliminar" de reservas/visitas/avisos/
// alertas borraban el registro para siempre sin posibilidad de recuperarlo
// -- ahora cualquier "Eliminar" mueve el registro completo aquí (nunca lo
// destruye) y el equipo puede restaurarlo o, si de verdad ya no hace falta,
// eliminarlo definitivamente desde /crm/papelera.
export type TrashedItem = {
  id: string;
  collection: string;
  label: string;
  record: unknown;
  deleted_by: string;
  deleted_at: string;
};

export function moveToTrash(collection: string, record: unknown, label: string, deletedBy: string): void {
  appendToCollection<TrashedItem>("trash", {
    id: crypto.randomUUID(),
    collection,
    label,
    record,
    deleted_by: deletedBy,
    deleted_at: new Date().toISOString(),
  });
}

// FALLO REAL de rendimiento (10/11/2026): un borrado masivo real de
// cientos de incidencias llamaba a moveToTrash() una vez por cada una --
// cada llamada vuelve a leer y a escribir el archivo ENTERO de la
// papelera, así que con cientos seleccionadas de golpe eso eran cientos
// de lecturas/escrituras completas en una sola petición, bloqueando el
// servidor mientras duraba. Esta versión hace UNA sola lectura y UNA
// sola escritura para todo el lote.
export function moveManyToTrash(items: { collection: string; record: unknown; label: string }[], deletedBy: string): void {
  if (items.length === 0) return;
  const trash = readCollection<TrashedItem>("trash");
  const now = new Date().toISOString();
  for (const it of items) {
    trash.push({ id: crypto.randomUUID(), collection: it.collection, label: it.label, record: it.record, deleted_by: deletedBy, deleted_at: now });
  }
  writeCollection("trash", trash);
}

export function listTrash(): TrashedItem[] {
  return readCollection<TrashedItem>("trash").sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
}

// Devuelve el registro a su colección original (al final de la lista, como
// si se acabara de crear) y lo quita de la papelera.
export function restoreFromTrash(trashId: string): TrashedItem | null {
  const all = readCollection<TrashedItem>("trash");
  const item = all.find((t) => t.id === trashId);
  if (!item) return null;
  writeCollection<TrashedItem>("trash", all.filter((t) => t.id !== trashId));
  appendToCollection(item.collection, item.record);
  return item;
}

// Borrado real y definitivo -- ya no se puede deshacer. Es el único sitio
// de todo el CRM donde un registro desaparece para siempre.
export function purgeFromTrash(trashId: string): boolean {
  const all = readCollection<TrashedItem>("trash");
  if (!all.some((t) => t.id === trashId)) return false;
  writeCollection<TrashedItem>("trash", all.filter((t) => t.id !== trashId));
  return true;
}
