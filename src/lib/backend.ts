import { ensureFreshAccessToken, getApiBase } from '../auth/app-auth';
import { fetchPublicRepoInfo } from './github-public';

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
  let rateLimited = false;

  if (token) {
    try {
      let res = await fetch(repoApiUrl(owner, repo), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
      });
      if (res.ok) {
        let json = (await res.json()) as any;
        isPrivate = json && typeof json.private === 'boolean' ? Boolean(json.private) : null;
        defaultBranch = json && typeof json.default_branch === 'string' ? String(json.default_branch) : null;
        let permissions = json && typeof json.permissions === 'object' ? json.permissions : null;
        repoSelected = Boolean(permissions && permissions.push === true);
        installed = true;
        return {
          isPrivate,
          installed,
          repoSelected,
          repositorySelection: null,
          defaultBranch,
          rateLimited,
          manageUrl: null,
        };
      }
      if (res.status === 401) {
        // Session token likely expired; drop cached access token
        console.warn('vibenote: received 401 when fetching repo metadata');
      }
      if (res.status === 403) {
        let body: any = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        let message = body && typeof body.message === 'string' ? body.message.toLowerCase() : '';
        if (message.includes('rate limit') || message.includes('abuse')) {
          rateLimited = true;
        }
      }
    } catch (err) {
      console.warn('vibenote: failed to fetch repo metadata with auth', err);
    }
  }

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

  return {
    isPrivate,
    installed,
    repoSelected,
    repositorySelection: null,
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

function repoApiUrl(owner: string, repo: string): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
