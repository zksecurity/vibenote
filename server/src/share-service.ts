// Core business logic for sharing notes as per-user secret gists.
import crypto from 'node:crypto';
import path from 'node:path';
import { refreshAccessToken, type OAuthTokenResult } from './api.ts';
import type { Env } from './env.ts';
import type { SessionStoreInstance } from './session-store.ts';
import type { ShareStoreInstance, SharedNote, ShareAsset } from './share-store.ts';
import { extractMarkdownAssets, rewriteMarkdownAssets } from './markdown-assets.ts';
import {
  createSecretGist,
  updateSecretGist,
  downloadGistFile,
  type GistFileInput,
  type GistFilePatch,
} from './github-gist.ts';

type RepoTarget = { owner: string; repo: string };

type RepoFile = { bytes: Buffer; mediaType?: string; size: number };

type AssetPackaging = {
  shareAssets: ShareAsset[];
  gistFiles: GistFileInput[];
  removedFiles: string[];
  markdown: string;
  noteBytes: number;
  assetBytes: number;
};

const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_COUNT = 24;

export type { CreateShareRequest, CreateShareResult, ResolveShareResult, UpdateShareRequest, NoteShareSummary };
export {
  createShare,
  updateShare,
  resolveShare,
  disableShare,
  fetchSharedFile,
  listSharesForNote,
  markExpiredShares,
  validateExpiry,
};

type CreateShareRequest = {
  repo: string;
  path: string;
  mode: 'unlisted';
  includeAssets?: boolean;
  expiresAt?: string | null;
  text?: string;
};

type UpdateShareRequest = {
  text?: string | null;
};

type CreateShareResult = {
  share: SharedNote;
  url: string;
};

type NoteShareSummary = {
  id: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  includeAssets: boolean;
};

type ResolveShareResult = {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  mode: 'unlisted';
  isDisabled: boolean;
  assetNames: string[];
  primaryFile: string;
};

async function createShare(
  env: Env,
  shareStore: ShareStoreInstance,
  sessionStore: SessionStoreInstance,
  sessionId: string,
  githubLogin: string,
  request: CreateShareRequest
): Promise<CreateShareResult> {
  let repoTarget = parseRepo(request.repo);
  let notePath = sanitizePath(request.path);
  if (!notePath) throw new ShareError(400, 'invalid note path');
  if (request.mode !== 'unlisted') throw new ShareError(400, 'unsupported mode');

  let expiresAt = validateExpiry(request.expiresAt);
  let tokens = await ensureAccessToken(env, sessionStore, sessionId);
  assertHasGistScope(tokens.scope);

  let noteText = resolveNoteText(request.text, notePath);
  if (noteText === null) {
    let repoFile = await fetchRepoFile(repoTarget.owner, repoTarget.repo, notePath, tokens.accessToken, 'note');
    if (repoFile.size > MAX_NOTE_BYTES) {
      throw new ShareError(413, 'note is too large to share');
    }
    noteText = repoFile.bytes.toString('utf8');
  }
  let noteBytes = Buffer.byteLength(noteText, 'utf8');
  if (noteBytes > MAX_NOTE_BYTES) {
    throw new ShareError(413, 'note is too large to share');
  }

  let includeAssets = request.includeAssets !== false;
  let packaging = await packageAssets({
    noteText,
    notePath,
    owner: repoTarget.owner,
    repo: repoTarget.repo,
    accessToken: tokens.accessToken,
    includeAssets,
  });

  let gistFiles: GistFileInput[] = [{ filename: 'note.md', content: packaging.markdown }, ...packaging.gistFiles];
  let title = extractTitle(noteText, notePath);
  let description = buildGistDescription(title);

  let gist = await createSecretGist(tokens.accessToken, gistFiles, description);
  let nowIso = new Date().toISOString();
  let shareId = generateShareId();
  let share: SharedNote = {
    id: shareId,
    mode: 'unlisted',
    gistId: gist.id,
    gistOwner: gist.ownerLogin || githubLogin,
    primaryFile: 'note.md',
    primaryEncoding: 'utf8',
    assets: packaging.shareAssets,
    title,
    createdBy: { userId: tokens.userId, githubLogin },
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt: expiresAt ?? undefined,
    isDisabled: false,
    includeAssets,
    sourceRepo: `${repoTarget.owner}/${repoTarget.repo}`,
    sourcePath: notePath,
    metadata: {
      noteBytes: packaging.noteBytes,
      assetBytes: packaging.assetBytes,
      snapshotSha: gist.revision,
    },
  };

  await shareStore.create(share);
  return { share, url: buildShareUrl(env.PUBLIC_VIEWER_BASE_URL, shareId) };
}

