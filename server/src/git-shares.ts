import type express from 'express';
import { env } from './env.ts';
import { getOwnerInstallationId, installationRequest } from './github-app.ts';
import { resolveAssetPath, encodeAssetPath, collectAssetPaths } from './share-assets.ts';
import { createRepoIdStore } from './repo-id-store.ts';
import { handleErrors } from './common.ts';
import { HttpError } from './http-error.ts';
import { readTextBounded, pipeBounded } from './bounded-body.ts';

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
  if (!REPO_ID_PATTERN.test(repoId)) return false;
  // Opaque segments decode to bytes and look up their canonical encoding. A noncanonical spelling
  // (the last character carries 2 unused bits) would register fine but never resolve.
  return Buffer.from(repoId, 'base64url').toString('base64url') === repoId;
}

// --- Asset cache (same pattern as sharing.ts) ---

// notePath is stored alongside paths so we can detect when the share descriptor
// changed (e.g. .shares/<id> now points to a different file) and avoid serving
// stale allowlists.
type AssetCacheEntry = { paths: Set<string>; cachedAt: number; notePath: string };
const assetCache = new Map<string, AssetCacheEntry>();
const ASSET_CACHE_TTL_MS = 5 * 60 * 1000;

// --- Upstream size limits ---
// A share descriptor holds just a note path.
const MAX_DESCRIPTOR_BYTES = 4 * 1024;
const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
// .shares/.repo-id holds an 11-character id plus optional whitespace.
const MAX_REPO_ID_FILE_BYTES = 64;
const MAX_REPO_METADATA_BYTES = 256 * 1024;

// --- Repo ID store ---

const repoIdStore = createRepoIdStore({ filePath: env.REPO_ID_STORE_FILE });
await repoIdStore.init();

// --- GitHub helpers ---

