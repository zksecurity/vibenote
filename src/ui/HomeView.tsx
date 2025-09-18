import React from 'react';
import type { Route } from './routing';
import type { RecentRepo } from '../storage/local';

type HomeViewProps = {
  recents: RecentRepo[];
  navigate: (route: Route, options?: { replace?: boolean }) => void;
};

export function HomeView({ recents, navigate }: HomeViewProps) {
  let hasRepos = recents.length > 0;

  const openEntry = (entry: RecentRepo) => {
    if (entry.slug === 'new') {
      navigate({ kind: 'new' });
      return;
    }
    let owner = entry.owner;
    let repo = entry.repo;
    if (!owner || !repo) {
      let [fallbackOwner, fallbackRepo] = entry.slug.split('/', 2);
      owner = fallbackOwner;
      repo = fallbackRepo;
    }
    if (!owner || !repo) return;
    navigate({ kind: 'repo', owner, repo });
  };

  const renderLabel = (entry: RecentRepo) => {
    if (entry.title) return entry.title;
    if (entry.owner && entry.repo) return `${entry.owner}/${entry.repo}`;
    if (entry.slug === 'new') return 'Local scratchpad';
    return entry.slug;
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">VibeNote</span>
        </div>
        <div className="topbar-actions">
          <button className="btn primary" onClick={() => navigate({ kind: 'new' })}>
            Start new notebook
          </button>
        </div>
      </header>
      <div className="app-layout">
        <section className="workspace" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <div className="empty-state" style={{ maxWidth: 480 }}>
            <h2>Welcome to VibeNote</h2>
            <p>Select a repository below or start a fresh scratchpad.</p>
            {hasRepos ? (
              <div style={{ width: '100%', marginTop: 24 }}>
                <div style={{ fontWeight: 600, textAlign: 'left', marginBottom: 8 }}>Recent repositories</div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
                  {recents.map((entry) => (
                    <li key={entry.slug}>
                      <button
                        className="btn secondary"
                        style={{ width: '100%', justifyContent: 'space-between', alignItems: 'center' }}
                        onClick={() => openEntry(entry)}
                      >
                        <span>
                          {renderLabel(entry)}
                        </span>
                        <span aria-hidden>→</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p style={{ marginTop: 24 }}>No repositories yet. Start with a scratchpad to try things out.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
