// Data-layer hook that orchestrates repo auth, storage, and sync state for RepoView.
import { useMemo, useState, useEffect, useRef, useSyncExternalStore, useCallback } from 'react';
import {
  isRepoLinked,
  markRepoLinked,
  isAutosyncEnabled,
  setAutosyncEnabled,
  getLastAutoSyncAt,
  recordAutoSyncRun,
  type FileMeta,
  type RepoFile,
  clearAllLocalData,
  getLastActiveFileId,
  setLastActiveFileId,
  getRepoStore,
  computeSyncedHash,
} from './storage/local';
import {
  signInWithGitHubApp,
  getSessionToken as getAppSessionToken,
  getSessionUser as getAppSessionUser,
  signOutFromGitHubApp,
  type AppUser,
  getAccessTokenRecord,
} from './auth/app-auth';
import {
  getRepoMetadata as apiGetRepoMetadata,
  getInstallUrl as apiGetInstallUrl,
  getShareLinkForNote as apiGetShareLinkForNote,
  createShareLink as apiCreateShareLink,
  revokeShareLink as apiRevokeShareLink,
  type RepoMetadata,
  type ShareLink,
} from './lib/backend';
import {
  buildRemoteConfig,
  syncBidirectional,
  type RemoteConfig,
  type SyncSummary,
  listRepoFiles,
  pullRepoFile,
  type RemoteFile,
} from './sync/git-sync';
import { logError } from './lib/logging';
import { useReadOnlyFiles } from './data/useReadOnlyFiles';
import { normalizePath } from './lib/util';
import type { RepoRoute } from './ui/routing';

export { useRepoData };
export type { RepoAccessState, RepoDataInputs, RepoDataState, RepoDataActions, ShareState };

const AUTO_SYNC_MIN_INTERVAL_MS = 60_000;
const AUTO_SYNC_DEBOUNCE_MS = 10_000;
const AUTO_SYNC_POLL_INTERVAL_MS = 180_000;

type ShareState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  link?: ShareLink;
  error?: string;
};

type RepoDataState = {
  // session state
  hasSession: boolean;
  user: AppUser | undefined;

  // repo access state
  canEdit: boolean;
  canRead: boolean;
  canSync: boolean;
  repoLinked: boolean;
  needsInstall: boolean;
  repoQueryStatus: RepoQueryStatus;
  manageUrl: string | undefined;
  defaultBranch: string | undefined;

  // repo content
  activeFile: RepoFile | undefined;
  activePath: string | undefined;
  files: FileMeta[];
  folders: string[];

  // sync state
  autosync: boolean;
  syncing: boolean;

  // general info
  share: ShareState;
  statusMessage: string | undefined;
};

type RepoDataActions = {
  // auth actions
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  openRepoAccess: () => Promise<void>;

  // syncing actions
  syncNow: () => Promise<void>;
  setAutosync: (enabled: boolean) => void;

  // edit notes/folders
  selectFile: (path: string | undefined) => Promise<void>;
  createNote: (dir: string, name: string) => string | undefined;
  createFolder: (parentDir: string, name: string) => void;
  renameFile: (path: string, name: string) => void;
  deleteFile: (path: string) => void;
  renameFolder: (dir: string, newName: string) => void;
  deleteFolder: (dir: string) => void;
  saveFile: (path: string, text: string) => void;
  createShareLink: () => Promise<void>;
  refreshShareLink: () => Promise<void>;
  revokeShareLink: () => Promise<void>;
};

type RepoDataInputs = {
  slug: string;
  route: RepoRoute;
  recordRecent: (entry: {
    slug: string;
    owner?: string;
    repo?: string;
    title?: string;
    connected?: boolean;
  }) => void;
  setActivePath: (notePath: string | undefined) => void;
};

/**
 * Data layer entry point.
 *
 * Invariants when calling this hook:
 * - `slug` and `route` are always in sync, and never change througout the component lifetime
 * - `recordRecent` and `setActivePath` are stable as well
 * - none of these will be put in dependency arrays
 */
