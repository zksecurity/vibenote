// Primary workspace view combining repo chrome, file tree, and editor panels.
import { useMemo, useState, useEffect, useRef } from 'react';
import { FileTree, type FileEntry } from './FileTree';
import { Editor } from './Editor';
import { TextEditor } from './TextEditor';
import { AssetViewer } from './AssetViewer';
import { RepoSwitcher } from './RepoSwitcher';
import { Toggle } from './Toggle';
import { GitHubIcon, ExternalLinkIcon, NotesIcon, CloseIcon, SyncIcon, ShareIcon } from './RepoIcons';
import type { AppDataAction, AppDataResult, AppDataState } from '../data';
import type { FileMeta } from '../storage/local';
import {
  getExpandedFolders,
  setExpandedFolders,
  isMarkdownFile,
  isBinaryFile,
  isAssetUrlFile,
  isTextFile,
  basename,
  extractDir,
  stripExtension,
} from '../storage/local';
import { normalizePath } from '../lib/util';
import { useRepoAssetLoader } from './useRepoAssetLoader';
import { ShareDialog } from './ShareDialog';
import { useOnClickOutside } from './useOnClickOutside';

type RepoViewProps = {
  state: AppDataState;
  dispatch: (action: AppDataAction) => void;
  helpers: AppDataResult['helpers'];
};

const primaryModifier = detectPrimaryShortcut();

export function RepoView({ state, dispatch, helpers }: RepoViewProps) {
  let workspace = state.workspace;
  if (workspace === undefined) return null;
  return <RepoViewInner key={workspace.target.slug} state={state} dispatch={dispatch} helpers={helpers} />;
}

