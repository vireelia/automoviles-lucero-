// BLOQUE 7 (09/11/2026, auditoría estricta: "implementar una barrera que
// impida enviar mensajes históricos de forma masiva al activar nuevas
// versiones o cambiar variables de entorno"). Las colas reales ya tienen
// topes de ventana propios (23h para el seguimiento, 20h para la ventana
// de WhatsApp de los pendientes), que de por sí ya impiden tocar un
// histórico de días -- esto añade una barrera EXPLÍCITA y operada a mano,
// nunca automática: con `LUCERO_NO_AUTO_BEFORE` (fecha ISO) puesto, ningún
// envío automático (primer contacto, seguimiento, reintento de pendientes)
// toca nada anterior a esa fecha, sin importar lo que digan las ventanas
// de cada cola por separado. Sin la variable puesta, no cambia nada -- es
// una barrera opcional, para activarla justo antes de un despliegue real.
export function esAnteriorAlCorte(isoDate: string | null | undefined): boolean {
  const corte = process.env.LUCERO_NO_AUTO_BEFORE;
  if (!corte || !isoDate) return false;
  const corteMs = new Date(corte).getTime();
  const fechaMs = new Date(isoDate).getTime();
  if (!Number.isFinite(corteMs) || !Number.isFinite(fechaMs)) return false;
  return fechaMs < corteMs;
}