function useRepoData({ slug, route, recordRecent, setActivePath }: RepoDataInputs): {
  state: RepoDataState;
  actions: RepoDataActions;
} {
  // ORIGINAL STATE AND MAIN HOOKS
  // Local storage wrapper
  let { files: localFiles, folders: localFolders } = useLocalRepoSnapshot(slug);

  // Store the current GitHub App session token to toggle authenticated features instantly.
  let [sessionToken, setSessionToken] = useState<string | undefined>(() => getAppSessionToken() ?? undefined);
  let hasSession = sessionToken !== undefined;

  // Carry the latest sync status message shown across the workspace.
  // TODO make this disappear after a timeout
  let [statusMessage, setStatusMessage] = useState<string | undefined>(undefined);

  // Track share metadata for the active note.
  let [shareState, setShareState] = useState<ShareState>({ status: 'idle' });

  // Track whether this repo slug has already been linked to GitHub sync.
  let [linked, setLinked] = useState(() => isRepoLinked(slug));

  // Keep the signed-in GitHub App user details for header UI.
  let [user, setUser] = useState<AppUser | undefined>(() => getAppSessionUser() ?? undefined);

  // Query GitHub for repo access state and other metadata.
  let repoAccess = useRepoAccess({ route, sessionToken });

  // DERIVED STATE (and hooks that depend on it)

  let { defaultBranch, manageUrl } = repoAccess;
  let repoOwner = route.kind === 'repo' ? route.owner : undefined;
  let repoName = route.kind === 'repo' ? route.repo : undefined;
  let accessStatusReady =
    repoAccess.status === 'ready' || repoAccess.status === 'rate-limited' || repoAccess.status === 'error';

  let desiredPath = normalizePath(route.notePath);

  // in readonly mode, we store nothing locally and just fetch content from github no demand
  let isReadOnly = repoAccess.level === 'read';
  let {
    files: readOnlyFiles,
    activeFile: activeReadOnlyFile,
    folders: readOnlyFolders,
    selectFile: selectReadOnlyFile,
    reset: resetReadOnlyState,
  } = useReadOnlyFiles({ slug, isReadOnly, defaultBranch, desiredPath });

  // whether we treat the repo as locally writable
  // note that we are optimistic about write access until the access check completes,
  // to avoid flickering the UI when revisiting a known writable repo
  let canEdit =
    route.kind === 'new' || (hasSession && (repoAccess.level === 'write' || (!accessStatusReady && linked)));

  let canSync = canEdit && route.kind === 'repo' && linked;

  let { autosync, syncing, setAutosync, scheduleAutoSync, performSync } = useSync({
    slug,
    canSync,
    defaultBranch,
  });

  // Derive the files/folders from whichever source is powering the tree.
  let files = isReadOnly ? readOnlyFiles : localFiles;
  let folders = isReadOnly ? readOnlyFolders : localFolders;

  // determine the active note
  let activeFileMeta = useMemo(() => {
    // if specified in the route, that takes precedence
    if (desiredPath !== undefined) return findByPath(files, desiredPath);
    if (!canEdit) return undefined;
    // otherwise try to restore last active file (if any)
    let storedId = getLastActiveFileId(slug);
    if (storedId !== undefined) {
      return files.find((file) => file.id === storedId);
    }
    // otherwise we don't show any file, that's fine
    return undefined;
  }, [canEdit, files, desiredPath]);

  let activeId = activeFileMeta?.id;

  let activeLocalFile = useMemo<RepoFile | undefined>(() => {
    if (!canEdit) return undefined;
    if (!activeId) return undefined;
    return getRepoStore(slug).loadFileById(activeId) ?? undefined;
  }, [canEdit, activeId]);

  let activeFile: RepoFile | undefined = canEdit ? activeLocalFile : activeReadOnlyFile;

  let activePath = activeFile?.path ?? activeFileMeta?.path ?? desiredPath;

  // EFFECTS
  // please avoid adding more effects here, keep logic clean/separated

  // Persist last active file id so writable repos can restore it later.
  useEffect(() => {
    if (canEdit) setLastActiveFileId(slug, activeId ?? null);
  }, [canEdit, activeId]);

  // When the loaded doc changes path (e.g., rename or sync or restoring last active), push the route forward.
  useEffect(() => {
    if (activeFile?.path === undefined) return;
    if (pathsEqual(desiredPath, activeFile.path)) return;
    setActivePath(activeFile.path);
  }, [activeFile?.path, desiredPath]);

  // Remember recently opened repos once we know the current repo is reachable.
  // TODO this shouldn't a useEffect, the only place a repo ever becomes reachable is after
  // fetching metadata, so just record it there
  useEffect(() => {
    if (route.kind !== 'repo') return;
    if (repoAccess.level === 'none') return;
    recordRecent({
      slug,
      owner: route.owner,
      repo: route.repo,
      connected: repoAccess.level === 'write' && linked,
    });
  }, [slug, route, linked, recordRecent, repoAccess.level]);

  let initialPullRef = useRef({ done: false });
  let shareRequestRef = useRef<{ owner: string; repo: string; path: string } | null>(null);

  const loadShareForTarget = useCallback(async (target: { owner: string; repo: string; path: string }) => {
    shareRequestRef.current = target;
    setShareState((prev) => {
      if (prev.status === 'ready' && prev.link && shareMatchesTarget(prev.link, target)) {
        return prev;
      }
      return { status: 'loading' };
    });
    try {
      const link = await apiGetShareLinkForNote(target.owner, target.repo, target.path);
      if (shareRequestRef.current && !shareTargetEquals(shareRequestRef.current, target)) return;
      if (link) {
        setShareState({ status: 'ready', link });
      } else {
        setShareState({ status: 'ready' });
      }
    } catch (error) {
      if (shareRequestRef.current && !shareTargetEquals(shareRequestRef.current, target)) return;
      logError(error);
      setShareState({ status: 'error', error: formatError(error) });
    }
  }, []);

  // Kick off the one-time remote import when visiting a writable repo we have not linked yet.
  useEffect(() => {
    (async () => {
      if (route.kind !== 'repo') return;
      if (repoAccess.level !== 'write') return;
      if (!canEdit) return;
      if (linked) return;
      if (initialPullRef.current.done) return;
      try {
        let cfg: RemoteConfig = buildRemoteConfig(slug, repoAccess.defaultBranch);
        let entries = await listRepoFiles(cfg);
        let files: RemoteFile[] = [];
        // TODO this should be done in parallel, or actually we shouldn't download all files
        for (let e of entries) {
          let rf = await pullRepoFile(cfg, e.path);
          if (rf) files.push(rf);
        }
        let localStore = getRepoStore(slug);
        localStore.replaceWithRemote(files);
        let synced = localStore.listFiles();
        // if we are not on a specific path yet and there's no stored active id, show README.md
        if (desiredPath === undefined) {
          let storedId = getLastActiveFileId(slug);
          let storedPath =
            storedId !== undefined ? synced.find((note) => note.id === storedId)?.path : undefined;
          let readmePath = synced.find((note) => note.path.toLowerCase() === 'readme.md')?.path;
          let initialPath = storedPath ?? readmePath;
          if (initialPath !== undefined && !pathsEqual(desiredPath, initialPath)) {
            setActivePath(initialPath);
          }
        }
        markRepoLinked(slug);
        setLinked(true);
        setStatusMessage('Loaded repository');
      } catch (error) {
        logError(error);
      } finally {
        initialPullRef.current.done = true;
      }
    })();
  }, [route, repoAccess.level, linked, slug, canEdit, defaultBranch, desiredPath]);

  useEffect(() => {
    if (!repoOwner || !repoName || !hasSession || !canEdit) {
      shareRequestRef.current = null;
      setShareState((prev) => (prev.status === 'idle' ? prev : { status: 'idle' }));
      return;
    }
    if (activePath === undefined) {
      shareRequestRef.current = null;
      setShareState((prev) => (prev.status === 'idle' ? prev : { status: 'idle' }));
      return;
    }
    const target = { owner: repoOwner, repo: repoName, path: activePath };
    const current = shareRequestRef.current;
    const sameTarget = current !== null && current !== undefined && shareTargetEquals(current, target);
    if (!sameTarget && shareState.status !== 'idle') {
      shareRequestRef.current = null;
      setShareState((prev) => (prev.status === 'idle' ? prev : { status: 'idle' }));
      return;
    }
    if (shareState.status !== 'idle') {
      return;
    }
    void loadShareForTarget(target);
  }, [repoOwner, repoName, activePath, hasSession, canEdit, shareState, loadShareForTarget]);

  // CLICK HANDLERS

  const ensureActivePath = (nextPath: string | undefined) => {
    if (pathsEqual(route.notePath, nextPath)) return;
    setActivePath(nextPath);
  };

  // "Connect GitHub" button in the header
  const signIn = async () => {
    try {
      let result = await signInWithGitHubApp();
      if (result !== null) {
        setSessionToken(result.token);
        setUser(result.user);
      }
    } catch (error) {
      logError(error);
      setStatusMessage('Failed to sign in');
    }
  };

  // "Get Write Access" or "Get Read/Write Access" button
  const openRepoAccess = async () => {
    try {
      if (manageUrl !== undefined && repoAccess.metadata?.repoSelected === false) {
        window.open(manageUrl, '_blank', 'noopener');
        return;
      }
      if (route.kind !== 'repo') return;
      let url = await apiGetInstallUrl(route.owner, route.repo, window.location.href);
      window.open(url, '_blank', 'noopener');
    } catch (error) {
      logError(error);
      setStatusMessage('Failed to open GitHub');
    }
  };

  // "Sign out" button in the account menu
  const signOut = async () => {
    try {
      await signOutFromGitHubApp();
    } catch (error) {
      console.warn('vibenote: failed to sign out cleanly', error);
    }
    // reset local storage
    clearAllLocalData();
    getRepoStore(slug).replaceWithRemote([]);

    // reset hook state
    setSessionToken(undefined);
    setUser(undefined);
    setLinked(false);
    setAutosync(false);
    resetReadOnlyState();
    ensureActivePath(undefined);
    initialPullRef.current.done = false;

    setStatusMessage('Signed out');
  };

  // "Sync" button in the header
  const syncNow = async () => {
    try {
      setStatusMessage(undefined);
      if (!hasSession || !linked || slug === 'new' || !canEdit) {
        setStatusMessage('Connect GitHub and configure repo first');
        return;
      }
      let summary = await performSync();
      let parts: string[] = [];
      if (summary?.pulled) parts.push(`pulled ${summary.pulled}`);
      if (summary?.merged) parts.push(`merged ${summary.merged}`);
      if (summary?.pushed) parts.push(`pushed ${summary.pushed}`);
      if (summary?.deletedRemote) parts.push(`deleted remote ${summary.deletedRemote}`);
      if (summary?.deletedLocal) parts.push(`deleted local ${summary.deletedLocal}`);
      setStatusMessage(parts.length ? `Synced: ${parts.join(', ')}` : 'Up to date');
    } catch (error) {
      logError(error);
      setStatusMessage('Sync failed');
    }
  };

  // click on a file in the sidebar
  const selectFile = async (path: string | undefined) => {
    await selectReadOnlyFile(path);
    ensureActivePath(path);
  };

  const saveFile = (path: string, content: string) => {
    if (!canEdit) return;
    getRepoStore(slug).saveFile(path, content);
    scheduleAutoSync();
  };

  // TODO: assumes markdown file. eventually we want to support creating other files as well,
  // but that would mean some kind of user input on the file type.
  const createNote = (dir: string, name: string) => {
    if (!canEdit) return undefined;
    let store = getRepoStore(slug);
    let trimmedDir = dir.trim();
    let basePath = trimmedDir === '' ? `${name}.md` : `${trimmedDir}/${name}.md`;
    let id = store.createFile(basePath, '');
    let created = store.loadFileById(id);
    scheduleAutoSync();
    if (created) {
      ensureActivePath(created.path);
      return created.path;
    }
    return undefined;
  };

  const createFolder = (parentDir: string, name: string) => {
    if (!canEdit) return;
    try {
      getRepoStore(slug).createFolder(parentDir, name);
    } catch (error) {
      logError(error);
      setStatusMessage('Invalid folder name.');
      return;
    }
    scheduleAutoSync();
  };

  const renameFile = (path: string, name: string) => {
    if (!canEdit) return;
    try {
      let store = getRepoStore(slug);
      let nextPath = store.renameFile(path, name);
      if (nextPath && pathsEqual(activePath, path)) {
        ensureActivePath(nextPath);
      }
      scheduleAutoSync();
    } catch (error) {
      logError(error);
      setStatusMessage('Invalid file name.');
    }
  };

  const deleteFile = (path: string) => {
    if (!canEdit) return;
    let removed = getRepoStore(slug).deleteFile(path);
    if (!removed) {
      setStatusMessage('Unable to delete file.');
      return;
    }
    if (pathsEqual(activePath, path)) ensureActivePath(undefined);
    scheduleAutoSync();
  };

  const renameFolder = (dir: string, newName: string) => {
    if (!canEdit) return;
    try {
      getRepoStore(slug).renameFolder(dir, newName);
      scheduleAutoSync();
    } catch (error) {
      logError(error);
      setStatusMessage('Invalid folder name.');
    }
  };

  const deleteFolder = (dir: string) => {
    if (!canEdit) return;
    let localStore = getRepoStore(slug);
    let files = localStore.listFiles();
    let hasFiles = files.some((f) => f.dir === dir || f.dir.startsWith(dir + '/'));
    if (hasFiles && !window.confirm('Delete folder and all contained files?')) return;
    localStore.deleteFolder(dir);
    if (activePath !== undefined && isPathInsideDir(activePath, dir)) {
      ensureActivePath(undefined);
    }
    scheduleAutoSync();
  };

  const createShare = async () => {
    if (!repoOwner || !repoName || !canEdit) return;
    if (!hasSession) {
      setShareState({ status: 'error', error: 'Sign in with GitHub to share notes.' });
      return;
    }
    if (activePath === undefined) {
      setShareState({ status: 'error', error: 'Select a note to share.' });
      return;
    }
    const target = { owner: repoOwner, repo: repoName, path: activePath };
    shareRequestRef.current = target;
    setShareState({ status: 'loading' });
    try {
      const branch = defaultBranch ?? 'main';
      const share = await apiCreateShareLink({
        owner: target.owner,
        repo: target.repo,
        path: target.path,
        branch,
      });
      if (!shareMatchesTarget(share, target)) {
        return;
      }
      setShareState({ status: 'ready', link: share });
    } catch (error) {
      logError(error);
      setShareState({ status: 'error', error: formatError(error) });
      throw error;
    }
  };

  const revokeShare = async () => {
    const existing = shareState.link;
    if (!existing) return;
    setShareState({ status: 'loading' });
    try {
      await apiRevokeShareLink(existing.id);
      setShareState({ status: 'ready' });
    } catch (error) {
      logError(error);
      setShareState({ status: 'error', error: formatError(error) });
      throw error;
    }
  };

  const refreshShare = async () => {
    if (!repoOwner || !repoName || !hasSession || activePath === undefined) {
      setShareState({ status: 'idle' });
      return;
    }
    await loadShareForTarget({ owner: repoOwner, repo: repoName, path: activePath });
  };

  let state: RepoDataState = {
    hasSession,
    user,

    canRead: canEdit || isReadOnly,
    canEdit,
    canSync,
    repoLinked: linked,
    repoQueryStatus: repoAccess.status,
    needsInstall: repoAccess.needsInstall,
    manageUrl,

    activeFile,
    activePath,
    files,
    folders,

    autosync,
    syncing,
    share: shareState,
    statusMessage,
    defaultBranch,
  };

  let actions: RepoDataActions = {
    signIn,
    signOut,
    openRepoAccess,

    syncNow,
    setAutosync,
    selectFile,
    createNote,
    createFolder,
    renameFile,
    deleteFile,
    renameFolder,
    deleteFolder,
    saveFile,
    createShareLink: createShare,
    refreshShareLink: refreshShare,
    revokeShareLink: revokeShare,
  };

  return { state, actions };
}

