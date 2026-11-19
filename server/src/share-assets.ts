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

  // Every scanned span excludes its own opening delimiter, so a failed match stops at the next
  // candidate instead of rescanning the rest of the note. This keeps extraction linear in the note
  // size even for adversarial input (e.g. thousands of unmatched `[`).
  // The flat pattern finds links whose text has no brackets; the nested pattern allows one level of
  // balanced brackets in the text. Together they find both targets of `[![alt](a.png)](b.pdf)`.
  // Destinations may likewise contain one level of balanced parentheses, e.g. in `"title (1)"`.
  const destination = String.raw`\(((?:[^()]|\([^()]*\))+)\)`;
  const inlinePatterns = [
    new RegExp(String.raw`\[[^[\]]*\]` + destination, 'g'),
    new RegExp(String.raw`\[(?:[^[\]]|\[[^[\]]*\])*\]` + destination, 'g'),
  ];
  for (const inlinePattern of inlinePatterns) {
    for (const match of markdown.matchAll(inlinePattern)) {
      add(captureUrl(match[1]));
    }
  }

  for (const ref of extractHtmlAssetRefs(markdown)) {
    add(ref);
  }

  const definitions = extractReferenceDefinitions(markdown);
  const referencePattern = /(!)?\[([^[\]]*)\]\[([^[\]]*)\]/g;
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

// Values of src/href attributes on asset-bearing HTML tags. Each tag is parsed once, left to right,
// honoring quoted attribute values (which may contain `<` or `>`), and the search resumes after it,
// so the scan is linear in the note size. A tag still open at the end of the note ends the search;
// assets of tags nested in its unterminated text are not collected and fail closed.
function extractHtmlAssetRefs(markdown: string): string[] {
  let refs: string[] = [];
  let tagStart = /<(?:img|a|audio|video|source|track)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = tagStart.exec(markdown)) !== null) {
    let tag = parseTagAttributes(markdown, tagStart.lastIndex);
    if (tag === undefined) break;
    for (let attribute of tag.attributes) {
      if (attribute.name === 'src' || attribute.name === 'href') refs.push(attribute.value);
    }
    tagStart.lastIndex = tag.end;
  }
  return refs;
}

// Parse attributes from `start` (just after the tag name) up to the closing `>`. Returns where
// scanning should resume: after `>`, or at an unquoted `<`, which means this was not a tag.
function parseTagAttributes(
  text: string,
  start: number
): { attributes: { name: string; value: string }[]; end: number } | undefined {
  let attributes: { name: string; value: string }[] = [];
  let i = start;
  while (i < text.length) {
    let ch = text.charAt(i);
    if (ch === '>') return { attributes, end: i + 1 };
    if (ch === '<') return { attributes: [], end: i };
    if (/[\s/]/.test(ch)) {
      i++;
      continue;
    }
    let nameEnd = i;
    while (nameEnd < text.length && !/[\s=>/<"']/.test(text.charAt(nameEnd))) nameEnd++;
    if (nameEnd === i) {
      // A stray quote where a name should be; skip it
      i++;
      continue;
    }
    let name = text.slice(i, nameEnd).toLowerCase();
    i = nameEnd;
    while (i < text.length && /\s/.test(text.charAt(i))) i++;
    if (text.charAt(i) !== '=') {
      attributes.push({ name, value: '' });
      continue;
    }
    i++;
    while (i < text.length && /\s/.test(text.charAt(i))) i++;
    let quote = text.charAt(i);
    if (quote === '"' || quote === "'") {
      let close = text.indexOf(quote, i + 1);
      if (close === -1) return undefined;
      attributes.push({ name, value: text.slice(i + 1, close) });
      i = close + 1;
    } else {
      let valueEnd = i;
      while (valueEnd < text.length && !/[\s>"'<`=]/.test(text.charAt(valueEnd))) valueEnd++;
      attributes.push({ name, value: text.slice(i, valueEnd) });
      i = valueEnd;
    }
  }
  return undefined;
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
  // The destination and the title may each start on the next line. Matching at most one line break
  // in each gap keeps every attempt to a few lines.
  const definitionPattern =
    /^[ \t]*\[([^[\]]+)\]:[ \t]*\n?[ \t]*(<[^<>\n]+>|\S+)(?:(?:[ \t]+|[ \t]*\n[ \t]*)["'(][^"'()\n]*["')])?[ \t]*$/gim;
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
