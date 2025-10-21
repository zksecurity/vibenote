// Utilities that prepare clipboard images (downscaling + encoding) before storage.
export {
  prepareClipboardImage,
  toBase64,
  bytesFromBase64Length,
  SUPPORTED_IMAGE_TYPES,
  IMAGE_SIZE_LIMIT_BYTES,
  IMAGE_MAX_DIMENSION,
  IMAGE_FINAL_SIZE_LIMIT_BYTES,
  type PreparedClipboardImage,
};

import { COMMON_ASSET_DIR } from './pathing';

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'image/avif',
]);

const IMAGE_SIZE_LIMIT_BYTES = 3_000_000;
const IMAGE_FINAL_SIZE_LIMIT_BYTES = 4_000_000;
const IMAGE_MAX_DIMENSION = 2_500;
const JPEG_EXPORT_QUALITY = 0.85;
const WEBP_EXPORT_QUALITY = 0.8;

type PreparedClipboardImage = {
  base64: string;
  ext: string;
  mimeType: string;
  width: number | undefined;
  height: number | undefined;
  wasCompressed: boolean;
  sourceBytes: number;
  outputBytes: number;
  folder: string;
};

async function prepareClipboardImage(file: File): Promise<PreparedClipboardImage | undefined> {
  let mimeType = normalizeMimeType(file.type);
  if (!mimeType) return undefined;
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) return undefined;

  let originalBase64 = await toBase64(file);
  let originalBytes = bytesFromBase64Length(originalBase64.length);
  let compressible = mimeType !== 'image/gif' && mimeType !== 'image/svg+xml';

  let dimensions: { width: number; height: number } | undefined = undefined;
  let shouldAttemptCompression = compressible && file.size > IMAGE_SIZE_LIMIT_BYTES;
  let processed = {
    base64: originalBase64,
    ext: extensionForMime(mimeType),
    mimeType,
    width: undefined as number | undefined,
    height: undefined as number | undefined,
    wasCompressed: false,
    sourceBytes: originalBytes,
    outputBytes: originalBytes,
    folder: COMMON_ASSET_DIR,
  };

  if (!shouldAttemptCompression && !needsDimensionClamp(mimeType)) {
    return processed;
  }

  try {
    dimensions = await loadImageDimensions(file);
  } catch {
    return processed;
  }

  processed.width = dimensions?.width;
  processed.height = dimensions?.height;

  let needsResize = dimensions !== undefined && exceedsMaxDimension(dimensions);
  let needsReencode = shouldAttemptCompression;

  if (!needsResize && !needsReencode) {
    return processed;
  }

  try {
    let draw = await drawToCanvas(file, dimensions ?? { width: 0, height: 0 }, needsResize);
    let targetMime = chooseTargetMime(mimeType);
    let encoded = encodeCanvas(draw.canvas, draw.context, targetMime, { quality: JPEG_EXPORT_QUALITY });
    let outputMime = encoded?.mime ?? mimeType;
    let outputBase64 = encoded?.base64 ?? originalBase64;
    let outputBytes = encoded ? bytesFromBase64Length(encoded.base64.length) : originalBytes;
    let ext = extensionForMime(outputMime);
    if (encoded && outputBytes > IMAGE_FINAL_SIZE_LIMIT_BYTES) {
      let webpEncoded = encodeCanvas(draw.canvas, draw.context, 'image/webp', { quality: WEBP_EXPORT_QUALITY });
      if (webpEncoded) {
        let webpBytes = bytesFromBase64Length(webpEncoded.base64.length);
        if (webpBytes < outputBytes) {
          outputBase64 = webpEncoded.base64;
          outputMime = webpEncoded.mime;
          outputBytes = webpBytes;
          ext = extensionForMime(outputMime);
        }
      }
    }
    if (outputBytes >= originalBytes) {
      processed.base64 = originalBase64;
      processed.outputBytes = originalBytes;
      processed.wasCompressed = false;
      processed.ext = extensionForMime(mimeType);
      processed.mimeType = mimeType;
      return processed;
    }
    processed.base64 = outputBase64;
    processed.outputBytes = outputBytes;
    processed.wasCompressed = true;
    processed.ext = ext;
    processed.mimeType = outputMime;
    processed.width = draw.width;
    processed.height = draw.height;
    return processed;
  } catch {
    return processed;
  }
}

