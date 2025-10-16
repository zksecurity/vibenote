import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { getEnv, type Env } from './env.ts';
import {
  createAuthStartRedirect,
  handleAuthCallback,
  buildInstallUrl,
  buildSetupRedirect,
  refreshAccessToken,
  logoutSession,
  verifyBearerSession,
  type SessionClaims,
} from './api.ts';
import { createSessionStore, type SessionStoreInstance } from './session-store.ts';
import { createShareStore, type ShareRecord } from './share-store.ts';
import { getRepoInstallationId, installationRequest } from './github-app.ts';
import { resolveAssetPath, encodeAssetPath, collectAssetPaths } from './share-assets.ts';

declare module 'express-serve-static-core' {
  interface Request {
    sessionUser?: SessionClaims;
  }
}

const env = getEnv();
const sessionStore = createSessionStore({
  filePath: env.SESSION_STORE_FILE,
  encryptionKey: env.SESSION_ENCRYPTION_KEY,
});
await sessionStore.init();
const shareStore = createShareStore({
  filePath: env.SHARE_STORE_FILE,
});
await shareStore.init();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (env.ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error('CORS not allowed'));
    },
    credentials: true,
  })
);

app.get('/v1/healthz', (_req, res) => res.json({ ok: true }));

const shareAssetCache = new Map<string, { paths: Set<string>; cachedAt: number }>();
const SHARE_ASSET_CACHE_TTL_MS = 5 * 60 * 1000;

app.get('/v1/auth/github/start', async (req, res) => {
  let returnTo = String(req.query.returnTo ?? '');
  let sanitizedReturnTo = normalizeReturnTo(returnTo, env.ALLOWED_ORIGINS);
  if (sanitizedReturnTo === null) {
    return res.status(400).json({ error: 'invalid returnTo origin' });
  }
  let redirect = await createAuthStartRedirect(env, sanitizedReturnTo, callbackURL(req));
  res.redirect(redirect);
});

app.get(
  '/v1/auth/github/callback',
  handleErrors(async (req, res) => {
    let code = String(req.query.code ?? '');
    let stateToken = String(req.query.state ?? '');
    let { html } = await handleAuthCallback(
      env,
      sessionStore,
      code,
      stateToken,
      callbackURL(req),
      requestOrigin(req)
    );
    res.status(200).type('html').send(html);
  })
);

app.post(
  '/v1/auth/github/refresh',
  requireSession,
  handleErrors(async (req, res) => {
    let claims = req.sessionUser;
    if (!claims) throw HttpError(401, 'missing session');
    let tokens = await refreshAccessToken(env, sessionStore, claims.sessionId);
    res.json({ accessToken: tokens.accessToken, accessTokenExpiresAt: tokens.accessTokenExpiresAt });
  })
);

app.post(
  '/v1/auth/github/logout',
  requireSession,
  handleErrors(async (req, res) => {
    let claims = req.sessionUser;
    if (!claims) throw HttpError(401, 'missing session');
    await logoutSession(sessionStore, claims.sessionId);
    res.status(204).end();
  })
);

app.get(
  '/v1/app/install-url',
  handleErrors(async (req, res) => {
    let owner = String(req.query.owner ?? '');
    let repo = String(req.query.repo ?? '');
    let returnTo = String(req.query.returnTo ?? '');
    let sanitizedReturnTo = normalizeReturnTo(returnTo, env.ALLOWED_ORIGINS);
    if (sanitizedReturnTo === null && returnTo.trim().length > 0) throw Error('invalid returnTo origin');
    let url = await buildInstallUrl(env, owner, repo, sanitizedReturnTo ?? '');
    res.json({ url });
  })
);

app.get(
  '/v1/app/setup',
  handleErrors(async (req, res) => {
    let installationId = req.query.installation_id ? String(req.query.installation_id) : null;
    let setupAction = req.query.setup_action ? String(req.query.setup_action) : null;
    let stateToken = String(req.query.state ?? '');
    let returnTo = String(req.query.returnTo ?? '');
    let sanitizedReturnTo = normalizeReturnTo(returnTo, env.ALLOWED_ORIGINS);
    if (sanitizedReturnTo === null && returnTo.trim().length > 0) throw Error('invalid returnTo origin');
    let target = await buildSetupRedirect(
      env,
      stateToken,
      sanitizedReturnTo ?? '',
      setupAction,
      installationId,
      requestOrigin(req)
    );
    res.redirect(target);
  })
);

app.post('/v1/webhooks/github', (_req, res) => {
  res.status(204).end();
});

