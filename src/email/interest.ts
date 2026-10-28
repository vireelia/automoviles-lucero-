// Decide si un correo es de un cliente interesado antes de contestarlo.
// Reglas explícitas y auditables: lo que no encaja no recibe respuesta
// automática y pasa a revisión humana.

// Solo correo automático o masivo: no hay una persona al otro lado que
// pueda recibir una respuesta. Cualquier correo escrito por alguien se atiende.
const AUTOMATED_ONLY = [
  /\b(darse de baja|baja de (la )?lista|unsubscribe|dar de baja)\b/i,
  /\b(newsletter|boletín|webinar|promoci[oó]n de (lanzamiento|oferta)|descuento exclusivo)\b/i,
  // FALLO REAL detectado (15/10/2026): el propio Coches.net manda correos de
  // marketing/sugerencias ("comunicacion@...coches.net", "sugerencias@...")
  // con coches populares -- esto NO es un cliente real preguntando, es
  // publicidad del portal, y se coló porque mencionaba modelos de coches.
  /\b(los m[aá]s populares|no te quedes sin ellos|coches que viste|recomendados para ti|basado en tu b[uú]squeda)\b/i,
  // FALLO REAL detectado (16/10/2026): Coches.net también manda avisos
  // informativos de actividad telefónica en el perfil del concesionario
  // ("Contacto de llamada atendida/no atendida desde el perfil...") -- esto
  // es un registro de que entró una llamada, no un cliente escribiendo un
  // mensaje que haya que contestar. El agente le respondía "¿en qué puedo
  // ayudarte?" a un aviso automático sin nadie al otro lado leyéndolo.
  /\bcontacto de llamada (atendida|no atendida)\b/i,
];

// Remitentes de marketing/boletín de los propios portales (nunca un cliente
// real detrás) -- se descarta por el remitente, sin depender de palabras
// concretas en el cuerpo.
const MARKETING_SENDER = /\b(comunicacion|sugerencias|newsletter|noticias|marketing)@/i;

// FALLO REAL detectado (16/10/2026, tras permitir clientes directos sin
// portal): plataformas B2B del propio sector (subastas/renting entre
// profesionales, nunca un cliente particular) se colaban porque sus
// boletines van llenos de marcas/modelos reales -- coinciden con las
// palabras de INTERESTED de pura casualidad. Autorola es una plataforma
// real de subastas de vehículos entre concesionarios, confirmado con dos
// respuestas reales sin sentido hoy mismo ("veo que me has enviado
// información sobre una subasta de vehículos..."). Se descarta por dominio
// del remitente, igual que MARKETING_SENDER.
// FALLO REAL detectado (26/10/2026, "estan saliendo muchos errores de
// correos" -- confirmado con un rebote real de Gmail: "Tu mensaje no se ha
// entregado a mail@info.auto1.com porque no se ha encontrado el dominio").
// Auto1 es otra plataforma B2B real del sector (compraventa de vehículos
// entre profesionales) -- mismo problema que Autorola, Daniel le contestó
// como si fuera un cliente y, además, ese dominio de envío ni siquiera
// admite respuestas (sin servidor de correo), así que el rebote volvía al
// buzón real del negocio. Lista en vez de una sola regex, para que la
// próxima plataforma B2B que aparezca sea una línea más, no una reescritura.
const B2B_INDUSTRY_SENDER = [/@mail\.autorola\.es$/i, /@([a-z0-9-]+\.)?auto1\.com$/i];

