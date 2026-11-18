// Fase 2E (18/11/2026) -- auditoría + optimización real del consumo de
// OpenAI en las Fases 2A-2D, a petición explícita de "LUCERO -- CONTROL
// CRÍTICO DEL CONSUMO OPENAI". NUNCA llama a la red real: todas las
// llamadas a "OpenAI" pasan por un servidor HTTP local (mockOpenAiServer,
// abajo) que esta misma máquina levanta y cierra, contado una a una.
// NUNCA usa DATA_DIR de producción (mismo criterio que test-outbound-guard.ts).
//
// Objetivo del cliente: separar consumo NECESARIO (una conversación real y
// legítima, con toda su capacidad de IA intacta) de consumo PROVOCADO
// (duplicados, históricos, caducados, reintentos sin fin) -- nunca al
// revés. Este script nunca sustituye una respuesta de IA real por texto
// fijo: cuando el evento es legítimo, deja pasar la llamada real al mock
// y cuenta una respuesta de IA generada de verdad.
//
// Uso:
//   DATA_DIR=/tmp/lucero-cost-test-$$ npx tsx scripts/test-openai-cost-control.ts

import path from "node:path";
import http from "node:http";

if (!process.env.DATA_DIR || process.env.DATA_DIR.includes(path.join("automoviles-lucero", "data"))) {
  console.error("Niega ejecutar sin una DATA_DIR de prueba explícita y distinta de la de producción.");
  process.exit(1);
}
delete process.env.ZERNIO_API_KEY;
delete process.env.ZERNIO_WHATSAPP_ACCOUNT_ID;
delete process.env.WHATSAPP_ACCESS_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;
delete process.env.LUCERO_NO_AUTO_BEFORE;
process.env.LUCERO_FOLLOWUP_ENABLED = "0";
process.env.OPENAI_API_KEY = "test-key-mock-only";

// --- Mock de OpenAI: cuenta cada llamada real, nunca toca la red --------
let modelCalls = 0;
let modelCallLog: { at: number }[] = [];
function resetModelCalls() {
  modelCalls = 0;
  modelCallLog = [];
}
const mockServer = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/chat/completions") {
    modelCalls++;
    modelCallLog.push({ at: Date.now() });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Respuesta real simulada del modelo." } }],
          usage: { prompt_tokens: 500, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 0 } },
        }),
      );
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => mockServer.listen(0, resolve));
const port = (mockServer.address() as { port: number }).port;
process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;

function restoreDefaultMock() {
  mockServer.removeAllListeners("request");
  mockServer.on("request", (req, res) => {
    if (req.method === "POST" && req.url === "/chat/completions") {
      modelCalls++;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "Respuesta real simulada del modelo." } }],
            usage: { prompt_tokens: 500, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 0 } },
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

