import { useMemo, useState, useEffect, useRef, useSyncExternalStore, useCallback } from 'react';
import { FileTree, type FileEntry } from './FileTree';
import { Editor } from './Editor';
import {
  LocalStore,
  isRepoLinked,
  markRepoLinked,
  isAutosyncEnabled,
  setAutosyncEnabled,
  getLastAutoSyncAt,
  recordAutoSyncRun,
  type NoteMeta,
  type NoteDoc,
  clearAllLocalData,
  getLastActiveNoteId,
  setLastActiveNoteId,
  getExpandedFolders,
  setExpandedFolders,
} from '../storage/local';
import {
  signInWithGitHubApp,
  getSessionToken as getAppSessionToken,
  getSessionUser as getAppSessionUser,
  ensureFreshAccessToken,
  signOutFromGitHubApp,
} from '../auth/app-auth';
import {
  getRepoMetadata as apiGetRepoMetadata,
  getInstallUrl as apiGetInstallUrl,
  type RepoMetadata,
} from '../lib/backend';
import { fetchPublicRepoInfo } from '../lib/github-public';
import {
  buildRemoteConfig,
  pullNote,
  listNoteFiles,
  syncBidirectional,
  type RemoteConfig,
  type SyncSummary,
} from '../sync/git-sync';
import { hashText } from '../storage/local';
import { RepoSwitcher } from './RepoSwitcher';
import { Toggle } from './Toggle';
import { GitHubIcon, ExternalLinkIcon, NotesIcon, CloseIcon, SyncIcon } from './RepoIcons';
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

type RepoAccessLevel = 'none' | 'read' | 'write';
type RepoAccessStatus = 'idle' | 'checking' | 'ready' | 'rate-limited' | 'error';
type RepoAccessState = {
  level: RepoAccessLevel;
  status: RepoAccessStatus;
  metadata: RepoMetadata | null;
  defaultBranch: string | null;
  error: string | null;
  rateLimited: boolean;
  needsInstall: boolean;
  manageUrl: string | null;
  isPrivate: boolean | null;
};

type ReadOnlyNote = { id: string; path: string; title: string; dir: string; sha?: string };

const initialAccessState: RepoAccessState = {
  level: 'none',
  status: 'idle',
  metadata: null,
  defaultBranch: null,
  error: null,
  rateLimited: false,
  needsInstall: false,
  manageUrl: null,
  isPrivate: null,
};

const AUTO_SYNC_MIN_INTERVAL_MS = 60_000;
const AUTO_SYNC_DEBOUNCE_MS = 10_000;

export function RepoView(props: RepoViewProps) {
  return <RepoViewInner key={props.slug} {...props} />;
}

