import crypto from 'node:crypto';
import type express from 'express';
import { env } from './env.ts';
import { getRepoInstallationId, installationRequest } from './github-app.ts';
import { resolveAssetPath, encodeAssetPath, collectAssetPaths } from './share-assets.ts';
import { createRepoKeyStore } from './repo-key-store.ts';
import { handleErrors, HttpError, requireSession } from './common.ts';

export { gitShareEndpoints };

// --- Validation helpers ---

// Share ID minimum length is 4 to allow readable names, but SHORT IDs ARE INSECURE
// for any share on a private repo.
//
// IMPORTANT: Tier 2 encryption does NOT make short share IDs safe. The share ID is still
// a plaintext filename inside .shares/ in the repo. If owner/repo are known or guessable,
// Tier 1 is always available and a brute-forced share ID leaks both repo existence AND content.
// GitHub deliberately doesn't reveal whether a private repo exists — we must uphold that.
//
// Rule: share IDs MUST be cryptographically random on private repos, regardless of tier.
// Use crypto.randomBytes(16).toString('base64url') = 22 chars, 128 bits of entropy.
// Short human-readable IDs are only safe on public repos (where content is already public).
//
// DO NOT raise the minimum here to enforce this — short IDs are structurally valid
// (e.g. legacy or public repos). Enforce random defaults in the UI/CLI layer.
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

