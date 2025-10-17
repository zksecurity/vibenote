// Backend adapter that resolves GitHub repo metadata, installation state, and share link APIs.
import { ensureFreshAccessToken, refreshAccessTokenNow, getApiBase, getSessionToken } from '../auth/app-auth';
import { fetchPublicRepoInfo } from './github-public';

export {
  type RepoMetadata,
  type ShareLink,
  getRepoMetadata,
  getInstallUrl,
  getShareLinkForNote,
  createShareLink,
  revokeShareLink,
};

const GITHUB_API_BASE = 'https://api.github.com';

type RepoMetadataErrorKind = 'auth' | 'not-found' | 'forbidden' | 'network' | 'rate-limited' | 'unknown';

type RepoMetadata = {
  isPrivate: boolean | null;
  installed: boolean;
  repoSelected: boolean;
  defaultBranch: string | null;
  rateLimited?: boolean;
  // Manage URL deep-links into the GitHub App installation settings when known.
  manageUrl?: string | null;
  authFailed?: boolean;
  notFound?: boolean;
  forbidden?: boolean;
  networkError?: boolean;
  errorStatus?: number | null;
  errorMessage?: string | null;
  errorKind?: RepoMetadataErrorKind | null;
};

type ShareLink = {
  id: string;
  owner: string;
  repo: string;
  path: string;
  branch: string;
  createdAt: string;
  createdByLogin: string;
  createdByUserId: string;
  url: string;
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
  let authFailed = false;
  let notFound = false;
  let forbidden = false;
  let networkError = false;
  let errorStatus: number | null = null;
  let errorMessage: string | null = null;
  let errorKind: RepoMetadataErrorKind | null = null;

  // Track the first meaningful API failure so the UI can differentiate auth vs install issues.
  const rememberError = (kind: RepoMetadataErrorKind, status: number | null, message: string | null) => {
    if (!errorKind) errorKind = kind;
    if (status !== null && errorStatus === null) errorStatus = status;
    if (message && !errorMessage) errorMessage = message;
  };

  const extractMessage = (payload: Record<string, unknown> | null) => {
    let raw = payload && typeof payload.message === 'string' ? payload.message : undefined;
    return raw ? String(raw) : null;
  };

  // Wrap GitHub fetches so network errors bubble up as structured metadata instead of exceptions.
  const fetchRepoWithToken = async (activeToken: string): Promise<Response | null> => {
    try {
      return await githubGet(activeToken, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    } catch (err) {
      networkError = true;
      rememberError('network', 0, err instanceof Error ? err.message : String(err ?? 'unknown-error'));
      return null;
    }
  };

  if (token) {
    try {
      let repoRes: Response | null = await fetchRepoWithToken(token);
      if (repoRes && repoRes.status === 401) {
        const unauthorizedBody = await safeJson(repoRes);
        const unauthorizedMessage = extractMessage(unauthorizedBody) ?? 'GitHub authentication failed';
        const refreshed = await refreshAccessTokenNow();
        token = refreshed;
        repoRes = refreshed ? await fetchRepoWithToken(refreshed) : null;
        if (refreshed === null) {
          authFailed = true;
          rememberError('auth', 401, unauthorizedMessage);
        }
      }
      if (repoRes && repoRes.ok) {
        let json = (await repoRes.json()) as any;
        isPrivate = json && typeof json.private === 'boolean' ? Boolean(json.private) : null;
        defaultBranch = json && typeof json.default_branch === 'string' ? String(json.default_branch) : null;
        let permissions = json && typeof json.permissions === 'object' ? json.permissions : null;
        userHasPush = Boolean(permissions && permissions.push === true);
        fetchedWithToken = true;
      } else if (repoRes) {
        let body = await safeJson(repoRes);
        let message = extractMessage(body);
        switch (repoRes.status) {
          case 401:
            authFailed = true;
            rememberError('auth', repoRes.status, message ?? 'GitHub authentication failed');
            break;
          case 403: {
            let lowered = (message ?? '').toLowerCase();
            if (lowered.includes('rate limit') || lowered.includes('abuse')) {
              rateLimited = true;
              rememberError('rate-limited', repoRes.status, message ?? 'GitHub rate limited the request');
            } else {
              forbidden = true;
              rememberError('forbidden', repoRes.status, message ?? 'GitHub denied access to the repository');
            }
            break;
          }
          case 404:
            notFound = true;
            rememberError('not-found', repoRes.status, message ?? 'Repository not found for the current user');
            break;
          default:
            rememberError('unknown', repoRes.status, message);
            break;
        }
      }
    } catch (err) {
      console.warn('vibenote: failed to fetch repo metadata with auth', err);
      networkError = true;
      rememberError('network', 0, err instanceof Error ? err.message : String(err ?? 'unknown-error'));
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
      rememberError('network', 0, err instanceof Error ? err.message : String(err ?? 'unknown-error'));
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
        notFound = true;
        rememberError('not-found', publicInfo.status ?? 404, publicInfo.message ?? 'Repository not found');
      }
      if (publicInfo.rateLimited) rateLimited = true;
      if (publicInfo.rateLimited) {
        rememberError('rate-limited', publicInfo.status ?? 403, publicInfo.message ?? 'GitHub rate limited the request');
      }
    }
  }

  return {
    isPrivate,
    installed,
    repoSelected,
    defaultBranch,
    rateLimited,
    manageUrl,
    authFailed,
    notFound,
    forbidden,
    networkError,
    errorStatus,
    errorMessage,
    errorKind,
  };
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

async function getShareLinkForNote(owner: string, repo: string, path: string): Promise<ShareLink | null> {
  const sessionToken = getSessionToken();
  if (!sessionToken) return null;
  const base = getApiBase();
  const url = new URL(`${base}/v1/shares`);
  url.searchParams.set('owner', owner);
  url.searchParams.set('repo', repo);
  url.searchParams.set('path', path);
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      Accept: 'application/json',
    },
  });
  if (res.status === 401) {
    return null;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`share lookup failed (${res.status}): ${text}`);
  }
  const payload = (await res.json()) as { share?: unknown };
  if (!payload || payload.share === undefined || payload.share === null) {
    return null;
  }
  const parsed = parseShare(payload.share);
  if (!parsed) {
    throw new Error('invalid share payload');
  }
  return parsed;
}

