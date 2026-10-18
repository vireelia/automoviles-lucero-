// Publicación/programación de contenido en redes sociales vía Zernio
// (https://zernio.com). Se usa para difundir el contenido que genera el
// Studio (Higgsfield) sin salir del CRM. El cliente lee ZERNIO_API_KEY
// del entorno igual que el resto de integraciones del proyecto; si falta,
// las funciones devuelven un error controlado en vez de lanzar, para no
// tumbar el proceso por una integración opcional.
import { Zernio } from "@zernio/node";

let client: Zernio | null = null;

function getClient(): Zernio | null {
  if (!process.env.ZERNIO_API_KEY) return null;
  if (!client) client = new Zernio({ apiKey: process.env.ZERNIO_API_KEY });
  return client;
}

export function isZernioConnected(): boolean {
  return Boolean(process.env.ZERNIO_API_KEY);
}

export type ZernioAccount = { id: string; platform: string; [key: string]: unknown };

export async function listZernioAccounts(): Promise<
  { ok: true; accounts: ZernioAccount[] } | { ok: false; error: string }
> {
  const zernio = getClient();
  if (!zernio) return { ok: false, error: "zernio_no_configurado" };
  try {
    const { data } = await zernio.accounts.listAccounts();
    return { ok: true, accounts: (data?.accounts ?? data ?? []) as ZernioAccount[] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type PublishPostInput = {
  content: string;
  mediaUrls?: string[];
  platforms: { platform: string; accountId: string }[];
  scheduledFor?: string; // ISO; si se omite y publishNow no es true, queda como borrador
  publishNow?: boolean;
};

export async function publishZernioPost(
  input: PublishPostInput
): Promise<{ ok: true; postId: string; status: string } | { ok: false; error: string }> {
  const zernio = getClient();
  if (!zernio) return { ok: false, error: "zernio_no_configurado" };
  if (!input.platforms.length) return { ok: false, error: "sin_cuentas_destino" };
  try {
    const { data } = await zernio.posts.createPost({
      body: {
        content: input.content,
        mediaUrls: input.mediaUrls,
        platforms: input.platforms,
        ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
        ...(input.publishNow ? { publishNow: true } : {}),
      },
    });
    return { ok: true, postId: data.post._id, status: data.post.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