function RepoViewInner({ slug, route, navigate, onRecordRecent }: RepoViewProps) {
  // ORIGINAL STATE AND MAIN HOOKS

  // Local storage wrapper
  const store = useMemo(() => {
    if (route.kind === 'repo') {
      return new LocalStore(slug);
    }
    return new LocalStore(slug, { seedWelcome: true });
  }, [slug, route.kind]);
  const { localNotes, localFolders, notifyStoreListeners } = useRepoStore(store);

  // Hold the currently loaded read-only note so the editor can render remote content.
  const [readOnlyDoc, setReadOnlyDoc] = useState<NoteDoc | null>(null);

  // Cache read-only note metadata fetched straight from GitHub when in view-only mode.
  const [readOnlyNotes, setReadOnlyNotes] = useState<ReadOnlyNote[]>([]);

  // Indicate when remote read-only data is being fetched to show loading states.
  const [readOnlyLoading, setReadOnlyLoading] = useState(false);

  // Store the current GitHub App session token to toggle authenticated features instantly.
  const [sessionToken, setSessionToken] = useState(getAppSessionToken);

  // Carry the latest sync status message shown across the workspace.
  // TODO make this disappear after a timeout
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  // Track whether this repo slug has already been linked to GitHub sync.
  const [linked, setLinked] = useState(() => isRepoLinked(slug));

  // Keep the signed-in GitHub App user details for header UI.
  const [user, setUser] = useState(getAppSessionUser);
  const userAvatarSrc = user?.avatarDataUrl ?? user?.avatarUrl ?? undefined;

  // Query GitHub for repo access state and other metadata.
  const repoAccess = useRepoAccess({ route, sessionToken, linked });

  // DERIVED STATE (and hooks that depend on it)

  const manageUrl = repoAccess.manageUrl;
  const accessStatusReady =
    repoAccess.status === 'ready' || repoAccess.status === 'rate-limited' || repoAccess.status === 'error';
  const isMetadataError = repoAccess.status === 'error';
  const isReadOnly = repoAccess.level === 'read';

  // whether we treat the repo as locally writable
  // note that we are optimistic about write access until the access check completes
  const canEdit =
    route.kind === 'new' ||
    (!!sessionToken && (repoAccess.level === 'write' || (!accessStatusReady && linked)));

  const needsInstallForPrivate = repoAccess.needsInstall;
  const isRateLimited = repoAccess.status === 'rate-limited';

  const { autosync, setAutosync, scheduleAutoSync, performSync, syncing } = useAutosync({
    slug,
    route,
    store,
    sessionToken,
    linked,
    canEdit,
    notifyStoreListeners,
  });

  // TODO why does this depend on _local notes_ rather than active notes?
  const { activeId, setActiveId } = useActiveNote({ slug, store, notes: localNotes, canEdit });

  const localDoc = useMemo(() => {
    if (!canEdit) return null;
    if (!activeId) return null;
    return store.loadNote(activeId);
  }, [canEdit, activeId, store, localNotes]);

  const activeNotes = isReadOnly ? readOnlyNotes : localNotes;

  const doc = canEdit ? localDoc : readOnlyDoc;

  // Derive the folder set from whichever source is powering the tree.
  const activeFolders = useMemo(() => {
    if (isReadOnly) {
      const set = new Set<string>();
      for (const note of readOnlyNotes) {
        if (!note.dir) continue;
        let current = note.dir.replace(/(^\/+|\/+?$)/g, '');
        // we also need all ancestor folders
        while (current) {
          set.add(current);
          const idx = current.lastIndexOf('/');
          current = idx >= 0 ? current.slice(0, idx) : '';
        }
      }
      return Array.from(set).sort();
    }
    return localFolders;
  }, [localFolders, isReadOnly, readOnlyNotes]);

  // CALLBACKS / HELPERS

  // Fetch the latest contents when a read-only file is selected from the tree.
  const loadReadOnlyNote = useCallback(
    async (id: string) => {
      const entry = readOnlyNotes.find((n) => n.id === id);
      if (!entry) return;
      const cfg = remoteConfigForSlug(slug, repoAccess.defaultBranch);
      try {
        const remote = await pullNote(cfg, entry.path);
        if (!remote) return;
        setReadOnlyDoc({
          id: entry.id,
          path: entry.path,
          title: entry.title,
          dir: entry.dir,
          text: remote.text,
          updatedAt: Date.now(),
          lastRemoteSha: remote.sha,
          lastSyncedHash: hashText(remote.text),
        });
      } catch (error) {
        console.error(error);
      }
    },
    [readOnlyNotes, slug, repoAccess.defaultBranch]
  );

  // EFFECTS

  // Remember recently opened repos once we know the current repo is reachable.
  useEffect(() => {
    if (route.kind !== 'repo') return;
    if (repoAccess.level === 'none') return;
    onRecordRecent({
      slug,
      owner: route.owner,
      repo: route.repo,
      connected: repoAccess.level === 'write' && linked,
    });
  }, [slug, route, linked, onRecordRecent, repoAccess.level]);

  // Kick off the one-time remote import when visiting a writable repo we have not linked yet.
  const initialPullRef = useRef({ done: false });

  useEffect(() => {
    (async () => {
      if (route.kind !== 'repo') return;
      if (repoAccess.level !== 'write') return;
      if (!canEdit) return;
      if (linked) return;
      if (initialPullRef.current.done) return;
      try {
        const cfg: RemoteConfig = remoteConfigForSlug(slug, repoAccess.defaultBranch);
        const entries = await listNoteFiles(cfg);
        const files: { path: string; text: string; sha?: string }[] = [];
        for (const e of entries) {
          const rf = await pullNote(cfg, e.path);
          if (rf) files.push({ path: rf.path, text: rf.text, sha: rf.sha });
        }
        store.replaceWithRemote(files);
        notifyStoreListeners();
        const synced = store.listNotes();
        setActiveId((prev) => {
          if (prev) return prev;
          let stored = getLastActiveNoteId(slug);
          if (stored && synced.some((n) => n.id === stored)) return stored;
          return null;
        });
        markRepoLinked(slug);
        setLinked(true);
        setSyncMsg('Loaded repository');
      } catch (e) {
        console.error(e);
      } finally {
        initialPullRef.current.done = true;
      }
    })();
  }, [route, repoAccess.level, linked, slug, store, canEdit, repoAccess.defaultBranch]);

  // Drop any cached read-only data once we gain write access.
  useEffect(() => {
    if (isReadOnly) return;
    setReadOnlyNotes((prev) => (prev.length === 0 ? prev : []));
    setReadOnlyDoc((prev) => (prev === null ? prev : null));
    setReadOnlyLoading(false);
  }, [isReadOnly]);

  // Populate the read-only note list straight from GitHub when we lack write access.
  useEffect(() => {
    if (!isReadOnly) return;
    let cancelled = false;
    setReadOnlyLoading(true);
    (async () => {
      try {
        const cfg = remoteConfigForSlug(slug, repoAccess.defaultBranch);
        const entries = await listNoteFiles(cfg);
        const toTitle = (path: string) => {
          const base = path.slice(path.lastIndexOf('/') + 1);
          return base.replace(/\.md$/i, '');
        };
        const mapped: ReadOnlyNote[] = entries.map((entry) => {
          const title = toTitle(entry.path);
          const dir = (() => {
            const idx = entry.path.lastIndexOf('/');
            return idx >= 0 ? entry.path.slice(0, idx) : '';
          })();
          return { id: entry.path, path: entry.path, title, dir, sha: entry.sha };
        });
        if (cancelled) return;
        setReadOnlyNotes(mapped);
        if (mapped.length > 0) {
          const first = mapped[0]!;
          setActiveId(first.id);
          const remote = await pullNote(cfg, first.path);
          if (!remote || cancelled) return;
          setReadOnlyDoc({
            id: first.id,
            path: first.path,
            title: first.title,
            dir: first.dir,
            text: remote.text,
            updatedAt: Date.now(),
            lastRemoteSha: remote.sha,
            lastSyncedHash: hashText(remote.text),
          });
        } else {
          setReadOnlyDoc(null);
          setActiveId(null);
        }
        if (!cancelled) setReadOnlyLoading(false);
      } catch (e) {
        console.error(e);
        if (!cancelled) setReadOnlyLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      setReadOnlyLoading(false);
    };
  }, [isReadOnly, slug, repoAccess.defaultBranch]);

  // Attempt a last-minute sync via the Service Worker so pending edits survive tab closure.
  useEffect(() => {
    if (route.kind !== 'repo') return;
    if (!sessionToken || !linked || slug === 'new' || !canEdit) return;
    if (!('serviceWorker' in navigator)) return;

    const flushViaServiceWorker = async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const ctrl = reg?.active;
        if (!ctrl) return;
        const accessToken = await ensureFreshAccessToken();
        if (!accessToken) return;
        const cfg = remoteConfigForSlug(slug, repoAccess.defaultBranch);
        const pending = store
          .listNotes()
          .map((meta) => store.loadNote(meta.id))
          .filter((doc): doc is NoteDoc => !!doc)
          .filter((doc) => doc.lastSyncedHash !== hashText(doc.text ?? ''))
          .map((doc) => ({
            path: doc.path,
            text: doc.text ?? '',
            baseSha: doc.lastRemoteSha,
            message: 'vibenote: background sync',
          }));
        if (pending.length === 0) return;
        ctrl.postMessage({
          type: 'vibenote-flush',
          payload: {
            token: accessToken,
            config: cfg,
            files: pending,
          },
        });
      } catch (err) {
        // Background flush is best effort; log for debugging only.
        console.warn('vibenote: background flush failed', err);
      }
    };

    const onPageHide = () => {
      void flushViaServiceWorker();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') void flushViaServiceWorker();
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [route.kind, sessionToken, linked, slug, canEdit, store, repoAccess.defaultBranch]);

  // CLICK HANDLERS

  // "Connect GitHub" button in the header
  const onConnect = async () => {
    try {
      const result = await signInWithGitHubApp();
      if (result) {
        setSessionToken(result.token);
        setUser(result.user);
      }
    } catch (e) {
      console.error(e);
      setSyncMsg('Failed to sign in');
    }
  };

  // "Get Write Access" or "Get Read/Write Access" button
  const openAccessSetup = async () => {
    try {
      // the app is already installed and we go straight into the right user's settings to manage repos
      if (manageUrl && repoAccess.metadata?.repoSelected === false) {
        window.open(manageUrl, '_blank', 'noopener');
        return;
      }
      // otherwise, we build a link that will first prompt to select the organization/user to install in
      if (route.kind !== 'repo') return;
      const url = await apiGetInstallUrl(route.owner, route.repo, window.location.href);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      console.error(e);
      setSyncMsg('Failed to open GitHub');
    }
  };

  // "Sign out" button in the account menu
  const onSignOut = async () => {
    try {
      await signOutFromGitHubApp();
    } catch (err) {
      console.warn('vibenote: failed to sign out cleanly', err);
    }
    clearAllLocalData();
    store.replaceWithRemote([]);
    notifyStoreListeners();
    setSessionToken(null);
    setUser(null);
    setLinked(false);
    setAutosync(false);
    setMenuOpen(false);
    setReadOnlyNotes([]);
    setActiveId(null);
    setReadOnlyDoc(null);
    initialPullRef.current.done = false;
    setSyncMsg('Signed out');
  };

  // "Sync" button in the header
  const onSyncNow = async () => {
    try {
      setSyncMsg(null);
      if (!sessionToken || !linked || slug === 'new' || !canEdit) {
        setSyncMsg('Connect GitHub and configure repo first');
        return;
      }
      const summary = await performSync();
      const parts: string[] = [];
      if (summary?.pulled) parts.push(`pulled ${summary.pulled}`);
      if (summary?.merged) parts.push(`merged ${summary.merged}`);
      if (summary?.pushed) parts.push(`pushed ${summary.pushed}`);
      if (summary?.deletedRemote) parts.push(`deleted remote ${summary.deletedRemote}`);
      if (summary?.deletedLocal) parts.push(`deleted local ${summary.deletedLocal}`);
      setSyncMsg(parts.length ? `Synced: ${parts.join(', ')}` : 'Up to date');
    } catch (err) {
      console.error(err);
      setSyncMsg('Sync failed');
    }
  };

  // UI STATE AND EFFECTS

  const showSidebar = canEdit || isReadOnly;
  const layoutClass = showSidebar ? '' : 'single';

  // Track sidebar visibility, especially for mobile drawer toggles.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Track whether the account dropdown menu is currently expanded.
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the account dropdown when clicking anywhere else on the page.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.account-menu') && !target.closest('.account-btn')) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  // Toggle the repo switcher overlay.
  const [showSwitcher, setShowSwitcher] = useState(false);

  // Keyboard shortcuts: Cmd/Ctrl+K and "g" then "r" open the repo switcher.
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
      // Always allow Ctrl/Cmd+K to open the switcher, even when typing
      if ((e.ctrlKey || e.metaKey) && key === 'k') {
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
      }
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
                title={linked ? 'Change repository' : 'Choose repository'}
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
                title="Choose repository"
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
            <>
              <button className="btn primary" onClick={onConnect}>
                Connect GitHub
              </button>
            </>
          ) : (
            <>
              {linked && canEdit && (
                <button
                  className={`btn secondary sync-btn ${syncing ? 'is-syncing' : ''}`}
                  onClick={onSyncNow}
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
                  <span className="note-count">{activeNotes.length}</span>
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
              notes={activeNotes}
              folders={activeFolders}
              canEdit={canEdit}
              slug={slug}
              activeId={activeId}
              setActiveId={setActiveId}
              closeSidebar={() => setSidebarOpen(false)}
              store={store}
              notifyStoreListeners={notifyStoreListeners}
              scheduleAutoSync={scheduleAutoSync}
              setSyncMsg={setSyncMsg}
              loadReadOnlyNote={loadReadOnlyNote}
            />
            {route.kind === 'repo' && linked && canEdit ? (
              <div className="repo-autosync-toggle">
                <Toggle
                  checked={autosync}
                  onChange={(enabled) => {
                    setAutosync(enabled);
                  }}
                  label="Autosync"
                  description="Runs background sync after edits and periodically."
                />
              </div>
            ) : null}
          </aside>
        )}
        <section className="workspace">
          <div className="workspace-body">
            {readOnlyLoading ? (
              <div className="empty-state">
                <h2>Loading repository…</h2>
                <p>Fetching files from GitHub. Hang tight.</p>
              </div>
            ) : route.kind === 'repo' && needsInstallForPrivate ? (
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
                  <button className="btn primary" onClick={openAccessSetup}>
                    Get Read/Write Access
                  </button>
                ) : (
                  <p>Please sign in with GitHub to request access.</p>
                )}
              </div>
            ) : (
              <>
                {isMetadataError && (
                  <div className="alert warning">
                    <span className="badge">Offline</span>
                    <span className="alert-text">
                      Could not reach GitHub. You can still edit notes offline.
                    </span>
                  </div>
                )}
                {!isMetadataError && isRateLimited && (
                  <div className="alert warning">
                    <span className="badge">Limited</span>
                    <span className="alert-text">
                      GitHub rate limits temporarily prevent checking repository access. Public repositories
                      remain viewable; retry shortly for private access checks.
                    </span>
                  </div>
                )}
                {isReadOnly && (
                  <div className="alert">
                    <span className="badge">Read-only</span>
                    <span className="alert-text">You can view, but not edit files in this repository.</span>
                    {sessionToken ? (
                      <button className="btn primary" onClick={openAccessSetup}>
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
                      readOnly={isReadOnly || needsInstallForPrivate || !canEdit}
                      onChange={(id, text) => {
                        store.saveNote(id, text);
                        scheduleAutoSync();
                      }}
                    />
                  </div>
                ) : isReadOnly ? (
                  <div className="empty-state">
                    <h2>Browse on GitHub to view files</h2>
                    <p>This repository has no notes cached locally yet.</p>
                    <p>
                      Open the repository on GitHub or select a file from the sidebar to load it in VibeNote.
                    </p>
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
          {syncMsg && (
            <div className="status-banner">
              <span>Status</span>
              <span>{syncMsg}</span>
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
          <button className="btn subtle full-width" onClick={onSignOut}>
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

type RepoAccessParams = {
  route: Route;
  sessionToken: string | null;
  linked: boolean;
};

type AccessDeriveInput = {
  meta: RepoMetadata;
  isPrivate: boolean | null;
  defaultBranch: string | null;
  rateLimited: boolean;
  sessionToken: string | null;
  usedPublicRead: boolean;
};

function useRepoAccess({ route, sessionToken, linked }: RepoAccessParams): RepoAccessState {
  const owner = route.kind === 'repo' ? route.owner : null;
  const repo = route.kind === 'repo' ? route.repo : null;
  // Track the evolving access status/metadata for the active repository target.
  const [state, setState] = useState<RepoAccessState>({ ...initialAccessState, status: 'checking' });

  // Query GitHub (and the public fallback) whenever the targeted repo changes.
  useEffect(() => {
    if (!owner || !repo) return;
    let cancelled = false;
    const checkingState: RepoAccessState = { ...initialAccessState, status: 'checking' };
    setState((prev) => (areAccessStatesEqual(prev, checkingState) ? prev : checkingState));
    (async () => {
      try {
        const meta = await apiGetRepoMetadata(owner, repo);
        let isPrivate = meta.isPrivate;
        let defaultBranch = meta.defaultBranch;
        let rateLimited = meta.rateLimited === true;
        let usedPublicRead = false;
        if ((isPrivate === null || defaultBranch === null) && !meta.repoSelected) {
          const info = await fetchPublicRepoInfo(owner, repo);
          if (info.ok) {
            if (isPrivate === null && typeof info.isPrivate === 'boolean') isPrivate = info.isPrivate;
            if (defaultBranch === null) defaultBranch = info.defaultBranch ?? null;
            usedPublicRead = info.isPrivate === false;
          } else {
            if (typeof info.isPrivate === 'boolean' && isPrivate === null) isPrivate = info.isPrivate;
            if (info.rateLimited) rateLimited = true;
          }
        }
        const next = deriveAccessFromMetadata({
          meta,
          isPrivate,
          defaultBranch,
          rateLimited,
          sessionToken,
          usedPublicRead,
        });
        if (!cancelled) {
          setState((prev) => (areAccessStatesEqual(prev, next) ? prev : next));
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'unknown-error';
        const errorState: RepoAccessState = {
          ...initialAccessState,
          level: 'none',
          status: 'error',
          error: message,
        };
        setState((prev) => (areAccessStatesEqual(prev, errorState) ? prev : errorState));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, sessionToken, linked]);

  if (!owner || !repo) return initialAccessState;
  return state;
}

function deriveAccessFromMetadata(input: AccessDeriveInput): RepoAccessState {
  const { meta, isPrivate, defaultBranch, rateLimited, sessionToken, usedPublicRead } = input;
  const hasSession = !!sessionToken;
  const repoSelected = meta.repoSelected === true;

  let level: RepoAccessLevel = 'none';
  if (repoSelected && hasSession) {
    level = 'write';
  } else if (repoSelected) {
    level = 'read';
  } else if (usedPublicRead || isPrivate === false) {
    level = 'read';
  } else {
    level = 'none';
  }

  const status: RepoAccessStatus = rateLimited ? 'rate-limited' : 'ready';
  const needsInstall = hasSession && isPrivate !== false && !repoSelected;

  return {
    level,
    status,
    metadata: meta,
    defaultBranch,
    error: null,
    rateLimited,
    needsInstall,
    manageUrl: meta.manageUrl ?? null,
    isPrivate,
  };
}

type RepoStoreSnapshot = {
  notes: NoteMeta[];
  folders: string[];
};

function useRepoStore(store: LocalStore) {
  const listenersRef = useRef(new Set<() => void>());
  const snapshotRef = useRef<RepoStoreSnapshot | undefined>(undefined);
  // set to initial state from localStorage on first render
  if (snapshotRef.current === undefined) {
    snapshotRef.current = readRepoSnapshot(store);
  }
  const storagePrefix = `vibenote:repo:${encodeURIComponent(store.slug)}:`;

  const emit = useCallback(() => {
    const current = snapshotRef.current!;
    const next = readRepoSnapshot(store);
    if (current && snapshotsEqual(current, next)) return;
    snapshotRef.current = next;
    for (const listener of listenersRef.current) {
      try {
        listener();
      } catch (err) {
        console.error('vibenote: repo store listener failed', err);
      }
    }
  }, [store]);

  // React to storage events from other tabs so the tree stays in sync across windows.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) return;
      if (!event.key || !event.key.startsWith(storagePrefix)) return;
      emit();
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [emit, storagePrefix]);

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const getSnapshot = useCallback(() => snapshotRef.current!, []);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return {
    localNotes: snapshot.notes,
    localFolders: snapshot.folders,
    notifyStoreListeners: emit,
  };
}

type AutosyncParams = {
  slug: string;
  route: Route;
  store: LocalStore;
  sessionToken: string | null;
  linked: boolean;
  canEdit: boolean;
  notifyStoreListeners: () => void;
};

type PerformSyncOptions = {
  silent?: boolean;
};

function useAutosync(params: AutosyncParams) {
  const { slug, route, store, sessionToken, linked, canEdit, notifyStoreListeners } = params;
  // Remember the user's autosync preference per repo slug.
  const [autosync, setAutosyncState] = useState<boolean>(() =>
    slug !== 'new' ? isAutosyncEnabled(slug) : false
  );
  // Indicate when a sync operation is currently running.
  const [syncing, setSyncing] = useState(false);
  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);

  // Pick up persisted autosync preferences when mounting for a repo.
  useEffect(() => {
    setAutosyncState(slug !== 'new' ? isAutosyncEnabled(slug) : false);
  }, [slug]);

  // Clear any pending timers if the hook gets torn down.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const performSync = useCallback(
    async (options: PerformSyncOptions = {}): Promise<SyncSummary | null> => {
      if (inFlightRef.current) return null;
      inFlightRef.current = true;
      setSyncing(true);
      try {
        if (!sessionToken || !linked || slug === 'new' || !canEdit) return null;
        const summary = await syncBidirectional(store, slug);
        recordAutoSyncRun(slug);
        notifyStoreListeners();
        return summary;
      } catch (err) {
        if (options.silent) {
          console.error(err);
          return null;
        }
        throw err;
      } finally {
        inFlightRef.current = false;
        setSyncing(false);
      }
    },
    [sessionToken, linked, slug, canEdit, store, notifyStoreListeners]
  );

  const scheduleAutoSync = useCallback(
    (debounceMs: number = AUTO_SYNC_DEBOUNCE_MS) => {
      if (!autosync) return;
      if (route.kind !== 'repo') return;
      if (!sessionToken || !linked || slug === 'new' || !canEdit) return;
      const last = getLastAutoSyncAt(slug) ?? 0;
      const now = Date.now();
      const dueIn = Math.max(0, AUTO_SYNC_MIN_INTERVAL_MS - (now - last));
      const delay = Math.max(debounceMs, dueIn);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void performSync({ silent: true });
      }, delay);
    },
    [autosync, route.kind, sessionToken, linked, slug, canEdit, performSync]
  );

  // Schedule an immediate background sync when autosync becomes eligible.
  useEffect(() => {
    if (route.kind !== 'repo') return;
    if (!autosync) return;
    if (!sessionToken || !linked || slug === 'new' || !canEdit) return;
    scheduleAutoSync(0);
  }, [route.kind, autosync, sessionToken, linked, slug, canEdit, scheduleAutoSync]);

  // Keep polling in the background so we pick up remote changes over time.
  useEffect(() => {
    if (route.kind !== 'repo') return;
    if (!autosync || !sessionToken || !linked || slug === 'new' || !canEdit) return;
    const id = window.setInterval(() => scheduleAutoSync(0), 180_000);
    return () => window.clearInterval(id);
  }, [route.kind, autosync, sessionToken, linked, slug, canEdit, scheduleAutoSync]);

  const setAutosync = useCallback(
    (enabled: boolean) => {
      setAutosyncState(enabled);
      setAutosyncEnabled(slug, enabled);
      if (!enabled) {
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        return;
      }
      scheduleAutoSync(0);
    },
    [scheduleAutoSync, slug]
  );

  return {
    autosync,
    setAutosync,
    scheduleAutoSync,
    performSync,
    syncing,
  } as const;
}

function useActiveNote({
  slug,
  store,
  notes,
  canEdit,
}: {
  slug: string;
  store: LocalStore;
  notes: NoteMeta[];
  canEdit: boolean;
}) {
  // Track the currently focused note id for the editor and file tree.
  const [activeId, setActiveId] = useState<string | null>(() => {
    const stored = getLastActiveNoteId(slug);
    if (!stored) return null;
    const available = store.listNotes();
    return available.some((note) => note.id === stored) ? stored : null;
  });

  // Restore the last active note from storage when loading an existing repo.
  useEffect(() => {
    if (activeId) return;
    const stored = getLastActiveNoteId(slug);
    if (!stored) return;
    if (notes.some((note) => note.id === stored)) setActiveId(stored);
  }, [slug, activeId, notes]);

  // Persist the active note id so future visits resume on the same file (when permitted).
  useEffect(() => {
    if (!canEdit) return;
    setLastActiveNoteId(slug, activeId ?? null);
  }, [activeId, slug, canEdit]);

  // Nudge the active note to a valid entry whenever the editable list changes.
  useEffect(() => {
    if (!canEdit) return;
    setActiveId((prev) => {
      if (prev && notes.some((note) => note.id === prev)) return prev;
      if (prev) return notes[0]?.id ?? null;
      return prev;
    });
  }, [canEdit, notes]);

  return { activeId, setActiveId } as const;
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

type FileSidebarProps = {
  notes: (NoteMeta | ReadOnlyNote)[];
  folders: string[];
  canEdit: boolean;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  slug: string;
  store: LocalStore;
  closeSidebar: () => void;
  notifyStoreListeners: () => void;
  scheduleAutoSync: (delay?: number) => void;
  setSyncMsg: (msg: string | null) => void;
  loadReadOnlyNote: (id: string) => Promise<void>;
};

function FileSidebar(props: FileSidebarProps) {
  let {
    canEdit,
    notes,
    slug,
    folders,
    activeId,
    setActiveId,
    closeSidebar,
    store,
    notifyStoreListeners,
    scheduleAutoSync,
    setSyncMsg,
    loadReadOnlyNote,
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

  const handleCreateFile = (dir: string, name: string) => {
    if (!canEdit) return;
    let id = store.createNote(name, '', dir);
    notifyStoreListeners();
    setActiveId(id);
    scheduleAutoSync();
    return id;
  };

  const handleCreateFolder = (parentDir: string, name: string) => {
    if (!canEdit) return;
    try {
      store.createFolder(parentDir, name);
      notifyStoreListeners();
    } catch (error) {
      console.error(error);
      setSyncMsg('Invalid folder name.');
    }
  };

  const handleRenameFile = (id: string, title: string) => {
    if (!canEdit) return;
    try {
      store.renameNote(id, title);
      notifyStoreListeners();
      scheduleAutoSync();
    } catch (error) {
      console.error(error);
      setSyncMsg('Invalid title. Avoid / and control characters.');
    }
  };

  const handleDeleteFile = (id: string) => {
    if (!canEdit) return;
    store.deleteNote(id);
    notifyStoreListeners();
    let list = store.listNotes();
    if (activeId === id) setActiveId(list[0]?.id ?? null);
    scheduleAutoSync();
  };

  const handleRenameFolder = (dir: string, newName: string) => {
    if (!canEdit) return;
    try {
      store.renameFolder(dir, newName);
      notifyStoreListeners();
      scheduleAutoSync();
    } catch (error) {
      console.error(error);
      setSyncMsg('Invalid folder name.');
    }
  };

  const handleDeleteFolder = (dir: string) => {
    if (!canEdit) return;
    let hasNotes = files.some((file) => file.dir === dir || file.dir.startsWith(dir + '/'));
    if (hasNotes && !window.confirm('Delete folder and all contained notes?')) return;
    store.deleteFolder(dir);
    notifyStoreListeners();
    let list = store.listNotes();
    if (activeId && !list.some((note) => note.id === activeId)) setActiveId(list[0]?.id ?? null);
    scheduleAutoSync();
  };

  const handleSelectFile = (id: string) => {
    if (!canEdit) {
      setActiveId(id);
      closeSidebar();
      loadReadOnlyNote(id);
      return;
    }
    setActiveId(id);
    closeSidebar();
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
          onSelectFile={handleSelectFile}
          onRenameFile={handleRenameFile}
          onDeleteFile={handleDeleteFile}
          onCreateFile={handleCreateFile}
          onCreateFolder={handleCreateFolder}
          onRenameFolder={handleRenameFolder}
          onDeleteFolder={handleDeleteFolder}
          newEntry={canEdit ? newEntry : null}
          onFinishCreate={() => setNewEntry(null)}
        />
      </div>
    </>
  );
}

function areAccessStatesEqual(a: RepoAccessState, b: RepoAccessState): boolean {
  return (
    a.level === b.level &&
    a.status === b.status &&
    a.metadata === b.metadata &&
    a.defaultBranch === b.defaultBranch &&
    a.error === b.error &&
    a.rateLimited === b.rateLimited &&
    a.needsInstall === b.needsInstall &&
    a.manageUrl === b.manageUrl &&
    a.isPrivate === b.isPrivate
  );
}

function remoteConfigForSlug(slug: string, branch: string | null): RemoteConfig {
  const cfg: RemoteConfig = buildRemoteConfig(slug);
  if (branch) cfg.branch = branch;
  return cfg;
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

function readRepoSnapshot(store: LocalStore): RepoStoreSnapshot {
  return {
    notes: store.listNotes(),
    folders: store.listFolders(),
  };
}

function snapshotsEqual(a: RepoStoreSnapshot, b: RepoStoreSnapshot): boolean {
  return noteMetasEqual(a.notes, b.notes) && foldersEqual(a.folders, b.folders);
}

function noteMetasEqual(a: NoteMeta[], b: NoteMeta[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (left.id !== right.id) return false;
    if (left.path !== right.path) return false;
    if (left.title !== right.title) return false;
    if ((left.dir || '') !== (right.dir || '')) return false;
    if (left.updatedAt !== right.updatedAt) return false;
  }
  return true;
}

function foldersEqual(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
