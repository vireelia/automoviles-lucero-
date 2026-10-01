// Semilla de inventario REAL -- exportación oficial de Coches.net PRO
// (fuente del propio negocio, Automóviles Lucero), importada 01/10/2026.
// Sustituye por completo el catálogo anterior basado en observación pública
// (Secciones 19-21 del encargo) -- esta es la fuente intermedia real que
// permite la Sección 49 (INVENTORY_PROVIDER) mientras no haya integración
// automática por API/feed en vivo con Coches.net. category viene directo del
// campo real "carroceria" del feed, no inventado -- valores reales observados:
// ['4x4', 'Berlina', 'Familiar', 'Industriales', 'Monovolumen'].
//
// Para regenerar este archivo a partir de un nuevo export XML de Coches.net
// PRO, ver scripts/import-cochesnet.mjs.

export type Vehicle = {
  id: string;
  ref_cochesnet: string | null;
  ref_wallapop: string | null;
  category: "Monovolumen" | "Berlina" | "Industriales" | "4x4" | "Familiar";
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

const SOURCE = "Coches.net PRO (exportación oficial del negocio, feed XML)";
const IMPORTED = "2026-10-01";

export const vehiclesSeed: Vehicle[] = [
  {
    id: "lucero-cn20638303", ref_cochesnet: null, ref_wallapop: null,
    category: "Monovolumen",
    make: "Mercedes-Benz", model: "Clase R", version: "R 320 CDI 4MATIC",
    year: 2006, year_note: null, km: 516000, fuel: "Diesel", power_cv: 224, price_eur: 9490,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20643841", ref_cochesnet: null, ref_wallapop: null,
    category: "Berlina",
    make: "BMW", model: "Serie 3", version: "330d xDrive",
    year: 2010, year_note: null, km: 290000, fuel: "Diesel", power_cv: 245, price_eur: 8890,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20677977", ref_cochesnet: null, ref_wallapop: null,
    category: "Monovolumen",
    make: "Renault", model: "Scenic", version: "Zen Energy dCi 81kW 110CV",
    year: 2018, year_note: null, km: 259000, fuel: "Diesel", power_cv: 110, price_eur: 7990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20687617", ref_cochesnet: null, ref_wallapop: null,
    category: "Industriales",
    make: "Peugeot", model: "Expert", version: "Furgon BlueHDi 100 SS 6v Long",
    year: 2023, year_note: null, km: 200000, fuel: "Diesel", power_cv: 102, price_eur: 9990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20687650", ref_cochesnet: null, ref_wallapop: null,
    category: "Industriales",
    make: "Peugeot", model: "Expert", version: "Furgon Pro 1.5 BlueHDi 100 Long",
    year: 2022, year_note: null, km: 220000, fuel: "Diesel", power_cv: 102, price_eur: 9990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20687707", ref_cochesnet: null, ref_wallapop: null,
    category: "Monovolumen",
    make: "Seat", model: "Altea XL", version: "1.6 TDI 105cv SS EEcomotive ITech",
    year: 2014, year_note: null, km: 248000, fuel: "Diesel", power_cv: 105, price_eur: 4490,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20687766", ref_cochesnet: null, ref_wallapop: null,
    category: "Monovolumen",
    make: "Ford", model: "SMAX", version: "2.0 TDCi Panther 140kW STLine Pow",
    year: 2021, year_note: null, km: 320000, fuel: "Diesel", power_cv: 190, price_eur: 11900,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20688275", ref_cochesnet: null, ref_wallapop: null,
    category: "4x4",
    make: "Volkswagen", model: "Tiguan", version: "2.0 TDI 4M 140cv DSG RLine",
    year: 2010, year_note: null, km: 350000, fuel: "Diesel", power_cv: 140, price_eur: 6490,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20691714", ref_cochesnet: null, ref_wallapop: null,
    category: "Monovolumen",
    make: "Mercedes-Benz", model: "Clase A", version: "A 150",
    year: 2009, year_note: null, km: 310000, fuel: "Gasolina", power_cv: 95, price_eur: 2990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20692684", ref_cochesnet: null, ref_wallapop: null,
    category: "4x4",
    make: "Mitsubishi", model: "Outlander", version: "2.0 DID Kaiteki",
    year: 2007, year_note: null, km: 294000, fuel: "Diesel", power_cv: 140, price_eur: 3990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20693416", ref_cochesnet: null, ref_wallapop: null,
    category: "Industriales",
    make: "Peugeot", model: "Expert", version: "Furgon Asphalt 1.5 BlueHDi 120 Standard",
    year: 2020, year_note: null, km: 240000, fuel: "Diesel", power_cv: 120, price_eur: 8990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20743464", ref_cochesnet: null, ref_wallapop: null,
    category: "Monovolumen",
    make: "Peugeot", model: "5008", version: "Allure 1.6 BlueHDi 120 EAT6",
    year: 2016, year_note: null, km: 280000, fuel: "Diesel", power_cv: 120, price_eur: 4990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20743497", ref_cochesnet: null, ref_wallapop: null,
    category: "Berlina",
    make: "Volkswagen", model: "Polo", version: "1.4 85cv Advance",
    year: 2012, year_note: null, km: 210000, fuel: "Gasolina", power_cv: 85, price_eur: 4990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20743579", ref_cochesnet: null, ref_wallapop: null,
    category: "Monovolumen",
    make: "Mercedes-Benz", model: "Viano", version: "3.0 CDI Trend Larga",
    year: 2012, year_note: null, km: 600000, fuel: "Diesel", power_cv: 224, price_eur: 10900,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20782521", ref_cochesnet: null, ref_wallapop: null,
    category: "Berlina",
    make: "Toyota", model: "Aygo", version: "1.4D Blue",
    year: 2009, year_note: null, km: 290000, fuel: "Diesel", power_cv: 54, price_eur: 2490,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20782640", ref_cochesnet: null, ref_wallapop: null,
    category: "Berlina",
    make: "Volkswagen", model: "Golf", version: "VI 2.0 TDI 170cv GTD",
    year: 2009, year_note: null, km: 340000, fuel: "Diesel", power_cv: 170, price_eur: 4990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20782940", ref_cochesnet: null, ref_wallapop: null,
    category: "Industriales",
    make: "Volkswagen", model: "Transporter", version: "Caja Plataf DC Largo 2.0 TDI BMT 114CV",
    year: 2014, year_note: null, km: 428000, fuel: "Diesel", power_cv: 114, price_eur: 7990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "6 meses", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20783018", ref_cochesnet: null, ref_wallapop: null,
    category: "Industriales",
    make: "Fiat", model: "Doblo", version: "Panorama Lounge 1.6 Multijet 105cv E5",
    year: 2016, year_note: null, km: 290000, fuel: "Diesel", power_cv: 105, price_eur: 5990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20783068", ref_cochesnet: null, ref_wallapop: null,
    category: "Berlina",
    make: "Volkswagen", model: "Golf", version: "VI 2.0 TDI 140cv DPF Sport",
    year: 2009, year_note: null, km: 350000, fuel: "Diesel", power_cv: 140, price_eur: 3900,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20785249", ref_cochesnet: null, ref_wallapop: null,
    category: "Industriales",
    make: "Fiat", model: "Doblo", version: "Panorama Dynamic 1.6 Multijet 90cv",
    year: 2012, year_note: null, km: 270000, fuel: "Diesel", power_cv: 90, price_eur: 1990,
    stock_status: "not_roadworthy", validation_status: "owner_confirmed",
    known_defects: "Avería de motor: el motor gira pero no arranca. Se desconoce la causa (según el anuncio, 'ideal para mecánicos').", warranty_note: null, conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20798257", ref_cochesnet: null, ref_wallapop: null,
    category: "Monovolumen",
    make: "Renault", model: "Grand Scenic", version: "Dynamique dCi 110 EDC 7p 2012",
    year: 2013, year_note: null, km: 320000, fuel: "Diesel", power_cv: 110, price_eur: 3490,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20798607", ref_cochesnet: null, ref_wallapop: null,
    category: "Familiar",
    make: "Peugeot", model: "308", version: "SW Allure BlueHDI 130 SS EAT8",
    year: 2023, year_note: null, km: 200000, fuel: "Diesel", power_cv: 130, price_eur: 8990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20805935", ref_cochesnet: null, ref_wallapop: null,
    category: "Industriales",
    make: "Ford", model: "Transit", version: "350 96kW L3H2 Van DC Trend FWD",
    year: 2024, year_note: null, km: 237000, fuel: "Diesel", power_cv: 130, price_eur: 13990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20805948", ref_cochesnet: null, ref_wallapop: null,
    category: "4x4",
    make: "Audi", model: "Q5", version: "2.0 TDI 170cv quattro DPF",
    year: 2009, year_note: null, km: 320000, fuel: "Diesel", power_cv: 170, price_eur: 7490,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20805977", ref_cochesnet: null, ref_wallapop: null,
    category: "Berlina",
    make: "BMW", model: "Serie 1", version: "120d",
    year: 2006, year_note: null, km: 260000, fuel: "Diesel", power_cv: 163, price_eur: 3900,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20805996", ref_cochesnet: null, ref_wallapop: null,
    category: "4x4",
    make: "Audi", model: "Q3", version: "2.0 TDI 177cv quattro S tronic Advance",
    year: 2012, year_note: null, km: 290000, fuel: "Diesel", power_cv: 177, price_eur: 8490,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20837795", ref_cochesnet: null, ref_wallapop: null,
    category: "Industriales",
    make: "Fiat", model: "Ducato", version: "Furgon Maxi 35 L4H2 Multijet 103 kW",
    year: 2023, year_note: null, km: 198000, fuel: "Diesel", power_cv: 140, price_eur: 14990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20837825", ref_cochesnet: null, ref_wallapop: null,
    category: "Monovolumen",
    make: "Seat", model: "Alhambra", version: "2.0 TDI 110kW 150CV DSG SS St Ad Trav",
    year: 2018, year_note: null, km: 180000, fuel: "Diesel", power_cv: 150, price_eur: 13990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20837864", ref_cochesnet: null, ref_wallapop: null,
    category: "Familiar",
    make: "Volkswagen", model: "Passat", version: "Variant Executive 2.0 TDI 90kW 122CV D",
    year: 2022, year_note: null, km: 190000, fuel: "Diesel", power_cv: 122, price_eur: 11490,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20838012", ref_cochesnet: null, ref_wallapop: null,
    category: "Industriales",
    make: "Fiat", model: "Talento", version: "M1 1.2 SX Corto 1.6 EcoJet 107kW 145CV",
    year: 2017, year_note: null, km: 230000, fuel: "Diesel", power_cv: 145, price_eur: 13990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20838052", ref_cochesnet: null, ref_wallapop: null,
    category: "Industriales",
    make: "Peugeot", model: "Boxer", version: "335 L3 BHDI 103kW 140CV SS 6 Vel. MAN",
    year: 2022, year_note: null, km: 190000, fuel: "Diesel", power_cv: 140, price_eur: 25900,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20838078", ref_cochesnet: null, ref_wallapop: null,
    category: "Berlina",
    make: "Audi", model: "A7", version: "Sportback 50 TDI 210kW quattro triptron.",
    year: 2019, year_note: null, km: 200000, fuel: "Diesel", power_cv: 286, price_eur: 26900,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20838099", ref_cochesnet: null, ref_wallapop: null,
    category: "4x4",
    make: "Audi", model: "SQ7", version: "4.0 TDI quattro tiptronic",
    year: 2017, year_note: null, km: 130000, fuel: "Diesel", power_cv: 435, price_eur: 39900,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20838141", ref_cochesnet: null, ref_wallapop: null,
    category: "4x4",
    make: "Porsche", model: "Cayenne", version: "4.1 S Diesel Tiptronic",
    year: 2013, year_note: null, km: 270000, fuel: "Diesel", power_cv: 382, price_eur: 22900,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20838180", ref_cochesnet: null, ref_wallapop: null,
    category: "Berlina",
    make: "Maserati", model: "Ghibli", version: "S Q4 3.0 V6 BT 410cv AWD",
    year: 2016, year_note: null, km: 177000, fuel: "Gasolina", power_cv: 410, price_eur: 27990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20838262", ref_cochesnet: null, ref_wallapop: null,
    category: "Berlina",
    make: "BMW", model: "Serie 1", version: "118d M Sport Edition",
    year: 2013, year_note: null, km: 285000, fuel: "Diesel", power_cv: 143, price_eur: 5990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20838343", ref_cochesnet: null, ref_wallapop: null,
    category: "Monovolumen",
    make: "Mercedes-Benz", model: "Clase B", version: "B 200 d Urban",
    year: 2016, year_note: null, km: 270000, fuel: "Diesel", power_cv: 136, price_eur: 8990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20838383", ref_cochesnet: null, ref_wallapop: null,
    category: "Monovolumen",
    make: "Ford", model: "SMAX", version: "2.0 TDCi Panther 140kW STLine AWD Pow",
    year: 2021, year_note: null, km: 320000, fuel: "Diesel", power_cv: 190, price_eur: 10990,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
  {
    id: "lucero-cn20866933", ref_cochesnet: null, ref_wallapop: null,
    category: "Monovolumen",
    make: "Nissan", model: "Qashqai+2", version: "1.5 dCi TEKNA SPORT 4x2 17",
    year: 2010, year_note: null, km: 200000, fuel: "Diesel", power_cv: 106, price_eur: 5490,
    stock_status: "available", validation_status: "owner_confirmed",
    known_defects: null, warranty_note: "12 meses (1 año)", conflicts: [],
    source: SOURCE, source_updated_at: IMPORTED,
  },
];