async function updateShare(
  env: Env,
  shareStore: ShareStoreInstance,
  sessionStore: SessionStoreInstance,
  sessionId: string,
  githubLogin: string,
  shareId: string,
  body: UpdateShareRequest
): Promise<SharedNote> {
  let existing = shareStore.getById(shareId);
  if (!existing) throw new ShareError(404, 'share not found');
  if (existing.isDisabled) throw new ShareError(410, 'share disabled');

  let tokens = await ensureAccessToken(env, sessionStore, sessionId);
  assertHasGistScope(tokens.scope);
  if (existing.createdBy.userId !== tokens.userId) {
    throw new ShareError(403, 'forbidden');
  }

  let repoParts = parseRepo(existing.sourceRepo);
  let notePath = existing.sourcePath;
  let noteText = resolveNoteText(body.text ?? undefined, notePath);
  if (noteText === null) {
    let repoFile = await fetchRepoFile(repoParts.owner, repoParts.repo, notePath, tokens.accessToken, 'note');
    if (repoFile.size > MAX_NOTE_BYTES) {
      throw new ShareError(413, 'note is too large to share');
    }
    noteText = repoFile.bytes.toString('utf8');
  }
  let noteBytes = Buffer.byteLength(noteText, 'utf8');
  if (noteBytes > MAX_NOTE_BYTES) {
    throw new ShareError(413, 'note is too large to share');
  }

  let packaging = await packageAssets({
    noteText,
    notePath,
    owner: repoParts.owner,
    repo: repoParts.repo,
    accessToken: tokens.accessToken,
    includeAssets: existing.includeAssets,
    existingAssets: existing.assets,
  });

  let gistDescription = buildGistDescription(extractTitle(noteText, notePath));
  let patches: GistFilePatch[] = [
    { filename: existing.primaryFile, content: packaging.markdown },
    ...packaging.gistFiles.map((file) => ({ filename: file.filename, content: file.content })),
    ...packaging.removedFiles.map((filename) => ({ filename, delete: true })),
  ];
  let updated = await updateSecretGist(tokens.accessToken, existing.gistId, patches, gistDescription);

  let updatedShare: SharedNote = {
    ...existing,
    title: extractTitle(noteText, notePath),
    updatedAt: new Date().toISOString(),
    assets: packaging.shareAssets,
    metadata: {
      noteBytes: packaging.noteBytes,
      assetBytes: packaging.assetBytes,
      snapshotSha: updated.revision ?? existing.metadata.snapshotSha,
    },
  };
  let stored = await shareStore.update(existing.id, updatedShare);
  return stored ?? updatedShare;
}

async function resolveShare(shareStore: ShareStoreInstance, shareId: string): Promise<ResolveShareResult | null> {
  let record = shareStore.getById(shareId);
  if (!record) return null;
  let disabled = record.isDisabled || isExpired(record.expiresAt);
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    mode: record.mode,
    isDisabled: disabled,
    assetNames: record.assets.map((asset) => asset.gistFile),
    primaryFile: record.primaryFile,
  };
}

async function disableShare(shareStore: ShareStoreInstance, shareId: string): Promise<boolean> {
  let updated = await shareStore.disable(shareId);
  return updated !== undefined;
}

async function listSharesForNote(
  env: Env,
  shareStore: ShareStoreInstance,
  sessionStore: SessionStoreInstance,
  sessionId: string,
  repo: string,
  notePath: string
): Promise<NoteShareSummary[]> {
  let tokens = await ensureAccessToken(env, sessionStore, sessionId);
  let normalizedPath = sanitizePath(notePath);
  if (!normalizedPath) return [];
  let entries = shareStore
    .listByUser(tokens.userId)
    .filter((item) => !item.isDisabled && item.sourceRepo === repo && item.sourcePath === normalizedPath);
  return entries.map((item) => ({
    id: item.id,
    url: buildShareUrl(env.PUBLIC_VIEWER_BASE_URL, item.id),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    expiresAt: item.expiresAt,
    includeAssets: item.includeAssets,
  }));
}

