// @vitest-environment node
// Tests for the OAuth callback page rendered by the auth API.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import type { Env } from '../env.ts';
import { handleAuthCallback } from '../api.ts';
import { signState } from '../jwt.ts';
import { createSessionStore } from '../session-store.ts';

const SECRET = 'test-secret';
const env: Env = {
  PORT: 0,
  ALLOWED_ORIGINS: ['https://vibenote.test'],
  PREVIEW_ALLOWED_GITHUB_USERS: undefined,
  PREVIEW_URL_PATTERN: undefined,
  GITHUB_APP_SLUG: 'test-app',
  GITHUB_APP_ID: 1,
  GITHUB_APP_PRIVATE_KEY: 'unused',
  GITHUB_OAUTH_CLIENT_ID: 'client-id',
  GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
  GITHUB_WEBHOOK_SECRET: undefined,
  SESSION_JWT_SECRET: SECRET,
  SESSION_STORE_FILE: path.join(os.tmpdir(), `vibenote-api-test-${process.pid}.json`),
  SESSION_ENCRYPTION_KEY: '0'.repeat(64),
  REPO_ID_STORE_FILE: '/dev/null',
  PUBLIC_VIEWER_BASE_URL: 'https://vibenote.test',
};

const store = createSessionStore({
  filePath: env.SESSION_STORE_FILE,
  encryptionKey: env.SESSION_ENCRYPTION_KEY,
});

beforeAll(async () => {
  await store.init();
});

// Stub GitHub's token exchange and user endpoints; the user's display name is attacker-controlled.
function stubGitHub(name: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({
          access_token: 'access',
          token_type: 'bearer',
          scope: '',
          expires_in: 28800,
          refresh_token: 'refresh',
          refresh_token_expires_in: 15897600,
        });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json({ id: 7, login: 'mallory', name, avatar_url: null });
      }
      throw Error(`unexpected fetch ${url}`);
    })
  );
}

describe('OAuth callback page', () => {
  it('embeds user-controlled profile data without letting it escape the data element', async () => {
    let name = '</script><script>alert(1)</script><!-- &  ';
    stubGitHub(name);
    let state = await signState({ returnTo: 'https://vibenote.test/', t: Date.now() }, SECRET);
    let { html } = await handleAuthCallback(env, store, 'code', state, 'https://api.vibenote.test/callback');

    expect(html).not.toContain('<script>alert(1)');
    let match = /<script type="application\/json" id="vibenote-auth">([^<]*)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    let data: unknown = JSON.parse(match?.[1] ?? '');
    expect(data).toMatchObject({ targetOrigin: 'https://vibenote.test', message: { user: { name } } });
  });
});
