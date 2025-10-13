import { useEffect, useMemo, useState, useRef } from 'react';
import { marked } from 'marked';
import type { TokenizerAndRendererExtension } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { MarkdownFile, BinaryFile, AssetUrlFile } from '../storage/local';
import { extractDir } from '../storage/local';
import { normalizePath } from '../lib/util';
import { resolveAssetPreview } from './asset-preview-cache';

type Props = {
  doc: MarkdownFile;
  // Pass path explicitly to eliminate any chance of routing a change
  // to the wrong note due to stale closures higher up the tree.
  onChange: (path: string, text: string) => void;
  readOnly?: boolean;
  slug: string;
  loadAsset: (path: string) => Promise<BinaryFile | AssetUrlFile | undefined>;
};

export function Editor({ doc, onChange, readOnly = false, slug, loadAsset }: Props) {
  const [text, setText] = useState(doc.content);
  const previewRef = useRef<HTMLDivElement | null>(null);

  // Reset editor when switching to a different note
  useEffect(() => {
    setText(doc.content);
  }, [doc.id]);

  // Reflect external updates to the same note (e.g., after sync/merge)
  useEffect(() => {
    if (text !== doc.content) setText(doc.content);
  }, [doc.content]);

  const onInput = (val: string) => {
    if (readOnly) return;
    setText(val);
    onChange(doc.path, val);
  };

  const html = useMemo(() => {
    configureDomPurifyOnce();
    configureMarkedOnce();
    const out = marked.parse(text, { async: false });
    const raw = typeof out === 'string' ? out : '';
    // Sanitize to prevent XSS; hooks enforce URL policy and link hygiene
    return DOMPurify.sanitize(raw, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['target', 'rel'],
    });
  }, [text]);

  // Resolve relative image sources inside the rendered Markdown preview.
  useEffect(() => {
    let container = previewRef.current;
    if (!container) return;
    let cancelled = false;
    let images = Array.from(container.querySelectorAll('img'));
    for (let img of images) {
      if (cancelled) break;
      let annotated = img.getAttribute('data-vibenote-src');
      if (!annotated) {
        let initial = img.getAttribute('src') ?? '';
        if (initial === '') continue;
        img.setAttribute('data-vibenote-src', initial);
        annotated = initial;
      }
      let assetPath = resolveAssetPath(doc.path, annotated);
      if (!assetPath) continue;
      void resolveAssetPreview({ slug, assetPath, loadAsset }).then((preview) => {
        if (cancelled || !preview) return;
        if (img.getAttribute('src') !== preview.url) {
          img.setAttribute('src', preview.url);
        }
        img.setAttribute('data-vibenote-resolved', 'true');
      });
    }
    return () => {
      cancelled = true;
    };
  }, [html, doc.path, slug, loadAsset]);

  return (
    <>
      {!readOnly && <textarea value={text} onChange={(e) => onInput(e.target.value)} spellCheck={false} />}
      <div
        ref={previewRef}
        className={`preview${readOnly ? ' preview-only' : ''}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  );
}

// Configure DOMPurify hooks once per module to enforce URL policy
let domPurifyConfigured = false;
let markedConfigured = false;

function configureDomPurifyOnce() {
  if (domPurifyConfigured) return;
  // Block dangerous URL schemes on href/src; drop malformed URLs
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    const name = data.attrName as string;
    if (name !== 'href' && name !== 'src') return;
    const value = (data.attrValue as string) || '';
    try {
      const url = new URL(value, window.location.href);
      const scheme = url.protocol.toLowerCase();
      if (scheme === 'data:' || scheme === 'javascript:') {
        data.keepAttr = false;
        (data as any).attrValue = '';
      }
    } catch {
      data.keepAttr = false;
      (data as any).attrValue = '';
    }
  });
  // Add safe attributes for external links
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    let element = node as Element;
    let tag = element.tagName;
    if (tag === 'A') {
      const a = element as HTMLAnchorElement;
      const href = a.getAttribute('href') || '';
      try {
        const url = new URL(href, window.location.href);
        const isExternal = url.origin !== window.location.origin;
        if (isExternal) {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        }
      } catch {
        // ignore
      }
      return;
    }
    if (tag === 'IMG') {
      const img = element as HTMLImageElement;
      const src = img.getAttribute('src') || '';
      if (!isRelativeAssetSrc(src)) return;
      img.setAttribute('data-vibenote-src', src);
      img.setAttribute('src', '');
    }
  });
  domPurifyConfigured = true;
}

function configureMarkedOnce() {
  if (markedConfigured) return;

  const blockMathExtension: TokenizerAndRendererExtension = {
    name: 'blockMath',
    level: 'block',
    start(src) {
      const match = src.match(/\$\$/);
      return match ? match.index : undefined;
    },
    tokenizer(src) {
      const match = /^\$\$([\s\S]+?)\$\$(?:\n+|$)/.exec(src);
      if (!match) return undefined;
      const text = (match[1] ?? '').trim();
      return {
        type: 'blockMath',
        raw: match[0],
        text,
        displayMode: true,
      };
    },
    renderer(token) {
      try {
        return katex.renderToString(token.text || '', {
          displayMode: true,
          throwOnError: false,
        });
      } catch {
        return token.text || '';
      }
    },
  };

  const inlineMathExtension: TokenizerAndRendererExtension = {
    name: 'inlineMath',
    level: 'inline',
    start(src) {
      const index = src.indexOf('$');
      return index === -1 ? undefined : index;
    },
    tokenizer(src) {
      if (src[0] !== '$' || src[1] === '$') return undefined;
      let index = 1;
      let closing = -1;
      while (index < src.length) {
        const char = src[index];
        if (char === '\\') {
          index += 2;
          continue;
        }
        if (char === '$') {
          closing = index;
          break;
        }
        if (char === '\n') return undefined;
        index += 1;
      }
      if (closing === -1) return undefined;
      const raw = src.slice(0, closing + 1);
      const text = raw.slice(1, -1);
      return {
        type: 'inlineMath',
        raw,
        text,
        displayMode: false,
      };
    },
    renderer(token) {
      try {
        return katex.renderToString(token.text || '', {
          displayMode: false,
          throwOnError: false,
        });
      } catch {
        return token.text || '';
      }
    },
  };

  marked.use({ extensions: [blockMathExtension, inlineMathExtension] });
  markedConfigured = true;
}

function resolveAssetPath(docPath: string, src: string): string | undefined {
  if (!isRelativeAssetSrc(src)) return undefined;
  let withoutQuery = stripQueryAndHash(src);
  if (withoutQuery === '') return undefined;
  let decoded = decodePathComponent(withoutQuery);
  if (decoded === undefined) return undefined;
  if (decoded.startsWith('/')) {
    return simplifyPath(decoded.slice(1));
  }
  let baseDir = extractDir(docPath);
  let combined = baseDir ? `${baseDir}/${decoded}` : decoded;
  return simplifyPath(combined);
}

function isRelativeAssetSrc(src: string): boolean {
  let trimmed = src.trim();
  if (trimmed === '') return false;
  if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) return false;
  if (trimmed.startsWith('//')) return false;
  if (trimmed.startsWith('#')) return false;
  return true;
}

function stripQueryAndHash(src: string): string {
  let limit = src.length;
  for (let i = 0; i < src.length; i++) {
    let char = src[i];
    if (char === '?' || char === '#') {
      limit = i;
      break;
    }
  }
  return src.slice(0, limit);
}

function simplifyPath(path: string): string {
  let normalized = normalizePath(path) ?? '';
  let segments = normalized.split('/');
  let stack: string[] = [];
  for (let part of segments) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

function decodePathComponent(path: string): string | undefined {
  try {
    return decodeURI(path);
  } catch {
    return undefined;
  }
}