async function fetchSharedFile(
  shareStore: ShareStoreInstance,
  shareId: string,
  filename: string
): Promise<{ bytes: Buffer; mediaType?: string; encoding: 'utf8' | 'base64'; isPrimary: boolean } | null> {
  let record = shareStore.getById(shareId);
  if (!record) return null;
  if (record.isDisabled || isExpired(record.expiresAt)) {
    throw new ShareError(410, 'share disabled');
  }
  let isPrimary = filename === record.primaryFile;
  let assetMeta: ShareAsset | undefined;
  if (!isPrimary) {
    assetMeta = record.assets.find((asset) => asset.gistFile === filename);
    if (!assetMeta) throw new ShareError(404, 'file not found');
  }
  let gistFile = await downloadGistFile(record.gistOwner, record.gistId, filename);
  let encoding: 'utf8' | 'base64' = isPrimary ? record.primaryEncoding : assetMeta?.encoding ?? 'utf8';
  let bytes = Buffer.from(gistFile.bytes);
  if (encoding === 'base64') {
    bytes = Buffer.from(bytes.toString('utf8'), 'base64');
  }
  if (isPrimary) {
    let replacements = new Map<string, string>();
    for (let asset of record.assets) {
      replacements.set(
        asset.gistFile,
        `/api/gist-raw?share=${encodeURIComponent(record.id)}&file=${encodeURIComponent(asset.gistFile)}`
      );
    }
    let rewritten = rewriteMarkdownAssets(bytes.toString('utf8'), replacements);
    bytes = Buffer.from(rewritten, 'utf8');
  }
  let mediaType = isPrimary ? 'text/markdown; charset=utf-8' : assetMeta?.mediaType ?? gistFile.mediaType;
  return { bytes, mediaType, encoding, isPrimary };
}

function markExpiredShares(store: ShareStoreInstance): Promise<void> {
  let now = Date.now();
  let pending: Promise<unknown>[] = [];
  for (let share of store.listAll()) {
    if (!share.expiresAt) continue;
    let expiry = Date.parse(share.expiresAt);
    if (Number.isNaN(expiry) || expiry > now) continue;
    if (!share.isDisabled) {
      pending.push(store.disable(share.id));
    }
  }
  return Promise.all(pending).then(() => undefined);
}

function validateExpiry(value?: string | null): string | null {
  if (value === undefined || value === null) return null;
  let trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) throw new ShareError(400, 'invalid expiresAt timestamp');
  if (parsed <= Date.now()) throw new ShareError(400, 'expiresAt must be in the future');
  return new Date(parsed).toISOString();
}

async function ensureAccessToken(
  env: Env,
  sessionStore: SessionStoreInstance,
  sessionId: string
): Promise<OAuthTokenResult & { userId: string }> {
  let refreshed = await refreshAccessToken(env, sessionStore, sessionId);
  let record = sessionStore.get(sessionId);
  if (!record) throw new ShareError(401, 'session expired');
  return { ...refreshed, userId: record.userId };
}

function parseRepo(value: string): RepoTarget {
  let trimmed = value.trim();
  let segments = trimmed.split('/');
  if (segments.length !== 2) {
    throw new ShareError(400, 'repo must be owner/repo');
  }
  let owner = segments[0]?.trim();
  let repo = segments[1]?.trim();
  if (!owner || !repo) {
    throw new ShareError(400, 'repo must be owner/repo');
  }
  return { owner, repo };
}

function sanitizePath(value: string): string | null {
  let trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('/')) trimmed = trimmed.slice(1);
  let normalized = path.posix.normalize(trimmed);
  if (normalized.startsWith('../') || normalized === '..') return null;
  return normalized;
}

