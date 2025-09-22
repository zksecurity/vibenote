import React, { useEffect, useRef, useState } from 'react';

type RepoConfigModalProps = {
  mode: 'onboard' | 'manage';
  ownerLogin: string | null;
  syncing: boolean;
  error: string | null;
  onSubmit: (config: { owner: string; repo: string; branch: string }) => void;
  onClose: () => void;
  onLinkExisting: () => void;
};

export { RepoConfigModal };

function RepoConfigModal({ mode, ownerLogin, syncing, error, onSubmit, onClose, onLinkExisting }: RepoConfigModalProps) {
  const [owner, setOwner] = useState(() => ownerLogin ?? '');
  const [repo, setRepo] = useState('notes');
  const repoInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (ownerLogin && owner.trim() === '') {
      setOwner(ownerLogin);
    }
  }, [ownerLogin, owner]);

  useEffect(() => {
    repoInputRef.current?.focus();
  }, []);

  const heading = mode === 'onboard' ? 'Create your notes repository' : 'Create or link a repository';
  const description =
    mode === 'onboard'
      ? 'VibeNote stores your notes in a private GitHub repository. Create one now to start syncing.'
      : 'Set up a GitHub repository for your notes. You can create a new repo or link to an existing one.';

  const canSubmit = owner.trim() !== '' && repo.trim() !== '' && !syncing;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({ owner: owner.trim(), repo: repo.trim(), branch: 'main' });
  };

  const close = () => {
    if (syncing) return;
    onClose();
  };

  const linkExisting = () => {
    if (syncing) return;
    onLinkExisting();
  };

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
          {error ? <div className="repo-config-error">{error}</div> : null}
          <div className="repo-config-footer">
            <button type="button" className="btn" onClick={close} disabled={syncing}>
              {mode === 'onboard' ? 'Skip for now' : 'Close'}
            </button>
            <div className="repo-config-actions">
              <button type="button" className="btn secondary" onClick={linkExisting} disabled={syncing}>
                Link existing repo
              </button>
              <button type="submit" className="btn primary" disabled={!canSubmit}>
                {syncing ? 'Setting up…' : 'Create repository'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
