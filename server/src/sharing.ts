import crypto from 'node:crypto';
import type express from 'express';
import { type Env, env } from './env.ts';
import { refreshAccessToken, type SessionClaims } from './api.ts';
import { type SessionStoreInstance } from './session-store.ts';
import { createShareStore, type ShareRecord } from './share-store.ts';
import { getRepoInstallationId, installationRequest } from './github-app.ts';
import { resolveAssetPath, encodeAssetPath, collectAssetPaths } from './share-assets.ts';
import { handleErrors, HttpError, requireSession } from './common.ts';

export { sharingEndpoints };

const shareAssetCache = new Map<string, { paths: Set<string>; cachedAt: number }>();
const SHARE_ASSET_CACHE_TTL_MS = 5 * 60 * 1000;

const shareStore = createShareStore({
  filePath: env.SHARE_STORE_FILE,
});
await shareStore.init();

function sharingEndpoints(app: express.Express, sessionStore: SessionStoreInstance) {
  app.post(
    '/v1/shares',
    requireSession,
    handleErrors(async (req, res) => {
      const session = req.sessionUser!;
      let { accessToken } = await refreshAccessToken(env, sessionStore, session.sessionId);
      let { owner, repo, path, branch } = parseShareBody(req.body);

      // verify user has read access to the repo, otherwise they are not allowed to create a share.
      // they could guess a repo/owner/path and get access to private notes otherwise!
      // note that we even make this request if owner/repo/path is invalid, to avoid leaking info about existing paths to a timing attack.
      const repoRes = await fetchRepo(env, sessionStore, session.sessionId, owner, repo);
      if (!owner || !repo || !path || !branch || repoRes.status === 404)
        throw HttpError(404, 'note not found. either no access or invalid owner/repo/path/branch');
      if (!repoRes.ok) {
        const text = await repoRes.text();
        throw HttpError(502, `github error ${repoRes.status}: ${text}`);
      }
      const repoJson = (await repoRes.json()) as any;
      const permissions =
        repoJson && typeof repoJson.permissions === 'object' ? repoJson.permissions : undefined;
      if (!permissions || permissions.push !== true)
        throw HttpError(403, 'insufficient permissions to share note');

      const noteExists = await verifyNoteExistsWithUserToken({ owner, repo, path, branch, accessToken });
      if (!noteExists)
        throw HttpError(404, 'note not found. either no access or invalid owner/repo/path/branch');

      // once access is verified, we either bail if a share already exists, or create a new one
      const existing = shareStore.findActiveByNote(owner, repo, path);
      if (existing) return res.status(200).json(shareResponse(existing, env));

      const installationId = await getRepoInstallationId(env, owner, repo);
      const id = generateShareId();
      const record = await shareStore.create({
        id,
        owner,
        repo,
        branch,
        path,
        createdByLogin: session.login,
        createdByUserId: session.sub,
        installationId,
      });
      console.log(`[vibenote] share created ${owner}/${repo}`);
      res.status(201).json(shareResponse(record, env));
    })
  );

  app.get(
    '/v1/shares',
    requireSession,
    handleErrors(async (req, res) => {
      const session = req.sessionUser!;
      let { owner, repo, path } = parseShareBody(req.query);

      // verify user has read access to the repo, otherwise they are not allowed to see share links.
      // they could guess a repo/owner/path and get access to private notes otherwise!
      // note that we even make this request if owner/repo/path is invalid, to avoid leaking info about existing paths to a timing attack.
      let result = await fetchRepo(env, sessionStore, session.sessionId, owner, repo);
      if (!owner || !repo || !path || result.status === 404)
        throw HttpError(404, 'note not found. either no access or invalid owner/repo/path/branch');
      if (!result.ok) {
        const text = await result.text();
        throw HttpError(502, `github error ${result.status}: ${text}`);
      }

      // once access is verified, we either return existing share, or null
      const existing = shareStore.findActiveByNote(owner, repo, path);
      res.json({ share: existing ? shareResponse(existing, env) : null });
    })
  );

  app.delete(
    '/v1/shares/:id',
    requireSession,
    handleErrors(async (req, res) => {
      const record = getShareRecord(req);
      const session = req.sessionUser!;
      const canRevoke = await canUserRevokeShare(env, sessionStore, session, record);
      if (!canRevoke) throw HttpError(403, 'insufficient permissions to revoke share');

      const removed = await shareStore.revoke(record.id);
      if (!removed) throw HttpError(404, 'share not found');

      console.log(`[vibenote] share revoked ${record.owner}/${record.repo}`);
      shareAssetCache.delete(record.id);
      res.status(204).end();
    })
  );

  app.get(
    '/v1/share-links/:id',
    handleErrors(async (req, res) => {
      const record = getShareRecord(req);
      res.json({ id: record.id, createdBy: { login: record.createdByLogin } });
    })
  );

  app.get(
    '/v1/share-links/:id/content',
    handleErrors(async (req, res) => {
      const record = getShareRecord(req);
      const ghRes = await fetchShareContent(env, record, record.path);
      const text = await ghRes.text();
      cacheShareAssets(record.id, record.path, text);
      res
        .status(200)
        .setHeader('Content-Type', 'text/markdown; charset=utf-8')
        .setHeader('Cache-Control', 'no-store')
        .send(text);
    })
  );

  app.get(
    '/v1/share-links/:id/assets',
    handleErrors(async (req, res) => {
      const record = getShareRecord(req);
      const rawPathParam = decodeURIComponent(asTrimmedString(req.query.path));
      const pathCandidate = resolveAssetPath(record.path, rawPathParam);
      if (!pathCandidate) throw Error('invalid asset path');
      let allowedPaths = await ensureShareAssetsLoaded(record, env);
      if (!allowedPaths.has(pathCandidate)) throw HttpError(404, 'asset not found');
      const ghRes = await fetchShareContent(env, record, pathCandidate);
      const buffer = Buffer.from(await ghRes.arrayBuffer());
      const contentType = ghRes.headers.get('Content-Type') ?? 'application/octet-stream';
      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=300',
        Vary: 'Accept-Encoding',
      };
      const etag = ghRes.headers.get('ETag');
      if (etag) headers.ETag = etag;
      const lastModified = ghRes.headers.get('Last-Modified');
      if (lastModified) headers['Last-Modified'] = lastModified;
      res.status(200).set(headers).send(buffer);
    })
  );
}

