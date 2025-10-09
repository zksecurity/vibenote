// Core business logic for sharing notes as secret gists.
import crypto from 'node:crypto';
import path from 'node:path';
import { refreshAccessToken, type OAuthTokenResult } from './api.ts';
import type { Env } from './env.ts';
import type { SessionStoreInstance } from './session-store.ts';
import type { ShareStoreInstance, SharedNote, ShareAsset } from './share-store.ts';
import { extractMarkdownAssets, rewriteMarkdownAssets } from './markdown-assets.ts';
import { createSecretGist, fetchGistFile } from './github-gist.ts';

export type { CreateShareRequest, CreateShareResult, ResolveShareResult };
export {
  createShare,
  resolveShare,
  disableShare,
  fetchSharedFile,
  markExpiredShares,
  validateExpiry,
};

type CreateShareRequest = {
  repo: string;
  path: string;
  mode: 'unlisted';
  includeAssets?: boolean;
  expiresAt?: string | null;
};

type CreateShareResult = {
  shared: SharedNote;
  url: string;
};

type ResolveShareResult = {
  id: string;
  title?: string;
  createdAt: string;
  expiresAt?: string;
  mode: 'unlisted';
  isDisabled: boolean;
  assetNames: string[];
  primaryFile: string;
};

type RepoTarget = {
  owner: string;
  repo: string;
  path: string;
};

type RepoFile = {
  bytes: Buffer;
  mediaType?: string;
  size: number;
};

type GistFile = {
  filename: string;
  content: string;
};

type AssetPackaging = {
  shareAssets: ShareAsset[];
  gistFiles: GistFile[];
  markdown: string;
  noteBytes: number;
  assetBytes: number;
};

const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_COUNT = 24;

async function createShare(
  env: Env,
  shareStore: ShareStoreInstance,
  sessionStore: SessionStoreInstance,
  sessionId: string,
  githubLogin: string,
  request: CreateShareRequest
): Promise<CreateShareResult> {
  let parsed = parseRepo(request.repo);
  let notePath = sanitizePath(request.path);
  if (!notePath) {
    throw new ShareError(400, 'invalid note path');
  }
  let expiresAt = validateExpiry(request.expiresAt);
  if (request.mode !== 'unlisted') {
    throw new ShareError(400, 'unsupported mode');
  }

  let tokens = await ensureAccessToken(env, sessionStore, sessionId);
  let noteFile = await fetchRepoFile(parsed.owner, parsed.repo, notePath, tokens.accessToken, 'note');
  if (noteFile.size > MAX_NOTE_BYTES) {
    throw new ShareError(413, 'note is too large to share');
  }
  let noteText = noteFile.bytes.toString('utf8');

  let packaging = await packageAssets({
    noteText,
    notePath,
    owner: parsed.owner,
    repo: parsed.repo,
    accessToken: tokens.accessToken,
    includeAssets: request.includeAssets !== false,
  });

  let gistFiles: GistFile[] = [{ filename: 'note.md', content: packaging.markdown }, ...packaging.gistFiles];
  let title = extractTitle(noteText, notePath);
  let description = buildGistDescription(title);

  let gist = await createSecretGist(env.GIST_SERVICE_TOKEN, gistFiles, description);

  let shareId = generateShareId();
  let createdAt = new Date().toISOString();
  let shared: SharedNote = {
    id: shareId,
    mode: 'unlisted',
    gistId: gist.id,
    primaryFile: 'note.md',
    primaryEncoding: 'utf8',
    assets: packaging.shareAssets,
    title,
    createdBy: {
      userId: tokens.userId,
      githubLogin,
    },
    createdAt,
    expiresAt: expiresAt ?? undefined,
    isDisabled: false,
    metadata: {
      noteBytes: packaging.noteBytes,
      assetBytes: packaging.assetBytes,
    },
  };

  await shareStore.create(shared);
  let url = buildShareUrl(env.PUBLIC_VIEWER_BASE_URL, shareId);
  return { shared, url };
}

async function resolveShare(shareStore: ShareStoreInstance, shareId: string): Promise<ResolveShareResult | null> {
  let record = shareStore.getById(shareId);
  if (!record) return null;
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    mode: record.mode,
    isDisabled: record.isDisabled || isExpired(record.expiresAt),
    assetNames: record.assets.map((asset) => asset.gistFile),
    primaryFile: record.primaryFile,
  };
}

async function disableShare(shareStore: ShareStoreInstance, shareId: string): Promise<boolean> {
  let updated = await shareStore.disable(shareId);
  return updated !== undefined;
}

async function fetchSharedFile(
  env: Env,
  shareStore: ShareStoreInstance,
  shareId: string,
  filename: string
): Promise<{ bytes: Buffer; mediaType?: string; encoding: 'utf8' | 'base64'; isPrimary: boolean } | null> {
  let record = shareStore.getById(shareId);
  if (!record) {
    return null;
  }
  if (record.isDisabled || isExpired(record.expiresAt)) {
    throw new ShareError(410, 'share disabled');
  }
  let isPrimary = filename === record.primaryFile;
  let assetMeta: ShareAsset | undefined;
  if (!isPrimary) {
    assetMeta = record.assets.find((asset) => asset.gistFile === filename);
    if (!assetMeta) {
      throw new ShareError(404, 'file not found');
    }
  }
  let gistFile = await fetchGistFile(env.GIST_SERVICE_TOKEN, record.gistId, filename);
  let encoding: 'utf8' | 'base64' = 'utf8';
  encoding = isPrimary ? record.primaryEncoding : assetMeta?.encoding ?? 'utf8';
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
  let mediaType = isPrimary ? 'text/markdown' : assetMeta?.mediaType ?? gistFile.mediaType;
  return { bytes, mediaType, encoding, isPrimary };
}

