// Git sync helpers backed by GitHub's REST v3 API.
// Uses a stored OAuth token to read and write note files in a repository.

import { getStoredToken } from '../auth/github';
import type { NoteDoc, NoteMeta } from '../storage/local';
import type { LocalStore } from '../storage/local';
import { listTombstones, type Tombstone, removeTombstones, findByPath, markSynced, updateNoteText, moveNotePath } from '../storage/local';
import { mergeMarkdown } from '../merge/merge';

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
  const raw = localStorage.getItem('vibenote:config');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RemoteConfig;
  } catch {
    return null;
  }
}

export function configureRemote(cfg: RemoteConfig) {
  remote = cfg;
  localStorage.setItem('vibenote:config', JSON.stringify(cfg));
}

export function getRemoteConfig(): RemoteConfig | null {
  return remote ?? loadConfig();
}

export function clearRemoteConfig() {
  remote = null;
  localStorage.removeItem('vibenote:config');
}

export async function repoExists(owner: string, repo: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: authHeaders(),
  });
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
  const url = `https://api.github.com/repos/${remote.owner}/${remote.repo}/contents/${encodeApiPath(
    path
  )}?ref=${encodeURIComponent(remote.branch)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to fetch note');
  const data = await res.json();
  const content = fromBase64((data.content as string).replace(/\n/g, ''));
  return { path, text: content, sha: data.sha };
}

export type SyncSummary = {
  pulled: number;
  pushed: number;
  deletedRemote: number;
  deletedLocal: number;
  merged: number;
};

// Fetch raw blob content by SHA
export async function fetchBlob(sha: string): Promise<string | null> {
  if (!remote) return null;
  const url = `https://api.github.com/repos/${remote.owner}/${remote.repo}/git/blobs/${encodeURIComponent(sha)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) return null;
  const data = await res.json();
  const content = fromBase64((data.content as string).replace(/\n/g, ''));
  return content;
}

// Upsert a single file and return its new content sha
export async function putFile(
  file: { path: string; text: string; baseSha?: string },
  message: string
): Promise<string> {
  if (!remote) throw new Error('No remote');
  const url = `https://api.github.com/repos/${remote.owner}/${remote.repo}/contents/${encodeApiPath(file.path)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ message, content: toBase64(file.text), sha: file.baseSha, branch: remote.branch }),
  });
  if (!res.ok) throw new Error('Commit failed');
  const data = await res.json();
  const contentSha: string | undefined = data.content?.sha;
  if (!contentSha) throw new Error('Missing content sha');
  return contentSha;
}

export async function commitBatch(
  files: { path: string; text: string; baseSha?: string }[],
  message: string
): Promise<string | null> {
  if (!remote || files.length === 0) return null;
  let commitSha: string | null = null;
  for (const f of files) {
    const url = `https://api.github.com/repos/${remote.owner}/${
      remote.repo
    }/contents/${encodeApiPath(f.path)}`;
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
  const url = `${base}${dir ? '/' + encodeApiPath(dir) : ''}?ref=${encodeURIComponent(
    remote.branch
  )}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error('Failed to list notes directory');
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data
    .filter((e: any) => {
      if (e.type !== 'file' || typeof e.path !== 'string') return false;
      const name: string = e.name || '';
      if (!/\.md$/i.test(name)) return false;
      if (name.toLowerCase() === 'readme.md') return false; // not a note
      return true;
    })
    .map((e: any) => ({ path: e.path as string, sha: e.sha as string }));
}

