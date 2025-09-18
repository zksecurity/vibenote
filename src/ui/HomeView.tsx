import React from 'react';
import type { Route } from './routing';
import type { RecentRepo } from '../storage/local';

type HomeViewProps = {
  recents: RecentRepo[];
  navigate: (route: Route, options?: { replace?: boolean }) => void;
};

export function HomeView({ recents, navigate }: HomeViewProps) {
  const repos = recents.filter((entry) => entry.slug !== 'new');
  const hasRepos = repos.length > 0;

  const openEntry = (entry: RecentRepo) => {
    if (entry.owner && entry.repo) {
      navigate({ kind: 'repo', owner: entry.owner, repo: entry.repo });
      return;
    }
    const [owner, repo] = entry.slug.split('/', 2);
    if (owner && repo) navigate({ kind: 'repo', owner, repo });
  };

  const renderLabel = (entry: RecentRepo) => {
    if (entry.owner && entry.repo) return `${entry.owner}/${entry.repo}`;
    return entry.slug;
  };

  const goCreateRepo = () => {
    navigate({ kind: 'new' });
  };

  return (
    <div className="app-shell home-shell">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">VibeNote</span>
        </div>
        <div className="topbar-actions" />
      </header>
      <main className="home-main">
        <section className="home-header">
          <div>
            <h1>Recent repositories</h1>
            <p>Jump back into your notes or connect a new GitHub repo.</p>
          </div>
          <button className="btn primary" onClick={goCreateRepo}>
            Create notes repository
          </button>
        </section>
        {hasRepos ? (
          <ul className="home-recents">
            {repos.map((entry) => (
              <li key={entry.slug}>
                <button className="home-repo" onClick={() => openEntry(entry)}>
                  <span className="home-repo-label">{renderLabel(entry)}</span>
                  <span aria-hidden className="home-repo-arrow">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
                      <path d="M6 12 10 8 6 4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <section className="home-empty">
            <h2>Connect your first repository</h2>
            <p>Bring an existing GitHub notes repo into VibeNote to get started.</p>
            <button className="btn primary" onClick={goCreateRepo}>
              Create notes repository
            </button>
          </section>
        )}
      </main>
    </div>
  );
}
