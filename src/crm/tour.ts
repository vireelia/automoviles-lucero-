import { readFileSync } from "fs";
import path from "path";

// Tutorial guiado del CRM (23/11/2026). El motor es genérico y vive en
// src/data/guided-tour.js (se copia tal cual al Docker); aquí solo están los
// pasos reales de ESTE CRM. Cada sección: primero se señala su entrada del menú
// (con clic de verdad), luego se explica la página y sus botones.

type Step = {
  id: string;
  path: string;
  target: string;
  text?: string;
  title: string;
  body: string;
  placement?: "top" | "bottom" | "left" | "right" | "center";
  advanceOnClick?: boolean;
  optional?: boolean;
};

const nav = (href: string) => `nav a[href="${href}"]`;

function menuStep(id: string, href: string, title: string, body: string, optional = false): Step {
  return { id: `menu-${id}`, path: "/crm", target: nav(href), title, body: `${body} Haz clic para entrar.`, placement: "right", advanceOnClick: true, optional };
}

const STEPS: Step[] = [
  { id: "bienvenida", path: "/crm", target: "header .brand", title: "Bienvenido al CRM de Lucero", body: "Este recorrido te enseña, sección por sección y botón por botón, para qué sirve cada cosa. Puedes salir cuando quieras con «Salir del tutorial» o con la tecla Esc, y volver a empezar con el botón «Ver tutorial» de la esquina.", placement: "right" },
  { id: "barra-superior", path: "/crm", target: ".topbar", title: "Barra superior", body: "Siempre visible. Aquí tienes el buscador (por nombre, teléfono o coche), los avisos de mensajes sin leer y de alertas, y el estado de los asistentes. Los números bajan solos cuando abres cada conversación.", placement: "bottom" },
  { id: "hoy", path: "/crm", target: "main h1", title: "Inicio: lo de hoy", body: "Resumen de lo que necesita atención hoy: visitas del día, mensajes sin contestar, reservas pendientes y tareas. Es lo primero que conviene mirar al llegar.", placement: "bottom" },
  { id: "hoy-buscar", path: "/crm", target: 'main input[placeholder^="Buscar"]', optional: true, title: "Buscador", body: "Escribe un nombre, un teléfono o un coche y te lleva directo a la ficha. Es la forma más rápida de encontrar a un cliente.", placement: "bottom" },

  menuStep("coches", "/crm/coches", "Vehículos", "El stock real de coches y furgonetas, con precio, kilómetros, cambio y estado."),
  { id: "coches-pagina", path: "/crm/coches", target: "main h1", title: "Listado de vehículos", body: "Cada coche muestra su estado (disponible, reservado, vendido). Entra en uno para ver su ficha y corregir el precio si hace falta. Las visitas y reservas solo se pueden hacer con coches que estén aquí y disponibles.", placement: "bottom" },

  menuStep("clientes", "/crm/clientes", "Clientes", "Todos los interesados, ordenados por temperatura (frío, templado, caliente)."),
  { id: "clientes-pagina", path: "/crm/clientes", target: "main h1", title: "Ficha de clientes", body: "Aquí ves quién ha escrito o llamado, con su coche de interés y su temperatura. Abre una ficha para ver toda la historia: conversaciones, visitas, reservas y tareas.", placement: "bottom" },
  { id: "clientes-anadir", path: "/crm/clientes", target: "main button", text: "Añadir cliente", optional: true, title: "Añadir cliente", body: "Para dar de alta a mano a alguien que ha llamado o ha venido. Es obligatorio escribir su nombre real: no se guardan clientes sin nombre.", placement: "bottom" },
  { id: "clientes-exportar", path: "/crm/clientes", target: "main a, main button", text: "Exportar", optional: true, title: "Exportar", body: "Descarga la lista de clientes en un archivo (JSON) para guardarla o usarla en otro sitio.", placement: "bottom" },
  { id: "clientes-limpiar", path: "/crm/clientes", target: "main button", text: "Limpiar", optional: true, title: "Limpiar sin interés real", body: "Retira de la lista los contactos que nunca mostraron interés real (por ejemplo, mensajes automáticos), para que solo queden clientes de verdad.", placement: "bottom" },

  menuStep("anuncios", "/crm/anuncios", "Anuncios", "Los coches que se publican y su rendimiento."),
  { id: "anuncios-pagina", path: "/crm/anuncios", target: "main h1", title: "Anuncios", body: "Resumen de lo publicado. Desde aquí se prepara qué coches conviene anunciar.", placement: "bottom" },

  menuStep("studio", "/crm/studio", "Studio IA", "Crea imágenes y vídeos de los coches con inteligencia artificial.", true),
  { id: "studio-pagina", path: "/crm/studio", target: "main h1", optional: true, title: "Studio IA", body: "Genera contenido para redes. Cada generación tiene coste real, por eso solo lo ven los administradores. Desde un resultado terminado puedes publicarlo en redes.", placement: "bottom" },

  menuStep("contactos", "/crm/contactos", "Contactos", "Todas las conversaciones en un solo sitio: WhatsApp, correo y llamadas."),
  { id: "contactos-pagina", path: "/crm/contactos/whatsapp", target: "main h1", title: "Contactos", body: "Aquí atiendes las conversaciones. Las pestañas separan WhatsApp, Correo y Llamadas. Al abrir una conversación se marca como leída y el número de la barra superior baja, como en WhatsApp.", placement: "bottom" },
  { id: "contactos-nuevo", path: "/crm/contactos/whatsapp", target: "main a, main button", text: "Nuevo contacto", optional: true, title: "+ Nuevo contacto", body: "Da de alta a mano a alguien (nombre real, teléfono o correo, coche de interés y canal por el que llegó).", placement: "bottom" },

  menuStep("agenda", "/crm/agenda", "Agenda", "El calendario de visitas y citas."),
  { id: "agenda-pagina", path: "/crm/agenda", target: "main h1", title: "Agenda", body: "Vista de calendario de lo que hay agendado. Las citas solo se confirman de lunes a viernes, de 9:30 a 14:00; fines de semana y festivos quedan como solicitadas.", placement: "bottom" },

  menuStep("citas", "/crm/citas", "Visitas", "Las visitas pedidas por los clientes para ver un coche."),
  { id: "citas-pagina", path: "/crm/citas", target: "main h1", title: "Visitas", body: "Cada visita lleva nombre, teléfono, coche y hora. Los asistentes solo las crean con un coche real disponible y con el nombre del cliente. Si el coche se vende, la visita se cierra y se crea una tarea para avisar al cliente.", placement: "bottom" },
  { id: "citas-imprimir", path: "/crm/citas", target: "main a, main button", text: "imprimir", optional: true, title: "Ver la semana para imprimir", body: "Abre la semana en una vista lista para imprimir y dejarla en el mostrador.", placement: "bottom" },

  menuStep("reservas", "/crm/reservas", "Reservas", "Los coches que un cliente quiere apartar."),
  { id: "reservas-pagina", path: "/crm/reservas", target: "main h1", title: "Reservas", body: "Una reserva queda pendiente hasta que llega el justificante de pago. Pueden existir varias pendientes a la vez para el mismo coche: gana quien primero paga y envía el justificante.", placement: "bottom" },
  { id: "reservas-crear", path: "/crm/reservas", target: "main button", text: "Crear la reserva", optional: true, title: "Crear la reserva", body: "Para apuntar a mano una reserva. Hace falta el nombre real del cliente; sin él no se crea.", placement: "top" },
  { id: "reservas-atendido", path: "/crm/reservas", target: "main button", text: "Ya lo he atendido", optional: true, title: "Ya lo he atendido", body: "Marca el aviso como resuelto cuando ya has gestionado esa reserva, para que deje de aparecer como pendiente.", placement: "top" },

  menuStep("compras", "/crm/compras", "Compras", "Los clientes que quieren vendernos su coche o furgoneta."),
  { id: "compras-pagina", path: "/crm/compras", target: "main h1", title: "Compras", body: "Solo entran aquí las solicitudes reales que los clientes rellenan en la web vendenostufurgoneta.es: datos del vehículo, kilómetros, precio que piden, estado y fotos. Abre una para ver todo.", placement: "bottom" },
  { id: "compras-eliminar", path: "/crm/compras", target: "main button", text: "Eliminar", optional: true, title: "Eliminar seleccionadas", body: "Marca las solicitudes que ya no interesan (hay casilla para seleccionar todas) y elimínalas de una vez. Van a la Papelera, así que se pueden recuperar.", placement: "bottom" },

  menuStep("ventas", "/crm/ventas", "Ventas", "Los coches vendidos."),
  { id: "ventas-pagina", path: "/crm/ventas", target: "main h1", title: "Ventas", body: "Registro de las ventas cerradas, para ver qué se ha vendido y cuándo.", placement: "bottom" },

  menuStep("tareas", "/crm/seguimiento", "Tareas", "Lo que el equipo tiene que hacer: llamar, confirmar visitas, avisar clientes."),
  { id: "tareas-pagina", path: "/crm/seguimiento", target: "main h1", title: "Tareas y seguimiento", body: "Muchas se crean solas (por ejemplo, avisar a un cliente cuyo coche se vendió). Cada tarea lleva su próxima acción y enlaza a la ficha del cliente.", placement: "bottom" },
  { id: "tareas-crear", path: "/crm/seguimiento", target: "main button", text: "Crear tarea", optional: true, title: "Crear tarea", body: "Apunta a mano algo pendiente: escribe la próxima acción (por ejemplo, «llamar el jueves») y guárdala.", placement: "top" },

  menuStep("informes", "/crm/informes", "Informes", "Cifras del negocio y de los asistentes."),
  { id: "informes-pagina", path: "/crm/informes", target: "main h1", title: "Informes", body: "Resultados reales: conversaciones, visitas, reservas e incidencias de los asistentes.", placement: "bottom" },
  { id: "informes-analizar", path: "/crm/informes", target: "main button", text: "Analizar incidencias", optional: true, title: "Analizar incidencias ahora", body: "Revisa los fallos recientes de los asistentes y te explica qué ha pasado y qué conviene corregir.", placement: "bottom" },

  menuStep("asistentes", "/crm/asistentes", "Asistentes", "Miguel (voz), Carolina (WhatsApp) y Daniel (correo).", true),
  { id: "asistentes-pagina", path: "/crm/asistentes", target: "main h1", optional: true, title: "Asistentes", body: "Los tres asistentes de IA: Miguel atiende las llamadas, Carolina contesta por WhatsApp y Daniel gestiona el correo de Coches.net y Wallapop. Aquí ves su actividad y puedes pausar cada uno.", placement: "bottom" },

  menuStep("integraciones", "/crm/integraciones", "Integraciones", "Las conexiones con WhatsApp, Google y la voz.", true),
  { id: "integraciones-pagina", path: "/crm/integraciones", target: "main h1", optional: true, title: "Integraciones", body: "Estado de cada conexión. Si Gmail deja de leer correos, aquí se reconecta Google. Si algo está desconectado, los asistentes de ese canal no funcionan.", placement: "bottom" },

  menuStep("equipo", "/crm/equipo", "Usuarios", "Las personas que entran al CRM y sus permisos.", true),
  { id: "equipo-pagina", path: "/crm/equipo", target: "main h1", optional: true, title: "Usuarios", body: "Quién puede entrar y con qué rol: administrador, comercial o equipo. Solo los administradores ven este apartado.", placement: "bottom" },

  menuStep("ajustes", "/crm/ajustes", "Ajustes", "Configuración general del CRM.", true),
  { id: "ajustes-pagina", path: "/crm/ajustes", target: "main h1", optional: true, title: "Ajustes", body: "Opciones generales del negocio y del CRM.", placement: "bottom" },

  menuStep("papelera", "/crm/papelera", "Papelera", "Lo eliminado, por si hay que recuperarlo.", true),
  { id: "papelera-pagina", path: "/crm/papelera", target: "main h1", optional: true, title: "Papelera", body: "Nada se borra del todo: lo que eliminas en Compras, Clientes u otras secciones queda aquí y se puede recuperar.", placement: "bottom" },

  { id: "fin", path: "/crm", target: "header .brand", title: "Listo", body: "Ya conoces todo el CRM. Recuerda: el botón «Ver tutorial» de la esquina inferior derecha repite este recorrido cuando quieras.", placement: "right" },
];

// Secciones solo para administradores (mismas que NAV_ITEMS con adminOnly).
const ADMIN_ONLY = new Set(["studio", "asistentes", "integraciones", "equipo", "ajustes", "papelera"]);

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

// Etiqueta <script> lista para pegar antes de </body>. `<` escapado en los datos
// para que un texto nunca pueda cerrar el script.
export function tourScriptTag(role?: string): string {
  const js = engine();
  if (!js) return "";
  const data = JSON.stringify({ key: "lucero-crm-tour", startLabel: "Ver tutorial", spa: false, color: "#dc2626", steps: role === "admin" ? STEPS : STEPS.filter((st) => !ADMIN_ONLY.has(st.id.replace(/-pagina$/, "").replace(/^menu-/, ""))) }).replace(/</g, "\\u003c");
  return `<script>${js}\nGuidedTour.init(${data});</script>`;
}
