// Modal that appears when the user clicks the "Share" icon in the file header.
import { useState, useEffect, type FocusEvent, type MouseEvent } from 'react';
import { CloseIcon, CopyIcon, CopySuccessIcon, CopyErrorIcon } from './RepoIcons';
import { type ShareState } from '../data';

export { ShareDialog, type ShareDialogProps };

type ShareDialogProps = {
  share: ShareState;
  notePath: string | undefined;
  onClose: () => void;
  onCreate: () => Promise<void>;
  onRevoke: () => Promise<void>;
  onRefresh: () => Promise<void>;
};

function ShareDialog({ share, notePath, onClose, onCreate, onRevoke, onRefresh }: ShareDialogProps) {
  const shareUrl = share.link?.url ?? '';
  const noteLabel = notePath ? notePath.split('/').pop() ?? notePath : 'note';
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  useEffect(() => {
    setCopyState('idle');
  }, [shareUrl]);

  const copyLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      const area = document.createElement('textarea');
      area.value = shareUrl;
      area.setAttribute('readonly', '');
      area.style.position = 'absolute';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      const copySucceeded = document.execCommand('copy');
      document.body.removeChild(area);
      setCopyState(copySucceeded ? 'copied' : 'error');
      window.setTimeout(() => setCopyState('idle'), 2000);
    }
  };

  function highlightShareUrl(input: HTMLInputElement): void {
    input.select();
  }

  function handleShareUrlFocus(event: FocusEvent<HTMLInputElement>): void {
    highlightShareUrl(event.currentTarget);
  }

  function handleShareUrlClick(event: MouseEvent<HTMLInputElement>): void {
    highlightShareUrl(event.currentTarget);
  }

  const renderBody = () => {
    if (share.status === 'loading') {
      return <p className="share-status">Checking share status...</p>;
    }
    if (share.status === 'error') {
      return (
        <div className="share-error">
          <p>Could not load the share status.</p>
          {share.error && <p className="share-error-detail">{share.error}</p>}
          <button className="btn secondary" onClick={onRefresh}>
            Try again
          </button>
        </div>
      );
    }
    if (share.link) {
      let copyButtonIcon = <CopyIcon />;
      let copyButtonLabel = 'Copy link';
      if (copyState === 'copied') {
        copyButtonIcon = <CopySuccessIcon />;
        copyButtonLabel = 'Copied';
      } else if (copyState === 'error') {
        copyButtonIcon = <CopyErrorIcon />;
        copyButtonLabel = 'Copy failed';
      }
      return (
        <div className="share-success">
          <div className="share-url-row">
            <input
              className="share-url-input"
              value={shareUrl}
              readOnly
              aria-label="Shareable link"
              onFocus={handleShareUrlFocus}
              onClick={handleShareUrlClick}
              title={shareUrl}
            />
            <button
              className="btn secondary share-copy-btn"
              data-state={copyState}
              onClick={copyLink}
              type="button"
              disabled={!shareUrl}
            >
              {copyButtonIcon}
              <span className="share-copy-btn-label">{copyButtonLabel}</span>
            </button>
          </div>
          <p className="share-hint">The link stays live until you revoke it.</p>
          <button className="btn subtle share-revoke" onClick={onRevoke}>
            Revoke link
          </button>
        </div>
      );
    }
    return (
      <div className="share-create">
        <button className="btn primary" onClick={onCreate}>
          Create share link
        </button>
        <p className="share-hint">Links are unlisted and anyone with the URL can read the note.</p>
      </div>
    );
  };

  return (
    <div className="share-overlay" role="dialog" aria-modal="true" aria-label="Share note dialog">
      <div className="share-dialog">
        <div className="share-dialog-header">
          <h2 className="share-dialog-title">Share this note</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close share dialog">
            <CloseIcon />
          </button>
        </div>
        <div className="share-dialog-body">
          <p className="share-dialog-subtitle">
            {share.link
              ? 'Anyone with the link can view the latest version.'
              : 'Generate a secret link to share the rendered Markdown with anyone.'}
          </p>
          <div className="share-note-summary">
            <span className="share-note-label">Note</span>
            <span className="share-note-name" title={notePath ?? ''}>
              {noteLabel}
            </span>
          </div>
          {renderBody()}
        </div>
      </div>
    </div>
  );
}