function RepoViewInner({ state, dispatch, helpers }: RepoViewProps) {
  let workspace = state.workspace;
  if (workspace === undefined) return null;

  let slug = workspace.target.slug;
  let hasSession = state.session.status === 'signed-in';
  let user = state.session.user;
  let {
    canEdit,
    canRead,
    canSync,
    linked: repoLinked,
    manageUrl,
    defaultBranch,
    errorType: repoErrorType,
  } = workspace.access;
  let activeFile = workspace.document.activeFile;
  let activePath = state.navigation.target?.filePath ?? workspace.document.activePath;
  let files = workspace.tree.files;
  let folders = workspace.tree.folders;
  let autosync = workspace.sync.autosync;
  let syncing = workspace.sync.syncing;
  let statusMessage = workspace.sync.statusMessage;
  let share = workspace.share;

  const userAvatarSrc = user?.avatarDataUrl ?? user?.avatarUrl ?? undefined;
  let repoOwner = workspace.target.kind === 'github' ? workspace.target.owner : undefined;
  let repoName = workspace.target.kind === 'github' ? workspace.target.repo : undefined;
  const showSidebar = canRead;
  const isReadOnly = !canEdit && canRead;
  const layoutClass = showSidebar ? '' : 'single';

  const activeIsMarkdown = activeFile !== undefined && isMarkdownFile(activeFile);
  const canShare =
    hasSession &&
    workspace.target.kind === 'github' &&
    activePath !== undefined &&
    canEdit &&
    activeIsMarkdown;
  const shareDisabled = share.status === 'idle' || share.status === 'loading';

  // error states that require user action (these trigger a custom full sized banner)
  const needsSessionRefresh = repoLinked && repoErrorType === 'auth';
  const needsInstall = hasSession && repoErrorType === 'not-found';
  const needsUserAction = workspace.target.kind === 'github' && (needsSessionRefresh || needsInstall);

  // Pure UI state: sidebar visibility and account menu.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const repoButtonRef = useRef<HTMLButtonElement | null>(null);
  const shareButtonRef = useRef<HTMLButtonElement | null>(null);
  const accountButtonRef = useRef<HTMLButtonElement | null>(null);
  const accountMenuRef = useOnClickOutside(() => setMenuOpen(false), { trigger: accountButtonRef });

  useEffect(() => {
    if (!shareOpen) return;
    if (share.status !== 'idle') return;
    if (activePath === undefined) return;
    dispatch({ type: 'share.refresh', notePath: activePath });
  }, [activePath, dispatch, shareOpen, share.status]);

  const [showSwitcher, setShowSwitcher] = useState(false);

  // Keyboard shortcuts: Cmd/Ctrl+K and "g","r" open the repo switcher even when the tree is focused.
  const repoShortcutLabel = primaryModifier === 'meta' ? '⌘K' : 'Ctrl+K';
  const repoButtonBaseTitle = workspace.target.kind === 'github' ? 'Change repository' : 'Choose repository';
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

  const onSelect = (path: string | undefined) => {
    dispatch({ type: 'note.open', path });
    setSidebarOpen(false);
  };

  const onCreateNote = (dir: string, name: string) => {
    dispatch({ type: 'note.create', parentDir: dir, name });
    return undefined;
  };

  const onCreateFolder = (parentDir: string, name: string) => {
    dispatch({ type: 'folder.create', parentDir, name });
  };

  const onRenameFile = (path: string, name: string) => {
    dispatch({ type: 'file.rename', path, name });
  };

  const onMoveFile = (path: string, targetDir: string) => {
    dispatch({ type: 'file.move', path, targetDir });
    return buildMovedFilePath(path, targetDir);
  };

  const onDeleteFile = (path: string) => {
    dispatch({ type: 'file.delete', path });
  };

  const onRenameFolder = (path: string, name: string) => {
    dispatch({ type: 'folder.rename', path, name });
  };

  const onMoveFolder = (path: string, targetDir: string) => {
    dispatch({ type: 'folder.move', path, targetDir });
    return buildMovedFolderPath(path, targetDir);
  };

  const onDeleteFolder = (path: string) => {
    dispatch({ type: 'folder.delete', path });
  };

  const loadAsset = useRepoAssetLoader({ slug, isReadOnly, defaultBranch });

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
            onClick={() => dispatch({ type: 'navigation.go-home' })}
            aria-label="Go home"
          >
            <span className="brand">VibeNote</span>
          </button>
          {workspace.target.kind === 'github' ? (
            <span className="repo-anchor align-workspace">
              <button
                type="button"
                className="btn ghost repo-btn"
                onClick={() => setShowSwitcher((v) => !v)}
                ref={repoButtonRef}
                title={repoButtonTitle}
              >
                <GitHubIcon />
                <span className="repo-label">
                  <span className="repo-owner">{repoOwner}/</span>
                  <span>{repoName}</span>
                </span>
              </button>
              <a
                className="repo-open-link"
                href={`https://github.com/${repoOwner}/${repoName}`}
                target="_blank"
                rel="noreferrer"
                title="Open on GitHub"
                aria-label="Open on GitHub"
              >
                <ExternalLinkIcon />
              </a>
            </span>
          ) : (
            hasSession && (
              <span className="repo-anchor align-workspace">
                <button
                  type="button"
                  className="btn ghost repo-btn repo-btn-empty"
                  onClick={() => setShowSwitcher((v) => !v)}
                  ref={repoButtonRef}
                  disabled={syncing}
                  title={repoButtonTitle}
                >
                  <GitHubIcon />
                  <span className="repo-label">
                    <span>Choose repository</span>
                  </span>
                </button>
              </span>
            )
          )}
        </div>
        <div className="topbar-actions">
          {!hasSession ? (
            <button className="btn primary" onClick={() => dispatch({ type: 'session.sign-in' })}>
              Connect GitHub
            </button>
          ) : (
            <>
              {canShare && (
                <button
                  className={`btn icon sync-btn${share.link ? ' sync-btn-active' : ''}`}
                  onClick={() => setShareOpen(true)}
                  ref={shareButtonRef}
                  title={
                    share.link
                      ? 'Manage share link'
                      : shareDisabled
                        ? 'Checking share status'
                        : 'Create share link'
                  }
                  aria-label={share.link ? 'Manage share link' : 'Create share link'}
                  disabled={shareDisabled}
                  aria-disabled={shareDisabled}
                >
                  <ShareIcon />
                </button>
              )}
              {canSync && (
                <button
                  className={`btn icon sync-btn ${syncing ? 'syncing' : ''}`}
                  onClick={() => dispatch({ type: 'sync.run', source: 'user' })}
                  disabled={syncing}
                  aria-label={syncing ? 'Syncing' : 'Sync now'}
                  title={syncing ? 'Syncing…' : 'Sync now'}
                >
                  <SyncIcon syncing={syncing} />
                </button>
              )}
              {user !== undefined && (
                <button
                  className="btn ghost account-btn"
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-label="Account menu"
                  ref={accountButtonRef}
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
                  <span>Files</span>
                  <span className="note-count">{files.length}</span>
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
              files={files}
              folders={folders}
              canEdit={canEdit}
              slug={slug}
              activePath={activePath}
              onSelect={onSelect}
              onCreateNote={onCreateNote}
              onCreateFolder={onCreateFolder}
              onRenameFile={onRenameFile}
              onMoveFile={onMoveFile}
              onDeleteFile={onDeleteFile}
              onRenameFolder={onRenameFolder}
              onMoveFolder={onMoveFolder}
              onDeleteFolder={onDeleteFolder}
            />
            {canSync ? (
              <div className="repo-autosync-toggle">
                <Toggle
                  checked={autosync}
                  onChange={(enabled) => dispatch({ type: 'sync.set-autosync', enabled })}
                  label="Autosync"
                  description="Runs background sync after edits and periodically."
                />
              </div>
            ) : null}
          </aside>
        )}
        <section className="workspace">
          <div className="workspace-body">
            {repoErrorType === 'network' && (
              <div className="alert warning">
                <span className="badge">Offline</span>
                <span className="alert-text">
                  Could not reach GitHub. {canEdit ? 'You can still edit notes offline.' : ''}
                </span>
              </div>
            )}
            {repoErrorType === 'rate-limited' && (
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
                {hasSession && (
                  <button
                    className="btn primary"
                    onClick={() =>
                      dispatch({ type: 'repo.request-access', owner: repoOwner!, repo: repoName! })
                    }
                  >
                    Get Write Access
                  </button>
                )}
              </div>
            )}
            {activeFile !== undefined ? (
              <div className="workspace-panels">
                {isMarkdownFile(activeFile) ? (
                  <Editor
                    key={activeFile.id}
                    doc={activeFile}
                    readOnly={!canEdit}
                    slug={slug}
                    loadAsset={loadAsset}
                    onImportAssets={helpers.importPastedAssets}
                    onChange={(path, text) => {
                      dispatch({ type: 'file.save', path, contents: text });
                    }}
                  />
                ) : isBinaryFile(activeFile) || isAssetUrlFile(activeFile) ? (
                  <AssetViewer key={activeFile.id} file={activeFile} />
                ) : isTextFile(activeFile) ? (
                  <TextEditor
                    key={activeFile.id}
                    doc={activeFile}
                    readOnly={!canEdit}
                    onChange={(path, text) => {
                      dispatch({ type: 'file.save', path, contents: text });
                    }}
                  />
                ) : null}
              </div>
            ) : needsUserAction ? (
              <div className="empty-state">
                <h2>{needsSessionRefresh ? 'Refresh GitHub access' : "Can't access this repository"}</h2>
                {needsSessionRefresh ? (
                  <>
                    <p>VibeNote lost permission to talk to GitHub for this repository.</p>
                    <p>Sign in again to refresh your session without clearing any local notes.</p>
                    <button className="btn primary" onClick={() => dispatch({ type: 'session.sign-in' })}>
                      Sign in again
                    </button>
                  </>
                ) : (
                  <>
                    <p>This repository is private or not yet enabled for the VibeNote GitHub App.</p>
                    <p>
                      Continue to GitHub and either select <strong>Only select repositories</strong> and pick
                      <code>
                        {' '}
                        {repoOwner}/{repoName}
                      </code>
                      , or grant access to all repositories (not recommended).
                    </p>
                    {hasSession ? (
                      <button
                        className="btn primary"
                        onClick={() =>
                          dispatch({ type: 'repo.request-access', owner: repoOwner!, repo: repoName! })
                        }
                      >
                        Get Read/Write Access
                      </button>
                    ) : (
                      <p>Please sign in with GitHub to request access.</p>
                    )}
                  </>
                )}
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
          </div>
          {statusMessage !== undefined && (
            <div className="status-banner">
              <span>Status</span>
              <span>{statusMessage}</span>
            </div>
          )}
        </section>
      </div>
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}

      {menuOpen && user !== undefined && (
        <div className="account-menu" ref={accountMenuRef}>
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
              dispatch({ type: 'session.sign-out' });
              setMenuOpen(false);
            }}
          >
            Sign out
          </button>
          {manageUrl !== undefined && repoOwner !== undefined && (
            <a className="btn subtle full-width" href={manageUrl} target="_blank" rel="noreferrer">
              Manage VibeNote installation for {repoOwner}
            </a>
          )}
        </div>
      )}
      {showSwitcher && (
        <RepoSwitcher
          currentSlug={slug}
          recents={state.repos.recents}
          probe={state.repos.probe}
          dispatch={dispatch}
          onClose={() => setShowSwitcher(false)}
          triggerRef={repoButtonRef}
        />
      )}
      {shareOpen && (
        <ShareDialog
          share={share}
          notePath={activePath}
          triggerRef={shareButtonRef}
          onClose={() => setShareOpen(false)}
          onCreate={async () => {
            if (activePath !== undefined) dispatch({ type: 'share.create', notePath: activePath });
          }}
          onRevoke={async () => {
            if (activePath !== undefined) dispatch({ type: 'share.revoke', notePath: activePath });
          }}
          onRefresh={async () => {
            if (activePath !== undefined) dispatch({ type: 'share.refresh', notePath: activePath });
          }}
        />
      )}
    </div>
  );
}

