// Backend adapter that resolves GitHub repo metadata and installation state.
import { ensureFreshAccessToken, refreshAccessTokenNow, getApiBase, getSessionToken } from '../auth/app-auth';
import { fetchPublicRepoInfo } from './github-public';

export { type RepoMetadata, type ShareLink, getRepoMetadata, getInstallUrl, createShareLink, disableShareLink };

const GITHUB_API_BASE = 'https://api.github.com';

type ShareLink = {
  id: string;
  url: string;
  title: string | null;
  createdAt: string;
  expiresAt: string | null;
  mode: 'unlisted';
};

type ShareCreateOptions = {
  repo: string;
  path: string;
  includeAssets: boolean;
  expiresAt?: string | null;
};

async function createShareLink(options: ShareCreateOptions): Promise<ShareLink> {
  let sessionToken = getSessionToken();
  if (!sessionToken) {
    throw new Error('Sign in with GitHub to share this note.');
  }
  let base = getApiBase();
  let payload = {
    repo: options.repo,
    path: options.path,
    mode: 'unlisted' as const,
    includeAssets: options.includeAssets,
    expiresAt: options.expiresAt ?? null,
  };
  let res = await fetch(`${base}/api/share/gist`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify(payload),
  });
  let body = await parseJsonSafe(res);
  if (!res.ok) {
    let message = body && typeof body.error === 'string' ? body.error : 'Failed to create share link.';
    throw new Error(message);
  }
  let share = normalizeShareLink(body);
  if (!share) {
    throw new Error('Share response was malformed.');
  }
  return share;
}

async function disableShareLink(shareId: string): Promise<void> {
  let sessionToken = getSessionToken();
  if (!sessionToken) {
    throw new Error('Sign in to manage shares.');
  }
  let base = getApiBase();
  let res = await fetch(`${base}/api/shares/${encodeURIComponent(shareId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  if (!res.ok && res.status !== 404 && res.status !== 204) {
    let body = await parseJsonSafe(res);
    let message = body && typeof body.error === 'string' ? body.error : 'Failed to revoke share.';
    throw new Error(message);
  }
}

async function parseJsonSafe(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function normalizeShareLink(raw: any): ShareLink | null {
  if (!raw || typeof raw !== 'object') return null;
  let id = typeof raw.id === 'string' ? raw.id : undefined;
  let url = typeof raw.url === 'string' ? raw.url : undefined;
  let createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : undefined;
  if (!id || !url || !createdAt) return null;
  let expiresAtValue = raw.expiresAt;
  let expiresAt =
    typeof expiresAtValue === 'string'
      ? expiresAtValue
      : expiresAtValue === null || expiresAtValue === undefined
      ? null
      : null;
  let titleValue = raw.title;
  let title = typeof titleValue === 'string' ? titleValue : null;
  return { id, url, title, createdAt, expiresAt, mode: 'unlisted' };
}

type RepoMetadata = {
  isPrivate: boolean | null;
  installed: boolean;
  repoSelected: boolean;
  defaultBranch: string | null;
  rateLimited?: boolean;
  // Manage URL deep-links into the GitHub App installation settings when known.
  manageUrl?: string | null;
};

async function getRepoMetadata(owner: string, repo: string): Promise<RepoMetadata> {
  let token = await ensureFreshAccessToken();
  let isPrivate: boolean | null = null;
  let defaultBranch: string | null = null;
  let repoSelected = false;
  let installed = false;
  let rateLimited = false;
  let userHasPush = false;
  let fetchedWithToken = false;
  let manageUrl: string | undefined;

  if (token) {
    try {
      let repoRes: Response | null = await githubGet(
        token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
      );
      if (repoRes.status === 401) {
        const refreshed = await refreshAccessTokenNow();
        token = refreshed;
        repoRes = refreshed
          ? await githubGet(refreshed, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
          : null;
      }
      if (repoRes && repoRes.ok) {
        let json = (await repoRes.json()) as any;
        isPrivate = json && typeof json.private === 'boolean' ? Boolean(json.private) : null;
        defaultBranch = json && typeof json.default_branch === 'string' ? String(json.default_branch) : null;
        let permissions = json && typeof json.permissions === 'object' ? json.permissions : null;
        userHasPush = Boolean(permissions && permissions.push === true);
        fetchedWithToken = true;
      } else if (repoRes && repoRes.status === 403) {
        let body = await safeJson(repoRes);
        let message = body && typeof body.message === 'string' ? body.message.toLowerCase() : '';
        if (message.includes('rate limit') || message.includes('abuse')) {
          rateLimited = true;
        }
      }
    } catch (err) {
      console.warn('vibenote: failed to fetch repo metadata with auth', err);
    }
  }

  if (token) {
    try {
      const access = await resolveInstallationAccess(token, owner, repo);
      ({ installed, manageUrl } = access);
      if (access.repoSelected && userHasPush) {
        repoSelected = true;
      } else {
        repoSelected = false;
      }
    } catch (err) {
      console.warn('vibenote: failed to resolve installation access', err);
    }
  }

  if (!fetchedWithToken) {
    let publicInfo = await fetchPublicRepoInfo(owner, repo);
    if (publicInfo.ok) {
      // will always be false for public API
      isPrivate = publicInfo.isPrivate ?? null;
      defaultBranch = publicInfo.defaultBranch ?? null;
    } else {
      if (publicInfo.isPrivate === true) isPrivate = true;
      if (publicInfo.notFound) {
        isPrivate = isPrivate ?? null;
      }
      if (publicInfo.rateLimited) rateLimited = true;
    }
  }

  return { isPrivate, installed, repoSelected, defaultBranch, rateLimited, manageUrl };
}

async function getInstallUrl(owner: string, repo: string, returnTo: string): Promise<string> {
  let base = getApiBase();
  let u = new URL(`${base}/v1/app/install-url`);
  u.searchParams.set('owner', owner);
  u.searchParams.set('repo', repo);
  u.searchParams.set('returnTo', returnTo);
  let res = await fetch(u);
  if (!res.ok) throw new Error('failed to build install url');
  let j = await res.json();
  return String(j.url || '');
}

async function githubGet(token: string, path: string): Promise<Response> {
  return await fetch(`${GITHUB_API_BASE}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
    },
  });
}

