import { businessInfo } from "../data/business-info.js";
import { envelope } from "../response.js";

export function getBusinessInfo() {
  return envelope({
    status: "ok",
    data: businessInfo,
    source: "Especificación maestra de producción confirmada por el responsable del negocio, 29/09/2026. Campos individuales llevan su propio validation_status.",
    source_updated_at: "2026-09-29",
  });
}
