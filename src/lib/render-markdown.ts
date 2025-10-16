// Shared Markdown rendering utilities for the editor and public share viewer.
import { marked } from 'marked';
import type { TokenizerAndRendererExtension } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';

export type { MarkdownRenderMode };
export { renderMarkdown };

type MarkdownRenderMode = 'editor' | 'share';

let domPurifyConfigured = false;
let markedConfigured = false;
let currentMode: MarkdownRenderMode = 'share';

function renderMarkdown(markdown: string, mode: MarkdownRenderMode): string {
  configureDomPurifyOnce();
  configureMarkedOnce();
  let previousMode = currentMode;
  currentMode = mode;
  try {
    let raw = marked.parse(markdown, { async: false });
    let html = typeof raw === 'string' ? raw : '';
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['target', 'rel'],
    });
  } finally {
    currentMode = previousMode;
  }
}

function configureDomPurifyOnce() {
  if (domPurifyConfigured) return;
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    let name = data.attrName as string;
    if (name !== 'href' && name !== 'src') {
      return;
    }
    let value = (data.attrValue as string) || '';
    try {
      let url = new URL(value, window.location.href);
      let scheme = url.protocol.toLowerCase();
      if (scheme === 'data:' || scheme === 'javascript:') {
        data.keepAttr = false;
        (data as any).attrValue = '';
      }
    } catch {
      data.keepAttr = false;
      (data as any).attrValue = '';
    }
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    let element = node as Element;
    let tag = element.tagName;
    if (tag === 'A') {
      let a = element as HTMLAnchorElement;
      let href = a.getAttribute('href') || '';
      try {
        let url = new URL(href, window.location.href);
        let isExternal = url.origin !== window.location.origin;
        if (isExternal) {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        }
      } catch {
        // ignore invalid URLs
      }
      return;
    }
    if (tag === 'IMG' && currentMode === 'editor') {
      let img = element as HTMLImageElement;
      img.style.maxWidth = '100%';
      let src = img.getAttribute('src') || '';
      if (!isRelativeReference(src)) {
        return;
      }
      img.setAttribute('data-vibenote-src', src);
      img.setAttribute('src', '');
    }
  });
  domPurifyConfigured = true;
}

function configureMarkedOnce() {
  if (markedConfigured) return;
  let blockMathExtension: TokenizerAndRendererExtension = {
    name: 'blockMath',
    level: 'block',
    start(src) {
      let match = src.match(/\$\$/);
      return match ? match.index : undefined;
    },
    tokenizer(src) {
      let match = /^\$\$([\s\S]+?)\$\$(?:\n+|$)/.exec(src);
      if (!match) return undefined;
      let text = (match[1] ?? '').trim();
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
  let inlineMathExtension: TokenizerAndRendererExtension = {
    name: 'inlineMath',
    level: 'inline',
    start(src) {
      let index = src.indexOf('$');
      return index === -1 ? undefined : index;
    },
    tokenizer(src) {
      if (src[0] !== '$' || src[1] === '$') return undefined;
      let index = 1;
      let closing = -1;
      while (index < src.length) {
        let char = src[index];
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
      let raw = src.slice(0, closing + 1);
      let text = raw.slice(1, -1);
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

function isRelativeReference(value: string): boolean {
  let trimmed = value.trim();
  if (trimmed === '') return false;
  if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) return false;
  if (trimmed.startsWith('//')) return false;
  if (trimmed.startsWith('#')) return false;
  return true;
}
