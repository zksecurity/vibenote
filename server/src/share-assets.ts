import path from 'node:path';

export { resolveAssetPath, decodeAssetParam, encodeAssetPath, extractRelativeAssetRefs };
export { collectAssetPaths };

const BLOCKED_ASSET_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdown',
  '.mkd',
  '.mkdn',
  '.mdx',
  '.html',
  '.htm',
]);

function resolveAssetPath(notePath: string, requestPath: string): string | null {
  let candidate = requestPath.trim();
  if (candidate.length === 0) return null;
  candidate = candidate.replace(/\\/g, '/');
  if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
    return null;
  }
  if (candidate.startsWith('/')) {
    candidate = candidate.replace(/^\/+/, '');
  } else {
    const noteDir = path.posix.dirname(notePath);
    if (noteDir !== '.' && candidate.startsWith(`${noteDir}/`)) {
      // already relative to repo root with noteDir prefix; keep as-is
    } else {
      candidate = noteDir === '.' ? candidate : `${noteDir}/${candidate}`;
    }
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized.startsWith('../') || normalized === '..') {
    return null;
  }
  return normalized;
}

function decodeAssetParam(raw: string | undefined): string {
  if (typeof raw !== 'string') return '';
  return decodeURIComponentSafe(raw);
}

function encodeAssetPath(pathValue: string): string {
  return pathValue
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function extractRelativeAssetRefs(markdown: string): string[] {
  const results: string[] = [];
  const added = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const target = normalizeLinkTarget(raw);
    if (!target) return;
    if (!added.has(target)) {
      added.add(target);
      results.push(target);
    }
  };

  const inlineImagePattern = /!\[[^\]]*]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(inlineImagePattern)) {
    add(captureUrl(match[1]));
  }

  const inlineLinkPattern = /\[([^\]]*?)]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(inlineLinkPattern)) {
    const index = match.index ?? 0;
    if (index > 0 && markdown[index - 1] === '!') {
      continue;
    }
    add(captureUrl(match[2]));
  }

  const htmlImgPattern = /<img[^>]*src=["']([^"']+)["'][^>]*>/gi;
  for (const match of markdown.matchAll(htmlImgPattern)) {
    add(match[1]);
  }

  const htmlAnchorPattern = /<a[^>]*href=["']([^"']+)["'][^>]*>/gi;
  for (const match of markdown.matchAll(htmlAnchorPattern)) {
    add(match[1]);
  }

  const htmlMediaPattern = /<(?:audio|video)[^>]*src=["']([^"']+)["'][^>]*>/gi;
  for (const match of markdown.matchAll(htmlMediaPattern)) {
    add(match[1]);
  }

  const htmlSourcePattern = /<(?:source|track)[^>]*src=["']([^"']+)["'][^>]*>/gi;
  for (const match of markdown.matchAll(htmlSourcePattern)) {
    add(match[1]);
  }

  const definitions = extractReferenceDefinitions(markdown);
  const referenceImagePattern = /!\[([^\]]*)]\[([^\]]*)]/g;
  for (const match of markdown.matchAll(referenceImagePattern)) {
    let label = match[2];
    if (label === undefined) continue;
    if (label.trim().length === 0) {
      label = match[1] ?? '';
    }
    const target = definitions.get(label.trim().toLowerCase());
    if (target) {
      add(target);
    }
  }

  const referenceLinkPattern = /\[([^\]]*)]\[([^\]]*)]/g;
  for (const match of markdown.matchAll(referenceLinkPattern)) {
    const index = match.index ?? 0;
    if (index > 0 && markdown[index - 1] === '!') {
      continue;
    }
    let label = match[2];
    if (label === undefined) continue;
    if (label.trim().length === 0) {
      label = match[1] ?? '';
    }
    const target = definitions.get(label.trim().toLowerCase());
    if (target) {
      add(target);
    }
  }

  return results;
}

function collectAssetPaths(notePath: string, markdown: string): Set<string> {
  const paths = new Set<string>();
  for (const ref of extractRelativeAssetRefs(markdown)) {
    const normalized = resolveAssetPath(notePath, decodeAssetParam(ref));
    if (normalized && isAllowedAttachment(normalized)) {
      paths.add(normalized);
    }
  }
  return paths;
}

function normalizeLinkTarget(raw: string): string | undefined {
  if (!raw) return undefined;
  let trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (isExternalReference(trimmed)) return undefined;
  return trimmed;
}

function isExternalReference(target: string): boolean {
  const lower = target.toLowerCase();
  return (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('data:') ||
    lower.startsWith('tel:') ||
    lower.startsWith('//') ||
    lower.startsWith('#')
  );
}

function captureUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let trimmed = raw.trim();
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex !== -1) {
    trimmed = trimmed.slice(0, spaceIndex);
  }
  return trimmed;
}

function extractReferenceDefinitions(markdown: string): Map<string, string> {
  const map = new Map<string, string>();
  const definitionPattern = /^\s*\[([^\]]+)\]:\s*(<[^>]+>|[^\s]+)(?:\s+["'(][^"'()]*["')])?\s*$/gim;
  let match: RegExpExecArray | null;
  while ((match = definitionPattern.exec(markdown)) !== null) {
    const labelRaw = match[1];
    let target = match[2];
    if (!labelRaw || !target) continue;
    target = target.trim();
    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.slice(1, -1).trim();
    }
    if (!target) continue;
    if (isExternalReference(target)) continue;
    map.set(labelRaw.trim().toLowerCase(), target);
  }
  return map;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isAllowedAttachment(pathValue: string): boolean {
  const lower = pathValue.toLowerCase();
  const dotIndex = lower.lastIndexOf('.');
  if (dotIndex === -1) {
    return true;
  }
  const extension = lower.slice(dotIndex);
  return !BLOCKED_ASSET_EXTENSIONS.has(extension);
}
