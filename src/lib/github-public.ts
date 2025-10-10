const CACHE_TTL_OK = 1000 * 60 * 5; // 5 minutes
const CACHE_TTL_ERROR = 1000 * 30; // 30 seconds

type CacheEntry = {
  info: PublicRepoInfo;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();
const treeCache = new Map<
  string,
  { entries: Array<{ path: string; sha: string }> | null; expiresAt: number }
>();
const fileCache = new Map<
  string,
  { file: { contentBase64: string; sha: string } | null; expiresAt: number }
>();

export type PublicRepoInfo = {
  ok: boolean;
  isPrivate?: boolean;
  defaultBranch?: string | null;
  rateLimited?: boolean;
  notFound?: boolean;
  status?: number;
  message?: string;
};

export async function fetchPublicRepoInfo(owner: string, repo: string): Promise<PublicRepoInfo> {
  const key = cacheKey(owner, repo);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.info;
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        headers: { Accept: 'application/vnd.github+json' },
      }
    );
    if (res.status === 200) {
      const data: any = await res.json();
      const info: PublicRepoInfo = {
        ok: true,
        isPrivate: Boolean(data.private),
        defaultBranch: data.default_branch ? String(data.default_branch) : null,
        rateLimited: false,
        notFound: false,
        status: res.status,
      };
      cache.set(key, { info, expiresAt: now + CACHE_TTL_OK });
      return info;
    }

    let message: string | undefined;
    try {
      const body: any = await res.json();
      if (body && typeof body.message === 'string') message = body.message;
    } catch {
      // ignore JSON parse errors
    }

    const lowered = (message || '').toLowerCase();
    const rateLimited = res.status === 403 && (lowered.includes('rate limit') || lowered.includes('abuse'));
    const info: PublicRepoInfo = {
      ok: false,
      rateLimited,
      notFound: res.status === 404,
      status: res.status,
      message,
    };
    const ttl = rateLimited ? CACHE_TTL_ERROR : CACHE_TTL_ERROR;
    cache.set(key, { info, expiresAt: now + ttl });
    return info;
  } catch (err: any) {
    const info: PublicRepoInfo = {
      ok: false,
      rateLimited: false,
      notFound: false,
      status: 0,
      message: err instanceof Error ? err.message : String(err ?? 'unknown-error'),
    };
    cache.set(key, { info, expiresAt: now + CACHE_TTL_ERROR });
    return info;
  }
}

export function clearPublicRepoInfoCache() {
  cache.clear();
  treeCache.clear();
  fileCache.clear();
}

function cacheKey(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

export async function fetchPublicTree(
  owner: string,
  repo: string,
  ref: string
): Promise<Array<{ path: string; sha: string }>> {
  const key = `tree:${cacheKey(owner, repo)}@${ref}`;
  const now = Date.now();
  const cached = treeCache.get(key);
  if (cached && cached.expiresAt > now && cached.entries) return cached.entries;
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) {
    const entries: Array<{ path: string; sha: string }> = [];
    treeCache.set(key, { entries, expiresAt: now + CACHE_TTL_ERROR });
    throw new PublicFetchError('tree', res.status);
  }
  const json: any = await res.json();
  const entries = Array.isArray(json?.tree)
    ? (json.tree as Array<any>)
        .filter((n) => n && n.type === 'blob' && typeof n.path === 'string' && typeof n.sha === 'string')
        .map((n) => ({ path: String(n.path), sha: String(n.sha) }))
    : [];
  treeCache.set(key, { entries, expiresAt: now + CACHE_TTL_OK });
  return entries;
}

export async function fetchPublicFile(
  owner: string,
  repo: string,
  path: string,
  ref?: string
): Promise<{ contentBase64: string; sha: string }> {
  const key = `file:${cacheKey(owner, repo)}:${path}@${ref ?? ''}`;
  const now = Date.now();
  const cached = fileCache.get(key);
  if (cached && cached.expiresAt > now && cached.file) return cached.file;
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo
    )}/contents/${encodeURIComponent(path)}`
  );
  if (ref) url.searchParams.set('ref', ref);
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) {
    fileCache.set(key, { file: null, expiresAt: now + CACHE_TTL_ERROR });
    throw new PublicFetchError('file', res.status);
  }
  const json: any = await res.json();
  if (!json || typeof json.sha !== 'string') {
    throw new Error('invalid public file response');
  }
  const sha = String(json.sha);
  let contentBase64 = normalizeBase64(typeof json.content === 'string' ? json.content : '');
  if (!contentBase64) {
    const blobUrl =
      typeof json.git_url === 'string'
        ? json.git_url
        : `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
            repo
          )}/git/blobs/${encodeURIComponent(sha)}`;
    const blobRes = await fetch(blobUrl, { headers: { Accept: 'application/vnd.github+json' } });
    if (blobRes.ok) {
      const blobJson: any = await blobRes.json();
      contentBase64 = normalizeBase64(typeof blobJson?.content === 'string' ? blobJson.content : '');
    }
    if (!contentBase64) {
      throw new Error('invalid public file response');
    }
  }
  const file = { contentBase64, sha };
  fileCache.set(key, { file, expiresAt: now + CACHE_TTL_OK });
  return file;
}

export class PublicFetchError extends Error {
  status: number;
  kind: 'tree' | 'file' | 'repo';
  constructor(kind: 'tree' | 'file' | 'repo', status: number) {
    super(`${kind} fetch failed (${status})`);
    this.kind = kind;
    this.status = status;
  }
}

function normalizeBase64(content: string): string {
  return content.replace(/\s+/g, '');
}