function normalizeMimeType(type: string | undefined | null): string | undefined {
  if (!type) return undefined;
  let trimmed = type.trim().toLowerCase();
  if (trimmed === '') return undefined;
  if (trimmed === 'image/jpg') return 'image/jpeg';
  return trimmed;
}

function extensionForMime(type: string): string {
  switch (type) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/svg+xml':
      return 'svg';
    case 'image/avif':
      return 'avif';
    default:
      return 'bin';
  }
}

async function toBase64(file: File): Promise<string> {
  let buffer = await file.arrayBuffer();
  let bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

function bytesFromBase64Length(length: number): number {
  return Math.floor((length * 3) / 4);
}

type LoadedImage = {
  image: HTMLImageElement;
  width: number;
  height: number;
};

async function loadImageDimensions(file: File): Promise<{ width: number; height: number }> {
  let url = URL.createObjectURL(file);
  try {
    return await new Promise<{ width: number; height: number }>((resolve, reject) => {
      let img = new Image();
      img.onload = () => resolve({ width: img.width, height: img.height });
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function exceedsMaxDimension(dimensions: { width: number; height: number }): boolean {
  return dimensions.width > IMAGE_MAX_DIMENSION || dimensions.height > IMAGE_MAX_DIMENSION;
}

function needsDimensionClamp(mimeType: string): boolean {
  return mimeType !== 'image/gif' && mimeType !== 'image/svg+xml';
}

type CanvasResult = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
};

async function drawToCanvas(
  file: File,
  dimensions: { width: number; height: number },
  resize: boolean
): Promise<CanvasResult> {
  let canvas = document.createElement('canvas');
  let ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2d context not available');
  let target = computeTargetDimensions(dimensions, resize);
  canvas.width = target.width;
  canvas.height = target.height;
  let image = await loadImageElement(file);
  ctx.drawImage(image, 0, 0, target.width, target.height);
  return { canvas, context: ctx, width: target.width, height: target.height };
}

async function loadImageElement(file: File): Promise<HTMLImageElement> {
  let url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      let img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function computeTargetDimensions(
  dimensions: { width: number; height: number },
  resize: boolean
): { width: number; height: number } {
  if (!resize) return { width: dimensions.width, height: dimensions.height };
  let { width, height } = dimensions;
  let maxEdge = Math.max(width, height);
  if (maxEdge <= IMAGE_MAX_DIMENSION || maxEdge === 0) {
    return { width, height };
  }
  let scale = IMAGE_MAX_DIMENSION / maxEdge;
  let scaledWidth = Math.round(width * scale);
  let scaledHeight = Math.round(height * scale);
  return { width: scaledWidth, height: scaledHeight };
}

type EncodeOptions = {
  quality?: number;
};

function encodeCanvas(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  mime: string,
  options: EncodeOptions
): { base64: string; mime: string } | undefined {
  let targetMime = adjustTargetMime(mime, canvas);
  if (targetMime === 'image/png') {
    let dataUrl = canvas.toDataURL('image/png');
    let base64 = extractBase64(dataUrl);
    return { base64, mime: 'image/png' };
  }
  if (targetMime === 'image/jpeg') {
    let dataUrl = canvas.toDataURL('image/jpeg', options.quality);
    let base64 = extractBase64(dataUrl);
    return { base64, mime: 'image/jpeg' };
  }
  if (targetMime === 'image/webp') {
    try {
      let dataUrl = canvas.toDataURL('image/webp', options.quality);
      let base64 = extractBase64(dataUrl);
      return { base64, mime: 'image/webp' };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function extractBase64(dataUrl: string): string {
  let idx = dataUrl.indexOf(',');
  if (idx < 0) return '';
  return dataUrl.slice(idx + 1);
}

function adjustTargetMime(mime: string, canvas: HTMLCanvasElement): string {
  if (mime === 'image/png') return 'image/png';
  if (mime === 'image/webp') return 'image/webp';
  return 'image/jpeg';
}

function chooseTargetMime(source: string): string {
  if (source === 'image/png') return 'image/png';
  if (source === 'image/webp') return 'image/jpeg';
  if (source === 'image/avif') return 'image/jpeg';
  if (source === 'image/gif') return 'image/png';
  if (source === 'image/svg+xml') return 'image/png';
  return 'image/jpeg';
}