// Bancos/entidades financieras y publicidad (a petición real, 15/10/2026,
// tras el fallo del bucle de autorespuesta): el agente de correo tiene
// PROHIBIDO contestar esto automáticamente, nunca, aunque mencione algo
// comercial de pasada -- siempre a revisión humana.
const BANK_OR_ADS = [
  /\b(banco|bbva|santander|caixabank|la caixa|ing direct|openbank|bankinter|unicaja|sabadell|revolut|n26|wise)\b/i,
  // FALLO REAL detectado (27/10/2026, caso real: un correo de "Comprobante
  // transferencia" de info@caixabank.es -- una transferencia REAL que Ramón
  // había hecho él mismo -- se contestó como si fuera un cliente): el texto
  // decía "transferencia realizada", no "recibida"/"enviada" como cubría
  // esta regex, y el remitente nunca se comprobaba aquí, solo el cuerpo --
  // el nombre del banco no aparece en el texto de un comprobante real, solo
  // en el remitente. Añadido "realizada"/"procesada" y variantes de
  // comprobante/justificante.
  /\b(movimiento\s+bancario|extracto|saldo\s+de\s+tu\s+cuenta|cargo\s+en\s+tu\s+cuenta|transferencia\s+(recibida|enviada|realizada|procesada)|comprobante\s+(de\s+)?transferencia|justificante\s+de\s+la?\s*transferencia)\b/i,
  /\b(oferta\s+especial|black\s*friday|cyber\s*monday|c[oó]digo\s+promocional|rebajas|liquidaci[oó]n\s+total)\b/i,
  /\b(publicidad|marketing|campa[nñ]a\s+de\s+email)\b/i,
];
// Mismas entidades de arriba, pero comprobando el REMITENTE real -- un
// comprobante de transferencia real no suele repetir el nombre del banco
// en el propio texto (solo en el remitente), así que depender solo del
// cuerpo dejaba pasar justo ese caso real.
const BANK_SENDER = /@(bbva|santander|caixabank|lacaixa|ingdirect|ing|openbank|bankinter|unicajabanco|unicaja|bancsabadell|sabadell|revolut|n26|wise)\.(es|com)$/i;

// FALLO REAL GRAVE detectado (28/10/2026, caso real confirmado: un correo
// de la gestoría del propio negocio, "RECOGIDA NUEVOS DISTINTIVOS VTC",
// se contestó como si fuera un cliente -- "eso está prohibido"): los
// correos de la gestoría/asesoría del negocio solo se descartaban cuando
// el asunto/cuerpo mencionaba un documento sensible (nómina, embargo...).
// Un aviso administrativo mundano de la misma gestoría (recoger un
// distintivo, un trámite, un aviso de horario) no lleva ninguna de esas
// palabras, así que pasaba como si fuera una consulta real de un cliente.
// No se puede enumerar cada gestoría real que exista, pero su dominio casi
// siempre lo dice solo -- se descarta por el REMITENTE, igual que los
// bancos, nunca por el contenido del mensaje.
const PROFESSIONAL_SERVICES_SENDER = /@([a-z0-9-]*(gestoria|asesoria|consultoria|notaria|graduadosocial)[a-z0-9-]*)\.[a-z.]+$/i;

// FALLO REAL detectado (15/10/2026): el propio Wallapop mandó un aviso de
// seguridad ("inicio de sesión desde nuevo dispositivo") con el cuerpo
// vacío, y el agente le contestó igualmente ("No entiendo bien tu
// mensaje...") porque esa dirección ya tenía una conversación real previa
// (ver hasPriorThread más abajo). Nunca es un cliente preguntando por un
// coche -- va directo a revisión humana, sin importar el remitente ni si
// hay hilo previo.
const SECURITY_OR_ACCOUNT = [
  /\b(aviso\s+de\s+seguridad|alerta\s+de\s+seguridad|actividad\s+(inusual|sospechosa))\b/i,
  /\b(inicio\s+de\s+sesi[oó]n|nuevo\s+dispositivo|nuevo\s+inicio\s+de\s+sesi[oó]n)\b/i,
  /\b(restablec\w*\s+(tu\s+)?contrase[nñ]a|cambio\s+de\s+contrase[nñ]a|recuperar\s+contrase[nñ]a)\b/i,
  /\b(verifica\s+tu\s+cuenta|c[oó]digo\s+de\s+verificaci[oó]n|verificaci[oó]n\s+en\s+dos\s+pasos|2fa)\b/i,
];

