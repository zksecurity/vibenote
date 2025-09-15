import React, { useEffect, useState } from 'react';
import { repoExists } from '../sync/git-sync';

interface Props {
  defaultOwner: string;
  defaultRepo?: string;
  onSubmit: (cfg: { owner: string; repo: string; branch: string }) => void;
  onCancel: () => void;
}

export function RepoConfigModal({ defaultOwner, defaultRepo, onSubmit, onCancel }: Props) {
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
        <h3>Create your notes repo (optional)</h3>
        <div style={{ color: 'var(--muted)' }}>
          We recommend a private repository for your notes.
          Enter a name to create or connect a repo under your account. You can skip and continue offline.
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
          {checking ? 'Checking repository…' : exists === true ? 'Repository exists — connect to it' : exists === false ? 'Will create a new private repository' : ''}
        </div>
        <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onCancel}>Skip</button>
          <button type="submit" className="btn primary">{exists ? 'Connect repository' : 'Create repository'}</button>
        </div>
      </form>
    </div>
  );
}
