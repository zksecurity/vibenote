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
  }),
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
    const state = (await verifyState(stateToken, env.SESSION_JWT_SECRET)) as any;
    const returnTo = typeof state?.returnTo === 'string' && state.returnTo ? state.returnTo : '/';
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
    const tokenJson = (await tokenRes.json()) as any;
    const accessToken = String(tokenJson.access_token ?? '');
    if (!accessToken) throw new Error('no access token');
    const ures = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
    });
    if (!ures.ok) throw new Error(`user fetch failed: ${ures.status}`);
    const u: any = await ures.json();
    const sessionToken = await signSession(
      {
        sub: String(u.id),
        login: String(u.login),
        avatarUrl: (u.avatar_url as string) ?? null,
        name: (u.name as string | null) ?? null,
      },
      env.SESSION_JWT_SECRET,
    );

    const rt = new URL(returnTo, returnTo.startsWith('http') ? undefined : `https://${req.headers.host}`);
    const origin = rt.origin;
    const html = `<!doctype html><meta charset="utf-8"><title>VibeNote Login</title><script>
      (function(){
        try {
          const msg = { type: 'vibenote:auth', sessionToken: ${JSON.stringify(
            sessionToken,
          )}, user: { id: ${JSON.stringify(String(u.id))}, login: ${JSON.stringify(
            String(u.login),
          )}, name: ${JSON.stringify((u.name as string | null) ?? null)}, avatarUrl: ${JSON.stringify(
            u.avatar_url ?? null,
          )}, avatarDataUrl: null } };
          if (window.opener && '${origin}') { window.opener.postMessage(msg, '${origin}'); }
        } catch (e) {}
        setTimeout(function(){ window.close(); }, 50);
      })();
    </script>
    <p>Signed in. You can close this window. <a href="${rt.toString()}">Continue</a></p>`;
    res.status(200).type('html').send(html);
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

// App install URL
app.get('/v1/app/install-url', async (req: express.Request, res: express.Response) => {
  const owner = String(req.query.owner ?? '');
  const repo = String(req.query.repo ?? '');
  const returnTo = String(req.query.returnTo ?? '');
  const state = await signState({ owner, repo, returnTo, t: Date.now() }, env.SESSION_JWT_SECRET, 60 * 30);
  const url = `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(
    state,
  )}`;
  res.json({ url });
});