const INTERESTED = [
  /\b(coche|coches|veh[ií]culo|vehiculos|veh[ií]culos|furgoneta|furgonetas|todoterreno|suv|monovolumen|berlina|familiar|4x4)\b/i,
  /\b(precio|cu[aá]nto cuesta|cu[aá]nto vale|cu[aá]nto es|oferta|financ\w*|plazos|cuota)\b/i,
  /\b(cita|visitar|ver el|ver la|probar|prueba|quedar|pasar por|ir a ver)\b/i,
  /\b(reservar|reserva|apartar|se\s+lo\s+llevo|me lo llevo)\b/i,
  /\b(tasar|tasaci[oó]n|valorar|vender mi|quiero vender|compr\w*|busco)\b/i,
  /\b(disponible|kil[oó]metros|kms?|garant[ií]a|itv|matr[ií]cula|motor|diesel|gasolina|h[ií]brido|el[eé]ctrico)\b/i,
  /\b(golf|polo|astra|corsa|clio|megane|kuga|focus|qashqai|tiguan|x[1-7]|serie [1-7]|a[1-8]|c[1-5]|ibiza|leon|octavia|fiesta|tucson|sportage|berlingo|doblo|transit|jumper|ducato|vito|sprinter|passat|scenic|sc[eé]nic|touran|sharan|caddy|t-roc|t-cross|arona|ateca|kadjar|captur|duster|sandero|yaris|corolla|rav4|c-hr|juke|micra|mokka|crossland|grandland|peugeot|citro[eë]n|seat|renault|volkswagen|skoda|hyundai|kia|toyota|nissan|opel|dacia|fiat)\b/i,
  /\b(car|cars|van|vans|price|how much|appointment|finance|financing|test drive|buy|reserve|sell my car)\b/i,
];

// Plantillas propias de los portales (encargo real, 14/10/2026, caso real:
// un correo de "nuevo contacto" con nombre/teléfono/modelo NO llevaba
// ninguna palabra de la lista de arriba -- "Passat" no estaba en la lista
// de modelos, y aun así es un lead real de verdad, con teléfono incluido).
// Si el propio portal generó esta notificación, es por definición un
// interés comercial real -- no hace falta que coincida además con una
// palabra concreta.
const PORTAL_NOTIFICATION_TEMPLATE = [
  /\btienes un nuevo contacto\b/i,
  /\bnuevo contacto\b/i,
  /se ha interesado por/i,
  /contactado desde/i,
  /estos son sus datos de contacto/i,
];

// Documentación sensible (encargo real, 14/10/2026): nunca se contesta
// automáticamente aunque el correo también mencione algo comercial de
// pasada -- se revisa a mano, sin tocar ni procesar esos documentos.
const SENSITIVE_DOCS = [
  /\b(factura|facturaci[oó]n|albar[aá]n)\b/i,
  /\b(n[oó]mina|n[oó]minas|seguridad social)\b/i,
  /\b(extracto\s+bancario|iban\b|n[uú]mero\s+de\s+cuenta|tarjeta\s+de\s+cr[eé]dito)\b/i,
  /\b(dni|n[ieí]e|pasaporte|documento\s+de\s+identidad)\b/i,
  /\b(contrato\s+(de\s+)?(trabajo|arrendamiento|alquiler|laboral))\b/i,
  // Especificación formal del agente de Gmail (15/10/2026, sección 3 y 8):
  // "correos con contraseñas, credenciales, datos confidenciales" y
  // "comunicaciones legales, bancarias o fiscales" -- explícito en el
  // encargo, no estaba cubierto todavía.
  /\b(contrase[nñ]a|credenciales|usuario\s+y\s+clave)\b/i,
  /\b(demanda|denuncia|requerimiento\s+legal|abogado|juzgado|hacienda|agencia\s+tributaria|inspecci[oó]n\s+fiscal)\b/i,
];

// Especificación formal del agente de Gmail (15/10/2026, sección 3:
// "comunicaciones internas entre empleados, propietarios o proveedores"):
// direcciones propias del negocio que reciben avisos internos (resúmenes
// diarios, etc.) y que nunca son un cliente, aunque mencionen un vehículo de
// pasada dentro de ese resumen.
const INTERNAL_SENDERS = [/^automovileslucero@gmail\.com$/i];

