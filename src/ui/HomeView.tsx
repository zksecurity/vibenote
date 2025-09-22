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

  const goToSetup = () => {
    navigate({ kind: 'new' });
  };

  return (
    <div className="app-shell home-shell">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">VibeNote</span>
        </div>
        <div className="topbar-actions">
          <button className="btn secondary" onClick={goToSetup}>
            Create notes repository
          </button>
        </div>
      </header>
      <main className="home-main">
        <section className="home-hero">
          <div className="home-hero-text">
            <h1>Bring your notes to GitHub</h1>
            <p>Turn a repository into a Markdown notebook with offline-first editing and quick GitHub sync.</p>
            <div className="home-hero-actions">
              <button className="btn primary" onClick={goToSetup}>
                Create notes repository
              </button>
              <button className="btn ghost" onClick={goToSetup}>
                Link existing repository
              </button>
            </div>
          </div>
          <div className="home-hero-card">
            <h2>Why VibeNote?</h2>
            <ul>
              <li>Notes stay as Markdown files in your repo</li>
              <li>Offline-first editing with optimistic sync</li>
              <li>Automatic merges powered by Y.js</li>
            </ul>
          </div>
        </section>
        {hasRepos ? (
          <section className="home-recents-section">
            <div className="home-recents-header">
              <h2>Recent repositories</h2>
              <p>Pick up where you left off.</p>
            </div>
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
          </section>
        ) : (
          <section className="home-empty">
            <h2>Connect your first repository</h2>
            <p>Start a fresh notes repo on GitHub or link one you already use.</p>
            <button className="btn primary" onClick={goToSetup}>
              Create notes repository
            </button>
          </section>
        )}
      </main>
    </div>
  );
}
