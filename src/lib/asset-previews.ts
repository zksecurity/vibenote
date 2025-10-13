// Shared helpers for turning repo assets into browser-safe preview URLs.
export { BLOB_PLACEHOLDER_PREFIX, parseBlobPointer, sanitizeBase64, normalizeBase64, buildPreviewUrl };
export type { BlobPointer, PreviewUrl };

const BLOB_PLACEHOLDER_PREFIX = 'gh-blob:';

type BlobPointer = { owner: string; repo: string; sha: string };

type PreviewUrl =
  | { kind: 'blob'; url: string }
  | { kind: 'data'; url: string }
  | { kind: 'remote'; url: string };

function parseBlobPointer(content: string): BlobPointer | null {
  if (!content.startsWith(BLOB_PLACEHOLDER_PREFIX)) return null;
  let remainder = content.slice(BLOB_PLACEHOLDER_PREFIX.length);
  let [slug, sha] = remainder.split('#', 2);
  if (!slug || !sha) return null;
  let [owner, repo] = slug.split('/', 2);
  if (!owner || !repo) return null;
  return { owner, repo, sha };
}

function sanitizeBase64(content: string | undefined): string | null {
  if (!content) return null;
  return content.replace(/\s+/g, '');
}

function normalizeBase64(content: string): string {
  return content.replace(/\s+/g, '');
}

function buildPreviewUrl(contentBase64: string | null, mime: string | undefined): PreviewUrl | null {
  if (!contentBase64 || contentBase64.length === 0) return null;
  let safeMime = mime && mime.trim().length > 0 ? mime : 'application/octet-stream';
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try {
      let bytes = base64ToBytes(contentBase64);
      if (bytes) {
        let buffer = toArrayBuffer(bytes);
        let blob = new Blob([buffer], { type: safeMime });
        let url = URL.createObjectURL(blob);
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
  let length = decoded.length;
  let buffer = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    buffer[i] = decoded.charCodeAt(i);
  }
  return buffer;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  let bufferLike = bytes.buffer;
  let start = bytes.byteOffset;
  let end = start + bytes.byteLength;
  if (bufferLike instanceof ArrayBuffer && typeof bufferLike.slice === 'function') {
    return bufferLike.slice(start, end);
  }
  let clone = new Uint8Array(bytes.byteLength);
  clone.set(bytes);
  return clone.buffer;
}
