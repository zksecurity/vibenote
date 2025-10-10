// Renders a preview for binary assets (currently image files) inside the workspace.
import { useEffect, useMemo } from 'react';
import type { BinaryFile } from '../storage/local';
import { basename } from '../storage/local';

type AssetViewerProps = {
  file: BinaryFile;
};

export function AssetViewer({ file }: AssetViewerProps) {
  const cleanedBase64 = useMemo(() => sanitizeBase64(file.content), [file.content]);
  const preview = useMemo(() => buildPreviewUrl(cleanedBase64, file.mime), [cleanedBase64, file.mime]);
  const assetName = useMemo(() => (file.title ? file.title : basename(file.path)), [file.title, file.path]);
  const sizeLabel = useMemo(() => formatFileSize(estimateBytes(cleanedBase64)), [cleanedBase64]);

  useEffect(() => {
    if (preview?.kind !== 'blob') return;
    return () => {
      try {
        URL.revokeObjectURL(preview.url);
      } catch {
        // ignore revoke issues; preview already gone or unsupported
      }
    };
  }, [preview]);

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
        {preview && (
          <a className="btn subtle" download={assetName} href={preview.url}>
            Download
          </a>
        )}
      </div>
      <div className="asset-viewer-body">
        {preview && <img key={preview.url} src={preview.url} alt={assetName} />}
        {!preview && (
          <p className="asset-viewer-fallback">Unable to preview this asset. Try downloading it instead.</p>
        )}
      </div>
    </div>
  );
}

type PreviewUrl = { kind: 'blob'; url: string } | { kind: 'data'; url: string };

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

function estimateBytes(contentBase64: string | null): number {
  if (!contentBase64 || contentBase64.length === 0) return 0;
  const length = contentBase64.length;
  const padding = contentBase64.endsWith('==') ? 2 : contentBase64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((length * 3) / 4) - padding);
}

function formatFileSize(bytes: number): string | null {
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
