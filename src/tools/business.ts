import { businessInfo } from "../data/business-info.js";
import { envelope } from "../response.js";

export function getBusinessInfo() {
  return envelope({
    status: "ok",
    data: businessInfo,
    source: "Especificación interna 22/09/2026, sin validar por el dueño en la mayoría de campos.",
    source_updated_at: "2026-09-22",
  });
}
