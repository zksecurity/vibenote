import type { Env } from './env.ts';
import {
  makeApp,
  getRepositoryInstallation,
  getOwnerInstallation,
  getDefaultBranch,
  getInstallationOctokit,
  getRepoDetailsViaInstallation,
} from './github.ts';
import { signSession, verifySession, signState, verifyState, type SessionClaims } from './jwt.ts';

export type { SessionClaims };

export type CommitChange = {
  path: string;
  contentBase64?: string;
  delete?: boolean;
};

export type CommitRequest = {
  branch: string;
  message?: string;
  changes: CommitChange[];
};

export type RepoMetadataPayload = {
  isPrivate: boolean | null;
  installed: boolean;
  repoSelected: boolean;
  repositorySelection: 'all' | 'selected' | null;
  defaultBranch: string | null;
  manageUrl: string | null;
};

export async function createAuthStartRedirect(
  env: Env,
  returnTo: string,
  callbackUrl: string
): Promise<string> {
  const state = await signState({ returnTo, t: Date.now() }, env.SESSION_JWT_SECRET, 600);
  const params = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID,
    redirect_uri: callbackUrl,
    scope: 'read:user user:email',
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function handleAuthCallback(
  env: Env,
  code: string,
  stateToken: string,
  callbackUrl: string,
  pageOrigin: string
): Promise<{ html: string }> {
  const state = await verifyState(stateToken, env.SESSION_JWT_SECRET);
  const returnTo = getOptionalString(state, 'returnTo') ?? '/';
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl,
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
  const user = parseGitHubUser(await ures.json());
  const sessionToken = await signSession(
    {
      sub: user.id,
      login: user.login,
      avatarUrl: user.avatarUrl,
      name: user.name,
    },
    env.SESSION_JWT_SECRET
  );
  const rt = new URL(returnTo, returnTo.startsWith('http') ? undefined : pageOrigin);
  const origin = rt.origin;
  const html = `<!doctype html><meta charset="utf-8"><title>VibeNote Login</title><script>
      (function(){
        try {
          const msg = { type: 'vibenote:auth', sessionToken: ${JSON.stringify(
            sessionToken
          )}, user: { id: ${JSON.stringify(user.id)}, login: ${JSON.stringify(
    user.login
  )}, name: ${JSON.stringify(user.name)}, avatarUrl: ${JSON.stringify(
    user.avatarUrl
  )}, avatarDataUrl: null } };
          if (window.opener && '${origin}') { window.opener.postMessage(msg, '${origin}'); }
        } catch (e) {}
        setTimeout(function(){ window.close(); }, 50);
      })();
    </script>
    <p>Signed in. You can close this window. <a href="${rt.toString()}">Continue</a></p>`;
  return { html };
}

export async function buildInstallUrl(
  env: Env,
  owner: string,
  repo: string,
  returnTo: string
): Promise<string> {
  const state = await signState({ owner, repo, returnTo, t: Date.now() }, env.SESSION_JWT_SECRET, 60 * 30);
  return `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(
    state
  )}`;
}

export async function buildSetupRedirect(
  env: Env,
  stateToken: string,
  returnTo: string,
  setupAction: string | null,
  installationId: string | null,
  origin: string
): Promise<string> {
  const state = await verifyState(stateToken, env.SESSION_JWT_SECRET);
  const fallback = getOptionalString(state, 'returnTo') ?? '/';
  const url = new URL(returnTo || fallback, returnTo.startsWith('http') ? undefined : origin);
  if (installationId) url.searchParams.set('installation_id', installationId);
  if (setupAction) url.searchParams.set('setup_action', setupAction);
  return url.toString();
}

export async function fetchRepoMetadata(env: Env, owner: string, repo: string): Promise<RepoMetadataPayload> {
  const appClient = makeApp(env);
  let isPrivate: boolean | null = null;
  let defaultBranch: string | null = null;
  let repoAccessible = false;
  let repositorySelection: 'all' | 'selected' | null = null;
  let manageUrl: string | null = null;

  const repoInst = await getRepositoryInstallation(appClient, owner, repo);
  let ownerInstRecord = null as Awaited<ReturnType<typeof getOwnerInstallation>> | null;
  if (repoInst) {
    repoAccessible = true;
    repositorySelection = repoInst.repository_selection;
    manageUrl = buildInstallationManageUrl(repoInst.account, repoInst.id);
    const details = await getRepoDetailsViaInstallation(appClient, repoInst.id, owner, repo);
    if (details) {
      isPrivate = details.isPrivate;
      defaultBranch = details.defaultBranch;
    }
  } else {
    ownerInstRecord = await getOwnerInstallation(appClient, owner);
    if (ownerInstRecord) {
      repositorySelection = ownerInstRecord.repository_selection;
      manageUrl = buildInstallationManageUrl(ownerInstRecord.account, ownerInstRecord.id);
      if (repositorySelection === 'all') {
        repoAccessible = true;
        const details = await getRepoDetailsViaInstallation(appClient, ownerInstRecord.id, owner, repo);
        if (details) {
          isPrivate = details.isPrivate;
          defaultBranch = details.defaultBranch;
        }
      }
    }
  }
  const installed = Boolean(repoInst || ownerInstRecord);
  return {
    isPrivate,
    installed,
    repoSelected: repoAccessible,
    repositorySelection,
    defaultBranch,
    manageUrl,
  };
}

export async function fetchRepoTree(
  env: Env,
  owner: string,
  repo: string,
  ref: string | null
): Promise<{ entries: unknown[] }> {
  const appClient = makeApp(env);
  const repoInst = await getRepositoryInstallation(appClient, owner, repo);
  if (!repoInst) throw new Error('app not installed for this repo');
  const kit = await getInstallationOctokit(appClient, repoInst.id);
  let branch = ref;
  if (!branch) {
    branch = await getDefaultBranch(appClient, repoInst.id, owner, repo);
  }
  if (!branch) throw new Error('ref missing');
  const { data } = await kit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
    owner,
    repo,
    tree_sha: branch,
    recursive: '1',
  });
  return { entries: data.tree };
}

