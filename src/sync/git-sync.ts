// Git sync helpers backed by GitHub's REST v3 API.
// Uses a stored OAuth token to read and write note files in a repository.

import { getStoredToken } from '../auth/github';

export interface RemoteConfig {
  owner: string;
  repo: string;
  branch: string;
  notesDir: string; // e.g., 'notes'
}

export interface RemoteFile {
  path: string;
  text: string;
  sha: string; // blob sha at HEAD
}

let remote: RemoteConfig | null = loadConfig();

function loadConfig(): RemoteConfig | null {
  const raw = localStorage.getItem('gitnote:config');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RemoteConfig;
  } catch {
    return null;
  }
}

export function configureRemote(cfg: RemoteConfig) {
  remote = cfg;
  localStorage.setItem('gitnote:config', JSON.stringify(cfg));
}

export function getRemoteConfig(): RemoteConfig | null {
  return remote ?? loadConfig();
}

export function clearRemoteConfig() {
  remote = null;
  localStorage.removeItem('gitnote:config');
}

export async function repoExists(owner: string, repo: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: authHeaders() });
  return res.ok;
}

function authHeaders() {
  const token = getStoredToken();
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
  };
}

function encodeApiPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export async function pullNote(path: string): Promise<RemoteFile | null> {
  if (!remote) return null;
  const url = `https://api.github.com/repos/${remote.owner}/${remote.repo}/contents/${encodeApiPath(path)}?ref=${encodeURIComponent(remote.branch)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to fetch note');
  const data = await res.json();
  const content = fromBase64((data.content as string).replace(/\n/g, ''));
  return { path, text: content, sha: data.sha };
}

export async function commitBatch(
  files: { path: string; text: string; baseSha?: string }[],
  message: string
): Promise<string | null> {
  if (!remote || files.length === 0) return null;
  let commitSha: string | null = null;
  for (const f of files) {
    const url = `https://api.github.com/repos/${remote.owner}/${remote.repo}/contents/${encodeApiPath(f.path)}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        message,
        content: toBase64(f.text),
        sha: f.baseSha,
        branch: remote.branch,
      }),
    });
    if (!res.ok) throw new Error('Commit failed');
    const data = await res.json();
    commitSha = data.commit?.sha || commitSha;
  }
  return commitSha;
}

// List Markdown files under the configured notesDir at HEAD
export async function listNoteFiles(): Promise<{ path: string; sha: string }[]> {
  if (!remote) return [];
  const dir = (remote.notesDir || '').replace(/(^\/+|\/+?$)/g, '');
  const base = `https://api.github.com/repos/${remote.owner}/${remote.repo}/contents`;
  const url = `${base}${dir ? '/' + encodeApiPath(dir) : ''}?ref=${encodeURIComponent(remote.branch)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error('Failed to list notes directory');
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data
    .filter((e: any) => e.type === 'file' && typeof e.path === 'string' && /\.md$/i.test(e.name))
    .map((e: any) => ({ path: e.path as string, sha: e.sha as string }));
}

// --- base64 helpers that safely handle UTF-8 ---
function toBase64(input: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export async function deleteFiles(
  files: { path: string; sha: string }[],
  message: string
): Promise<string | null> {
  if (!remote || files.length === 0) return null;
  let commitSha: string | null = null;
  for (const f of files) {
    const url = `https://api.github.com/repos/${remote.owner}/${remote.repo}/contents/${encodeApiPath(f.path)}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        message,
        sha: f.sha,
        branch: remote.branch,
      }),
    });
    if (!res.ok) throw new Error('Delete failed');
    const data = await res.json();
    commitSha = data.commit?.sha || commitSha;
  }
  return commitSha;
}

function fromBase64(b64: string): string {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  const decoder = new TextDecoder();
  return decoder.decode(bytes);
}

export async function ensureRepoExists(owner: string, repo: string, isPrivate = true): Promise<boolean> {
  const token = getStoredToken();
  if (!token) return false;
  const exists = await repoExists(owner, repo);
  if (exists) return true;
  const res = await fetch(`https://api.github.com/user/repos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ name: repo, private: isPrivate, auto_init: true }),
  });
  return res.ok;
}
