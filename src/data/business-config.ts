import { readCollection, writeCollection } from "../store.js";
import { businessInfo } from "./business-info.js";

// Valores del negocio editables en caliente desde el CRM (26/10/2026,
// "hazlo editable de verdad" -- a petición real tras preguntar "como subo
// las comisiones... si no hay nada para subirlas" tipo de cosa, esta vez
// sobre Ajustes). SOLO entran aquí los campos que el agente de IA nunca
// repite como texto fijo dentro de los prompts (prompt-core.md/voice/chat)
// -- esos (horarios de visita, importe/plazo de la reserva, garantía,
// plazo de financiación) se QUEDAN en business-info.ts sin tocar a
// propósito: cambiarlos aquí sin re-escribir también el prompt crearía una
// contradicción real entre lo que el modelo "cree" de memoria y lo que
// esta configuración devuelve. Los de aquí (teléfonos, WhatsApp, dirección,
// criterios numéricos de financiación) solo los leen las tools en código,
// nunca están narrados como cifra fija en ningún prompt -- de ahí que sea
// seguro que tomen efecto en caliente, sin reiniciar ni resincronizar nada.
export type BusinessOverrides = {
  id: "overrides";
  ramon_phone?: string | null;
  jose_phone?: string | null;
  whatsapp_number?: string | null;
  address?: string | null;
  how_to_arrive?: string | null;
  financing_min_price_eur?: number | null;
  financing_max_km?: number | null;
  financing_max_age_years?: number | null;
  updated_at?: string;
  updated_by?: string | null;
};

function readOverrides(): BusinessOverrides | undefined {
  return readCollection<BusinessOverrides>("business_overrides").find((r) => r.id === "overrides");
}

export function getBusinessConfig() {
  const o = readOverrides();
  return {
    ramonPhone: o?.ramon_phone?.trim() || businessInfo.responsables.ramon.transfer_number,
    josePhone: o?.jose_phone?.trim() || businessInfo.responsables.jose.transfer_number,
    whatsappNumber: o?.whatsapp_number?.trim() || businessInfo.whatsapp.number,
    address: o?.address?.trim() || businessInfo.location.address.value,
    howToArrive: o?.how_to_arrive?.trim() || businessInfo.location.how_to_arrive,
    financingMinPriceEur: o?.financing_min_price_eur ?? businessInfo.financing.criteria.min_price_eur,
    financingMaxKm: o?.financing_max_km ?? businessInfo.financing.criteria.max_km,
    financingMaxAgeYears: o?.financing_max_age_years ?? businessInfo.financing.criteria.max_age_years,
    // Para que Ajustes pueda mostrar "esto es un valor puesto a mano" vs "esto es el de siempre".
    hasOverride: {
      ramonPhone: Boolean(o?.ramon_phone?.trim()),
      josePhone: Boolean(o?.jose_phone?.trim()),
      whatsappNumber: Boolean(o?.whatsapp_number?.trim()),
      address: Boolean(o?.address?.trim()),
      howToArrive: Boolean(o?.how_to_arrive?.trim()),
      financingMinPriceEur: o?.financing_min_price_eur != null,
      financingMaxKm: o?.financing_max_km != null,
      financingMaxAgeYears: o?.financing_max_age_years != null,
    },
  };
}

export function saveBusinessOverrides(patch: Partial<Omit<BusinessOverrides, "id" | "updated_at" | "updated_by">>, updatedBy: string | null): void {
  const current = readOverrides() ?? ({ id: "overrides" } as BusinessOverrides);
  const merged: BusinessOverrides = { ...current, ...patch, id: "overrides", updated_at: new Date().toISOString(), updated_by: updatedBy };
  const rows = readCollection<BusinessOverrides>("business_overrides").filter((r) => r.id !== "overrides");
  rows.push(merged);
  writeCollection("business_overrides", rows);
}