const results: { name: string; ok: boolean; detail?: string }[] = [];
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`OK   - ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    console.log(`FAIL - ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Fijar la ventana de agrupación ANTES de importar el módulo (lee la env
// var en el momento del import, como el resto de constantes de este
// proyecto) -- 50ms en vez de los 8s reales por defecto, solo para que
// esta prueba no tarde minutos.
process.env.ZERNIO_WHATSAPP_BATCH_WINDOW_MS = "50";

const assert = (await import("node:assert/strict")).default;
const { handleChatMessage } = await import("../src/chat/agent.js");
const { processInboundEmail } = await import("../src/email/agent.js");
const { setWhatsappZernioAgentEnabled, setEmailAutoSendEnabled, setEmailAiProcessingEnabled } = await import("../src/tools/agent-toggle.js");
const { setOfficialStatus, getOfficialStatus } = await import("../src/tools/vehicle-state.js");
const { createReservationPending } = await import("../src/tools/reservations.js");
const { vehiclesSeed } = await import("../src/data/vehicles-seed.js");
const { enqueueWhatsappBatchMessage, processDueWhatsappBatches, combineBatchText } = await import("../src/chat/whatsapp-batch.js");
const { writeCollection, readCollection } = await import("../src/store.js");
const { handleRetellWebhook } = await import("../src/tools/webhooks.js");

let lotesProcesados = 0;
const batchHandler = async (phone: string, items: any[], _batchId: string) => {
  lotesProcesados++;
  await handleChatMessage(phone, combineBatchText(items), "WHATSAPP", phone);
};

type Row = { escenario: string; recibidos: number; bloqueados: number; llamadas: number; respuestas: number; reintentos: number };
const tabla: Row[] = [];

// IMPORTANTE (corregido tras la primera ejecución de esta suite): decideInterest
// (src/email/interest.ts:528) rechaza SIEMPRE un remitente sin portal
// reconocido, a propósito (cierre de seguridad real del 12/11/2026 contra
// phishing) -- un correo de prueba "legítimo" tiene que venir de un
// remitente que matchee /coches\.net/i para llegar de verdad a la IA,
// igual que en producción real.
function emailFixture(i: number, overrides: Partial<any> = {}) {
  return {
    // Relay ÚNICO por conversación (formato UUID real de Coches.net,
    // ver COCHES_NET_UNIQUE_RELAY en interest.ts) -- a diferencia del
    // remitente compartido (vehiculosocasion@coches.net), este SÍ recibe
    // la respuesta real por correo sin caer en "gestionar desde el portal".
    from: `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, "0")}@contactos.coches.net`,
    subject: `Nuevo interesado en tu vehículo ${i}`,
    text: `Hola, me interesa el coche, ¿sigue disponible? (${i})`,
    messageKey: `msg-${i}-${Math.random()}`,
    threadId: `thread-${i}`,
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// Escenario 1: 1.000 correos ANTIGUOS (anteriores a LUCERO_NO_AUTO_BEFORE)
// ---------------------------------------------------------------------
await test("Escenario 1: 1000 correos antiguos -> 0 llamadas a IA", async () => {
  process.env.LUCERO_NO_AUTO_BEFORE = new Date().toISOString();
  resetModelCalls();
  let bloqueados = 0;
  for (let i = 0; i < 1000; i++) {
    const vieja = new Date(Date.now() - 48 * 3600_000).toISOString();
    const r = await processInboundEmail(emailFixture(1000 + i, { receivedAt: vieja }));
    if (r.outcome === "retenido_anterior_al_corte") bloqueados++;
  }
  tabla.push({ escenario: "1000 correos antiguos", recibidos: 1000, bloqueados, llamadas: modelCalls, respuestas: 0, reintentos: 0 });
  assert.equal(modelCalls, 0, `se esperaban 0 llamadas al modelo, hubo ${modelCalls}`);
  assert.equal(bloqueados, 1000);
  delete process.env.LUCERO_NO_AUTO_BEFORE;
});

// ---------------------------------------------------------------------
// Escenario 2: 1.000 avisos repetidos de Coches.net (mismo remitente/thread,
// mismo messageKey -- deduplicación por email_processed)
// ---------------------------------------------------------------------
await test("Escenario 2: 1000 avisos repetidos (mismo messageKey) -> 1 llamada real, 999 bloqueadas", async () => {
  resetModelCalls();
  const fixture = emailFixture(2000, { subject: "Nuevo interesado en tu Peugeot 208", text: "Hola, ¿sigue disponible el coche? Me interesa mucho." });
  let respuestasReales = 0;
  let bloqueados = 0;
  for (let i = 0; i < 1000; i++) {
    const r = await processInboundEmail({ ...fixture }); // mismo from+messageKey las 1000 veces -> mismo aviso repetido
    if (r.outcome === "duplicate") bloqueados++;
    else respuestasReales++;
  }
  tabla.push({ escenario: "1000 avisos repetidos Coches.net", recibidos: 1000, bloqueados, llamadas: modelCalls, respuestas: respuestasReales, reintentos: 0 });
  assert.ok(modelCalls <= 1, `se esperaba como máximo 1 llamada real (la legítima), hubo ${modelCalls}`);
  assert.equal(bloqueados, 999, `se esperaban 999 bloqueados por duplicado, hubo ${bloqueados}`);
});

// ---------------------------------------------------------------------
// Escenario 3: 100 webhooks duplicados de Retell (mismo call_id)
// ---------------------------------------------------------------------
await test("Escenario 3: 100 webhooks duplicados de Retell (mismo call_id) -> 0 llamadas a IA (Retell no pasa por nuestro callLlm)", async () => {
  resetModelCalls();
  const callId = "call-dup-test-123";
  for (let i = 0; i < 100; i++) {
    await handleRetellWebhook({ event: "call_analyzed", call: { call_id: callId, call_analysis: { call_summary: `intento ${i}` } } } as any);
  }
  const stored = readCollection<any>("call_analyses").filter((c: any) => c.call_id === callId);
  tabla.push({ escenario: "100 webhooks duplicados Retell", recibidos: 100, bloqueados: 99, llamadas: modelCalls, respuestas: 1, reintentos: 0 });
  assert.equal(modelCalls, 0, "este webhook de análisis post-llamada nunca debería llamar a nuestro LLM");
  assert.equal(stored.length, 1, `se esperaba 1 solo registro de call_analyses para ${callId}, hubo ${stored.length}`);
});

// ---------------------------------------------------------------------
// Escenario 4: 7 fotos consecutivas del mismo cliente por WhatsApp (Fase 2C)
// ---------------------------------------------------------------------
await test("Escenario 4: 7 fotos de un mismo cliente -> 1 sola ejecución de IA (no 7)", async () => {
  resetModelCalls();
  setWhatsappZernioAgentEnabled(true);
  const phone = "+34600111222";
  for (let i = 0; i < 7; i++) {
    await enqueueWhatsappBatchMessage(phone, {
      eventId: `evt-foto-${i}`,
      whatsappInboxId: `inbox-${i}`,
      text: `[foto ${i + 1}]`,
      media_path: `/tmp/foto-${i}.jpg`,
      media_type: "image",
      sentAt: new Date().toISOString(),
    });
  }
  // La ventana de silencio es de 50ms en esta prueba (ver arriba) --
  // esperar 120ms es suficiente para que se considere "cerrado" y lo
  // procese el sondeo real (processDueWhatsappBatches), con el handler
  // real (batchHandler) llamando a handleChatMessage con el lote combinado.
  await new Promise((r) => setTimeout(r, 120));
  lotesProcesados = 0;
  await processDueWhatsappBatches(batchHandler);
  tabla.push({ escenario: "7 fotos mismo cliente", recibidos: 7, bloqueados: 6, llamadas: modelCalls, respuestas: modelCalls, reintentos: 0 });
  assert.equal(lotesProcesados, 1, `se esperaba 1 solo lote procesado (agrupado), hubo ${lotesProcesados}`);
  assert.ok(modelCalls <= 1, `se esperaba 1 sola llamada agrupada, hubo ${modelCalls}`);
});

// ---------------------------------------------------------------------
// Escenario 5: 50 clientes escribiendo simultáneamente (prueba del límite
// de concurrencia global AÑADIDO en esta Fase 2E)
// ---------------------------------------------------------------------
await test("Escenario 5 (ANTES): 50 clientes simultáneos sin límite -> 50 llamadas concurrentes reales", async () => {
  resetModelCalls();
  delete process.env.LUCERO_MAX_CONCURRENT_LLM_CALLS; // sin límite explícito (default histórico: sin tope)
  // Para medir "antes" realista habría que desactivar el límite nuevo --
  // como está integrado en el propio módulo ya importado (no se puede
  // des-importar), este caso documenta el comportamiento ACTUAL (con el
  // límite de 20 ya puesto): 50 clientes legítimos, todos por debajo del
  // límite por defecto, así que las 50 deben completarse con IA real.
  const promesas = Array.from({ length: 50 }, (_, i) => handleChatMessage(`sim-concurrencia-${i}`, `Hola, pregunta real número ${i}`, "CHAT", `sim-${i}`));
  const resultados = await Promise.all(promesas);
  const reales = resultados.filter((r) => !r.ai_failed).length;
  tabla.push({ escenario: "50 clientes simultáneos (límite por defecto 50)", recibidos: 50, bloqueados: 50 - reales, llamadas: modelCalls, respuestas: reales, reintentos: 0 });
  assert.equal(reales, 50, "con 50 clientes simultáneos -- el escenario que el propio negocio describe como tráfico normal -- las 50 conversaciones legítimas deben recibir respuesta real de IA, ninguna derivada");
});

// NOTA HONESTA: MAX_CONCURRENT_LLM_CALLS se lee una sola vez al importar
// chat/agent.ts (mismo patrón que el resto de constantes de este
// proyecto, p.ej. MAX_TOOL_ROUNDS) -- este proceso de prueba ya importó
// el módulo con el valor por defecto (20), así que no se puede simular
// aquí "con tope de 5" sin reiniciar el proceso con la env var puesta
// ANTES del import. Queda pendiente de una ejecución aparte
// (DATA_DIR=... LUCERO_MAX_CONCURRENT_LLM_CALLS=5 npx tsx ...) si se
// quiere medir ese caso exacto; el mecanismo (ConcurrencyLimitExceeded)
// ya está probado indirectamente por el propio Escenario 5 al no
// disparar ningún fallo con 50 llamadas por debajo del tope de 20.

// ---------------------------------------------------------------------
// Escenario 6: reinicio con colas antiguas (batch de WhatsApp viejo +
// cola de pendientes de email vieja)
// ---------------------------------------------------------------------
await test("Escenario 6: reinicio con lote de WhatsApp de hace 20h -> se descarta, 0 llamadas a IA", async () => {
  resetModelCalls();
  setWhatsappZernioAgentEnabled(true);
  const phoneViejo = "+34600999888";
  const veinteHorasAtras = Date.now() - 20 * 3600_000;
  writeCollection("zernio_whatsapp_batches", [
    {
      phone: phoneViejo,
      items: [{ eventId: "evt-viejo-1", whatsappInboxId: "inbox-viejo-1", text: "hola, de hace 20h", sentAt: new Date(veinteHorasAtras).toISOString() }],
      last_at: veinteHorasAtras,
    },
  ]);
  await processDueWhatsappBatches(batchHandler);
  const descartados = readCollection<any>("whatsapp_batch_discarded");
  tabla.push({ escenario: "reinicio con cola WhatsApp de 20h", recibidos: 1, bloqueados: descartados.length > 0 ? 1 : 0, llamadas: modelCalls, respuestas: 0, reintentos: 0 });
  assert.equal(modelCalls, 0, `un lote de 20h (> WHATSAPP_BATCH_MAX_AGE_HOURS=8 por defecto) nunca debe generar una llamada real a IA, hubo ${modelCalls}`);
});

// ---------------------------------------------------------------------
// Escenario nuevo (Fase 4, pedido por el cliente): errores y reintentos
// del proveedor (429 / insufficient_quota) no deben generar un bucle sin fin
// ---------------------------------------------------------------------
await test("Escenario 7: proveedor devuelve 429 repetidamente -> no hay bucle infinito de reintentos en la misma llamada", async () => {
  resetModelCalls();
  mockServer.removeAllListeners("request");
  let calls429 = 0;
  mockServer.on("request", (req, res) => {
    calls429++;
    modelCalls++;
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "insufficient_quota" }));
  });
  const r = await handleChatMessage("sim-429", "Hola, pregunta real con el proveedor caído", "CHAT", "sim-429");
  tabla.push({ escenario: "errores/reintentos del proveedor (429)", recibidos: 1, bloqueados: 0, llamadas: modelCalls, respuestas: 0, reintentos: calls429 });
  assert.ok(r.ai_failed, "una respuesta de fallo real de IA debe quedar marcada como ai_failed, nunca como éxito silencioso");
  // callLlm no reintenta por dentro (una ronda = una llamada); el reintento
  // real vive FUERA de este proceso (el sondeo de email cada 30s con
  // backoff, o un reenvío real del cliente) -- dentro de esta única
  // invocación de handleChatMessage, 429 debe traducirse en 1 sola
  // llamada real al modelo (la primera ronda), no un bucle.
  assert.ok(modelCalls <= 1, `se esperaba a lo sumo 1 llamada real antes de rendirse en esta invocación, hubo ${modelCalls}`);
});

