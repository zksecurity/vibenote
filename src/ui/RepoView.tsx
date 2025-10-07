import { useMemo, useState, useEffect } from 'react';
import { FileTree, type FileEntry } from './FileTree';
import { Editor } from './Editor';
import { RepoSwitcher } from './RepoSwitcher';
import { Toggle } from './Toggle';
import { GitHubIcon, ExternalLinkIcon, NotesIcon, CloseIcon, SyncIcon } from './RepoIcons';
import { useRepoData, type RepoNoteListItem } from '../data';
import { getExpandedFolders, setExpandedFolders } from '../storage/local';
import type { Route } from './routing';

type RepoViewProps = {
  slug: string;
  route: Route;
  navigate: (route: Route, options?: { replace?: boolean }) => void;
  onRecordRecent: (entry: {
    slug: string;
    owner?: string;
    repo?: string;
    title?: string;
    connected?: boolean;
  }) => void;
};

const primaryModifier = detectPrimaryShortcut();

export function RepoView(props: RepoViewProps) {
  return <RepoViewInner key={props.slug} {...props} />;
}

function RepoViewInner({ slug, route, navigate, onRecordRecent }: RepoViewProps) {
  // Data layer exposes repo-backed state and the high-level actions the UI needs.
  const { state, actions } = useRepoData({ slug, route, onRecordRecent });
  const {
    sessionToken,
    user,

    canEdit,
    canRead,
    canSync,
    repoQueryStatus,
    needsInstall,

    doc,
    activeId,
    notes,
    folders,

    autosync,
    syncing,
    statusMessage,
  } = state;

  const userAvatarSrc = user?.avatarDataUrl ?? user?.avatarUrl ?? undefined;
  const showSidebar = canRead;
  const isReadOnly = !canEdit && canRead;
  const layoutClass = showSidebar ? '' : 'single';

  // Pure UI state: sidebar visibility and account menu.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the account dropdown when clicking anywhere else on the page.
  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.account-menu') && !target.closest('.account-btn')) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  const [showSwitcher, setShowSwitcher] = useState(false);

  // Keyboard shortcuts: Cmd/Ctrl+K and "g" then "r" open the repo switcher.
  const repoShortcutLabel = primaryModifier === 'meta' ? '⌘K' : 'Ctrl+K';
  const repoButtonBaseTitle = route.kind === 'repo' ? 'Change repository' : 'Choose repository';
  const repoButtonTitle = `${repoButtonBaseTitle} (${repoShortcutLabel})`;

  useEffect(() => {
    let lastG = 0;
    const isTypingTarget = (el: EventTarget | null) => {
      const n = el as HTMLElement | null;
      if (!n) return false;
      const tag = (n.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || (n as any).isContentEditable === true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const key = e.key.toLowerCase();
      // Always allow the primary shortcut (Ctrl or Cmd) + K to open the switcher, even when typing
      const usesPrimaryModifier = primaryModifier === 'meta' ? e.metaKey : e.ctrlKey;
      if (usesPrimaryModifier && key === 'k') {
        e.preventDefault();
        setShowSwitcher(true);
        return;
      }
      if (isTypingTarget(e.target)) return;
      const now = Date.now();
      if (key === 'g') {
        lastG = now;
        return;
      }
      if (key === 'r' && now - lastG < 800) {
        e.preventDefault();
        lastG = 0;
        setShowSwitcher(true);
        return;
      }
      lastG = 0;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <button
            className="btn icon only-mobile"
            onClick={() => setSidebarOpen((value) => !value)}
            aria-label={sidebarOpen ? 'Close notes' : 'Open notes'}
            aria-expanded={sidebarOpen}
          >
            <NotesIcon />
          </button>
          <button
            className="brand-button"
            type="button"
            onClick={() => navigate({ kind: 'home' })}
            aria-label="Go home"
          >
            <span className="brand">VibeNote</span>
          </button>
          {route.kind === 'repo' ? (
            <span className="repo-anchor align-workspace">
              <button
                className="btn ghost repo-btn"
                onClick={() => setShowSwitcher(true)}
                title={repoButtonTitle}
              >
                <GitHubIcon />
                <span className="repo-label">
                  <span className="repo-owner">{route.owner}/</span>
                  <span>{route.repo}</span>
                </span>
              </button>
              <a
                className="repo-open-link"
                href={`https://github.com/${route.owner}/${route.repo}`}
                target="_blank"
                rel="noreferrer"
                title="Open on GitHub"
                aria-label="Open on GitHub"
              >
                <ExternalLinkIcon />
              </a>
            </span>
          ) : sessionToken ? (
            <span className="repo-anchor align-workspace">
              <button
                type="button"
                className="btn ghost repo-btn repo-btn-empty"
                onClick={() => setShowSwitcher(true)}
                disabled={syncing}
                title={repoButtonTitle}
              >
                <GitHubIcon />
                <span className="repo-label">
                  <span>Choose repository</span>
                </span>
              </button>
            </span>
          ) : null}
        </div>
        <div className="topbar-actions">
          {!sessionToken ? (
            <button className="btn primary" onClick={actions.signIn}>
              Connect GitHub
            </button>
          ) : (
            <>
              {canSync && (
                <button
                  className={`btn secondary sync-btn ${syncing ? 'is-syncing' : ''}`}
                  onClick={actions.syncNow}
                  disabled={syncing}
                  aria-label={syncing ? 'Syncing' : 'Sync now'}
                  title={syncing ? 'Syncing…' : 'Sync now'}
                >
                  <SyncIcon spinning={syncing} />
                </button>
              )}
              {user && (
                <button
                  className="btn ghost account-btn"
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-label="Account menu"
                >
                  {userAvatarSrc ? (
                    <img src={userAvatarSrc} alt={user.login} />
                  ) : (
                    <span className="account-avatar-fallback" aria-hidden>
                      {(user.name || user.login || '?').charAt(0).toUpperCase()}
                    </span>
                  )}
                </button>
              )}
            </>
          )}
        </div>
      </header>
      <div className={`app-layout ${layoutClass}`}>
        {showSidebar && (
          <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
            <div className="sidebar-header">
              <div className="sidebar-title">
                <div className="sidebar-title-main">
                  <span>Notes</span>
                  <span className="note-count">{notes.length}</span>
                </div>
                <button
                  className="btn icon only-mobile"
                  onClick={() => setSidebarOpen(false)}
                  aria-label="Close notes"
                >
                  <CloseIcon />
                </button>
              </div>
            </div>
            <FileSidebar
              notes={notes}
              folders={folders}
              canEdit={canEdit}
              slug={slug}
              activeId={activeId}
              onSelect={async (id: string) => {
                await actions.selectNote(id);
                setSidebarOpen(false);
              }}
              onCreateNote={actions.createNote}
              onCreateFolder={actions.createFolder}
              onRenameNote={actions.renameNote}
              onDeleteNote={actions.deleteNote}
              onRenameFolder={actions.renameFolder}
              onDeleteFolder={actions.deleteFolder}
            />
            {canSync ? (
              <div className="repo-autosync-toggle">
                <Toggle
                  checked={autosync}
                  onChange={actions.setAutosync}
                  label="Autosync"
                  description="Runs background sync after edits and periodically."
                />
              </div>
            ) : null}
          </aside>
        )}
        <section className="workspace">
          <div className="workspace-body">
            {route.kind === 'repo' && needsInstall ? (
              <div className="empty-state">
                <h2>Can't access this repository</h2>
                <p>This repository is private or not yet enabled for the VibeNote GitHub App.</p>
                <p>
                  Continue to GitHub and either select <strong>Only select repositories</strong> and pick
                  <code>
                    {' '}
                    {route.owner}/{route.repo}
                  </code>
                  , or grant access to all repositories (not recommended).
                </p>
                {sessionToken ? (
                  <button className="btn primary" onClick={actions.openRepoAccess}>
                    Get Read/Write Access
                  </button>
                ) : (
                  <p>Please sign in with GitHub to request access.</p>
                )}
              </div>
            ) : (
              <>
                {repoQueryStatus === 'error' && (
                  <div className="alert warning">
                    <span className="badge">Offline</span>
                    <span className="alert-text">
                      Could not reach GitHub. You can still edit notes offline.
                    </span>
                  </div>
                )}
                {repoQueryStatus === 'rate-limited' && (
                  <div className="alert warning">
                    <span className="badge">Limited</span>
                    <span className="alert-text">
                      GitHub rate limits temporarily prevent accessing the repository.
                    </span>
                  </div>
                )}
                {isReadOnly && (
                  <div className="alert">
                    <span className="badge">Read-only</span>
                    <span className="alert-text">You can view, but not edit files in this repository.</span>
                    {sessionToken ? (
                      <button className="btn primary" onClick={actions.openRepoAccess}>
                        Get Write Access
                      </button>
                    ) : null}
                  </div>
                )}
                {doc ? (
                  <div className="workspace-panels">
                    <Editor
                      key={doc.id}
                      doc={doc}
                      readOnly={!canEdit}
                      onChange={(id, text) => {
                        actions.updateNoteText(id, text);
                      }}
                    />
                  </div>
                ) : (
                  <div className="empty-state">
                    <h2>Welcome to VibeNote</h2>
                    <p>Select a note from the sidebar or create a new one to get started.</p>
                    <p>
                      To sync with GitHub, connect your account and link a repository. Once connected, use{' '}
                      <strong>Sync now</strong> anytime to pull and push updates.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
          {statusMessage && (
            <div className="status-banner">
              <span>Status</span>
              <span>{statusMessage}</span>
            </div>
          )}
        </section>
      </div>
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}

      {menuOpen && user && (
        <div className="account-menu">
          <div className="account-menu-header">
            <div className="account-menu-avatar" aria-hidden>
              {userAvatarSrc ? (
                <img src={userAvatarSrc} alt="" />
              ) : (
                <span>{(user.name || user.login || '?').charAt(0).toUpperCase()}</span>
              )}
            </div>
            <div>
              <div className="account-name">{user.name || user.login}</div>
              <div className="account-handle">@{user.login}</div>
            </div>
          </div>
          <button
            className="btn subtle full-width"
            onClick={async () => {
              await actions.signOut();
              setMenuOpen(false);
            }}
          >
            Sign out
          </button>
        </div>
      )}
      {showSwitcher && (
        <RepoSwitcher
          route={route}
          slug={slug}
          navigate={navigate}
          onRecordRecent={onRecordRecent}
          onClose={() => setShowSwitcher(false)}
        />
      )}
    </div>
  );
}

type FileSidebarProps = {
  notes: RepoNoteListItem[];
  folders: string[];
  canEdit: boolean;
  slug: string;
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreateNote: (dir: string, name: string) => string | null;
  onCreateFolder: (parentDir: string, name: string) => void;
  onRenameNote: (id: string, title: string) => void;
  onDeleteNote: (id: string) => void;
  onRenameFolder: (dir: string, newName: string) => void;
  onDeleteFolder: (dir: string) => void;
};

function FileSidebar(props: FileSidebarProps) {
  let {
    canEdit,
    notes,
    slug,
    folders,
    activeId,
    onSelect,
    onCreateNote,
    onCreateFolder,
    onRenameNote,
    onDeleteNote,
    onRenameFolder,
    onDeleteFolder,
  } = props;

  // Derive file entries for the tree component from the provided notes list.
  let files = useMemo<FileEntry[]>(
    () => notes.map((note) => ({ id: note.id, name: note.title, path: note.path, dir: note.dir })),
    [notes]
  );

  // make sure that for every folder, its parent folders is also included (otherwise expanding doesn't work)
  // TODO there are some code paths that store folders incompletely in local storage, and some that store parent folders.
  // should be consistent.
  folders = useMemo(() => {
    let folderSet = new Set(folders);
    for (let folder of folders) {
      let parts = folder.split('/');
      while (parts.length > 1) {
        parts.pop();
        folderSet.add(parts.join('/'));
      }
    }
    return Array.from(folderSet).sort();
  }, [folders]);

  // Maintain collapsed state against the active folder list so disclosure toggles persist.
  let { collapsed, setCollapsedMap } = useCollapsedFolders({ slug, folders, canEdit });

  // Track which item is highlighted so new actions know their context.
  let [selection, setSelection] = useState<
    { kind: 'folder'; dir: string } | { kind: 'file'; id: string } | null
  >(null);

  // Drive inline creation rows in the tree with a deterministic key.
  let [newEntry, setNewEntry] = useState<{
    kind: 'file' | 'folder';
    parentDir: string;
    key: number;
  } | null>(null);

  // Reset inline creation state when edit access is lost.
  useEffect(() => {
    if (!canEdit) setNewEntry(null);
  }, [canEdit]);

  // helper to get the correct parent directory for new notes/folders
  function selectedDir() {
    if (selection?.kind === 'folder') return selection.dir;
    if (selection?.kind === 'file') {
      return files.find((f) => f.id === selection.id)?.dir ?? '';
    }
    return '';
  }

  const handleNewNoteClick = () => {
    if (!canEdit) return;
    setNewEntry({ kind: 'file', parentDir: selectedDir(), key: Date.now() });
  };

  const handleNewFolderClick = () => {
    if (!canEdit) return;
    setNewEntry({ kind: 'folder', parentDir: selectedDir(), key: Date.now() });
  };

  return (
    <>
      {canEdit && (
        <div className="sidebar-actions">
          <button className="btn primary" onClick={handleNewNoteClick}>
            New note
          </button>
          <button className="btn secondary" onClick={handleNewFolderClick}>
            New folder
          </button>
        </div>
      )}
      <div className="sidebar-body">
        <FileTree
          files={files}
          folders={folders}
          activeId={activeId}
          collapsed={collapsed}
          onCollapsedChange={setCollapsedMap}
          onSelectionChange={setSelection}
          onSelectFile={onSelect}
          onRenameFile={onRenameNote}
          onDeleteFile={onDeleteNote}
          onCreateFile={onCreateNote}
          onCreateFolder={onCreateFolder}
          onRenameFolder={onRenameFolder}
          onDeleteFolder={onDeleteFolder}
          newEntry={canEdit ? newEntry : null}
          onFinishCreate={() => setNewEntry(null)}
        />
      </div>
    </>
  );
}

function useCollapsedFolders({
  slug,
  folders,
  canEdit,
}: {
  slug: string;
  folders: string[];
  canEdit: boolean;
}) {
  // Remember which folders are expanded so the tree view stays consistent per repo.
  const [expandedState, setExpandedState] = useState<string[]>(() =>
    sanitizeExpandedDirs(folders, getExpandedFolders(slug))
  );

  // Refresh expanded state when the slug changes to honor stored preferences.
  useEffect(() => {
    const stored = getExpandedFolders(slug);
    const next = sanitizeExpandedDirs(folders, stored);
    setExpandedState((prev) => (foldersEqual(prev, next) ? prev : next));
  }, [slug, folders]);

  // Drop any folders that no longer exist from the expanded list.
  useEffect(() => {
    setExpandedState((prev) => sanitizeExpandedDirs(folders, prev));
  }, [folders]);

  // Persist expanded folders back to storage for future visits (when enabled).
  useEffect(() => {
    if (!canEdit) return;
    setExpandedFolders(slug, expandedState);
  }, [slug, expandedState, canEdit]);

  const collapsed = useMemo(() => buildCollapsedMap(expandedState, folders), [expandedState, folders]);

  const setCollapsedMap = (next: Record<string, boolean>) => {
    const expanded = expandedDirsFromCollapsed(next);
    setExpandedState((prev) => {
      const nextExpanded = sanitizeExpandedDirs(folders, expanded);
      return foldersEqual(prev, nextExpanded) ? prev : nextExpanded;
    });
  };

  return { collapsed, setCollapsedMap } as const;
}

function buildCollapsedMap(expanded: string[], folders: string[]): Record<string, boolean> {
  let expandedSet = new Set(expanded.filter((dir) => typeof dir === 'string' && dir !== ''));
  let map: Record<string, boolean> = { '': false };
  for (let dir of folders) {
    if (dir === '') continue;
    map[dir] = expandedSet.has(dir) ? false : true;
  }
  for (let dir of expandedSet) {
    if (!(dir in map)) map[dir] = false;
  }
  return map;
}

function sanitizeExpandedDirs(folders: string[], dirs: string[]): string[] {
  if (dirs.length === 0) return [];
  const valid = new Set(folders);
  valid.delete('');
  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of dirs) {
    if (!dir) continue;
    if (!valid.has(dir)) continue;
    if (seen.has(dir)) continue;
    seen.add(dir);
    result.push(dir);
  }
  return result;
}

function expandedDirsFromCollapsed(map: Record<string, boolean>): string[] {
  const expanded: string[] = [];
  for (const key in map) {
    if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
    if (key === '') continue;
    if (map[key] === false) expanded.push(key);
  }
  return expanded;
}

function foldersEqual(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function detectPrimaryShortcut(): 'meta' | 'ctrl' {
  if (typeof navigator === 'undefined') return 'ctrl';
  let platform = navigator.platform ?? '';
  if (!platform && typeof navigator.userAgent === 'string') platform = navigator.userAgent;
  const APPLE_PLATFORM_PATTERN = /mac|iphone|ipad|ipod/i;
  if (APPLE_PLATFORM_PATTERN.test(platform)) return 'meta';
  return 'ctrl';
}
