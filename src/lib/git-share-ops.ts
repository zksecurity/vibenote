// Git-native share operations — create, revoke, and look up shares stored as
// plain-text files in .shares/ within the repo.
//
// .shares/.repo-id  →  random 11-char base64url string (one per repo)
// .shares/<shareId> →  note path, e.g. "notes/foo.md"
//
// Opaque share URLs: <origin>/s/<segment>
//   segment = base64url(repoIdBytes[8] ∥ shareIdBytes[16]) = 32 chars
//
// Known share info is cached in localStorage to avoid re-reading from GitHub on
// every note selection. Shares created on other devices won't appear until the
// user explicitly creates a new one (acceptable limitation for now).

import { ensureFreshAccessToken, getApiBase } from '../auth/app-auth';
import { normalizePath } from './util';

export type { GitShareLink };
export { createGitShare, revokeGitShare, lookupCachedShare };

type GitShareLink = {
  shareId: string;
  url: string;
};

// --- Crypto helpers (browser-native, no Node.js) ---

function toBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromBase64url(s: string): Uint8Array {
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)!;
  return bytes;
}

function generateRepoId(): string {
  // 8 random bytes → 11-char base64url
  return toBase64url(crypto.getRandomValues(new Uint8Array(8)));
}

function generateShareId(): string {
  // 16 random bytes → 22-char base64url (128 bits of entropy)
  return toBase64url(crypto.getRandomValues(new Uint8Array(16)));
}

// Combine repoId (8 bytes) and shareId (16 bytes) into a 32-char opaque segment.
function computeOpaqueSegment(repoId: string, shareId: string): string {
  const combined = new Uint8Array(24);
  combined.set(fromBase64url(repoId), 0);
  combined.set(fromBase64url(shareId), 8);
  return toBase64url(combined);
}

// --- localStorage share cache ---
//
// Key:   vibenote:share-cache:<owner>/<repo>  (lowercase)
// Value: { repoId: string; shares: { [normalizedNotePath]: shareId } }

type ShareCache = {
  repoId: string;
  shares: Record<string, string>;
};

function shareCacheKey(owner: string, repo: string): string {
  return `vibenote:share-cache:${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function readShareCache(owner: string, repo: string): ShareCache | null {
  try {
    const raw = localStorage.getItem(shareCacheKey(owner, repo));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as Record<string, unknown>).repoId !== 'string' ||
      typeof (parsed as Record<string, unknown>).shares !== 'object'
    ) {
      return null;
    }
    return parsed as ShareCache;
  } catch {
    return null;
  }
}

function writeShareCache(owner: string, repo: string, cache: ShareCache): void {
  try {
    localStorage.setItem(shareCacheKey(owner, repo), JSON.stringify(cache));
  } catch {
    // ignore (storage quota exceeded, private browsing, etc.)
  }
}

// Returns the GitShareLink for a note if one is cached, otherwise null.
// Synchronous — safe to call on every note selection.
function lookupCachedShare(owner: string, repo: string, notePath: string): GitShareLink | null {
  const cache = readShareCache(owner, repo);
  if (!cache) return null;
  const shareId = cache.shares[normalizePath(notePath)];
  if (!shareId) return null;
  const segment = computeOpaqueSegment(cache.repoId, shareId);
  return { shareId, url: `${window.location.origin}/s/${segment}` };
}

function setCachedShare(
  owner: string,
  repo: string,
  repoId: string,
  notePath: string,
  shareId: string
): void {
  const cache = readShareCache(owner, repo) ?? { repoId, shares: {} };
  cache.repoId = repoId;
  cache.shares[normalizePath(notePath)] = shareId;
  writeShareCache(owner, repo, cache);
}

function deleteCachedShare(owner: string, repo: string, notePath: string): void {
  const cache = readShareCache(owner, repo);
  if (!cache) return;
  delete cache.shares[normalizePath(notePath)];
  writeShareCache(owner, repo, cache);
}

// --- GitHub Contents API helpers ---

const GITHUB_API = 'https://api.github.com';

type RepoFileResult = { text: string; sha: string };

// Encode UTF-8 text to standard base64 for GitHub Contents API payloads.
function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// Decode GitHub's base64 content (which may contain embedded newlines) to text.
function base64ToText(b64: string): string {
  const clean = b64.replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)!;
  return new TextDecoder().decode(bytes);
}

function encodeRepoPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function repoContentsUrl(owner: string, repo: string, path: string): string {
  return `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeRepoPath(path)}`;
}

async function readRepoFile(
  token: string,
  owner: string,
  repo: string,
  path: string
): Promise<RepoFileResult | null> {
  const res = await fetch(repoContentsUrl(owner, repo, path), {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read failed (${res.status}): ${path}`);
  const json = await res.json() as Record<string, unknown>;
  const sha = typeof json.sha === 'string' ? json.sha : '';
  const content = typeof json.content === 'string' ? json.content : '';
  return { text: base64ToText(content), sha };
}

