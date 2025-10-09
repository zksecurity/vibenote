// Markdown asset discovery and rewrite helpers for sharing pipeline.
import path from 'node:path';

export type { MarkdownAssetRef };
export { extractMarkdownAssets, rewriteMarkdownAssets };

type MarkdownAssetRef = {
  raw: string;
  normalized: string;
};

const LINK_PATTERN = /(!?\[[^\]]*\]\(([^)]+)\))/g;
const HTML_IMG_PATTERN = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;

function extractMarkdownAssets(markdown: string): MarkdownAssetRef[] {
  let refs: MarkdownAssetRef[] = [];

  let linkMatch: RegExpExecArray | null;
  LINK_PATTERN.lastIndex = 0;
  while ((linkMatch = LINK_PATTERN.exec(markdown)) !== null) {
    let full = linkMatch[1] ?? '';
    let target = linkMatch[2] ?? '';
    let parsed = parseCandidate(target);
    if (parsed === undefined) continue;
    refs.push(parsed);
  }

  let htmlMatch: RegExpExecArray | null;
  while ((htmlMatch = HTML_IMG_PATTERN.exec(markdown)) !== null) {
    let target = htmlMatch[1] ?? '';
    let parsed = parseCandidate(target);
    if (parsed === undefined) continue;
    refs.push(parsed);
  }

  return refs;
}

function parseCandidate(value: string): MarkdownAssetRef | undefined {
  let trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  let withoutTitle = trimmed.replace(/\s+(['"]).*$/, '');
  let raw = withoutTitle;
  let cleaned = withoutTitle.split('#')[0]?.split('?')[0] ?? '';
  if (cleaned.startsWith('http://') || cleaned.startsWith('https://')) return undefined;
  if (cleaned.startsWith('data:') || cleaned.startsWith('javascript:')) return undefined;
  if (cleaned.startsWith('//')) return undefined;
  if (cleaned.startsWith('mailto:')) return undefined;
  let normalized = normalizeRelativePath(cleaned);
  if (normalized === undefined) return undefined;
  return { raw, normalized };
}

function normalizeRelativePath(candidate: string): string | undefined {
  let stripped = candidate.replace(/^\.\//, '');
  if (stripped.trim().length === 0) return undefined;
  if (stripped.startsWith('/')) return undefined;
  let normalized = path.posix.normalize(stripped);
  if (normalized.startsWith('../') || normalized === '..' || normalized.includes('/../')) {
    return undefined;
  }
  return normalized;
}

function rewriteMarkdownAssets(markdown: string, replacements: Map<string, string>): string {
  if (replacements.size === 0) return markdown;
  let updated = markdown;
  for (let [original, next] of replacements.entries()) {
    let pattern = buildReplacePattern(original);
    updated = updated.replace(pattern, (...args: string[]) => {
      let match = args[0] ?? '';
      let mdPrefix = args[1];
      let mdUrl = args[2];
      let mdSuffix = args[3];
      let htmlPrefix = args[4];
      let htmlUrl = args[5];
      let htmlSuffix = args[6];
      if (mdPrefix !== undefined && mdUrl !== undefined && mdSuffix !== undefined) {
        let replacedUrl = replaceUrl(mdUrl, next);
        return `${mdPrefix}${replacedUrl}${mdSuffix}`;
      }
      if (htmlPrefix !== undefined && htmlUrl !== undefined && htmlSuffix !== undefined) {
        let replacedUrl = replaceUrl(htmlUrl, next);
        return `${htmlPrefix}${replacedUrl}${htmlSuffix}`;
      }
      return match;
    });
  }
  return updated;
}

function buildReplacePattern(target: string): RegExp {
  let escaped = escapeForRegex(target);
  return new RegExp(`(!?\\[[^\\]]*\\]\\()(${escaped})([^)]*\\))|(<img\\s+[^>]*src=["'])(${escaped})(["'][^>]*>)`, 'g');
}

function replaceUrl(current: string, next: string): string {
  return next;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
