// Bloqueo real para que la comprobación de hueco libre y la creación de la
// cita no puedan solaparse (13/10/2026: "evitar dobles reservas" es crítico).
//
// ACTUALIZADO (09/11/2026): era una cola SOLO en memoria del proceso. Se
// perdía en cada reinicio y, si llegaran a correr dos procesos a la vez
// (reinicio solapado de EasyPanel, o una segunda réplica), dos clientes
// podían quedarse con el mismo hueco. Ahora encadena igual dentro del
// proceso Y toma además un bloqueo en disco, atómico entre procesos. Si el
// bloqueo no se consigue se sigue adelante antes que rechazar una cita real,
// dejando constancia.
import { withPersistentLock } from "../locks.js";

let queue: Promise<unknown> = Promise.resolve();

export function withAppointmentLock<T>(fn: () => Promise<T>): Promise<T> {
  const conBloqueo = () =>
    withPersistentLock("citas", fn, 30_000).catch((err) => {
      console.error(`[citas] sin bloqueo en disco (${err instanceof Error ? err.message : err}); se continúa para no rechazar una cita real.`);
      return fn();
    });
  const result = queue.then(conBloqueo, conBloqueo);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
