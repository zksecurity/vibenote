import React, { useEffect, useMemo, useState } from 'react';
import { getApiBase } from '../auth/app-auth';
import { renderMarkdown } from '../lib/markdown';

export function ViewerApp() {
  let [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let shareId = extractShareId();
    if (!shareId) {
      setState({ status: 'error', message: 'This share link is invalid.' });
      return;
    }
    document.documentElement.setAttribute('data-viewer', 'true');
    let abort = new AbortController();
    (async () => {
      try {
        let base = getApiBase();
        let resolveRes = await fetch(`${base}/api/shares/${encodeURIComponent(shareId)}/resolve`, {
          signal: abort.signal,
        });
        let resolveBody = await readJson(resolveRes);
        if (resolveRes.status === 404) {
          setState({ status: 'gone', message: 'This shared note could not be found.' });
          return;
        }
        if (resolveRes.status === 410) {
          let message = pickError(resolveBody, 'This shared note is no longer available.');
          setState({ status: 'gone', message });
          return;
        }
        if (!resolveRes.ok) {
          let message = pickError(resolveBody, 'Failed to load shared note.');
          setState({ status: 'error', message });
          return;
        }
        let share = resolveBody?.share as any;
        if (!share || typeof share.primaryFile !== 'string') {
          setState({ status: 'error', message: 'Share metadata was malformed.' });
          return;
        }
        let noteRes = await fetch(
          `${base}/api/gist-raw?share=${encodeURIComponent(shareId)}&file=${encodeURIComponent(share.primaryFile)}`,
          { signal: abort.signal }
        );
        if (!noteRes.ok) {
          let message = pickError(await readJson(noteRes), 'Failed to load note body.');
          setState({ status: 'error', message });
          return;
        }
        let markdown = await noteRes.text();
        let readyData: ViewerData = {
          shareId,
          markdown,
          title: typeof share.title === 'string' && share.title.trim().length > 0 ? share.title : null,
          createdAt: typeof share.createdAt === 'string' ? share.createdAt : null,
          expiresAt: typeof share.expiresAt === 'string' ? share.expiresAt : null,
          mode: share.mode === 'unlisted' ? 'unlisted' : 'unlisted',
          url: window.location.href,
        };
        updateHead(readyData);
        setState({ status: 'ready', data: readyData });
      } catch (error) {
        if (abort.signal.aborted) return;
        setState({ status: 'error', message: pickError(error, 'Failed to load shared note.') });
      }
    })();
    return () => abort.abort();
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="viewer-shell">
        <header className="viewer-header">
          <h1>Loading…</h1>
        </header>
        <main className="viewer-body">
          <p className="viewer-status">Fetching shared note…</p>
        </main>
      </div>
    );
  }

  if (state.status === 'error' || state.status === 'gone') {
    let message = state.message;
    return (
      <div className="viewer-shell">
        <header className="viewer-header">
          <h1>Shared note</h1>
          <span className="viewer-pill">Unlisted</span>
        </header>
        <main className="viewer-body">
          <p className="viewer-status">{message}</p>
        </main>
        <ViewerFooter />
      </div>
    );
  }

  const html = useMemo(() => {
    if (state.status !== 'ready') return '';
    return renderMarkdown(state.data.markdown);
  }, [state]);

  if (state.status === 'ready') {
    let data = state.data;
    return (
      <div className="viewer-shell">
        <header className="viewer-header">
          <div>
            <h1>{data.title ?? 'Shared note'}</h1>
            <div className="viewer-meta">
              <span className="viewer-pill">{formatMode(data.mode)}</span>
              {data.createdAt && <span>Published {formatDateDisplay(data.createdAt)}</span>}
              {data.expiresAt && <span>Expires {formatDateDisplay(data.expiresAt)}</span>}
            </div>
          </div>
          <button className="btn secondary viewer-copy" onClick={() => copyLink(data.url)}>
            Copy link
          </button>
        </header>
        <main className="viewer-body">
          <article className="viewer-note" dangerouslySetInnerHTML={{ __html: html }} />
        </main>
        <ViewerFooter />
      </div>
    );
  }

  return null;
}

type LoadingState = { status: 'loading' };
type ErrorState = { status: 'error'; message: string; data?: undefined };
type GoneState = { status: 'gone'; message: string; data?: undefined };
type ReadyState = { status: 'ready'; data: ViewerData };
type State = LoadingState | ErrorState | GoneState | ReadyState;

type ViewerData = {
  shareId: string;
  markdown: string;
  title: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  mode: 'unlisted';
  url: string;
};

function extractShareId(): string | null {
  let path = window.location.pathname.replace(/^\/+/, '');
  let [first, second] = path.split('/');
  if (first !== 's' || !second) return null;
  return second;
}

async function readJson(res: Response): Promise<any> {
  try {
    return await res.clone().json();
  } catch {
    return null;
  }
}

function pickError(payload: unknown, fallback: string): string {
  if (payload instanceof Error && payload.message) return payload.message;
  if (payload && typeof payload === 'object' && typeof (payload as any).error === 'string') {
    return String((payload as any).error);
  }
  return fallback;
}

function updateHead(data: ViewerData) {
  let title = data.title ? `${data.title} – VibeNote` : 'Shared note – VibeNote';
  document.title = title;
  setMeta('description', data.title ? `Shared note: ${data.title}` : 'Shared note on VibeNote.');
  setMeta('og:title', title);
  setMeta('og:description', 'Shared via VibeNote.');
  setMeta('og:type', 'article');
  setMeta('og:url', data.url);
  setMeta('twitter:card', 'summary_large_image');
  setMeta('twitter:title', title);
  setMeta('referrer', 'no-referrer');
}

function setMeta(name: string, value: string) {
  let meta = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = name;
    document.head.appendChild(meta);
  }
  meta.content = value;
}

let viewerDateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function formatDateDisplay(value: string): string {
  let date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return viewerDateFormatter.format(date);
}

async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // ignore clipboard failures
  }
}

function formatMode(mode: 'unlisted'): string {
  if (mode === 'unlisted') return 'Unlisted';
  return mode;
}

function ViewerFooter() {
  return (
    <footer className="viewer-footer">
      <span>
        Shared via <a href="https://vibenote.dev" target="_blank" rel="noreferrer">VibeNote</a>
      </span>
    </footer>
  );
}
