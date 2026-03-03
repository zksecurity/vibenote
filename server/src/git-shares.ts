import type express from 'express';
import { env } from './env.ts';
import { getRepoInstallationId, installationRequest } from './github-app.ts';
import { resolveAssetPath, encodeAssetPath, collectAssetPaths } from './share-assets.ts';
import { createRepoIdStore } from './repo-id-store.ts';
import { handleErrors, HttpError, requireSession } from './common.ts';

export { gitShareEndpoints };

// --- Validation helpers ---

// Share ID minimum length is 4 to allow readable names, but SHORT IDs ARE INSECURE
// for any share on a private repo.
//
// Rule: share IDs MUST be cryptographically random on private repos, regardless of tier.
// Use crypto.randomBytes(16).toString('base64url') = 22 chars, 128 bits of entropy.
// Short human-readable IDs are only safe on public repos (where content is already public).
//
// DO NOT raise the minimum here to enforce this — short IDs are structurally valid
// (e.g. public repos or notes intended to become fully public). Enforce random defaults in the UI/CLI layer.
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

function isValidShareId(shareId: string): boolean {
  return SHARE_ID_PATTERN.test(shareId);
}

function isValidOwnerRepo(owner: string, repo: string): boolean {
  const seg = /^[A-Za-z0-9._-]{1,100}$/;
  return seg.test(owner) && seg.test(repo);
}

// repoId is always the base64url encoding of exactly 8 random bytes (11 chars).
const REPO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function isValidRepoId(repoId: string): boolean {
  return REPO_ID_PATTERN.test(repoId);
}

// --- Asset cache (same pattern as sharing.ts) ---

// notePath and ref are stored alongside paths so we can detect when the share
// descriptor has changed (e.g. .shares/<id>.json pointing to a new file) and
// avoid serving stale allowlists.
type AssetCacheEntry = { paths: Set<string>; cachedAt: number; notePath: string; ref: string | undefined };
const assetCache = new Map<string, AssetCacheEntry>();
const ASSET_CACHE_TTL_MS = 5 * 60 * 1000;

// --- Repo ID store ---

const repoIdStore = createRepoIdStore({ filePath: env.REPO_ID_STORE_FILE });
await repoIdStore.init();

// --- GitHub helpers ---

