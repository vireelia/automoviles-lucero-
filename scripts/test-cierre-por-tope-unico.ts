// Uso: DATA_DIR=/tmp/lucero-test-$$ npx tsx scripts/test-cierre-por-tope-unico.ts
// Caso real 22/11/2026 (Erika Mendoza, 27 mensajes): el cierre duro por tope de
// mensajes se mandó 4 veces. Debe mandarse UNA sola vez por conversación.
import path from "path";
if (!process.env.DATA_DIR || process.env.DATA_DIR.includes(path.join("automoviles-lucero", "data"))) {
  console.error("Niega ejecutar sin una DATA_DIR de prueba explícita y distinta de la de producción.");
  process.exit(1);
}
process.env.OPENAI_API_KEY ||= "sk-test-no-se-usa";
const { writeCollection, readCollection } = await import("../src/store.js");
const { handleChatMessage } = await import("../src/chat/agent.js");

let ok = 0, total = 0;
function check(name: string, cond: boolean) {
  total++;
  if (cond) { ok++; console.log("  ✓", name); } else console.log("  ✗ FALLA:", name);
}

const phone = "+34600000777";
const msgs = Array.from({ length: 30 }, (_, i) => [
  { role: "user", content: `mensaje ${i}` },
  { role: "assistant", content: `respuesta ${i}` },
]).flat();
writeCollection("chat_conversations", [{ id: phone, messages: msgs, updated_at: new Date().toISOString(), user_turn_count: 1 }]);

const r1 = await handleChatMessage(phone, "otra pregunta", "WHATSAPP", phone);
check("1er mensaje tras el tope: se manda el cierre", r1.reply.includes("Para no alargar mucho más la conversación") && !r1.silent);

const r2 = await handleChatMessage(phone, "hola?", "WHATSAPP", phone);
check("2º mensaje: NO se repite el cierre (silencio)", r2.silent === true && r2.reply === "");
const r3 = await handleChatMessage(phone, "alguien?", "WHATSAPP", phone);
check("3er mensaje: sigue en silencio", r3.silent === true && r3.reply === "");
const r4 = await handleChatMessage(phone, "responded", "WHATSAPP", phone);
check("4º mensaje: sigue en silencio", r4.silent === true && r4.reply === "");

const conv = readCollection<{ id: string; messages: { role: string; content: string }[] }>("chat_conversations").find((c) => c.id === phone)!;
const cierres = conv.messages.filter((m) => m.role === "assistant" && m.content.includes("Para no alargar mucho más")).length;
check("en el historial hay exactamente 1 cierre", cierres === 1);
check("los mensajes del cliente se guardan igualmente", conv.messages.some((m) => m.content === "alguien?"));

const handoffs = readCollection<{ lead_phone?: string; reason?: string }>("handoffs").filter((h) => h.lead_phone === phone && (h.reason ?? "").includes("tope"));
check("el aviso al equipo salió una sola vez", handoffs.length === 1);

console.log(`\n${ok}/${total} pruebas superadas.`);
process.exit(ok === total ? 0 : 1);