async function fetchRepoFile(
  owner: string,
  repo: string,
  filePath: string,
  token: string,
  kind: 'note' | 'asset'
): Promise<RepoFile> {
  let encodedPath = filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  let url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`
  );
  let res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.raw',
      Authorization: `Bearer ${token}`,
    },
  });
  if (res.status === 404) {
    if (kind === 'note') throw new ShareError(404, 'note file not found');
    throw new ShareError(404, `asset not found: ${filePath}`);
  }
  if (!res.ok) {
    let label = kind === 'note' ? 'note' : 'asset';
    throw new ShareError(502, `failed to fetch ${label} (${res.status})`);
  }
  let arrayBuffer = await res.arrayBuffer();
  let bytes = Buffer.from(arrayBuffer);
  let size = bytes.byteLength;
  let mediaType = res.headers.get('content-type') ?? undefined;
  return { bytes, size, mediaType };
}

async function packageAssets(options: {
  noteText: string;
  notePath: string;
  owner: string;
  repo: string;
  accessToken: string;
  includeAssets: boolean;
  existingAssets?: ShareAsset[];
}): Promise<AssetPackaging> {
  let noteBytes = Buffer.byteLength(options.noteText, 'utf8');
  if (!options.includeAssets) {
    return {
      shareAssets: [],
      gistFiles: [],
      removedFiles: options.existingAssets?.map((asset) => asset.gistFile) ?? [],
      markdown: options.noteText,
      noteBytes,
      assetBytes: 0,
    };
  }

  let assets = extractMarkdownAssets(options.noteText);
  let noteDir = path.posix.dirname(options.notePath);
  if (noteDir === '.') noteDir = '';

  let existingByNormalized = new Map<string, ShareAsset>();
  if (Array.isArray(options.existingAssets)) {
    for (let asset of options.existingAssets) {
      existingByNormalized.set(asset.normalizedPath, asset);
    }
  }

  let shareAssets: ShareAsset[] = [];
  let gistFiles: GistFileInput[] = [];
  let replacements = new Map<string, string>();
  let totalAssetBytes = 0;
  let usedNames = new Set<string>();

  for (let ref of assets) {
    let normalized = ref.normalized;
    let existing = existingByNormalized.get(normalized);
    let resolved = noteDir ? path.posix.join(noteDir, normalized) : normalized;
    let content = await fetchRepoFile(options.owner, options.repo, resolved, options.accessToken, 'asset');
    totalAssetBytes += content.size;
    if (totalAssetBytes > MAX_ASSET_BYTES) {
      throw new ShareError(413, 'asset files exceed size limit');
    }
    let gistFile = existing?.gistFile ?? buildAssetFilename(resolved, usedNames.size);
    while (usedNames.has(gistFile)) {
      gistFile = buildAssetFilename(resolved, usedNames.size + 1);
    }
    usedNames.add(gistFile);
    let encoding = chooseEncoding(resolved, content.mediaType);
    let asset: ShareAsset = {
      originalPath: ref.raw,
      normalizedPath: normalized,
      gistFile,
      encoding,
      mediaType: content.mediaType,
    };
    shareAssets.push(asset);
    replacements.set(ref.raw, gistFile);
    let gistContent = encoding === 'base64' ? content.bytes.toString('base64') : content.bytes.toString('utf8');
    gistFiles.push({ filename: gistFile, content: gistContent });
  }

  let removedFiles: string[] = [];
  if (Array.isArray(options.existingAssets)) {
    let retain = new Set(shareAssets.map((asset) => asset.gistFile));
    for (let asset of options.existingAssets) {
      if (!retain.has(asset.gistFile)) {
        removedFiles.push(asset.gistFile);
      }
    }
  }

  let rewritten = rewriteMarkdownAssets(options.noteText, replacements);
  return {
    shareAssets,
    gistFiles,
    removedFiles,
    markdown: rewritten,
    noteBytes,
    assetBytes: totalAssetBytes,
  };
}

function buildAssetFilename(originalPath: string, index: number): string {
  let ext = path.posix.extname(originalPath).toLowerCase();
  if (!ext || ext.length > 8) ext = '.bin';
  let padded = String(index + 1).padStart(4, '0');
  return `asset_${padded}${ext}`;
}

function chooseEncoding(resolvedPath: string, mediaType: string | undefined): 'utf8' | 'base64' {
  let ext = path.posix.extname(resolvedPath).toLowerCase();
  if (mediaType && mediaType.startsWith('text/')) return 'utf8';
  if (ext === '.svg' || ext === '.txt' || ext === '.json') return 'utf8';
  return 'base64';
}

function buildGistDescription(title: string | undefined): string {
  let base = 'VibeNote shared note';
  if (!title) return base;
  return `${base} – ${title}`;
}

function extractTitle(markdown: string, notePath: string): string | undefined {
  let lines = markdown.split(/\r?\n/);
  for (let line of lines) {
    let trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) {
      return trimmed.replace(/^#+\s*/, '').trim();
    }
    break;
  }
  let base = path.posix.basename(notePath);
  return base || undefined;
}

function buildShareUrl(baseUrl: string, shareId: string): string {
  let normalized = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${normalized}/s/${shareId}`;
}

function generateShareId(): string {
  return crypto.randomBytes(16).toString('base64url');
}

function isExpired(value: string | undefined): boolean {
  if (!value) return false;
  let parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed <= Date.now() : false;
}

function resolveNoteText(text: string | undefined, notePath: string): string | null {
  if (typeof text !== 'string') return null;
  if (text.length === 0) return '';
  return text;
}

function assertHasGistScope(scopes: string[]): void {
  if (!Array.isArray(scopes)) {
    throw new ShareError(403, 'GitHub authorization missing gist scope');
  }
  if (scopes.some((scope) => scope.trim().toLowerCase() === 'gist')) return;
  throw new ShareError(403, 'GitHub authorization missing gist scope');
}

class ShareError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export { ShareError };
