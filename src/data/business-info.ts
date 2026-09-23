// Datos del negocio (Sección 1 y 2 del encargo). Solo lo marcado como
// confirmado debe presentarse como hecho; todo lo demás lleva su propio
// estado de validación explícito para que el agente no lo trate como firme.

export const businessInfo = {
  name: "Automóviles Lucero",
  activity: "Compra y venta de vehículos. También trámites de vehículos para terceros (según el cliente, sin validar alcance).",
  address: {
    value: "Calle Cayetano Pando, 3, 28047 Madrid",
    validation_status: "owner_confirmed",
  },
  timezone: "Europe/Madrid",
  language: "es-ES",
  profiles: {
    cochesnet: "https://www.coches.net/concesionario/autolunaslagunamadrid/",
    wallapop: "https://es.wallapop.com/user/autolunaslagunam-355383125",
  },
  phones: [
    { number: "622177052", note: "Recuperado en investigación de perfil/directorio, asociado a 'Ramón'.", validation_status: "unconfirmed" },
    { number: "919260191", note: "Recuperado en coches.net -- puede ser línea propia o número de seguimiento del portal.", validation_status: "unconfirmed" },
    { number: "622188213", note: "Publicado en compramostufurgon.com (se presenta como Automóviles Lucero, misma dirección) -- el cliente había dicho que no tenían web.", validation_status: "unconfirmed" },
  ],
  internal_whatsapp_number: null, // PENDIENTE DE CONFIRMAR (Sección 1)
  hours: {
    value: null, // NO usar el horario de compramostufurgon.com hasta que el dueño lo apruebe
    unvalidated_reference: "Web compramostufurgon.com dice L-V 9:30-14:00 y 16:30-19:30, S-D con cita previa, festivos con cita -- SIN VALIDAR, puede haber horario distinto para ventas y gestoría.",
    validation_status: "pending",
  },
  financing: {
    provider: "Lendrock",
    criteria: {
      min_price_eur: 4000,
      min_price_boundary_included: null, // pendiente: ¿exactamente 4.000 € entra?
      max_km: 280000,
      max_km_boundary_included: null, // pendiente: ¿exactamente 280.000 km entra?
    },
    note: "Cumplir estos criterios no significa financiación aprobada. Requiere estudio. El agente nunca la aprueba ni calcula cuota/TIN/TAE.",
    validation_status: "pending_boundary_confirmation",
  },
  procedures: {
    // Nota interna: el cliente mencionó una cifra de 130 € para un trámite sin
    // identificar cuál, si incluye impuestos/tasas, ni qué se cobra aparte.
    // Instrucción explícita del dueño (23/09/2026): NO indicar precios ni
    // gastos de trámites hasta que estén aprobados -- por eso esta cifra NO
    // se expone en el objeto de respuesta, solo en este comentario de fuente.
    known_types: [
      "Transferencia de vehículo",
      "Cambio de titularidad",
      "Informe DGT",
      "Baja de vehículo",
    ],
    pricing_available: false,
    validation_status: "pending",
  },
  purchase_from_individuals: {
    services: ["Compra de coches", "Compra de furgonetas", "Compra de todoterrenos", "Compra de vehículos industriales"],
    claims_unvalidated: ["Tasación gratuita", "Rapidez de pago y tramitación"],
    validation_status: "pending",
  },
  appointment_types: ["Visita", "Prueba de conducción", "Tasación", "Reserva comercial"],
  pending_from_owner: [
    "Horarios oficiales y festivos",
    "Teléfonos y responsables",
    "WhatsApp interno para resúmenes",
    "Fuente maestra de stock",
    "Discrepancias de vehículos (Sección 21)",
    "Acceso autorizado al inventario",
    "Límites exactos de financiación (4.000 € y 280.000 km, ¿incluidos?)",
    "Criterios adicionales de Lendrock",
    "Trámite de 130 € y qué incluye",
    "Política de compra a particulares",
    "Garantías por vehículo",
    "Reserva, señal y cancelaciones",
    "Entrega y pruebas de conducción",
    "Descuentos autorizados",
    "Agenda y autoridad para confirmar citas",
    "Transferencia de llamada y devolución de llamadas",
    "Privacidad, grabación/transcripción y conservación",
  ],
};
