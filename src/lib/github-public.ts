const CACHE_TTL_OK = 1000 * 60 * 5; // 5 minutes
const CACHE_TTL_ERROR = 1000 * 30; // 30 seconds

type CacheEntry = {
  info: PublicRepoInfo;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

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
    const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
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
}

function cacheKey(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

