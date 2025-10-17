// Modal that appears when the user clicks the "Share" icon in the file header.
import { useState, useEffect, type FocusEvent, type MouseEvent, type RefObject } from 'react';
import { CloseIcon, CopyIcon, CopySuccessIcon, CopyErrorIcon } from './RepoIcons';
import { useOnClickOutside } from './useOnClickOutside';
import { type ShareState } from '../data';

export { ShareDialog, type ShareDialogProps };

type ShareDialogProps = {
  share: ShareState;
  notePath: string | undefined;
  triggerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onCreate: () => Promise<void>;
  onRevoke: () => Promise<void>;
  onRefresh: () => Promise<void>;
};

function ShareDialog({
  share,
  notePath,
  triggerRef,
  onClose,
  onCreate,
  onRevoke,
  onRefresh,
}: ShareDialogProps) {
  let [lastVariant, setLastVariant] = useState<'unshared' | 'shared'>(share.link ? 'shared' : 'unshared');
  let [lastShareUrl, setLastShareUrl] = useState(share.link?.url ?? '');
  const shareUrl = share.link?.url ?? lastShareUrl;
  const noteLabel = notePath ? notePath.split('/').pop() ?? notePath : 'note';
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  useEffect(() => {
    if (share.status === 'ready') {
      if (share.link) {
        setLastVariant('shared');
        setLastShareUrl(share.link.url);
      } else {
        setLastVariant('unshared');
        setLastShareUrl('');
      }
    }
  }, [share.status, share.link]);

  useEffect(() => {
    if (share.status === 'idle') {
      setLastVariant('unshared');
      setLastShareUrl('');
    }
  }, [share.status]);

  useEffect(() => {
    setCopyState('idle');
  }, [shareUrl]);

  const dialogRef = useOnClickOutside(onClose, { trigger: triggerRef });

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
    const isLoading = share.status === 'loading';
    const activeVariant =
      share.status === 'loading' || share.status === 'idle'
        ? lastVariant
        : share.link
        ? 'shared'
        : 'unshared';
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
      <div className="share-flow" data-variant={activeVariant} data-busy={isLoading}>
        <div className="share-panel share-create" data-active={activeVariant === 'unshared'}>
          <button className="btn primary" onClick={onCreate} disabled={isLoading}>
            {isLoading ? 'Loading...' : 'Create share link'}
          </button>
          <p className="share-hint">Links are unlisted and anyone with the URL can read the note.</p>
        </div>
        <div className="share-panel share-success" data-active={activeVariant === 'shared'}>
          <div className="share-url-row">
            <input
              className="share-url-input"
              value={shareUrl}
              readOnly
              aria-label="Shareable link"
              onFocus={handleShareUrlFocus}
              onClick={handleShareUrlClick}
              title={shareUrl}
              placeholder={shareUrl === '' ? 'Loading link...' : undefined}
            />
            <button
              className="btn secondary share-copy-btn"
              data-state={copyState}
              onClick={copyLink}
              type="button"
              disabled={!shareUrl || isLoading}
            >
              {copyButtonIcon}
              <span className="share-copy-btn-label">{copyButtonLabel}</span>
            </button>
          </div>
          <p className="share-hint">The link stays live until you revoke it.</p>
          <button className="btn subtle share-revoke" onClick={onRevoke} disabled={isLoading}>
            Revoke link
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="share-overlay" role="dialog" aria-modal="true" aria-label="Share note dialog">
      <div className="share-dialog" ref={dialogRef}>
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
              : 'Generate a secret link to share the note with anyone.'}
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