async function resolveInstallationAccess(
  token: string,
  owner: string,
  repo: string
): Promise<{
  installed: boolean;
  repoSelected: boolean;
  manageUrl?: string;
}> {
  let installations = await listUserInstallations(token);
  // we only consider installations whose account login matches the repo owner
  // (probably there is exactly one)
  let ownerLower = owner.toLowerCase();
  installations = installations.filter((inst) => inst.accountLogin?.toLowerCase() === ownerLower);

  // the owner does not match any installation account login
  if (installations.length === 0) return { installed: false, repoSelected: false };

  let repoLower = repo.toLowerCase();
  const targetFullName = `${ownerLower}/${repoLower}`;
  let manageUrl: string | undefined;

  for (let inst of installations) {
    if (!Number.isFinite(inst.id)) continue;
    if (inst.repositorySelection === 'all') {
      let manageUrl = buildInstallationManageUrl(owner, inst);
      return { installed: true, repoSelected: true, manageUrl };
    }
    if (inst.repositorySelection === 'selected') {
      manageUrl = buildInstallationManageUrl(owner, inst);
      const hasRepo = await installationIncludesRepo(token, inst.id, targetFullName);
      if (hasRepo) {
        return { installed: true, repoSelected: true, manageUrl };
      }
      // keep checking other installations for the same owner before concluding
    } else {
      // repository_selection null implies install exists but repo access unknown; continue to check others
    }
  }

  manageUrl ??= buildInstallationManageUrl(owner, installations[0]);

  return { installed: true, repoSelected: false, manageUrl };
}

type InstallationSummary = {
  id: number;
  accountLogin: string | null;
  accountType: string | null;
  repositorySelection: 'all' | 'selected' | null;
};

async function listUserInstallations(token: string): Promise<InstallationSummary[]> {
  const results: InstallationSummary[] = [];
  let page = 1;
  while (page <= 10) {
    const res = await githubGet(token, `/user/installations?per_page=100&page=${page}`);
    if (!res.ok) {
      break;
    }
    const json = (await res.json()) as any;
    const installations = Array.isArray(json?.installations) ? json.installations : [];
    for (const raw of installations) {
      const idValue = typeof raw?.id === 'number' ? raw.id : Number(raw?.id);
      if (!Number.isFinite(idValue)) continue;
      const accountLogin = raw?.account && typeof raw.account.login === 'string' ? raw.account.login : null;
      const accountType = raw?.account && typeof raw.account.type === 'string' ? raw.account.type : null;
      const selectionValue = raw?.repository_selection;
      const selection = selectionValue === 'all' ? 'all' : selectionValue === 'selected' ? 'selected' : null;
      results.push({ id: idValue, accountLogin, accountType, repositorySelection: selection });
    }
    const totalCount = typeof json?.total_count === 'number' ? json.total_count : undefined;
    if (installations.length < 100) break;
    if (totalCount !== undefined && results.length >= totalCount) break;
    page += 1;
  }
  return results;
}

async function installationIncludesRepo(
  token: string,
  installationId: number,
  targetFullName: string
): Promise<boolean> {
  let page = 1;
  while (page <= 10) {
    const res = await githubGet(
      token,
      `/user/installations/${installationId}/repositories?per_page=100&page=${page}`
    );
    if (!res.ok) {
      break;
    }
    const json = (await res.json()) as any;
    const repos = Array.isArray(json?.repositories) ? json.repositories : [];
    for (const repo of repos) {
      const fullNameValue =
        typeof repo?.full_name === 'string'
          ? repo.full_name
          : repo?.owner && typeof repo.owner.login === 'string' && typeof repo?.name === 'string'
          ? `${repo.owner.login}/${repo.name}`
          : null;
      if (!fullNameValue) continue;
      if (fullNameValue.toLowerCase() === targetFullName) {
        return true;
      }
    }
    const totalCount = typeof json?.total_count === 'number' ? json.total_count : undefined;
    if (repos.length < 100) break;
    if (totalCount !== undefined && page * 100 >= totalCount) break;
    page += 1;
  }
  return false;
}

function buildInstallationManageUrl(
  owner: string,
  summary: InstallationSummary | undefined
): string | undefined {
  if (!summary) return undefined;
  if (!Number.isFinite(summary.id)) return undefined;
  let idPart = String(summary.id);
  if (summary.accountType && summary.accountType.toLowerCase() === 'organization') {
    let login = summary.accountLogin ?? owner;
    return `https://github.com/organizations/${encodeURIComponent(login)}/settings/installations/${idPart}`;
  }
  return `https://github.com/settings/installations/${idPart}`;
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
