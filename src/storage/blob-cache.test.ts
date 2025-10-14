import { describe, expect, test, vi } from 'vitest';

import type { BlobCacheKey } from './blob-cache';

const CACHE_NAMESPACE = 'vibenote/blob-cache/v1';

function buildId(key: BlobCacheKey): string {
  return `https://vibenote.blob/${encodeURIComponent(key.owner)}/${encodeURIComponent(
    key.repo
  )}/${encodeURIComponent(key.sha)}`;
}

describe('blob-cache', () => {
  test('falls back to memory storage when Cache API is unavailable', async () => {
    const originalCaches = (globalThis as { caches?: CacheStorage }).caches;
    const key: BlobCacheKey = { owner: 'user', repo: 'repo', sha: 'sha1' };
    (globalThis as { caches?: CacheStorage }).caches = undefined;
    vi.resetModules();
    const { readCachedBlob, writeCachedBlob, clearBlobCache } = await import('./blob-cache');
    await clearBlobCache();
    expect(await readCachedBlob(key)).toBeNull();
    await writeCachedBlob(key, 'YmFzZTY0');
    expect(await readCachedBlob(key)).toBe('YmFzZTY0');
    await clearBlobCache();
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: CacheStorage }).caches;
    } else {
      (globalThis as { caches?: CacheStorage }).caches = originalCaches;
    }
  });

  test('persists payloads through the Cache API', async () => {
    const originalCaches = (globalThis as { caches?: CacheStorage }).caches;
    const { MockCacheStorage } = await import('../test/mock-cache-storage');
    const storage = new MockCacheStorage();
    (globalThis as { caches?: CacheStorage }).caches = storage as unknown as CacheStorage;
    const key: BlobCacheKey = { owner: 'user', repo: 'repo', sha: 'sha2' };

    vi.resetModules();
    const { writeCachedBlob } = await import('./blob-cache');
    await writeCachedBlob(key, 'c3VwZXItZGF0YQ==');

    expect(storage.peek(CACHE_NAMESPACE, buildId(key))).toBe('c3VwZXItZGF0YQ==');

    vi.resetModules();
    const { readCachedBlob, clearBlobCache } = await import('./blob-cache');
    (globalThis as { caches?: CacheStorage }).caches = storage as unknown as CacheStorage;
    expect(await readCachedBlob(key)).toBe('c3VwZXItZGF0YQ==');

    await clearBlobCache();
    expect(storage.peek(CACHE_NAMESPACE, buildId(key))).toBeNull();
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: CacheStorage }).caches;
    } else {
      (globalThis as { caches?: CacheStorage }).caches = originalCaches;
    }
  });
});