// Portales de compraventa (encargo real, 14/10/2026): se detecta el origen
// para dejarlo registrado en el CRM, y sobre todo para distinguir el caso
// en que el propio portal exige responder desde su chat/app -- contestar
// por correo a esa notificación no le llega de verdad al comprador.
// Orden importante: si el cuerpo menciona milanuncios/wallapop se etiqueta
// así aunque el correo llegue técnicamente desde el dominio de coches.net
// (comparten el mismo sistema de notificaciones) -- lo que importa al
// equipo es el anuncio real de origen, no quién reenvió el aviso.
const PORTAL_SENDERS: { match: RegExp; name: string }[] = [
  { match: /milanuncios/i, name: "Milanuncios" },
  { match: /wallapop/i, name: "Wallapop" },
  { match: /coches\.net/i, name: "Coches.net" },
];
const PORTAL_MANAGE_ELSEWHERE = [
  /gestionar\s+(el\s+)?chat/i,
  /responde(r)?\s+desde\s+la\s+app/i,
  /ver\s+(el\s+)?mensaje\s+en\s+(la\s+)?(app|plataforma|web)/i,
  /abre\s+la\s+app\s+para\s+responder/i,
  /descarga\s+la\s+app/i,
];

// FALLO REAL grave detectado (16/10/2026, revisando Pendientes del CRM):
// coches.net reenvía peticiones de contacto SOLO por WhatsApp desde una
// dirección de sistema sin respuesta real -- el agente las contestaba por
// correo a esa dirección muerta, perdiendo clientes reales. Confirmado con
// nombres y teléfonos reales (Steven, Oscar, moisés, Messi sanmartin,
// saidelas38...) desde el 12/10/2026, nunca contactados de verdad.
export const WHATSAPP_ONLY_REQUEST = /quiere que le contactes solo por whatsapp|nueva solicitud via whatsapp/i;

// Todas las notificaciones reales de Coches.net (interés normal y la de
// WhatsApp) incluyen al final un bloque JSON de verdad con los datos reales
// del cliente -- más fiable que adivinar nombre/teléfono con expresiones
// sueltas sobre el texto libre.
export function extractCochesNetContact(
  text: string,
): { name: string | null; phone: string | null; make: string | null; model: string | null; version: string | null; inquiry: string | null } | null {
  const phoneMatch = /"phone":"(\d+)"/.exec(text);
  if (!phoneMatch) return null;
  const nameMatch = /"first_name":"([^"]*)"/.exec(text);
  const makeMatch = /"make":"([^"]*)"/.exec(text);
  const modelMatch = /"model":"([^"]*)"/.exec(text);
  const versionMatch = /"version":\s*"([^"]*)"/.exec(text);
  // El mensaje real del cliente va entre "quiere que le contactes solo por
  // WhatsApp" y el aviso "**Recuerda utilizar..." -- se usa tal cual como
  // primer mensaje real para el agente de chat, en vez de inventar uno.
  const inquiryMatch = /quiere que le contactes solo por whatsapp\s*\n+\s*(.+?)\n+\s*\*\*recuerda/is.exec(text);
  return {
    phone: phoneMatch[1],
    name: nameMatch?.[1]?.trim() || null,
    make: makeMatch?.[1]?.trim() || null,
    model: modelMatch?.[1]?.trim() || null,
    version: versionMatch?.[1]?.trim() || null,
    inquiry: inquiryMatch?.[1]?.trim() || null,
  };
}

