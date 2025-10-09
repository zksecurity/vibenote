// Modal for creating public share links for a single note.
import { useEffect, useState } from 'react';
import { createShareLink, disableShareLink, type ShareLink } from '../lib/backend';
import { CloseIcon } from './RepoIcons';

export type { ShareModalProps };
export function ShareModal(props: ShareModalProps) {
  let { repoSlug, notePath, noteTitle, noteText, share, onClose, onShared, onUnshared } = props;
  let [includeAssets, setIncludeAssets] = useState(true);
  let [expiryDate, setExpiryDate] = useState('');
  let [submitting, setSubmitting] = useState(false);
  let [error, setError] = useState<string | null>(null);
  let [result, setResult] = useState<ShareLink | null>(null);
  let [copied, setCopied] = useState(false);

  useEffect(() => {
    setIncludeAssets(true);
    setExpiryDate('');
    setSubmitting(false);
    setError(null);
    setResult(null);
    setCopied(false);
  }, [repoSlug, notePath]);

  useEffect(() => {
    if (share) {
      setResult(share);
      setIncludeAssets(share.includeAssets);
      setExpiryDate(share.expiresAt ? share.expiresAt.slice(0, 10) : '');
    }
  }, [share?.id, share?.updatedAt]);

  let activeShare = (share ?? result) ?? null;

  useEffect(() => {
    let onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  let onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      let expiresAt = expiryDate.trim().length > 0 ? buildExpiryIso(expiryDate) : null;
      let share = await createShareLink({
        repo: repoSlug,
        path: notePath,
        includeAssets,
        expiresAt,
        text: noteText,
      });
      setResult(share);
      setCopied(false);
      if (onShared) onShared(share);
    } catch (err) {
      let message = err instanceof Error ? err.message : 'Failed to create share.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  let onCopy = async () => {
    if (!activeShare) return;
    try {
      await navigator.clipboard.writeText(activeShare.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  let onStopSharing = async () => {
    if (!activeShare) return;
    setSubmitting(true);
    setError(null);
    try {
      await disableShareLink(activeShare.id);
      setResult(null);
      setCopied(false);
      if (onUnshared) onUnshared();
    } catch (err) {
      let message = err instanceof Error ? err.message : 'Failed to stop sharing.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal
      onClick={() => {
        onClose();
      }}
    >
      <div
        className="modal share-modal"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="share-header">
          <div>
            <h3>Share this note</h3>
            <p>
              {noteTitle ?? notePath}
              <span className="share-pill">Unlisted</span>
            </p>
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close share dialog">
            <CloseIcon />
          </button>
        </div>
        {activeShare === null ? (
          <form className="share-form" onSubmit={onSubmit}>
            <label className="share-field">
              <span>Attachments</span>
              <label className="share-checkbox">
                <input
                  type="checkbox"
                  checked={includeAssets}
                  onChange={(event) => setIncludeAssets(event.target.checked)}
                />
                Include referenced images and files
              </label>
            </label>
            <label className="share-field">
              <span>Expiry (optional)</span>
              <input
                type="date"
                value={expiryDate}
                onChange={(event) => setExpiryDate(event.target.value)}
                min={todayDate()}
              />
            </label>
            {error && <div className="share-error">{error}</div>}
            <div className="share-actions">
              <button type="button" className="btn subtle" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={submitting}>
                {submitting ? 'Creating…' : 'Create link'}
              </button>
            </div>
          </form>
        ) : (
          <div className="share-result">
            <div className="share-url">
              <input type="text" readOnly value={activeShare.url} aria-label="Share URL" />
              <button className="btn secondary" onClick={onCopy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <dl>
              <div>
                <dt>Created</dt>
                <dd>{formatDisplayDate(new Date(activeShare.createdAt))}</dd>
              </div>
              <div>
                <dt>Last updated</dt>
                <dd>{formatDisplayDate(new Date(activeShare.updatedAt))}</dd>
              </div>
              <div>
                <dt>Attachments</dt>
                <dd>{activeShare.includeAssets ? 'Images & files included' : 'Note only'}</dd>
              </div>
              {activeShare.expiresAt && (
                <div>
                  <dt>Expires</dt>
                  <dd>{formatDisplayDate(new Date(activeShare.expiresAt))}</dd>
                </div>
              )}
            </dl>
            <p className="share-note">This link stays in sync with your edits automatically.</p>
            {error && <div className="share-error">{error}</div>}
            <div className="share-actions">
              <a className="btn secondary" href={activeShare.url} target="_blank" rel="noreferrer">
                Open
              </a>
              <button className="btn subtle" onClick={onStopSharing} disabled={submitting}>
                Stop sharing
              </button>
              <button className="btn primary" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type ShareModalProps = {
  repoSlug: string;
  notePath: string;
  noteTitle?: string;
  noteText: string;
  share?: ShareLink | null;
  onClose: () => void;
  onShared?: (link: ShareLink) => void;
  onUnshared?: () => void;
};

function todayDate(): string {
  let now = new Date();
  let month = String(now.getMonth() + 1).padStart(2, '0');
  let day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function buildExpiryIso(dateStr: string): string {
  let iso = new Date(`${dateStr}T23:59:59`).toISOString();
  return iso;
}

let dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function formatDisplayDate(date: Date): string {
  return dateFormatter.format(date);
}