type FileSidebarProps = {
  files: FileMeta[];
  folders: string[];
  canEdit: boolean;
  slug: string;
  activePath: string | undefined;
  onSelect: (path: string | undefined) => void;
  onCreateNote: (dir: string, name: string) => string | undefined;
  onCreateFolder: (parentDir: string, name: string) => void;
  onRenameFile: (path: string, name: string) => void;
  onMoveFile: (path: string, targetDir: string) => string | undefined;
  onDeleteFile: (path: string) => void;
  onRenameFolder: (dir: string, newName: string) => void;
  onMoveFolder: (dir: string, targetDir: string) => string | undefined;
  onDeleteFolder: (dir: string) => void;
};

function FileSidebar(props: FileSidebarProps) {
  let {
    canEdit,
    files,
    slug,
    folders,
    activePath,
    onSelect,
    onCreateNote,
    onCreateFolder,
    onRenameFile,
    onMoveFile,
    onDeleteFile,
    onRenameFolder,
    onMoveFolder,
    onDeleteFolder,
  } = props;

  // Derive file entries for the tree component from the provided notes list.
  let treeFiles = useMemo<FileEntry[]>(
    () =>
      files.map((file) => ({
        name: basename(file.path),
        path: file.path,
        dir: extractDir(file.path),
        title: stripExtension(basename(file.path)),
        kind: file.kind,
      })),
    [files]
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
    { kind: 'folder'; path: string } | { kind: 'file'; path: string } | null
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
    if (selection?.kind === 'folder') return selection.path;
    if (selection?.kind === 'file') {
      let normalized = normalizePath(selection.path);
      let f = files.find((f) => normalizePath(f.path) === normalized);
      return f ? extractDir(f.path) : '';
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
          files={treeFiles}
          folders={folders}
          activePath={activePath}
          collapsed={collapsed}
          onCollapsedChange={setCollapsedMap}
          onSelectionChange={setSelection}
          onSelectFile={onSelect}
          onRenameFile={onRenameFile}
          onMoveFile={onMoveFile}
          onDeleteFile={onDeleteFile}
          onCreateFile={(dir, name) => {
            const createdPath = onCreateNote(dir, name);
            if (createdPath !== undefined) onSelect(createdPath);
          }}
          onCreateFolder={onCreateFolder}
          onRenameFolder={onRenameFolder}
          onMoveFolder={onMoveFolder}
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

function buildMovedFilePath(path: string, targetDir: string): string {
  let name = basename(path);
  let normalizedDir = normalizePath(targetDir);
  if (normalizedDir === '') return name;
  return `${normalizedDir}/${name}`;
}

function buildMovedFolderPath(path: string, targetDir: string): string {
  let parts = normalizePath(path).split('/');
  let folderName = parts[parts.length - 1] ?? path;
  let normalizedDir = normalizePath(targetDir);
  if (normalizedDir === '') return folderName;
  return `${normalizedDir}/${folderName}`;
}

function detectPrimaryShortcut(): 'meta' | 'ctrl' {
  if (typeof navigator === 'undefined') return 'ctrl';
  let platform = navigator.platform ?? '';
  if (!platform && typeof navigator.userAgent === 'string') platform = navigator.userAgent;
  const APPLE_PLATFORM_PATTERN = /mac|iphone|ipad|ipod/i;
  if (APPLE_PLATFORM_PATTERN.test(platform)) return 'meta';
  return 'ctrl';
}
