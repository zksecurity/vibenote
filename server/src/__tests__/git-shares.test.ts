// @vitest-environment node
// Integration tests for git-native shares endpoints.
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

// --- Hoisted mocks (available before vi.mock factories run) ---

const {
  mockGetRepoInstallationId,
  mockInstallationRequest,
  mockVerifyBearerSession,
  REPO_KEY_FILE,
  TEMP_DIR,
} = vi.hoisted(() => {
  const path = require('node:path');
  const os = require('node:os');
  const dir = path.join(os.tmpdir(), `vibenote-git-shares-test-${process.pid}`);
  return {
    mockGetRepoInstallationId: vi.fn() as any,
    mockInstallationRequest: vi.fn() as any,
    mockVerifyBearerSession: vi.fn() as any,
    TEMP_DIR: dir,
    REPO_KEY_FILE: path.join(dir, 'repo-keys.json'),
  };
});

vi.mock('../env.ts', () => ({
  env: {
    PORT: 0,
    ALLOWED_ORIGINS: ['http://localhost'],
    GITHUB_APP_ID: 12345,
    GITHUB_APP_PRIVATE_KEY: 'fake-key',
    GITHUB_APP_SLUG: 'test-app',
    GITHUB_OAUTH_CLIENT_ID: 'fake-client-id',
    GITHUB_OAUTH_CLIENT_SECRET: 'fake-client-secret',
    SESSION_JWT_SECRET: 'test-secret',
    SESSION_STORE_FILE: '/dev/null',
    SESSION_ENCRYPTION_KEY: '0'.repeat(64),
    SHARE_STORE_FILE: '/dev/null',
    REPO_KEY_STORE_FILE: REPO_KEY_FILE,
    PUBLIC_VIEWER_BASE_URL: 'https://test.vibenote.dev',
  },
}));

vi.mock('../github-app.ts', () => ({
  getRepoInstallationId: mockGetRepoInstallationId,
  getInstallationToken: vi.fn().mockResolvedValue('fake-token'),
  installationRequest: mockInstallationRequest,
}));

vi.mock('../api.ts', () => ({
  verifyBearerSession: mockVerifyBearerSession,
}));

// --- Now import the modules under test (after mocks are in place) ---

import express from 'express';
import { gitShareEndpoints } from '../git-shares.ts';

// --- Helpers ---

const INSTALLATION_ID = 42;
const MARKDOWN_BODY = '# Hello World\n\nThis is a shared note.';

/**
 * Set up mock GitHub responses for a repo with specific files.
 * files: map of repo file paths to their content (string or null for 404).
 */
