// Git-native share operations — create, revoke, and look up shares stored as
// plain-text files in .shares/ within the repo.
//
// .shares/.repo-id  →  random 11-char base64url string (one per repo)
// .shares/<shareId> →  note path, e.g. "notes/foo.md"
//
// Opaque share URLs: <origin>/s/<segment>
//   segment = base64url(repoIdBytes[8] ∥ shareIdBytes[16]) = 32 chars
//
// Share files participate in the regular git sync (FileKind 'text'), so the
// local store is always up to date after a sync. lookupCachedShare is a pure
// in-memory scan — no network call needed.

import { ensureFreshAccessToken, getApiBase } from '../auth/app-auth';
import { normalizePath } from './util';
import { getRepoStore, markSynced, hashText } from '../storage/local';

export type { GitShareLink };
export { createGitShare, revokeGitShare, lookupCachedShare };

type GitShareLink = { shareId: string; url: string };

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

// --- Local store share lookup ---
// Scans .shares/ files in the local store (populated and kept fresh by the
// regular git sync) to find an existing share for a given note path.
// Entirely in-memory — no network call.

function lookupCachedShare(owner: string, repo: string, notePath: string): GitShareLink | null {
  const store = getRepoStore(`${owner}/${repo}`);
  const files = store.listFiles();
  const normalized = normalizePath(notePath);

  // Find .shares/.repo-id first — needed to compute the opaque URL.
  const repoIdMeta = files.find((f) => f.path === '.shares/.repo-id');
  if (!repoIdMeta) return null;
  const repoIdFile = store.loadFileById(repoIdMeta.id);
  if (!repoIdFile) return null;
  const repoId = repoIdFile.content.trim();

  // Find the share file whose content matches the note path.
  for (const meta of files) {
    if (!meta.path.startsWith('.shares/') || meta.path === '.shares/.repo-id') continue;
    const file = store.loadFileById(meta.id);
    if (!file) continue;
    if (normalizePath(file.content.trim()) !== normalized) continue;
    const shareId = meta.path.slice('.shares/'.length);
    const url = `${window.location.origin}/s/${computeOpaqueSegment(repoId, shareId)}`;
    return { shareId, url };
  }
  return null;
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
  const json = (await res.json()) as Record<string, unknown>;
  const sha = typeof json.sha === 'string' ? json.sha : '';
  const content = typeof json.content === 'string' ? json.content : '';
  return { text: base64ToText(content), sha };
}

// Returns the blob SHA of the newly created file.
async function putRepoFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  text: string,
  message: string
): Promise<string> {
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
  const json = (await res.json()) as Record<string, unknown>;
  // GitHub returns { content: { sha } } — the blob SHA of the created file
  const contentObj = json.content;
  const sha =
    contentObj &&
    typeof contentObj === 'object' &&
    typeof (contentObj as Record<string, unknown>).sha === 'string'
      ? ((contentObj as Record<string, unknown>).sha as string)
      : '';
  return sha;
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
// Read .shares/.repo-id from the local store (preferred, populated by sync) or
// directly from the GitHub API. If absent, generate and commit a fresh one.

async function ensureRepoId(token: string, owner: string, repo: string): Promise<string> {
  const slug = `${owner}/${repo}`;
  const store = getRepoStore(slug);

  // Fast path: already in local store from a previous sync or creation
  const localMeta = store.findMetaByPath('.shares/.repo-id');
  if (localMeta) {
    const local = store.loadFileById(localMeta.id);
    if (local?.content) return local.content.trim();
  }

  // Slow path: try to read from GitHub (another device may have committed it)
  const existing = await readRepoFile(token, owner, repo, '.shares/.repo-id');
  if (existing) {
    const repoId = existing.text.trim();
    // Add to local store so future lookups are instant
    const id = store.createFile('.shares/.repo-id', repoId, { kind: 'text' });
    markSynced(slug, id, { remoteSha: existing.sha, syncedHash: hashText(repoId) });
    return repoId;
  }

  // First share ever in this repo — generate, commit, and store locally
  const repoId = generateRepoId();
  const sha = await putRepoFile(token, owner, repo, '.shares/.repo-id', repoId, 'shares: initialize repo id');
  const id = store.createFile('.shares/.repo-id', repoId, { kind: 'text' });
  markSynced(slug, id, { remoteSha: sha, syncedHash: hashText(repoId) });
  return repoId;
}

// --- High-level share operations ---

async function createGitShare(owner: string, repo: string, notePath: string): Promise<GitShareLink> {
  const token = await ensureFreshAccessToken();
  if (!token) throw new Error('Not authenticated — sign in to share notes.');
  const slug = `${owner}/${repo}`;

  // Ensure .shares/.repo-id exists in the repo and is registered with the backend
  const repoId = await ensureRepoId(token, owner, repo);
  await registerRepoId(repoId, owner, repo);

  // Commit a new share file and mirror it to the local store immediately
  const shareId = generateShareId();
  const sha = await putRepoFile(token, owner, repo, `.shares/${shareId}`, notePath, `share: ${notePath}`);
  const store = getRepoStore(slug);
  const id = store.createFile(`.shares/${shareId}`, notePath, { kind: 'text' });
  markSynced(slug, id, { remoteSha: sha, syncedHash: hashText(notePath) });

  const url = `${window.location.origin}/s/${computeOpaqueSegment(repoId, shareId)}`;
  return { shareId, url };
}

async function revokeGitShare(owner: string, repo: string, notePath: string, shareId: string): Promise<void> {
  const token = await ensureFreshAccessToken();
  if (!token) throw new Error('Not authenticated.');

  // Read the share file to get its SHA — required by the GitHub delete API
  const file = await readRepoFile(token, owner, repo, `.shares/${shareId}`);
  if (file) {
    await deleteRepoFile(token, owner, repo, `.shares/${shareId}`, file.sha, `share: revoke ${notePath}`);
  }

  // Remove from local store — sync tombstone will be a no-op since the file
  // is already gone from GitHub (the sync handles missing remote gracefully).
  const store = getRepoStore(`${owner}/${repo}`);
  store.deleteFile(`.shares/${shareId}`);
}
