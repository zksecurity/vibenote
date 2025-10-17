import React, { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Route } from './routing';
import { listRecentRepos, type RecentRepo } from '../storage/local';
import { repoExists } from '../sync/git-sync';
import { useOnClickOutside } from './useOnClickOutside';

type Props = {
  route: Route;
  slug: string;
  navigate: (route: Route, options?: { replace?: boolean }) => void;
  onClose: () => void;
  onRecordRecent: (entry: { slug: string; owner?: string; repo?: string; connected?: boolean }) => void;
  triggerRef?: RefObject<HTMLElement | null>;
};

type Parsed = { owner: string; repo: string } | null;

function parseOwnerRepo(input: string): Parsed {
  const s = input.trim().replace(/^\/+|\/+$/g, '');
  const [owner, repo] = s.split('/', 2);
  if (!owner || !repo) return null;
  return { owner, repo };
}

export function RepoSwitcher({ route, slug, navigate, onClose, onRecordRecent, triggerRef }: Props) {
  const [input, setInput] = useState('');
  const [recents, setRecents] = useState<RecentRepo[]>(() => listRecentRepos());
  const [checking, setChecking] = useState(false);
  const [exists, setExists] = useState<boolean | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const panelRef = useOnClickOutside(onClose, { trigger: triggerRef });
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setRecents(listRecentRepos());
  }, [route]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const suggestions = useMemo(() => {
    const q = input.trim().toLowerCase();
    const base = recents;
    if (!q) return base.slice(0, 8);
    const score = (slug: string) =>
      slug.toLowerCase().startsWith(q) ? 0 : slug.toLowerCase().includes(q) ? 1 : 2;
    return base
      .slice()
      .sort((a, b) => score(a.slug) - score(b.slug) || b.lastOpenedAt - a.lastOpenedAt)
      .filter((r) => r.slug.toLowerCase().includes(q))
      .slice(0, 8);
  }, [input, recents]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [suggestions.length]);

  // Debounced existence check for precise owner/repo inputs
  useEffect(() => {
    let cancel = false;
    const parsed = parseOwnerRepo(input);
    if (!parsed) {
      setExists(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const ok = await repoExists(parsed.owner, parsed.repo);
        if (!cancel) setExists(ok);
      } finally {
        if (!cancel) setChecking(false);
      }
    }, 300);
    return () => {
      cancel = true;
      clearTimeout(t);
    };
  }, [input]);

  const goTo = (owner: string, repo: string) => {
    onRecordRecent({ slug: `${owner}/${repo}`, owner, repo });
    navigate({ kind: 'repo', owner, repo });
    onClose();
  };

  const onEnter = () => {
    const parsed = parseOwnerRepo(input);
    if (selectedIndex >= 0 && suggestions[selectedIndex]) {
      const s = suggestions[selectedIndex];
      const [o, r] = s.slug.split('/', 2);
      if (o && r) {
        goTo(o, r);
        return;
      }
    }
    if (parsed) goTo(parsed.owner, parsed.repo);
  };

  const parsed = parseOwnerRepo(input);

  const statusText = checking
    ? 'Checking repository…'
    : parsed
    ? exists === true
      ? 'Press Enter to open'
      : exists === false
      ? 'Repo not found or no access'
      : 'Type owner/repo to open'
    : 'Type owner/repo or choose a recent';

  return (
    <div ref={panelRef} className="repo-switcher-panel" onClick={(e) => e.stopPropagation()}>
      <div className="repo-switcher-input-row">
        <input
          ref={inputRef}
          className="input repo-switcher-input"
          placeholder="owner/repo"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onEnter();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelectedIndex((i) => Math.min(i + 1, Math.max(0, suggestions.length - 1)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelectedIndex((i) => Math.max(0, i - 1));
            }
          }}
        />
      </div>
      <div className="repo-switcher-status">{statusText}</div>
      <ul className="repo-switcher-list">
        {suggestions.map((s, idx) => (
          <li key={s.slug}>
            <button
              className={`repo-switcher-item ${idx === selectedIndex ? 'active' : ''}`}
              onMouseEnter={() => setSelectedIndex(idx)}
              onClick={() => {
                const [o, r] = s.slug.split('/', 2);
                if (o && r) goTo(o, r);
              }}
            >
              <span className="repo-switcher-slug">
                {s.owner && s.repo ? `${s.owner}/${s.repo}` : s.slug}
              </span>
              {s.connected ? <span className="repo-switcher-connected">linked</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
