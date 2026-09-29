// Datos del negocio. Fuente principal desde 29/09/2026: "ESPECIFICACIÓN
// MAESTRA DE PRODUCCIÓN" confirmada por el responsable de Automóviles
// Lucero (Ramón/José) -- prevalece sobre cualquier dato genérico anterior
// observado en coches.net/Wallapop/compramostufurgon.com. Solo lo marcado
// owner_confirmed debe presentarse como hecho; el resto lleva su propio
// estado de validación para que el agente no lo trate como firme.

export const businessInfo = {
  name: "Automóviles Lucero",
  activity: "Compraventa de vehículos.",
  location: {
    address: { value: "Calle Cayetano Pando, 3, 28047 Madrid", validation_status: "owner_confirmed" },
    zone: "Carabanchel / Lucero, Madrid",
    references: ["Metro Lucero", "Metro/Renfe Laguna"],
    references_note: "Aproximadamente 300 metros según información proporcionada por el negocio -- no dar la distancia como medición exacta.",
  },
  timezone: "Europe/Madrid",
  language: { primary: "es-ES", secondary: "en", note: "Detectar idioma del cliente cuando sea posible (Sección 41)." },
  profiles: {
    cochesnet: "https://www.coches.net/concesionario/autolunaslagunamadrid/",
    wallapop: "https://es.wallapop.com/user/autolunaslagunam-355383125",
  },
  whatsapp: {
    number: "622177052",
    validation_status: "owner_confirmed",
    source: "Especificación maestra 29/09/2026 -- 'WHATSAPP INDICADO'.",
    note: "Número indicado por el negocio. Si es cuenta de WhatsApp App o Business Platform, y si conserva historial/uso actual, sigue sin confirmar (punto 7 del cuestionario) -- no asumir capacidad técnica de envío automático todavía.",
  },
  phones_unconfirmed: [
    { number: "919260191", note: "Recuperado en coches.net -- puede ser línea propia o número de seguimiento del portal.", validation_status: "unconfirmed" },
    { number: "622188213", note: "Publicado en compramostufurgon.com (misma dirección) -- sin confirmar relación exacta.", validation_status: "unconfirmed" },
  ],
  responsables: {
    ramon: { role: "Responsable. Gestiona financiación internamente.", transfer_number: null, validation_status: "name_confirmed_number_pending" },
    jose: { role: "Responsable.", transfer_number: null, validation_status: "name_confirmed_number_pending" },
    note: "Número de transferencia específico de José pendiente de configurar (Sección 2). Hasta entonces no usar transfer_call en vivo -- registrar con create_handoff.",
  },
  hours: {
    weekdays: { visits: ["09:30-14:00", "16:30-19:00"] },
    weekend: "Solo con cita previa y confirmación.",
    validation_status: "owner_confirmed",
    source: "Especificación maestra 29/09/2026 (Sección 21).",
  },
  financing: {
    provider_note: "Provisto anteriormente como 'Lendrock' en investigación previa -- no restated en la especificación maestra 29/09/2026, no asumir que sigue siendo el mismo proveedor sin confirmar.",
    criteria: {
      min_price_eur: 3000,
      min_price_inclusive: true,
      max_km: 300000,
      max_km_inclusive: false, // el documento dice literalmente "menos de 300.000 km"
      max_age_years: 15,
      max_age_inclusive: true,
      term_months: { min: 36, max: 72 },
      no_down_payment_possible: true,
    },
    process: ["DNI", "Validación de DNI", "Validación bancaria"],
    approval_note: "Ramón gestiona el proceso internamente; la aprobación final la da la entidad financiera. Nunca prometer aprobación, cuota, TIN o TAE sin herramienta autorizada.",
    validation_status: "owner_confirmed",
    source: "Especificación maestra 29/09/2026 (Sección 16).",
  },
  warranty: {
    duration_months: 12,
    max_km: 20000,
    rule: "El que ocurra primero (12 meses o 20.000 km).",
    covers: ["Motor", "Caja de cambios"],
    on_disputed_case: "No decidir si una avería concreta entra en garantía -- derivar siempre al vendedor.",
    validation_status: "owner_confirmed",
    source: "Especificación maestra 29/09/2026 (Sección 17).",
  },
  transfer_fee: {
    amount_eur: null,
    validation_status: "pending",
    note: "NUNCA decir 130€ ni ningún importe. Responder que se cobra aparte y que el vendedor confirma el importe.",
  },
  reservation: {
    amount_eur: 500,
    duration_days: 15,
    flow_note: "CREATE_RESERVATION_PENDING -> instrucciones de pago -> cliente paga -> cliente envía justificante -> validación humana -> RESERVED. Nunca marcar RESERVED solo porque el cliente diga 'ya pagué'.",
    priority_rule: "Prioridad de quien primero ingresa Y envía justificante. Cita, mensaje o interés NO dan prioridad (Sección 27).",
    return_note: "Devoluciones vinculadas a avería del vehículo -- no interpretar legalmente cada caso, escalar siempre a HUMAN_HANDOFF (Sección 28).",
    out_of_madrid_advance_eur: 500,
    validation_status: "owner_confirmed",
    source: "Especificación maestra 29/09/2026 (Secciones 25-29).",
  },
  procedures: {
    known_types: ["Transferencia de vehículo", "Cambio de titularidad", "Informe DGT", "Baja de vehículo"],
    pricing_available: false,
    validation_status: "pending",
  },
  purchase_from_individuals: {
    services: ["Compra de coches", "Compra de furgonetas (interés especial)", "Compra de todoterrenos", "Compra de vehículos industriales"],
    capture_progressively: ["nombre", "teléfono", "marca", "modelo", "año", "kilómetros", "motor", "matrícula", "estado", "ITV", "fotos", "precio esperado", "financiación/cargas pendientes"],
    never_auto_appraise: true,
    validation_status: "owner_confirmed_process_unconfirmed_pricing",
    source: "Especificación maestra 29/09/2026 (Sección 34).",
  },
  appointment_types: ["visita", "prueba", "tasacion", "reserva_comercial"],
  test_drive: { requires_license: true, note: "Prueba breve por la zona. No inventar restricciones de edad.", source: "Especificación maestra 29/09/2026 (Sección 24)." },
  reminder: { hours_before: 2, channel: "WhatsApp (automatización pendiente de integración real)" },
  followups: { max_automatic: 3, rule: "No usar mensajes repetitivos tipo '¿sigues interesado?'. Aportar valor (vehículo nuevo, alternativa, actualización, enlace). Después del tercero: STOP." },
  similar_vehicles_match: { price_range_eur: 2000, km_range: 50000, same_category_priority: true, limit: 3 },
  lead_scoring: {
    levels: ["COLD", "WARM", "HOT"],
    hot_signals: ["voy ahora", "me lo llevo", "quiero reservar", "pásame la cuenta", "quiero comprarlo hoy", "tengo el dinero"],
    never_reveal_to_client: true,
    hot_action: "Notificar al vendedor inmediatamente (create_handoff/notify_salesperson con urgencia alta).",
  },
  escalation_triggers: [
    "cliente quiere cerrar", "cliente pide vendedor", "negociación concreta", "condición especial",
    "reclamación", "disputa", "devolución", "financiación compleja", "información no disponible",
    "pregunta específica no verificable", "riesgo de error",
  ],
  sale_confirmation_rule: "La IA nunca marca SOLD solo porque el cliente diga que compra. Flujo: HOT -> Ramón/José -> operación confirmada -> SOLD.",
  inventory_sources: { primary: ["coches.net", "wallapop"], integration_status: "PENDING_INTEGRATION -- sin API/acceso autorizado. No inventar endpoints ni hacer scraping agresivo. Fuente intermedia actual: catálogo cargado internamente (ver vehicles-seed.ts)." },
  pending_from_owner: [
    "Acceso autorizado a Coches.net/Wallapop (API o método) para inventario en vivo",
    "Número de transferencia de llamada de José",
    "Tipo de cuenta de WhatsApp (App o Business Platform) y si conserva historial",
    "Precio de transferencia de vehículo",
    "Tarifas de trámites (transferencia, cambio de titularidad, informe DGT, baja)",
    "Discrepancias de vehículos observadas entre coches.net y Wallapop (ver conflicts por unidad)",
    "Confirmación de si el proveedor de financiación sigue siendo Lendrock",
  ],
};