function setupRepoMock(
  owner: string,
  repo: string,
  files: Record<string, string | null>,
) {
  mockGetRepoInstallationId.mockImplementation(
    async (_env: any, o: string, r: string) => {
      if (o === owner && r === repo) return INSTALLATION_ID;
      throw new Error('app not installed for repository');
    },
  );

  mockInstallationRequest.mockImplementation(
    async (_env: any, _installationId: number, urlPath: string) => {
      // Extract the file path from the GitHub contents URL
      // URL format: /repos/:owner/:repo/contents/:path
      const contentsPrefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/`;
      if (!urlPath.startsWith(contentsPrefix)) {
        return new Response('not found', { status: 404 });
      }
      let filePath = urlPath.slice(contentsPrefix.length);
      // Remove query params (e.g. ?ref=...)
      const qIdx = filePath.indexOf('?');
      if (qIdx >= 0) filePath = filePath.slice(0, qIdx);
      filePath = decodeURIComponent(filePath);

      const content = files[filePath];
      if (content === undefined || content === null) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      return new Response(content, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    },
  );
}

/**
 * Encrypt a share payload into a base64url blob (inverse of decryptBlob).
 */
function encryptBlob(
  keyHex: string,
  payload: { owner: string; repo: string; shareId: string },
): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]).toString('base64url');
}

// --- Test server setup ---

let baseUrl: string;
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  gitShareEndpoints(app);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  // Clean up temp files
  await fs.rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
});

// The global setup file stubs fetch with vi.fn(). We need the real one.
const realFetch = globalThis.fetch.bind(globalThis);

beforeEach(() => {
  vi.clearAllMocks();
  // Restore real fetch (setup.ts stubs it each beforeEach)
  vi.stubGlobal('fetch', realFetch);
});

// --- Tier 1: Open shares ---

describe('Tier 1 — Open shares', () => {
  it('1. happy path: serves markdown content', async () => {
    setupRepoMock('owner', 'repo', {
      '.shares/test-note.json': JSON.stringify({ path: 'notes/hello.md' }),
      'notes/hello.md': MARKDOWN_BODY,
    });

    const res = await fetch(`${baseUrl}/v1/git-shares/owner/repo/test-note/content`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const body = await res.text();
    expect(body).toBe(MARKDOWN_BODY);
  });

  it('2. invalid share id: returns 404', async () => {
    setupRepoMock('owner', 'repo', {});

    const res = await fetch(`${baseUrl}/v1/git-shares/owner/repo/nonexistent/content`);

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('share not found');
  });

  it('3. malformed share descriptor: returns 404 not 502', async () => {
    setupRepoMock('owner', 'repo', {
      '.shares/bad-json.json': '{not valid json!!!',
    });

    const res = await fetch(`${baseUrl}/v1/git-shares/owner/repo/bad-json/content`);

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('share not found');
  });

  it('4. path traversal rejected', async () => {
    setupRepoMock('owner', 'repo', {
      '.shares/evil.json': JSON.stringify({ path: '../../../etc/passwd' }),
    });

    const res = await fetch(`${baseUrl}/v1/git-shares/owner/repo/evil/content`);

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('share not found');
  });

  it('5. non-.md path rejected', async () => {
    setupRepoMock('owner', 'repo', {
      '.shares/evil2.json': JSON.stringify({ path: 'notes/secret.txt' }),
    });

    const res = await fetch(`${baseUrl}/v1/git-shares/owner/repo/evil2/content`);

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('share not found');
  });

  it('6. metadata endpoint does not leak path', async () => {
    setupRepoMock('owner', 'repo', {
      '.shares/test-note.json': JSON.stringify({ path: 'notes/hello.md' }),
      'notes/hello.md': MARKDOWN_BODY,
    });

    const res = await fetch(`${baseUrl}/v1/git-shares/owner/repo/test-note`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ owner: 'owner', repo: 'repo', shareId: 'test-note' });
    expect(json).not.toHaveProperty('path');
  });
});

// --- Tier 2: Encrypted shares ---

describe('Tier 2 — Encrypted shares', () => {
  const KEY_HEX = crypto.randomBytes(32).toString('hex');
  const REPO_ID = 'test-repo-id';
  const ENC_OWNER = 'enc-owner';
  const ENC_REPO = 'enc-repo';
  const ENC_SHARE_ID = 'enc-share-id';

  // Register a repo id in the repo key store before tier 2 tests
  beforeAll(async () => {
    // We need to register the repo id. Since the store is internal to git-shares.ts,
    // we go through the POST /v1/repo-keys endpoint.
    // Set up mocks for the registration flow.
    mockGetRepoInstallationId.mockResolvedValue(INSTALLATION_ID);
    mockInstallationRequest.mockImplementation(
      async (_env: any, _installationId: number, urlPath: string) => {
        // collaborator permission check
        if (urlPath.includes('/collaborators/')) {
          return new Response(JSON.stringify({ permission: 'admin' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // .shares/.key file
        if (urlPath.includes('.shares/.key')) {
          return new Response(
            JSON.stringify({ repoId: REPO_ID, key: KEY_HEX }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      },
    );
    mockVerifyBearerSession.mockResolvedValue({
      sessionId: 'test-session',
      sub: 'user-1',
      login: 'testuser',
      avatarUrl: null,
      name: 'Test User',
    });

    const res = await fetch(`${baseUrl}/v1/repo-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer fake-token',
      },
      body: JSON.stringify({
        repoId: REPO_ID,
        key: KEY_HEX,
        owner: ENC_OWNER,
        repo: ENC_REPO,
      }),
    });
    expect(res.status).toBe(201);
  });

  it('7. happy path: encrypted share serves markdown', async () => {
    const blob = encryptBlob(KEY_HEX, {
      owner: ENC_OWNER,
      repo: ENC_REPO,
      shareId: ENC_SHARE_ID,
    });

    setupRepoMock(ENC_OWNER, ENC_REPO, {
      [`.shares/${ENC_SHARE_ID}.json`]: JSON.stringify({ path: 'notes/encrypted.md' }),
      'notes/encrypted.md': MARKDOWN_BODY,
    });

    const res = await fetch(`${baseUrl}/v1/git-shares/enc/${REPO_ID}/${blob}/content`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const body = await res.text();
    expect(body).toBe(MARKDOWN_BODY);
  });

  it('8. invalid repoId: returns 404', async () => {
    const blob = encryptBlob(KEY_HEX, {
      owner: ENC_OWNER,
      repo: ENC_REPO,
      shareId: ENC_SHARE_ID,
    });

    const res = await fetch(`${baseUrl}/v1/git-shares/enc/nonexistent-repo-id/${blob}/content`);

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('share not found');
  });

  it('9. tampered blob: returns 404 not 400', async () => {
    const res = await fetch(
      `${baseUrl}/v1/git-shares/enc/${REPO_ID}/dGhpc2lzZ2FyYmxlZGRhdGFub3RyZWFsbHllbmNyeXB0ZWQ/content`,
    );

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('share not found');
  });

  it('10. metadata does not leak internal details', async () => {
    const blob = encryptBlob(KEY_HEX, {
      owner: ENC_OWNER,
      repo: ENC_REPO,
      shareId: ENC_SHARE_ID,
    });

    setupRepoMock(ENC_OWNER, ENC_REPO, {
      [`.shares/${ENC_SHARE_ID}.json`]: JSON.stringify({ path: 'notes/encrypted.md' }),
      'notes/encrypted.md': MARKDOWN_BODY,
    });

    const res = await fetch(`${baseUrl}/v1/git-shares/enc/${REPO_ID}/${blob}`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(json).not.toHaveProperty('owner');
    expect(json).not.toHaveProperty('repo');
    expect(json).not.toHaveProperty('path');
    expect(json).not.toHaveProperty('shareId');
  });

  it('11. wrong repo in blob: returns 404', async () => {
    // Encrypt blob with a different owner/repo than what's registered for this repoId
    const blob = encryptBlob(KEY_HEX, {
      owner: 'wrong-owner',
      repo: 'wrong-repo',
      shareId: ENC_SHARE_ID,
    });

    const res = await fetch(`${baseUrl}/v1/git-shares/enc/${REPO_ID}/${blob}/content`);

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('share not found');
  });
});

