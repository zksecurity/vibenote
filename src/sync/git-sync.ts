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

export function buildRemoteConfig(slug: string): RemoteConfig {
  const [owner, repo] = slug.split('/', 2);
  if (!owner || !repo) throw new Error('Invalid repository slug');
  return { owner, repo, branch: 'main', notesDir: '' };
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

export async function pullNote(config: RemoteConfig, path: string): Promise<RemoteFile | null> {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${encodeApiPath(
    path
  )}?ref=${encodeURIComponent(config.branch)}`;
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
export async function fetchBlob(config: RemoteConfig, sha: string): Promise<string | null> {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/git/blobs/${encodeURIComponent(sha)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) return null;
  const data = await res.json();
  const content = fromBase64((data.content as string).replace(/\n/g, ''));
  return content;
}

// Upsert a single file and return its new content sha
export async function putFile(
  config: RemoteConfig,
  file: { path: string; text: string; baseSha?: string },
  message: string
): Promise<string> {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${encodeApiPath(file.path)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ message, content: toBase64(file.text), sha: file.baseSha, branch: config.branch }),
  });
  if (!res.ok) throw new Error('Commit failed');
  const data = await res.json();
  const contentSha: string | undefined = data.content?.sha;
  if (!contentSha) throw new Error('Missing content sha');
  return contentSha;
}

export async function commitBatch(
  config: RemoteConfig,
  files: { path: string; text: string; baseSha?: string }[],
  message: string
): Promise<string | null> {
  if (files.length === 0) return null;
  let commitSha: string | null = null;
  for (const f of files) {
    const url = `https://api.github.com/repos/${config.owner}/${
      config.repo
    }/contents/${encodeApiPath(f.path)}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        message,
        content: toBase64(f.text),
        sha: f.baseSha,
        branch: config.branch,
      }),
    });
    if (!res.ok) throw new Error('Commit failed');
    const data = await res.json();
    commitSha = data.commit?.sha || commitSha;
  }
  return commitSha;
}

// List Markdown files under the configured notesDir at HEAD
export async function listNoteFiles(config: RemoteConfig): Promise<{ path: string; sha: string }[]> {
  const dir = (config.notesDir || '').replace(/(^\/+|\/+?$)/g, '');
  const base = `https://api.github.com/repos/${config.owner}/${config.repo}/contents`;
  const url = `${base}${dir ? '/' + encodeApiPath(dir) : ''}?ref=${encodeURIComponent(
    config.branch
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
  config: RemoteConfig,
  files: { path: string; sha: string }[],
  message: string
): Promise<string | null> {
  if (files.length === 0) return null;
  let commitSha: string | null = null;
  for (const f of files) {
    const url = `https://api.github.com/repos/${config.owner}/${
      config.repo
    }/contents/${encodeApiPath(f.path)}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        message,
        sha: f.sha,
        branch: config.branch,
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

