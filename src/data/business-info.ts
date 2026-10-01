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
  language: {
    primary: "es-ES",
    secondary: ["en", "otros idiomas de la Unión Europea (italiano, francés, rumano, etc.)"],
    note: "Ampliado 29/09/2026 en llamada real con Ramón: detectar y responder en el idioma del cliente cuando sea un idioma de la UE, no solo español/inglés.",
    validation_status: "owner_confirmed",
  },
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
  ],
  responsables: {
    ramon: { role: "Responsable. Gestiona financiación internamente. Confirma reservas/ventas.", transfer_number: "+34622188213", validation_status: "owner_confirmed" },
    jose: { role: "Responsable (hermano de Ramón).", transfer_number: "+34624807067", validation_status: "owner_confirmed" },
    transfer_priority: "Preguntar al cliente con cuál de los dos prefiere hablar (Ramón o José); se transfiere primero a ese, y si no contesta, automáticamente al otro sin volver a preguntar.",
    note: "Número de José corregido 01/10/2026 a +34624807067 (antes +34624807069, dígito final equivocado). Número personal de Ramón para transferencia de llamada confirmado 01/10/2026: +34622188213, distinto del +34622177052 que es el WhatsApp del negocio. transfer_call en vivo activado en el agente de voz. Desde 01/10/2026 (decisión del cliente), ya no hay un orden fijo Ramón->José: el responsable se elige preguntando antes de transferir.",
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
    unresolved_conflict:
      "En la llamada real del 29/09/2026, Ramón repitió SIN que se lo preguntaran los mismos números de arriba (3.000€/300.000km/15 años). Pero minutos después, cuando Eliud leyó en voz alta una regla distinta para 'confirmarla' (más de 4.000€ y menos de 280.000km -- cifras de una investigación previa, no de esta especificación), Ramón también dijo 'sí'. No se resolvió cuál es la correcta -- probablemente confirmó de pasada sin comparar las dos cifras. Se mantienen 3.000€/300.000km/15 años porque están triple-confirmados (documento + dicho dos veces por Ramón sin que se lo pidieran) frente a un 'sí' aislado a una pregunta de verificación. PREGUNTAR A RAMÓN para resolver del todo antes de publicar en producción si hay dudas.",
    process: ["DNI", "Validación de DNI (por correo electrónico)", "Validación bancaria (genera informe al banco de si el cliente es apto)"],
    no_extra_docs_needed: "No requiere nómina, contrato de trabajo ni antigüedad laboral -- la validación bancaria ya cubre eso (confirmado 29/09/2026).",
    approval_note: "Ramón gestiona el proceso internamente; la aprobación final la da la entidad financiera. Nunca prometer aprobación, cuota, TIN o TAE sin herramienta autorizada.",
    do_not_ask_as_qualifying_question: "Confirmado 29/09/2026: no preguntar si el cliente quiere financiación como parte de la captación de datos del lead -- solo tratarlo si el cliente lo saca.",
    cash_preference_note: "Hay vehículos que se venden solo al contado; en general el contado es la preferencia del negocio, aunque no hay una lista cerrada de qué unidades exactamente.",
    validation_status: "owner_confirmed",
    source: "Especificación maestra 29/09/2026 (Sección 16) + llamada real 29/09/2026.",
  },
  warranty: {
    duration_months: 12,
    max_km: 20000,
    rule: "El que ocurra primero (12 meses o 20.000 km).",
    covers: ["Motor", "Caja de cambios"],
    on_disputed_case: "No decidir si una avería concreta entra en garantía -- derivar siempre al vendedor.",
    validation_status: "owner_confirmed",
    source: "Especificación maestra 29/09/2026 (Sección 17) + reconfirmado textualmente en llamada real 29/09/2026.",
  },
  transfer_fee: {
    amount_eur: null,
    validation_status: "pending",
    note: "NUNCA decir 130€ ni ningún importe. Responder que se cobra aparte y que el vendedor confirma el importe.",
  },
  reservation: {
    amount_eur: 500,
    duration_days: 15,
    bank_account_iban: null, // PENDIENTE: Ramón dijo que se le pasa al cliente en el momento si lo pide, pero no dio el número de cuenta real en esta llamada -- no inventar un IBAN. En cuanto se confirme, el agente puede darlo directamente (ver proactive_upsell).
    flow_note: "CREATE_RESERVATION_PENDING -> instrucciones de pago (nº de cuenta, pendiente de confirmar) -> cliente paga -> cliente envía justificante por WhatsApp AL NÚMERO DEL NEGOCIO indicando marca/modelo/matrícula -> validación humana (normalmente Ramón revisa el justificante) -> RESERVED. Nunca marcar RESERVED solo porque el cliente diga 'ya pagué'.",
    proactive_upsell: "Confirmado 29/09/2026: Ramón quiere que el agente ofrezca la reserva de forma proactiva y vendedora cuando detecte interés real -- no es venta agresiva, es informar de un hecho real: si no lo reserva, alguien más puede comprarlo primero. No es 'urgencia falsa' (el dato es cierto), pero tampoco inventar plazos o compradores concretos que no existen.",
    priority_rule: "Prioridad de quien primero ingresa Y envía justificante. Cita, mensaje o interés NO dan prioridad (Sección 27). Confirmado 29/09/2026: PUEDEN existir varias reservas pendientes en paralelo para el mismo coche (varias personas intentando pagar) -- el vehículo solo queda RESERVED de verdad cuando el equipo confirma la primera que llegó con justificante válido; las demás quedan canceladas automáticamente en ese momento.",
    return_note: "Confirmado 29/09/2026: la señal solo es reembolsable si el vehículo resulta tener una avería. En cualquier otro caso, no es reembolsable -- si hay disputa sobre esto, escalar siempre a HUMAN_HANDOFF, el agente nunca decide.",
    proforma_invoice_note: "Confirmado 29/09/2026: cuando alguien pide un presupuesto/factura proforma de un vehículo (típicamente para pedir un préstamo al banco), se le pide el mismo adelanto de 500€ que a una reserva -- es el mismo flujo, no un trámite aparte.",
    out_of_madrid_advance_eur: 500,
    validation_status: "owner_confirmed",
    source: "Especificación maestra 29/09/2026 (Secciones 25-29) + llamada real 29/09/2026.",
  },
  procedures: {
    known_types: ["Transferencia de vehículo", "Cambio de titularidad", "Informe DGT", "Baja de vehículo"],
    pricing_available: false,
    validation_status: "pending",
  },
  purchase_from_individuals: {
    services: ["Compra de coches", "Compra de furgonetas (interés especial)", "Compra de todoterrenos", "Compra de vehículos industriales"],
    capture_progressively: ["nombre", "teléfono", "marca", "modelo", "año", "kilómetros", "motor", "matrícula", "estado", "ITV", "fotos", "precio esperado", "financiación/cargas pendientes"],
    matricula_note: "La matrícula SÍ se pide aquí (del coche que trae el cliente para vender/tasar) -- distinto de la regla de no dar la matrícula de los coches en venta del propio inventario de Lucero.",
    no_limits: "Confirmado 29/09/2026: compran de todo, sin límite de antigüedad/km/precio/estado para estudiar un vehículo -- interés especial en furgonetas.",
    never_auto_appraise: true,
    validation_status: "owner_confirmed_process_unconfirmed_pricing",
    source: "Especificación maestra 29/09/2026 (Sección 34) + llamada real 29/09/2026.",
  },
  appointment_types: ["visita", "prueba", "tasacion", "reserva_comercial"],
  appointment_types_note: "Confirmado 29/09/2026: en la práctica casi todo es 'visita' (ver el coche); si ya están decididos, se les dice que vengan directamente y se cierra ahí mismo (entrega/financiación in situ). No presentar los 4 tipos como opciones separadas de agenda -- es una sola cita real.",
  test_drive: { requires_license: true, note: "Prueba breve por la zona (una vuelta a la manzana). No inventar restricciones de edad.", source: "Especificación maestra 29/09/2026 (Sección 24) + llamada real 29/09/2026." },
  delivery_note: "Confirmado 29/09/2026: la entrega normalmente se hace al momento, el mismo día que se cierra la operación. No prometer un plazo distinto salvo que haya trámites pendientes que lo impidan.",
  vehicle_history_disclaimer: "Confirmado 29/09/2026: Automóviles Lucero es una COMPRAVENTA, no el propietario original -- no conocen el historial completo (propietarios anteriores, reparaciones previas a la compra, etc.). Ante preguntas de ese tipo, la respuesta honesta no es 'lo confirma el vendedor' sino explicar que, al ser compraventa, no tienen el historial completo del vehículo antes de que entrara en el concesionario.",
  privacy_rule: "Confirmado 29/09/2026: el agente nunca debe compartir datos personales de la empresa ni de las personas (ni de Ramón/José, ni de otros clientes). Tampoco debe sobre-especificar información en general.",
  reminder: { hours_before: 2, channel: "WhatsApp (automatización pendiente de integración real)" },
  followups: { max_automatic: 3, rule: "No usar mensajes repetitivos tipo '¿sigues interesado?'. Aportar valor (vehículo nuevo, alternativa, actualización, enlace). Después del tercero: STOP." },
  similar_vehicles_match: { price_range_eur: 2000, km_range: 50000, same_category_priority: true, limit: 3 },
  lead_scoring: {
    levels: ["COLD", "WARM", "HOT"],
    hot_signals: ["voy ahora", "me lo llevo", "quiero reservar", "pásame la cuenta", "quiero comprarlo hoy", "tengo el dinero", "lo antes posible", "voy para allá y me lo llevo hoy mismo"],
    never_reveal_to_client: true,
    hot_action: "Notificar al vendedor inmediatamente (create_handoff/notify_salesperson con urgencia alta).",
  },
  qualifying_lead_fields: {
    ask: ["nombre", "teléfono", "coche de interés", "fecha prevista de compra/visita"],
    never_ask_as_qualifying_question: ["financiación (sí/no)"],
    note: "Confirmado 29/09/2026: venta rápida, sin meter al cliente en el tema de financiación como parte de la captación de datos.",
  },
  returning_customer_note: "Confirmado 29/09/2026: si el mismo teléfono ya contactó antes, el agente puede y debe referenciarlo de forma natural (ej. 'hablamos antes sobre el Audi Q3') usando get_customer_history -- no hacerle repetir lo ya dicho.",
  escalation_triggers: [
    "cliente quiere cerrar", "cliente pide vendedor", "negociación concreta", "condición especial",
    "reclamación", "disputa", "devolución", "financiación compleja", "información no disponible",
    "pregunta específica no verificable", "riesgo de error",
  ],
  sale_confirmation_rule: "La IA nunca marca SOLD solo porque el cliente diga que compra. Flujo: HOT -> Ramón/José -> operación confirmada -> SOLD.",
  inventory_sources: { primary: ["coches.net", "wallapop"], integration_status: "PENDING_INTEGRATION -- sin API/acceso autorizado. No inventar endpoints ni hacer scraping agresivo. Fuente intermedia actual: catálogo cargado internamente (ver vehicles-seed.ts)." },
  pending_from_owner: [
    "Acceso de lectura real a Coches.net/Wallapop (Eliud lo pedirá directamente, fuera de esta llamada)",
    "Número de transferencia COMPLETO de José (solo se capturó '624...' en llamada real)",
    "Número de cuenta bancaria (IBAN) real para instrucciones de pago de reservas",
    "Tipo de cuenta de WhatsApp (App o Business Platform) y si conserva historial",
    "Precio de transferencia de vehículo",
    "Tarifas de trámites (transferencia, cambio de titularidad, informe DGT, baja) -- NUNCA usar la cifra de 130€ mencionada antes hasta que el negocio confirme exactamente qué incluye",
    "Discrepancias de vehículos observadas entre coches.net y Wallapop (ver conflicts por unidad)",
    "Confirmación de si el proveedor de financiación sigue siendo Lendrock",
    "Resolver la contradicción de umbrales de financiación (ver financing.unresolved_conflict)",
    "Número de teléfono nuevo a comprar para conectar el agente de voz (Eliud gestiona esto, no Ramón)",
    "Quién paga el número nuevo y el consumo de llamadas",
    "Si la IA debe atender el teléfono 24h o solo en horario de oficina (las citas que ofrezca siempre deben caer dentro del horario confirmado, eso ya está resuelto)",
  ],
};
