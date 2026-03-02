import crypto from 'node:crypto';
import type express from 'express';
import { env } from './env.ts';
import { getRepoInstallationId, installationRequest } from './github-app.ts';
import { resolveAssetPath, encodeAssetPath, collectAssetPaths } from './share-assets.ts';
import { createRepoKeyStore } from './repo-key-store.ts';
import { handleErrors, HttpError, requireSession } from './common.ts';

export { gitShareEndpoints };

// --- Validation helpers ---

// Token minimum length is 4 to allow readable names, but SHORT TOKENS ARE INSECURE
// for tier 1 open shares on private repos (where the token is the only secret).
// 4 chars ≈ 16M combinations = brute-forceable. 16+ chars ≈ 96+ bits = secure.
//
// The VibeNote UI / CLI MUST default to generating cryptographically random tokens
// (e.g. crypto.randomBytes(18).toString('base64url') = 24 chars, 144 bits).
// Short human-readable tokens should only be used on public repos or with tier 2
// encryption where the token is inside the encrypted blob.
//
// DO NOT raise the minimum here to enforce this — it would break tier 2 where
// short tokens are fine (security comes from encryption, not token entropy).
// Instead, enforce secure defaults in the UI/CLI layer.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

function isValidToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

function isValidOwnerRepo(owner: string, repo: string): boolean {
  const seg = /^[A-Za-z0-9._-]{1,100}$/;
  return seg.test(owner) && seg.test(repo);
}

// --- Asset cache (same pattern as sharing.ts) ---

const assetCache = new Map<string, { paths: Set<string>; cachedAt: number }>();
const ASSET_CACHE_TTL_MS = 5 * 60 * 1000;

// --- Repo key store ---

const repoKeyStore = createRepoKeyStore({ filePath: env.REPO_KEY_STORE_FILE });
await repoKeyStore.init();

// --- GitHub helpers ---

async function fetchRepoFile(owner: string, repo: string, filePath: string, accept: string, ref?: string): Promise<Response> {
  let installationId: number;
  try {
    installationId = await getRepoInstallationId(env, owner, repo);
  } catch {
    throw HttpError(404, 'share not found');
  }
  const pathSegment = encodeAssetPath(filePath);
  const url = ref
    ? `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${pathSegment}?ref=${encodeURIComponent(ref)}`
    : `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${pathSegment}`;
  const res = await installationRequest(env, installationId, url, { headers: { Accept: accept } });
  if (res.status === 404) throw HttpError(404, 'share not found');
  if (!res.ok) {
    // Log actual error server-side, return generic 404 to avoid leaking repo existence
    const text = await res.text().catch(() => '');
    console.error(`[vibenote] github fetch error: ${res.status} ${text}`);
    throw HttpError(404, 'share not found');
  }
  return res;
}

async function fetchShareJson(owner: string, repo: string, token: string, ref?: string): Promise<{ path: string; ref?: string }> {
  const GENERIC = 'share not found';
  const ghRes = await fetchRepoFile(owner, repo, `.shares/${token}.json`, 'application/vnd.github.raw', ref);
  const raw = await ghRes.text();
  let parsed: { path?: string; ref?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw HttpError(404, GENERIC);
  }
  if (!parsed || typeof parsed.path !== 'string') {
    throw HttpError(404, GENERIC);
  }
  const p = parsed.path;
  if (!p || !p.toLowerCase().endsWith('.md')) throw HttpError(404, GENERIC);
  let sanitized = p.replace(/\\/g, '/').replace(/^\/+/, '');
  if (sanitized.includes('..')) throw HttpError(404, GENERIC);
  const parsedRef = typeof parsed.ref === 'string' ? parsed.ref : undefined;
  return { path: sanitized, ref: parsedRef };
}

