// Global cache for resolved asset previews so multiple editors reuse fetched blobs/URLs.
import { normalizePath } from '../lib/util';
import { hashText } from '../storage/local';
import type { BinaryFile, AssetUrlFile } from '../storage/local';
import {
  buildPreviewUrl,
  sanitizeBase64,
  parseBlobPointer,
  normalizeBase64,
  type PreviewUrl,
  type BlobPointer,
} from '../lib/asset-previews';
import { buildRemoteConfig, fetchBlob } from '../sync/git-sync';

export { resolveAssetPreview, clearAssetPreviewCache };

type PreviewCacheEntry = { preview: PreviewUrl; dispose?: () => void };

const previewCache = new Map<string, PreviewCacheEntry | null>();
const pendingRequests = new Map<string, Promise<PreviewCacheEntry | null>>();

type ResolveAssetPreviewParams = {
  slug: string;
  assetPath: string;
  loadAsset: (path: string) => Promise<BinaryFile | AssetUrlFile | undefined>;
};

async function resolveAssetPreview(params: ResolveAssetPreviewParams): Promise<PreviewUrl | null> {
  let { slug, assetPath, loadAsset } = params;
  let requestKey = buildRequestKey(slug, assetPath);
  let inFlight = pendingRequests.get(requestKey);
  if (inFlight) {
    let entry = await inFlight;
    return entry?.preview ?? null;
  }
  let task = (async () => {
    let asset = await loadAsset(assetPath);
    if (!asset) return null;
    let cacheKey = buildCacheKey(slug, asset);
    let cached = previewCache.get(cacheKey);
    if (cached !== undefined) return cached;
    let entry = await buildPreviewEntry(asset);
    if (!entry) return null;
    storeEntry(cacheKey, entry);
    return entry;
  })();
  pendingRequests.set(requestKey, task);
  try {
    let entry = await task;
    return entry?.preview ?? null;
  } finally {
    pendingRequests.delete(requestKey);
  }
}

function buildRequestKey(slug: string, path: string): string {
  let normalized = normalizePath(path);
  return `${slug}::${normalized ?? path}`;
}

function buildCacheKey(slug: string, asset: BinaryFile | AssetUrlFile): string {
  let normalizedPath = normalizePath(asset.path) ?? asset.path;
  if (asset.kind === 'binary') {
    let contentHash =
      typeof asset.lastSyncedHash === 'string' && asset.lastSyncedHash.length > 0
        ? asset.lastSyncedHash
        : hashText(sanitizeBase64(asset.content) ?? '');
    return `${slug}::${normalizedPath}::binary::${contentHash}`;
  }
  let pointer = parseBlobPointer(asset.content);
  if (pointer) {
    let sha = asset.lastRemoteSha ?? pointer.sha;
    return `blob::${pointer.owner}/${pointer.repo}#${sha}`;
  }
  let url = asset.content.trim();
  return `${slug}::${normalizedPath}::url::${url}`;
}

async function buildPreviewEntry(asset: BinaryFile | AssetUrlFile): Promise<PreviewCacheEntry | null> {
  if (asset.kind === 'binary') {
    let preview = buildPreviewUrl(sanitizeBase64(asset.content), asset.mime);
    return preview ? toCacheEntry(preview) : null;
  }
  let pointer = parseBlobPointer(asset.content);
  if (!pointer) {
    let url = asset.content.trim();
    if (url === '') return null;
    return toCacheEntry({ kind: 'remote', url });
  }
  let preview = await fetchPointerPreview(pointer, asset.mime, asset.lastRemoteSha);
  return preview ? toCacheEntry(preview) : null;
}

async function fetchPointerPreview(
  pointer: BlobPointer,
  mime: string | undefined,
  shaHint: string | undefined
): Promise<PreviewUrl | null> {
  try {
    let slug = `${pointer.owner}/${pointer.repo}`;
    let config = buildRemoteConfig(slug);
    let blob = await fetchBlob(config, shaHint ?? pointer.sha);
    if (!blob) return null;
    return buildPreviewUrl(normalizeBase64(blob), mime);
  } catch {
    return null;
  }
}

function toCacheEntry(preview: PreviewUrl): PreviewCacheEntry {
  if (preview.kind !== 'blob') return { preview };
  let disposed = false;
  return {
    preview,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        URL.revokeObjectURL(preview.url);
      } catch {
        // ignore revoke errors
      }
    },
  };
}

function storeEntry(key: string, entry: PreviewCacheEntry) {
  let previous = previewCache.get(key);
  if (previous && previous.preview.kind === 'blob') {
    previous.dispose?.();
  }
  previewCache.set(key, entry);
}

function clearAssetPreviewCache() {
  for (let entry of previewCache.values()) {
    entry?.dispose?.();
  }
  previewCache.clear();
  pendingRequests.clear();
}
