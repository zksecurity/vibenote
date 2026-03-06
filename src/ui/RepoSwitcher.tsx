import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { AppAction } from '../data';
import type { RecentRepo } from '../storage/local';
import { useOnClickOutside } from './useOnClickOutside';

type Props = {
  dispatch: (action: AppAction) => void;
  probe: {
    status: 'idle' | 'checking' | 'ready';
    owner?: string;
    repo?: string;
    exists?: boolean;
  };
  recents: RecentRepo[];
  onClose: () => void;
  triggerRef?: RefObject<HTMLElement | null>;
};

type Parsed = { owner: string; repo: string } | null;

function parseOwnerRepo(input: string): Parsed {
  const s = input.trim().replace(/^\/+|\/+$/g, '');
  const [owner, repo] = s.split('/', 2);
  if (!owner || !repo) return null;
  return { owner, repo };
}

export function RepoSwitcher({ dispatch, probe, recents, onClose, triggerRef }: Props) {
  const [input, setInput] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const panelRef = useOnClickOutside(onClose, { trigger: triggerRef });
  const inputRef = useRef<HTMLInputElement | null>(null);

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
    const parsed = parseOwnerRepo(input);
    if (!parsed) {
      return;
    }
    const t = setTimeout(async () => {
      dispatch({ type: 'repo.probe', owner: parsed.owner, repo: parsed.repo });
    }, 300);
    return () => {
      clearTimeout(t);
    };
  }, [dispatch, input]);

  const goTo = (owner: string, repo: string) => {
    dispatch({ type: 'repo.activate', repo: { kind: 'github', owner, repo } });
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
  const probeMatchesInput =
    parsed !== null &&
    probe.owner?.toLowerCase() === parsed.owner.toLowerCase() &&
    probe.repo?.toLowerCase() === parsed.repo.toLowerCase();
  const checking = probeMatchesInput && probe.status === 'checking';
  const exists = probeMatchesInput && probe.status === 'ready' ? (probe.exists ?? null) : null;

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