// Subscribe to the LocalStore's internal cache so React re-renders whenever
// notes or folder lists change (including updates from other tabs).
function useLocalRepoSnapshot(slug: string) {
  let storeRef = useRef<ReturnType<typeof getRepoStore>>();
  if (storeRef.current?.slug !== slug) {
    storeRef.current = getRepoStore(slug);
  }
  let store = storeRef.current;
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
    () => store.getSnapshot()
  );
}

type RepoAccessLevel = 'none' | 'read' | 'write';
type RepoQueryStatus = 'unknown' | 'ready' | 'rate-limited' | 'error';

type RepoAccessState = {
  level: RepoAccessLevel;
  status: RepoQueryStatus;
  metadata?: RepoMetadata;
  defaultBranch?: string;
  error?: string;
  rateLimited: boolean;
  needsInstall: boolean;
  manageUrl?: string;
  isPrivate?: boolean;
};

const initialAccessState: RepoAccessState = {
  level: 'none',
  status: 'unknown',
  defaultBranch: undefined,
  rateLimited: false,
  needsInstall: false,
  manageUrl: undefined,
  isPrivate: undefined,
};

function useRepoAccess(params: { route: RepoRoute; sessionToken: string | undefined }): RepoAccessState {
  let { route, sessionToken } = params;
  let owner = route.kind === 'repo' ? route.owner : undefined;
  let repo = route.kind === 'repo' ? route.repo : undefined;

  // Track the evolving access status/metadata for the active repository target.
  let [state, setState] = useState<RepoAccessState>(initialAccessState);

  // Query GitHub (and the public fallback) whenever the targeted repo changes.
  useEffect(() => {
    if (owner === undefined || repo === undefined) return;
    let cancelled = false;
    (async () => {
      try {
        let meta = await apiGetRepoMetadata(owner, repo);
        let next = deriveAccessFromMetadata({ meta, hasSession: sessionToken !== undefined });
        if (!cancelled) {
          setState((prev) => (areAccessStatesEqual(prev, next) ? prev : next));
        }
      } catch (error) {
        if (cancelled) return;
        let message = error instanceof Error ? error.message : 'unknown-error';
        let errorState: RepoAccessState = {
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
  }, [owner, repo, sessionToken]);

  if (owner === undefined || repo === undefined) return initialAccessState;
  return state;
}

function deriveAccessFromMetadata({
  meta,
  hasSession,
}: {
  meta: RepoMetadata;
  hasSession: boolean;
}): RepoAccessState {
  let level: RepoAccessLevel = 'none';
  if (meta.repoSelected && hasSession) {
    level = 'write';
  } else if (meta.repoSelected) {
    level = 'read';
  } else if (meta.isPrivate === false) {
    level = 'read';
  } else {
    level = 'none';
  }

  return {
    level,
    status: meta.rateLimited ? 'rate-limited' : 'ready',
    metadata: meta,
    defaultBranch: meta.defaultBranch ?? undefined,
    error: undefined,
    rateLimited: meta.rateLimited === true,
    needsInstall: hasSession && level === 'none',
    manageUrl: meta.manageUrl ?? undefined,
    isPrivate: meta.isPrivate ?? undefined,
  };
}

function useSync(params: { slug: string; canSync: boolean; defaultBranch?: string }) {
  let { slug, defaultBranch, canSync } = params;
  let noSync = !canSync;

  // Remember the user's autosync preference per repo slug.
  let [autosync, setAutosyncState] = useState<boolean>(() =>
    slug !== 'new' ? isAutosyncEnabled(slug) : false
  );
  let noAutosync = !autosync || noSync;

  // Indicate when a sync operation is currently running.
  let [syncing, setSyncing] = useState(false);
  let timerRef = useRef<number | undefined>(undefined);
  let inFlightRef = useRef(false);

  // Pick up persisted autosync preferences when mounting for a repo.
  useEffect(() => {
    setAutosyncState(slug !== 'new' ? isAutosyncEnabled(slug) : false);
  }, [slug]);

  // Clear any pending timers if the hook gets torn down.
  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    };
  }, []);

  const performSync = async (options: { silent?: boolean } = {}): Promise<SyncSummary | undefined> => {
    if (inFlightRef.current) return undefined;
    inFlightRef.current = true;
    setSyncing(true);
    try {
      if (noSync) return undefined;
      let store = getRepoStore(slug);
      let summary = await syncBidirectional(store, slug);
      recordAutoSyncRun(slug);
      return summary;
    } catch (error) {
      if (options.silent) {
        logError(error);
        return undefined;
      }
      throw error;
    } finally {
      inFlightRef.current = false;
      setSyncing(false);
    }
  };

  const scheduleAutoSync = (debounceMs: number = AUTO_SYNC_DEBOUNCE_MS) => {
    if (noAutosync) return;
    let last = getLastAutoSyncAt(slug) ?? 0;
    let now = Date.now();
    let dueIn = Math.max(0, AUTO_SYNC_MIN_INTERVAL_MS - (now - last));
    let delay = Math.max(debounceMs, dueIn);
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      void performSync({ silent: true });
    }, delay);
  };

  // Schedule an immediate background sync when autosync becomes eligible.
  useEffect(() => {
    if (noAutosync) return;
    scheduleAutoSync(0);
  }, [noAutosync, slug]);

  // Keep polling in the background so we pick up remote changes over time.
  useEffect(() => {
    if (noAutosync) return;
    let id = window.setInterval(() => scheduleAutoSync(0), AUTO_SYNC_POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [noAutosync, slug]);

  const setAutosync = (enabled: boolean) => {
    setAutosyncState(enabled);
    setAutosyncEnabled(slug, enabled);
    if (!enabled) {
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
      return;
    }
    scheduleAutoSync(0);
  };

  // Attempt a last-minute sync via the Service Worker so pending edits survive tab closure.
  useEffect(() => {
    if (noSync || !('serviceWorker' in navigator)) return;

    const flushViaServiceWorker = async () => {
      try {
        let reg = await navigator.serviceWorker.ready;
        let ctrl = reg?.active;
        if (ctrl === null || ctrl === undefined) return;
        let accessToken = getAccessTokenRecord()?.token;
        if (accessToken === undefined) return;
        let cfg = buildRemoteConfig(slug, defaultBranch);
        let localStore = getRepoStore(slug);
        let pending = localStore
          .listFiles()
          .map((meta) => localStore.loadFileById(meta.id))
          .filter((note) => note !== null)
          .filter(
            (note) => note.lastSyncedHash !== computeSyncedHash(note.kind, note.content, note.lastRemoteSha)
          )
          .map((note) => ({
            path: note.path,
            text: note.content,
            baseSha: note.lastRemoteSha,
            message: 'vibenote: background sync',
          }));
        if (pending.length === 0) return;
        ctrl.postMessage({
          type: 'vibenote-flush',
          payload: { token: accessToken, config: cfg, files: pending },
        });
      } catch (error) {
        console.warn('vibenote: background flush failed', error);
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
  }, [slug, noSync, defaultBranch]);

  return { autosync, setAutosync, scheduleAutoSync, performSync, syncing };
}

function pathsEqual(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return normalizePath(a) === normalizePath(b);
}

function isPathInsideDir(path: string, dir: string): boolean {
  let normalizedPath = normalizePath(path);
  let normalizedDir = normalizePath(dir);
  if (normalizedDir === '') return true;
  return normalizedPath.startsWith(normalizedDir + '/');
}

function shareMatchesTarget(link: ShareLink, target: { owner: string; repo: string; path: string }): boolean {
  return (
    link.owner.toLowerCase() === target.owner.toLowerCase() &&
    link.repo.toLowerCase() === target.repo.toLowerCase() &&
    normalizePath(link.path) === normalizePath(target.path)
  );
}

function shareTargetEquals(
  a: { owner: string; repo: string; path: string },
  b: { owner: string; repo: string; path: string }
): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    normalizePath(a.path) === normalizePath(b.path)
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') return error.message;
  return String(error);
}

function findByPath<T extends { id: string; path: string }>(notes: T[], targetPath: string): T | undefined {
  let normalized = normalizePath(targetPath);
  return notes.find((note) => normalizePath(note.path) === normalized);
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
