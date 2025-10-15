// Helpers for the public share viewer to talk to the backend API.
type ShareMetaResponse = {
  id: string;
  createdAt: string;
  createdBy: { login: string };
};

export type { ShareMetaResponse };
export { getApiBase, fetchShareMeta, fetchShareContent };

let cachedBase: string | null = null;

function getApiBase(): string {
  if (cachedBase) return cachedBase;
  const env = (import.meta as any).env || {};
  const fromEnv: string | undefined = env.VITE_VIBENOTE_API_BASE || env.VIBENOTE_API_BASE;
  const fromGlobal: string | undefined = (globalThis as any).VIBENOTE_API_BASE;
  const base = fromEnv ?? fromGlobal ?? '';
  if (!base) throw new Error('VIBENOTE_API_BASE not set for share viewer');
  cachedBase = String(base).replace(/\/$/, '');
  return cachedBase;
}

async function fetchShareMeta(id: string): Promise<Response> {
  const res = await fetch(`${getApiBase()}/v1/share-links/${encodeURIComponent(id)}`, {
    headers: { Accept: 'application/json' },
  });
  return res;
}

async function fetchShareContent(id: string): Promise<Response> {
  return await fetch(`${getApiBase()}/v1/share-links/${encodeURIComponent(id)}/content`, {
    headers: { Accept: 'text/markdown' },
  });
}