async function putRepoFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  text: string,
  message: string
): Promise<void> {
  const res = await fetch(repoContentsUrl(owner, repo, path), {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, content: textToBase64(text) }),
  });
  if (!res.ok) throw new Error(`GitHub write failed (${res.status}): ${path}`);
}

async function deleteRepoFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  sha: string,
  message: string
): Promise<void> {
  const res = await fetch(repoContentsUrl(owner, repo, path), {
    method: 'DELETE',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, sha }),
  });
  if (!res.ok) throw new Error(`GitHub delete failed (${res.status}): ${path}`);
}

// --- Backend repo-id registration ---

async function registerRepoId(repoId: string, owner: string, repo: string): Promise<void> {
  const base = getApiBase();
  const res = await fetch(`${base}/v1/repo-id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId, owner, repo }),
  });
  if (!res.ok) throw new Error(`repo-id registration failed (${res.status})`);
}

// --- Ensure repoId ---
// Read .shares/.repo-id from the repo; generate and commit one if absent.
// Updates the localStorage cache with the repoId.

async function ensureRepoId(token: string, owner: string, repo: string): Promise<string> {
  // Check cache first to avoid a round-trip when possible
  const cache = readShareCache(owner, repo);
  if (cache?.repoId) return cache.repoId;

  const existing = await readRepoFile(token, owner, repo, '.shares/.repo-id');
  if (existing) {
    const repoId = existing.text.trim();
    const updated = cache ?? { repoId, shares: {} };
    updated.repoId = repoId;
    writeShareCache(owner, repo, updated);
    return repoId;
  }

  // First share ever in this repo — generate and commit a fresh repoId
  const repoId = generateRepoId();
  await putRepoFile(token, owner, repo, '.shares/.repo-id', repoId, 'shares: initialize repo id');
  writeShareCache(owner, repo, { repoId, shares: {} });
  return repoId;
}

// --- High-level share operations ---

async function createGitShare(owner: string, repo: string, notePath: string): Promise<GitShareLink> {
  const token = await ensureFreshAccessToken();
  if (!token) throw new Error('Not authenticated — sign in to share notes.');

  // Ensure .shares/.repo-id exists in the repo and is registered with the backend
  const repoId = await ensureRepoId(token, owner, repo);
  await registerRepoId(repoId, owner, repo);

  // Commit a new share file for this note
  const shareId = generateShareId();
  await putRepoFile(token, owner, repo, `.shares/${shareId}`, notePath, `share: ${notePath}`);

  // Cache locally and return the opaque URL
  setCachedShare(owner, repo, repoId, notePath, shareId);
  const url = `${window.location.origin}/s/${computeOpaqueSegment(repoId, shareId)}`;
  return { shareId, url };
}

async function revokeGitShare(
  owner: string,
  repo: string,
  notePath: string,
  shareId: string
): Promise<void> {
  const token = await ensureFreshAccessToken();
  if (!token) throw new Error('Not authenticated.');

  // Read the share file to get its SHA — required by the GitHub delete API
  const file = await readRepoFile(token, owner, repo, `.shares/${shareId}`);
  if (file) {
    await deleteRepoFile(
      token,
      owner,
      repo,
      `.shares/${shareId}`,
      file.sha,
      `share: revoke ${notePath}`
    );
  }
  deleteCachedShare(owner, repo, notePath);
}
