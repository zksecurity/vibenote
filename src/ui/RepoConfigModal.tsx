import React, { useEffect, useState } from 'react';
import { repoExists } from '../sync/git-sync';

interface Props {
  defaultOwner: string;
  defaultRepo?: string;
  mode: 'onboard' | 'manage';
  onSubmit: (cfg: { owner: string; repo: string; branch: string }) => void;
  onCancel: () => void;
}

export function RepoConfigModal({ defaultOwner, defaultRepo, mode, onSubmit, onCancel }: Props) {
  const [repo, setRepo] = useState(defaultRepo || 'notes');
  const [exists, setExists] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setRepo(defaultRepo || 'notes');
  }, [defaultRepo]);

  useEffect(() => {
    let cancelled = false;
    const name = repo.trim();
    if (!name) { setExists(null); return; }
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const ok = await repoExists(defaultOwner, name);
        if (!cancelled) setExists(ok);
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [defaultOwner, repo]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = repo.trim();
    if (!r) return;
    onSubmit({ owner: defaultOwner, repo: r, branch: 'main' });
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <h3>{mode === 'onboard' ? 'Set up your notes repository' : 'Change notes repository'}</h3>
        <div style={{ color: 'var(--muted)' }}>
          {mode === 'onboard'
            ? (
              <>We recommend a private repository for your notes. Enter a name to create a new repo under your account or connect to an existing one. You can skip now and continue offline; connect any time from the header.</>
            ) : (
              <>Choose the repository to connect. Type a name to connect to an existing repo or create a new private one.</>
            )}
        </div>
        <div className="toolbar" style={{ gap: 8 }}>
          <input className="input" value={defaultOwner} disabled />
          <span style={{ alignSelf:'center', color:'var(--muted)' }}>/</span>
          <input
            className="input"
            placeholder="notes"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
        </div>
        <div style={{ color:'var(--muted)', minHeight: 20 }}>
          {checking
            ? 'Checking repository…'
            : (defaultRepo && repo.trim() === defaultRepo)
              ? 'Currently connected'
              : exists === true
                ? 'Repository exists — connect to it'
                : exists === false
                  ? 'Will create a new private repository'
                  : ''}
        </div>
        <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onCancel}>{mode === 'onboard' ? 'Skip' : 'Cancel'}</button>
          <button
            type="submit"
            className="btn primary"
            disabled={Boolean(defaultRepo && repo.trim() === defaultRepo) || !repo.trim()}
          >
            {(defaultRepo && repo.trim() === defaultRepo) ? 'Already connected' : (exists ? (mode === 'onboard' ? 'Connect repository' : 'Switch to repository') : (mode === 'onboard' ? 'Create repository' : 'Create and connect'))}
          </button>
        </div>
      </form>
    </div>
  );
}
