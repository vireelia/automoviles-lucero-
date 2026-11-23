import { readFileSync } from "fs";
import path from "path";

// Tutorial guiado del CRM (23/11/2026, rehecho a petición: "que vaya más organizado, que lo explique en las
// secciones reales y que explique mejor para qué sirven"). El motor es genérico y vive en src/data/guided-tour.js
// (se copia tal cual al Docker); aquí solo está el contenido real de ESTE CRM.
//
// Organización: 5 bloques con una tarjeta de introducción cada uno. En cada sección, primero se señala su entrada
// del menú (con clic de verdad) explicando PARA QUÉ SIRVE, y luego se resaltan los bloques reales de la pantalla
// (contadores, listas, pestañas, botones) explicando qué se hace con cada uno. Todo lo que se describe existe en
// la pantalla real; si un elemento depende de que haya datos, el paso tiene alternativa o se salta solo.

type Step = {
  id: string;
  path: string;
  target: string;
  text?: string;
  fallback?: string;
  title: string;
  body: string;
  group: string;
  placement?: "top" | "bottom" | "left" | "right" | "center";
  advanceOnClick?: boolean;
  optional?: boolean;
  center?: boolean;
  adminOnly?: boolean;
};

const G0 = "Primeros pasos";
const G1 = "Bloque 1 · Tu día a día";
const G2 = "Bloque 2 · Vender un coche";
const G3 = "Bloque 3 · Conseguir coches";
const G4 = "Bloque 4 · Control y resultados";
const G5 = "Bloque 5 · Administración";

type Page = { target: string; fallback?: string; text?: string; title: string; body: string; optional?: boolean; placement?: Step["placement"] };

const steps: Step[] = [];
let cur = "/crm"; // página en la que se está; los pasos de menú no obligan a volver al inicio

function intro(group: string, id: string, title: string, body: string, adminOnly = false) {
  steps.push({ id, path: cur, target: "body", center: true, group, title, body, placement: "center", adminOnly });
}

