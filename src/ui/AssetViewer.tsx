// Renders a preview for binary assets (currently image files) inside the workspace.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BinaryFile, AssetUrlFile } from '../storage/local';
import { basename } from '../storage/local';
import { buildRemoteConfig, fetchBlob } from '../sync/git-sync';

const BLOB_PLACEHOLDER_PREFIX = 'gh-blob:';

type AssetViewerProps = {
  file: BinaryFile | AssetUrlFile;
};

export function AssetViewer({ file }: AssetViewerProps) {
  const cleanedBase64 = useMemo(
    () => (file.kind === 'binary' ? sanitizeBase64(file.content) : null),
    [file.kind, file.content]
  );
  const blobPointer = useMemo(() => (file.kind === 'asset-url' ? parseBlobPointer(file.content) : null), [file]);
  const directPreview = useMemo(() => {
    if (file.kind === 'binary') {
      return buildPreviewUrl(cleanedBase64, file.mime);
    }
    if (file.kind === 'asset-url') {
      if (blobPointer) return null;
      const url = file.content.trim();
      return url ? ({ kind: 'remote', url } as PreviewUrl) : null;
    }
    return null;
  }, [file.kind, file.content, cleanedBase64, file.mime, blobPointer]);
  const [resolvedPreview, setResolvedPreview] = useState<PreviewUrl | null>(directPreview);
  const objectUrlRef = useRef<string | null>(resolvedPreview?.kind === 'blob' ? resolvedPreview.url : null);

  useEffect(() => {
    if (!blobPointer) {
      setResolvedPreview(directPreview);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const slug = `${blobPointer.owner}/${blobPointer.repo}`;
        const config = buildRemoteConfig(slug);
        const blob = await fetchBlob(config, blobPointer.sha);
        if (cancelled) return;
        if (!blob) {
          setResolvedPreview(null);
          return;
        }
        const next = buildPreviewUrl(normalizeBase64(blob), file.mime);
        setResolvedPreview(next);
      } catch {
        if (!cancelled) setResolvedPreview(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blobPointer, directPreview, file.mime]);

  useEffect(() => {
    const current = resolvedPreview?.kind === 'blob' ? resolvedPreview.url : null;
    if (objectUrlRef.current && objectUrlRef.current !== current) {
      try {
        URL.revokeObjectURL(objectUrlRef.current);
      } catch {
        // ignore revoke errors
      }
    }
    objectUrlRef.current = current;
  }, [resolvedPreview]);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        try {
          URL.revokeObjectURL(objectUrlRef.current);
        } catch {
          // ignore revoke errors
        }
        objectUrlRef.current = null;
      }
    };
  }, []);

  const assetName = useMemo(() => (file.title ? file.title : basename(file.path)), [file.title, file.path]);
  const sizeLabel = useMemo(
    () => (file.kind === 'binary' ? formatFileSize(estimateBytes(cleanedBase64)) : null),
    [file.kind, cleanedBase64]
  );

  const downloadHref = useMemo(() => {
    if (!resolvedPreview) return undefined;
    return resolvedPreview.url;
  }, [resolvedPreview]);

  return (
    <div className="asset-viewer">
      <div className="asset-viewer-header">
        <div className="asset-viewer-title">
          <h2>{assetName}</h2>
          <p className="asset-viewer-meta">
            <span>{file.mime || 'binary file'}</span>
            {sizeLabel !== null && <span>• {sizeLabel}</span>}
          </p>
          <p className="asset-viewer-path">
            <span>Path:</span> <code>{file.path}</code>
          </p>
        </div>
        {resolvedPreview && downloadHref && (
          <a className="btn subtle" download={assetName} href={downloadHref}>
            Download
          </a>
        )}
      </div>
      <div className="asset-viewer-body">
        {resolvedPreview && <img key={resolvedPreview.url} src={resolvedPreview.url} alt={assetName} />}
        {!resolvedPreview && (
          <p className="asset-viewer-fallback">Unable to preview this asset. Try downloading it instead.</p>
        )}
      </div>
    </div>
  );
}

type PreviewUrl =
  | { kind: 'blob'; url: string }
  | { kind: 'data'; url: string }
  | { kind: 'remote'; url: string };

function buildPreviewUrl(contentBase64: string | null, mime: string | undefined): PreviewUrl | null {
  if (!contentBase64 || contentBase64.length === 0) return null;
  const safeMime = mime && mime.trim().length > 0 ? mime : 'application/octet-stream';
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try {
      const bytes = base64ToBytes(contentBase64);
      if (bytes) {
        const buffer = toArrayBuffer(bytes);
        const blob = new Blob([buffer], { type: safeMime });
        const url = URL.createObjectURL(blob);
        return { kind: 'blob', url };
      }
    } catch {
      // fall through to data URL
    }
  }
  return { kind: 'data', url: `data:${safeMime};base64,${contentBase64}` };
}

function base64ToBytes(b64: string): Uint8Array | null {
  let decoded = '';
  try {
    decoded = atob(b64);
  } catch {
    return null;
  }
  const length = decoded.length;
  const buffer = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    buffer[i] = decoded.charCodeAt(i);
  }
  return buffer;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const bufferLike = bytes.buffer;
  const start = bytes.byteOffset;
  const end = start + bytes.byteLength;
  if (bufferLike instanceof ArrayBuffer && typeof bufferLike.slice === 'function') {
    return bufferLike.slice(start, end);
  }
  const clone = new Uint8Array(bytes.byteLength);
  clone.set(bytes);
  return clone.buffer;
}

function sanitizeBase64(content: string | undefined): string | null {
  if (!content) return null;
  return content.replace(/\s+/g, '');
}

function normalizeBase64(content: string): string {
  return content.replace(/\s+/g, '');
}

function estimateBytes(contentBase64: string | null): number {
  if (!contentBase64 || contentBase64.length === 0) return 0;
  const length = contentBase64.length;
  const padding = contentBase64.endsWith('==') ? 2 : contentBase64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((length * 3) / 4) - padding);
}

function formatFileSize(bytes: number | null): string | null {
  if (!bytes) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted = value >= 100 || unitIndex === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${formatted} ${units[unitIndex]}`;
}

type BlobPointer = { owner: string; repo: string; sha: string };

function parseBlobPointer(content: string): BlobPointer | null {
  if (!content.startsWith(BLOB_PLACEHOLDER_PREFIX)) return null;
  const remainder = content.slice(BLOB_PLACEHOLDER_PREFIX.length);
  const [slug, sha] = remainder.split('#', 2);
  if (!slug || !sha) return null;
  const [owner, repo] = slug.split('/', 2);
  if (!owner || !repo) return null;
  return { owner, repo, sha };
}
