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
  extractDir,
  recordRecentRepo,
  listRecentRepos,
  type RecentRepo,
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
  type RepoMetadata,
} from './lib/backend';
import { createGitShare, revokeGitShare, lookupCachedShare, type GitShareLink } from './lib/git-share-ops';
import {
  buildRemoteConfig,
  syncBidirectional,
  type RemoteConfig,
  type SyncSummary,
  listRepoFiles,
  pullRepoFile,
  repoExists,
  type RemoteFile,
  formatSyncFailure,
} from './sync/git-sync';
import { logError } from './lib/logging';
import { useReadOnlyFiles } from './data/useReadOnlyFiles';
import { normalizePath } from './lib/util';
import { prepareClipboardImage } from './lib/image-processing';
import { relativePathBetween, COMMON_ASSET_DIR } from './lib/pathing';
import type { Route, RepoRoute } from './ui/routing';

export { useAppShellData, useWorkspaceAppData, useRepoData, repoRouteToSlug };
export type {
  AppAction,
  AppDataResult,
  AppState,
  AppNavigationState,
  RepoAccessState,
  RepoDataInputs,
  RepoDataState,
  RepoDataActions,
  RepoDataRouteSync,
  ShareState,
  RepoAccessErrorType,
  ImportedAsset,
};

const AUTO_SYNC_MIN_INTERVAL_MS = 60_000;
const AUTO_SYNC_DEBOUNCE_MS = 10_000;
const AUTO_SYNC_POLL_INTERVAL_MS = 180_000;

type ShareState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  link?: GitShareLink;
  error?: string;
};

// Compact set of error outcomes we surface to the UI for repo access.
type RepoAccessErrorType = 'auth' | 'not-found' | 'forbidden' | 'network' | 'rate-limited' | 'unknown';

type RepoDataState = {
  // session state
  hasSession: boolean;
  user: AppUser | undefined;

  // repo access state
  canEdit: boolean;
  canRead: boolean;
  canSync: boolean;
  repoLinked: boolean;
  repoQueryStatus: RepoQueryStatus;
  manageUrl: string | undefined;
  defaultBranch: string | undefined;
  repoErrorType: RepoAccessErrorType | undefined;

  // repo content
  activeFile: RepoFile | undefined;
  activePath: string | undefined;
  files: FileMeta[];
  folders: string[];

  // sync state
  autosync: boolean;
  syncing: boolean;

  // note sharing state
  share: ShareState;

  // general info
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
  moveFile: (path: string, targetDir: string) => string | undefined;
  deleteFile: (path: string) => void;
  renameFolder: (dir: string, newName: string) => void;
  moveFolder: (dir: string, targetDir: string) => string | undefined;
  deleteFolder: (dir: string) => void;
  saveFile: (path: string, text: string) => void;
  importPastedAssets: (params: { notePath: string; files: File[] }) => Promise<ImportedAsset[]>;
  createShareLink: () => Promise<void>;
  refreshShareLink: () => Promise<void>;
  revokeShareLink: () => Promise<void>;
};

type RepoDataRouteSync = {
  revision: number;
  replace: boolean;
  route: RepoRoute;
};

type ImportedAsset = {
  assetPath: string;
  markdownPath: string;
  altText: string;
};

type RepoDataInputs = {
  slug: string;
  route: RepoRoute;
};

type AppNavigationState = {
  /** Which top-level screen the app should currently render. */
  screen: 'resolving' | 'home' | 'workspace';
  /** Active workspace target when the app is on the workspace screen. */
  target?: RepoRoute;
  /** Whether the next route sync should replace browser history. */
  replace?: boolean;
};

type RepoProbeState = {
  /** Lifecycle of the latest repo probe request from the switcher UI. */
  status: 'idle' | 'checking' | 'ready';
  /** Owner currently being probed, if any. */
  owner?: string;
  /** Repo currently being probed, if any. */
  repo?: string;
  /** Whether the probed repo appears reachable from the current session. */
  exists?: boolean;
};

