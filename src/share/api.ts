// Helpers for the public share viewer to talk to the backend git-shares API.
export type { ShareRef, ShareMetaResponse };
export { getApiBase, parseShareUrl, fetchShareMeta, fetchShareContent, buildAssetUrl };

// Discriminated union identifying which tier a share URL belongs to.
type ShareRef =
  | { tier: 1; owner: string; repo: string; shareId: string }
  | { tier: 2; segment: string };

// Both tiers return the repo owner; Tier 2 keeps repo and shareId opaque.
type ShareMetaResponse = {
  owner: string;
};

// Tier 2 opaque segments are exactly 32 base64url characters.
const OPAQUE_SEGMENT_RE = /^[A-Za-z0-9_-]{32}$/;

let cachedBase: string | null = null;

function getApiBase(): string {
  if (cachedBase) return cachedBase;
  const env = (import.meta as any).env || {};
  const fromEnv: string | undefined = env.VITE_VIBENOTE_API_BASE || env.VIBENOTE_API_BASE;
  const fromGlobal: string | undefined = (globalThis as any).VIBENOTE_API_BASE;
  const base = fromEnv ?? fromGlobal ?? '';
  if (!base) throw new Error('VIBENOTE_API_BASE not set for share viewer');
  cachedBase = String(base).replace(/\/$/, '');
  return cachedBase;
}

// Parse the current window location into a ShareRef, or null if the URL is unrecognised.
function parseShareUrl(): ShareRef | null {
  try {
    const pathname = window.location.pathname;
    // Expect /s/<rest>
    const match = pathname.match(/^\/s\/(.+)$/);
    if (!match || !match[1]) return null;
    const rest = match[1];
    const segments = rest.split('/').filter((s) => s !== '');

    if (segments.length === 3) {
      // Tier 1: /s/<owner>/<repo>/<shareId>
      const [owner, repo, shareId] = segments;
      if (!owner || !repo || !shareId) return null;
      return { tier: 1, owner, repo, shareId };
    }

    if (segments.length === 1 && OPAQUE_SEGMENT_RE.test(segments[0] ?? '')) {
      // Tier 2: /s/<32-char opaque segment>
      return { tier: 2, segment: segments[0]! };
    }
  } catch {
    // ignore
  }
  return null;
}

function metaUrl(ref: ShareRef): string {
  const base = getApiBase();
  if (ref.tier === 1) {
    return `${base}/v1/git-shares/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${encodeURIComponent(ref.shareId)}`;
  }
  return `${base}/v1/git-shares/${ref.segment}`;
}

function contentUrl(ref: ShareRef): string {
  return `${metaUrl(ref)}/content`;
}

function buildAssetUrl(ref: ShareRef, relativePath: string): string {
  const params = new URLSearchParams({ path: relativePath });
  return `${metaUrl(ref)}/assets?${params.toString()}`;
}

async function fetchShareMeta(ref: ShareRef): Promise<Response> {
  return fetch(metaUrl(ref), { headers: { Accept: 'application/json' } });
}

async function fetchShareContent(ref: ShareRef): Promise<Response> {
  return fetch(contentUrl(ref), { headers: { Accept: 'text/markdown' } });
}