// --- Repo keys ---

describe('Repo keys', () => {
  it('12. repoId collision rejected for different repo', async () => {
    const collisionRepoId = 'collision-repo-id';
    const collisionKeyHex = crypto.randomBytes(32).toString('hex');

    // First: register repo id for repo A
    mockGetRepoInstallationId.mockResolvedValue(INSTALLATION_ID);
    mockInstallationRequest.mockImplementation(
      async (_env: any, _installationId: number, urlPath: string) => {
        if (urlPath.includes('/collaborators/')) {
          return new Response(JSON.stringify({ permission: 'admin' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (urlPath.includes('.shares/.key')) {
          return new Response(
            JSON.stringify({ repoId: collisionRepoId, key: collisionKeyHex }),
            { status: 200 },
          );
        }
        return new Response('not found', { status: 404 });
      },
    );
    mockVerifyBearerSession.mockResolvedValue({
      sessionId: 'test-session',
      sub: 'user-1',
      login: 'testuser',
      avatarUrl: null,
      name: 'Test User',
    });

    const res1 = await fetch(`${baseUrl}/v1/repo-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer fake-token',
      },
      body: JSON.stringify({
        repoId: collisionRepoId,
        key: collisionKeyHex,
        owner: 'repo-a-owner',
        repo: 'repo-a',
      }),
    });
    expect(res1.status).toBe(201);

    // Second: try to register same repoId for repo B — should fail
    const res2 = await fetch(`${baseUrl}/v1/repo-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer fake-token',
      },
      body: JSON.stringify({
        repoId: collisionRepoId,
        key: collisionKeyHex,
        owner: 'repo-b-owner',
        repo: 'repo-b',
      }),
    });
    expect(res2.status).toBe(404);
    const json = await res2.json();
    expect(json.error).toBe('repository not found or insufficient permissions');
  });
});

// --- Error indistinguishability ---

describe('Error indistinguishability', () => {
  it('13. all error responses have identical status and message', async () => {
    // Collect error responses from different failure modes

    // a) Invalid share id (share file not found)
    setupRepoMock('owner', 'repo', {});
    const resA = await fetch(`${baseUrl}/v1/git-shares/owner/repo/nonexistent/content`);

    // b) Malformed JSON
    setupRepoMock('owner', 'repo', {
      '.shares/bad-json.json': 'not json at all {{{',
    });
    const resB = await fetch(`${baseUrl}/v1/git-shares/owner/repo/bad-json/content`);

    // c) Bad path (traversal)
    setupRepoMock('owner', 'repo', {
      '.shares/bad-path.json': JSON.stringify({ path: '../../etc/passwd' }),
    });
    const resC = await fetch(`${baseUrl}/v1/git-shares/owner/repo/bad-path/content`);

    // d) Non-.md extension
    setupRepoMock('owner', 'repo', {
      '.shares/bad-ext.json': JSON.stringify({ path: 'notes/file.txt' }),
    });
    const resD = await fetch(`${baseUrl}/v1/git-shares/owner/repo/bad-ext/content`);

    // e) Non-existent repo (installation not found)
    mockGetRepoInstallationId.mockRejectedValue(
      new Error('app not installed for repository'),
    );
    const resE = await fetch(`${baseUrl}/v1/git-shares/no-owner/no-repo/sometoken/content`);

    // All should be 404 with identical body
    const bodies = await Promise.all(
      [resA, resB, resC, resD, resE].map(async (r) => {
        expect(r.status).toBe(404);
        return r.json();
      }),
    );

    const expectedBody = { error: 'share not found' };
    for (const body of bodies) {
      expect(body).toEqual(expectedBody);
    }
  });
});
