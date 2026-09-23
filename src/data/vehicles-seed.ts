// Semilla de inventario. Fuente: observación de coches.net y Wallapop del
// 22/09/2026 (Secciones 19-21 del encargo). NO es stock confirmado ni una
// oferta vigente -- todas las unidades llevan stock_status "unknown" y
// validation_status "observed_public" hasta que el dueño confirme.
//
// Base: las 38 unidades de coches.net (Sección 19). Las 28 de Wallapop
// (Sección 20) NO se suman como coches distintos -- se representan como
// wallapop_price/wallapop_km/wallapop_year SOLO donde la Sección 21 marca
// un conflicto explícito, y como wallapop_ref informativo cuando hay
// correspondencia razonable sin conflicto declarado. No se fusionan ni
// separan unidades por intuición fuera de lo que el propio documento ya
// establece en la Sección 21.

export type Vehicle = {
  id: string;
  ref_cochesnet: string | null;
  ref_wallapop: string | null;
  make: string;
  model: string;
  version: string;
  year: number | null;
  year_note: string | null;
  km: number;
  fuel: string;
  power_cv: number;
  price_eur: number;
  stock_status: "available" | "reserved" | "sold" | "workshop" | "not_roadworthy" | "unknown";
  validation_status: "owner_confirmed" | "document_verified" | "observed_public" | "conflict" | "expired";
  known_defects: string | null;
  warranty_note: string | null;
  conflicts: string[];
  source: string;
  source_updated_at: string;
};

const OBSERVED = "2026-09-22";
const SOURCE = "coches.net (observado 22/09/2026, sin validar)";