function section(o: { group: string; id: string; href: string; page?: string; title: string; why: string; adminOnly?: boolean; pages?: Page[] }) {
  steps.push({
    id: `menu-${o.id}`, path: cur, target: `nav a[href="${o.href}"]`, group: o.group, title: o.title,
    body: `Para qué sirve: ${o.why}\n\nHaz clic para entrar.`, placement: "right", advanceOnClick: true, adminOnly: o.adminOnly,
  });
  cur = o.page ?? o.href;
  (o.pages ?? []).forEach((p, i) =>
    steps.push({
      id: `${o.id}-${i + 1}`, path: cur, target: p.target, fallback: p.fallback, text: p.text, optional: p.optional ?? false,
      group: o.group, title: p.title, body: p.body, placement: p.placement ?? "bottom", adminOnly: o.adminOnly,
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------
steps.push({
  id: "bienvenida", path: "/crm", target: "body", center: true, group: G0, title: "Bienvenido al CRM de Lucero", placement: "center",
  body:
    "Este recorrido te explica, sección por sección y sobre las pantallas reales, para qué sirve cada cosa y qué puedes hacer en ella.\n\n" +
    "Va en 5 bloques: Tu día a día · Vender un coche · Conseguir coches · Control y resultados · Administración.\n\n" +
    "Puedes salir cuando quieras (tecla Esc) y repetirlo con el botón «Ver tutorial» de la esquina.",
});
steps.push({
  id: "barra-superior", path: "/crm", target: ".topbar", group: G0, title: "La barra superior, siempre visible", placement: "bottom",
  body:
    "• Buscador: encuentra a cualquier cliente, coche o matrícula (atajo ⌘K o Ctrl+K).\n" +
    "• Mensajes y avisos: el número es lo que no has leído; baja solo cuando abres cada conversación.\n" +
    "• «Asistentes»: indica si Miguel, Carolina y Daniel están activos o necesitan revisión.",
});

// ---- Bloque 1 ---------------------------------------------------------------------------------------------------
intro(G1, "b1", "Tu día a día", "Lo que miras cada mañana:\n\n• Inicio: qué hay que atender hoy.\n• Contactos: quién ha escrito o llamado.\n• Agenda: qué hay en el calendario.\n• Tareas: qué te toca hacer.");

section({
  group: G1, id: "inicio", href: "/crm", title: "Inicio",
  why: "es el resumen del día y lo primero que debes mirar al llegar. Reúne de todos los canales lo que necesita tu atención.",
  pages: [
    { target: "main .stats", fallback: "main h1", title: "Los contadores del día",
      body: "Seis números: visitas de hoy, reservas por atender, incidencias, correos por contestar, reservas activas y clientes sin responsable.\n\nPulsa un número para ir directo a esa lista. Si todo está a cero, no hay nada urgente." },
    { target: "main .home-cols h2", fallback: "main .box", title: "Lo de hoy, en cuatro listas",
      body: "Visitas de hoy · Reservas que hay que atender · Clientes nuevos de hoy · Próximas visitas.\n\nCada tarjeta trae botones para actuar sin salir de aquí: «Llamar», «Escribir por WhatsApp», «Ya le he llamado» (quita el aviso) o «Ha pagado» en las reservas." },
    { target: "main form.search", fallback: "main h1", title: "Buscador del día a día",
      body: "Escribe un nombre, un teléfono o un coche y te lleva directo a su ficha. Es la forma más rápida de encontrar a alguien." },
  ],
});

section({
  group: G1, id: "contactos", href: "/crm/contactos", page: "/crm/contactos/whatsapp", title: "Contactos",
  why: "aquí están todas las conversaciones con clientes: WhatsApp (Carolina), correo (Daniel) y llamadas (Miguel). Los asistentes contestan solos; tú lees y entras si hace falta.",
  pages: [
    { target: "#contactos-tabs", fallback: "main h1", title: "Un canal por pestaña",
      body: "WhatsApp, Correo, Llamadas y los avisos de Coches.net y Wallapop.\n\nCada conversación entra por su canal y, al abrirla, se marca como leída: el número de la barra superior baja, como en WhatsApp." },
    { target: "#contactos-panel", fallback: "main h1", title: "La lista y la conversación",
      body: "A un lado, las conversaciones con la más reciente arriba. Al abrir una ves lo que se ha hablado y los datos del cliente." },
    { target: "main a, main button", text: "Nuevo contacto", optional: true, title: "+ Nuevo contacto",
      body: "Para dar de alta a mano a alguien que ha llamado o ha venido en persona. Hace falta su nombre real: sin nombre no se guarda." },
  ],
});

section({
  group: G1, id: "agenda", href: "/crm/agenda", title: "Agenda",
  why: "un calendario de los próximos días con todo mezclado: visitas, llamadas y tareas de todos los canales.",
  pages: [
    { target: "main .agenda-day.today", fallback: "main .agenda-day", title: "Día por día",
      body: "Cada fila enlaza a su sección real (la visita, la tarea…) para gestionarla. El día de hoy aparece resaltado." },
  ],
});

section({
  group: G1, id: "tareas", href: "/crm/seguimiento", title: "Tareas",
  why: "la lista de cosas que alguien del equipo debe hacer: llamar a un cliente, confirmar una visita, verificar un pago…",
  pages: [
    { target: "main .cards-grid > :first-child", fallback: "main .box", title: "Tareas pendientes",
      body: "Algunas se crean solas: visita por confirmar, justificante por verificar, cliente que no se presentó, aviso urgente de un asistente.\n\nCada tarjeta tiene «Ver cliente» para abrir su ficha y «Completar» cuando ya está hecha." },
    { target: "main button", text: "Crear tarea", optional: true, title: "Crear una tarea tú",
      body: "Para apuntar algo pendiente: elige el tipo, el cliente (por teléfono), escribe qué hay que hacer y ponle prioridad, fecha y responsable." },
  ],
});

// ---- Bloque 2 ---------------------------------------------------------------------------------------------------
intro(G2, "b2", "Vender un coche",
  "El camino real de una venta:\n\n1. El cliente pregunta y queda en Clientes.\n2. Pide ver un coche: Visitas.\n3. Aparta el coche con 500 €: Reservas.\n4. Se cierra la venta: Ventas.\n\nVehículos es el catálogo del que parte todo.");

section({
  group: G2, id: "clientes", href: "/crm/clientes", title: "Clientes",
  why: "la ficha de cada persona interesada, con lo que quiere y lo caliente que está (caliente, tibio o frío).",
  pages: [
    { target: "main .cards-grid > :first-child", fallback: "main h1", title: "Una tarjeta por cliente",
      body: "Miguel, Carolina y Daniel anotan solos lo que quiere cada cliente, sea cual sea el canal: tú lo lees y llamas si hace falta.\n\nLos fríos sin contacto en 45 días se archivan solos; nunca se borran, solo dejan de aparecer." },
    { target: "main details.box", fallback: "main h1", title: "Añadir un cliente a mano",
      body: "Despliega este bloque para dar de alta a alguien: nombre real (obligatorio), teléfono y el coche que le interesa." },
    { target: "main a, main button", text: "Limpiar", optional: true, title: "Limpiar y exportar",
      body: "«Limpiar sin interés real» quita los contactos que nunca mostraron interés (mensajes automáticos…).\n\nA su lado: «Exportar (JSON)» descarga la lista y «Gestionar archivados» recupera los archivados." },
  ],
});

section({
  group: G2, id: "vehiculos", href: "/crm/coches", title: "Vehículos",
  why: "el catálogo real de coches y furgonetas. Los asistentes solo ofrecen y agendan lo que está aquí y disponible.",
  pages: [
    { target: "main .cards-grid > :first-child", fallback: "main h1", title: "Un coche por tarjeta",
      body: "Cada tarjeta muestra el coche con su precio y su estado. Pulsa «Cambiar» para marcarlo disponible, reservado o vendido, o para cambiar el precio.\n\nSi lo marcas como vendido, ya no se agendan visitas ni reservas de ese coche." },
  ],
});

section({
  group: G2, id: "visitas", href: "/crm/citas", title: "Visitas",
  why: "los días y horas en que vendrán clientes a ver un coche. La mayoría las agendan solos los asistentes.",
  pages: [
    { target: "main .records-list > :first-child", fallback: "main h1", title: "La lista de visitas",
      body: "Cada visita tiene cliente, coche, día y hora. Solo se crean con el nombre real del cliente y con un coche disponible del catálogo.\n\nSi el coche se vende, la visita se cierra sola y se crea una tarea para avisar al cliente." },
    { target: "main button", text: "Vino y compró", fallback: "main .records-list", optional: true, title: "Después de la visita",
      body: "Marca qué pasó: «Vino», «Vino y compró» o «No se presentó» (esta última crea una tarea de seguimiento).\n\n«Cancelar» la anula y «Cambiar» mueve el día o la hora." },
  ],
});

section({
  group: G2, id: "reservas", href: "/crm/reservas", title: "Reservas",
  why: "apartar un coche a un cliente con una señal de 500 €.",
  pages: [
    { target: "main .records-list > :first-child", fallback: "main h1", title: "El camino de una reserva",
      body: "1. El cliente la pide y queda pendiente de pago.\n2. Cuando paga, pulsa «Ha pagado».\n3. Compruebas el justificante y pulsas «Confirmar la reserva»: el coche pasa a reservado.\n\nSi no se concreta, «Cancelar»." },
    { target: "main button", text: "Crear la reserva", optional: true, title: "Crear una reserva a mano",
      body: "Para cuando el cliente decide en persona o por teléfono: elige el coche, escribe su nombre real (obligatorio) y su teléfono." },
  ],
});

section({
  group: G2, id: "ventas", href: "/crm/ventas", title: "Ventas",
  why: "el historial de ventas cerradas, para ver qué se ha vendido y por qué canal llegó el cliente.",
  pages: [
    { target: "main .stats", fallback: "main h1", title: "El resumen de ventas",
      body: "Ventas cerradas, importe total conocido y cuántas no tienen reserva vinculada.\n\nUna venta se cierra desde la ficha del cliente («✅ Venta cerrada»). Nunca se muestra un importe inventado." },
  ],
});

// ---- Bloque 3 ---------------------------------------------------------------------------------------------------
intro(G3, "b3", "Conseguir coches",
  "No solo vendes: también compras.\n\n• Compras: personas que quieren venderte su coche.\n• Anuncios: qué retirar de los portales.\n• Studio IA: imágenes y vídeos para publicitar los coches.");

section({
  group: G3, id: "compras", href: "/crm/compras", title: "Compras",
  why: "las personas que quieren venderte su coche o furgoneta. Solo entran las que rellenan el formulario de la web vendenostufurgoneta.es.",
  pages: [
    { target: "main .compras-split", fallback: "main h1", title: "La solicitud y su detalle",
      body: "A un lado, la lista con el coche de cada persona. Al abrir una ves lo que pide, el estado del vehículo y sus fotos." },
    { target: "main button", text: "Marcar contactada", fallback: "main .compras-split", optional: true, title: "Llevar el control",
      body: "Llama o escribe por WhatsApp desde los botones y marca en qué punto está: «Marcar contactada» o «Descartar».\n\n«Eliminar» la manda a la Papelera, y las casillas permiten eliminar varias a la vez." },
  ],
});

section({
  group: G3, id: "anuncios", href: "/crm/anuncios", title: "Anuncios",
  why: "saber qué coches ya no deben seguir publicados en Coches.net, Milanuncios o Wallapop porque se han reservado o vendido.",
  pages: [
    { target: "main .records-list", fallback: "main .box", title: "Qué retirar de los portales",
      body: "Publicar anuncios desde aquí todavía no está construido (faltan los accesos de esos portales).\n\nLos portales no se sincronizan solos: lo que se reserva o se vende hay que retirarlo a mano en cada uno. Debajo tienes accesos al catálogo y a Studio IA." },
  ],
});

section({
  group: G3, id: "studio", href: "/crm/studio", title: "Studio IA", adminOnly: true,
  why: "genera con IA vídeos e imágenes publicitarias de los coches y los publica en redes. Solo administradores, porque cada generación tiene un coste real.",
  pages: [
    { target: "main .box", fallback: "main h1", title: "Generar contenido",
      body: "Elige el coche y qué quieres crear. Cuando termina, puedes publicarlo en redes desde el propio resultado." },
  ],
});

// ---- Bloque 4 ---------------------------------------------------------------------------------------------------
intro(G4, "b4", "Control y resultados",
  "Para saber cómo va el negocio y si los asistentes trabajan bien:\n\n• Informes: cifras reales de cada periodo.\n• Asistentes: actividad de Miguel, Carolina y Daniel.");

section({
  group: G4, id: "informes", href: "/crm/informes", title: "Informes",
  why: "cifras reales de un periodo: cuántos clientes llegan, cuántos ven un coche, cuántos reservan y cuántos compran.",
  pages: [
    { target: "main .legend", fallback: "main .stats", title: "Elige el periodo",
      body: "Hoy, Ayer, Últimos 7 o 30 días, Este mes, Mes anterior o Todo. Las cifras de la página se recalculan para ese periodo." },
    { target: "main .stats", fallback: "main h1", title: "Del cliente a la venta",
      body: "Clientes nuevos y contactados, calientes, visitas concertadas, confirmadas y realizadas…\n\nSon siempre conteos reales: «Sin datos» significa que aún no hay casos que medir, no un error." },
    { target: "main button", text: "Analizar incidencias", fallback: "main .box", optional: true, title: "Calidad de los asistentes",
      body: "Más abajo hay costes (voz y OpenAI), clientes por canal y calidad de datos.\n\n«Analizar incidencias ahora» revisa los fallos recientes de los asistentes y explica qué corregir." },
  ],
});

section({
  group: G4, id: "asistentes", href: "/crm/asistentes", title: "Asistentes", adminOnly: true,
  why: "ver cómo trabajan los 3 asistentes de IA: Miguel (llamadas), Carolina (WhatsApp y chat) y Daniel (correo).",
  pages: [
    { target: "main .row", fallback: "main h1", title: "Una tarjeta por asistente",
      body: "Cada una muestra su configuración y su última actividad. La conexión técnica con WhatsApp, correo y teléfono está en Integraciones." },
  ],
});

// ---- Bloque 5 ---------------------------------------------------------------------------------------------------
intro(G5, "b5", "Administración", "Solo para administradores:\n\n• Integraciones: conexiones técnicas.\n• Usuarios: quién entra al CRM.\n• Ajustes: datos del negocio.\n• Papelera: lo eliminado, recuperable.", true);

section({
  group: G5, id: "integraciones", href: "/crm/integraciones", title: "Integraciones", adminOnly: true,
  why: "las conexiones técnicas del CRM con Google (correo y calendario), WhatsApp y el teléfono. Aquí se activa o pausa cada asistente.",
  pages: [
    { target: "main h3", text: "Google", fallback: "main h1", title: "Qué hay conectado",
      body: "• Google: correo y calendario. Si Gmail deja de leer correos, se reconecta aquí.\n• Correo: modo de prueba, para redactar sin enviar.\n• WhatsApp (Zernio) y Teléfono (Miguel): estado y botón para activar o desactivar al asistente de ese canal." },
  ],
});

section({
  group: G5, id: "usuarios", href: "/crm/equipo", title: "Usuarios", adminOnly: true,
  why: "quién entra al CRM y con qué permisos.",
  pages: [
    { target: "main .box", fallback: "main h1", title: "Dar de alta y cambiar contraseñas",
      body: "Crea el acceso de una persona nueva y elige su rol: administrador, comercial o equipo.\n\nDebajo, cada persona con su botón «Cambiar contraseña»." },
  ],
});

section({
  group: G5, id: "ajustes", href: "/crm/ajustes", title: "Ajustes", adminOnly: true,
  why: "los datos del negocio tal como los usan los asistentes: contacto, ubicación, criterios de financiación y plantillas de WhatsApp.",
  pages: [
    { target: "main h3", text: "Contacto", fallback: "main h1", title: "Datos que usan los asistentes",
      body: "Lo que cambies aquí tiene efecto al momento, sin reiniciar nada. Los horarios, la garantía y la reserva son de solo lectura.\n\nPulsa «Guardar cambios» al terminar." },
  ],
});

section({
  group: G5, id: "papelera", href: "/crm/papelera", title: "Papelera", adminOnly: true,
  why: "lo que se eliminó (reservas, visitas, avisos, alertas) queda aquí y se puede recuperar. Nada se borra para siempre hasta que lo confirmes en esta pantalla.",
});

steps.push({
  id: "fin", path: cur, target: "body", center: true, group: G0, title: "Ya conoces todo el CRM", placement: "center",
  body:
    "Recuerda el camino de una venta:\nContactos → Clientes → Visitas → Reservas → Ventas.\n\n" +
    "Cuando quieras repasar algo, pulsa «Ver tutorial» en la esquina inferior derecha.",
});

const STEPS: Step[] = steps;

let engineCache: string | null = null;
function engine(): string {
  if (engineCache === null) {
    try {
      engineCache = readFileSync(path.resolve(process.cwd(), "src/data/guided-tour.js"), "utf8");
    } catch {
      engineCache = ""; // sin el motor, el CRM sigue funcionando; solo no hay tutorial
    }
  }
  return engineCache;
}

// Etiqueta <script> lista para pegar antes de </body>. `<` escapado en los datos para que un texto nunca cierre el script.
export function tourScriptTag(role?: string): string {
  const js = engine();
  if (!js) return "";
  const list = role === "admin" ? STEPS : STEPS.filter((st) => !st.adminOnly);
  // La clave lleva v2: quien tenía el tutorial antiguo a medias no reanuda en un paso que ya no existe.
  const data = JSON.stringify({ key: "lucero-crm-tour-v2", startLabel: "Ver tutorial", spa: false, color: "#dc2626", steps: list }).replace(/</g, "\\u003c");
  return `<script>${js}\nGuidedTour.init(${data});</script>`;
}

// Estado público e inocuo del tutorial (sin datos de negocio): sirve para comprobar desde fuera, sin entrar al
// CRM, que la versión desplegada lleva el motor y cuántos pasos tiene.
export function tourStatus(): { loaded: boolean; engine_bytes: number; steps: number } {
  const js = engine();
  return { loaded: js.length > 0, engine_bytes: js.length, steps: STEPS.length };
}
