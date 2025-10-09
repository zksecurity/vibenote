import express from 'express';
import cors from 'cors';
import { getEnv } from './env.ts';
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
import { createSessionStore } from './session-store.ts';
import { createShareStore } from './share-store.ts';
import {
  createShare,
  resolveShare,
  disableShare,
  fetchSharedFile,
  markExpiredShares,
  ShareError,
} from './share-service.ts';

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
let shareStore = createShareStore({
  filePath: env.SHARE_STORE_FILE,
});
await shareStore.init();
let corsOrigins = Array.from(new Set([...env.ALLOWED_ORIGINS, ...env.PUBLIC_VIEWER_ORIGINS]));

const app = express();
app.use(express.json({ limit: '2mb' }));

const corsMiddleware = cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (corsOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS not allowed'));
  },
  credentials: true,
});

app.use(corsMiddleware);
app.options('*', corsMiddleware);

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

app.post('/api/share/gist', requireSession, async (req, res) => {
  setShareSecurityHeaders(res, 'json');
  try {
    let claims = req.sessionUser;
    if (!claims) {
      return res.status(401).json({ error: 'missing session' });
    }
    let body = req.body ?? {};
    let modeValue = typeof body.mode === 'string' ? body.mode : 'unlisted';
    let includeAssets =
      body.includeAssets === undefined ? undefined : body.includeAssets === null ? undefined : Boolean(body.includeAssets);
    let expiresAt =
      body.expiresAt === null ? null : typeof body.expiresAt === 'string' ? body.expiresAt : undefined;
    let request = {
      repo: typeof body.repo === 'string' ? body.repo : '',
      path: typeof body.path === 'string' ? body.path : '',
      mode: modeValue as any,
      includeAssets,
      expiresAt,
    };
    let result = await createShare(env, shareStore, sessionStore, claims.sessionId, claims.login, request);
    res.status(201).json({
      id: result.shared.id,
      url: result.url,
      title: result.shared.title ?? null,
      createdAt: result.shared.createdAt,
      expiresAt: result.shared.expiresAt ?? null,
      mode: result.shared.mode,
    });
  } catch (error) {
    if (handleShareError(res, error)) return;
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.delete('/api/shares/:id', requireSession, async (req, res) => {
  setShareSecurityHeaders(res, 'json');
  try {
    let claims = req.sessionUser;
    if (!claims) {
      return res.status(401).json({ error: 'missing session' });
    }
    let shareId = String(req.params.id ?? '').trim();
    if (shareId.length === 0) {
      return res.status(400).json({ error: 'invalid share id' });
    }
    let record = shareStore.getById(shareId);
    if (!record) {
      return res.status(204).end();
    }
    if (record.createdBy.userId !== claims.sub) {
      return res.status(403).json({ error: 'forbidden' });
    }
    await disableShare(shareStore, shareId);
    res.status(204).end();
  } catch (error) {
    if (handleShareError(res, error)) return;
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.get('/api/shares/:id/resolve', async (req, res) => {
  setShareSecurityHeaders(res, 'json');
  try {
    let shareId = String(req.params.id ?? '').trim();
    if (shareId.length === 0) {
      return res.status(400).json({ error: 'invalid share id' });
    }
    let resolved = await resolveShare(shareStore, shareId);
    if (!resolved) {
      return res.status(404).json({ error: 'share not found' });
    }
    if (resolved.isDisabled) {
      return res.status(410).json({ error: 'share unavailable', share: resolved });
    }
    res.json({ share: resolved });
  } catch (error) {
    if (handleShareError(res, error)) return;
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.get('/api/gist-raw', async (req, res) => {
  setShareSecurityHeaders(res, 'asset');
  try {
    let shareId = String(req.query.share ?? '').trim();
    let fileName = String(req.query.file ?? '').trim();
    if (shareId.length === 0 || fileName.length === 0) {
      return res.status(400).json({ error: 'missing share or file' });
    }
    let result = await fetchSharedFile(env, shareStore, shareId, fileName);
    if (result === null) {
      return res.status(404).json({ error: 'share not found' });
    }
    let contentType =
      result.mediaType ??
      (result.isPrimary ? 'text/markdown; charset=utf-8' : 'application/octet-stream');
    if (result.isPrimary && !contentType.includes('charset')) {
      contentType = `${contentType}; charset=utf-8`;
    }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(result.bytes);
  } catch (error) {
    if (handleShareError(res, error)) return;
    res.status(500).json({ error: getErrorMessage(error) });
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

setInterval(() => {
  markExpiredShares(shareStore).catch((error) => {
    console.error('[vibenote] share prune failed', error);
  });
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

function handleShareError(res: express.Response, error: unknown): boolean {
  if (error instanceof ShareError) {
    res.status(error.status).json({ error: error.message });
    return true;
  }
  return false;
}

function setShareSecurityHeaders(res: express.Response, kind: 'json' | 'asset'): void {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  if (kind === 'asset') {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"
    );
  } else {
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
  }
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
