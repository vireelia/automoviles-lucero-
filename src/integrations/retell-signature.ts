import crypto from "crypto";

// Retell firma cada webhook con HMAC-SHA256, usando la API key con insignia de
// webhook como secreto, sobre el cuerpo sin procesar concatenado con la marca de
// tiempo en milisegundos. La cabecera X-Retell-Signature llega como "v=<ts>,d=<hex>".
// Se rechazan las peticiones con más de 5 minutos para evitar repeticiones.
const MAX_AGE_MS = 5 * 60 * 1000;

export function verifyRetellSignature(
  rawBody: string,
  header: string | undefined,
  apiKey: string | undefined,
  now = Date.now(),
): boolean {
  if (!apiKey || !header) return false;
  const fields = new Map<string, string>();
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) fields.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const timestamp = fields.get("v");
  const digest = fields.get("d");
  if (!timestamp || !digest || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp)) > MAX_AGE_MS) return false;
  const expected = Buffer.from(
    crypto.createHmac("sha256", apiKey).update(rawBody + timestamp).digest("hex"),
    "hex",
  );
  const received = Buffer.from(digest, "hex");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}
