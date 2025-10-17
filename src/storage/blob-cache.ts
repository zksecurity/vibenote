// Persistent cache for GitHub blob payloads keyed by repository and SHA.
// Stores base64 payloads in the Cache API when available, with an in-memory fallback.
export type { BlobCacheKey };
export { readCachedBlob, writeCachedBlob, clearBlobCache };

type BlobCacheKey = {
  owner: string;
  repo: string;
  sha: string;
};

const CACHE_NAMESPACE = 'vibenote/blob-cache/v1';

const memoryStore = new Map<string, string>();

function buildCacheId(key: BlobCacheKey): string {
  let { owner, repo, sha } = key;
  return `https://vibenote.blob/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(
    sha
  )}`;
}

function hasCacheApi(): boolean {
  return typeof globalThis.caches === 'object' && globalThis.caches !== null;
}

async function openCache(): Promise<Cache | null> {
  if (!hasCacheApi()) return null;
  try {
    return await globalThis.caches.open(CACHE_NAMESPACE);
  } catch {
    return null;
  }
}

async function readFromPersistentCache(id: string): Promise<string | null> {
  let cache = await openCache();
  if (!cache) return null;
  try {
    let match = await cache.match(id);
    if (!match) return null;
    let text = await match.text();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

async function writeToPersistentCache(id: string, payload: string): Promise<void> {
  let cache = await openCache();
  if (!cache) return;
  try {
    let response = new Response(payload, {
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'public, immutable',
      },
    });
    await cache.put(id, response);
  } catch {
    // ignore failed writes
  }
}

async function deletePersistentCache(): Promise<void> {
  if (!hasCacheApi()) return;
  try {
    await globalThis.caches.delete(CACHE_NAMESPACE);
  } catch {
    // ignore cache deletion errors
  }
}

async function readFromMemory(id: string): Promise<string | null> {
  let value = memoryStore.get(id);
  return value === undefined || value === '' ? null : value;
}

async function writeToMemory(id: string, payload: string): Promise<void> {
  if (payload === '') return;
  memoryStore.set(id, payload);
}

function clearMemory(): void {
  memoryStore.clear();
}

async function readCachedBlob(key: BlobCacheKey): Promise<string | null> {
  let id = buildCacheId(key);
  let memory = await readFromMemory(id);
  if (memory !== null) return memory;
  let stored = await readFromPersistentCache(id);
  if (stored === null) return null;
  await writeToMemory(id, stored);
  return stored;
}

async function writeCachedBlob(key: BlobCacheKey, payload: string): Promise<void> {
  if (payload === '') return;
  let id = buildCacheId(key);
  await writeToMemory(id, payload);
  await writeToPersistentCache(id, payload);
}

async function clearBlobCache(): Promise<void> {
  clearMemory();
  await deletePersistentCache();
}
