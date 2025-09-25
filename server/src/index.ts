import express from 'express';
import cors from 'cors';
import { getEnv } from './env.ts';
import {
  createAuthStartRedirect,
  handleAuthCallback,
  buildInstallUrl,
  buildSetupRedirect,
  fetchRepoMetadata,
  fetchRepoTree,
  fetchRepoFile,
  fetchRepoBlob,
  commitToRepo,
  parseCommitRequestBody,
  verifyBearerSession,
  type SessionClaims,
} from './api.ts';

declare module 'express-serve-static-core' {
  interface Request {
    sessionUser?: SessionClaims;
  }
}

const env = getEnv();
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
  const returnTo = String(req.query.returnTo ?? '');
  const redirect = await createAuthStartRedirect(env, returnTo, callbackURL(req));
  res.redirect(redirect);
});

app.get('/v1/auth/github/callback', async (req, res) => {
  try {
    const code = String(req.query.code ?? '');
    const stateToken = String(req.query.state ?? '');
    const { html } = await handleAuthCallback(env, code, stateToken, callbackURL(req), requestOrigin(req));
    res.status(200).type('html').send(html);
  } catch (error: unknown) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.get('/v1/app/install-url', async (req, res) => {
  const owner = String(req.query.owner ?? '');
  const repo = String(req.query.repo ?? '');
  const returnTo = String(req.query.returnTo ?? '');
  const url = await buildInstallUrl(env, owner, repo, returnTo);
  res.json({ url });
});

app.get('/v1/app/setup', async (req, res) => {
  try {
    const installationId = req.query.installation_id ? String(req.query.installation_id) : null;
    const setupAction = req.query.setup_action ? String(req.query.setup_action) : null;
    const stateToken = String(req.query.state ?? '');
    const returnTo = String(req.query.returnTo ?? '');
    const target = await buildSetupRedirect(
      env,
      stateToken,
      returnTo,
      setupAction,
      installationId,
      requestOrigin(req)
    );
    res.redirect(target);
  } catch (error: unknown) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.get('/v1/repos/:owner/:repo/metadata', async (req, res) => {
  try {
    const data = await fetchRepoMetadata(env, String(req.params.owner), String(req.params.repo));
    res.json(data);
  } catch (error: unknown) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.get('/v1/repos/:owner/:repo/tree', async (req, res) => {
  try {
    const data = await fetchRepoTree(
      env,
      String(req.params.owner),
      String(req.params.repo),
      req.query.ref ? String(req.query.ref) : null
    );
    res.json(data);
  } catch (error: unknown) {
    if (isInstallationMissingError(error)) {
      return res.status(403).json({ error: 'app not installed for this repo' });
    }
    if (error instanceof Error && error.message === 'ref missing') {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.get('/v1/repos/:owner/:repo/file', async (req, res) => {
  const path = String(req.query.path ?? '');
  if (!path) return res.status(400).json({ error: 'path required' });
  try {
    const data = await fetchRepoFile(
      env,
      String(req.params.owner),
      String(req.params.repo),
      path,
      req.query.ref ? String(req.query.ref) : undefined
    );
    res.json(data);
  } catch (error: unknown) {
    if (isInstallationMissingError(error)) {
      return res.status(403).json({ error: 'app not installed for this repo' });
    }
    if (error instanceof Error && error.message) {
      if (error.message === 'path refers to a directory' || error.message === 'unsupported content type') {
        return res.status(400).json({ error: error.message });
      }
    }
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.get('/v1/repos/:owner/:repo/blob/:sha', async (req, res) => {
  try {
    const data = await fetchRepoBlob(
      env,
      String(req.params.owner),
      String(req.params.repo),
      String(req.params.sha)
    );
    res.json(data);
  } catch (error: unknown) {
    if (isInstallationMissingError(error)) {
      return res.status(403).json({ error: 'app not installed for this repo' });
    }
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.post('/v1/repos/:owner/:repo/commit', requireSession, async (req, res) => {
  try {
    const payload = parseCommitRequestBody(req.body);
    const result = await commitToRepo(
      env,
      String(req.params.owner),
      String(req.params.repo),
      payload,
      req.sessionUser
    );
    res.json(result);
  } catch (error: unknown) {
    if (isInstallationMissingError(error)) {
      return res.status(403).json({ error: 'app not installed for this repo' });
    }
    if (error instanceof Error && /^(branch|changes) required/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    if (error instanceof Error && error.message.startsWith('invalid ')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.post('/v1/webhooks/github', (_req, res) => {
  res.status(204).end();
});

const server = app.listen(env.PORT, () => {
  console.log(`[vibenote] api listening on :${env.PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
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

function isInstallationMissingError(error: unknown): boolean {
  return error instanceof Error && error.message === 'app not installed for this repo';
}

function requireSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.header('authorization') || req.header('Authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    return res.status(401).json({ error: 'missing auth' });
  }
  const token = header.slice(7).trim();
  verifyBearerSession(token, env)
    .then((claims) => {
      req.sessionUser = claims;
      next();
    })
    .catch(() => res.status(401).json({ error: 'invalid session' }));
}