export async function fetchRepoFile(
  env: Env,
  owner: string,
  repo: string,
  path: string,
  ref?: string
): Promise<{ contentBase64: string; sha: string }> {
  const appClient = makeApp(env);
  const repoInst = await getRepositoryInstallation(appClient, owner, repo);
  if (!repoInst) throw new Error('app not installed for this repo');
  const kit = await getInstallationOctokit(appClient, repoInst.id);
  const response = await kit.request('GET /repos/{owner}/{repo}/contents/{path}', {
    owner,
    repo,
    path,
    ref,
  });
  if (Array.isArray(response.data)) {
    throw new Error('path refers to a directory');
  }
  if (response.data.type !== 'file') {
    throw new Error('unsupported content type');
  }
  return { contentBase64: response.data.content, sha: response.data.sha };
}

export async function fetchRepoBlob(
  env: Env,
  owner: string,
  repo: string,
  sha: string
): Promise<{ contentBase64: string; encoding: string }> {
  const appClient = makeApp(env);
  const repoInst = await getRepositoryInstallation(appClient, owner, repo);
  if (!repoInst) throw new Error('app not installed for this repo');
  const kit = await getInstallationOctokit(appClient, repoInst.id);
  const { data } = await kit.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', {
    owner,
    repo,
    file_sha: sha,
  });
  return { contentBase64: data.content, encoding: String(data.encoding) };
}