export const vehiclesSeed: Vehicle[] = [
  {
    id: "lucero-001", ref_cochesnet: null, ref_wallapop: null,
    make: "Audi", model: "A7 Sportback", version: "50 TDI quattro",
    year: 2019, year_note: null, km: 200000, fuel: "Diésel", power_cv: 286, price_eur: 27990,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null,
    conflicts: ["Clasificación de combustible pendiente de confirmar (Wallapop lo muestra como híbrido; el texto original dice TDI). No prometer autonomía eléctrica."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-002", ref_cochesnet: null, ref_wallapop: null,
    make: "Audi", model: "Q3", version: "2.0 TDI quattro S tronic Advance",
    year: 2012, year_note: null, km: 290000, fuel: "Diésel", power_cv: 177, price_eur: 8490,
    stock_status: "unknown", validation_status: "conflict",
    known_defects: null, warranty_note: null,
    conflicts: ["Kilometraje distinto en Wallapop: 290.000 km frente a 309.000 km.", "Referencias de acabado distintas entre portales."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-003", ref_cochesnet: null, ref_wallapop: null,
    make: "Audi", model: "Q5", version: "2.0 TDI quattro",
    year: 2009, year_note: null, km: 320000, fuel: "Diésel", power_cv: 170, price_eur: 7490,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-004", ref_cochesnet: null, ref_wallapop: null,
    make: "Audi", model: "SQ7", version: "4.0 TDI quattro tiptronic",
    year: 2017, year_note: null, km: 130000, fuel: "Diésel", power_cv: 435, price_eur: 41990,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null,
    conflicts: ["Wallapop anuncia frenos carbocerámicos; equipamiento pendiente de validar por unidad.", "El precio nuevo sin extras (112.243 €) que aparece en fotos del anuncio NO es el precio de venta de este vehículo usado."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-005", ref_cochesnet: null, ref_wallapop: null,
    make: "BMW", model: "Serie 1", version: "120d",
    year: 2006, year_note: null, km: 260000, fuel: "Diésel", power_cv: 163, price_eur: 3900,
    stock_status: "unknown", validation_status: "conflict",
    known_defects: null, warranty_note: null,
    conflicts: ["Precio distinto en Wallapop: 3.900 € frente a 3.990 €."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-006", ref_cochesnet: null, ref_wallapop: null,
    make: "BMW", model: "Serie 3", version: "330d xDrive",
    year: 2010, year_note: null, km: 290000, fuel: "Diésel", power_cv: 245, price_eur: 8890,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-007", ref_cochesnet: null, ref_wallapop: null,
    make: "Ford", model: "S-MAX", version: "ST-Line automático",
    year: 2021, year_note: null, km: 320000, fuel: "Diésel", power_cv: 190, price_eur: 11900,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-008", ref_cochesnet: null, ref_wallapop: null,
    make: "Maserati", model: "Ghibli", version: "S Q4 3.0 V6",
    year: 2016, year_note: null, km: 177000, fuel: "Gasolina", power_cv: 410, price_eur: 29990,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: "1 año (mención histórica, no política confirmada).", conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-009", ref_cochesnet: null, ref_wallapop: null,
    make: "Mercedes-Benz", model: "Clase A", version: "A150",
    year: 2009, year_note: null, km: 310000, fuel: "Gasolina", power_cv: 95, price_eur: 2990,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-010", ref_cochesnet: null, ref_wallapop: null,
    make: "Mercedes-Benz", model: "Clase B", version: "B200 d Urban",
    year: 2016, year_note: null, km: 270000, fuel: "Diésel", power_cv: 136, price_eur: 9990,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-011", ref_cochesnet: null, ref_wallapop: null,
    make: "Mercedes-Benz", model: "Clase R", version: "R320 CDI 4MATIC",
    year: 2006, year_note: null, km: 516000, fuel: "Diésel", power_cv: 224, price_eur: 9490,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-012", ref_cochesnet: null, ref_wallapop: null,
    make: "Mercedes-Benz", model: "Viano", version: "3.0 CDI Trend Larga",
    year: 2012, year_note: null, km: 600000, fuel: "Diésel", power_cv: 224, price_eur: 10900,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-013", ref_cochesnet: null, ref_wallapop: null,
    make: "Mitsubishi", model: "Outlander", version: "2.0 DID Kaiteki",
    year: 2007, year_note: null, km: 294000, fuel: "Diésel", power_cv: 140, price_eur: 3990,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: "Sin indicación de garantía en la ficha observada.", conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-014", ref_cochesnet: null, ref_wallapop: null,
    make: "Opel", model: "Mokka", version: "1.6 CDTi Excellence",
    year: 2016, year_note: null, km: 300000, fuel: "Diésel", power_cv: 136, price_eur: 4490,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-015", ref_cochesnet: null, ref_wallapop: null,
    make: "Peugeot", model: "308 SW", version: "Allure BlueHDi EAT8",
    year: 2023, year_note: null, km: 200000, fuel: "Diésel", power_cv: 130, price_eur: 8990,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-016", ref_cochesnet: null, ref_wallapop: null,
    make: "Peugeot", model: "5008", version: "Allure 1.6 BlueHDi EAT6",
    year: 2016, year_note: null, km: 280000, fuel: "Diésel", power_cv: 120, price_eur: 4990,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null,
    conflicts: ["Kilometraje justo en el límite de financiación de Lendrock (280.000 km) -- no decidir el caso límite sin confirmación del negocio."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-017", ref_cochesnet: null, ref_wallapop: null,
    make: "Porsche", model: "Cayenne", version: "4.1 S Diesel Tiptronic",
    year: 2013, year_note: null, km: 270000, fuel: "Diésel", power_cv: 382, price_eur: 24890,
    stock_status: "unknown", validation_status: "conflict",
    known_defects: null, warranty_note: null,
    conflicts: ["Precio distinto en Wallapop: 24.890 € frente a 23.900 €.", "Etiqueta medioambiental pendiente de conciliación entre portales."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-018", ref_cochesnet: null, ref_wallapop: null,
    make: "Renault", model: "Grand Scénic", version: "Dynamique dCi EDC",
    year: null, year_note: "Año en conflicto: 2013 en el campo de año, 2012 en el título, 2011 en la URL. Pendiente de documentación.",
    km: 320000, fuel: "Diésel", power_cv: 110, price_eur: 3490,
    stock_status: "unknown", validation_status: "conflict",
    known_defects: null, warranty_note: null,
    conflicts: ["Año distinto según campo (2013), título (2012) y URL (2011). No usar ninguno como definitivo sin documentación."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-019", ref_cochesnet: null, ref_wallapop: null,
    make: "Renault", model: "Scénic", version: "Zen Energy dCi",
    year: 2018, year_note: null, km: 259000, fuel: "Diésel", power_cv: 110, price_eur: 7990,
    stock_status: "unknown", validation_status: "conflict",
    known_defects: null, warranty_note: null,
    conflicts: ["Año distinto en Wallapop: 2018 frente a 2017."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-020", ref_cochesnet: null, ref_wallapop: null,
    make: "Seat", model: "Altea XL", version: "1.6 TDI ITech",
    year: 2014, year_note: null, km: 248000, fuel: "Diésel", power_cv: 105, price_eur: 4490,
    stock_status: "unknown", validation_status: "conflict",
    known_defects: null, warranty_note: null,
    conflicts: ["Precio distinto en Wallapop: 4.490 € frente a 4.300 €."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-021", ref_cochesnet: null, ref_wallapop: null,
    make: "Seat", model: "Ibiza", version: "1.9 TDI Sport",
    year: 2008, year_note: null, km: 290000, fuel: "Diésel", power_cv: 105, price_eur: 3490,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-022", ref_cochesnet: null, ref_wallapop: null,
    make: "Toyota", model: "Aygo", version: "1.4D Blue",
    year: 2009, year_note: null, km: 290000, fuel: "Diésel", power_cv: 54, price_eur: 2490,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-023", ref_cochesnet: null, ref_wallapop: null,
    make: "Toyota", model: "Yaris", version: "1.5 Hybrid Active",
    year: 2017, year_note: null, km: 229000, fuel: "Híbrido", power_cv: 100, price_eur: 8490,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-024", ref_cochesnet: null, ref_wallapop: null,
    make: "Volkswagen", model: "Golf VI", version: "2.0 TDI Sport",
    year: 2009, year_note: null, km: 350000, fuel: "Diésel", power_cv: 140, price_eur: 3900,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-025", ref_cochesnet: null, ref_wallapop: null,
    make: "Volkswagen", model: "Golf VI", version: "GTD",
    year: 2009, year_note: null, km: 340000, fuel: "Diésel", power_cv: 170, price_eur: 4990,
    stock_status: "unknown", validation_status: "conflict",
    known_defects: null, warranty_note: null,
    conflicts: ["Año distinto en Wallapop: 2009 frente a 2010."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-026", ref_cochesnet: null, ref_wallapop: null,
    make: "Volkswagen", model: "Passat Variant", version: "Business DSG",
    year: 2022, year_note: null, km: 197000, fuel: "Diésel", power_cv: 122, price_eur: 11990,
    stock_status: "unknown", validation_status: "conflict",
    known_defects: null, warranty_note: null,
    conflicts: [
      "Precio distinto en Wallapop: 11.990 € frente a 11.490 €.",
      "Kilometraje distinto en Wallapop: 197.000 km frente a 190.000 km.",
      "Referencias contradictorias sobre garantía en el texto de Wallapop.",
    ],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-027", ref_cochesnet: null, ref_wallapop: null,
    make: "Volkswagen", model: "Polo", version: "1.4 Advance",
    year: 2012, year_note: null, km: 210000, fuel: "Gasolina", power_cv: 85, price_eur: 4990,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-028", ref_cochesnet: null, ref_wallapop: null,
    make: "Volkswagen", model: "Tiguan", version: "R-Line DSG 4M",
    year: 2010, year_note: null, km: 350000, fuel: "Diésel", power_cv: 140, price_eur: 6490,
    stock_status: "unknown", validation_status: "conflict",
    known_defects: null, warranty_note: null,
    conflicts: ["Precio distinto en Wallapop: 6.490 € frente a 5.990 €."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-029", ref_cochesnet: null, ref_wallapop: null,
    make: "Fiat", model: "Doblò Panorama", version: "Dynamic 1.6 Multijet",
    year: 2012, year_note: null, km: 270000, fuel: "Diésel", power_cv: 90, price_eur: 1990,
    stock_status: "not_roadworthy", validation_status: "conflict",
    known_defects: "DEFECTO GRAVE publicado en Wallapop: el motor no arranca. Causa no determinada. No ofrecer como listo para circular ni para prueba de conducción.",
    warranty_note: "Sin indicación de garantía en la ficha observada.",
    conflicts: ["Defecto grave (motor no arranca) solo consta en Wallapop, no en coches.net -- pedir confirmación al negocio antes de mencionarlo u omitirlo."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-030", ref_cochesnet: null, ref_wallapop: null,
    make: "Fiat", model: "Doblò Panorama", version: "Lounge 1.6 Multijet",
    year: 2016, year_note: null, km: 290000, fuel: "Diésel", power_cv: 105, price_eur: 5990,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null,
    conflicts: ["No confundir con la Doblò 2012 (lucero-029), que sí tiene un defecto grave publicado."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-031", ref_cochesnet: null, ref_wallapop: null,
    make: "Fiat", model: "Talento", version: "M1 SX Corto 1.6 EcoJet",
    year: 2017, year_note: null, km: 230000, fuel: "Diésel", power_cv: 145, price_eur: 14990,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-032", ref_cochesnet: null, ref_wallapop: null,
    make: "Ford", model: "Transit", version: "350 L3H2",
    year: 2024, year_note: null, km: 237000, fuel: "Diésel", power_cv: 130, price_eur: 13990,
    stock_status: "unknown", validation_status: "conflict",
    known_defects: null, warranty_note: null,
    conflicts: ["Kilometraje distinto en Wallapop: 237.000 km frente a 238.000 km."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-033", ref_cochesnet: null, ref_wallapop: null,
    make: "Iveco", model: "Daily", version: "2.3 TD 35C12",
    year: 2021, year_note: null, km: 240000, fuel: "Diésel", power_cv: 116, price_eur: 13490,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-034", ref_cochesnet: null, ref_wallapop: null,
    make: "Peugeot", model: "Boxer", version: "335 L3",
    year: 2022, year_note: null, km: 190000, fuel: "Diésel", power_cv: 140, price_eur: 26900,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null,
    conflicts: ["Wallapop lo anuncia con frigorífico y trampilla -- confirmar certificado y condiciones del equipo frigorífico antes de mencionarlos."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-035", ref_cochesnet: null, ref_wallapop: null,
    make: "Peugeot", model: "Expert", version: "Asphalt 1.5 BlueHDi Standard",
    year: 2020, year_note: null, km: 240000, fuel: "Diésel", power_cv: 120, price_eur: 8990,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null,
    conflicts: ["Hay varias unidades Expert con datos parecidos (lucero-035, 036, 037) -- no fusionarlas sin referencia interna."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-036", ref_cochesnet: null, ref_wallapop: null,
    make: "Peugeot", model: "Expert", version: "BlueHDi Long",
    year: 2023, year_note: null, km: 200000, fuel: "Diésel", power_cv: 102, price_eur: 9990,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null,
    conflicts: ["Hay varias unidades Expert con datos parecidos (lucero-035, 036, 037) -- no fusionarlas sin referencia interna."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-037", ref_cochesnet: null, ref_wallapop: null,
    make: "Peugeot", model: "Expert", version: "Pro 1.5 BlueHDi Long",
    year: 2022, year_note: null, km: 220000, fuel: "Diésel", power_cv: 102, price_eur: 9990,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: null,
    conflicts: ["Hay varias unidades Expert con datos parecidos (lucero-035, 036, 037) -- no fusionarlas sin referencia interna."],
    source: SOURCE, source_updated_at: OBSERVED,
  },
  {
    id: "lucero-038", ref_cochesnet: null, ref_wallapop: null,
    make: "Volkswagen", model: "Transporter", version: "Caja Plataforma Doble Cabina",
    year: 2014, year_note: null, km: 428000, fuel: "Diésel", power_cv: 114, price_eur: 7990,
    stock_status: "unknown", validation_status: "observed_public",
    known_defects: null, warranty_note: "6 meses (mención histórica, no política confirmada).", conflicts: [],
    source: SOURCE, source_updated_at: OBSERVED,
  },
];
