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
        <div className="topbar-actions">
          <button className="btn secondary" onClick={goCreateRepo}>
            New repository
          </button>
        </div>
      </header>
      <main className="home-main">
        <section className="home-hero">
          <div className="home-hero-text">
            <h1>Keep your release notes in sync</h1>
            <p>
              Spin up a dedicated notes repository on GitHub and share shipping context with your
              team in minutes.
            </p>
          </div>
          <div className="home-hero-actions">
            <button className="btn primary" onClick={goCreateRepo}>
              Create notes repository
            </button>
            <button className="btn ghost" onClick={goCreateRepo}>
              Link existing repo
            </button>
          </div>
        </section>
        {hasRepos ? (
          <section className="home-section">
            <div className="home-section-header">
              <h2>Recent repositories</h2>
              <button className="btn subtle" onClick={goCreateRepo}>
                Connect another
              </button>
            </div>
            <p className="home-section-subtitle">Jump back into a repo you've opened recently.</p>
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
          <section className="home-empty-card">
            <h2>Create your first notes repository</h2>
            <p>
              We'll initialize a private repo under your GitHub account with a README so teammates know
              how to contribute.
            </p>
            <div className="home-empty-actions">
              <button className="btn primary" onClick={goCreateRepo}>
                Create notes repository
              </button>
              <button className="btn ghost" onClick={goCreateRepo}>
                Link existing repo
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
