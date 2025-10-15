// Public share viewer entry that resolves the share id and renders the note.
import React, { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import type { TokenizerAndRendererExtension } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { fetchShareContent, fetchShareMeta, getApiBase, type ShareMetaResponse } from './api';

type ViewerState =
  | { status: 'loading'; id: string }
  | { status: 'ready'; id: string; meta: ShareMetaResponse; markdown: string }
  | { status: 'error'; message: string }
  | { status: 'not-found' };

export function ShareApp() {
  const shareId = useMemo(resolveShareId, []);
  const [state, setState] = useState<ViewerState>(() =>
    shareId ? { status: 'loading', id: shareId } : { status: 'error', message: 'Missing share id.' }
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const link = target.closest<HTMLAnchorElement>('a[data-share-disabled="true"]');
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.document.addEventListener('click', handleClick);
    return () => {
      window.document.removeEventListener('click', handleClick);
    };
  }, []);

  useEffect(() => {
    if (!shareId) return;
    let cancelled = false;
    (async () => {
      try {
        setState({ status: 'loading', id: shareId });
        const metaRes = await fetchShareMeta(shareId);
        if (cancelled) return;
        if (metaRes.status === 404) {
          setState({ status: 'not-found' });
          return;
        }
        if (!metaRes.ok) {
          throw new Error(`Request failed (${metaRes.status})`);
        }
        const meta = (await metaRes.json()) as ShareMetaResponse;
        const contentRes = await fetchShareContent(shareId);
        if (cancelled) return;
        if (contentRes.status === 404) {
          setState({ status: 'error', message: 'Shared note could not be found in the repository.' });
          return;
        }
        if (!contentRes.ok) {
          throw new Error(`Content request failed (${contentRes.status})`);
        }
        const markdown = await contentRes.text();
        if (cancelled) return;
        setState({ status: 'ready', id: shareId, meta, markdown });
      } catch (error) {
        if (cancelled) return;
        setState({ status: 'error', message: formatError(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shareId]);

  const renderedHtml = useMemo(() => {
    if (state.status !== 'ready') return '';
    return renderMarkdown(state.markdown, { shareId: state.id });
  }, [state]);

  if (state.status === 'loading') {
    return (
      <main className="share-app">
        <div className="share-card">
          <p className="share-status-text">Loading shared note...</p>
        </div>
      </main>
    );
  }

  if (state.status === 'not-found') {
    return (
      <main className="share-app">
        <div className="share-card">
          <h1>This share link doesn&apos;t exist.</h1>
          <p>The link may be mistyped or revoked.</p>
        </div>
      </main>
    );
  }

  if (state.status === 'error') {
    return (
      <main className="share-app">
        <div className="share-card">
          <h1>We couldn&apos;t load that note.</h1>
          <p>{state.message}</p>
        </div>
      </main>
    );
  }

  const { meta } = state;

  return (
    <div className="share-layout">
      <main className="share-main">
        <article className="share-article">
          <header className="share-article-header">
            <p className="share-shared-by">
              Shared by <span>@{meta.createdBy.login}</span> on{' '}
              <a href="https://vibenote.dev" target="_blank" rel="noopener noreferrer">
                VibeNote
              </a>
            </p>
          </header>
          <div className="share-content" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
        </article>
      </main>
    </div>
  );
}

function resolveShareId(): string | null {
  try {
    const { pathname, search, hash } = window.location;
    const pathMatch = pathname.match(/\/s\/([A-Za-z0-9_-]{6,})/);
    if (pathMatch && pathMatch[1]) return pathMatch[1];
    const params = new URLSearchParams(search);
    const viaQuery = params.get('id');
    if (viaQuery) return viaQuery;
    if (hash) {
      const trimmed = hash.replace(/^#/, '');
      if (trimmed.startsWith('s/')) return trimmed.slice(2);
      if (trimmed.startsWith('id=')) return trimmed.slice(3);
    }
  } catch {
    // ignore and fall through
  }
  return null;
}

function renderMarkdown(markdown: string, options: { shareId: string }): string {
  configureDomPurifyOnce();
  configureMarkedOnce();
  const raw = marked.parse(markdown, { async: false });
  const html = typeof raw === 'string' ? raw : '';
  const sanitized = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ['target', 'rel'] });
  try {
    return rewriteAssetUrls(sanitized, options);
  } catch (error) {
    console.warn('vibenote: failed to rewrite asset URLs', error);
    return sanitized;
  }
}

function rewriteAssetUrls(html: string, options: { shareId: string }): string {
  if (typeof window === 'undefined') return html;
  const container = document.createElement('div');
  container.innerHTML = html;
  const nodes = container.querySelectorAll<HTMLElement>('[src], [href]');
  for (const node of nodes) {
    for (const attr of ['src', 'href']) {
      if (!node.hasAttribute(attr)) continue;
      const value = node.getAttribute(attr);
      if (!value) continue;
      const trimmed = value.trim();
      if (!isRelativeAssetUrl(trimmed)) continue;
      if (isBlockedAttachment(trimmed)) {
        if (node instanceof HTMLAnchorElement && attr === 'href') {
          disableShareLink(node);
        } else {
          node.removeAttribute(attr);
        }
        continue;
      }
      node.setAttribute(attr, buildAssetUrl(options.shareId, trimmed));
    }
  }
  return container.innerHTML;
}

function isRelativeAssetUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith('#')) return false;
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith('http://') || lowered.startsWith('https://')) return false;
  if (lowered.startsWith('data:') || lowered.startsWith('mailto:') || lowered.startsWith('tel:'))
    return false;
  if (lowered.startsWith('//')) return false;
  return true;
}

function buildAssetUrl(shareId: string, relativePath: string): string {
  const params = new URLSearchParams({ path: relativePath });
  return `${getApiBase()}/v1/share-links/${encodeURIComponent(shareId)}/assets?${params.toString()}`;
}

let domPurifyConfigured = false;
let markedConfigured = false;

function configureDomPurifyOnce() {
  if (domPurifyConfigured) return;
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
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if ((node as Element).tagName === 'A') {
      const a = node as HTMLAnchorElement;
      const href = a.getAttribute('href') || '';
      try {
        const url = new URL(href, window.location.href);
        const isExternal = url.origin !== window.location.origin;
        if (isExternal) {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        }
      } catch {
        // ignore invalid URLs
      }
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
      const match = src.match(/\\$\\$/);
      return match ? match.index : undefined;
    },
    tokenizer(src) {
      const match = /^\\$\\$([\\s\\S]+?)\\$\\$(?:\\n+|$)/.exec(src);
      if (!match) return undefined;
      const text = (match[1] ?? '').trim();
      return { type: 'blockMath', raw: match[0], text, displayMode: true };
    },
    renderer(token) {
      try {
        return katex.renderToString(token.text || '', { displayMode: true, throwOnError: false });
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
        if (char === '\\\\') {
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
      return { type: 'inlineMath', raw, text, displayMode: false };
    },
    renderer(token) {
      try {
        return katex.renderToString(token.text || '', { displayMode: false, throwOnError: false });
      } catch {
        return token.text || '';
      }
    },
  };
  marked.use({ extensions: [blockMathExtension, inlineMathExtension] });
  markedConfigured = true;
}

function formatError(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') return error.message;
  return String(error);
}

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

const DISABLED_LINK_TOOLTIP = 'This link is not available in the shared view.';

function isBlockedAttachment(pathValue: string): boolean {
  const lower = pathValue.toLowerCase();
  const clean = lower.split(/[?#]/, 1)[0] ?? lower;
  const dotIndex = clean.lastIndexOf('.');
  if (dotIndex === -1) return false;
  const extension = clean.slice(dotIndex);
  return BLOCKED_ASSET_EXTENSIONS.has(extension);
}

function disableShareLink(anchor: HTMLAnchorElement): void {
  anchor.setAttribute('href', '#');
  anchor.setAttribute('data-share-disabled', 'true');
  anchor.setAttribute('aria-disabled', 'true');
  anchor.removeAttribute('target');
  anchor.removeAttribute('rel');
  if (!anchor.getAttribute('title')) {
    anchor.setAttribute('title', DISABLED_LINK_TOOLTIP);
  }
}
