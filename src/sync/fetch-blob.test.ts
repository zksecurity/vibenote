import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../auth/app-auth', () => {
  return {
    ensureFreshAccessToken: vi.fn(async () => 'token'),
  };
});

const CACHE_NAMESPACE = 'vibenote/blob-cache/v1';

function buildId(owner: string, repo: string, sha: string): string {
  return `https://vibenote.blob/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(
    sha
  )}`;
}

describe('fetchBlob', () => {
  let originalCaches: CacheStorage | undefined;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    originalCaches = (globalThis as { caches?: CacheStorage }).caches;
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    vi.resetModules();
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: CacheStorage }).caches;
    } else {
      (globalThis as { caches?: CacheStorage }).caches = originalCaches;
    }
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  });

  test('returns cached payloads without refetching', async () => {
    const { MockCacheStorage } = await import('../test/mock-cache-storage');
    const storage = new MockCacheStorage();
    (globalThis as { caches?: CacheStorage }).caches = storage as unknown as CacheStorage;

    const fetchSpy = vi.fn(async () => {
      return new Response(JSON.stringify({ content: 'Y2FjaGVkLWRhdGE=' }), { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    vi.resetModules();
    const ensureFreshAccessToken = (await import('../auth/app-auth')).ensureFreshAccessToken as unknown as ReturnType<
      typeof vi.fn
    >;
    ensureFreshAccessToken.mockClear();
    const { fetchBlob } = await import('./git-sync');
    const key = { owner: 'user', repo: 'repo', branch: 'main' as const };

    const first = await fetchBlob(key, 'sha1');
    expect(first).toBe('Y2FjaGVkLWRhdGE=');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ensureFreshAccessToken).toHaveBeenCalledTimes(1);

    fetchSpy.mockClear();
    ensureFreshAccessToken.mockClear();

    const second = await fetchBlob(key, 'sha1');
    expect(second).toBe('Y2FjaGVkLWRhdGE=');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ensureFreshAccessToken).not.toHaveBeenCalled();

    const stored = storage.peek(CACHE_NAMESPACE, buildId('user', 'repo', 'sha1'));
    expect(stored).toBe('Y2FjaGVkLWRhdGE=');

    const { clearBlobCache } = await import('../storage/blob-cache');
    await clearBlobCache();
  });

  test('de-duplicates concurrent fetches and retries after failures', async () => {
    const { MockCacheStorage } = await import('../test/mock-cache-storage');
    const storage = new MockCacheStorage();
    (globalThis as { caches?: CacheStorage }).caches = storage as unknown as CacheStorage;

    const fetchSpy = vi
      .fn(async () => new Response(JSON.stringify({ content: 'Zmlyc3QtdmFsdWU=' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response('', { status: 404 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    vi.resetModules();
    const ensureFreshAccessToken = (await import('../auth/app-auth')).ensureFreshAccessToken as unknown as ReturnType<
      typeof vi.fn
    >;
    ensureFreshAccessToken.mockClear();
    const { fetchBlob } = await import('./git-sync');
    const key = { owner: 'user', repo: 'repo', branch: 'main' as const };

    const [firstAttempt, secondAttempt] = await Promise.all([fetchBlob(key, 'sha2'), fetchBlob(key, 'sha2')]);
    expect(firstAttempt).toBe('');
    expect(secondAttempt).toBe('');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockImplementation(async () => {
      return new Response(JSON.stringify({ content: 'Zmlyc3QtdmFsdWU=' }), { status: 200 });
    });

    const third = await fetchBlob(key, 'sha2');
    expect(third).toBe('Zmlyc3QtdmFsdWU=');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const fourth = await fetchBlob(key, 'sha2');
    expect(fourth).toBe('Zmlyc3QtdmFsdWU=');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const stored = storage.peek(CACHE_NAMESPACE, buildId('user', 'repo', 'sha2'));
    expect(stored).toBe('Zmlyc3QtdmFsdWU=');

    const { clearBlobCache } = await import('../storage/blob-cache');
    await clearBlobCache();
  });
});
