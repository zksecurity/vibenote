import type { ReactElement } from 'react';

export { GitHubIcon, ExternalLinkIcon, NotesIcon, CloseIcon, SyncIcon, ShareIcon };

function GitHubIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.11 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.91.08 2.11.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function ExternalLinkIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M10.5 2a.5.5 0 0 0 0 1h2.293L7.146 8.646a.5.5 0 1 0 .708.708L13.5 3.707V6a.5.5 0 0 0 1 0V2.5a.5.5 0 0 0-.5-.5H10.5Z" />
      <path d="M3.75 3A1.75 1.75 0 0 0 2 4.75v7.5C2 13.44 2.56 14 3.25 14h7.5c.69 0 1.25-.56 1.25-1.25V9.5a.5.5 0 0 0-1 0v3.25a.25.25 0 0 1-.25.25h-7.5a.25.25 0 0 1-.25-.25v-7.5c0-.138.112-.25.25-.25H7a.5.5 0 0 0 0-1H3.75Z" />
    </svg>
  );
}

function NotesIcon(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M3 1.75A1.75 1.75 0 0 1 4.75 0h6.5A1.75 1.75 0 0 1 13 1.75v12.5A1.75 1.75 0 0 1 11.25 16h-6.5A1.75 1.75 0 0 1 3 14.25Zm1.5.75a.75.75 0 0 0-.75.75v10.5c0 .414.336.75.75.75h6.5a.75.75 0 0 0 .75-.75V3.25a.75.75 0 0 0-.75-.75ZM5 4.5A.5.5 0 0 1 5.5 4h3a.5.5 0 0 1 0 1h-3A.5.5 0 0 1 5 4.5Zm0 2.75A.75.75 0 0 1 5.75 6.5h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 5 7.25Zm0 2.75c0-.414.336-.75.75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 5 10Z" />
    </svg>
  );
}

function CloseIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M3.22 3.22a.75.75 0 0 1 1.06 0L8 6.94l3.72-3.72a.75.75 0 1 1 1.06 1.06L9.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L8 9.06l-3.72 3.72a.75.75 0 1 1-1.06-1.06L6.94 8 3.22 4.28a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

function SyncIcon({ spinning }: { spinning: boolean }): ReactElement {
  return (
    <svg
      className={`sync-icon ${spinning ? 'spinning' : ''}`}
      width="20"
      height="20"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      aria-hidden
    >
      <path d="M2.5 8a5.5 5.5 0 0 1 9-3.9" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M13.5 8a5.5 5.5 0 0 1-9 3.9" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M11.5 2.5 13.5 5l-3 .5" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 13.5 2.5 11l3-.5" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ShareIcon(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden>
      <path d="M12 5.5a1.75 1.75 0 1 0-1.69-2.16l-4.02 2.3a1.75 1.75 0 0 0 0 2.72l4.02 2.3a1.75 1.75 0 1 0 .38-.66l-4.02-2.3a.75.75 0 0 1 0-1.16l4.02-2.3A1.74 1.74 0 0 0 12 5.5Z" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="4" cy="8" r="2.25" strokeWidth="1.4" />
    </svg>
  );
}