// --- base64 helpers that safely handle UTF-8 ---
function toBase64(input: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(input);
  let binary = '';
  for (let byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function deleteFiles(
  files: { path: string; sha: string }[],
  message: string
): Promise<string | null> {
  if (!remote || files.length === 0) return null;
  let commitSha: string | null = null;
  for (const f of files) {
    const url = `https://api.github.com/repos/${remote.owner}/${
      remote.repo
    }/contents/${encodeApiPath(f.path)}`;
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

export async function ensureRepoExists(
  owner: string,
  repo: string,
  isPrivate = true
): Promise<boolean> {
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

function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);
  return (h >>> 0).toString(16);
}

export async function syncBidirectional(store: LocalStore): Promise<SyncSummary> {
  let pulled = 0;
  let pushed = 0;
  let deletedRemote = 0;
  let deletedLocal = 0;
  let merged = 0;

  const entries = await listNoteFiles();
  const remoteMap = new Map<string, string>(entries.map((e) => [e.path, e.sha] as const));
  const pending = listTombstones();
  const renameSources = new Set(pending.filter((t) => t.type === 'rename').map((t) => t.from));
  const deleteSources = new Set(pending.filter((t) => t.type === 'delete').map((t) => t.path));

  // Process remote files: pull new or changed, merge when both changed
  for (const e of entries) {
    const local = findByPath(e.path);
    if (!local) {
      if (renameSources.has(e.path) || deleteSources.has(e.path)) continue;
      // New remote file → pull
      const rf = await pullNote(e.path);
      if (!rf) continue;
      // Create local note using the store so index stays consistent
      const title = e.path.slice(e.path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
      const id = store.createNote(title, rf.text);
      // Mark sync metadata
      markSynced(id, { remoteSha: rf.sha, syncedHash: hashText(rf.text) });
      pulled++;
      continue;
    }
    const { id, doc } = local;
    const lastRemoteSha = doc.lastRemoteSha;
    if (e.sha === lastRemoteSha) {
      // Remote unchanged since base
      const changedLocally = doc.lastSyncedHash !== hashText(doc.text || '');
      if (changedLocally) {
        const newSha = await putFile({ path: doc.path, text: doc.text, baseSha: e.sha }, 'vibenote: update notes');
        markSynced(id, { remoteSha: newSha, syncedHash: hashText(doc.text || '') });
        pushed++;
      }
    } else {
      // Remote changed; fetch remote content
      const rf = await pullNote(e.path);
      if (!rf) continue;
      const base = lastRemoteSha ? await fetchBlob(lastRemoteSha) : '';
      const localText = doc.text || '';
      if (doc.lastSyncedHash !== hashText(localText)) {
        // both changed → merge
        const mergedText = mergeMarkdown(base ?? '', localText, rf.text);
        if (mergedText !== localText) {
          updateNoteText(id, mergedText);
        }
        const newSha = await putFile({ path: doc.path, text: mergedText, baseSha: rf.sha }, 'vibenote: merge notes');
        markSynced(id, { remoteSha: newSha, syncedHash: hashText(mergedText) });
        merged++;
        pushed++;
      } else {
        // only remote changed → pull
        updateNoteText(id, rf.text);
        markSynced(id, { remoteSha: rf.sha, syncedHash: hashText(rf.text) });
        pulled++;
      }
    }
  }

  // Handle remote deletions
  // For any local note missing on remote
  const localNotes = store.listNotes();
  for (const meta of localNotes) {
    if (!remoteMap.has(meta.path)) {
      const local = findByPath(meta.path);
      if (!local) continue;
      const { id, doc } = local;
      const changedLocally = doc.lastSyncedHash !== hashText(doc.text || '');
      if (changedLocally) {
        // Restore to remote
        const newSha = await putFile({ path: doc.path, text: doc.text }, 'vibenote: restore note');
        markSynced(id, { remoteSha: newSha, syncedHash: hashText(doc.text || '') });
        pushed++;
      } else {
        // Delete locally (will record a tombstone, which we clear below)
        store.deleteNote(id);
        deletedLocal++;
      }
    }
  }

  // Process tombstones (deletes and renames)
  const tombs = listTombstones();
  for (const t of tombs) {
    if (t.type === 'delete') {
      const sha = remoteMap.get(t.path);
      if (!sha) {
        // already gone remotely
        removeTombstones((x) => x.type === 'delete' && x.path === t.path && x.deletedAt === t.deletedAt);
        continue;
      }
      if (!t.lastRemoteSha || t.lastRemoteSha === sha) {
        // safe to delete remotely
        await deleteFiles([{ path: t.path, sha }], 'vibenote: delete removed notes');
        deletedRemote++;
        removeTombstones((x) => x.type === 'delete' && x.path === t.path && x.deletedAt === t.deletedAt);
      } else {
        // remote changed since we deleted locally → keep remote (no action), clear tombstone
        removeTombstones((x) => x.type === 'delete' && x.path === t.path && x.deletedAt === t.deletedAt);
      }
    } else if (t.type === 'rename') {
      const remoteSha = remoteMap.get(t.from);
      if (!remoteSha && !t.lastRemoteSha) {
        // Nothing tracked for this rename: remote already missing
        removeTombstones((x) => x.type === 'rename' && x.from === t.from && x.to === t.to && x.renamedAt === t.renamedAt);
        continue;
      }
      let shaToDelete = remoteSha;
      if (!shaToDelete) {
        const remoteFile = await pullNote(t.from);
        if (!remoteFile) {
          removeTombstones((x) => x.type === 'rename' && x.from === t.from && x.to === t.to && x.renamedAt === t.renamedAt);
          continue;
        }
        shaToDelete = remoteFile.sha;
        remoteMap.set(t.from, shaToDelete);
      }
      if (!t.lastRemoteSha || t.lastRemoteSha === shaToDelete) {
        await deleteFiles([{ path: t.from, sha: shaToDelete }], 'vibenote: delete old path after rename');
        deletedRemote++;
        remoteMap.delete(t.from);
        removeTombstones((x) => x.type === 'rename' && x.from === t.from && x.to === t.to && x.renamedAt === t.renamedAt);
        continue;
      }

      const existing = findByPath(t.from);
      const remoteFile = await pullNote(t.from);
      if (remoteFile) {
        if (existing) {
          if ((existing.doc.text || '') !== remoteFile.text) {
            updateNoteText(existing.id, remoteFile.text);
          }
          markSynced(existing.id, { remoteSha: remoteFile.sha, syncedHash: hashText(remoteFile.text) });
        } else {
          const title = basename(t.from).replace(/\.md$/i, '');
          const newId = store.createNote(title, remoteFile.text);
          moveNotePath(newId, t.from);
          markSynced(newId, { remoteSha: remoteFile.sha, syncedHash: hashText(remoteFile.text) });
          pulled++;
        }
      }
      removeTombstones((x) => x.type === 'rename' && x.from === t.from && x.to === t.to && x.renamedAt === t.renamedAt);
    }
  }

  return { pulled, pushed, deletedRemote, deletedLocal, merged };
}

function basename(p: string) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}
