// @vitest-environment node
// Tests for GitHub App helpers: installation lookup and request deadlines.
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import type { Env } from '../env.ts';
import { getOwnerInstallationId, githubFetch } from '../github-app.ts';

// The global setup file stubs fetch with vi.fn(). We need the real one.
const realFetch = globalThis.fetch.bind(globalThis);

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const env: Env = {
  PORT: 0,
  ALLOWED_ORIGINS: [],
  PREVIEW_ALLOWED_GITHUB_USERS: undefined,
  PREVIEW_URL_PATTERN: undefined,
  GITHUB_APP_SLUG: 'test-app',
  GITHUB_APP_ID: 1,
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  GITHUB_OAUTH_CLIENT_ID: 'client-id',
  GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
  GITHUB_WEBHOOK_SECRET: undefined,
  SESSION_JWT_SECRET: 'test-secret',
  SESSION_STORE_FILE: '/dev/null',
  SESSION_ENCRYPTION_KEY: '0'.repeat(64),
  REPO_ID_STORE_FILE: '/dev/null',
  PUBLIC_VIEWER_BASE_URL: 'https://vibenote.test',
};

describe('getOwnerInstallationId', () => {
  it('resolves installations per owner from the paginated installation list', async () => {
    // 100 installations on the first page, one on the second
    let firstPage = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, account: { login: `user-${i}` } }));
    let requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requests.push(url);
        let page = new URL(url).searchParams.get('page');
        return Response.json(page === '1' ? firstPage : [{ id: 500, account: { login: 'Acme-Org' } }]);
      })
    );

    // Owner logins are case-insensitive
    expect(await getOwnerInstallationId(env, 'acme-org')).toBe(500);
    expect(await getOwnerInstallationId(env, 'USER-7')).toBe(8);
    await expect(getOwnerInstallationId(env, 'unknown')).rejects.toThrow('app not installed for owner');

    // One list load served all lookups, and no per-repository endpoint was used
    expect(requests).toHaveLength(2);
    expect(requests.every((url) => url.startsWith('https://api.github.com/app/installations?'))).toBe(true);
  });
});

describe('githubFetch', () => {
  it('aborts when GitHub does not respond within the deadline', async () => {
    // A server that accepts requests and never answers
    let server = http.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    let address = server.address();
    if (address === null || typeof address === 'string') throw Error('unexpected server address');
    vi.stubGlobal('fetch', realFetch);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let pending = githubFetch(`http://127.0.0.1:${address.port}/`);
      let settled = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(10_000);
      await settled;
    } finally {
      vi.useRealTimers();
      server.closeAllConnections();
      server.close();
    }
  });
});
