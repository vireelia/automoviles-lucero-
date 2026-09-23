// Sobre de respuesta común de la Sección 17: toda herramienta devuelve esta
// forma, para que el prompt nunca reciba un "ok" cuando en realidad falta
// algo esencial.
export type ToolStatus = "ok" | "stale" | "needs_review" | "not_found" | "denied" | "error";

export function envelope<T>(opts: {
  status: ToolStatus;
  data?: T | null;
  source?: string | null;
  source_updated_at?: string | null;
  conflicts?: string[];
  error_code?: string;
}) {
  return {
    status: opts.status,
    request_id: crypto.randomUUID(),
    data: opts.data ?? null,
    source: opts.source ?? null,
    source_updated_at: opts.source_updated_at ?? null,
    last_successful_sync_at: opts.source_updated_at ?? null,
    verified_at: null, // nadie del negocio ha validado estos datos todavía
    conflicts: opts.conflicts ?? [],
    error_code: opts.error_code ?? null,
  };
}
