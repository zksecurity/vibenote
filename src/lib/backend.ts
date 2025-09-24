import { getSessionToken } from '../auth/app-auth';
import { getApiBase } from '../auth/app-auth';

export type RepoMetadata = {
  isPrivate: boolean | null;
  installed: boolean;
  repoSelected: boolean;
  repositorySelection: 'all' | 'selected' | null;
  defaultBranch: string | null;
  rateLimited?: boolean;
};

function headers(auth: boolean): HeadersInit {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (auth) {
    const t = getSessionToken();
    if (t) h['Authorization'] = `Bearer ${t}`;
  }
  return h;
}

export async function getRepoMetadata(owner: string, repo: string): Promise<RepoMetadata> {
  const base = getApiBase();
  const res = await fetch(`${base}/v1/repos/${encode(owner)}/${encode(repo)}/metadata`);
  if (!res.ok) throw new Error('metadata fetch failed');
  return (await res.json()) as RepoMetadata;
}

export async function getTree(
  owner: string,
  repo: string,
  ref?: string
): Promise<Array<{ path: string; type: string; sha?: string }>> {
  const base = getApiBase();
  const url = new URL(`${base}/v1/repos/${encode(owner)}/${encode(repo)}/tree`);
  if (ref) url.searchParams.set('ref', ref);
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error('tree fetch failed');
    (err as any).status = res.status;
    throw err;
  }
  const data = await res.json();
  return Array.isArray(data.entries) ? data.entries : [];
}

export async function getFile(
  owner: string,
  repo: string,
  path: string,
  ref?: string
): Promise<{ contentBase64: string; sha: string }> {
  const base = getApiBase();
  const url = new URL(`${base}/v1/repos/${encode(owner)}/${encode(repo)}/file`);
  url.searchParams.set('path', path);
  if (ref) url.searchParams.set('ref', ref);
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error('file fetch failed');
    (err as any).status = res.status;
    throw err;
  }
  return (await res.json()) as { contentBase64: string; sha: string };
}

export async function getBlob(owner: string, repo: string, sha: string): Promise<{ contentBase64: string }> {
  const base = getApiBase();
  const res = await fetch(`${base}/v1/repos/${encode(owner)}/${encode(repo)}/blob/${encode(sha)}`);
  if (!res.ok) throw new Error('blob fetch failed');
  return (await res.json()) as { contentBase64: string };
}

export type CommitResponse = { commitSha: string; blobShas?: Record<string, string> };

export async function commit(
  owner: string,
  repo: string,
  body: {
    branch: string;
    message: string;
    changes: Array<{ path: string; contentBase64?: string; delete?: boolean }>;
    baseSha?: string;
  }
): Promise<CommitResponse> {
  const base = getApiBase();
  const res = await fetch(`${base}/v1/repos/${encode(owner)}/${encode(repo)}/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers(true) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`commit failed (${res.status})`);
  return (await res.json()) as CommitResponse;
}

export async function getInstallUrl(owner: string, repo: string, returnTo: string): Promise<string> {
  const base = getApiBase();
  const u = new URL(`${base}/v1/app/install-url`);
  u.searchParams.set('owner', owner);
  u.searchParams.set('repo', repo);
  u.searchParams.set('returnTo', returnTo);
  const res = await fetch(u);
  if (!res.ok) throw new Error('failed to build install url');
  const j = await res.json();
  return String(j.url || '');
}

function encode(s: string): string {
  return encodeURIComponent(s);
}
