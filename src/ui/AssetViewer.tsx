// Renders a preview for binary assets (currently image files) inside the workspace.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BinaryFile, AssetUrlFile } from '../storage/local';
import { basename } from '../storage/local';
import { buildRemoteConfig, fetchBlob } from '../sync/git-sync';
import {
  buildPreviewUrl,
  normalizeBase64,
  parseBlobPointer,
  sanitizeBase64,
  type PreviewUrl,
} from '../lib/asset-previews';

type AssetViewerProps = {
  file: BinaryFile | AssetUrlFile;
};

export function AssetViewer({ file }: AssetViewerProps) {
  const cleanedBase64 = useMemo(
    () => (file.kind === 'binary' ? sanitizeBase64(file.content) : null),
    [file.kind, file.content]
  );
  const blobPointer = useMemo(
    () => (file.kind === 'asset-url' ? parseBlobPointer(file.content) : null),
    [file]
  );
  const directPreview = useMemo(() => {
    if (file.kind === 'binary') {
      return buildPreviewUrl(cleanedBase64, file.path);
    }
    if (file.kind === 'asset-url') {
      if (blobPointer) return null;
      const url = file.content.trim();
      return url ? ({ kind: 'remote', url } as PreviewUrl) : null;
    }
    return null;
  }, [file.kind, file.content, cleanedBase64, file.path, blobPointer]);
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
        const next = buildPreviewUrl(normalizeBase64(blob), file.path);
        setResolvedPreview(next);
      } catch {
        if (!cancelled) setResolvedPreview(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blobPointer, directPreview, file.path]);

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

  const assetName = useMemo(() => basename(file.path), [file.path]);

  const downloadHref = useMemo(() => {
    if (!resolvedPreview) return undefined;
    return resolvedPreview.url;
  }, [resolvedPreview]);

  return (
    <div className="asset-viewer">
      <div className="asset-viewer-header">
        <div className="asset-viewer-title">
          <h2>{assetName}</h2>
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
