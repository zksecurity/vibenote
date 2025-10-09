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
import type { LocalStore, FileKind } from '../storage/local';
import {
  listTombstones,
  removeTombstones,
  findFileByPath,
  findByPath,
  findByRemoteSha,
  findBySyncedHash,
  markSynced,
  updateNoteText,
  updateBinaryContent,
  moveNotePath,
  debugLog,
} from '../storage/local';
import { mergeMarkdown } from '../merge/merge';

export interface RemoteConfig {
  owner: string;
  repo: string;
  branch: string;
}

type CommitResponse = { commitSha: string; blobShas: Record<string, string> };

type PutFilePayload = {
  path: string;
  text?: string;
  binaryBase64?: string;
  baseSha?: string;
};

const GITHUB_API_BASE = 'https://api.github.com';
const MARKDOWN_MIME = 'text/markdown';
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};
const BINARY_EXTENSIONS = new Set<string>(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif']);

type RepoFileEntry = {
  path: string;
  sha: string;
  kind: FileKind;
  mime: string;
};

type RemoteFileData = RepoFileEntry & {
  text?: string;
  binaryBase64?: string;
};

export interface RemoteFile {
  path: string;
  text: string;
  sha: string;
}

export function buildRemoteConfig(slug: string, branch?: string): RemoteConfig {
  let [owner, repo] = slug.split('/', 2);
  if (!owner || !repo) throw Error('Invalid repository slug');
  return { owner, repo, branch: branch ?? 'main' };
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

export async function pullRepoFile(config: RemoteConfig, path: string): Promise<RemoteFileData | null> {
  const kind = fileKindFromPath(path);
  if (!kind) return null;
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
      let json = await res.json();
      let sha = String(json.sha || '');
      let contentB64 = normalizeBase64(String(json.content || ''));
      return deserializeRemoteFile(path, kind, sha, contentB64);
    }
    if (res.status !== 403 && res.status !== 404) {
      await throwGitHubError(res, resourcePath);
    }
  }
  try {
    let publicFile = await fetchPublicFile(config.owner, config.repo, path, branch);
    let contentB64 = normalizeBase64(publicFile.contentBase64 || '');
    return deserializeRemoteFile(path, kind, publicFile.sha, contentB64);
  } catch (pubErr: unknown) {
    if (pubErr instanceof PublicFetchError && pubErr.status === 404) return null;
    throw pubErr;
  }
}

export async function pullNote(config: RemoteConfig, path: string): Promise<RemoteFile | null> {
  let file = await pullRepoFile(config, path);
  if (!file || file.kind !== 'markdown') return null;
  return { path: file.path, text: file.text ?? '', sha: file.sha };
}

export type SyncSummary = {
  pulled: number;
  pushed: number;
  deletedRemote: number;
  deletedLocal: number;
  merged: number;
};

// Upsert a single file and return its new content sha
export async function putFile(config: RemoteConfig, file: PutFilePayload, message: string): Promise<string> {
  const hasText = file.text !== undefined;
  const contentBase64 = hasText ? toBase64(file.text ?? '') : normalizeBase64(file.binaryBase64 ?? '');
  let res = await commitChanges(config, message, [
    { path: file.path, contentBase64, encoding: hasText ? 'utf-8' : 'base64' },
  ]);
  return extractBlobSha(res, file.path) ?? res.commitSha;
}

export async function commitBatch(
  config: RemoteConfig,
  files: PutFilePayload[],
  message: string
): Promise<string | null> {
  if (files.length === 0) return null;
  let res = await commitChanges(
    config,
    message,
    files.map((f) => ({
      path: f.path,
      contentBase64: f.text !== undefined ? toBase64(f.text) : normalizeBase64(f.binaryBase64 ?? ''),
      encoding: f.text !== undefined ? 'utf-8' : 'base64',
    }))
  );
  // Return the first blob sha if available to align with caller expectations
  const firstPath = files[0]?.path;
  return firstPath ? extractBlobSha(res, firstPath) ?? res.commitSha : res.commitSha;
}

export async function listRepoFiles(config: RemoteConfig): Promise<RepoFileEntry[]> {
  const filterEntries = (entries: Array<{ path?: string; sha?: string; type?: string }>) => {
    const results: RepoFileEntry[] = [];
    for (const e of entries) {
      let type = e.type;
      let path = e.path;
      let sha = e.sha;
      if (type !== 'blob' || !path || !sha) continue;
      const kind = fileKindFromPath(path);
      if (!kind) continue;
      results.push({ path, sha, kind, mime: inferMimeFromPath(path) });
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
      let json = await res.json();
      let entries = Array.isArray(json?.tree) ? json.tree : [];
      return filterEntries(entries);
    }
    if (res.status !== 403 && res.status !== 404) {
      await throwGitHubError(res, treePath);
    }
  }
  let entries = await fetchPublicTree(config.owner, config.repo, branch);
  return filterEntries(entries.map((entry) => ({ path: entry.path, sha: entry.sha, type: 'blob' })));
}

