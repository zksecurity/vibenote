// Git sync helpers backed by GitHub's REST v3 API.
// Uses the GitHub REST v3 API directly with user-scoped access tokens.

import { ensureFreshAccessToken } from '../auth/app-auth';
import { getRepoMetadata } from '../lib/backend';
import {
  fetchPublicFile,
  fetchPublicTree,
  fetchPublicRepoInfo,
  PublicFetchError,
} from '../lib/github-public';
import type { LocalStore } from '../storage/local';
import {
  listTombstones,
  removeTombstones,
  findByPath,
  markSynced,
  updateNoteText,
  moveNotePath,
  debugLog,
} from '../storage/local';
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

type CommitResponse = { commitSha: string; blobShas: Record<string, string> };

const GITHUB_API_BASE = 'https://api.github.com';

export function buildRemoteConfig(slug: string): RemoteConfig {
  const [owner, repo] = slug.split('/', 2);
  if (!owner || !repo) throw new Error('Invalid repository slug');
  return { owner, repo, branch: 'main', notesDir: '' };
}

export async function repoExists(owner: string, repo: string): Promise<boolean> {
  try {
    let meta = await getRepoMetadata(owner, repo);
    if (meta.installed) return true;
    if (meta.isPrivate === false) return true;
    if (meta.isPrivate === true) return false;
  } catch {
    // ignore and fall through to public fetch
  }
  try {
    const info = await fetchPublicRepoInfo(owner, repo);
    return info.ok && info.isPrivate === false;
  } catch {
    return false;
  }
}

export async function pullNote(config: RemoteConfig, path: string): Promise<RemoteFile | null> {
  let branch = config.branch || 'main';
  let token = await ensureFreshAccessToken();
  if (token) {
    let resourcePath = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
      config.repo
    )}/contents/${encodePath(path)}`;
    if (branch) {
      resourcePath = `${resourcePath}?ref=${encodeURIComponent(branch)}`;
    }
    let res = await githubRequest(token, 'GET', resourcePath);
    if (res.ok) {
      let json = (await res.json()) as any;
      let content = fromBase64(String(json.content || '').replace(/\n/g, ''));
      return { path, text: content, sha: String(json.sha || '') };
    }
    if (res.status !== 403 && res.status !== 404) {
      await throwGitHubError(res, resourcePath);
    }
  }
  try {
    let publicFile = await fetchPublicFile(config.owner, config.repo, path, branch);
    let content = fromBase64((publicFile.contentBase64 || '').replace(/\n/g, ''));
    return { path, text: content, sha: publicFile.sha };
  } catch (pubErr: unknown) {
    if (pubErr instanceof PublicFetchError && pubErr.status === 404) return null;
    throw pubErr;
  }
}

export type SyncSummary = {
  pulled: number;
  pushed: number;
  deletedRemote: number;
  deletedLocal: number;
  merged: number;
};

// Upsert a single file and return its new content sha
export async function putFile(
  config: RemoteConfig,
  file: { path: string; text: string; baseSha?: string },
  message: string
): Promise<string> {
  let res = await commitChanges(config, message, [
    { path: file.path, contentBase64: toBase64(file.text) },
  ]);
  return extractBlobSha(res, file.path) ?? res.commitSha;
}

export async function commitBatch(
  config: RemoteConfig,
  files: { path: string; text: string; baseSha?: string }[],
  message: string
): Promise<string | null> {
  if (files.length === 0) return null;
  let res = await commitChanges(
    config,
    message,
    files.map((f) => ({ path: f.path, contentBase64: toBase64(f.text) }))
  );
  // Return the first blob sha if available to align with caller expectations
  const firstPath = files[0]?.path;
  return firstPath ? extractBlobSha(res, firstPath) ?? res.commitSha : res.commitSha;
}

// List Markdown files under the configured notesDir at HEAD
export async function listNoteFiles(config: RemoteConfig): Promise<{ path: string; sha: string }[]> {
  const rootDir = (config.notesDir || '').replace(/(^\/+|\/+?$)/g, '');
  const filterEntries = (entries: Array<{ path?: string; sha?: string; type?: string }>) => {
    const results: { path: string; sha: string }[] = [];
    for (const e of entries) {
      const type = e.type;
      const path = e.path;
      const sha = e.sha;
      if (type !== 'blob' || !path || !sha) continue;
      if (rootDir && !path.startsWith(rootDir + '/')) continue;
      if (!/\.md$/i.test(path)) continue;
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (!rootDir && name.toLowerCase() === 'readme.md') continue;
      results.push({ path, sha });
    }
    return results;
  };

  let branch = config.branch || 'main';
  let token = await ensureFreshAccessToken();
  if (token) {
    let treePath = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
      config.repo
    )}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
    let res = await githubRequest(token, 'GET', treePath);
    if (res.ok) {
      let json = (await res.json()) as any;
      let entries = Array.isArray(json?.tree) ? (json.tree as Array<any>) : [];
      return filterEntries(entries);
    }
    if (res.status !== 403 && res.status !== 404) {
      await throwGitHubError(res, treePath);
    }
  }
  let entries = await fetchPublicTree(config.owner, config.repo, branch);
  return filterEntries(entries.map((entry) => ({ path: entry.path, sha: entry.sha, type: 'blob' })));
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
  let res = await commitChanges(
    config,
    message,
    files.map((f) => ({ path: f.path, delete: true }))
  );
  return res.commitSha || null;
}

function fromBase64(b64: string): string {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  const decoder = new TextDecoder();
  return decoder.decode(bytes);
}

// Fetch raw blob content by SHA using backend (requires installation for the repo)
export async function fetchBlob(config: RemoteConfig, sha: string): Promise<string | null> {
  let token = await ensureFreshAccessToken();
  if (!token) return '';
  let blobPath = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
    config.repo
  )}/git/blobs/${encodeURIComponent(sha)}`;
  let res = await githubRequest(token, 'GET', blobPath);
  if (!res.ok) {
    return '';
  }
  let json = (await res.json()) as any;
  return fromBase64(String(json.content || '').replace(/\n/g, ''));
}

