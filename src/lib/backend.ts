import { ensureFreshAccessToken, getApiBase } from '../auth/app-auth';
import { fetchPublicRepoInfo } from './github-public';

const GITHUB_API_BASE = 'https://api.github.com';

type InstallationSummary = {
  id: number;
  accountLogin: string | null;
  repositorySelection: 'all' | 'selected' | null;
};

type InstallationAccess = {
  installed: boolean;
  repoSelected: boolean;
  repositorySelection: 'all' | 'selected' | null;
};

export type RepoMetadata = {
  isPrivate: boolean | null;
  installed: boolean;
  repoSelected: boolean;
  repositorySelection: 'all' | 'selected' | null;
  defaultBranch: string | null;
  rateLimited?: boolean;
  manageUrl?: string | null;
};

export async function getRepoMetadata(owner: string, repo: string): Promise<RepoMetadata> {
  let token = await ensureFreshAccessToken();
  let isPrivate: boolean | null = null;
  let defaultBranch: string | null = null;
  let repoSelected = false;
  let installed = false;
  let repositorySelection: 'all' | 'selected' | null = null;
  let rateLimited = false;
  let userHasPush = false;
  let fetchedWithToken = false;

  if (token) {
    try {
      let res = await githubGet(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
      if (res.ok) {
        let json = (await res.json()) as any;
        isPrivate = json && typeof json.private === 'boolean' ? Boolean(json.private) : null;
        defaultBranch = json && typeof json.default_branch === 'string' ? String(json.default_branch) : null;
        let permissions = json && typeof json.permissions === 'object' ? json.permissions : null;
        userHasPush = Boolean(permissions && permissions.push === true);
        fetchedWithToken = true;
      } else {
        if (res.status === 403) {
          let body = await safeJson(res);
          let message = body && typeof body.message === 'string' ? body.message.toLowerCase() : '';
          if (message.includes('rate limit') || message.includes('abuse')) {
            rateLimited = true;
          }
        }
      }
    } catch (err) {
      console.warn('vibenote: failed to fetch repo metadata with auth', err);
    }

    try {
      const access = await resolveInstallationAccess(token, owner, repo);
      installed = access.installed;
      repositorySelection = access.repositorySelection;
      if (access.repoSelected && userHasPush) {
        repoSelected = true;
      } else {
        repoSelected = false;
      }
    } catch (err) {
      console.warn('vibenote: failed to resolve installation access', err);
    }
  }

  let shouldFetchPublic = !fetchedWithToken || isPrivate === null || defaultBranch === null;
  if (shouldFetchPublic) {
    let publicInfo = await fetchPublicRepoInfo(owner, repo);
    if (publicInfo.ok) {
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

  return {
    isPrivate,
    installed,
    repoSelected,
    repositorySelection,
    defaultBranch,
    rateLimited,
    manageUrl: null,
  };
}

export async function getInstallUrl(owner: string, repo: string, returnTo: string): Promise<string> {
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

async function resolveInstallationAccess(token: string, owner: string, repo: string): Promise<InstallationAccess> {
  const installations = await listUserInstallations(token);
  if (installations.length === 0) {
    return { installed: false, repoSelected: false, repositorySelection: null };
  }

  const ownerLower = owner.toLowerCase();
  const repoLower = repo.toLowerCase();
  const targetFullName = `${ownerLower}/${repoLower}`;

  // First pass: installations whose account login matches the repo owner
  let matchedInstallation = false;
  let matchedSelection: 'all' | 'selected' | null = null;
  for (const inst of installations) {
    if (!inst.accountLogin || inst.accountLogin.toLowerCase() !== ownerLower) continue;
    if (!Number.isFinite(inst.id)) continue;
    matchedInstallation = true;
    matchedSelection = inst.repositorySelection;
    if (inst.repositorySelection === 'all') {
      return { installed: true, repoSelected: true, repositorySelection: 'all' };
    }
    if (inst.repositorySelection === 'selected') {
      const hasRepo = await installationIncludesRepo(token, inst.id, targetFullName);
      if (hasRepo) {
        return { installed: true, repoSelected: true, repositorySelection: 'selected' };
      }
      // keep checking other installations for the same owner before concluding
    } else {
      // repository_selection null implies install exists but repo access unknown; continue to check others
    }
  }

  if (matchedInstallation) {
    return { installed: true, repoSelected: false, repositorySelection: matchedSelection };
  }

  // Fallback: check other installations in case repo is granted across accounts (rare)
  for (const inst of installations) {
    if (!Number.isFinite(inst.id)) continue;
    if (inst.repositorySelection !== 'selected') continue;
    const hasRepo = await installationIncludesRepo(token, inst.id, targetFullName);
    if (hasRepo) {
      return { installed: true, repoSelected: true, repositorySelection: 'selected' };
    }
  }

  return { installed: false, repoSelected: false, repositorySelection: null };
}

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
      const selectionValue = raw?.repository_selection;
      const selection = selectionValue === 'all' ? 'all' : selectionValue === 'selected' ? 'selected' : null;
      results.push({ id: idValue, accountLogin, repositorySelection: selection });
    }
    const totalCount = typeof json?.total_count === 'number' ? json.total_count : undefined;
    if (installations.length < 100) break;
    if (totalCount !== undefined && results.length >= totalCount) break;
    page += 1;
  }
  return results;
}

async function installationIncludesRepo(token: string, installationId: number, targetFullName: string): Promise<boolean> {
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
      const fullNameValue = typeof repo?.full_name === 'string'
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

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