function shareResponse(record: ShareRecord, env: Env) {
  return {
    id: record.id,
    owner: record.owner,
    repo: record.repo,
    path: record.path,
    branch: record.branch,
    createdAt: record.createdAt,
    createdBy: {
      login: record.createdByLogin,
      userId: record.createdByUserId,
    },
    url: buildShareUrl(env.PUBLIC_VIEWER_BASE_URL, record.id),
  };
}

function buildShareUrl(base: string, id: string): string {
  const normalized = base.replace(/\/+$/, '');
  return `${normalized}/s/${id}`;
}

async function verifyNoteExistsWithUserToken(options: {
  owner: string;
  repo: string;
  path: string;
  branch: string;
  accessToken: string;
}): Promise<boolean> {
  const { owner, repo, path, branch, accessToken } = options;
  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo
    )}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
      },
    }
  );
  if (res.status === 404) return false;
  if (!res.ok) {
    const text = await res.text();
    throw Error(`github note lookup failed (${res.status}): ${text}`);
  }
  return true;
}

async function fetchRepo(
  env: Env,
  store: SessionStoreInstance,
  sessionId: string,
  owner: string,
  repo: string
) {
  const tokens = await refreshAccessToken(env, store, sessionId);
  return fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      Accept: 'application/vnd.github+json',
    },
  });
}

async function canUserRevokeShare(
  env: Env,
  store: SessionStoreInstance,
  session: SessionClaims,
  record: ShareRecord
): Promise<boolean> {
  if (session.sub === record.createdByUserId) return true;
  try {
    let res = await fetchRepo(env, store, session.sessionId, record.owner, record.repo);
    if (!res.ok) return false;
    let json = (await res.json()) as any;
    let permissions = json && typeof json.permissions === 'object' ? json.permissions : undefined;
    if (permissions?.push === true) return true;
  } catch {}
  return false;
}

function asTrimmedString(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.trim();
}

function asRecord(obj: unknown): Record<string, unknown> {
  return typeof obj !== 'object' || obj === null ? {} : (obj as Record<string, unknown>);
}

function parseShareBody(inputBody: unknown) {
  let body = asRecord(inputBody);
  let owner = asTrimmedString(body.owner);
  let repo = asTrimmedString(body.repo);
  let branch = asTrimmedString(body.branch) || 'main';

  // we only allow sharing .md files, and validate/sanitize the path
  let path = asTrimmedString(body.path);
  if (!path.toLowerCase().endsWith('.md')) {
    path = '';
  } else {
    path = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (path.includes('..')) path = '';
  }
  return { owner, repo, path, branch };
}

function getShareRecord(req: express.Request) {
  let id = getPathParam(req, 'id');
  if (!id || !isValidShareId(id)) throw HttpError(404, 'share not found');
  const record = shareStore.get(id);
  if (!record || record.id !== id) throw HttpError(404, 'share not found');
  return record;
}

function generateShareId(): string {
  return crypto.randomBytes(18).toString('base64url');
}

function isValidShareId(id: string): boolean {
  return /^[A-Za-z0-9_-]{10,}$/.test(id);
}

function getPathParam(req: express.Request, key: string): string | undefined {
  const params = req.params as Record<string, string | undefined>;
  const value = params[key];
  return typeof value === 'string' ? value : undefined;
}

async function fetchShareContent(env: Env, record: ShareRecord, path: string) {
  const ghRes = await installationRequest(
    env,
    record.installationId,
    `/repos/${encodeURIComponent(record.owner)}/${encodeURIComponent(record.repo)}/contents/${encodeAssetPath(
      path
    )}?ref=${encodeURIComponent(record.branch)}`,
    { headers: { Accept: 'application/vnd.github.raw' } }
  );
  if (ghRes.status === 404) throw HttpError(404, 'content not found');
  if (!ghRes.ok) {
    const text = await ghRes.text();
    throw HttpError(502, `github error ${ghRes.status}: ${text}`);
  }
  return ghRes;
}

function cacheShareAssets(shareId: string, notePath: string, markdown: string): Set<string> {
  const paths = collectAssetPaths(notePath, markdown);
  shareAssetCache.set(shareId, { paths, cachedAt: Date.now() });
  return paths;
}

async function ensureShareAssetsLoaded(record: ShareRecord, env: Env): Promise<Set<string>> {
  const cached = shareAssetCache.get(record.id);
  if (cached && Date.now() - cached.cachedAt <= SHARE_ASSET_CACHE_TTL_MS) {
    return cached.paths;
  }
  const ghRes = await fetchShareContent(env, record, record.path);
  const markdown = await ghRes.text();
  return cacheShareAssets(record.id, record.path, markdown);
}