function extractBlobSha(res: CommitResponse, path: string): string | undefined {
  const map = res.blobShas;
  if (!map) return undefined;
  if (path in map) return map[path];
  // Git stores paths exactly as provided; attempt normalized
  const alt = path.replace(/^\.\//, '');
  if (alt in map) return map[alt];
  return undefined;
}

async function commitChanges(
  config: RemoteConfig,
  message: string,
  changes: Array<{ path: string; contentBase64?: string; delete?: boolean }>
): Promise<CommitResponse> {
  let token = await requireAccessToken();
  if (changes.length === 0) {
    return { commitSha: '', blobShas: {} };
  }
  let ownerEncoded = encodeURIComponent(config.owner);
  let repoEncoded = encodeURIComponent(config.repo);
  let branch = config.branch ? config.branch.trim() : '';
  if (!branch) branch = 'main';
  let refPath = `/repos/${ownerEncoded}/${repoEncoded}/git/ref/heads/${encodeURIComponent(branch)}`;

  let headSha: string | null = null;
  let baseTreeSha: string | null = null;
  let isInitialCommit = false;

  let refRes = await githubRequest(token, 'GET', refPath);
  if (refRes.ok) {
    let refJson = (await refRes.json()) as any;
    let refObject = refJson && typeof refJson.object === 'object' ? refJson.object : null;
    if (!refObject || typeof refObject.sha !== 'string') {
      throw new Error('Unexpected ref payload from GitHub');
    }
    headSha = String(refObject.sha);
    let commitRes = await githubRequest(
      token,
      'GET',
      `/repos/${ownerEncoded}/${repoEncoded}/git/commits/${encodeURIComponent(headSha)}`
    );
    if (!commitRes.ok) {
      await throwGitHubError(commitRes, `/repos/${config.owner}/${config.repo}/git/commits/${headSha}`);
    }
    let commitJson = (await commitRes.json()) as any;
    baseTreeSha = commitJson && commitJson.tree && typeof commitJson.tree.sha === 'string'
      ? String(commitJson.tree.sha)
      : null;
  } else if (refRes.status === 404) {
    isInitialCommit = true;
  } else {
    await throwGitHubError(refRes, refPath);
  }

  let treeItems: Array<{
    path?: string;
    mode?: '100644' | '100755' | '040000' | '160000' | '120000';
    type?: 'blob' | 'tree' | 'commit';
    sha?: string | null;
    content?: string;
    encoding?: 'utf-8';
  }> = [];
  let trackedPaths = new Set<string>();
  for (let change of changes) {
    if (change.delete) {
      treeItems.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    let contentBase64 = change.contentBase64 ?? '';
    let normalized = contentBase64.replace(/\n/g, '');
    let decoded = '';
    try {
      decoded = fromBase64(normalized);
    } catch (err) {
      console.warn('vibenote: failed to decode base64 content for', change.path, err);
    }
    treeItems.push({ path: change.path, mode: '100644', type: 'blob', content: decoded, encoding: 'utf-8' });
    trackedPaths.add(change.path);
  }

  let treePayload: {
    base_tree?: string;
    tree: typeof treeItems;
  } = {
    tree: treeItems,
  };
  if (baseTreeSha) treePayload.base_tree = baseTreeSha;

  let treePath = `/repos/${ownerEncoded}/${repoEncoded}/git/trees`;
  let treeRes = await githubRequest(token, 'POST', treePath, treePayload);
  if (!treeRes.ok) {
    await throwGitHubError(treeRes, treePath);
  }
  let treeJson = (await treeRes.json()) as any;
  let blobShas: Record<string, string> = {};
  if (Array.isArray(treeJson?.tree)) {
    for (let entry of treeJson.tree as Array<any>) {
      if (!entry || entry.type !== 'blob') continue;
      if (!entry.path || !entry.sha) continue;
      if (trackedPaths.has(String(entry.path))) {
        blobShas[String(entry.path)] = String(entry.sha);
      }
    }
  }

  let finalMessage = message && message.trim().length > 0 ? message.trim() : 'Update from VibeNote';
  let parents = isInitialCommit || !headSha ? [] : [headSha];
  let commitPayload = {
    message: finalMessage,
    tree: String(treeJson.sha || ''),
    parents,
  };
  let commitPath = `/repos/${ownerEncoded}/${repoEncoded}/git/commits`;
  let commitRes = await githubRequest(token, 'POST', commitPath, commitPayload);
  if (!commitRes.ok) {
    await throwGitHubError(commitRes, commitPath);
  }
  let commitJson = (await commitRes.json()) as any;
  let newCommitSha = String(commitJson.sha || '');

  if (isInitialCommit || !headSha) {
    let createRefPath = `/repos/${ownerEncoded}/${repoEncoded}/git/refs`;
    let createRes = await githubRequest(token, 'POST', createRefPath, {
      ref: `refs/heads/${branch}`,
      sha: newCommitSha,
    });
    if (!createRes.ok && createRes.status !== 422) {
      await throwGitHubError(createRes, createRefPath);
    }
  } else {
    let updateRefPath = `/repos/${ownerEncoded}/${repoEncoded}/git/refs/heads/${encodeURIComponent(branch)}`;
    let updateRes = await githubRequest(token, 'PATCH', updateRefPath, {
      sha: newCommitSha,
      force: false,
    });
    if (!updateRes.ok) {
      await throwGitHubError(updateRes, updateRefPath);
    }
  }

  return { commitSha: newCommitSha, blobShas };
}

async function requireAccessToken(): Promise<string> {
  let token = await ensureFreshAccessToken();
  if (!token) {
    throw new Error('GitHub authentication required');
  }
  return token;
}

async function githubRequest(
  token: string | null,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  let headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let init: RequestInit = {
    method,
    headers,
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return await fetch(`${GITHUB_API_BASE}${path}`, init);
}

async function throwGitHubError(res: Response, path: string): Promise<never> {
  let error: any = new Error(`GitHub request failed (${res.status})`);
  error.status = res.status;
  error.path = path;
  try {
    error.body = await res.json();
  } catch {
    try {
      error.text = await res.text();
    } catch {
      error.text = null;
    }
  }
  throw error;
}

function encodePath(input: string): string {
  return input
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
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
      const dir = (() => {
        const i = e.path.lastIndexOf('/');
        return i >= 0 ? e.path.slice(0, i) : '';
      })();
      const id = (store as any).createNote(title, rf.text, dir);
      // Mark sync metadata
      markSynced(storeSlug, id, { remoteSha: rf.sha, syncedHash: hashText(rf.text) });
      pulled++;
      debugLog(slug, 'sync:pull:new', { path: e.path });
      continue;
    }
    const { id, doc } = local;
    const lastRemoteSha = doc.lastRemoteSha;
    if (e.sha === lastRemoteSha) {
      // Remote unchanged since base
      const changedLocally = doc.lastSyncedHash !== hashText(doc.text || '');
      if (changedLocally) {
        const newSha = await putFile(
          config,
          { path: doc.path, text: doc.text, baseSha: e.sha },
          'vibenote: update notes'
        );
        markSynced(storeSlug, id, { remoteSha: newSha, syncedHash: hashText(doc.text || '') });
        pushed++;
        debugLog(slug, 'sync:push:unchanged-remote', { path: doc.path });
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
        const newSha = await putFile(
          config,
          { path: doc.path, text: mergedText, baseSha: rf.sha },
          'vibenote: merge notes'
        );
        markSynced(storeSlug, id, { remoteSha: newSha, syncedHash: hashText(mergedText) });
        merged++;
        pushed++;
        debugLog(slug, 'sync:merge', { path: doc.path });
      } else {
        // only remote changed → pull
        updateNoteText(storeSlug, id, rf.text);
        markSynced(storeSlug, id, { remoteSha: rf.sha, syncedHash: hashText(rf.text) });
        pulled++;
        debugLog(slug, 'sync:pull:remote-changed', { path: doc.path });
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
        debugLog(slug, 'sync:restore-remote-missing', { path: doc.path });
      } else {
        // Delete locally (will record a tombstone, which we clear below)
        store.deleteNote(id);
        deletedLocal++;
        debugLog(slug, 'sync:delete-local-remote-missing', { path: doc.path });
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
        removeTombstones(
          storeSlug,
          (x) => x.type === 'delete' && x.path === t.path && x.deletedAt === t.deletedAt
        );
        debugLog(slug, 'sync:tombstone:delete:remote-missing', { path: t.path });
        continue;
      }
      if (!t.lastRemoteSha || t.lastRemoteSha === sha) {
        // safe to delete remotely
        await deleteFiles(config, [{ path: t.path, sha }], 'vibenote: delete removed notes');
        deletedRemote++;
        removeTombstones(
          storeSlug,
          (x) => x.type === 'delete' && x.path === t.path && x.deletedAt === t.deletedAt
        );
        debugLog(slug, 'sync:tombstone:delete:remote-deleted', { path: t.path });
      } else {
        // remote changed since we deleted locally → keep remote (no action), clear tombstone
        removeTombstones(
          storeSlug,
          (x) => x.type === 'delete' && x.path === t.path && x.deletedAt === t.deletedAt
        );
        debugLog(slug, 'sync:tombstone:delete:remote-changed-keep-remote', { path: t.path });
      }
    } else if (t.type === 'rename') {
      const remoteSha = remoteMap.get(t.from);
      if (!remoteSha && !t.lastRemoteSha) {
        // Nothing tracked for this rename: remote already missing
        removeTombstones(
          storeSlug,
          (x) => x.type === 'rename' && x.from === t.from && x.to === t.to && x.renamedAt === t.renamedAt
        );
        debugLog(slug, 'sync:tombstone:rename:remote-missing', { from: t.from, to: t.to });
        continue;
      }
      let shaToDelete = remoteSha;
      if (!shaToDelete) {
        const remoteFile = await pullNote(config, t.from);
        if (!remoteFile) {
          removeTombstones(
            storeSlug,
            (x) => x.type === 'rename' && x.from === t.from && x.to === t.to && x.renamedAt === t.renamedAt
          );
          continue;
        }
        shaToDelete = remoteFile.sha;
        remoteMap.set(t.from, shaToDelete);
      }
      if (!t.lastRemoteSha || t.lastRemoteSha === shaToDelete) {
        await deleteFiles(
          config,
          [{ path: t.from, sha: shaToDelete }],
          'vibenote: delete old path after rename'
        );
        deletedRemote++;
        remoteMap.delete(t.from);
        removeTombstones(
          storeSlug,
          (x) => x.type === 'rename' && x.from === t.from && x.to === t.to && x.renamedAt === t.renamedAt
        );
        debugLog(slug, 'sync:tombstone:rename:remote-deleted', { from: t.from, to: t.to });
        continue;
      }

      const existing = findByPath(storeSlug, t.from);
      const remoteFile = await pullNote(config, t.from);
      if (remoteFile) {
        if (existing) {
          if ((existing.doc.text || '') !== remoteFile.text) {
            updateNoteText(storeSlug, existing.id, remoteFile.text);
          }
          markSynced(storeSlug, existing.id, {
            remoteSha: remoteFile.sha,
            syncedHash: hashText(remoteFile.text),
          });
        } else {
          const title = basename(t.from).replace(/\.md$/i, '');
          const dir = t.from.includes('/') ? t.from.slice(0, t.from.lastIndexOf('/')) : '';
          const newId = (store as any).createNote(title, remoteFile.text, dir);
          moveNotePath(storeSlug, newId, t.from);
          markSynced(storeSlug, newId, {
            remoteSha: remoteFile.sha,
            syncedHash: hashText(remoteFile.text),
          });
          pulled++;
          debugLog(slug, 'sync:tombstone:rename:recreate-local', { from: t.from });
        }
      }
      removeTombstones(
        storeSlug,
        (x) => x.type === 'rename' && x.from === t.from && x.to === t.to && x.renamedAt === t.renamedAt
      );
    }
  }

  const summary = { pulled, pushed, deletedRemote, deletedLocal, merged };
  return summary;
}

function basename(p: string) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}