async function createShareLink(options: {
  owner: string;
  repo: string;
  path: string;
  branch: string;
}): Promise<ShareLink> {
  const sessionToken = getSessionToken();
  if (!sessionToken) throw new Error('missing session token');
  const base = getApiBase();
  const res = await fetch(`${base}/v1/shares`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`share create failed (${res.status}): ${text}`);
  }
  const parsed = parseShare(await res.json());
  if (!parsed) {
    throw new Error('invalid share payload');
  }
  return parsed;
}

async function revokeShareLink(id: string): Promise<void> {
  const sessionToken = getSessionToken();
  if (!sessionToken) throw new Error('missing session token');
  const base = getApiBase();
  const res = await fetch(`${base}/v1/shares/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`share revoke failed (${res.status}): ${text}`);
  }
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

function parseShare(input: unknown): ShareLink | null {
  if (!input || typeof input !== 'object') return null;
  const data = input as Record<string, unknown>;
  const id = asString(data.id);
  const owner = asString(data.owner);
  const repo = asString(data.repo);
  const path = asString(data.path);
  const branch = asString(data.branch);
  const createdAt = asString(data.createdAt);
  const url = asString(data.url);
  const createdBy =
    data.createdBy && typeof data.createdBy === 'object' ? (data.createdBy as Record<string, unknown>) : null;
  const createdByLogin = createdBy ? asString(createdBy.login) : null;
  const createdByUserId = createdBy ? asString(createdBy.userId) : null;
  if (
    !id ||
    !owner ||
    !repo ||
    !path ||
    !branch ||
    !createdAt ||
    !url ||
    !createdByLogin ||
    !createdByUserId
  ) {
    return null;
  }
  return {
    id,
    owner,
    repo,
    path,
    branch,
    createdAt,
    createdByLogin,
    createdByUserId,
    url,
  };
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
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