// FALLO REAL detectado (21/10/2026, caso real de un cliente llamado Ignacio
// y otro ZAKARIA): el bloque JSON de Coches.net trae su nombre real y su
// correo personal real (client.first_name/client.email), pero
// FALLO REAL GRAVE detectado (27/10/2026, caso real: Sandra y Fran, dos
// clientes reales distintos, ambos interesados en coches distintos, con
// el nombre/correo real apareciendo mezclado en una sola ficha): no todos
// los remitentes de Coches.net son un relay único por conversación
// (xxxxx@contactos.coches.net) -- "vehiculosocasion@coches.net" es un
// remitente COMPARTIDO, el mismo para cualquier cliente que escriba sobre
// cualquier anuncio. Usarlo tal cual como clave de identidad del lead
// (como si fuera el relay único) mezclaba a todos los clientes reales que
// alguna vez escribieron por ahí en una sola ficha -- el primero se
// quedaba con el nombre para siempre, el resto se perdían dentro de la
// misma ficha. Un remitente de Coches.net es un relay único de verdad
// solo si tiene forma de UUID -- cualquier otro (vehiculosocasion@,
// no-reply@, correo@pro....) es compartido y nunca debe ser la clave de
// identidad por sí solo.
const COCHES_NET_UNIQUE_RELAY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@contactos\.coches\.net$/i;
export function isCochesNetSharedSender(from: string): boolean {
  return /@(pro\.)?coches\.net$/i.test(from) && !COCHES_NET_UNIQUE_RELAY.test(from);
}
// extractCochesNetContact exige que haya "phone" dentro del bloque -- las
// notificaciones normales de "alguien está interesado en tu anuncio" casi
// nunca lo traen, así que ese nombre/correo real se perdía sin usar en el
// lead (quedaba con phone = el relay anónimo de coches.net y name = null).
// Esta función no exige teléfono -- solo mira el bloque "client" y saca lo
// que haya, para enriquecer el lead sin tocar su clave de identidad (el
// relay sigue siendo el "phone" del lead, evitando duplicarlo) -- EXCEPTO
// cuando el remitente es compartido (ver isCochesNetSharedSender arriba),
// caso en el que el propio llamador debe usar el correo real como clave
// en su lugar, nunca el remitente compartido.
export function extractCochesNetClientIdentity(text: string): { name: string | null; email: string | null } | null {
  const clientBlockMatch = /"client":\s*\{([^}]*)\}/.exec(text);
  if (!clientBlockMatch) return null;
  const block = clientBlockMatch[1];
  const nameMatch = /"first_name":"([^"]*)"/.exec(block);
  const emailMatch = /"email":"([^"]*)"/.exec(block);
  const name = nameMatch?.[1]?.trim() || null;
  const email = emailMatch?.[1]?.trim() || null;
  if (!name && !email) return null;
  return { name, email };
}

// FALLO REAL detectado (21/10/2026, "es un caos, el texto se sale de la
// pantalla"): Correos mostraba el correo de Coches.net tal cual, con todo el
// boilerplate del portal (enlaces de tracking kilométricos, pies de firma,
// y el bloque JSON entero al final) -- ilegible, y los enlaces largos sin
// espacios rompían el ancho de la página. El bloque JSON final es el mismo
// en todas las plantillas reales de Coches.net (Mis mensajes / Email de
// coches.net / Nuevo contacto por WhatsApp) -- aislarlo y parsearlo de
// verdad (en vez de regex sueltas por campo) da un resumen limpio: nombre,
// teléfono, coche real y la pregunta real del cliente, sin el ruido.
export type CochesNetParsed = {
  name: string | null;
  phone: string | null;
  email: string | null;
  inquiry: string | null;
  car: { make: string | null; model: string | null; version: string | null; price: number | string | null } | null;
};
// Saca un campo "clave":"valor" suelto, sin exigir que lo que lo rodea sea
// JSON válido -- usado como red de seguridad cuando el bloque viene
// incompleto (ver más abajo).
function extractFieldLoose(block: string, key: string): string | null {
  // El cierre de comillas es opcional a propósito: si el corte cayó a mitad
  // del VALOR (p. ej. "first_name":"ANTO -- sin comilla de cierre porque el
  // correo guardado se acababa justo ahí), sigue mereciendo la pena
  // mostrar "ANTO" en vez de nada.
  const m = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"?`).exec(block);
  const v = m?.[1]?.trim();
  return v ? v : null;
}