async function fetchRepoFile(
  owner: string,
  repo: string,
  filePath: string,
  accept: string
): Promise<Response> {
  let installationId: number;
  try {
    installationId = await getOwnerInstallationId(env, owner);
  } catch {
    throw HttpError(404, 'share not found');
  }
  const url = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeAssetPath(filePath)}`;
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

// Read GitHub's numeric id of the repository currently at owner/repo. Renames redirect to the same
// repository; a reused name resolves to a different id.
async function fetchGitHubRepoId(owner: string, repo: string): Promise<number> {
  let installationId: number;
  try {
    installationId = await getOwnerInstallationId(env, owner);
  } catch {
    throw HttpError(404, 'share not found');
  }
  const url = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const res = await installationRequest(env, installationId, url, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw HttpError(404, 'share not found');
  let json: unknown;
  try {
    json = JSON.parse(await readTextBounded(res, MAX_REPO_METADATA_BYTES));
  } catch {
    throw HttpError(404, 'share not found');
  }
  if (typeof json !== 'object' || json === null || !('id' in json) || typeof json.id !== 'number') {
    throw HttpError(404, 'share not found');
  }
  return json.id;
}

// Share descriptors are plain-text files whose entire content is the note path.
// Tier 1 descriptors live at .shares/<shareId>, Tier 2 descriptors at .shares/opaque/<shareId>.
// Share ids cannot contain `/`, so the Tier 1 route can never read a Tier 2 descriptor: a shareId
// decoded from an opaque link resolves exactly like a nonexistent share there, and does not let a
// link holder confirm a guessed repository name.
function openDescriptorPath(shareId: string): string {
  return `.shares/${shareId}`;
}

function opaqueDescriptorPath(shareId: string): string {
  return `.shares/opaque/${shareId}`;
}

// Fetch a share descriptor and return the note path it contains.
async function fetchSharePath(owner: string, repo: string, descriptorPath: string): Promise<string> {
  const GENERIC = 'share not found';
  const ghRes = await fetchRepoFile(owner, repo, descriptorPath, 'application/vnd.github.raw');
  const raw = (await readTextBounded(ghRes, MAX_DESCRIPTOR_BYTES)).trim();
  if (!raw || !raw.toLowerCase().endsWith('.md')) throw HttpError(404, GENERIC);
  let sanitized = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (sanitized.includes('..')) throw HttpError(404, GENERIC);
  return sanitized;
}

// --- Opaque segment helpers (Tier 2) ---

// A Tier 2 URL segment is base64url(repoId_bytes[8] || shareId_bytes[16]) = exactly 32 chars.
// The repoId (8 bytes) maps to owner/repo server-side; the shareId (16 bytes) names the
// .shares/opaque/<shareId> descriptor. The URL hides the repository, not the shareId: anyone can
// decode the segment, which is why Tier 2 descriptors live outside the Tier 1 namespace.
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

function cacheAssets(cacheKey: string, notePath: string, markdown: string): Set<string> {
  const paths = collectAssetPaths(notePath, markdown);
  assetCache.set(cacheKey, { paths, cachedAt: Date.now(), notePath });
  return paths;
}

async function ensureAssetsLoaded(
  cacheKey: string,
  owner: string,
  repo: string,
  notePath: string
): Promise<Set<string>> {
  const cached = assetCache.get(cacheKey);
  // Bypass cache if the share descriptor changed (different notePath)
  if (cached && Date.now() - cached.cachedAt <= ASSET_CACHE_TTL_MS && cached.notePath === notePath) {
    return cached.paths;
  }
  const ghRes = await fetchRepoFile(owner, repo, notePath, 'application/vnd.github.raw');
  const markdown = await readTextBounded(ghRes, MAX_NOTE_BYTES);
  return cacheAssets(cacheKey, notePath, markdown);
}

async function serveContent(
  res: express.Response,
  owner: string,
  repo: string,
  notePath: string,
  cacheKey: string
): Promise<void> {
  const ghRes = await fetchRepoFile(owner, repo, notePath, 'application/vnd.github.raw');
  const text = await readTextBounded(ghRes, MAX_NOTE_BYTES);
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
  cacheKey: string
): Promise<void> {
  const rawPathParam = decodeURIComponent(asTrimmedString(req.query.path));
  const pathCandidate = resolveAssetPath(notePath, rawPathParam);
  if (!pathCandidate) throw HttpError(400, 'invalid asset path');

  const allowedPaths = await ensureAssetsLoaded(cacheKey, owner, repo, notePath);
  if (!allowedPaths.has(pathCandidate)) throw HttpError(404, 'asset not found');

  const ghRes = await fetchRepoFile(owner, repo, pathCandidate, 'application/vnd.github.raw');
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
  // Stream instead of buffering, so memory use does not grow with asset size or concurrent viewers
  res.status(200).set(headers);
  await pipeBounded(ghRes, res, MAX_ASSET_BYTES);
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

async function getOpaqueShareParams(
  req: express.Request
): Promise<{ owner: string; repo: string; descriptorPath: string }> {
  const GENERIC = 'share not found';
  const params = req.params as Record<string, string | undefined>;
  const segment = (params.segment ?? '').trim();

  const decoded = decodeOpaqueSegment(segment);
  if (!decoded) throw HttpError(404, GENERIC);

  const { repoId, shareId } = decoded;
  const record = repoIdStore.get(repoId);
  if (!record) throw HttpError(404, GENERIC);
  // The stored name must still belong to the repository the repoId was registered for
  if ((await fetchGitHubRepoId(record.owner, record.repo)) !== record.githubRepoId) {
    throw HttpError(404, GENERIC);
  }

  return { owner: record.owner, repo: record.repo, descriptorPath: opaqueDescriptorPath(shareId) };
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
      const { owner, repo, descriptorPath } = await getOpaqueShareParams(req);
      const notePath = await fetchSharePath(owner, repo, descriptorPath);
      await serveContent(res, owner, repo, notePath, opaqueCacheKey(segment));
    })
  );

  app.get(
    '/v1/git-shares/:segment',
    handleErrors(async (req, res) => {
      const { owner, repo, descriptorPath } = await getOpaqueShareParams(req);
      await fetchSharePath(owner, repo, descriptorPath); // validate share exists
      // Return owner (repo owner name) but not repo or shareId — URL stays opaque.
      res.json({ owner });
    })
  );

  app.get(
    '/v1/git-shares/:segment/assets',
    handleErrors(async (req, res) => {
      const params = req.params as Record<string, string | undefined>;
      const segment = (params.segment ?? '').trim();
      const { owner, repo, descriptorPath } = await getOpaqueShareParams(req);
      const notePath = await fetchSharePath(owner, repo, descriptorPath);
      await serveAsset(req, res, owner, repo, notePath, opaqueCacheKey(segment));
    })
  );

  // ==========================================
  // Tier 1 — Open share resolution
  // ==========================================

  app.get(
    '/v1/git-shares/:owner/:repo/:shareId/content',
    handleErrors(async (req, res) => {
      const { owner, repo, shareId } = getOpenShareParams(req);
      const notePath = await fetchSharePath(owner, repo, openDescriptorPath(shareId));
      await serveContent(res, owner, repo, notePath, openCacheKey(owner, repo, shareId));
    })
  );

  app.get(
    '/v1/git-shares/:owner/:repo/:shareId',
    handleErrors(async (req, res) => {
      const { owner, repo, shareId } = getOpenShareParams(req);
      await fetchSharePath(owner, repo, openDescriptorPath(shareId)); // validate share exists
      res.json({ owner, repo, shareId });
    })
  );

  app.get(
    '/v1/git-shares/:owner/:repo/:shareId/assets',
    handleErrors(async (req, res) => {
      const { owner, repo, shareId } = getOpenShareParams(req);
      const notePath = await fetchSharePath(owner, repo, openDescriptorPath(shareId));
      await serveAsset(req, res, owner, repo, notePath, openCacheKey(owner, repo, shareId));
    })
  );

  // ==========================================
  // Tier 2 — Repo ID registration
  // ==========================================

  // No session auth required: proof of write access is the presence of .shares/.repo-id
  // in the repo with matching content, verified below via the GitHub App installation token.
  app.post(
    '/v1/repo-id',
    handleErrors(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const repoId = asTrimmedString(body.repoId);
      const owner = asTrimmedString(body.owner);
      const repo = asTrimmedString(body.repo);

      if (!repoId || !owner || !repo) throw HttpError(400, 'missing required fields: repoId, owner, repo');
      if (!isValidOwnerRepo(owner, repo)) throw HttpError(400, 'invalid owner/repo');
      if (!isValidRepoId(repoId)) throw HttpError(400, 'invalid repo id');

      const REPO_ACCESS_DENIED = 'repository not found or insufficient permissions';

      // A registered repoId gets the same answer for every request, without contacting GitHub.
      // Anyone holding an opaque link knows its repoId, so an answer that depended on owner/repo
      // would confirm a guessed repository name. Clients check where a new link resolves instead.
      if (repoIdStore.get(repoId) !== undefined) {
        res.status(200).json({ ok: true });
        return;
      }

      // Resolve the GitHub App installation for this repo.
      let installationId: number;
      try {
        installationId = await getOwnerInstallationId(env, owner);
      } catch {
        throw HttpError(404, REPO_ACCESS_DENIED);
      }

      // Fetch .shares/.repo-id and verify its contents match the submitted repoId.
      // This is the sole access proof: only someone with write access to the repo
      // could have committed this file.
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
      let repoIdFileText: string;
      try {
        repoIdFileText = await readTextBounded(repoIdFileRes, MAX_REPO_ID_FILE_BYTES);
      } catch {
        throw HttpError(404, REPO_ACCESS_DENIED);
      }
      const storedRepoId = repoIdFileText.trim();
      if (storedRepoId !== repoId) {
        throw HttpError(404, REPO_ACCESS_DENIED);
      }

      let githubRepoId: number;
      try {
        githubRepoId = await fetchGitHubRepoId(owner, repo);
      } catch {
        throw HttpError(404, REPO_ACCESS_DENIED);
      }

      // Enforce one repoId per repo — reject if this repo already has a different repoId.
      // A binding of the same name to an older repository does not count: that name was reused.
      const existingByRepo = repoIdStore.getByRepo(owner, repo);
      if (
        existingByRepo &&
        existingByRepo.repoId !== repoId &&
        existingByRepo.githubRepoId === githubRepoId
      ) {
        throw HttpError(404, REPO_ACCESS_DENIED);
      }

      await repoIdStore.set({
        repoId,
        owner,
        repo,
        githubRepoId,
        registeredAt: new Date().toISOString(),
      });

      console.log(`[vibenote] repo id registered for ${owner}/${repo}`);
      res.status(201).json({ ok: true });
    })
  );
}
