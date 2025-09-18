import React, { useEffect, useState } from 'react';
import { repoExists } from '../sync/git-sync';

interface Props {
  accountOwner: string;
  initialOwner?: string;
  initialRepo?: string;
  mode: 'onboard' | 'manage';
  onSubmit: (cfg: { owner: string; repo: string; branch: string }) => void;
  onCancel: () => void;
}

export function RepoConfigModal({
  accountOwner,
  initialOwner,
  initialRepo,
  mode,
  onSubmit,
  onCancel,
}: Props) {
  const [owner, setOwner] = useState(initialOwner || accountOwner);
  const [repo, setRepo] = useState(initialRepo || 'notes');
  const [exists, setExists] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setOwner(initialOwner || accountOwner);
  }, [accountOwner, initialOwner, mode]);

  useEffect(() => {
    setRepo(initialRepo || 'notes');
  }, [initialRepo, mode]);

  useEffect(() => {
    let cancelled = false;
    const targetOwner = owner.trim();
    const targetRepo = repo.trim();
    if (!targetOwner || !targetRepo) {
      setExists(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const ok = await repoExists(targetOwner, targetRepo);
        if (!cancelled) setExists(ok);
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [owner, repo]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const o = owner.trim();
    const r = repo.trim();
    if (!o || !r) return;
    onSubmit({ owner: o, repo: r, branch: 'main' });
  };

  const trimmedOwner = owner.trim();
  const trimmedRepo = repo.trim();
  const originalRepo = initialRepo ?? '';
  const initialOwnerValue = initialOwner || accountOwner;
  const unchanged = Boolean(initialRepo) && trimmedOwner === initialOwnerValue && trimmedRepo === originalRepo;
  const ownerMatchesAccount = trimmedOwner === accountOwner;
  const blockedCreate = exists === false && !ownerMatchesAccount;
  const submitDisabled = unchanged || !trimmedOwner || !trimmedRepo || blockedCreate;

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
          <input
            className="input"
            placeholder={accountOwner}
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          />
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
            : unchanged
              ? 'Currently connected'
              : exists === true
                ? 'Repository exists — connect to it'
                : exists === false
                  ? ownerMatchesAccount
                    ? 'Will create a new private repository'
                    : 'Repository not found. Enter one you already have access to.'
                  : ''}
        </div>
        <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onCancel}>{mode === 'onboard' ? 'Skip' : 'Cancel'}</button>
          <button
            type="submit"
            className="btn primary"
            disabled={submitDisabled}
          >
            {unchanged
              ? 'Already connected'
              : exists === true
                ? (mode === 'onboard' ? 'Connect repository' : 'Switch to repository')
                : exists === false && ownerMatchesAccount
                  ? (mode === 'onboard' ? 'Create repository' : 'Create and connect')
                  : (mode === 'onboard' ? 'Connect repository' : 'Switch to repository')}
          </button>
        </div>
      </form>
    </div>
  );
}