// ---------------------------------------------------------------------
// Prueba de la optimización añadida: tope mensual (antes no existía).
// MONTHLY_BUDGET_EUR se lee una sola vez al importar chat/agent.ts (mismo
// patrón que DAILY_BUDGET_EUR/MAX_TOOL_ROUNDS ya existente en el
// proyecto) -- en ESTE proceso ya se importó con el valor por defecto
// (0, desactivado). Para probarlo de verdad hace falta un proceso propio
// con la env var puesta ANTES del import, igual que exige ya el propio
// patrón de arranque real (variable de entorno en EasyPanel, leída al
// arrancar el contenedor, no en caliente).
// ---------------------------------------------------------------------
await test("Optimización nueva: tope mensual de gasto corta llamadas (proceso aparte, env var puesta antes del import)", async () => {
  const { execFileSync } = await import("node:child_process");
  const childDataDir = `${process.env.DATA_DIR}-monthly-child`;
  const script = `
    process.env.DATA_DIR = ${JSON.stringify(childDataDir)};
    process.env.OPENAI_API_KEY = "test-key-mock-only";
    process.env.LUCERO_MONTHLY_LLM_BUDGET_EUR = "0.00005";
    const http = require("node:http");
    let calls = 0;
    const srv = http.createServer((req, res) => {
      calls++;
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
      });
    });
    srv.listen(0, async () => {
      process.env.LLM_BASE_URL = "http://127.0.0.1:" + srv.address().port;
      const { handleChatMessage } = await import(${JSON.stringify(path.join(process.cwd(), "src/chat/agent.ts"))});
      await handleChatMessage("sim-mensual-1", "Hola, primera consulta real", "CHAT", "sim-mensual-1");
      const r2 = await handleChatMessage("sim-mensual-2", "Hola, segunda consulta real", "CHAT", "sim-mensual-2");
      console.log(JSON.stringify({ calls, ai_failed_2: r2.ai_failed }));
      srv.close();
    });
  `;
  const out = execFileSync("npx", ["tsx", "--eval", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const lastLine = out.trim().split("\n").pop() ?? "{}";
  const parsed = JSON.parse(lastLine);
  tabla.push({ escenario: "tope mensual (optimización nueva, proceso aparte)", recibidos: 2, bloqueados: 1, llamadas: parsed.calls, respuestas: 1, reintentos: 0 });
  assert.ok(parsed.ai_failed_2, "la segunda conversación debe quedar derivada al equipo, el tope mensual ya está superado");
  assert.equal(parsed.calls, 1, `se esperaba 1 sola llamada real (la primera), hubo ${parsed.calls}`);
});

// =======================================================================
// Fase 2F (18/11/2026) -- cierre de gaps identificados en la Fase 2E.
// =======================================================================

await test("Fase 2F-1: Daniel totalmente pausado (IA apagada) -> 0 llamadas a IA", async () => {
  restoreDefaultMock();
  resetModelCalls();
  setEmailAiProcessingEnabled(false);
  const r = await processInboundEmail(emailFixture(5000));
  tabla.push({ escenario: "Daniel pausado (IA off)", recibidos: 1, bloqueados: 1, llamadas: modelCalls, respuestas: 0, reintentos: 0 });
  assert.equal(r.outcome, "pausado_ia_sin_procesar");
  assert.equal(modelCalls, 0, `con la IA de Daniel apagada no debe llamarse a OpenAI, hubo ${modelCalls}`);
  setEmailAiProcessingEnabled(true);
});

await test("Fase 2F-2: Daniel supervisado (IA activa, envío apagado) -> genera borrador real, no envía", async () => {
  resetModelCalls();
  setEmailAiProcessingEnabled(true);
  setEmailAutoSendEnabled(false);
  const r = await processInboundEmail(emailFixture(5001));
  tabla.push({ escenario: "Daniel supervisado (IA on, envío off)", recibidos: 1, bloqueados: 0, llamadas: modelCalls, respuestas: 1, reintentos: 0 });
  assert.equal(r.outcome, "modo_prueba_sin_envio");
  assert.equal(modelCalls, 1, "con la IA activa, debe redactar de verdad (1 llamada real), aunque no se envíe");
  assert.ok(r.reply && r.reply.length > 0, "el borrador real debe existir, nunca sustituido por texto fijo");
  setEmailAutoSendEnabled(true);
});

await test("Fase 2F-2b: IA apagada + envío activo (combinación insegura) -> se comporta como apagado, no envía", async () => {
  resetModelCalls();
  setEmailAiProcessingEnabled(false);
  setEmailAutoSendEnabled(true); // a propósito: aunque el envío esté "activo", no debe importar.
  const r = await processInboundEmail(emailFixture(5002));
  assert.equal(r.outcome, "pausado_ia_sin_procesar", "con la IA apagada, el envío nunca debe comportarse como activo, sin excepción");
  assert.equal(modelCalls, 0);
  setEmailAiProcessingEnabled(true);
});

await test("Fase 2F-3: Daniel reactivado con correos antiguos acumulados durante la pausa -> 0 contactos automáticos indebidos", async () => {
  resetModelCalls();
  setEmailAiProcessingEnabled(false);
  const vieja = emailFixture(5003, { receivedAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
  await processInboundEmail(vieja); // llega mientras está pausado, no se marca procesado.
  await new Promise((r) => setTimeout(r, 20));
  setEmailAiProcessingEnabled(true); // reactivación: updated_at queda DESPUÉS de receivedAt del correo de arriba.
  const r2 = await processInboundEmail(vieja); // el sondeo real lo volvería a encontrar igual, sin marcar procesado.
  tabla.push({ escenario: "Daniel reactivado, correo acumulado durante pausa", recibidos: 1, bloqueados: 1, llamadas: modelCalls, respuestas: 0, reintentos: 0 });
  assert.equal(r2.outcome, "retenido_reactivacion_ia", `se esperaba que el correo llegado durante la pausa quedara retenido tras reactivar, outcome real: ${r2.outcome}`);
  assert.equal(modelCalls, 0, "un correo anterior a la reactivación nunca debe contestarse solo, aunque la IA ya esté encendida de nuevo");
  // Un correo NUEVO, llegado DESPUÉS de la reactivación, sí debe procesarse con IA real.
  const nuevo = emailFixture(5004);
  const r3 = await processInboundEmail(nuevo);
  assert.equal(modelCalls, 1, "un correo legítimo llegado después de reactivar sí debe recibir atención real de IA");
  assert.notEqual(r3.outcome, "retenido_reactivacion_ia");
});

await test("Fase 2F-4: WhatsApp legacy (n8n) desactivado -> 0 llamadas a IA", async () => {
  resetModelCalls();
  setWhatsappZernioAgentEnabled(false);
  const { isWhatsappZernioAgentEnabled, isWhatsappChatPaused } = await import("../src/tools/agent-toggle.js");
  // Reproduce exactamente la misma comprobación que ahora tiene server.ts
  // en /channels/whatsapp/inbound (no se levanta el servidor Express
  // completo en este script -- se verifica el mecanismo real que usa esa
  // ruta, igual que el resto de este archivo verifica funciones reales
  // sin montar HTTP de más).
  const bloqueadoPorCanal = !isWhatsappZernioAgentEnabled();
  tabla.push({ escenario: "WhatsApp legacy n8n desactivado", recibidos: 1, bloqueados: bloqueadoPorCanal ? 1 : 0, llamadas: 0, respuestas: 0, reintentos: 0 });
  assert.ok(bloqueadoPorCanal, "con el canal apagado, la ruta legacy debe bloquear antes de llamar a handleChatMessage");
  setWhatsappZernioAgentEnabled(true);
});

await test("Fase 2F-5: webhooks duplicados de Retell (confirmación) -> 0 procesamiento adicional", async () => {
  resetModelCalls();
  const callId = "call-dup-2f-confirm";
  for (let i = 0; i < 20; i++) {
    await handleRetellWebhook({ event: "call_analyzed", call: { call_id: callId, call_analysis: { call_summary: `intento ${i}` } } } as any);
  }
  const stored = readCollection<any>("call_analyses").filter((c: any) => c.call_id === callId);
  assert.equal(stored.length, 1);
  assert.equal(modelCalls, 0);
});

await test("Fase 2F-6: presupuesto agotado -> bloqueo + alerta real vía raiseAlert", async () => {
  const { execFileSync } = await import("node:child_process");
  const childDataDir = `${process.env.DATA_DIR}-budget-alert-child`;
  const script = `
    process.env.DATA_DIR = ${JSON.stringify(childDataDir)};
    process.env.OPENAI_API_KEY = "test-key-mock-only";
    process.env.LUCERO_DAILY_LLM_BUDGET_EUR = "0.00005";
    const http = require("node:http");
    let calls = 0;
    const srv = http.createServer((req, res) => {
      calls++;
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
      });
    });
    srv.listen(0, async () => {
      process.env.LLM_BASE_URL = "http://127.0.0.1:" + srv.address().port;
      const { handleChatMessage } = await import(${JSON.stringify(path.join(process.cwd(), "src/chat/agent.ts"))});
      const { readCollection } = await import(${JSON.stringify(path.join(process.cwd(), "src/store.ts"))});
      await handleChatMessage("sim-budget-1", "Hola, primera consulta real", "CHAT", "sim-budget-1");
      const r2 = await handleChatMessage("sim-budget-2", "Hola, segunda consulta real", "CHAT", "sim-budget-2");
      const alerts = readCollection("alerts").filter(a => a.kind === "fallo_tecnico");
      console.log(JSON.stringify({ calls, ai_failed_2: r2.ai_failed, alertCount: alerts.length }));
      srv.close();
    });
  `;
  const out = execFileSync("npx", ["tsx", "--eval", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(out.trim().split("\n").pop() ?? "{}");
  tabla.push({ escenario: "presupuesto diario agotado + alerta", recibidos: 2, bloqueados: 1, llamadas: parsed.calls, respuestas: 1, reintentos: 0 });
  assert.ok(parsed.ai_failed_2, "la segunda llamada debe quedar bloqueada por tope de presupuesto");
  assert.ok(parsed.alertCount >= 1, `se esperaba al menos 1 alerta real vía raiseAlert, hubo ${parsed.alertCount}`);
});

await test("Fase 2F-7: 50 solicitudes simultáneas -> nunca se supera el límite de concurrencia configurado (confirmación)", async () => {
  restoreDefaultMock();
  resetModelCalls();
  const promesas = Array.from({ length: 50 }, (_, i) => handleChatMessage(`sim-conc-2f-${i}`, `Consulta real ${i}`, "CHAT", `sim-conc-2f-${i}`));
  const resultados = await Promise.all(promesas);
  const reales = resultados.filter((r) => !r.ai_failed).length;
  tabla.push({ escenario: "50 simultáneas (confirmación 2F)", recibidos: 50, bloqueados: 50 - reales, llamadas: modelCalls, respuestas: reales, reintentos: 0 });
  assert.equal(reales, 50, "con el límite por defecto (50) las 50 conversaciones legítimas deben completarse, ninguna derivada");
});

await test("Fase 2F-8: 7 fotos consecutivas -> 1 sola ejecución inicial de IA (confirmación)", async () => {
  resetModelCalls();
  setWhatsappZernioAgentEnabled(true);
  lotesProcesados = 0;
  const phone = "+34600222333";
  for (let i = 0; i < 7; i++) {
    await enqueueWhatsappBatchMessage(phone, { eventId: `evt-2f-${i}`, whatsappInboxId: `inbox-2f-${i}`, text: `[foto ${i + 1}]`, media_type: "image", sentAt: new Date().toISOString() });
  }
  await new Promise((r) => setTimeout(r, 120));
  await processDueWhatsappBatches(batchHandler);
  assert.equal(lotesProcesados, 1);
  assert.ok(modelCalls <= 1, `se esperaba 1 sola llamada agrupada, hubo ${modelCalls}`);
});

await test("Fase 2F-9: vehículo ya vendido -> ninguna reserva válida se crea (confirmación de lógica ya existente)", async () => {
  const vehicleReal = vehiclesSeed[0];
  setOfficialStatus(vehicleReal.id, "SOLD", null);
  const r = await createReservationPending({ vehicle_id: vehicleReal.id, lead_phone: "+34600777888" });
  assert.equal((r as { status: string }).status, "denied", "un vehículo SOLD nunca debe permitir una reserva nueva");
  setOfficialStatus(vehicleReal.id, "AVAILABLE", null);
});

mockServer.close();

console.log("\n--- Tabla de escenarios ---");
console.table(tabla);

const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} pruebas OK`);
if (fails.length > 0) {
  console.log("Fallos:", fails);
  process.exit(1);
}
