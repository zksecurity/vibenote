// Centralized icon wrappers to keep Lucide usage consistent across the UI.
import type { ReactElement } from 'react';
import { ExternalLink, NotebookText, RefreshCw, Share2, X } from 'lucide-react';

export { GitHubIcon, ExternalLinkIcon, NotesIcon, CloseIcon, SyncIcon, ShareIcon };

const iconStrokeWidth = 1.8;

// there's a github icon in lucide but I don't like it
// this one was drawn by codex
function GitHubIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.11 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.91.08 2.11.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function ExternalLinkIcon(): ReactElement {
  return <ExternalLink aria-hidden size={16} strokeWidth={iconStrokeWidth} />;
}

function NotesIcon(): ReactElement {
  return <NotebookText aria-hidden size={18} strokeWidth={iconStrokeWidth} />;
}

function CloseIcon(): ReactElement {
  return <X aria-hidden size={16} strokeWidth={iconStrokeWidth} />;
}

function SyncIcon({ spinning }: { spinning: boolean }): ReactElement {
  let className = 'sync-icon';
  if (spinning) className += ' spinning';
  return <RefreshCw aria-hidden className={className} size={18} strokeWidth={iconStrokeWidth} />;
}

function ShareIcon(): ReactElement {
  return <Share2 aria-hidden size={18} strokeWidth={iconStrokeWidth} />;
}
