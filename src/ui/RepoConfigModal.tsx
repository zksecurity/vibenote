import React, { useEffect, useRef, useState } from 'react';
import { repoExists } from '../sync/git-sync';
import { Toggle } from './Toggle';

type RepoConfigModalProps = {
  mode: 'onboard' | 'manage';
  ownerLogin: string | null;
  syncing: boolean;
  error: string | null;
  onSubmit: (config: { owner: string; repo: string; branch: string; autosync: boolean }) => void;
  onClose: () => void;
  onLinkExisting: () => void;
};

export { RepoConfigModal };

function RepoConfigModal({
  mode,
  ownerLogin,
  syncing,
  error,
  onSubmit,
  onClose,
  onLinkExisting,
}: RepoConfigModalProps) {
  const [owner, setOwner] = useState(() => ownerLogin ?? '');
  const [repo, setRepo] = useState('notes');
  const repoInputRef = useRef<HTMLInputElement | null>(null);
  const [checking, setChecking] = useState(false);
  const [exists, setExists] = useState<boolean | null>(null);
  // Default autosync on during onboarding; off otherwise
  const [autosync, setAutosync] = useState(mode === 'onboard');

  useEffect(() => {
    if (ownerLogin && owner.trim() === '') {
      setOwner(ownerLogin);
    }
  }, [ownerLogin, owner]);

  useEffect(() => {
    repoInputRef.current?.focus();
  }, []);

  // Debounced repo existence check when both fields are filled
  useEffect(() => {
    let cancel = false;
    const o = owner.trim();
    const r = repo.trim();
    if (o === '' || r === '') {
      setExists(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const ok = await repoExists(o, r);
        if (!cancel) setExists(ok);
      } catch {
        if (!cancel) setExists(null);
      } finally {
        if (!cancel) setChecking(false);
      }
    }, 300);
    return () => {
      cancel = true;
      clearTimeout(t);
    };
  }, [owner, repo]);

  const heading = mode === 'onboard' ? 'Connect your notes repository' : 'Connect a repository';
  const description =
    mode === 'onboard'
      ? 'VibeNote stores your notes in a GitHub repository. Connect an existing repo you already manage.'
      : 'Switch to or connect an existing GitHub repository for your notes.';

  const canSubmit = owner.trim() !== '' && repo.trim() !== '' && !syncing && exists !== false && !checking;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({ owner: owner.trim(), repo: repo.trim(), branch: 'main', autosync });
  };

  const close = () => {
    if (syncing) return;
    onClose();
  };

  const linkExisting = () => {
    if (syncing) return;
    onLinkExisting();
  };

  const showLinkExisting = owner.trim() === '' || repo.trim() === '';

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal repo-config-modal" onClick={(e) => e.stopPropagation()}>
        <div className="repo-config-header">
          <h3>{heading}</h3>
          <p>{description}</p>
        </div>
        <form className="repo-config-form" onSubmit={submit}>
          <label className="repo-config-field">
            <span>Owner</span>
            <input
              className="input"
              type="text"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              disabled={syncing}
              placeholder="github-user"
            />
          </label>
          <label className="repo-config-field">
            <span>Repository name</span>
            <input
              ref={repoInputRef}
              className="input"
              type="text"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              disabled={syncing}
              placeholder="notes"
            />
          </label>
          <div className="repo-config-field">
            <Toggle
              checked={autosync}
              onChange={setAutosync}
              label="Enable autosync"
              description="Runs background sync after edits and periodically."
              disabled={syncing}
            />
          </div>
          {error ? <div className="repo-config-error">{error}</div> : null}
          {checking ? (
            <div className="repo-config-hint">Checking repository…</div>
          ) : exists === true ? (
            <div className="repo-config-hint">Repository found — connect to start syncing.</div>
          ) : exists === false ? (
            <div className="repo-config-hint">Repository not found. Create it on GitHub first, then reconnect.</div>
          ) : null}
          <div className="repo-config-footer">
            <button type="button" className="btn" onClick={close} disabled={syncing}>
              {mode === 'onboard' ? 'Skip for now' : 'Close'}
            </button>
            <div className="repo-config-actions">
              {showLinkExisting && (
                <button type="button" className="btn secondary" onClick={linkExisting} disabled={syncing}>
                  Switch to existing repo
                </button>
              )}
              <button type="submit" className="btn primary" disabled={!canSubmit}>
                {syncing ? 'Connecting…' : 'Connect repository'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
