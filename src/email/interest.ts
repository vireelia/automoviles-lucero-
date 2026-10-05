// Decide si un correo es de un cliente interesado antes de contestarlo.
// Reglas explícitas y auditables: lo que no encaja no recibe respuesta
// automática y pasa a revisión humana.

// Solo correo automático o masivo: no hay una persona al otro lado que
// pueda recibir una respuesta. Cualquier correo escrito por alguien se atiende.
const AUTOMATED_ONLY = [
  /\b(darse de baja|baja de (la )?lista|unsubscribe|dar de baja)\b/i,
  /\b(newsletter|boletín|webinar|promoci[oó]n de (lanzamiento|oferta)|descuento exclusivo)\b/i,
];

const INTERESTED = [
  /\b(coche|coches|veh[ií]culo|vehiculos|veh[ií]culos|furgoneta|furgonetas|todoterreno|suv|monovolumen|berlina|familiar|4x4)\b/i,
  /\b(precio|cu[aá]nto cuesta|cu[aá]nto vale|cu[aá]nto es|oferta|financ\w*|plazos|cuota)\b/i,
  /\b(cita|visitar|ver el|ver la|probar|prueba|quedar|pasar por|ir a ver)\b/i,
  /\b(reservar|reserva|apartar|se\s+lo\s+llevo|me lo llevo)\b/i,
  /\b(tasar|tasaci[oó]n|valorar|vender mi|quiero vender|compr\w*|busco)\b/i,
  /\b(disponible|kil[oó]metros|kms?|garant[ií]a|itv|matr[ií]cula|motor|diesel|gasolina|h[ií]brido|el[eé]ctrico)\b/i,
  /\b(golf|polo|astra|corsa|clio|megane|kuga|focus|qashqai|tiguan|x[1-7]|serie [1-7]|a[1-8]|c[1-5]|ibiza|leon|octavia|fiesta|tucson|sportage|berlingo|doblo|transit|jumper|ducato|vito|sprinter)\b/i,
  /\b(car|cars|van|vans|price|how much|appointment|finance|financing|test drive|buy|reserve|sell my car)\b/i,
];

export type InterestDecision = { interested: boolean; reason: string };

export function decideInterest(input: { subject: string; text: string; hasPriorThread: boolean }): InterestDecision {
  const body = `${input.subject}\n${input.text}`;
  if (AUTOMATED_ONLY.some((r) => r.test(body))) {
    return { interested: false, reason: "correo_masivo_o_baja" };
  }
  if (input.hasPriorThread) {
    return { interested: true, reason: "conversacion_previa" };
  }
  if (INTERESTED.some((r) => r.test(body))) {
    return { interested: true, reason: "pregunta_sobre_vehiculos_o_servicios" };
  }
  return { interested: true, reason: "persona_sin_tema_claro" };
}
