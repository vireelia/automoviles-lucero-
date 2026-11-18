// Prueba ARQUITECTÓNICA (18/11/2026, Fase 2D, encargo autorizado por
// escrito -- "no basta con crear un archivo nuevo"): no ejecuta nada del
// negocio, solo analiza el código fuente con grep real. Falla si detecta una
// llamada directa al punto de entrada REAL del proveedor (Gmail/Meta) desde
// un archivo que no está en la lista blanca documentada de abajo -- así una
// función nueva futura que intente mandar un correo o un WhatsApp saltándose
// la barrera (sendWhatsappText/deliverEmail, que SÍ aplican el chequeo 1 de
// outbound-guard.ts como defensa en profundidad) rompe esta prueba en vez de
// colarse en silencio.
//
// Qué cuenta como "punto de entrada real al proveedor" aquí, y por qué:
//   - sendGmail(...)                         -- integrations/google.ts, la
//     única función que de verdad llama a la API de Gmail para ENVIAR.
//   - fetch(`https://graph.facebook.com/.../messages` -- integrations/whatsapp.ts,
//     la única llamada real a la WhatsApp Cloud API de Meta para enviar texto.
// deliverEmail/sendWhatsappText NO son el punto de entrada al proveedor --
// son la barrera. Se puede llamar a sendWhatsappText/deliverEmail desde
// cualquier sitio (de hecho así es como se usan en todo el proyecto) porque
// internamente SIEMPRE aplican el chequeo 1 de outbound-guard.ts antes de
// llegar aquí -- es jutamente ese chequeo cableado dentro del punto de
// entrada lo que hace esta prueba significativa: no hay forma de enviar de
// verdad sin pasar por él, salvo llamando directamente a estos dos puntos.
//
// Lista blanca real, archivo por archivo, con el motivo de cada excepción:
//   - src/integrations/google.ts   -- define sendGmail (no es una llamada).
//   - src/email/agent.ts           -- deliverEmail es el único llamador real
//                                      de sendGmail, y es ahí donde vive el
//                                      chequeo 1 (barrera) antes de llamarlo.
//   - src/integrations/whatsapp.ts -- define y llama al fetch de la Cloud
//                                      API directamente dentro de
//                                      sendWhatsappText, que ya aplica el
//                                      chequeo 1 antes.
//   - src/crm/app.ts               -- UNA llamada admin-only documentada:
//                                      "/integraciones/google/probar-gmail"
//                                      manda un correo de prueba de Gmail A
//                                      SU PROPIA cuenta conectada (to =
//                                      googleStatus().connected_email) --
//                                      nunca a un cliente real, es un
//                                      diagnóstico interno de conexión, no
//                                      un canal de negocio.
//
// Uso: npx tsx scripts/test-outbound-architecture.ts

import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";

const SRC_DIR = new URL("../src", import.meta.url).pathname;

const ALLOWLIST_SEND_GMAIL = new Set(["integrations/google.ts", "email/agent.ts", "crm/app.ts"]);
const ALLOWLIST_GRAPH_SEND = new Set(["integrations/whatsapp.ts"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

type Violation = { file: string; line: number; text: string; check: string };

function scan(): Violation[] {
  const violations: Violation[] = [];
  for (const file of walk(SRC_DIR)) {
    const rel = path.relative(SRC_DIR, file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/\bsendGmail\s*\(/.test(line) && !ALLOWLIST_SEND_GMAIL.has(rel)) {
        violations.push({ file: rel, line: i + 1, text: line.trim(), check: "sendGmail directo fuera de la barrera" });
      }
      // Excluye Messenger (Facebook Page, out of scope de esta barrera --
      // usa access_token en la propia URL, patrón distinto de la WhatsApp
      // Cloud API, que lo manda en el header Authorization).
      if (/graph\.facebook\.com\/[^`'"]*\/messages/.test(line) && !line.includes("access_token=") && !ALLOWLIST_GRAPH_SEND.has(rel)) {
        violations.push({ file: rel, line: i + 1, text: line.trim(), check: "WhatsApp Cloud API directa fuera de la barrera" });
      }
    });
  }
  return violations;
}

const results: { name: string; ok: boolean; detail?: string }[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`OK   - ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    console.log(`FAIL - ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

test("ningún archivo fuera de la lista blanca llama a sendGmail o a la WhatsApp Cloud API directamente", () => {
  const violations = scan();
  if (violations.length > 0) {
    throw new Error(
      `${violations.length} llamada(s) directa(s) al proveedor fuera de la barrera:\n` +
        violations.map((v) => `  ${v.file}:${v.line} (${v.check}) -- ${v.text}`).join("\n"),
    );
  }
});

// Demostración controlada de que el mecanismo de detección funciona de
// verdad: se escribe un archivo TEMPORAL real (fuera de la lista blanca)
// simulando código "nuevo" que se salta la barrera llamando a sendGmail
// directamente, se comprueba que la prueba lo detecta, y se borra. Nunca
// queda en el repo real, y nunca ejecuta ese código -- solo analiza su texto.
test("mecanismo de detección: un archivo nuevo que llame a sendGmail directamente SÍ se detecta", () => {
  const tmpRel = "chat/__tmp_simulacion_envio_sin_barrera.ts";
  const tmpPath = path.join(SRC_DIR, tmpRel);
  writeFileSync(tmpPath, `import { sendGmail } from "../integrations/google.js";\nexport async function envioMaliciosoSimulado() {\n  await sendGmail("cliente@ejemplo.com", "asunto", "cuerpo");\n}\n`);
  try {
    const violations = scan().filter((v) => v.file.includes("__tmp_simulacion_envio_sin_barrera"));
    if (violations.length !== 1) {
      throw new Error(`se esperaba detectar exactamente 1 violación en el archivo simulado, se detectaron ${violations.length}`);
    }
  } finally {
    unlinkSync(tmpPath);
  }
});

const fallidos = results.filter((r) => !r.ok);
console.log(`\n${results.length - fallidos.length}/${results.length} pruebas superadas.`);
if (fallidos.length > 0) {
  console.log("Fallidas:", fallidos.map((f) => `${f.name}: ${f.detail}`).join("\n"));
  process.exit(1);
}