export async function syncBidirectional(store: LocalStore, slug: string): Promise<SyncSummary> {
  let pulled = 0;
  let pushed = 0;
  let deletedRemote = 0;
  let deletedLocal = 0;
  let merged = 0;

  const config = buildRemoteConfig(slug);
  const storeSlug = store.getSlug();
  const entries = await listNoteFiles(config);
  const remoteMap = new Map<string, string>(entries.map((e) => [e.path, e.sha] as const));
  const pending = listTombstones(storeSlug);
  const renameSources = new Set(pending.filter((t) => t.type === 'rename').map((t) => t.from));
  const deleteSources = new Set(pending.filter((t) => t.type === 'delete').map((t) => t.path));

  // Process remote files: pull new or changed, merge when both changed
  for (const e of entries) {
    const local = findByPath(storeSlug, e.path);
    if (!local) {
      if (renameSources.has(e.path) || deleteSources.has(e.path)) continue;
      // New remote file → pull
      const rf = await pullNote(config, e.path);
      if (!rf) continue;
      // Create local note using the store so index stays consistent
      const title = e.path.slice(e.path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
      const id = store.createNote(title, rf.text);
      // Mark sync metadata
      markSynced(storeSlug, id, { remoteSha: rf.sha, syncedHash: hashText(rf.text) });
      pulled++;
      continue;
    }
    const { id, doc } = local;
    const lastRemoteSha = doc.lastRemoteSha;
    if (e.sha === lastRemoteSha) {
      // Remote unchanged since base
      const changedLocally = doc.lastSyncedHash !== hashText(doc.text || '');
      if (changedLocally) {
        const newSha = await putFile(config, { path: doc.path, text: doc.text, baseSha: e.sha }, 'vibenote: update notes');
        markSynced(storeSlug, id, { remoteSha: newSha, syncedHash: hashText(doc.text || '') });
        pushed++;
      }
    } else {
      // Remote changed; fetch remote content
      const rf = await pullNote(config, e.path);
      if (!rf) continue;
      const base = lastRemoteSha ? await fetchBlob(config, lastRemoteSha) : '';
      const localText = doc.text || '';
      if (doc.lastSyncedHash !== hashText(localText)) {
        // both changed → merge
        const mergedText = mergeMarkdown(base ?? '', localText, rf.text);
        if (mergedText !== localText) {
          updateNoteText(storeSlug, id, mergedText);
        }
        const newSha = await putFile(config, { path: doc.path, text: mergedText, baseSha: rf.sha }, 'vibenote: merge notes');
        markSynced(storeSlug, id, { remoteSha: newSha, syncedHash: hashText(mergedText) });
        merged++;
        pushed++;
      } else {
        // only remote changed → pull
        updateNoteText(storeSlug, id, rf.text);
        markSynced(storeSlug, id, { remoteSha: rf.sha, syncedHash: hashText(rf.text) });
        pulled++;
      }
    }
  }

  // Handle remote deletions
  // For any local note missing on remote
  const localNotes = store.listNotes();
  for (const meta of localNotes) {
    if (!remoteMap.has(meta.path)) {
      const local = findByPath(storeSlug, meta.path);
      if (!local) continue;
      const { id, doc } = local;
      const changedLocally = doc.lastSyncedHash !== hashText(doc.text || '');
      if (changedLocally) {
        // Restore to remote
        const newSha = await putFile(config, { path: doc.path, text: doc.text }, 'vibenote: restore note');
        markSynced(storeSlug, id, { remoteSha: newSha, syncedHash: hashText(doc.text || '') });
        pushed++;
      } else {
        // Delete locally (will record a tombstone, which we clear below)
        store.deleteNote(id);
        deletedLocal++;
      }
    }
  }

  // Process tombstones (deletes and renames)
  const tombs = listTombstones(storeSlug);
  for (const t of tombs) {
    if (t.type === 'delete') {
      const sha = remoteMap.get(t.path);
      if (!sha) {
        // already gone remotely
        removeTombstones(storeSlug, (x) => x.type === 'delete' && x.path === t.path && x.deletedAt === t.deletedAt);
        continue;
      }
      if (!t.lastRemoteSha || t.lastRemoteSha === sha) {
        // safe to delete remotely
        await deleteFiles(config, [{ path: t.path, sha }], 'vibenote: delete removed notes');
        deletedRemote++;
        removeTombstones(storeSlug, (x) => x.type === 'delete' && x.path === t.path && x.deletedAt === t.deletedAt);
      } else {
        // remote changed since we deleted locally → keep remote (no action), clear tombstone
        removeTombstones(storeSlug, (x) => x.type === 'delete' && x.path === t.path && x.deletedAt === t.deletedAt);
      }
    } else if (t.type === 'rename') {
      const remoteSha = remoteMap.get(t.from);
      if (!remoteSha && !t.lastRemoteSha) {
        // Nothing tracked for this rename: remote already missing
        removeTombstones(storeSlug, (x) => x.type === 'rename' && x.from === t.from && x.to === t.to && x.renamedAt === t.renamedAt);
        continue;
      }
      let shaToDelete = remoteSha;
      if (!shaToDelete) {
        const remoteFile = await pullNote(config, t.from);
        if (!remoteFile) {
          removeTombstones(storeSlug, (x) => x.type === 'rename' && x.from === t.from && x.to === t.to && x.renamedAt === t.renamedAt);
          continue;
        }
        shaToDelete = remoteFile.sha;
        remoteMap.set(t.from, shaToDelete);
      }
      if (!t.lastRemoteSha || t.lastRemoteSha === shaToDelete) {
        await deleteFiles(config, [{ path: t.from, sha: shaToDelete }], 'vibenote: delete old path after rename');
        deletedRemote++;
        remoteMap.delete(t.from);
        removeTombstones(storeSlug, (x) => x.type === 'rename' && x.from === t.from && x.to === t.to && x.renamedAt === t.renamedAt);
        continue;
      }

      const existing = findByPath(storeSlug, t.from);
      const remoteFile = await pullNote(config, t.from);
      if (remoteFile) {
        if (existing) {
          if ((existing.doc.text || '') !== remoteFile.text) {
            updateNoteText(storeSlug, existing.id, remoteFile.text);
          }
          markSynced(storeSlug, existing.id, { remoteSha: remoteFile.sha, syncedHash: hashText(remoteFile.text) });
        } else {
          const title = basename(t.from).replace(/\.md$/i, '');
          const newId = store.createNote(title, remoteFile.text);
          moveNotePath(storeSlug, newId, t.from);
          markSynced(storeSlug, newId, { remoteSha: remoteFile.sha, syncedHash: hashText(remoteFile.text) });
          pulled++;
        }
      }
      removeTombstones(storeSlug, (x) => x.type === 'rename' && x.from === t.from && x.to === t.to && x.renamedAt === t.renamedAt);
    }
  }

  return { pulled, pushed, deletedRemote, deletedLocal, merged };
}

function basename(p: string) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}
