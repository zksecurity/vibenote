// Public share viewer entry that resolves the share ref and renders the note.
import React, { useEffect, useMemo, useState } from 'react';
import { renderMarkdown } from '../lib/render-markdown';
import { fetchShareContent, fetchShareMeta, buildAssetUrl, parseShareUrl, type ShareRef, type ShareMetaResponse } from './api';

type ViewerState =
  | { status: 'loading'; ref: ShareRef }
  | { status: 'ready'; ref: ShareRef; meta: ShareMetaResponse; markdown: string }
  | { status: 'error'; message: string }
  | { status: 'not-found' };

export function ShareApp() {
  const shareRef = useMemo(parseShareUrl, []);
  const [state, setState] = useState<ViewerState>(() =>
    shareRef ? { status: 'loading', ref: shareRef } : { status: 'error', message: 'Missing share id.' }
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
    if (!shareRef) return;
    let cancelled = false;
    (async () => {
      try {
        setState({ status: 'loading', ref: shareRef });
        const contentPromise = fetchShareContent(shareRef);
        const metaRes = await fetchShareMeta(shareRef);
        if (cancelled) return;
        if (metaRes.status === 404) {
          setState({ status: 'not-found' });
          return;
        }
        if (!metaRes.ok) {
          throw Error(`Request failed (${metaRes.status})`);
        }
        const meta = (await metaRes.json()) as ShareMetaResponse;
        const contentRes = await contentPromise;
        if (cancelled) return;
        if (contentRes.status === 404) {
          setState({ status: 'error', message: 'Shared note could not be found in the repository.' });
          return;
        }
        if (!contentRes.ok) {
          throw Error(`Content request failed (${contentRes.status})`);
        }
        const markdown = await contentRes.text();
        if (cancelled) return;
        setState({ status: 'ready', ref: shareRef, meta, markdown });
      } catch (error) {
        if (cancelled) return;
        setState({ status: 'error', message: formatError(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shareRef]);

  const renderedHtml = useMemo(() => {
    if (state.status !== 'ready') return '';
    return renderShareMarkdown(state.markdown, { shareRef: state.ref });
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
              Shared by <span>@{meta.owner}</span> on{' '}
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

function renderShareMarkdown(markdown: string, options: { shareRef: ShareRef }): string {
  const sanitized = renderMarkdown(markdown, 'share');
  try {
    return rewriteAssetUrls(sanitized, options);
  } catch (error) {
    console.warn('vibenote: failed to rewrite asset URLs', error);
    return sanitized;
  }
}

function rewriteAssetUrls(html: string, options: { shareRef: ShareRef }): string {
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
      node.setAttribute(attr, buildAssetUrl(options.shareRef, trimmed));
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