/** App-level contract consumed by the UI shell. */
type AppState = {
  /** Current auth/session state for GitHub-backed features. */
  session: {
    status: 'signed-out' | 'signed-in';
    user: AppUser | undefined;
  };

  /** Canonical app location, synced to the URL by App.tsx. */
  navigation: AppNavigationState;

  /** Cross-workspace repo state that should survive switching between repos. */
  repos: {
    recents: RecentRepo[];
    probe: RepoProbeState;
  };

  /** State for the active repo/new-note workspace, if the user is currently in one. */
  workspace?: {
    /** The repo/new route this workspace represents. */
    target: RepoRoute;

    /** Access and GitHub integration status for the active target. */
    access: {
      status: RepoQueryStatus;
      level: RepoAccessLevel;
      canRead: boolean;
      canEdit: boolean;
      canSync: boolean;
      linked: boolean;
      manageUrl: string | undefined;
      defaultBranch: string | undefined;
      errorType: RepoAccessErrorType | undefined;
    };

    /** Tree data rendered by the file sidebar. */
    tree: {
      files: FileMeta[];
      folders: string[];
    };

    /** Currently opened file within the workspace. */
    document: {
      activeFile: RepoFile | undefined;
      activePath: string | undefined;
    };

    /** Sync-related state surfaced to the header and status banner. */
    sync: {
      autosync: boolean;
      syncing: boolean;
      statusMessage: string | undefined;
    };

    /** Share-link state for the active markdown note. */
    share: {
      status: ShareState['status'];
      link?: {
        url: string;
      };
      error?: string;
    };
  };
};

// Action protocol emitted by the UI.
// Actions are intents, not imperative callbacks: the UI asks for something to
// happen and then observes the resulting state update.
type AppAction =
  // App-level navigation and session lifecycle.
  | { type: 'navigation.go-home' }
  | { type: 'session.sign-in' }
  | { type: 'session.sign-out' }

  // Repo selection and access checks.
  // Open a workspace target and optionally seed the desired file path.
  | {
      type: 'repo.activate';
      repo: { kind: 'new' } | { kind: 'github'; owner: string; repo: string };
      filePath?: string;
    }
  // Check whether an owner/repo appears reachable from the current session.
  | { type: 'repo.probe'; owner: string; repo: string }
  | { type: 'repo.request-access'; owner: string; repo: string }

  // File/folder selection and local edits within the active workspace.
  | { type: 'note.open'; path?: string }
  | { type: 'note.create'; parentDir: string; name: string }
  | { type: 'file.save'; path: string; contents: string }
  | { type: 'file.rename'; path: string; name: string }
  | { type: 'file.move'; path: string; targetDir: string }
  | { type: 'file.delete'; path: string }
  | { type: 'folder.create'; parentDir: string; name: string }
  | { type: 'folder.rename'; path: string; name: string }
  | { type: 'folder.move'; path: string; targetDir: string }
  | { type: 'folder.delete'; path: string }

  // Editor-specific file imports that create assets plus markdown references.
  // Import pasted files into repo storage and attach them to the current note.
  | { type: 'assets.import'; notePath: string; files: File[] }

  // Sync controls for the active workspace.
  | { type: 'sync.run'; source: 'user' | 'auto' }
  | { type: 'sync.set-autosync'; enabled: boolean }

  // Share-link lifecycle for the active markdown note.
  | { type: 'share.create'; notePath: string }
  // Reload the cached share-link status for the active note target.
  | { type: 'share.refresh'; notePath: string }
  | { type: 'share.revoke'; notePath: string };

type AppDataResult = {
  state: AppState;
  dispatch: (action: AppAction) => void;
  helpers: {
    importPastedAssets: (params: { notePath: string; files: File[] }) => Promise<ImportedAsset[]>;
  };
};

type AppShellState = {
  session: AppState['session'];
  navigation: AppNavigationState;
  repos: AppState['repos'];
};

type AppShellDataResult = {
  state: AppShellState;
  dispatch: (action: AppAction) => void;
  setWorkspaceNavigation: (route: RepoRoute, options?: { replace?: boolean }) => void;
  syncSession: (session: AppShellState['session']) => void;
  refreshRecents: () => void;
};

/**
 * Repo-scoped data layer that still powers the current implementation.
 *
 * This hook no longer reaches back into the router or recents list directly.
 * It only works from the current repo route and emits state/action data.
 */