async function fetchRepoFile(
  owner: string,
  repo: string,
  filePath: string,
  accept: string,
  ref?: string
): Promise<Response> {
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

async function fetchShareJson(
  owner: string,
  repo: string,
  shareId: string,
  ref?: string
): Promise<{ path: string; ref?: string }> {
  const GENERIC = 'share not found';
  const ghRes = await fetchRepoFile(
    owner,
    repo,
    `.shares/${shareId}.json`,
    'application/vnd.github.raw',
    ref
  );
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

// --- Opaque segment helpers (Tier 2) ---

// A Tier 2 URL segment is base64url(repoId_bytes[8] || shareId_bytes[16]) = exactly 32 chars.
// The repoId (8 bytes) maps to owner/repo server-side; the shareId (16 bytes) is the
// .shares/<shareId>.json filename. Neither is visible in the URL.
const OPAQUE_SEGMENT_BYTE_LENGTH = 24; // 8 (repoId) + 16 (shareId)
const REPO_ID_BYTE_LENGTH = 8;
// Exactly 32 base64url characters (no padding, no standard base64 +/ chars).
const OPAQUE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{32}$/;

function decodeOpaqueSegment(segment: string): { repoId: string; shareId: string } | null {
  if (!OPAQUE_SEGMENT_PATTERN.test(segment)) return null;
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.length !== OPAQUE_SEGMENT_BYTE_LENGTH) return null;
  // Canonical roundtrip: reject non-canonical encodings (e.g. stray padding or non-url chars)
  if (decoded.toString('base64url') !== segment) return null;
  const repoId = decoded.subarray(0, REPO_ID_BYTE_LENGTH).toString('base64url');
  const shareId = decoded.subarray(REPO_ID_BYTE_LENGTH).toString('base64url');
  return { repoId, shareId };
}

// --- Shared response helpers ---

function cacheAssets(cacheKey: string, notePath: string, ref: string | undefined, markdown: string): Set<string> {
  const paths = collectAssetPaths(notePath, markdown);
  assetCache.set(cacheKey, { paths, cachedAt: Date.now(), notePath, ref });
  return paths;
}

async function ensureAssetsLoaded(
  cacheKey: string,
  owner: string,
  repo: string,
  notePath: string,
  ref?: string
): Promise<Set<string>> {
  const cached = assetCache.get(cacheKey);
  // Bypass cache if the share descriptor changed (different notePath or ref)
  if (cached && Date.now() - cached.cachedAt <= ASSET_CACHE_TTL_MS && cached.notePath === notePath && cached.ref === ref) {
    return cached.paths;
  }
  const ghRes = await fetchRepoFile(owner, repo, notePath, 'application/vnd.github.raw', ref);
  const markdown = await ghRes.text();
  return cacheAssets(cacheKey, notePath, ref, markdown);
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
  cacheAssets(cacheKey, notePath, ref, text);
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

// --- Tier 2 param extraction ---

function getOpaqueShareParams(req: express.Request): { owner: string; repo: string; shareId: string } {
  const GENERIC = 'share not found';
  const params = req.params as Record<string, string | undefined>;
  const segment = (params.segment ?? '').trim();

  const decoded = decodeOpaqueSegment(segment);
  if (!decoded) throw HttpError(404, GENERIC);

  const { repoId, shareId } = decoded;
  const record = repoIdStore.get(repoId);
  if (!record) throw HttpError(404, GENERIC);

  return { owner: record.owner, repo: record.repo, shareId };
}

function opaqueCacheKey(segment: string): string {
  return `opaque:${segment}`;
}

// --- Endpoints ---

function gitShareEndpoints(app: express.Express) {
  // ==========================================
  // Tier 2 — Opaque share resolution
  // Single base64url segment encodes repoId (8 bytes) + shareId (16 bytes).
  // ==========================================

  app.get(
    '/v1/git-shares/:segment/content',
    handleErrors(async (req, res) => {
      const params = req.params as Record<string, string | undefined>;
      const segment = (params.segment ?? '').trim();
      const { owner, repo, shareId } = getOpaqueShareParams(req);
      const { path: notePath, ref } = await fetchShareJson(owner, repo, shareId);
      await serveContent(res, owner, repo, notePath, opaqueCacheKey(segment), ref);
    })
  );

  app.get(
    '/v1/git-shares/:segment',
    handleErrors(async (req, res) => {
      const { owner, repo, shareId } = getOpaqueShareParams(req);
      await fetchShareJson(owner, repo, shareId); // validate share exists
      res.json({ ok: true });
    })
  );

  app.get(
    '/v1/git-shares/:segment/assets',
    handleErrors(async (req, res) => {
      const params = req.params as Record<string, string | undefined>;
      const segment = (params.segment ?? '').trim();
      const { owner, repo, shareId } = getOpaqueShareParams(req);
      const { path: notePath, ref } = await fetchShareJson(owner, repo, shareId);
      await serveAsset(req, res, owner, repo, notePath, opaqueCacheKey(segment), ref);
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
    '/v1/repo-id',
    requireSession,
    handleErrors(async (req, res) => {
      const session = req.sessionUser!;
      const body = req.body as Record<string, unknown>;
      const repoId = asTrimmedString(body.repoId);
      const owner = asTrimmedString(body.owner);
      const repo = asTrimmedString(body.repo);

      if (!repoId || !owner || !repo) throw HttpError(400, 'missing required fields: repoId, owner, repo');
      if (!isValidOwnerRepo(owner, repo)) throw HttpError(400, 'invalid owner/repo');
      if (!isValidRepoId(repoId)) throw HttpError(400, 'invalid repo id');

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

      // Fetch .shares/.repo-id from repo and verify the repoId matches
      const repoIdFileRes = await installationRequest(
        env,
        installationId,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeAssetPath(
          '.shares/.repo-id'
        )}`,
        { headers: { Accept: 'application/vnd.github.raw' } }
      );
      if (repoIdFileRes.status === 404) throw HttpError(404, REPO_ACCESS_DENIED);
      if (!repoIdFileRes.ok) throw HttpError(404, REPO_ACCESS_DENIED);

      // File contains just the raw repoId string, no JSON wrapper
      const storedRepoId = (await repoIdFileRes.text()).trim();
      if (storedRepoId !== repoId) {
        throw HttpError(404, REPO_ACCESS_DENIED);
      }

      // Reject if repoId already registered for a different repo (prevent collision DoS)
      const existing = repoIdStore.get(repoId);
      if (existing && (existing.owner !== owner || existing.repo !== repo)) {
        throw HttpError(404, REPO_ACCESS_DENIED);
      }

      // Enforce one repoId per repo — reject if this repo already has a different repoId
      const existingByRepo = repoIdStore.getByRepo(owner, repo);
      if (existingByRepo && existingByRepo.repoId !== repoId) {
        throw HttpError(404, REPO_ACCESS_DENIED);
      }

      await repoIdStore.set({
        repoId,
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