async function fetchCollaboratorPermission(
  installationId: number,
  owner: string,
  repo: string,
  login: string
): Promise<string | null> {
  try {
    const res = await installationRequest(
      env,
      installationId,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(
        login
      )}/permission`,
      { headers: { Accept: 'application/vnd.github+json' } }
    );
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) {
      const text = await res.text();
      throw HttpError(502, `github error ${res.status}: ${text}`);
    }
    const json = (await res.json()) as { permission?: string } | null;
    return json && typeof json.permission === 'string' ? json.permission : null;
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw HttpError(502, message);
  }
}

function hasWritePermission(permission: string): boolean {
  return permission === 'admin' || permission === 'maintain' || permission === 'write';
}

// --- AES-256-GCM helpers ---

function decryptBlob(keyHex: string, blobBase64url: string): { owner: string; repo: string; token: string } {
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (keyBuf.length !== 32) throw HttpError(400, 'invalid key');

  const combined = Buffer.from(blobBase64url, 'base64url');
  // iv(12) + ciphertext(variable) + authTag(16)
  if (combined.length < 12 + 1 + 16) throw HttpError(400, 'invalid encrypted blob');

  const iv = combined.subarray(0, 12);
  const authTag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(12, combined.length - 16);

  let plaintext: string;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw HttpError(400, 'decryption failed');
  }

  let parsed: { owner?: string; repo?: string; token?: string };
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw HttpError(400, 'invalid decrypted payload');
  }
  if (
    !parsed ||
    typeof parsed.owner !== 'string' ||
    typeof parsed.repo !== 'string' ||
    typeof parsed.token !== 'string'
  ) {
    throw HttpError(400, 'invalid decrypted payload');
  }
  return { owner: parsed.owner, repo: parsed.repo, token: parsed.token };
}

// --- Shared response helpers ---

function cacheAssets(cacheKey: string, notePath: string, markdown: string): Set<string> {
  const paths = collectAssetPaths(notePath, markdown);
  assetCache.set(cacheKey, { paths, cachedAt: Date.now() });
  return paths;
}

async function ensureAssetsLoaded(cacheKey: string, owner: string, repo: string, notePath: string, ref?: string): Promise<Set<string>> {
  const cached = assetCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt <= ASSET_CACHE_TTL_MS) {
    return cached.paths;
  }
  const ghRes = await fetchRepoFile(owner, repo, notePath, 'application/vnd.github.raw', ref);
  const markdown = await ghRes.text();
  return cacheAssets(cacheKey, notePath, markdown);
}

async function serveContent(
  res: express.Response,
  owner: string,
  repo: string,
  notePath: string,
  cacheKey: string,
  ref?: string
): Promise<void> {
  const ghRes = await fetchRepoFile(owner, repo, notePath, 'application/vnd.github.raw', ref);
  const text = await ghRes.text();
  cacheAssets(cacheKey, notePath, text);
  res
    .status(200)
    .setHeader('Content-Type', 'text/markdown; charset=utf-8')
    .setHeader('Cache-Control', 'no-store')
    .send(text);
}

async function serveAsset(
  req: express.Request,
  res: express.Response,
  owner: string,
  repo: string,
  notePath: string,
  cacheKey: string,
  ref?: string
): Promise<void> {
  const rawPathParam = decodeURIComponent(asTrimmedString(req.query.path));
  const pathCandidate = resolveAssetPath(notePath, rawPathParam);
  if (!pathCandidate) throw HttpError(400, 'invalid asset path');

  const allowedPaths = await ensureAssetsLoaded(cacheKey, owner, repo, notePath, ref);
  if (!allowedPaths.has(pathCandidate)) throw HttpError(404, 'asset not found');

  const ghRes = await fetchRepoFile(owner, repo, pathCandidate, 'application/vnd.github.raw', ref);
  const buffer = Buffer.from(await ghRes.arrayBuffer());
  const contentType = ghRes.headers.get('Content-Type') ?? 'application/octet-stream';
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=300',
    'Content-Security-Policy': "default-src 'none'",
    Vary: 'Accept-Encoding',
  };
  const etag = ghRes.headers.get('ETag');
  if (etag) headers.ETag = etag;
  const lastModified = ghRes.headers.get('Last-Modified');
  if (lastModified) headers['Last-Modified'] = lastModified;
  res.status(200).set(headers).send(buffer);
}

function asTrimmedString(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.trim();
}

// --- Tier 1 param extraction ---

function getOpenShareParams(req: express.Request): { owner: string; repo: string; token: string } {
  const params = req.params as Record<string, string | undefined>;
  const owner = (params.owner ?? '').trim();
  const repo = (params.repo ?? '').trim();
  const token = (params.token ?? '').trim();
  if (!isValidOwnerRepo(owner, repo)) throw HttpError(400, 'invalid owner/repo');
  if (!isValidToken(token)) throw HttpError(400, 'invalid token');
  return { owner, repo, token };
}

function openCacheKey(owner: string, repo: string, token: string): string {
  return `git:${owner}/${repo}/${token}`;
}

// --- Tier 2 (encrypted) param extraction ---

function getEncShareParams(req: express.Request): { owner: string; repo: string; token: string } {
  const GENERIC = 'share not found';
  const params = req.params as Record<string, string | undefined>;
  const keyId = (params.keyId ?? '').trim();
  const blob = (params.blob ?? '').trim();
  if (!keyId || !blob) throw HttpError(404, GENERIC);

  const keyRecord = repoKeyStore.get(keyId);
  if (!keyRecord) {
    // Dummy decryption to avoid timing side-channel revealing valid keyIds
    try { decryptBlob('0'.repeat(64), blob); } catch {}
    throw HttpError(404, GENERIC);
  }

  let decrypted: { owner: string; repo: string; token: string };
  try {
    decrypted = decryptBlob(keyRecord.key, blob);
  } catch {
    throw HttpError(404, GENERIC);
  }

  const { owner, repo, token } = decrypted;
  if (!isValidOwnerRepo(owner, repo) || !isValidToken(token)) {
    throw HttpError(404, GENERIC);
  }
  if (keyRecord.owner !== owner || keyRecord.repo !== repo) {
    throw HttpError(404, GENERIC);
  }

  return { owner, repo, token };
}

function encCacheKey(keyId: string, blob: string): string {
  return `enc:${keyId}/${blob}`;
}

// --- Endpoints ---

function gitShareEndpoints(app: express.Express) {
  // ==========================================
  // Tier 2 — Encrypted share resolution
  // (must be registered before Tier 1 so that
  //  /enc/:keyId/:blob doesn't match :owner/:repo/:token)
  // ==========================================

  app.get(
    '/v1/git-shares/enc/:keyId/:blob/content',
    handleErrors(async (req, res) => {
      const params = req.params as Record<string, string | undefined>;
      const keyId = (params.keyId ?? '').trim();
      const blob = (params.blob ?? '').trim();
      const { owner, repo, token } = getEncShareParams(req);
      const { path: notePath, ref } = await fetchShareJson(owner, repo, token);
      await serveContent(res, owner, repo, notePath, encCacheKey(keyId, blob), ref);
    })
  );

  app.get(
    '/v1/git-shares/enc/:keyId/:blob',
    handleErrors(async (req, res) => {
      const { owner, repo, token } = getEncShareParams(req);
      await fetchShareJson(owner, repo, token); // validate share exists
      res.json({ ok: true });
    })
  );

  app.get(
    '/v1/git-shares/enc/:keyId/:blob/assets',
    handleErrors(async (req, res) => {
      const params = req.params as Record<string, string | undefined>;
      const keyId = (params.keyId ?? '').trim();
      const blob = (params.blob ?? '').trim();
      const { owner, repo, token } = getEncShareParams(req);
      const { path: notePath, ref } = await fetchShareJson(owner, repo, token);
      await serveAsset(req, res, owner, repo, notePath, encCacheKey(keyId, blob), ref);
    })
  );

  // ==========================================
  // Tier 1 — Open share resolution
  // ==========================================

  app.get(
    '/v1/git-shares/:owner/:repo/:token/content',
    handleErrors(async (req, res) => {
      const { owner, repo, token } = getOpenShareParams(req);
      const { path: notePath, ref } = await fetchShareJson(owner, repo, token);
      await serveContent(res, owner, repo, notePath, openCacheKey(owner, repo, token), ref);
    })
  );

  app.get(
    '/v1/git-shares/:owner/:repo/:token',
    handleErrors(async (req, res) => {
      const { owner, repo, token } = getOpenShareParams(req);
      await fetchShareJson(owner, repo, token); // validate share exists
      res.json({ owner, repo, token });
    })
  );

  app.get(
    '/v1/git-shares/:owner/:repo/:token/assets',
    handleErrors(async (req, res) => {
      const { owner, repo, token } = getOpenShareParams(req);
      const { path: notePath, ref } = await fetchShareJson(owner, repo, token);
      await serveAsset(req, res, owner, repo, notePath, openCacheKey(owner, repo, token), ref);
    })
  );

  // ==========================================
  // Tier 2 — Repo keys registration
  // ==========================================

  app.post(
    '/v1/repo-keys',
    requireSession,
    handleErrors(async (req, res) => {
      const session = req.sessionUser!;
      const body = req.body as Record<string, unknown>;
      const id = asTrimmedString(body.id);
      const key = asTrimmedString(body.key);
      const owner = asTrimmedString(body.owner);
      const repo = asTrimmedString(body.repo);

      if (!id || !key || !owner || !repo) throw HttpError(400, 'missing required fields: id, key, owner, repo');
      if (!isValidOwnerRepo(owner, repo)) throw HttpError(400, 'invalid owner/repo');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw HttpError(400, 'invalid key id');
      if (!/^[0-9a-f]{64}$/i.test(key)) throw HttpError(400, 'key must be 64 hex characters (256-bit)');

      const REPO_ACCESS_DENIED = 'repository not found or insufficient permissions';

      // Verify caller has write access to the repo
      let installationId: number;
      try {
        installationId = await getRepoInstallationId(env, owner, repo);
      } catch {
        throw HttpError(404, REPO_ACCESS_DENIED);
      }

      const permission = await fetchCollaboratorPermission(installationId, owner, repo, session.login);
      if (permission === null || !hasWritePermission(permission)) {
        throw HttpError(404, REPO_ACCESS_DENIED);
      }

      // Fetch .shares/.key from repo and verify matching id
      const keyFileRes = await installationRequest(
        env,
        installationId,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeAssetPath(
          '.shares/.key'
        )}`,
        { headers: { Accept: 'application/vnd.github.raw' } }
      );
      if (keyFileRes.status === 404) throw HttpError(404, REPO_ACCESS_DENIED);
      if (!keyFileRes.ok) throw HttpError(404, REPO_ACCESS_DENIED);

      let keyFileContent: { id?: string; key?: string };
      try {
        keyFileContent = JSON.parse(await keyFileRes.text());
      } catch {
        throw HttpError(404, REPO_ACCESS_DENIED);
      }
      if (!keyFileContent || keyFileContent.id !== id || keyFileContent.key !== key) {
        throw HttpError(404, REPO_ACCESS_DENIED);
      }

      // Reject if keyId already registered for a different repo (prevent DoS via collision)
      const existing = repoKeyStore.get(id);
      if (existing && (existing.owner !== owner || existing.repo !== repo)) {
        throw HttpError(404, REPO_ACCESS_DENIED);
      }

      await repoKeyStore.set({
        id,
        key,
        owner,
        repo,
        registeredAt: new Date().toISOString(),
        registeredBy: session.login,
      });

      console.log(`[vibenote] repo key registered for ${owner}/${repo} by ${session.login}`);
      res.status(201).json({ ok: true });
    })
  );

}
