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
import type { LocalStore, FileKind, RepoFile } from '../storage/local';
import {
  listTombstones,
  removeTombstones,
  findFileByPath,
  findByRemoteSha,
  findBySyncedHash,
  markSynced,
  updateFile,
  moveFilePath,
  debugLog,
  computeSyncedHash,
} from '../storage/local';
import { mergeMarkdown } from '../merge/merge';

export type { RemoteConfig, RemoteFile };

type RemoteConfig = { owner: string; repo: string; branch: string };

type CommitResponse = { commitSha: string; blobShas: Record<string, string> };

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

type RepoFileEntry = { path: string; sha: string; kind: FileKind; mime: string };

type RemoteFile = RepoFileEntry & { content: string };

const BLOB_PLACEHOLDER_PREFIX = 'gh-blob:';

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

export async function pullRepoFile(config: RemoteConfig, path: string): Promise<RemoteFile | null> {
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
      let contentB64 = normalizeBase64(typeof json.content === 'string' ? json.content : '');
      const downloadUrl = typeof json.download_url === 'string' ? json.download_url : undefined;
      return await materializeRemoteFile({
        config,
        path,
        kind,
        sha,
        contentBase64: contentB64,
        downloadUrl,
      });
    }
    if (res.status !== 403 && res.status !== 404) {
      await throwGitHubError(res, resourcePath);
    }
  }
  try {
    let publicFile = await fetchPublicFile(config.owner, config.repo, path, branch);
    let contentB64 = normalizeBase64(publicFile.contentBase64 || '');
    return await materializeRemoteFile({
      config,
      path,
      kind,
      sha: publicFile.sha,
      contentBase64: contentB64,
      downloadUrl: publicFile.downloadUrl,
    });
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

type PutFilePayload = { path: string; content: string; kind: FileKind; baseSha?: string };

function serializeContent(file: { path: string; content: string; kind: FileKind }) {
  if (file.kind === 'asset-url') {
    throw new Error('asset-url files must be converted to binary content before upload');
  }
  return {
    path: file.path,
    contentBase64: file.kind === 'binary' ? normalizeBase64(file.content) : toBase64(file.content),
    encoding: file.kind === 'binary' ? ('base64' as const) : ('utf-8' as const),
  };
}

async function buildUploadPayload(
  config: RemoteConfig,
  doc: RepoFile,
  baseSha?: string
): Promise<PutFilePayload | null> {
  if (doc.kind === 'markdown') {
    return { path: doc.path, content: doc.content, kind: 'markdown', baseSha };
  }
  const binaryContent = await ensureBinaryContent(config, doc);
  if (!binaryContent) return null;
  return { path: doc.path, content: binaryContent, kind: 'binary', baseSha };
}

async function ensureBinaryContent(config: RemoteConfig, doc: RepoFile): Promise<string | null> {
  if (doc.kind === 'binary') return normalizeBase64(doc.content);
  if (doc.kind !== 'asset-url') return null;
  if (doc.lastRemoteSha) {
    const blob = await fetchBlob(config, doc.lastRemoteSha);
    if (blob) return normalizeBase64(blob);
  }
  if (!doc.content) return null;
  if (isBlobPlaceholder(doc.content)) return null;
  const fetched = await fetchUrlAsBase64(doc.content);
  return fetched ? normalizeBase64(fetched) : null;
}

// Upsert a single file and return its new content sha
export async function putFile(config: RemoteConfig, file: PutFilePayload, message: string): Promise<string> {
  let res = await commitChanges(config, message, [serializeContent(file)]);
  return extractBlobSha(res, file.path) ?? res.commitSha;
}

export async function commitBatch(
  config: RemoteConfig,
  files: PutFilePayload[],
  message: string
): Promise<string | null> {
  if (files.length === 0) return null;
  let res = await commitChanges(config, message, files.map(serializeContent));
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
      // file is filtered out, because it is not a supported file type
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

// Fetch raw blob content (base64) by SHA using backend (requires installation for the repo)
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
  return normalizeBase64(String(json.content || ''));
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
      treeItems.push({
        path: change.path,
        mode: '100644',
        type: 'blob',
        content: normalized,
        encoding: 'base64',
      });
    } else {
      let decoded = '';
      try {
        decoded = fromBase64(normalized);
      } catch (err) {
        console.warn('vibenote: failed to decode base64 content for', change.path, err);
      }
      treeItems.push({
        path: change.path,
        mode: '100644',
        type: 'blob',
        content: decoded,
        encoding: 'utf-8',
      });
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

async function materializeRemoteFile(input: {
  config: RemoteConfig;
  path: string;
  kind: 'markdown' | 'binary';
  sha: string;
  contentBase64: string;
  downloadUrl?: string | null;
}): Promise<RemoteFile> {
  let { config, path, kind, sha, contentBase64, downloadUrl } = input;
  if (kind === 'markdown') {
    let payload = contentBase64;
    if (payload === '') {
      const blob = await fetchBlob(config, sha);
      if (blob !== null) payload = blob;
    }
    return { path, sha, kind: 'markdown', mime: MARKDOWN_MIME, content: fromBase64(payload) };
  }
  if (kind === 'binary') {
    if (downloadUrl && isReusableDownloadUrl(downloadUrl)) {
      return { path, sha, kind: 'asset-url', mime: inferMimeFromPath(path), content: downloadUrl };
    }
    return {
      path,
      sha,
      kind: 'asset-url',
      mime: inferMimeFromPath(path),
      content: buildBlobPlaceholder(config, sha),
    };
  }
  kind satisfies never;
  throw Error('unexpected type');
}

function normalizeBase64(content: string): string {
  return content.replace(/\s+/g, '');
}

function isReusableDownloadUrl(url: string): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (trimmed === '') return false;
  const lower = trimmed.toLowerCase();
  return !/\b(token|access_token)=/.test(lower);
}

function buildBlobPlaceholder(config: RemoteConfig, sha: string): string {
  return `${BLOB_PLACEHOLDER_PREFIX}${config.owner}/${config.repo}#${sha}`;
}

function isBlobPlaceholder(content: string): boolean {
  return typeof content === 'string' && content.startsWith(BLOB_PLACEHOLDER_PREFIX);
}

async function fetchUrlAsBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    return arrayBufferToBase64(buffer);
  } catch {
    return null;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

function fileKindFromPath(path: string): 'markdown' | 'binary' | null {
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

function computeLocalHash(doc: RepoFile): string {
  if (doc.kind === 'asset-url') {
    return doc.lastSyncedHash ?? doc.lastRemoteSha ?? hashText(doc.content);
  }
  return hashText(doc.content);
}

function computeRemoteHash(file: RemoteFile): string {
  if (file.kind === 'asset-url') {
    return file.sha;
  }
  return hashText(file.content);
}

function computeBaseHash(kind: FileKind, baseContent: string, baseSha?: string | null): string {
  if (kind === 'asset-url') {
    return baseSha ?? hashText(baseContent);
  }
  return hashText(baseContent);
}

function syncedHashForDoc(doc: RepoFile, remoteSha?: string): string {
  return computeSyncedHash(doc.kind, doc.content, remoteSha ?? doc.lastRemoteSha);
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
  const remoteMap = new Map<string, string>(entries.map((e) => [e.path, e.sha] as const));
  const pending = listTombstones(storeSlug);
  const renameSources = new Set(pending.filter((t) => t.type === 'rename').map((t) => t.from));
  const deleteSources = new Set(pending.filter((t) => t.type === 'delete').map((t) => t.path));

  // Process remote files: pull new or changed, merge when both changed
  for (const e of entries) {
    let remoteFile: RemoteFile | null = null;
    let remoteContentHash: string | null = null;
    let local = findFileByPath(storeSlug, e.path);
    if (!local) {
      let renamed = e.sha ? findByRemoteSha(storeSlug, e.sha) : null;
      if (!renamed) {
        remoteFile = await pullRepoFile(config, e.path);
        if (!remoteFile) continue;
        remoteContentHash = computeRemoteHash(remoteFile);
        renamed = findBySyncedHash(storeSlug, remoteContentHash);
      }
      if (renamed && renamed.doc.path !== e.path) {
        moveFilePath(storeSlug, renamed.id, e.path);
        local = findFileByPath(storeSlug, e.path);
      }
    }
    if (!local) {
      if (renameSources.has(e.path) || deleteSources.has(e.path)) continue;
      // New remote file → pull
      const rf = remoteFile ?? (await pullRepoFile(config, e.path));
      if (!rf) continue;
      remoteFile = rf;
      remoteContentHash = remoteContentHash ?? computeRemoteHash(rf);
      // Create local note using the store so index stays consistent
      const id = store.createFile(e.path, rf.content, { kind: rf.kind, mime: rf.mime });
      // Mark sync metadata
      markSynced(storeSlug, id, { remoteSha: rf.sha, syncedHash: remoteContentHash });
      remoteMap.set(e.path, rf.sha);
      pulled++;
      debugLog(slug, 'sync:pull:new', { path: e.path });
      continue;
    }
    const { id, doc } = local;
    const lastRemoteSha = doc.lastRemoteSha;
    let localHash = computeLocalHash(doc);
    if (e.sha === lastRemoteSha) {
      // Remote unchanged since base
      const changedLocally = doc.lastSyncedHash !== localHash;
      if (changedLocally) {
        const payload = await buildUploadPayload(config, doc, e.sha);
        if (!payload) {
          debugLog(slug, 'sync:push:skip-missing-content', { path: doc.path });
          continue;
        }
        const newSha = await putFile(config, payload, 'vibenote: update notes');
        markSynced(storeSlug, id, { remoteSha: newSha, syncedHash: syncedHashForDoc(doc, newSha) });
        remoteMap.set(doc.path, newSha);
        pushed++;
        debugLog(slug, 'sync:push:unchanged-remote', { path: doc.path });
      }
    } else {
      // Remote changed; fetch remote content
      const rf = remoteFile ?? (await pullRepoFile(config, e.path));
      if (!rf) continue;
      const baseRaw = lastRemoteSha ? await fetchBlob(config, lastRemoteSha) : '';
      const baseContent = doc.kind === 'markdown' ? fromBase64(baseRaw ?? '') : baseRaw ?? '';
      const remoteHash = computeRemoteHash(rf);
      const baseHash = computeBaseHash(doc.kind, baseContent, lastRemoteSha);
      if (remoteHash === localHash) {
        markSynced(storeSlug, id, { remoteSha: rf.sha, syncedHash: syncedHashForDoc(doc, rf.sha) });
        remoteMap.set(e.path, rf.sha);
        debugLog(slug, 'sync:remote-equal-local', { path: doc.path });
        continue;
      }
      const remoteMatchesBase = doc.lastSyncedHash !== undefined && remoteHash === doc.lastSyncedHash;
      const localChangedFromBase = doc.lastSyncedHash !== localHash;
      if (remoteMatchesBase && localChangedFromBase) {
        debugLog(slug, 'sync:push:rename-detected', {
          path: doc.path,
          remoteHash,
          baseHash,
          localHash,
          lastRemoteSha,
          remoteSha: rf.sha,
        });
        const payload = await buildUploadPayload(config, doc, e.sha);
        if (!payload) {
          debugLog(slug, 'sync:push:skip-missing-content', { path: doc.path });
          continue;
        }
        const newSha = await putFile(config, payload, 'vibenote: update notes');
        markSynced(storeSlug, id, { remoteSha: newSha, syncedHash: syncedHashForDoc(doc, newSha) });
        remoteMap.set(doc.path, newSha);
        pushed++;
        debugLog(slug, 'sync:push:remote-rename-only', { path: doc.path });
        continue;
      }
      if (localChangedFromBase) {
        // both changed → merge
        if (doc.kind === 'markdown') {
          // custom merge strategy for markdown files
          const mergedText = mergeMarkdown(baseContent, doc.content, rf.content);
          if (mergedText !== doc.content) {
            updateFile(storeSlug, id, mergedText);
          }
          const newSha = await putFile(
            config,
            { path: doc.path, content: mergedText, baseSha: rf.sha, kind: 'markdown' },
            'vibenote: merge notes'
          );
          markSynced(storeSlug, id, { remoteSha: newSha, syncedHash: hashText(mergedText) });
          remoteMap.set(doc.path, newSha);
          merged++;
          pushed++;
          debugLog(slug, 'sync:merge', { path: doc.path });
        } else if (doc.kind === 'binary' || doc.kind === 'asset-url') {
          // TODO how to resolve conflicts for binary files?
          // currently we just use the remote version (seems fairer to pick the version that made it to github first)
          updateFile(storeSlug, id, rf.content, rf.mime);
          markSynced(storeSlug, id, { remoteSha: rf.sha, syncedHash: remoteHash });
          remoteMap.set(e.path, rf.sha);
          pulled++;
          debugLog(slug, 'sync:pull:binary-conflict', { path: doc.path });
        }
      } else {
        // only remote changed → pull
        updateFile(storeSlug, id, rf.content, rf.mime);
        markSynced(storeSlug, id, { remoteSha: rf.sha, syncedHash: remoteHash });
        remoteMap.set(e.path, rf.sha);
        pulled++;
        debugLog(slug, 'sync:pull:remote-changed', { path: doc.path });
      }
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
      const localHash = computeLocalHash(doc);
      const changedLocally = doc.lastSyncedHash !== localHash;
      if (changedLocally) {
        // Restore to remote
        const payload = await buildUploadPayload(config, doc);
        if (!payload) {
          debugLog(slug, 'sync:restore-skip-missing-content', { path: doc.path });
          continue;
        }
        const newSha = await putFile(config, payload, 'vibenote: restore note');
        markSynced(storeSlug, id, { remoteSha: newSha, syncedHash: syncedHashForDoc(doc, newSha) });
        remoteMap.set(doc.path, newSha);
        pushed++;
        debugLog(slug, 'sync:restore-remote-missing', { path: doc.path });
      } else {
        // Delete locally (will record a tombstone, which we clear below)
        store.deleteFileById(id);
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
      const targetLocal = findFileByPath(storeSlug, t.to);
      const remoteTargetSha = remoteMap.get(t.to);
      if (targetLocal && !remoteTargetSha) {
        const { id, doc } = targetLocal;
        const payload = await buildUploadPayload(config, doc);
        if (payload) {
          const nextSha = await putFile(config, payload, 'vibenote: update notes');
          markSynced(storeSlug, id, { remoteSha: nextSha, syncedHash: syncedHashForDoc(doc, nextSha) });
          remoteMap.set(t.to, nextSha);
          pushed++;
          debugLog(slug, 'sync:tombstone:rename:ensure-target', { to: t.to });
        } else {
          debugLog(slug, 'sync:tombstone:rename:skip-target-upload', { to: t.to });
        }
      }

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
        const remoteFile = await pullRepoFile(config, t.from);
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

      const existing = findFileByPath(storeSlug, t.from);
      const remoteFile = await pullRepoFile(config, t.from);
      if (remoteFile) {
        if (existing) {
          updateFile(storeSlug, existing.id, remoteFile.content, remoteFile.mime);
          markSynced(storeSlug, existing.id, {
            remoteSha: remoteFile.sha,
            syncedHash: computeRemoteHash(remoteFile),
          });
          remoteMap.set(remoteFile.path, remoteFile.sha);
        } else {
          const newId = store.createFile(remoteFile.path, remoteFile.content, {
            kind: remoteFile.kind,
            mime: remoteFile.mime,
          });
          moveFilePath(storeSlug, newId, t.from);
          markSynced(storeSlug, newId, {
            remoteSha: remoteFile.sha,
            syncedHash: computeRemoteHash(remoteFile),
          });
          pulled++;
          debugLog(slug, 'sync:tombstone:rename:recreate-local', { from: t.from });
          remoteMap.set(remoteFile.path, remoteFile.sha);
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