export function parseCochesNetJsonBlock(text: string): CochesNetParsed | null {
  const start = text.indexOf('{"client"');
  if (start === -1) return null;
  // El bloque puede venir seguido de basura (saltos de línea, texto cortado
  // por el proveedor de correo) -- se recorta al último "}" real en vez de
  // asumir que llega limpio hasta el final del texto.
  const end = text.lastIndexOf("}");
  if (end !== -1 && end > start) {
    // FALLO REAL detectado (27/10/2026, "se ven en códigos, no me gusta eso"):
    // cuando el cliente escribe su pregunta en varias líneas (p. ej. "Hola,\n
    // ¿Aún está a la venta?"), Coches.net mete ese salto de línea literal
    // dentro del valor de "inquiry" sin escaparlo -- JSON.parse no admite un
    // salto de línea real dentro de una cadena, así que fallaba con
    // CUALQUIER mensaje multilínea y el correo entero se mostraba en bruto
    // (el bloque JSON incluido) en vez de limpio. El resto del bloque es
    // siempre compacto de verdad (una sola línea), así que cualquier salto
    // de línea real que aparezca aquí dentro solo puede venir de dentro de
    // un valor de texto -- se escapa antes de parsear, nunca se inventa nada.
    const raw = text.slice(start, end + 1).replace(/\r\n|\r|\n/g, "\\n");
    try {
      const parsed = JSON.parse(raw);
      const client = parsed?.client ?? {};
      const car = parsed?.sales_lead?.car ?? null;
      return {
        name: typeof client.first_name === "string" && client.first_name.trim() ? client.first_name.trim() : null,
        phone: typeof client.phone === "string" && client.phone.trim() ? client.phone.trim() : null,
        email: typeof client.email === "string" && client.email.trim() ? client.email.trim() : null,
        inquiry: typeof parsed?.sales_lead?.inquiry === "string" && parsed.sales_lead.inquiry.trim() ? parsed.sales_lead.inquiry.trim() : null,
        car: car ? { make: car.make ?? null, model: car.model ?? null, version: car.version ?? null, price: car.price ?? null } : null,
      };
    } catch {
      // Cae al modo flexible de abajo (p. ej. un salto de línea real dentro
      // de otro campo distinto de "inquiry" que tampoco esperábamos).
    }
  }
  // FALLO REAL detectado (27/10/2026, "esto sigue en algunos chats" -- un
  // correo real guardado con el bloque JSON cortado a la mitad, de antes de
  // subir el límite de guardado): sin cierre "}" real, o con JSON inválido,
  // esto se rendía y mostraba el correo ENTERO en bruto (boilerplate +
  // trozo de JSON incluido) en vez de limpio. En vez de exigir que el
  // bloque entero sea JSON válido, se saca cada campo suelto por su cuenta
  // -- un resumen parcial real (lo que haya alcanzado a llegar) es siempre
  // mejor que código en bruto. Esto además "autocura" los correos viejos ya
  // guardados truncados, sin tocar ningún dato: el nombre/teléfono del
  // cliente van al principio del bloque, muy rara vez se pierden en el
  // corte.
  const block = text.slice(start);
  const name = extractFieldLoose(block, "first_name");
  const phone = extractFieldLoose(block, "phone");
  const email = extractFieldLoose(block, "email");
  const inquiry = extractFieldLoose(block, "inquiry");
  const make = extractFieldLoose(block, "make");
  const model = extractFieldLoose(block, "model");
  const version = extractFieldLoose(block, "version");
  const priceMatch = /"price"\s*:\s*"?(\d+(?:\.\d+)?)"?/.exec(block);
  if (!name && !phone && !email && !inquiry && !make) return null;
  return {
    name,
    phone,
    email,
    inquiry,
    car: make || model || version ? { make, model, version, price: priceMatch?.[1] ?? null } : null,
  };
}