function useRepoWorkspaceData({ slug, route }: RepoDataInputs): {
  state: RepoDataState;
  actions: RepoDataActions;
  routeSync?: RepoDataRouteSync;
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
  let accessStatusReady = repoAccess.status === 'ready' || repoAccess.status === 'error';
  let accessStatusUnknown = !accessStatusReady || repoAccess.errorType === 'network';

  let desiredPath = normalizePath(route.filePath);

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
    route.kind === 'new' || (hasSession && (repoAccess.level === 'write' || (accessStatusUnknown && linked)));

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
  }, [canEdit, activeId, files]);

  let activeFile: RepoFile | undefined = canEdit ? activeLocalFile : activeReadOnlyFile;
  let activePath = activeFile?.path;
  let activeIsMarkdown = activeFile?.kind === 'markdown';
  let routeRevisionRef = useRef(0);
  let [routeSync, setRouteSync] = useState<RepoDataRouteSync | undefined>(undefined);

  // EFFECTS
  // please avoid adding more effects here, keep logic clean/separated

  // Persist last active file id so writable repos can restore it later.
  useEffect(() => {
    if (canEdit) setLastActiveFileId(slug, activeId ?? null);
  }, [canEdit, activeId]);

  // When the loaded doc changes path (e.g., rename or sync or restoring last active), push the route forward.
  // We track the previous activeFile.path to only update the route when the FILE changes,
  // not when desiredPath changes (which happens during navigation).
  let prevActivePathRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    let currentPath = activeFile?.path;
    let prevPath = prevActivePathRef.current;
    prevActivePathRef.current = currentPath;

    // Only act when activeFile.path actually changed (not just on initial mount or desiredPath changes)
    if (currentPath === undefined) return;
    if (currentPath === prevPath) return;
    if (pathsEqual(desiredPath, currentPath)) return;
    setRouteSync({
      revision: ++routeRevisionRef.current,
      replace: true,
      route: updateRepoRouteNotePath(route, currentPath),
    });
  }, [activeFile?.path, desiredPath]);

  let initialPullRef = useRef({ done: false, slug });
  if (initialPullRef.current.slug !== slug) {
    initialPullRef.current = { done: false, slug };
  }
  let shareRequestRef = useRef<{ owner: string; repo: string; path: string } | null>(null);

  // Synchronous localStorage lookup — no network call needed.
  const loadShareForTarget = useCallback((target: { owner: string; repo: string; path: string }) => {
    shareRequestRef.current = target;
    const link = lookupCachedShare(target.owner, target.repo, target.path);
    setShareState(link ? { status: 'ready', link } : { status: 'ready' });
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
            setRouteSync({
              revision: ++routeRevisionRef.current,
              replace: true,
              route: updateRepoRouteNotePath(route, initialPath),
            });
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
    if (!activeIsMarkdown) {
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
  }, [
    repoOwner,
    repoName,
    activePath,
    activeIsMarkdown,
    hasSession,
    canEdit,
    shareState,
    loadShareForTarget,
  ]);

  // CLICK HANDLERS

  const ensureActivePath = (nextPath: string | undefined, options?: { replace?: boolean }) => {
    if (pathsEqual(route.filePath, nextPath)) return;
    // Keep path changes as data so the app-level adapter can sync the router.
    // hack: we navigate on the next event loop task to give React state time to update active doc
    setTimeout(() => {
      setRouteSync({
        revision: ++routeRevisionRef.current,
        replace: options?.replace === true,
        route: updateRepoRouteNotePath(route, nextPath),
      });
    }, 0);
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
    ensureActivePath(undefined, { replace: true });
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
      setStatusMessage(formatSyncFailure(error));
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
      // TODO it's weird to use the status message for this
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
        ensureActivePath(nextPath, { replace: true });
      }
      scheduleAutoSync();
    } catch (error) {
      logError(error);
      // TODO it's weird to use the status message for this
      setStatusMessage('Invalid file name.');
    }
  };

  const moveFile = (path: string, targetDir: string) => {
    if (!canEdit) return undefined;
    try {
      let store = getRepoStore(slug);
      let nextPath = store.moveFile(path, targetDir);
      if (nextPath && pathsEqual(activePath, path)) {
        ensureActivePath(nextPath, { replace: true });
      }
      if (nextPath) scheduleAutoSync();
      return nextPath;
    } catch (error) {
      logError(error);
      return undefined;
    }
  };

  const deleteFile = (path: string) => {
    if (!canEdit) return;
    let removed = getRepoStore(slug).deleteFile(path);
    if (!removed) {
      // TODO it's weird to use the status message for this
      setStatusMessage('Unable to delete file.');
      return;
    }
    if (pathsEqual(activePath, path)) ensureActivePath(undefined, { replace: true });
    scheduleAutoSync();
  };

  const renameFolder = (dir: string, newName: string) => {
    if (!canEdit) return;
    try {
      let nextDir = getRepoStore(slug).renameFolder(dir, newName);
      if (nextDir !== undefined && activePath !== undefined) {
        // Keep the active file route in sync when its parent folder moves.
        let remapped = remapPathForMovedFolder(activePath, dir, nextDir);
        if (remapped !== undefined) ensureActivePath(remapped, { replace: true });
      }
      scheduleAutoSync();
    } catch (error) {
      logError(error);
      // TODO it's weird to use the status message for this
      setStatusMessage('Invalid folder name.');
    }
  };

  const moveFolder = (dir: string, targetDir: string) => {
    if (!canEdit) return undefined;
    try {
      let nextDir = getRepoStore(slug).moveFolder(dir, targetDir);
      if (nextDir !== undefined && activePath !== undefined) {
        // Keep the active file route in sync when its parent folder moves.
        let remapped = remapPathForMovedFolder(activePath, dir, nextDir);
        if (remapped !== undefined) ensureActivePath(remapped, { replace: true });
      }
      scheduleAutoSync();
      return nextDir;
    } catch (error) {
      logError(error);
      // TODO it's weird to use the status message for this
      setStatusMessage('Invalid folder move.');
    }
  };

  const deleteFolder = (dir: string) => {
    if (!canEdit) return;
    let localStore = getRepoStore(slug);
    let files = localStore.listFiles();
    let hasFiles = files.some((f) => {
      let dirf = extractDir(f.path);
      return dirf === dir || dirf.startsWith(dir + '/');
    });
    if (hasFiles && !window.confirm('Delete folder and all contained files?')) return;
    localStore.deleteFolder(dir);
    if (activePath !== undefined && isPathInsideDir(activePath, dir)) {
      ensureActivePath(undefined, { replace: true });
    }
    scheduleAutoSync();
  };

  const importPastedAssets = useCallback(
    async ({ notePath, files }: { notePath: string; files: File[] }) => {
      if (!canEdit) return [];
      let store = getRepoStore(slug);
      let timestamp = buildTimestampString(new Date());
      let altDate = timestamp.slice(0, 8);
      let results: ImportedAsset[] = [];
      let index = 0;
      for (let file of files) {
        try {
          let prepared = await prepareClipboardImage(file);
          if (!prepared) continue;
          let baseName = buildAssetFileName({ timestamp, index, ext: prepared.ext });
          let targetPath = `${COMMON_ASSET_DIR}/${baseName}`;
          let id = store.createFile(targetPath, prepared.base64, { kind: 'binary' });
          let created = store.loadFileById(id);
          if (!created) continue;
          let relative = relativePathBetween(notePath, created.path);
          let ordinal = results.length + 1;
          let altText = `Pasted image ${formatAltDate(altDate)}${ordinal > 1 ? ` ${ordinal}` : ''}`;
          results.push({
            assetPath: created.path,
            markdownPath: relative,
            altText,
          });
          index += 1;
        } catch (error) {
          logError(error);
        }
      }
      if (results.length > 0) scheduleAutoSync();
      return results;
    },
    [canEdit, scheduleAutoSync, slug]
  );

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
    shareRequestRef.current = { owner: repoOwner, repo: repoName, path: activePath };
    setShareState({ status: 'loading' });
    try {
      const link = await createGitShare(repoOwner, repoName, activePath);
      setShareState({ status: 'ready', link });
    } catch (error) {
      logError(error);
      setShareState({ status: 'error', error: formatError(error) });
      throw error;
    }
  };

  const revokeShare = async () => {
    const existing = shareState.link;
    if (!existing || !repoOwner || !repoName || !activePath) return;
    setShareState({ status: 'loading' });
    try {
      await revokeGitShare(repoOwner, repoName, activePath, existing.shareId);
      setShareState({ status: 'ready' });
    } catch (error) {
      logError(error);
      setShareState({ status: 'error', error: formatError(error) });
      throw error;
    }
  };

  const refreshShare = async () => {
    if (!repoOwner || !repoName || !hasSession || activePath === undefined || !activeIsMarkdown) {
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
    manageUrl,
    repoErrorType: repoAccess.errorType,

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
    moveFile,
    deleteFile,
    renameFolder,
    moveFolder,
    deleteFolder,
    saveFile,
    importPastedAssets,
    createShareLink: createShare,
    refreshShareLink: refreshShare,
    revokeShareLink: revokeShare,
  };

  return { state, actions, routeSync };
}

