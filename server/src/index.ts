import crypto from 'node:crypto';
import path from 'node:path';
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

app.get('/v1/auth/github/start', async (req, res) => {
  let returnTo = String(req.query.returnTo ?? '');
  let sanitizedReturnTo = normalizeReturnTo(returnTo, env.ALLOWED_ORIGINS);
  if (sanitizedReturnTo === null) {
    return res.status(400).json({ error: 'invalid returnTo origin' });
  }
  let redirect = await createAuthStartRedirect(env, sanitizedReturnTo, callbackURL(req));
  res.redirect(redirect);
});

app.get('/v1/auth/github/callback', async (req, res) => {
  try {
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
  } catch (error: unknown) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.post('/v1/auth/github/refresh', requireSession, async (req, res) => {
  try {
    let claims = req.sessionUser;
    if (!claims) {
      return res.status(401).json({ error: 'missing session' });
    }
    let tokens = await refreshAccessToken(env, sessionStore, claims.sessionId);
    res.json({ accessToken: tokens.accessToken, accessTokenExpiresAt: tokens.accessTokenExpiresAt });
  } catch (error: unknown) {
    res.status(401).json({ error: getErrorMessage(error) });
  }
});

app.post('/v1/auth/github/logout', requireSession, async (req, res) => {
  try {
    let claims = req.sessionUser;
    if (!claims) {
      return res.status(401).json({ error: 'missing session' });
    }
    await logoutSession(sessionStore, claims.sessionId);
    res.status(204).end();
  } catch (error: unknown) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.get('/v1/app/install-url', async (req, res) => {
  let owner = String(req.query.owner ?? '');
  let repo = String(req.query.repo ?? '');
  let returnTo = String(req.query.returnTo ?? '');
  let sanitizedReturnTo = normalizeReturnTo(returnTo, env.ALLOWED_ORIGINS);
  if (sanitizedReturnTo === null && returnTo.trim().length > 0) {
    return res.status(400).json({ error: 'invalid returnTo origin' });
  }
  let url = await buildInstallUrl(env, owner, repo, sanitizedReturnTo ?? '');
  res.json({ url });
});

app.get('/v1/app/setup', async (req, res) => {
  try {
    let installationId = req.query.installation_id ? String(req.query.installation_id) : null;
    let setupAction = req.query.setup_action ? String(req.query.setup_action) : null;
    let stateToken = String(req.query.state ?? '');
    let returnTo = String(req.query.returnTo ?? '');
    let sanitizedReturnTo = normalizeReturnTo(returnTo, env.ALLOWED_ORIGINS);
    if (sanitizedReturnTo === null && returnTo.trim().length > 0) {
      return res.status(400).json({ error: 'invalid returnTo origin' });
    }
    let target = await buildSetupRedirect(
      env,
      stateToken,
      sanitizedReturnTo ?? '',
      setupAction,
      installationId,
      requestOrigin(req)
    );
    res.redirect(target);
  } catch (error: unknown) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.post('/v1/webhooks/github', (_req, res) => {
  res.status(204).end();
});

app.post('/v1/shares', requireSession, async (req, res) => {
  try {
    const body = req.body ?? {};
    const owner = parseOwnerRepo(body.owner);
    const repo = parseOwnerRepo(body.repo);
    const notePath = parseNotePath(body.path);
    const branch = parseBranch(body.branch);
    if (!owner || !repo || !notePath) {
      return res.status(400).json({ error: 'missing or invalid owner/repo/path' });
    }
    if (!branch) {
      return res.status(400).json({ error: 'missing or invalid branch' });
    }
    const existing = shareStore.findActiveByNote(owner, repo, notePath);
    if (existing) {
      return res.status(200).json(shareResponse(existing, env));
    }
    const session = req.sessionUser;
    if (!session) {
      return res.status(401).json({ error: 'missing session' });
    }
    const repoAccessToken = await refreshAccessToken(env, sessionStore, session.sessionId);
    const noteExists = await verifyNoteExistsWithUserToken({
      owner,
      repo,
      path: notePath,
      branch,
      accessToken: repoAccessToken.accessToken,
    });
    if (!noteExists) {
      return res.status(404).json({ error: 'note not found' });
    }
    const installationId = await getRepoInstallationId(env, owner, repo);
    const id = generateShareId();
    const record = await shareStore.create({
      id,
      owner,
      repo,
      branch,
      path: notePath,
      createdByLogin: session.login,
      createdByUserId: session.sub,
      installationId,
    });
    console.log(`[vibenote] share created ${owner}/${repo}`);
    res.status(201).json(shareResponse(record, env));
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.get('/v1/shares', requireSession, async (req, res) => {
  try {
    const owner = parseOwnerRepo(String(req.query.owner ?? ''));
    const repo = parseOwnerRepo(String(req.query.repo ?? ''));
    const notePath = parseNotePath(String(req.query.path ?? ''));
    if (!owner || !repo || !notePath) {
      return res.status(400).json({ error: 'missing or invalid owner/repo/path' });
    }
    const session = req.sessionUser;
    if (!session) {
      return res.status(401).json({ error: 'missing session' });
    }
    await ensureRepoReadableByUser(env, sessionStore, session.sessionId, owner, repo);
    const existing = shareStore.findActiveByNote(owner, repo, notePath);
    res.json({ share: existing ? shareResponse(existing, env) : null });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.delete('/v1/shares/:id', requireSession, async (req, res) => {
  try {
    const id = getPathParam(req, 'id');
    if (!id || !isValidShareId(id)) {
      return res.status(404).json({ error: 'share not found' });
    }
    const record = shareStore.get(id);
    if (!record) {
      return res.status(404).json({ error: 'share not found' });
    }
    const session = req.sessionUser;
    if (!session) {
      return res.status(401).json({ error: 'missing session' });
    }
    const canRevoke = await canUserRevokeShare(env, sessionStore, session, record);
    if (!canRevoke) {
      return res.status(403).json({ error: 'insufficient permissions to revoke share' });
    }
    const removed = await shareStore.revoke(id, {
      revokedByLogin: session.login,
      revokedByUserId: session.sub,
    });
    if (!removed) {
      return res.status(404).json({ error: 'share not found' });
    }
    console.log(`[vibenote] share revoked ${record.owner}/${record.repo}`);
    res.status(204).end();
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.get('/v1/share-links/:id', async (req, res) => {
  const id = getPathParam(req, 'id');
  if (!id || !isValidShareId(id)) {
    return res.status(404).json({ error: 'share not found' });
  }
  const record = shareStore.get(id);
  if (!record) {
    return res.status(404).json({ error: 'share not found' });
  }
  if (record.status !== 'active') {
    return res.status(404).json({ error: 'share not found' });
  }
  res.json({
    id: record.id,
    owner: record.owner,
    repo: record.repo,
    path: record.path,
    branch: record.branch,
    createdAt: record.createdAt,
    createdBy: {
      login: record.createdByLogin,
    },
  });
});

app.get('/v1/share-links/:id/content', async (req, res) => {
  try {
    const id = getPathParam(req, 'id');
    if (!id) {
      return res.status(404).json({ error: 'share not found' });
    }
    const record = shareStore.get(id);
    if (!record) {
      return res.status(404).json({ error: 'share not found' });
    }
    if (record.status !== 'active') {
      return res.status(404).json({ error: 'share not found' });
    }
    const ghRes = await installationRequest(
      env,
      record.installationId,
      `/repos/${encodeURIComponent(record.owner)}/${encodeURIComponent(record.repo)}/contents/${encodeURIComponent(
        record.path
      )}?ref=${encodeURIComponent(record.branch)}`,
      {
        headers: { Accept: 'application/vnd.github.raw' },
      }
    );
    if (ghRes.status === 404) {
      return res.status(404).json({ error: 'note not found' });
    }
    if (!ghRes.ok) {
      const text = await ghRes.text();
      return res.status(502).json({ error: `github error ${ghRes.status}: ${text}` });
    }
    const text = await ghRes.text();
    res
      .status(200)
      .setHeader('Content-Type', 'text/markdown; charset=utf-8')
      .setHeader('Cache-Control', 'no-store')
      .send(text);
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.get('/v1/share-links/:id/assets/*', async (req, res) => {
  try {
    const id = getPathParam(req, 'id');
    if (!id) {
      return res.status(404).json({ error: 'share not found' });
    }
    const record = shareStore.get(id);
    if (!record) {
      return res.status(404).json({ error: 'share not found' });
    }
    if (record.status !== 'active') {
      return res.status(404).json({ error: 'share not found' });
    }
    const assetParam = (getPathParam(req, '0') ?? '').toString();
    const pathCandidate = resolveAssetPath(record.path, assetParam);
    if (!pathCandidate) {
      return res.status(400).json({ error: 'invalid asset path' });
    }
    const ghRes = await installationRequest(
      env,
      record.installationId,
      `/repos/${encodeURIComponent(record.owner)}/${encodeURIComponent(record.repo)}/contents/${encodeURIComponent(
        pathCandidate
      )}?ref=${encodeURIComponent(record.branch)}`,
      {
        headers: { Accept: 'application/vnd.github.raw' },
      }
    );
    if (ghRes.status === 404) {
      return res.status(404).json({ error: 'asset not found' });
    }
    if (!ghRes.ok) {
      const text = await ghRes.text();
      return res.status(502).json({ error: `github error ${ghRes.status}: ${text}` });
    }
    const buffer = Buffer.from(await ghRes.arrayBuffer());
    const contentType = ghRes.headers.get('Content-Type') ?? 'application/octet-stream';
    res
      .status(200)
      .setHeader('Content-Type', contentType)
      .setHeader('Cache-Control', 'public, max-age=300')
      .send(buffer);
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

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
    status: record.status,
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

async function ensureRepoReadableByUser(
  env: Env,
  store: SessionStoreInstance,
  sessionId: string,
  owner: string,
  repo: string
): Promise<void> {
  const tokens = await refreshAccessToken(env, store, sessionId);
  const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (res.status === 404) {
    throw new Error('repository not found or not accessible');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`github repo permissions check failed (${res.status}): ${text}`);
  }
}

async function canUserRevokeShare(env: Env, store: SessionStoreInstance, session: SessionClaims, record: ShareRecord
): Promise<boolean> {
  if (session.sub === record.createdByUserId) return true;
  try {
    const tokens = await refreshAccessToken(env, store, session.sessionId);
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(record.owner)}/${encodeURIComponent(record.repo)}`,
      {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: 'application/vnd.github+json',
        },
      }
    );
    if (!res.ok) {
      return false;
    }
    const json = (await res.json()) as any;
    const permissions = json && typeof json.permissions === 'object' ? json.permissions : undefined;
    if (permissions && permissions.push === true) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function parseOwnerRepo(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    return null;
  }
  return value;
}

function parseNotePath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let value = input.trim();
  if (value.length === 0) return null;
  value = value.replace(/\\/g, '/');
  value = value.replace(/^\/+/, '');
  if (value.includes('..')) return null;
  if (!value.toLowerCase().endsWith('.md')) return null;
  return value;
}

function parseBranch(input: unknown): string | null {
  const fallback = 'main';
  if (typeof input !== 'string') return fallback;
  const value = input.trim();
  if (value.length === 0) return fallback;
  if (!/^[\w./-]+$/.test(value)) return null;
  return value;
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

function resolveAssetPath(notePath: string, requestPath: string): string | null {
  let candidate = requestPath.trim();
  if (candidate.length === 0) return null;
  candidate = candidate.replace(/\\/g, '/');
  if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
    return null;
  }
  if (candidate.startsWith('/')) {
    candidate = candidate.replace(/^\/+/, '');
  } else {
    const noteDir = path.posix.dirname(notePath);
    candidate = noteDir === '.' ? candidate : `${noteDir}/${candidate}`;
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized.startsWith('../') || normalized === '..') {
    return null;
  }
  return normalized;
}
