import express from 'express';
import cors from 'cors';
import { getEnv } from './env.ts';
import { signSession, verifySession, signState, verifyState, type SessionClaims } from './jwt.ts';
import {
  makeApp,
  getRepositoryInstallation,
  getOwnerInstallation,
  getDefaultBranch,
  getInstallationOctokit,
  getRepoDetailsViaInstallation,
} from './github.ts';

declare module 'express-serve-static-core' {
  interface Request {
    sessionUser?: SessionClaims;
  }
}

type CommitChange = {
  path: string;
  contentBase64?: string;
  delete?: boolean;
};

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

app.get('/v1/healthz', (_req: express.Request, res: express.Response) => res.json({ ok: true }));

// Auth: start OAuth (popup)
app.get('/v1/auth/github/start', async (req: express.Request, res: express.Response) => {
  const returnTo = String(req.query.returnTo ?? '');
  const state = await signState({ returnTo, t: Date.now() }, env.SESSION_JWT_SECRET, 600);
  const params = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID,
    redirect_uri: callbackURL(req),
    scope: 'read:user user:email',
    state,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

// Auth: callback
app.get('/v1/auth/github/callback', async (req: express.Request, res: express.Response) => {
  try {
    const code = String(req.query.code ?? '');
    const stateToken = String(req.query.state ?? '');
    const state = await verifyState(stateToken, env.SESSION_JWT_SECRET);
    const returnTo = getOptionalString(state, 'returnTo') ?? '/';
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.GITHUB_OAUTH_CLIENT_ID,
        client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
        code,
        redirect_uri: callbackURL(req),
        state: stateToken,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
    const tokenJson = await tokenRes.json();
    const accessToken = parseAccessToken(tokenJson);
    const ures = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
    });
    if (!ures.ok) throw new Error(`user fetch failed: ${ures.status}`);
    const u = parseGitHubUser(await ures.json());
    const sessionToken = await signSession(
      {
        sub: u.id,
        login: u.login,
        avatarUrl: u.avatarUrl,
        name: u.name,
      },
      env.SESSION_JWT_SECRET
    );

    const rt = new URL(returnTo, returnTo.startsWith('http') ? undefined : `https://${req.headers.host}`);
    const origin = rt.origin;
    const html = `<!doctype html><meta charset="utf-8"><title>VibeNote Login</title><script>
      (function(){
        try {
          const msg = { type: 'vibenote:auth', sessionToken: ${JSON.stringify(
            sessionToken
          )}, user: { id: ${JSON.stringify(u.id)}, login: ${JSON.stringify(u.login)}, name: ${JSON.stringify(
            u.name
          )}, avatarUrl: ${JSON.stringify(u.avatarUrl)}, avatarDataUrl: null } };
          if (window.opener && '${origin}') { window.opener.postMessage(msg, '${origin}'); }
        } catch (e) {}
        setTimeout(function(){ window.close(); }, 50);
      })();
    </script>
    <p>Signed in. You can close this window. <a href="${rt.toString()}">Continue</a></p>`;
    res.status(200).type('html').send(html);
  } catch (error: unknown) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// App install URL
app.get('/v1/app/install-url', async (req: express.Request, res: express.Response) => {
  const owner = String(req.query.owner ?? '');
  const repo = String(req.query.repo ?? '');
  const returnTo = String(req.query.returnTo ?? '');
  const state = await signState({ owner, repo, returnTo, t: Date.now() }, env.SESSION_JWT_SECRET, 60 * 30);
  const url = `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(
    state
  )}`;
  res.json({ url });
});

// Setup URL (post install)
app.get('/v1/app/setup', async (req: express.Request, res: express.Response) => {
  try {
    const installationId = req.query.installation_id ? String(req.query.installation_id) : null;
    const setupAction = req.query.setup_action ? String(req.query.setup_action) : null;
    const stateToken = String(req.query.state ?? '');
    const state = await verifyState(stateToken, env.SESSION_JWT_SECRET);
    const returnTo = getOptionalString(state, 'returnTo') ?? '/';
    const url = new URL(returnTo, returnTo.startsWith('http') ? undefined : `https://${req.headers.host}`);
    if (installationId) url.searchParams.set('installation_id', installationId);
    if (setupAction) url.searchParams.set('setup_action', setupAction);
    res.redirect(url.toString());
  } catch (error: unknown) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Metadata
app.get('/v1/repos/:owner/:repo/metadata', async (req: express.Request, res: express.Response) => {
  const owner = String(req.params.owner);
  const repo = String(req.params.repo);
  const appClient = makeApp(env);
  try {
    let isPrivate: boolean | null = null;
    let defaultBranch: string | null = null;
    let installed = false;
    let repoSelected = false;
    let repositorySelection: 'all' | 'selected' | null = null;
    const repoInst = await getRepositoryInstallation(appClient, owner, repo);
    if (repoInst) {
      installed = true;
      repoSelected = true;
      repositorySelection = repoInst.repository_selection;
      const details = await getRepoDetailsViaInstallation(appClient, repoInst.id, owner, repo);
      if (details) {
        isPrivate = details.isPrivate;
        defaultBranch = details.defaultBranch;
      }
    } else {
      const ownerInst = await getOwnerInstallation(appClient, owner);
      if (ownerInst) {
        installed = true;
        repositorySelection = ownerInst.repository_selection;
        repoSelected = repositorySelection === 'all' ? true : false;
        if (repoSelected) {
          const details = await getRepoDetailsViaInstallation(appClient, ownerInst.id, owner, repo);
          if (details) {
            isPrivate = details.isPrivate;
            defaultBranch = details.defaultBranch;
          }
        }
      }

      // Uninstalled and no additional data; leave isPrivate/defaultBranch null for client-side fetch
    }

    return res.json({ isPrivate, installed, repoSelected, repositorySelection, defaultBranch });
  } catch (error: unknown) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// Tree
app.get('/v1/repos/:owner/:repo/tree', async (req: express.Request, res: express.Response) => {
  const owner = String(req.params.owner);
  const repo = String(req.params.repo);
  const ref = req.query.ref ? String(req.query.ref) : null;
  const appClient = makeApp(env);
  try {
    const repoInst = await getRepositoryInstallation(appClient, owner, repo);
    if (!repoInst) return res.status(403).json({ error: 'app not installed for this repo' });
    const kit = await getInstallationOctokit(appClient, repoInst.id);
    let branch = ref;
    if (!branch) {
      branch = await getDefaultBranch(appClient, repoInst.id, owner, repo);
    }
    if (!branch) return res.status(400).json({ error: 'ref missing' });
    const { data } = await kit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
      owner,
      repo,
      tree_sha: branch,
      recursive: '1',
    });
    return res.json({ entries: data.tree });
  } catch (error: unknown) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// File
app.get('/v1/repos/:owner/:repo/file', async (req: express.Request, res: express.Response) => {
  const owner = String(req.params.owner);
  const repo = String(req.params.repo);
  const path = String(req.query.path ?? '');
  const ref = req.query.ref ? String(req.query.ref) : undefined;
  if (!path) return res.status(400).json({ error: 'path required' });
  const appClient = makeApp(env);
  try {
    const repoInst = await getRepositoryInstallation(appClient, owner, repo);
    if (!repoInst) return res.status(403).json({ error: 'app not installed for this repo' });
    const kit = await getInstallationOctokit(appClient, repoInst.id);
    const response = await kit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner,
      repo,
      path,
      ref,
    });
    if (Array.isArray(response.data)) {
      return res.status(400).json({ error: 'path refers to a directory' });
    }
    if (response.data.type !== 'file') {
      return res.status(400).json({ error: 'unsupported content type' });
    }
    return res.json({ contentBase64: response.data.content, sha: response.data.sha });
  } catch (error: unknown) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// Blob by sha (requires installation; used for 3-way merges)
app.get('/v1/repos/:owner/:repo/blob/:sha', async (req: express.Request, res: express.Response) => {
  const owner = String(req.params.owner);
  const repo = String(req.params.repo);
  const sha = String(req.params.sha);
  const appClient = makeApp(env);
  try {
    const repoInst = await getRepositoryInstallation(appClient, owner, repo);
    if (!repoInst) return res.status(403).json({ error: 'app not installed for this repo' });
    const kit = await getInstallationOctokit(appClient, repoInst.id);
    const { data } = await kit.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', {
      owner,
      repo,
      file_sha: sha,
    });
    return res.json({ contentBase64: data.content, encoding: data.encoding });
  } catch (error: unknown) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// Auth guard for write endpoints
function requireSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  const h = req.header('authorization') || req.header('Authorization');
  if (!h || !h.toLowerCase().startsWith('bearer ')) return res.status(401).json({ error: 'missing auth' });
  const token = h.slice(7).trim();
  verifySession(token, env.SESSION_JWT_SECRET)
    .then((claims) => {
      req.sessionUser = claims;
      next();
    })
    .catch(() => res.status(401).json({ error: 'invalid session' }));
}

// Commit endpoint (atomic commit via Git Data API)
app.post(
  '/v1/repos/:owner/:repo/commit',
  requireSession,
  async (req: express.Request, res: express.Response) => {
    const owner = String(req.params.owner);
    const repo = String(req.params.repo);
    const { branch, message: bodyMessage, changes } = parseCommitRequestBody(req.body);
    let message = bodyMessage ?? 'Update from VibeNote';
    message = message.trim().length > 0 ? message.trim() : 'Update from VibeNote';

    try {
      const appClient = makeApp(env);
      const repoInst = await getRepositoryInstallation(appClient, owner, repo);
      if (!repoInst) return res.status(403).json({ error: 'app not installed for this repo' });
      const kit = await getInstallationOctokit(appClient, repoInst.id);

      // Resolve HEAD commit sha
      const { data: refData } = await kit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner,
        repo,
        ref: `heads/${branch}`,
      });
      if (!refData.object || typeof refData.object !== 'object' || refData.object.type !== 'commit') {
        throw new Error('unexpected ref target');
      }
      const headSha = refData.object.sha;
      const { data: headCommitData } = await kit.request(
        'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
        { owner, repo, commit_sha: headSha }
      );
      const baseTreeSha = headCommitData.tree.sha;

      const treeItems: Array<{
        path?: string;
        mode?: '100644' | '100755' | '040000' | '160000' | '120000';
        type?: 'blob' | 'tree' | 'commit';
        sha?: string | null;
        content?: string;
        encoding?: 'utf-8';
      }> = [];
      const trackedPaths = new Set<string>();
      for (const ch of changes) {
        if (ch.delete === true) {
          treeItems.push({ path: ch.path, mode: '100644', type: 'blob', sha: null });
          continue;
        }
        const contentBase64 = ch.contentBase64 ?? '';
        let decoded: string;
        try {
          decoded = Buffer.from(contentBase64, 'base64').toString('utf-8');
        } catch (err) {
          console.warn('[vibenote] failed to decode base64 content for', ch.path, err);
          decoded = '';
        }
        treeItems.push({
          path: ch.path,
          mode: '100644',
          type: 'blob',
          content: decoded,
          encoding: 'utf-8',
        });
        trackedPaths.add(ch.path);
      }

      const session = req.sessionUser;
      if (session && session.login && session.sub) {
        const display = session.name && session.name.trim().length > 0 ? session.name : session.login;
        const coAuthorLine = `Co-authored-by: ${display} <${session.sub}+${session.login}@users.noreply.github.com>`;
        if (!message.includes('Co-authored-by:')) {
          message = `${message.trim()}\n\n${coAuthorLine}`;
        }
      }

      const { data: newTreeData } = await kit.request('POST /repos/{owner}/{repo}/git/trees', {
        owner,
        repo,
        base_tree: baseTreeSha,
        tree: treeItems,
      });
      const blobByPath: Record<string, string> = {};
      if (Array.isArray(newTreeData.tree)) {
        for (const entry of newTreeData.tree) {
          if (!entry || entry.type !== 'blob') continue;
          if (!entry.path || !entry.sha) continue;
          if (trackedPaths.has(entry.path)) blobByPath[entry.path] = entry.sha;
        }
      }
      const { data: newCommitData } = await kit.request('POST /repos/{owner}/{repo}/git/commits', {
        owner,
        repo,
        message,
        tree: newTreeData.sha,
        parents: [headSha],
      });
      await kit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: newCommitData.sha,
        force: false,
      });
      res.json({ commitSha: newCommitData.sha, blobShas: blobByPath });
    } catch (error: unknown) {
      res.status(500).json({ error: getErrorMessage(error) });
    }
  }
);

// Optional webhooks placeholder (no-op for v1)
app.post('/v1/webhooks/github', (req: express.Request, res: express.Response) => {
  res.status(204).end();
});

const server = app.listen(env.PORT, () => {
  console.log(`[vibenote] api listening on :${env.PORT}`);
});

function getOptionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return null;
}