// Setup URL (post install)
app.get('/v1/app/setup', async (req: express.Request, res: express.Response) => {
  try {
    const installationId = req.query.installation_id ? String(req.query.installation_id) : null;
    const setupAction = req.query.setup_action ? String(req.query.setup_action) : null;
    const stateToken = String(req.query.state ?? '');
    const state = (await verifyState(stateToken, env.SESSION_JWT_SECRET)) as any;
    const returnTo = typeof state?.returnTo === 'string' && state.returnTo ? state.returnTo : '/';
    const url = new URL(returnTo, returnTo.startsWith('http') ? undefined : `https://${req.headers.host}`);
    if (installationId) url.searchParams.set('installation_id', installationId);
    if (setupAction) url.searchParams.set('setup_action', setupAction);
    res.redirect(url.toString());
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
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
      repositorySelection = (repoInst.repository_selection as 'all' | 'selected' | undefined) ?? null;
      const details = await getRepoDetailsViaInstallation(appClient, repoInst.id, owner, repo);
      if (details) {
        isPrivate = details.isPrivate;
        defaultBranch = details.defaultBranch;
      }
    } else {
      const ownerInst = await getOwnerInstallation(appClient, owner);
      if (ownerInst) {
        installed = true;
        repositorySelection = (ownerInst.repository_selection as 'all' | 'selected' | undefined) ?? null;
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
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Tree
app.get('/v1/repos/:owner/:repo/tree', async (req: express.Request, res: express.Response) => {
  const owner = String(req.params.owner);
  const repo = String(req.params.repo);
  const ref = req.query.ref ? String(req.query.ref) : null;
  const appClient = makeApp(env);
  try {
    let kit: any = null;
    let useAuth = false;
    const repoInst = await getRepositoryInstallation(appClient, owner, repo);
    if (repoInst) {
      kit = await getInstallationOctokit(appClient, repoInst.id);
      useAuth = true;
    }
    let branch = ref;
    if (!branch) {
      if (useAuth) {
        branch = await getDefaultBranch(appClient, repoInst!.id, owner, repo);
      } else {
        return res.status(400).json({ error: 'ref missing' });
      }
    }
    if (!branch) return res.status(400).json({ error: 'ref missing' });
    const url = `GET /repos/{owner}/{repo}/git/trees/{tree_sha}`;
    if (useAuth) {
      const r = await kit.request(url, { owner, repo, tree_sha: branch, recursive: '1' as any });
      return res.json({ entries: r.data.tree });
    } else {
      const unauth = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        { headers: { Accept: 'application/vnd.github+json' } },
      );
      if (!unauth.ok) return res.status(unauth.status).json({ error: `github: ${unauth.status}` });
      const data: any = await unauth.json();
      return res.json({ entries: data.tree });
    }
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
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
    if (repoInst) {
      const kit = await getInstallationOctokit(appClient, repoInst.id);
      const r: any = await kit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path,
        ref,
      });
      const file: any = Array.isArray(r.data) ? null : r.data;
      if (!file) return res.status(400).json({ error: 'path refers to a directory' });
      return res.json({ contentBase64: file.content, sha: file.sha });
    }
    // unauth for public
    const u = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`);
    if (ref) u.searchParams.set('ref', ref);
    const r = await fetch(u, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return res.status(r.status).json({ error: `github: ${r.status}` });
    const file: any = await r.json();
    return res.json({ contentBase64: file.content, sha: file.sha });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
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
    const r: any = await kit.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', {
      owner,
      repo,
      file_sha: sha,
    });
    // r.data.content is base64
    return res.json({ contentBase64: r.data.content, encoding: r.data.encoding });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Auth guard for write endpoints
function requireSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  const h = req.header('authorization') || req.header('Authorization');
  if (!h || !h.toLowerCase().startsWith('bearer ')) return res.status(401).json({ error: 'missing auth' });
  const token = h.slice(7).trim();
  verifySession(token, env.SESSION_JWT_SECRET)
    .then((claims) => {
      (req as any).sessionUser = claims;
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
    const body = req.body as any;
    const branch = String(body.branch ?? '');
    let message = String(body.message ?? 'Update from VibeNote');
    const changes = Array.isArray(body.changes)
      ? (body.changes as Array<{
          path: string;
          contentBase64?: string;
          sha?: string;
          delete?: boolean;
        }>)
      : [];
    if (!branch || changes.length === 0)
      return res.status(400).json({ error: 'branch and changes required' });

    try {
      const appClient = makeApp(env);
      const repoInst = await getRepositoryInstallation(appClient, owner, repo);
      if (!repoInst) return res.status(403).json({ error: 'app not installed for this repo' });
      const kit = await getInstallationOctokit(appClient, repoInst.id);

      // Resolve HEAD commit sha
      const ref = await kit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner,
        repo,
        ref: `heads/${branch}`,
      });
      const headSha = String((ref.data.object as any).sha);
      const headCommit = await kit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
        owner,
        repo,
        commit_sha: headSha!,
      });
      const baseTreeSha = String(headCommit.data.tree.sha);

      const treeItems: Array<{
        path?: string;
        mode?: '100644' | '100755' | '040000' | '160000' | '120000';
        type?: 'blob' | 'tree' | 'commit';
        sha?: string | null;
        content?: string;
        encoding?: 'utf-8' | 'base64';
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

      const session = (req as any).sessionUser as SessionClaims | undefined;
      if (session && session.login && session.sub) {
        const display = session.name && session.name.trim().length > 0 ? session.name : session.login;
        const coAuthorLine = `Co-authored-by: ${display} <${session.sub}+${session.login}@users.noreply.github.com>`;
        if (!message.includes('Co-authored-by:')) {
          message = `${message.trim()}\n\n${coAuthorLine}`;
        }
      }

      const newTree: any = await kit.request('POST /repos/{owner}/{repo}/git/trees', {
        owner,
        repo,
        base_tree: baseTreeSha,
        tree: treeItems as any,
      });
      const blobByPath: Record<string, string> = {};
      if (Array.isArray(newTree.data?.tree)) {
        for (const entry of newTree.data.tree as Array<any>) {
          if (!entry || entry.type !== 'blob') continue;
          if (typeof entry.path !== 'string' || typeof entry.sha !== 'string') continue;
          if (trackedPaths.has(entry.path)) blobByPath[entry.path] = entry.sha;
        }
      }
      const newCommit: any = await kit.request('POST /repos/{owner}/{repo}/git/commits', {
        owner,
        repo,
        message,
        tree: String(newTree.data.sha),
        parents: [headSha],
      });
      await kit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: String(newCommit.data.sha),
        force: false,
      });
      res.json({ commitSha: newCommit.data.sha, blobShas: blobByPath });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  },
);

// Optional webhooks placeholder (no-op for v1)
app.post('/v1/webhooks/github', (req: express.Request, res: express.Response) => {
  res.status(204).end();
});

const server = app.listen(env.PORT, () => {
  console.log(`[vibenote] api listening on :${env.PORT}`);
});

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