// List Markdown files at HEAD (legacy helper used by read-only flows)
export async function listNoteFiles(config: RemoteConfig): Promise<{ path: string; sha: string }[]> {
  let files = await listRepoFiles(config);
  return files
    .filter((file) => file.kind === 'markdown')
    .map((file) => ({ path: file.path, sha: file.sha }));
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
  let json = await res.json();
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
  changes: Array<{ path: string; contentBase64?: string; encoding?: 'utf-8' | 'base64'; delete?: boolean }>
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
    let refJson = await refRes.json();
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
    let commitJson = await commitRes.json();
    baseTreeSha =
      commitJson && commitJson.tree && typeof commitJson.tree.sha === 'string'
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
    encoding?: 'utf-8' | 'base64';
  }> = [];
  let trackedPaths = new Set<string>();
  for (let change of changes) {
    if (change.delete) {
      treeItems.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    let normalized = normalizeBase64(change.contentBase64 ?? '');
    let encoding = change.encoding ?? 'utf-8';
    if (encoding === 'base64') {
      treeItems.push({ path: change.path, mode: '100644', type: 'blob', content: normalized, encoding: 'base64' });
    } else {
      let decoded = '';
      try {
        decoded = fromBase64(normalized);
      } catch (err) {
        console.warn('vibenote: failed to decode base64 content for', change.path, err);
      }
      treeItems.push({ path: change.path, mode: '100644', type: 'blob', content: decoded, encoding: 'utf-8' });
    }
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
  let treeJson = await treeRes.json();
  let blobShas: Record<string, string> = {};
  if (Array.isArray(treeJson?.tree)) {
    for (let entry of treeJson.tree) {
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
  let commitJson = await commitRes.json();
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

function deserializeRemoteFile(
  path: string,
  kind: FileKind,
  sha: string,
  contentBase64: string
): RemoteFileData {
  if (kind === 'markdown') {
    return {
      path,
      sha,
      kind,
      mime: MARKDOWN_MIME,
      text: fromBase64(contentBase64),
    };
  }
  return {
    path,
    sha,
    kind: 'binary',
    mime: inferMimeFromPath(path),
    binaryBase64: contentBase64,
  };
}

function normalizeBase64(content: string): string {
  return content.replace(/\s+/g, '');
}

function fileKindFromPath(path: string): FileKind | null {
  const idx = path.lastIndexOf('.');
  if (idx < 0 || idx === path.length - 1) return null;
  const ext = path
    .slice(idx + 1)
    .toLowerCase()
    .trim();
  if (ext === 'md') return 'markdown';
  if (BINARY_EXTENSIONS.has(ext)) return 'binary';
  return null;
}

function inferMimeFromPath(path: string): string {
  const kind = fileKindFromPath(path);
  if (kind === 'markdown') return MARKDOWN_MIME;
  const idx = path.lastIndexOf('.');
  if (idx < 0 || idx === path.length - 1) return 'application/octet-stream';
  const ext = path
    .slice(idx + 1)
    .toLowerCase()
    .trim();
  return IMAGE_MIME_BY_EXT[ext] ?? 'application/octet-stream';
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

  // TODO why does this not use a default branch??
  const config = buildRemoteConfig(slug);
  const storeSlug = store.slug;
  const entries = await listRepoFiles(config);
  const remoteMap = new Map<string, RepoFileEntry>();
  for (const entry of entries) remoteMap.set(entry.path, entry);
  const pending = listTombstones(storeSlug);
  const renameSources = new Set(pending.filter((t) => t.type === 'rename').map((t) => t.from));
  const deleteSources = new Set(pending.filter((t) => t.type === 'delete').map((t) => t.path));

  // Process remote files: pull new or changed, merge when both changed
  for (const entry of entries) {
    if (entry.kind === 'markdown') {
      let remoteFile: RemoteFile | null = null;
      let remoteTextHash: string | null = null;
      let local = findByPath(storeSlug, entry.path);

      if (!local) {
        let renamed = entry.sha ? findByRemoteSha(storeSlug, entry.sha) : null;
        if (!renamed) {
          remoteFile = await pullNote(config, entry.path);
          if (!remoteFile) continue;
          remoteTextHash = hashText(remoteFile.text || '');
          renamed = findBySyncedHash(storeSlug, remoteTextHash);
        }
        if (renamed && renamed.doc.path !== entry.path) {
          moveNotePath(storeSlug, renamed.id, entry.path);
          local = findByPath(storeSlug, entry.path);
        }
      }

      if (!local) {
        if (renameSources.has(entry.path) || deleteSources.has(entry.path)) continue;
        const rf = remoteFile ?? (await pullNote(config, entry.path));
        if (!rf) continue;
        remoteTextHash = remoteTextHash ?? hashText(rf.text || '');
        const title = entry.path.slice(entry.path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
        const dir = (() => {
          const i = entry.path.lastIndexOf('/');
          return i >= 0 ? entry.path.slice(0, i) : '';
        })();
        const id = store.createNote(title, rf.text, dir);
        markSynced(storeSlug, id, { remoteSha: rf.sha, syncedHash: remoteTextHash });
        remoteMap.set(entry.path, { path: entry.path, sha: rf.sha, kind: 'markdown', mime: MARKDOWN_MIME });
        pulled++;
        debugLog(slug, 'sync:pull:new', { path: entry.path });
        continue;
      }

      const { id, doc } = local;
      const lastRemoteSha = doc.lastRemoteSha;
      const localText = doc.content;
      const localHash = hashText(localText);

      if (entry.sha === lastRemoteSha) {
        const changedLocally = doc.lastSyncedHash !== localHash;
        if (changedLocally) {
          const newSha = await putFile(
            config,
            { path: doc.path, text: localText, baseSha: entry.sha },
            'vibenote: update notes'
          );
          markSynced(storeSlug, id, { remoteSha: newSha, syncedHash: localHash });
          remoteMap.set(doc.path, { path: doc.path, sha: newSha, kind: 'markdown', mime: MARKDOWN_MIME });
          pushed++;
          debugLog(slug, 'sync:push:unchanged-remote', { path: doc.path });
        }
        continue;
      }

      const rf = remoteFile ?? (await pullNote(config, entry.path));
      if (!rf) continue;
      const base = lastRemoteSha ? await fetchBlob(config, lastRemoteSha) : '';
      const remoteText = rf.text || '';
      const remoteHash = hashText(remoteText);

      if (remoteHash === localHash) {
        markSynced(storeSlug, id, { remoteSha: rf.sha, syncedHash: localHash });
        remoteMap.set(entry.path, { path: entry.path, sha: rf.sha, kind: 'markdown', mime: MARKDOWN_MIME });
        debugLog(slug, 'sync:remote-equal-local', { path: doc.path });
        continue;
      }

      const remoteMatchesBase = doc.lastSyncedHash !== undefined && remoteHash === doc.lastSyncedHash;
      const localChangedFromBase = doc.lastSyncedHash !== localHash;
      if (remoteMatchesBase && localChangedFromBase) {
        debugLog(slug, 'sync:push:rename-detected', {
          path: doc.path,
          remoteHash,
          baseHash: hashText(base ?? ''),
          localHash,
          lastRemoteSha,
          remoteSha: rf.sha,
        });
        const newSha = await putFile(
          config,
          { path: doc.path, text: localText, baseSha: entry.sha },
          'vibenote: update notes'
        );
        markSynced(storeSlug, id, { remoteSha: newSha, syncedHash: localHash });
        remoteMap.set(doc.path, { path: doc.path, sha: newSha, kind: 'markdown', mime: MARKDOWN_MIME });
        pushed++;
        debugLog(slug, 'sync:push:remote-rename-only', { path: doc.path });
        continue;
      }

      if (localChangedFromBase) {
        const mergedText = mergeMarkdown(base ?? '', localText, remoteText);
        if (mergedText !== localText) {
          updateNoteText(storeSlug, id, mergedText);
        }
        const newSha = await putFile(
          config,
          { path: doc.path, text: mergedText, baseSha: rf.sha },
          'vibenote: merge notes'
        );
        markSynced(storeSlug, id, { remoteSha: newSha, syncedHash: hashText(mergedText) });
        remoteMap.set(doc.path, { path: doc.path, sha: newSha, kind: 'markdown', mime: MARKDOWN_MIME });
        merged++;
        pushed++;
        debugLog(slug, 'sync:merge', { path: doc.path });
      } else {
        updateNoteText(storeSlug, id, remoteText);
        markSynced(storeSlug, id, { remoteSha: rf.sha, syncedHash: remoteHash });
        remoteMap.set(entry.path, { path: entry.path, sha: rf.sha, kind: 'markdown', mime: MARKDOWN_MIME });
        pulled++;
        debugLog(slug, 'sync:pull:remote-changed', { path: doc.path });
      }

      continue;
    }

    // Binary assets
    const localFile = findFileByPath(storeSlug, entry.path);
    if (!localFile) {
      if (renameSources.has(entry.path) || deleteSources.has(entry.path)) continue;
      const rf = await pullRepoFile(config, entry.path);
      if (!rf) continue;
      const id = store.createBinaryFile(rf.path, rf.binaryBase64 ?? '', rf.mime);
      markSynced(storeSlug, id, { remoteSha: rf.sha, syncedHash: hashText(rf.binaryBase64 ?? '') });
      remoteMap.set(entry.path, { path: entry.path, sha: rf.sha, kind: 'binary', mime: rf.mime });
      pulled++;
      debugLog(slug, 'sync:pull:new-binary', { path: entry.path });
      continue;
    }

    const { id, doc } = localFile;
    const lastRemoteSha = doc.lastRemoteSha;
    const localBinary = doc.content;
    const localHash = hashText(localBinary);

    if (entry.sha === lastRemoteSha) {
      const changedLocally = doc.lastSyncedHash !== localHash;
      if (changedLocally) {
        const newSha = await putFile(
          config,
          { path: doc.path, binaryBase64: localBinary },
          'vibenote: update assets'
        );
        markSynced(storeSlug, id, { remoteSha: newSha, syncedHash: hashText(localBinary) });
        remoteMap.set(doc.path, { path: doc.path, sha: newSha, kind: 'binary', mime: doc.mime ?? inferMimeFromPath(doc.path) });
        pushed++;
        debugLog(slug, 'sync:push:asset', { path: doc.path });
      }
      continue;
    }

    const rf = await pullRepoFile(config, entry.path);
    if (!rf) continue;
    const remoteBase64 = rf.binaryBase64 ?? '';
    const remoteHash = hashText(remoteBase64);
    if (remoteHash === localHash) {
      markSynced(storeSlug, id, { remoteSha: rf.sha, syncedHash: localHash });
      remoteMap.set(entry.path, { path: entry.path, sha: rf.sha, kind: 'binary', mime: rf.mime });
      debugLog(slug, 'sync:asset-remote-equal-local', { path: doc.path });
      continue;
    }

    if (doc.lastSyncedHash !== localHash) {
      const newSha = await putFile(
        config,
        { path: doc.path, binaryBase64: localBinary },
        'vibenote: update assets'
      );
      markSynced(storeSlug, id, { remoteSha: newSha, syncedHash: hashText(localBinary) });
      remoteMap.set(doc.path, { path: doc.path, sha: newSha, kind: 'binary', mime: doc.mime ?? inferMimeFromPath(doc.path) });
      pushed++;
      debugLog(slug, 'sync:asset-push', { path: doc.path });
    } else {
      updateBinaryContent(storeSlug, id, remoteBase64, rf.mime);
      markSynced(storeSlug, id, { remoteSha: rf.sha, syncedHash: remoteHash });
      remoteMap.set(entry.path, { path: entry.path, sha: rf.sha, kind: 'binary', mime: rf.mime });
      pulled++;
      debugLog(slug, 'sync:pull:asset-remote-changed', { path: doc.path });
    }
  }

  // Handle remote deletions
  // For any local note missing on remote
  const localFiles = store.listFiles();
  for (const meta of localFiles) {
    if (!remoteMap.has(meta.path)) {
      const local = findFileByPath(storeSlug, meta.path);
      if (!local) continue;
      const { id, doc } = local;
      let docKind: FileKind;
      let localText = '';
      let localBinary = '';
      let localHash = '';
      if (doc.kind === 'binary') {
        docKind = 'binary';
        localBinary = doc.content;
        localHash = hashText(localBinary);
      } else {
        docKind = 'markdown';
        localText = doc.content;
        localHash = hashText(localText);
      }
      const changedLocally = doc.lastSyncedHash !== localHash;
      if (changedLocally) {
        // Restore to remote
        if (docKind === 'binary') {
          const newSha = await putFile(
            config,
            { path: doc.path, binaryBase64: localBinary },
            'vibenote: restore file'
          );
          markSynced(storeSlug, id, { remoteSha: newSha, syncedHash: hashText(localBinary) });
          remoteMap.set(doc.path, {
            path: doc.path,
            sha: newSha,
            kind: 'binary',
            mime: doc.mime ?? inferMimeFromPath(doc.path),
          });
        } else {
          const newSha = await putFile(config, { path: doc.path, text: localText }, 'vibenote: restore note');
          markSynced(storeSlug, id, { remoteSha: newSha, syncedHash: hashText(localText) });
          remoteMap.set(doc.path, { path: doc.path, sha: newSha, kind: 'markdown', mime: MARKDOWN_MIME });
        }
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
      const entry = remoteMap.get(t.path);
      const sha = entry?.sha;
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
      const targetLocal = findFileByPath(storeSlug, t.to);
      const remoteTarget = remoteMap.get(t.to);
      if (targetLocal && !remoteTarget) {
        const { id, doc } = targetLocal;
        let nextSha: string;
        if (doc.kind === 'binary') {
          nextSha = await putFile(
            config,
            { path: doc.path, binaryBase64: doc.content },
            'vibenote: update assets'
          );
          markSynced(storeSlug, id, {
            remoteSha: nextSha,
            syncedHash: hashText(doc.content),
          });
          remoteMap.set(t.to, {
            path: t.to,
            sha: nextSha,
            kind: 'binary',
            mime: doc.mime ?? inferMimeFromPath(doc.path),
          });
        } else {
          nextSha = await putFile(config, { path: doc.path, text: doc.content }, 'vibenote: update notes');
          markSynced(storeSlug, id, { remoteSha: nextSha, syncedHash: hashText(doc.content) });
          remoteMap.set(t.to, { path: t.to, sha: nextSha, kind: 'markdown', mime: MARKDOWN_MIME });
        }
        pushed++;
        debugLog(slug, 'sync:tombstone:rename:ensure-target', { to: t.to });
      }

      const remoteEntry = remoteMap.get(t.from);
      let remoteSha = remoteEntry?.sha;
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
        const remoteFile = await pullRepoFile(config, t.from);
        if (!remoteFile) {
          removeTombstones(
            storeSlug,
            (x) => x.type === 'rename' && x.from === t.from && x.to === t.to && x.renamedAt === t.renamedAt
          );
          continue;
        }
        shaToDelete = remoteFile.sha;
        remoteMap.set(t.from, {
          path: remoteFile.path,
          sha: remoteFile.sha,
          kind: remoteFile.kind,
          mime: remoteFile.mime,
        });
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

      const existing = findFileByPath(storeSlug, t.from);
      const remoteFile = await pullRepoFile(config, t.from);
      if (remoteFile) {
        if (existing) {
          if (existing.doc.kind === 'binary') {
            updateBinaryContent(storeSlug, existing.id, remoteFile.binaryBase64 ?? '', remoteFile.mime);
            markSynced(storeSlug, existing.id, {
              remoteSha: remoteFile.sha,
              syncedHash: hashText(remoteFile.binaryBase64 ?? ''),
            });
          } else {
            if (existing.doc.content !== (remoteFile.text ?? '')) {
              updateNoteText(storeSlug, existing.id, remoteFile.text ?? '');
            }
            markSynced(storeSlug, existing.id, {
              remoteSha: remoteFile.sha,
              syncedHash: hashText(remoteFile.text ?? ''),
            });
          }
          remoteMap.set(remoteFile.path, {
            path: remoteFile.path,
            sha: remoteFile.sha,
            kind: remoteFile.kind,
            mime: remoteFile.mime,
          });
        } else {
          if (remoteFile.kind === 'binary') {
            const newId = store.createBinaryFile(remoteFile.path, remoteFile.binaryBase64 ?? '', remoteFile.mime);
            markSynced(storeSlug, newId, {
              remoteSha: remoteFile.sha,
              syncedHash: hashText(remoteFile.binaryBase64 ?? ''),
            });
            pulled++;
            debugLog(slug, 'sync:tombstone:rename:recreate-local-binary', { from: t.from });
          } else {
            const title = basename(t.from).replace(/\.md$/i, '');
            const dir = t.from.includes('/') ? t.from.slice(0, t.from.lastIndexOf('/')) : '';
            const newId = store.createNote(title, remoteFile.text ?? '', dir);
            moveNotePath(storeSlug, newId, t.from);
            markSynced(storeSlug, newId, {
              remoteSha: remoteFile.sha,
              syncedHash: hashText(remoteFile.text ?? ''),
            });
            pulled++;
            debugLog(slug, 'sync:tombstone:rename:recreate-local', { from: t.from });
          }
          remoteMap.set(remoteFile.path, {
            path: remoteFile.path,
            sha: remoteFile.sha,
            kind: remoteFile.kind,
            mime: remoteFile.mime,
          });
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