app.post(
  '/v1/shares',
  requireSession,
  handleErrors(async (req, res) => {
    const session = req.sessionUser!;
    const repoAccessToken = await refreshAccessToken(env, sessionStore, session.sessionId);
    let { owner, repo, path, branch } = parseShareBody(req.body);

    // verify user has read access to the repo, otherwise they are not allowed to create a share.
    // they could guess a repo/owner/path and get access to private notes otherwise!
    // note that we even make this request if owner/repo/path is invalid, to avoid leaking info about existing paths to a timing attack.
    const noteExists = await verifyNoteExistsWithUserToken({
      owner,
      repo,
      path,
      branch,
      accessToken: repoAccessToken.accessToken,
    });
    if (!owner || !repo || !path || !branch || !noteExists)
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
    let { owner, repo, path } = parseShareBody(req.query);
    if (!owner || !repo || !path) throw Error('missing or invalid owner/repo/path');

    const session = req.sessionUser!;
    // ensure the repo is readable by the user
    let result = await fetchRepo(env, sessionStore, session.sessionId, owner, repo);
    if (result.status === 404) throw HttpError(404, 'repository not found or not accessible');
    if (!result.ok) {
      const text = await result.text();
      throw HttpError(502, `github repo permissions check failed (${result.status}): ${text}`);
    }
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
    const text = await fetchShareMarkdown(record, env);
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
    const encodedAssetPath = encodeAssetPath(pathCandidate);
    const ghRes = await installationRequest(
      env,
      record.installationId,
      `/repos/${encodeURIComponent(record.owner)}/${encodeURIComponent(
        record.repo
      )}/contents/${encodedAssetPath}?ref=${encodeURIComponent(record.branch)}`,
      {
        headers: { Accept: 'application/vnd.github.raw' },
      }
    );
    if (ghRes.status === 404) throw HttpError(404, 'asset not found');
    if (!ghRes.ok) {
      const text = await ghRes.text();
      throw HttpError(502, `github error ${ghRes.status}: ${text}`);
    }
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

const server = app.listen(env.PORT, () => {
  console.log(`[vibenote] api listening on :${env.PORT}`);
});

for (let sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[vibenote] received ${sig}, shutting down...`);
    server.close(() => {
      console.log('[vibenote] shutdown complete');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('[vibenote] force exit after timeout');
      process.exit(1);
    }, 8000).unref();
  });
}

setInterval(() => {
  try {
    sessionStore.pruneExpired();
  } catch (error) {
    console.error('[vibenote] session prune failed', error);
  }
}, 60 * 60 * 1000).unref();

function callbackURL(req: express.Request): string {
  return `${getProtocol(req)}://${getHost(req)}/v1/auth/github/callback`;
}

function requestOrigin(req: express.Request): string {
  return `${getProtocol(req)}://${getHost(req)}`;
}

function getProtocol(req: express.Request): string {
  return req.header('x-forwarded-proto') ?? req.protocol ?? 'https';
}

function getHost(req: express.Request): string {
  return req.header('x-forwarded-host') ?? req.get('host') ?? 'localhost';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
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

function normalizeReturnTo(value: string, allowedOrigins: string[]): string | null {
  // Ensure callbacks only ever return control to trusted frontend origins.
  let trimmed = value.trim();
  if (trimmed.length === 0) {
    return '';
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  let protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    return null;
  }
  if (!allowedOrigins.includes(parsed.origin)) {
    return null;
  }
  return parsed.toString();
}

function requireSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  let header = req.header('authorization') || req.header('Authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    return res.status(401).json({ error: 'missing auth' });
  }
  let token = header.slice(7).trim();
  verifyBearerSession(token, env)
    .then((claims) => {
      req.sessionUser = claims;
      next();
    })
    .catch(() => res.status(401).json({ error: 'invalid session' }));
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
    throw new Error(`github note lookup failed (${res.status}): ${text}`);
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

async function fetchShareMarkdown(record: ShareRecord, env: Env): Promise<string> {
  const ghRes = await installationRequest(
    env,
    record.installationId,
    `/repos/${encodeURIComponent(record.owner)}/${encodeURIComponent(record.repo)}/contents/${encodeAssetPath(
      record.path
    )}?ref=${encodeURIComponent(record.branch)}`,
    {
      headers: { Accept: 'application/vnd.github.raw' },
    }
  );
  if (ghRes.status === 404) {
    throw HttpError(404, 'note not found');
  }
  if (!ghRes.ok) {
    const text = await ghRes.text();
    throw HttpError(502, `github error ${ghRes.status}: ${text}`);
  }
  return await ghRes.text();
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
  const markdown = await fetchShareMarkdown(record, env);
  return cacheShareAssets(record.id, record.path, markdown);
}

function handleErrors<T>(route: (req: express.Request, res: express.Response) => Promise<T>) {
  return async function (req: express.Request, res: express.Response): Promise<T | void> {
    try {
      return await route(req, res);
    } catch (error) {
      if (error instanceof HttpErrorClass) {
        res.status(error.status).json({ error: error.message });
      } else {
        res.status(400).json({ error: getErrorMessage(error) });
      }
    }
  };
}

function HttpError(status: number, message: string): HttpErrorClass {
  return new HttpErrorClass(status, message);
}

class HttpErrorClass extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