export async function commitToRepo(
  env: Env,
  owner: string,
  repo: string,
  payload: CommitRequest,
  sessionUser?: SessionClaims
): Promise<{ commitSha: string; blobShas: Record<string, string> }>;
export async function commitToRepo(
  env: Env,
  owner: string,
  repo: string,
  payload: CommitRequest,
  sessionUser?: SessionClaims
): Promise<{ commitSha: string; blobShas: Record<string, string> }> {
  const appClient = makeApp(env);
  const repoInst = await getRepositoryInstallation(appClient, owner, repo);
  if (!repoInst) throw new Error('app not installed for this repo');
  const kit = await getInstallationOctokit(appClient, repoInst.id);

  const { branch, message = 'Update from VibeNote', changes } = payload;
  if (!branch || !Array.isArray(changes) || changes.length === 0) {
    throw new Error('branch and changes required');
  }

  const { data: refData } = await kit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  if (!refData.object || typeof refData.object !== 'object' || refData.object.type !== 'commit') {
    throw new Error('unexpected ref target');
  }
  const headSha = refData.object.sha;
  const { data: headCommit } = await kit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
    owner,
    repo,
    commit_sha: headSha,
  });
  const baseTreeSha = headCommit.tree.sha;

  const treeItems: Array<{
    path?: string;
    mode?: '100644' | '100755' | '040000' | '160000' | '120000';
    type?: 'blob' | 'tree' | 'commit';
    sha?: string | null;
    content?: string;
    encoding?: 'utf-8';
  }> = [];
  const trackedPaths = new Set<string>();
  for (const change of changes) {
    if (change.delete) {
      treeItems.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const contentBase64 = change.contentBase64 ?? '';
    let decoded = '';
    try {
      decoded = Buffer.from(contentBase64, 'base64').toString('utf-8');
    } catch (error) {
      console.warn('[vibenote] failed to decode base64 content for', change.path, error);
    }
    treeItems.push({ path: change.path, mode: '100644', type: 'blob', content: decoded, encoding: 'utf-8' });
    trackedPaths.add(change.path);
  }

  let finalMessage = message.trim().length > 0 ? message.trim() : 'Update from VibeNote';
  if (sessionUser && sessionUser.login && sessionUser.sub) {
    const display =
      sessionUser.name && sessionUser.name.trim().length > 0 ? sessionUser.name : sessionUser.login;
    const coAuthorLine = `Co-authored-by: ${display} <${sessionUser.sub}+${sessionUser.login}@users.noreply.github.com>`;
    if (!finalMessage.includes('Co-authored-by:')) {
      finalMessage = `${finalMessage}\n\n${coAuthorLine}`;
    }
  }

  const { data: newTree } = await kit.request('POST /repos/{owner}/{repo}/git/trees', {
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: treeItems,
  });
  const blobByPath: Record<string, string> = {};
  if (Array.isArray(newTree.tree)) {
    for (const entry of newTree.tree) {
      if (!entry || entry.type !== 'blob') continue;
      if (!entry.path || !entry.sha) continue;
      if (trackedPaths.has(entry.path)) blobByPath[entry.path] = entry.sha;
    }
  }
  const { data: newCommit } = await kit.request('POST /repos/{owner}/{repo}/git/commits', {
    owner,
    repo,
    message: finalMessage,
    tree: newTree.sha,
    parents: [headSha],
  });
  await kit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: newCommit.sha,
    force: false,
  });
  return { commitSha: newCommit.sha, blobShas: blobByPath };
}

export function parseCommitRequestBody(input: unknown): CommitRequest {
  if (!input || typeof input !== 'object') throw new Error('invalid commit payload');
  const record = input as Record<string, unknown>;
  const branch = typeof record.branch === 'string' ? record.branch.trim() : '';
  if (!branch) throw new Error('branch required');
  const rawChanges = record.changes;
  if (!Array.isArray(rawChanges) || rawChanges.length === 0) {
    throw new Error('changes required');
  }
  const changes = rawChanges.map((raw, index) => {
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
  const message = typeof record.message === 'string' ? record.message : undefined;
  return { branch, message, changes };
}

export async function verifyBearerSession(token: string, env: Env): Promise<SessionClaims> {
  return await verifySession(token, env.SESSION_JWT_SECRET);
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

function getOptionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return null;
}

function buildInstallationManageUrl(account: unknown, installationId: number): string | null {
  if (!installationId) return null;
  let type: string | undefined;
  let login: string | undefined;
  if (account && typeof account === 'object') {
    const record = account as Record<string, unknown>;
    if (typeof record.type === 'string') type = record.type;
    if (typeof record.login === 'string') login = record.login;
  }
  if (type === 'Organization' && login) {
    return `https://github.com/organizations/${login}/settings/installations/${installationId}`;
  }
  return `https://github.com/settings/installations/${installationId}`;
}