function isValidShareId(shareId: string): boolean {
  return SHARE_ID_PATTERN.test(shareId);
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

async function fetchShareJson(owner: string, repo: string, shareId: string, ref?: string): Promise<{ path: string; ref?: string }> {
  const GENERIC = 'share not found';
  const ghRes = await fetchRepoFile(owner, repo, `.shares/${shareId}.json`, 'application/vnd.github.raw', ref);
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

function decryptBlob(keyHex: string, blobBase64url: string): { owner: string; repo: string; shareId: string } {
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

  let parsed: { owner?: string; repo?: string; shareId?: string };
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw HttpError(400, 'invalid decrypted payload');
  }
  if (
    !parsed ||
    typeof parsed.owner !== 'string' ||
    typeof parsed.repo !== 'string' ||
    typeof parsed.shareId !== 'string'
  ) {
    throw HttpError(400, 'invalid decrypted payload');
  }
  return { owner: parsed.owner, repo: parsed.repo, shareId: parsed.shareId };
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

function getOpenShareParams(req: express.Request): { owner: string; repo: string; shareId: string } {
  const params = req.params as Record<string, string | undefined>;
  const owner = (params.owner ?? '').trim();
  const repo = (params.repo ?? '').trim();
  const shareId = (params.shareId ?? '').trim();
  if (!isValidOwnerRepo(owner, repo)) throw HttpError(400, 'invalid owner/repo');
  if (!isValidShareId(shareId)) throw HttpError(400, 'invalid share id');
  return { owner, repo, shareId };
}

function openCacheKey(owner: string, repo: string, shareId: string): string {
  return `git:${owner}/${repo}/${shareId}`;
}

// --- Tier 2 (encrypted) param extraction ---

function getEncShareParams(req: express.Request): { owner: string; repo: string; shareId: string } {
  const GENERIC = 'share not found';
  const params = req.params as Record<string, string | undefined>;
  const repoId = (params.repoId ?? '').trim();
  const blob = (params.blob ?? '').trim();
  if (!repoId || !blob) throw HttpError(404, GENERIC);

  const keyRecord = repoKeyStore.get(repoId);
  if (!keyRecord) {
    // Dummy decryption to avoid timing side-channel revealing valid repoIds
    try { decryptBlob('0'.repeat(64), blob); } catch {}
    throw HttpError(404, GENERIC);
  }

  let decrypted: { owner: string; repo: string; shareId: string };
  try {
    decrypted = decryptBlob(keyRecord.key, blob);
  } catch {
    throw HttpError(404, GENERIC);
  }

  const { owner, repo, shareId } = decrypted;
  if (!isValidOwnerRepo(owner, repo) || !isValidShareId(shareId)) {
    throw HttpError(404, GENERIC);
  }
  if (keyRecord.owner !== owner || keyRecord.repo !== repo) {
    throw HttpError(404, GENERIC);
  }

  return { owner, repo, shareId };
}

function encCacheKey(repoId: string, blob: string): string {
  return `enc:${repoId}/${blob}`;
}

// --- Endpoints ---

function gitShareEndpoints(app: express.Express) {
  // ==========================================
  // Tier 2 — Encrypted share resolution
  // (must be registered before Tier 1 so that
  //  /enc/:repoId/:blob doesn't match :owner/:repo/:shareId)
  // ==========================================

  app.get(
    '/v1/git-shares/enc/:repoId/:blob/content',
    handleErrors(async (req, res) => {
      const params = req.params as Record<string, string | undefined>;
      const repoId = (params.repoId ?? '').trim();
      const blob = (params.blob ?? '').trim();
      const { owner, repo, shareId } = getEncShareParams(req);
      const { path: notePath, ref } = await fetchShareJson(owner, repo, shareId);
      await serveContent(res, owner, repo, notePath, encCacheKey(repoId, blob), ref);
    })
  );

  app.get(
    '/v1/git-shares/enc/:repoId/:blob',
    handleErrors(async (req, res) => {
      const { owner, repo, shareId } = getEncShareParams(req);
      await fetchShareJson(owner, repo, shareId); // validate share exists
      res.json({ ok: true });
    })
  );

  app.get(
    '/v1/git-shares/enc/:repoId/:blob/assets',
    handleErrors(async (req, res) => {
      const params = req.params as Record<string, string | undefined>;
      const repoId = (params.repoId ?? '').trim();
      const blob = (params.blob ?? '').trim();
      const { owner, repo, shareId } = getEncShareParams(req);
      const { path: notePath, ref } = await fetchShareJson(owner, repo, shareId);
      await serveAsset(req, res, owner, repo, notePath, encCacheKey(repoId, blob), ref);
    })
  );

  // ==========================================
  // Tier 1 — Open share resolution
  // ==========================================

  app.get(
    '/v1/git-shares/:owner/:repo/:shareId/content',
    handleErrors(async (req, res) => {
      const { owner, repo, shareId } = getOpenShareParams(req);
      const { path: notePath, ref } = await fetchShareJson(owner, repo, shareId);
      await serveContent(res, owner, repo, notePath, openCacheKey(owner, repo, shareId), ref);
    })
  );

  app.get(
    '/v1/git-shares/:owner/:repo/:shareId',
    handleErrors(async (req, res) => {
      const { owner, repo, shareId } = getOpenShareParams(req);
      await fetchShareJson(owner, repo, shareId); // validate share exists
      res.json({ owner, repo, shareId });
    })
  );

  app.get(
    '/v1/git-shares/:owner/:repo/:shareId/assets',
    handleErrors(async (req, res) => {
      const { owner, repo, shareId } = getOpenShareParams(req);
      const { path: notePath, ref } = await fetchShareJson(owner, repo, shareId);
      await serveAsset(req, res, owner, repo, notePath, openCacheKey(owner, repo, shareId), ref);
    })
  );

  // ==========================================
  // Tier 2 — Repo ID registration
  // ==========================================

  app.post(
    '/v1/repo-keys',
    requireSession,
    handleErrors(async (req, res) => {
      const session = req.sessionUser!;
      const body = req.body as Record<string, unknown>;
      const repoId = asTrimmedString(body.repoId);
      const key = asTrimmedString(body.key);
      const owner = asTrimmedString(body.owner);
      const repo = asTrimmedString(body.repo);

      if (!repoId || !key || !owner || !repo) throw HttpError(400, 'missing required fields: repoId, key, owner, repo');
      if (!isValidOwnerRepo(owner, repo)) throw HttpError(400, 'invalid owner/repo');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(repoId)) throw HttpError(400, 'invalid repo id');
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

      // Fetch .shares/.key from repo and verify matching repoId
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

      let keyFileContent: { repoId?: string; key?: string };
      try {
        keyFileContent = JSON.parse(await keyFileRes.text());
      } catch {
        throw HttpError(404, REPO_ACCESS_DENIED);
      }
      if (!keyFileContent || keyFileContent.repoId !== repoId || keyFileContent.key !== key) {
        throw HttpError(404, REPO_ACCESS_DENIED);
      }

      // Reject if repoId already registered for a different repo (prevent DoS via collision)
      const existing = repoKeyStore.get(repoId);
      if (existing && (existing.owner !== owner || existing.repo !== repo)) {
        throw HttpError(404, REPO_ACCESS_DENIED);
      }

      await repoKeyStore.set({
        repoId,
        key,
        owner,
        repo,
        registeredAt: new Date().toISOString(),
        registeredBy: session.login,
      });

      console.log(`[vibenote] repo id registered for ${owner}/${repo} by ${session.login}`);
      res.status(201).json({ ok: true });
    })
  );

}
