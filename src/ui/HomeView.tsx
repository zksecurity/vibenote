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
  const latestRepo = hasRepos ? repos[0] : null;

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

  const goMostRecent = () => {
    if (latestRepo) openEntry(latestRepo);
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
        <section className="home-hero">
          <div className="home-hero-text">
            <span className="home-pill">GitHub-native notes</span>
            <h1>Spin up your notes workspace</h1>
            <p>
              VibeNote keeps Markdown notes in your own GitHub repository so everything stays
              versioned, reviewable, and yours.
            </p>
            <div className="home-actions">
              <button className="btn primary" onClick={goCreateRepo}>
                Create notes repository
              </button>
              {latestRepo ? (
                <button className="btn secondary" onClick={goMostRecent}>
                  Open most recent
                </button>
              ) : null}
            </div>
          </div>
          <div className="home-hero-card">
            <h2>How it works</h2>
            <ol className="home-steps">
              <li>Connect GitHub using the secure device flow.</li>
              <li>Choose or create the repository that should store your Markdown notes.</li>
              <li>Write offline and sync when you're ready to push changes.</li>
            </ol>
          </div>
        </section>
        {hasRepos ? (
          <section className="home-section">
            <div className="home-section-header">
              <h2>Recent workspaces</h2>
              <p>Pick a repository to jump straight back into your notes.</p>
            </div>
            <ul className="home-recents">
              {repos.map((entry) => (
                <li key={entry.slug}>
                  <button className="home-repo" onClick={() => openEntry(entry)}>
                    <span className="home-repo-label">{renderLabel(entry)}</span>
                    <span aria-hidden className="home-repo-arrow">
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
                        <path
                          d="M6 12 10 8 6 4"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <section className="home-section">
            <div className="home-section-header">
              <h2>Recent workspaces</h2>
              <p>Once you connect a repo it will appear here for quick access.</p>
            </div>
            <div className="home-empty">
              <h3>No repositories yet</h3>
              <p>Create or link a repository to see it here.</p>
              <button className="btn primary" onClick={goCreateRepo}>
                Create notes repository
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
