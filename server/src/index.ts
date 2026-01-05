// Express API server wiring and request handling.
import express from 'express';
import cors from 'cors';
import { env } from './env.ts';
import {
  createAuthStartRedirect,
  handleAuthCallback,
  buildInstallUrl,
  buildSetupRedirect,
  refreshAccessToken,
  logoutSession,
  type SessionClaims,
} from './api.ts';
import { createSessionStore } from './session-store.ts';
import { handleErrors, HttpError, requireSession } from './common.ts';
import { sharingEndpoints } from './sharing.ts';

declare module 'express-serve-static-core' {
  interface Request {
    sessionUser?: SessionClaims;
  }
}

const sessionStore = createSessionStore({
  filePath: env.SESSION_STORE_FILE,
  encryptionKey: env.SESSION_ENCRYPTION_KEY,
});
await sessionStore.init();

function isAllowedOrigin(origin: string): boolean {
  // Allow production origins
  if (env.ALLOWED_ORIGINS.includes(origin)) return true;
  // Allow preview deployments only if pattern is configured
  if (env.PREVIEW_URL_PATTERN && env.PREVIEW_URL_PATTERN.test(origin)) return true;
  return false;
}

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(Error('CORS not allowed'));
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
      callbackURL(req)
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
    let tokens = await refreshAccessToken(env, sessionStore, claims.sessionId, requestOriginForAccessCheck(req));
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

sharingEndpoints(app);

const server = app.listen(env.PORT, () => {
  console.log(`[vibenote] api listening on :${env.PORT}`);
  if (env.PREVIEW_ALLOWED_GITHUB_USERS && env.PREVIEW_ALLOWED_GITHUB_USERS.length > 0) {
    console.log(`[vibenote] preview deployment allowlist: ${env.PREVIEW_ALLOWED_GITHUB_USERS.join(', ')}`);
  }
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

function requestOriginForAccessCheck(req: express.Request): string {
  let origin = req.get('origin');
  if (origin !== undefined && origin.trim().length > 0) {
    return origin;
  }
  throw HttpError(400, 'missing origin');
}

function getProtocol(req: express.Request): string {
  return req.protocol ?? 'https';
}

function getHost(req: express.Request): string {
  return req.get('host') ?? 'localhost';
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
  // Check explicit allowlist
  if (allowedOrigins.includes(parsed.origin)) {
    return parsed.toString();
  }
  // Check preview pattern if configured
  if (env.PREVIEW_URL_PATTERN && env.PREVIEW_URL_PATTERN.test(parsed.origin)) {
    return parsed.toString();
  }
  return null;
}