/**
 * Data layer entry point for the repo-scoped implementation.
 *
 * Invariants for callers:
 * - `slug` and `route` are always in sync, and never change throughout the component lifetime
 * - callers can treat the hook as owning the current repo route after mount
 * - `routeSync` is the only supported way for this layer to request route updates
 *
 * The wrapper keeps those routing mechanics localized so the workspace hook can
 * stay focused on repo state, sync, and file operations.
 */
function useRepoData({ slug, route }: RepoDataInputs): {
  state: RepoDataState;
  actions: RepoDataActions;
  routeSync?: RepoDataRouteSync;
} {
  let [routeState, setRouteState] = useState<RepoRoute>(route);

  useEffect(() => {
    setRouteState((prev) => (areRepoRoutesEqual(prev, route) ? prev : route));
  }, [route]);

  let { state, actions, routeSync } = useRepoWorkspaceData({ slug, route: routeState });

  useEffect(() => {
    if (routeSync === undefined) return;
    setRouteState((prev) => (areRepoRoutesEqual(prev, routeSync.route) ? prev : routeSync.route));
  }, [routeSync?.revision]);

  // Remember recently opened repos once we know the current repo is reachable.
  // TODO this shouldn't be a useEffect, the only place a repo ever becomes reachable is after
  // fetching metadata, so just record it there
  useEffect(() => {
    if (routeState.kind !== 'repo') return;
    if (!state.canRead) return;
    recordRecentRepo({
      slug,
      owner: routeState.owner,
      repo: routeState.repo,
      connected: state.canSync,
    });
  }, [slug, routeState, state.canRead, state.canSync]);

  return { state, actions, routeSync };
}