// FALLO REAL detectado (28/10/2026, caso real: Álvaro, "Hola! Podría ir a
// verlos?" -- "sigue saliendo en bruto, no sé cuántas veces te lo tengo
// que decir"): esta es una plantilla de Coches.net DISTINTA de la de
// "nueva solicitud"/"alguien está interesado" -- la de "tienes un nuevo
// mensaje", que reenvía la respuesta real del cliente. Esta plantilla
// NUNCA trae el bloque JSON "{client}" (parseCochesNetJsonBlock no
// encuentra nada), así que siempre caía al texto completo en bruto:
// boilerplate del anuncio, la pregunta real del cliente Y SU PROPIA FIRMA
// de correo (nombre, redes sociales, imágenes) todo mezclado. El mensaje
// real vive siempre entre "nuevo De {nombre}" y el arranque del historial
// anterior ("Mensajes anteriores", marcador fijo del propio portal) -- y,
// cuando el cliente tiene firma con el formato típico de MySignature.io
// ("*Nombre*" en su propia línea, muy común), se recorta ahí para no
// arrastrar la firma entera.
export function parseCochesNetReplyMessage(text: string): { name: string | null; inquiry: string } | null {
  const nameMatch = /\bnuevo\s+De\s+([^\r\n]+?)\s*[\r\n]/i.exec(text);
  if (!nameMatch) return null;
  let segment = text.slice(nameMatch.index + nameMatch[0].length);
  const stopAnterior = /\bMensajes\s+anteriores\b/i.exec(segment);
  if (stopAnterior) segment = segment.slice(0, stopAnterior.index);
  const sigMatch = /^\s*\*[^*\r\n]+\*\s*$/m.exec(segment);
  if (sigMatch) segment = segment.slice(0, sigMatch.index);
  const inquiry = segment
    .replace(/\[image:[^\]]*\]/gi, "")
    .replace(/‌/g, "")
    .trim();
  if (!inquiry) return null;
  return { name: nameMatch[1].trim() || null, inquiry };
}

export type PortalInfo = { portal: string | null; mustManageOnPortal: boolean };

export function detectPortal(input: { from: string; subject: string; text: string }): PortalInfo {
  // FALLO REAL grave detectado (18/10/2026, a petición de "hay algunos
  // correos de clientes que no esta respondiendo"): antes se buscaba
  // "milanuncios"/"wallapop" en TODO el correo (remitente + asunto + cuerpo
  // ENTERO, incluido el bloque JSON de metadatos al final). Los avisos
  // reales de vehiculosocasion@coches.net llevan "origin":{"source":
  // "milanuncios"} cuando el anuncio también se publicó ahí -- eso bastaba
  // para que el correo se etiquetara "Milanuncios" y decideInterest lo
  // descartara sin contestar, aunque el remitente real (coches.net) SÍ
  // entrega las respuestas de verdad. Confirmado real: Luis Fernando,
  // felix, Mohamed, jose anto... (5 clientes reales con nombre y teléfono)
  // nunca contactados por este motivo. Lo que importa es por DÓNDE vamos a
  // contestar (el remitente real del correo), no de qué anuncio habla el
  // texto -- por eso ahora solo se mira el remitente.
  const found = PORTAL_SENDERS.find((p) => p.match.test(input.from));
  // FALLO REAL grave detectado (15/10/2026, confirmado con el propio rebote de
  // Wallapop): cada respuesta por correo a una notificación de Wallapop volvía
  // automáticamente con "Este correo electrónico no está habilitado como canal
  // de Atención al Cliente" -- ninguna de las respuestas de hoy llegó a nadie,
  // y encima el contenido salía mal porque el cuerpo del aviso de Wallapop
  // siempre llega vacío (sin texto real del cliente), así que el agente
  // adivinaba a partir solo del asunto -- en un caso llegó a preguntar "¿quieres
  // vendernos tu vehículo?" sobre un aviso que en realidad era de un comprador
  // interesado en NUESTRO anuncio. Wallapop exige gestionarlo desde su propia
  // app/chat, siempre, sin excepción -- nunca se intenta responder por correo.
  const mustManageOnPortal = found?.name === "Wallapop" || PORTAL_MANAGE_ELSEWHERE.some((r) => r.test(input.text));
  return { portal: found?.name ?? null, mustManageOnPortal };
}