function parseAccessToken(json: unknown): string {
  if (!json || typeof json !== 'object') throw new Error('invalid token response');
  const token = (json as Record<string, unknown>).access_token;
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new Error('no access token');
  }
  return token;
}

function parseGitHubUser(json: unknown): {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
} {
  if (!json || typeof json !== 'object') throw new Error('invalid user response');
  const obj = json as Record<string, unknown>;
  const idValue = obj.id;
  const loginValue = obj.login;
  if ((typeof idValue !== 'number' && typeof idValue !== 'string') || typeof loginValue !== 'string') {
    throw new Error('invalid user payload');
  }
  const nameValue = obj.name;
  const avatarValue = obj.avatar_url;
  return {
    id: String(idValue),
    login: loginValue,
    name: typeof nameValue === 'string' && nameValue.length > 0 ? nameValue : null,
    avatarUrl: typeof avatarValue === 'string' && avatarValue.length > 0 ? avatarValue : null,
  };
}

function parseCommitRequestBody(input: unknown): {
  branch: string;
  message?: string;
  changes: CommitChange[];
} {
  if (!input || typeof input !== 'object') throw new Error('invalid commit payload');
  const record = input as Record<string, unknown>;
  const branchValue = typeof record.branch === 'string' ? record.branch.trim() : '';
  if (!branchValue) throw new Error('branch required');
  const rawChanges = record.changes;
  if (!Array.isArray(rawChanges) || rawChanges.length === 0) {
    throw new Error('changes required');
  }
  const changes: CommitChange[] = rawChanges.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`invalid change at index ${index}`);
    }
    const changeRecord = raw as Record<string, unknown>;
    const pathValue = typeof changeRecord.path === 'string' ? changeRecord.path.trim() : '';
    if (!pathValue) {
      throw new Error(`missing path for change at index ${index}`);
    }
    const deleteFlag = changeRecord.delete === true;
    const contentValue = changeRecord.contentBase64;
    if (!deleteFlag) {
      if (typeof contentValue !== 'string') {
        throw new Error(`missing contentBase64 for change at index ${index}`);
      }
      return {
        path: pathValue,
        contentBase64: contentValue,
      };
    }
    return { path: pathValue, delete: true };
  });

  const messageValue = typeof record.message === 'string' ? record.message : undefined;
  return { branch: branchValue, message: messageValue, changes };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

// Graceful shutdown (systemd / docker stop)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[vibenote] received ${sig}, shutting down...`);
    server.close(() => {
      console.log('[vibenote] shutdown complete');
      process.exit(0);
    });
    // Force exit if not closed in 8s
    setTimeout(() => {
      console.error('[vibenote] force exit after timeout');
      process.exit(1);
    }, 8000).unref();
  });
}

function callbackURL(req: express.Request): string {
  // Matches what you configured in the GitHub App
  const host = req.get('host');
  const proto = req.get('x-forwarded-proto') ?? req.protocol;
  return `${proto}://${host}/v1/auth/github/callback`;
}
