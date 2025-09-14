import React, { useState } from 'react';

interface Props {
  onSubmit: (cfg: { owner: string; repo: string; branch: string }) => void;
  onCancel: () => void;
}

export function RepoConfigModal({ onSubmit, onCancel }: Props) {
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!owner.trim() || !repo.trim()) return;
    onSubmit({ owner: owner.trim(), repo: repo.trim(), branch: branch.trim() });
  };

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <h3>Configure Repository</h3>
        <input
          className="input"
          placeholder="Owner"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          required
        />
        <input
          className="input"
          placeholder="Repository"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          required
        />
        <input
          className="input"
          placeholder="Branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />
        <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
          <button type="submit" className="btn primary">Save</button>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