function useAppShellData({ route }: { route: Route }): AppShellDataResult {
  // App-lifetime state: routing, recents, probe state, and coarse session info.
  let [session, setSession] = useState<AppShellState['session']>(() => readAppSessionState());
  let [recents, setRecents] = useState<RecentRepo[]>(() => listRecentRepos());
  let [probe, setProbe] = useState<RepoProbeState>({ status: 'idle' });
  let [navigation, setNavigation] = useState<AppNavigationState>(() =>
    deriveAppNavigation(route, listRecentRepos())
  );
  let probeRevisionRef = useRef(0);

  let refreshSession = useCallback(() => {
    let next = readAppSessionState();
    setSession((prev) => (areSessionStatesEqual(prev, next) ? prev : next));
  }, []);

  let refreshRecents = useCallback(() => {
    let next = listRecentRepos();
    setRecents((prev) => (recentReposEqual(prev, next) ? prev : next));
  }, []);

  let setWorkspaceNavigation = useCallback((target: RepoRoute, options?: { replace?: boolean }) => {
    let next: AppNavigationState = {
      screen: 'workspace',
      replace: options?.replace === true ? true : undefined,
      target,
    };
    setNavigation((prev) => (areAppNavigationsEqual(prev, next) ? prev : next));
  }, []);

  useEffect(() => {
    let onStorage = () => {
      refreshRecents();
      refreshSession();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    let next = deriveAppNavigation(route, recents);
    setNavigation((prev) => (areAppNavigationsEqual(prev, next) ? prev : next));
  }, [route, recents]);

  let dispatch = useCallback((action: AppAction) => {
    if (action.type === 'navigation.go-home') {
      setNavigation({ screen: 'home' });
      return;
    }
    if (action.type === 'session.sign-in') {
      void (async () => {
        try {
          let result = await signInWithGitHubApp();
          if (result === null) return;
          setSession({
            status: 'signed-in',
            user: result.user,
          });
        } catch (error) {
          logError(error);
        }
      })();
      return;
    }
    if (action.type === 'session.sign-out') {
      void (async () => {
        try {
          await signOutFromGitHubApp();
        } catch (error) {
          console.warn('vibenote: failed to sign out cleanly', error);
        }
        clearAllLocalData();
        refreshRecents();
        setSession({ status: 'signed-out', user: undefined });
      })();
      return;
    }
    if (action.type === 'repo.activate') {
      let currentTarget = navigation.screen === 'workspace' ? navigation.target : undefined;
      if (action.repo.kind === 'github' && currentTarget?.kind === 'repo') {
        let sameRepo =
          currentTarget.owner === action.repo.owner && currentTarget.repo === action.repo.repo;
        if (sameRepo && action.filePath === undefined) {
          return;
        }
      }
      let nextTarget: RepoRoute =
        action.repo.kind === 'new'
          ? { kind: 'new', filePath: action.filePath }
          : {
              kind: 'repo',
              owner: action.repo.owner,
              repo: action.repo.repo,
              filePath: action.filePath,
            };
      if (currentTarget !== undefined && areRepoRoutesEqual(currentTarget, nextTarget)) {
        return;
      }
      setNavigation({ screen: 'workspace', target: nextTarget });
      return;
    }
    if (action.type === 'repo.probe') {
      let revision = ++probeRevisionRef.current;
      setProbe({ status: 'checking', owner: action.owner, repo: action.repo });
      void repoExists(action.owner, action.repo).then((exists) => {
        if (probeRevisionRef.current !== revision) return;
        setProbe({ status: 'ready', owner: action.owner, repo: action.repo, exists });
      });
    }
  }, [navigation.screen, navigation.target]);

  return {
    state: {
      session,
      navigation,
      repos: {
        recents,
        probe,
      },
    },
    dispatch,
    setWorkspaceNavigation,
    syncSession: useCallback((next) => {
      setSession((prev) => (areSessionStatesEqual(prev, next) ? prev : next));
    }, []),
    refreshRecents,
  };
}

function useWorkspaceAppData({
  app,
  route,
}: {
  app: AppShellDataResult;
  route: RepoRoute;
}): AppDataResult {
  // Repo-lifetime adapter: mount this per slug so repo-local hooks can assume a stable target.
  let slug = repoRouteToSlug(route);
  let workspaceData = useRepoData({ slug, route });

  useEffect(() => {
    if (workspaceData.routeSync === undefined) return;
    app.setWorkspaceNavigation(workspaceData.routeSync.route, {
      replace: workspaceData.routeSync.replace,
    });
  }, [app.setWorkspaceNavigation, workspaceData.routeSync?.revision]);

  useEffect(() => {
    app.syncSession({
      status: workspaceData.state.hasSession ? 'signed-in' : 'signed-out',
      user: workspaceData.state.user,
    });
  }, [app.syncSession, workspaceData.state.hasSession, workspaceData.state.user]);

  useEffect(() => {
    if (!workspaceData.state.canRead) return;
    app.refreshRecents();
  }, [
    app.refreshRecents,
    slug,
    workspaceData.state.canRead,
    workspaceData.state.canSync,
    workspaceData.state.repoLinked,
    workspaceData.state.repoQueryStatus,
  ]);

  let state: AppState = {
    session: {
      status: workspaceData.state.hasSession ? 'signed-in' : 'signed-out',
      user: workspaceData.state.user,
    },
    navigation: app.state.navigation,
    repos: app.state.repos,
    workspace: {
      target: route,
      access: {
        status: workspaceData.state.repoQueryStatus,
        level: workspaceData.state.canEdit ? 'write' : workspaceData.state.canRead ? 'read' : 'none',
        canRead: workspaceData.state.canRead,
        canEdit: workspaceData.state.canEdit,
        canSync: workspaceData.state.canSync,
        linked: workspaceData.state.repoLinked,
        manageUrl: workspaceData.state.manageUrl,
        defaultBranch: workspaceData.state.defaultBranch,
        errorType: workspaceData.state.repoErrorType,
      },
      tree: {
        files: workspaceData.state.files,
        folders: workspaceData.state.folders,
      },
      document: {
        activeFile: workspaceData.state.activeFile,
        activePath: workspaceData.state.activePath,
      },
      sync: {
        autosync: workspaceData.state.autosync,
        syncing: workspaceData.state.syncing,
        statusMessage: workspaceData.state.statusMessage,
      },
      share: {
        status: workspaceData.state.share.status,
        link:
          workspaceData.state.share.link === undefined
            ? undefined
            : { url: workspaceData.state.share.link.url },
        error: workspaceData.state.share.error,
      },
    },
  };

  let dispatch = useCallback((action: AppAction) => {
    if (
      action.type === 'navigation.go-home' ||
      action.type === 'repo.activate' ||
      action.type === 'repo.probe'
    ) {
      app.dispatch(action);
      return;
    }
    if (action.type === 'session.sign-in') {
      void workspaceData.actions.signIn().finally(() => app.syncSession(readAppSessionState()));
      return;
    }
    if (action.type === 'session.sign-out') {
      void workspaceData.actions.signOut().finally(() => {
        app.syncSession(readAppSessionState());
        app.refreshRecents();
      });
      return;
    }
    if (action.type === 'repo.request-access') {
      void workspaceData.actions.openRepoAccess();
      return;
    }
    if (action.type === 'note.open') {
      app.setWorkspaceNavigation(updateRepoRouteNotePath(route, action.path));
      void workspaceData.actions.selectFile(action.path);
      return;
    }
    if (action.type === 'note.create') {
      void workspaceData.actions.createNote(action.parentDir, action.name);
      return;
    }
    if (action.type === 'file.save') {
      workspaceData.actions.saveFile(action.path, action.contents);
      return;
    }
    if (action.type === 'file.rename') {
      workspaceData.actions.renameFile(action.path, action.name);
      return;
    }
    if (action.type === 'file.move') {
      void workspaceData.actions.moveFile(action.path, action.targetDir);
      return;
    }
    if (action.type === 'file.delete') {
      workspaceData.actions.deleteFile(action.path);
      return;
    }
    if (action.type === 'folder.create') {
      workspaceData.actions.createFolder(action.parentDir, action.name);
      return;
    }
    if (action.type === 'folder.rename') {
      workspaceData.actions.renameFolder(action.path, action.name);
      return;
    }
    if (action.type === 'folder.move') {
      void workspaceData.actions.moveFolder(action.path, action.targetDir);
      return;
    }
    if (action.type === 'folder.delete') {
      workspaceData.actions.deleteFolder(action.path);
      return;
    }
    if (action.type === 'assets.import') {
      void workspaceData.actions.importPastedAssets({ notePath: action.notePath, files: action.files });
      return;
    }
    if (action.type === 'sync.run') {
      void workspaceData.actions.syncNow();
      return;
    }
    if (action.type === 'sync.set-autosync') {
      workspaceData.actions.setAutosync(action.enabled);
      return;
    }
    if (action.type === 'share.create') {
      void workspaceData.actions.createShareLink();
      return;
    }
    if (action.type === 'share.refresh') {
      void workspaceData.actions.refreshShareLink();
      return;
    }
    if (action.type === 'share.revoke') {
      void workspaceData.actions.revokeShareLink();
    }
  }, [
    app.dispatch,
    app.refreshRecents,
    app.setWorkspaceNavigation,
    app.syncSession,
    route,
    workspaceData.actions,
  ]);

  return {
    state,
    dispatch,
    helpers: {
      importPastedAssets: (params) => workspaceData.actions.importPastedAssets(params),
    },
  };
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
type RepoQueryStatus = 'unknown' | 'ready' | 'error';

type RepoAccessState = {
  level: RepoAccessLevel;
  status: RepoQueryStatus;
  metadata?: RepoMetadata;
  defaultBranch?: string;
  manageUrl?: string;
  isPrivate?: boolean;
  errorType?: RepoAccessErrorType;
  errorMessage?: string;
};

const initialAccessState: RepoAccessState = {
  level: 'none',
  status: 'unknown',
  defaultBranch: undefined,
  manageUrl: undefined,
  isPrivate: undefined,
  errorType: undefined,
  errorMessage: undefined,
};

function useRepoAccess(params: { route: RepoRoute; sessionToken: string | undefined }): RepoAccessState {
  let { route, sessionToken } = params;
  let owner = route.kind === 'repo' ? route.owner : undefined;
  let repo = route.kind === 'repo' ? route.repo : undefined;
  let [state, setState] = useState<RepoAccessState>(initialAccessState);

  // Query GitHub (and the public fallback) whenever the targeted repo changes.
  useEffect(() => {
    setState((prev) => (areAccessStatesEqual(prev, initialAccessState) ? prev : initialAccessState));
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
          errorType: 'network',
          errorMessage: message,
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
  if (meta.repoSelected && hasSession) level = 'write';
  else if (meta.repoSelected || meta.isPrivate === false) level = 'read';

  let status: RepoQueryStatus = 'ready';
  if (meta.errorKind !== undefined) status = 'error';

  return {
    level,
    status,
    metadata: meta,
    defaultBranch: meta.defaultBranch ?? undefined,
    manageUrl: meta.manageUrl ?? undefined,
    isPrivate: meta.isPrivate ?? undefined,
    errorType: meta.errorKind,
    errorMessage: meta.errorMessage,
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
  // FIXME: I don't think this works well, since it's not using our well-tested sync logic
  // consider disabling for now, or fixing soon
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
          // binary files don't work, so don't try to flush them
          .filter((note) => note.kind !== 'binary')
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

function buildTimestampString(date: Date): string {
  let year = date.getFullYear();
  let month = padTwo(date.getMonth() + 1);
  let day = padTwo(date.getDate());
  let hours = padTwo(date.getHours());
  let minutes = padTwo(date.getMinutes());
  let seconds = padTwo(date.getSeconds());
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function buildAssetFileName(params: { timestamp: string; index: number; ext: string }): string {
  let { timestamp, index, ext } = params;
  let sequence = index + 1;
  let id = crypto.randomUUID().slice(0, 6);
  return `pasted-image-${timestamp}-${sequence}-${id}.${ext}`;
}

function padTwo(value: number): string {
  let text = `${value}`;
  if (text.length >= 2) return text.slice(-2);
  return `0${text}`;
}

function formatAltDate(compact: string): string {
  if (compact.length < 8) return compact;
  let year = compact.slice(0, 4);
  let month = compact.slice(4, 6);
  let day = compact.slice(6, 8);
  return `${year}-${month}-${day}`;
}

function pathsEqual(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return normalizePath(a) === normalizePath(b);
}

function areRepoRoutesEqual(a: RepoRoute, b: RepoRoute): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'new' && b.kind === 'new') return pathsEqual(a.filePath, b.filePath);
  if (a.kind === 'repo' && b.kind === 'repo') {
    return a.owner === b.owner && a.repo === b.repo && pathsEqual(a.filePath, b.filePath);
  }
  return false;
}

function updateRepoRouteNotePath(route: RepoRoute, notePath: string | undefined): RepoRoute {
  if (route.kind === 'repo') {
    return { kind: 'repo', owner: route.owner, repo: route.repo, filePath: notePath };
  }
  return { kind: 'new', filePath: notePath };
}

function deriveAppNavigation(route: Route, recents: RecentRepo[]): AppNavigationState {
  if (route.kind === 'start') {
    let candidate = recents.find((entry) => entry.owner !== undefined && entry.repo !== undefined);
    if (candidate?.owner !== undefined && candidate.repo !== undefined) {
      return {
        screen: 'workspace',
        replace: true,
        target: { kind: 'repo', owner: candidate.owner, repo: candidate.repo },
      };
    }
    return { screen: 'home', replace: true };
  }
  if (route.kind === 'home') {
    if (recents.length === 0) {
      return {
        screen: 'workspace',
        replace: true,
        target: { kind: 'new', filePath: 'README.md' },
      };
    }
    return { screen: 'home' };
  }
  if (route.kind === 'new') {
    return {
      screen: 'workspace',
      target: { kind: 'new', filePath: route.filePath },
    };
  }
  return {
    screen: 'workspace',
    target: { kind: 'repo', owner: route.owner, repo: route.repo, filePath: route.filePath },
  };
}

function areAppNavigationsEqual(a: AppNavigationState, b: AppNavigationState): boolean {
  if (a.screen !== b.screen) return false;
  if (a.replace !== b.replace) return false;
  if (a.target === undefined || b.target === undefined) return a.target === b.target;
  return areRepoRoutesEqual(a.target, b.target);
}

function readAppSessionState(): AppShellState['session'] {
  let token = getAppSessionToken();
  return {
    status: token === null ? 'signed-out' : 'signed-in',
    user: getAppSessionUser() ?? undefined,
  };
}

function areSessionStatesEqual(a: AppShellState['session'], b: AppShellState['session']) {
  if (a.status !== b.status) return false;
  let left = a.user;
  let right = b.user;
  if (left === undefined || right === undefined) return left === right;
  return (
    left.login === right.login &&
    left.name === right.name &&
    left.avatarUrl === right.avatarUrl &&
    left.avatarDataUrl === right.avatarDataUrl
  );
}

function repoRouteToSlug(route: RepoRoute): string {
  if (route.kind === 'new') return 'new';
  return `${route.owner}/${route.repo}`;
}

function recentReposEqual(a: RecentRepo[], b: RecentRepo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    let left = a[i];
    let right = b[i];
    if (
      left?.slug !== right?.slug ||
      left?.owner !== right?.owner ||
      left?.repo !== right?.repo ||
      left?.connected !== right?.connected ||
      left?.lastOpenedAt !== right?.lastOpenedAt
    ) {
      return false;
    }
  }
  return true;
}

function isPathInsideDir(path: string, dir: string): boolean {
  let normalizedPath = normalizePath(path);
  let normalizedDir = normalizePath(dir);
  if (normalizedDir === '') return true;
  return normalizedPath.startsWith(normalizedDir + '/');
}

// Adjusts a file path when its containing folder tree moves from `fromDir` to `toDir`.
// Returns the remapped path or undefined if the original path is unaffected.
function remapPathForMovedFolder(path: string, fromDir: string, toDir: string): string | undefined {
  let normalizedPath = normalizePath(path);
  let normalizedFrom = normalizePath(fromDir);
  let normalizedTo = normalizePath(toDir);
  if (
    normalizedPath === undefined ||
    normalizedFrom === undefined ||
    normalizedTo === undefined ||
    !normalizedPath.startsWith(normalizedFrom)
  ) {
    return undefined;
  }
  let suffix = normalizedPath.slice(normalizedFrom.length);
  let remainder = suffix.startsWith('/') ? suffix.slice(1) : suffix;
  if (normalizedTo === '') return remainder === '' ? undefined : remainder;
  if (remainder === '') return normalizedTo;
  return `${normalizedTo}/${remainder}`;
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
    a.manageUrl === b.manageUrl &&
    a.isPrivate === b.isPrivate &&
    a.errorType === b.errorType &&
    a.errorMessage === b.errorMessage
  );
}