function markExpiredShares(store: ShareStoreInstance): Promise<void> {
  let now = Date.now();
  let pending: Promise<unknown>[] = [];
  for (let share of store.listAll()) {
    if (share.expiresAt === undefined) continue;
    let expiry = Date.parse(share.expiresAt);
    if (!Number.isFinite(expiry)) continue;
    if (expiry <= now && !share.isDisabled) {
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
  if (!Number.isFinite(parsed)) {
    throw new ShareError(400, 'invalid expiresAt timestamp');
  }
  if (parsed <= Date.now()) {
    throw new ShareError(400, 'expiresAt must be in the future');
  }
  return new Date(parsed).toISOString();
}

async function ensureAccessToken(
  env: Env,
  sessionStore: SessionStoreInstance,
  sessionId: string
): Promise<OAuthTokenResult & { userId: string }> {
  let refreshed = await refreshAccessToken(env, sessionStore, sessionId);
  let record = sessionStore.get(sessionId);
  if (!record) {
    throw new ShareError(401, 'session expired');
  }
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
  return { owner, repo, path: '' };
}

function sanitizePath(value: string): string | null {
  let trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('/')) {
    trimmed = trimmed.slice(1);
  }
  let normalized = path.posix.normalize(trimmed);
  if (normalized.startsWith('../') || normalized === '..') {
    return null;
  }
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
    if (kind === 'note') {
      throw new ShareError(404, 'note file not found');
    }
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
}): Promise<AssetPackaging> {
  let noteBytes = Buffer.byteLength(options.noteText, 'utf8');
  if (!options.includeAssets) {
    return { shareAssets: [], gistFiles: [], markdown: options.noteText, noteBytes, assetBytes: 0 };
  }

  let assets = extractMarkdownAssets(options.noteText);
  let noteDir = path.posix.dirname(options.notePath);
  if (noteDir === '.') noteDir = '';

  let shareAssets: ShareAsset[] = [];
  let gistFiles: GistFile[] = [];
  let byNormalized = new Map<string, ShareAsset>();
  let replacements = new Map<string, string>();
  let totalAssetBytes = 0;

  for (let ref of assets) {
    let existing = byNormalized.get(ref.normalized);
    if (existing) {
      replacements.set(ref.raw, existing.gistFile);
      continue;
    }
    if (byNormalized.size >= MAX_ASSET_COUNT) {
      throw new ShareError(413, 'too many asset files');
    }
    let resolved = noteDir ? path.posix.join(noteDir, ref.normalized) : ref.normalized;
    let content = await fetchRepoFile(options.owner, options.repo, resolved, options.accessToken, 'asset');
    totalAssetBytes += content.size;
    if (totalAssetBytes > MAX_ASSET_BYTES) {
      throw new ShareError(413, 'asset files exceed size limit');
    }
    let gistFile = buildAssetFilename(resolved, byNormalized.size);
    let encoding = chooseEncoding(resolved, content.mediaType);
    let asset: ShareAsset = {
      originalPath: ref.raw,
      gistFile,
      encoding,
      mediaType: content.mediaType,
    };
    shareAssets.push(asset);
    byNormalized.set(ref.normalized, asset);
    let gistContent =
      encoding === 'base64' ? content.bytes.toString('base64') : content.bytes.toString('utf8');
    gistFiles.push({ filename: gistFile, content: gistContent });
    replacements.set(ref.raw, gistFile);
  }

  let rewritten = rewriteMarkdownAssets(options.noteText, replacements);
  return { shareAssets, gistFiles, markdown: rewritten, noteBytes, assetBytes: totalAssetBytes };
}

function buildAssetFilename(originalPath: string, index: number): string {
  let ext = path.posix.extname(originalPath).toLowerCase();
  if (!ext || ext.length > 8) {
    ext = '.bin';
  }
  let padded = String(index + 1).padStart(4, '0');
  return `asset_${padded}${ext}`;
}

function chooseEncoding(resolvedPath: string, mediaType: string | undefined): 'utf8' | 'base64' {
  let ext = path.posix.extname(resolvedPath).toLowerCase();
  if (mediaType && mediaType.startsWith('text/')) {
    return 'utf8';
  }
  if (ext === '.svg' || ext === '.txt' || ext === '.json') {
    return 'utf8';
  }
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

function buildShareUrl(base: string, shareId: string): string {
  let normalized = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${normalized}/s/${shareId}`;
}

function generateShareId(): string {
  return crypto.randomBytes(16).toString('base64url');
}

function isExpired(value: string | undefined): boolean {
  if (!value) return false;
  let parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return parsed <= Date.now();
}

class ShareError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export { ShareError };
