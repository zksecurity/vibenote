import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Route } from './routing';
import { listRecentRepos, markRepoLinked, type RecentRepo } from '../storage/local';
import { buildRemoteConfig, commitBatch, listNoteFiles, pullNote, repoExists, ensureRepoExists, type RemoteConfig } from '../sync/git-sync';
import { ensureIntroReadme } from '../sync/readme';
import { LocalStore } from '../storage/local';

type Props = {
  accountOwner: string | null;
  route: Route;
  slug: string;
  navigate: (route: Route, options?: { replace?: boolean }) => void;
  onClose: () => void;
  onRecordRecent: (entry: { slug: string; owner?: string; repo?: string; connected?: boolean }) => void;
};

type Parsed = { owner: string; repo: string } | null;

function parseOwnerRepo(input: string): Parsed {
  const s = input.trim().replace(/^\/+|\/+$/g, '');
  const [owner, repo] = s.split('/', 2);
  if (!owner || !repo) return null;
  return { owner, repo };
}

export function RepoSwitcher({ accountOwner, route, slug, navigate, onClose, onRecordRecent }: Props) {
  const [input, setInput] = useState('');
  const [recents, setRecents] = useState<RecentRepo[]>(() => listRecentRepos());
  const [checking, setChecking] = useState(false);
  const [exists, setExists] = useState<boolean | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setRecents(listRecentRepos());
  }, [route]);

  useEffect(() => {
    // focus input on open
    inputRef.current?.focus();
    const openedAt = performance.now();
    const onDoc = (e: MouseEvent) => {
      // ignore the opening click that triggered the switcher
      if (performance.now() - openedAt < 200) return;
      const el = e.target as HTMLElement;
      if (!panelRef.current) return;
      if (!el.closest('.repo-switcher-panel')) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('click', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  const suggestions = useMemo(() => {
    const q = input.trim().toLowerCase();
    const base = recents.filter((r) => r.slug !== slug);
    if (!q) return base.slice(0, 8);
    const score = (slug: string) => (slug.toLowerCase().startsWith(q) ? 0 : slug.toLowerCase().includes(q) ? 1 : 2);
    return base
      .slice()
      .sort((a, b) => score(a.slug) - score(b.slug) || b.lastOpenedAt - a.lastOpenedAt)
      .filter((r) => r.slug.toLowerCase().includes(q))
      .slice(0, 8);
  }, [input, recents, slug]);

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

  const createRepo = async (owner: string, repo: string) => {
    if (!accountOwner || accountOwner !== owner) return;
    const confirmed = window.confirm(`Create private repository ${owner}/${repo}?`);
    if (!confirmed) return;
    const ok = await ensureRepoExists(owner, repo, true);
    if (!ok) return;
    const targetSlug = `${owner}/${repo}`;
    markRepoLinked(targetSlug);
    const config: RemoteConfig = buildRemoteConfig(targetSlug);
    // If creating for current slug and it had local notes, seed them
    const matchesCurrent = slug === targetSlug;
    if (matchesCurrent) {
      const local = new LocalStore(targetSlug, { seedWelcome: false });
      const files: { path: string; text: string; baseSha?: string }[] = [];
      for (const meta of local.listNotes()) {
        const doc = local.loadNote(meta.id);
        if (doc) files.push({ path: doc.path, text: doc.text });
      }
      if (files.length > 0) await commitBatch(config, files, 'vibenote: initialize notes');
    }
    await ensureIntroReadme(config);
    // Pull remote notes to hydrate local namespace
    const entries = await listNoteFiles(config);
    const remoteFiles: { path: string; text: string; sha?: string }[] = [];
    for (const entry of entries) {
      const rf = await pullNote(config, entry.path);
      if (rf) remoteFiles.push({ path: rf.path, text: rf.text, sha: rf.sha });
    }
    const targetStore = new LocalStore(targetSlug, { seedWelcome: false });
    targetStore.replaceWithRemote(remoteFiles);
    goTo(owner, repo);
  };

  const parsed = parseOwnerRepo(input);
  const canCreate = Boolean(parsed && accountOwner && parsed.owner === accountOwner && exists === false);

  const statusText = checking
    ? 'Checking repository…'
    : parsed
    ? exists === true
      ? 'Press Enter to open'
      : exists === false
      ? accountOwner && parsed.owner === accountOwner
        ? 'Repo not found — you can create it'
        : 'Repo not found or no access'
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
        {canCreate && (
          <button className="btn secondary" onClick={() => parsed && createRepo(parsed.owner, parsed.repo)}>
            Create repo
          </button>
        )}
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
              <span className="repo-switcher-slug">{s.owner && s.repo ? `${s.owner}/${s.repo}` : s.slug}</span>
              {s.connected ? <span className="repo-switcher-connected">linked</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
