import path from 'node:path';

export { resolveAssetPath, encodeAssetPath, extractRelativeAssetRefs, collectAssetPaths };

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

function encodeAssetPath(pathValue: string): string {
  return pathValue
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function extractRelativeAssetRefs(markdown: string): string[] {
  const added = new Set<string>();
  const add = (raw: string | undefined) => {
    let target = normalizeLinkTarget(raw);
    if (target) added.add(target);
  };

  const inlinePattern = /(!)?\[[^\]]*]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(inlinePattern)) {
    add(captureUrl(match[2]));
  }

  const htmlAssetPattern =
    /<(img|a|audio|video|source|track)\b[^>]*?(?:src|href)=["']([^"']+)["'][^>]*>/gi;
  for (const match of markdown.matchAll(htmlAssetPattern)) {
    add(match[2]);
  }

  const definitions = extractReferenceDefinitions(markdown);
  const referencePattern = /(!)?\[([^\]]*)]\[([^\]]*)]/g;
  for (const match of markdown.matchAll(referencePattern)) {
    let label = match[3];
    if (label === undefined) continue;
    if (label.trim().length === 0) {
      label = match[2] ?? '';
    }
    const target = definitions.get(label.trim().toLowerCase());
    if (target) {
      add(target);
    }
  }

  // try to decode to valid URL, but just ignore ref if it fails
  // (we don't want to reject the whole note just because of one bad link)
  return [...added]
    .map((ref) => {
      try {
        return decodeURIComponent(ref);
      } catch {
        return undefined;
      }
    })
    .filter((ref) => ref !== undefined);
}

function collectAssetPaths(notePath: string, markdown: string): Set<string> {
  const paths = new Set<string>();
  for (const ref of extractRelativeAssetRefs(markdown)) {
    const normalized = resolveAssetPath(notePath, ref);
    if (normalized && isAllowedAttachment(normalized)) {
      paths.add(normalized);
    }
  }
  return paths;
}

function normalizeLinkTarget(raw: string | undefined): string | undefined {
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

function isAllowedAttachment(pathValue: string): boolean {
  const lower = pathValue.toLowerCase();
  const dotIndex = lower.lastIndexOf('.');
  if (dotIndex === -1) {
    return true;
  }
  const extension = lower.slice(dotIndex);
  return !BLOCKED_ASSET_EXTENSIONS.has(extension);
}
