// Seguimiento comercial (20/10/2026, mejora integral del CRM, sección 14):
// tareas reales con responsable/vencimiento/prioridad/resultado, nunca un
// campo libre que nadie puede filtrar. Se crean solas en los puntos reales
// donde el encargo pide una automatización -- nunca al abrir una página (a
// diferencia del archivado automático de clientes, que sí es correcto
// re-evaluar en cada visita porque solo depende del tiempo transcurrido,
// aquí cada tarea nace de un EVENTO concreto, así que vive en el propio
// sitio donde ese evento ya ocurre).
import { appendToCollection, readCollection, writeCollection } from "../store.js";

export type TaskType =
  | "llamar"
  | "responder_mensaje"
  | "responder_correo"
  | "confirmar_visita"
  | "verificar_reserva"
  | "revisar_financiacion"
  | "recuperar_cliente"
  | "seguimiento_propuesta"
  | "resolver_incidencia"
  | "revisar_handoff"
  // Aviso cruzado entre canales (26/10/2026, "si el agente de gmail... le
  // pide el numero... que ese numero... le envie un aviso a carolina para
  // que lo contacte en whatsapp") -- Carolina (el agente de WhatsApp) no
  // puede escribirle ella sola a un número que nunca le escribió primero
  // (ventana de 24h de Meta para texto libre, sin plantilla aprobada), así
  // que el aviso real y honesto es para el equipo: contactar por WhatsApp
  // en cuanto se pueda, nunca un envío automático que Meta bloquearía.
  | "contactar_whatsapp"
  | "otra";

export type Task = {
  id: string;
  lead_phone: string | null;
  type: TaskType;
  reason: string | null;
  priority: "normal" | "alta";
  assigned_to: string | null;
  channel: string | null;
  // Id del registro de origen (reserva, handoff, visita...) -- clave real
  // de deduplicación: "no crear tareas duplicadas por el mismo evento".
  source_ref: string | null;
  status: "pendiente" | "completada";
  result: string | null;
  next_action: string | null;
  created_at: string;
  due_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
};

function now() {
  return new Date().toISOString();
}

export function listTasks(): Task[] {
  return readCollection<Task>("tasks");
}

// Nunca duplica la misma automatización para el mismo evento real -- si ya
// hay una tarea pendiente con el mismo tipo+origen, no crea otra.
export function createAutoTask(args: {
  lead_phone: string | null;
  type: TaskType;
  reason: string;
  source_ref: string;
  channel?: string | null;
  priority?: "normal" | "alta";
  due_at?: string | null;
}): Task | null {
  const tasks = listTasks();
  const dup = tasks.some((t) => t.status === "pendiente" && t.type === args.type && t.source_ref === args.source_ref);
  if (dup) return null;
  const task: Task = {
    id: crypto.randomUUID(),
    lead_phone: args.lead_phone,
    type: args.type,
    reason: args.reason,
    priority: args.priority ?? "normal",
    assigned_to: null,
    channel: args.channel ?? null,
    source_ref: args.source_ref,
    status: "pendiente",
    result: null,
    next_action: null,
    created_at: now(),
    due_at: args.due_at ?? null,
    completed_at: null,
    completed_by: null,
  };
  appendToCollection("tasks", task);
  return task;
}

export function createManualTask(args: {
  lead_phone: string | null;
  type: TaskType;
  reason: string;
  priority?: "normal" | "alta";
  assigned_to?: string | null;
  due_at?: string | null;
}): Task {
  const task: Task = {
    id: crypto.randomUUID(),
    lead_phone: args.lead_phone,
    type: args.type,
    reason: args.reason,
    priority: args.priority ?? "normal",
    assigned_to: args.assigned_to ?? null,
    channel: null,
    source_ref: null,
    status: "pendiente",
    result: null,
    next_action: null,
    created_at: now(),
    due_at: args.due_at ?? null,
    completed_at: null,
    completed_by: null,
  };
  appendToCollection("tasks", task);
  return task;
}

export function completeTask(id: string, completedBy: string, result?: string, nextAction?: string): boolean {
  const tasks = listTasks();
  const t = tasks.find((x) => x.id === id);
  if (!t) return false;
  t.status = "completada";
  t.completed_at = now();
  t.completed_by = completedBy;
  if (result) t.result = result;
  if (nextAction) t.next_action = nextAction;
  writeCollection("tasks", tasks);
  return true;
}

export function assignTask(id: string, assignedTo: string | null): boolean {
  const tasks = listTasks();
  const t = tasks.find((x) => x.id === id);
  if (!t) return false;
  t.assigned_to = assignedTo;
  writeCollection("tasks", tasks);
  return true;
}