export type InterestDecision = { interested: boolean; reason: string };

export function decideInterest(input: { from: string; subject: string; text: string; hasPriorThread: boolean; portal: string | null }): InterestDecision {
  const body = `${input.subject}\n${input.text}`;
  if (INTERNAL_SENDERS.some((r) => r.test(input.from))) {
    return { interested: false, reason: "remitente_interno_del_negocio" };
  }
  if (SENSITIVE_DOCS.some((r) => r.test(body))) {
    return { interested: false, reason: "documento_sensible_revision_humana" };
  }
  if (MARKETING_SENDER.test(input.from)) {
    return { interested: false, reason: "remitente_marketing_portal" };
  }
  if (B2B_INDUSTRY_SENDER.some((r) => r.test(input.from))) {
    return { interested: false, reason: "plataforma_b2b_sector_no_cliente" };
  }
  if (AUTOMATED_ONLY.some((r) => r.test(body))) {
    return { interested: false, reason: "correo_masivo_o_baja" };
  }
  if (BANK_OR_ADS.some((r) => r.test(body)) || BANK_SENDER.test(input.from)) {
    return { interested: false, reason: "banco_o_publicidad_prohibido" };
  }
  if (PROFESSIONAL_SERVICES_SENDER.test(input.from)) {
    return { interested: false, reason: "proveedor_privado_del_negocio_prohibido" };
  }
  if (SECURITY_OR_ACCOUNT.some((r) => r.test(body))) {
    return { interested: false, reason: "aviso_seguridad_o_cuenta_prohibido" };
  }
  // Decisión real del negocio (15/10/2026, actualizada el mismo día: "los de
  // Wallapop quítalos por ahora, dejemos solo coches.net o clientes que
  // escriban interesados"): Wallapop queda desactivado del todo por ahora --
  // ya se confirmó que rebota cualquier respuesta por correo, así que no
  // compensa ni siquiera registrar el intento. Lo mismo para cualquier otro
  // portal que no sea Coches.net (no hay evidencia de que funcione, mejor no
  // arriesgar). Coches.net sí se mantiene (confirmado, respuestas reales sin
  // rebote). Y ahora SÍ se permite contestar a un cliente que escribe
  // DIRECTO (sin venir de ningún portal) si de verdad muestra interés real --
  // antes se bloqueaba cualquier correo que no viniera de un portal.
  // Petición real del negocio (28/10/2026, "vamos a construir la sección
  // de Wallapop que tenemos pendiente"): seguir sin contestar nunca por
  // correo a Wallapop (confirmado real que rebota, ver mustManageOnPortal
  // arriba) no es lo mismo que el equipo no se entere -- hasta ahora
  // caía en el mismo "portal_no_habilitado_para_respuesta_automatica" que
  // cualquier otro portal sin soporte, y ESE caso ni siquiera avisa a
  // nadie (ver decideInterest/agent.ts) -- los contactos reales de
  // Wallapop se perdían en silencio. Un motivo propio para que agent.ts
  // sí lo registre y avise, sin tocar el resto de portales no soportados.
  if (input.portal === "Wallapop") {
    return { interested: false, reason: "wallapop_gestionar_en_portal" };
  }
  if (input.portal && input.portal !== "Coches.net") {
    return { interested: false, reason: "portal_no_habilitado_para_respuesta_automatica" };
  }
  if (input.hasPriorThread) {
    return { interested: true, reason: "conversacion_previa" };
  }
  if (INTERESTED.some((r) => r.test(body))) {
    return { interested: true, reason: "pregunta_sobre_vehiculos_o_servicios" };
  }
  if (PORTAL_NOTIFICATION_TEMPLATE.some((r) => r.test(body))) {
    return { interested: true, reason: "notificacion_real_de_portal" };
  }
  return { interested: false, reason: "sin_tema_claro_revision_humana" };
}
