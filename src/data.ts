// Data-layer hook that orchestrates repo auth, storage, and sync state for RepoView.
import { useMemo, useState, useEffect, useRef, useSyncExternalStore } from 'react';
import {
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
  hashText,
  getRepoStore,
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
import {
  buildRemoteConfig,
  pullNote,
  listNoteFiles,
  syncBidirectional,
  type RemoteConfig,
  type SyncSummary,
} from './sync/git-sync';
import { logError } from './lib/logging';
import { useReadOnlyNotes, type ReadOnlyNote } from './data/readonly-notes';
import { normalizePath } from './lib/util';
import type { RepoRoute } from './ui/routing';

export { useRepoData };
export type {
  RepoAccessState,
  RepoDataInputs,
  RepoDataState,
  RepoDataActions,
  RepoNoteListItem,
  ReadOnlyNote,
};

const AUTO_SYNC_MIN_INTERVAL_MS = 60_000;
const AUTO_SYNC_DEBOUNCE_MS = 10_000;
const AUTO_SYNC_POLL_INTERVAL_MS = 180_000;

type RepoNoteListItem = NoteMeta | ReadOnlyNote;

type RepoDataState = {
  // session state
  hasSession: boolean;
  user: AppUser | undefined;

  // repo access state
  canEdit: boolean;
  canRead: boolean;
  canSync: boolean;
  needsInstall: boolean;
  repoQueryStatus: RepoQueryStatus;
  manageUrl: string | undefined;

  // repo content
  doc: NoteDoc | undefined;
  activePath: string | undefined;
  notes: RepoNoteListItem[];
  folders: string[];

  // sync state
  autosync: boolean;
  syncing: boolean;

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
  selectNote: (path: string | undefined) => Promise<void>;
  createNote: (dir: string, name: string) => string | undefined;
  createFolder: (parentDir: string, name: string) => void;
  renameNote: (path: string, title: string) => void;
  deleteNote: (path: string) => void;
  renameFolder: (dir: string, newName: string) => void;
  deleteFolder: (dir: string) => void;
  updateNoteText: (path: string, text: string) => void;
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
  let { notes: localNotes, folders: localFolders } = useLocalRepoSnapshot(slug);

  // Store the current GitHub App session token to toggle authenticated features instantly.
  let [sessionToken, setSessionToken] = useState<string | undefined>(() => getAppSessionToken() ?? undefined);
  let hasSession = sessionToken !== undefined;

  // Carry the latest sync status message shown across the workspace.
  // TODO make this disappear after a timeout
  let [statusMessage, setSyncMessage] = useState<string | undefined>(undefined);

  // Track whether this repo slug has already been linked to GitHub sync.
  let [linked, setLinked] = useState(() => isRepoLinked(slug));

  // Keep the signed-in GitHub App user details for header UI.
  let [user, setUser] = useState<AppUser | undefined>(() => getAppSessionUser() ?? undefined);

  // Query GitHub for repo access state and other metadata.
  let repoAccess = useRepoAccess({ route, sessionToken });

  // DERIVED STATE (and hooks that depend on it)

  let { defaultBranch, manageUrl } = repoAccess;
  let accessStatusReady =
    repoAccess.status === 'ready' || repoAccess.status === 'rate-limited' || repoAccess.status === 'error';

  let desiredPath = normalizePath(route.kind === 'repo' ? route.notePath : undefined);

  // in readonly mode, we store nothing locally and just fetch content from github no demand
  let isReadOnly = repoAccess.level === 'read';
  let {
    notes: readOnlyNotes,
    doc: readOnlyDoc,
    folders: readOnlyFolders,
    selectDoc: selectReadOnlyDoc,
    reset: resetReadOnlyState,
  } = useReadOnlyNotes({ slug, isReadOnly, defaultBranch, desiredPath });

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

  let notes: RepoNoteListItem[] = isReadOnly ? readOnlyNotes : localNotes;
  let folders = isReadOnly ? readOnlyFolders : localFolders;

  let activeNoteMeta = useMemo(() => {
    if (desiredPath === undefined) return undefined;
    return findByPath(notes, desiredPath);
  }, [notes, desiredPath]);

  if (activeNoteMeta === undefined && !isReadOnly && desiredPath === undefined && notes.length > 0) {
    let readmeCandidate = notes.find((note) => note.path.toLowerCase() === 'readme.md');
    activeNoteMeta = (readmeCandidate ?? notes[0]) as NoteMeta;
  }

  let activeNoteId = activeNoteMeta?.id;

  let localDoc = useMemo(() => {
    if (!canEdit || activeNoteId === undefined) return undefined;
    return getRepoStore(slug).loadNote(activeNoteId) ?? undefined;
  }, [canEdit, activeNoteId, slug, localNotes]);

  let doc = canEdit ? localDoc : readOnlyDoc;

  let activeNotePath = doc?.path ?? activeNoteMeta?.path ?? desiredPath;

  const ensureActivePath = (nextPath: string | undefined) => {
    if (route.kind !== 'repo') return;
    if (pathsEqual(route.notePath, nextPath)) return;
    setActivePath(nextPath);
  };

  const resolveEditableNote = (path: string | undefined): NoteMeta | undefined => {
    if (path === undefined) return undefined;
    let normalized = normalizePath(path);
    let list = getRepoStore(slug).listNotes();
    return list.find((note) => normalizePath(note.path) === normalized);
  };

  // EFFECTS
  // please avoid adding more effects here, keep logic clean/separated

  // Persist last active note id so writable repos can restore it later.
  useEffect(() => {
    if (!canEdit) return;
    setLastActiveNoteId(slug, activeNoteId ?? null);
  }, [canEdit, slug, activeNoteId]);

  // When the loaded doc changes path (e.g., rename or sync), push the route forward.
  useEffect(() => {
    if (doc?.path === undefined) return;
    if (route.kind !== 'repo') return;
    if (pathsEqual(desiredPath, doc.path)) return;
    setActivePath(doc.path);
  }, [doc?.path, route.kind, desiredPath]);

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
        let entries = await listNoteFiles(cfg);
        let files: { path: string; text: string; sha?: string }[] = [];
        for (let e of entries) {
          let rf = await pullNote(cfg, e.path);
          if (rf) files.push({ path: rf.path, text: rf.text, sha: rf.sha });
        }
        let localStore = getRepoStore(slug);
        localStore.replaceWithRemote(files);
        let synced = localStore.listNotes();
        if (desiredPath === undefined) {
          let storedId = getLastActiveNoteId(slug);
          let storedPath =
            storedId !== undefined
              ? synced.find((note) => note.id === storedId)?.path ?? undefined
              : undefined;
          let readmePath = synced.find((note) => note.path.toLowerCase() === 'readme.md')?.path;
          let initialPath = storedPath ?? readmePath;
          if (initialPath !== undefined && route.kind === 'repo' && !pathsEqual(desiredPath, initialPath)) {
            setActivePath(initialPath);
          }
        }
        markRepoLinked(slug);
        setLinked(true);
        setSyncMessage('Loaded repository');
      } catch (error) {
        logError(error);
      } finally {
        initialPullRef.current.done = true;
      }
    })();
  }, [route, repoAccess.level, linked, slug, canEdit, defaultBranch, desiredPath]);

  // CLICK HANDLERS

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
      setSyncMessage('Failed to sign in');
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
      setSyncMessage('Failed to open GitHub');
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

    setSyncMessage('Signed out');
  };

  // "Sync" button in the header
  const syncNow = async () => {
    try {
      setSyncMessage(undefined);
      if (!hasSession || !linked || slug === 'new' || !canEdit) {
        setSyncMessage('Connect GitHub and configure repo first');
        return;
      }
      let summary = await performSync();
      let parts: string[] = [];
      if (summary?.pulled) parts.push(`pulled ${summary.pulled}`);
      if (summary?.merged) parts.push(`merged ${summary.merged}`);
      if (summary?.pushed) parts.push(`pushed ${summary.pushed}`);
      if (summary?.deletedRemote) parts.push(`deleted remote ${summary.deletedRemote}`);
      if (summary?.deletedLocal) parts.push(`deleted local ${summary.deletedLocal}`);
      setSyncMessage(parts.length ? `Synced: ${parts.join(', ')}` : 'Up to date');
    } catch (error) {
      logError(error);
      setSyncMessage('Sync failed');
    }
  };

  // click on a note in the sidebar
  const selectNote = async (path: string | undefined) => {
    await selectReadOnlyDoc(path);
    ensureActivePath(path);
  };

  const updateNoteText = (path: string, text: string) => {
    if (!canEdit) return;
    let meta = resolveEditableNote(path);
    if (!meta) return;
    getRepoStore(slug).saveNote(meta.id, text);
    scheduleAutoSync();
  };

  const createNote = (dir: string, name: string) => {
    if (!canEdit) return undefined;
    let store = getRepoStore(slug);
    let id = store.createNote(name, '', dir);
    let created = store.loadNote(id);
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
      setSyncMessage('Invalid folder name.');
      return;
    }
    scheduleAutoSync();
  };

  const renameNote = (path: string, title: string) => {
    if (!canEdit) return;
    let meta = resolveEditableNote(path);
    if (!meta) return;
    try {
      let store = getRepoStore(slug);
      store.renameNote(meta.id, title);
      let updated = store.loadNote(meta.id);
      if (updated) ensureActivePath(updated.path);
      scheduleAutoSync();
    } catch (error) {
      logError(error);
      setSyncMessage('Invalid title. Avoid / and control characters.');
    }
  };

  const deleteNote = (path: string) => {
    if (!canEdit) return;
    let meta = resolveEditableNote(path);
    if (!meta) return;
    let store = getRepoStore(slug);
    store.deleteNote(meta.id);
    if (activeNotePath !== undefined && pathsEqual(activeNotePath, path)) {
      ensureActivePath(undefined);
    }
    scheduleAutoSync();
  };

  const renameFolder = (dir: string, newName: string) => {
    if (!canEdit) return;
    try {
      getRepoStore(slug).renameFolder(dir, newName);
      scheduleAutoSync();
    } catch (error) {
      logError(error);
      setSyncMessage('Invalid folder name.');
    }
  };

  const deleteFolder = (dir: string) => {
    if (!canEdit) return;
    let localStore = getRepoStore(slug);
    let notes = localStore.listNotes();
    let hasNotes = notes.some((note) => {
      let directory = note.dir ?? '';
      return directory === dir || directory.startsWith(dir + '/');
    });
    if (hasNotes && !window.confirm('Delete folder and all contained notes?')) return;
    localStore.deleteFolder(dir);
    if (activeNotePath !== undefined && isPathInsideDir(activeNotePath, dir)) {
      ensureActivePath(undefined);
    }
    scheduleAutoSync();
  };

  let state: RepoDataState = {
    hasSession,
    user,

    canRead: canEdit || isReadOnly,
    canEdit,
    canSync: linked && canEdit,
    repoQueryStatus: repoAccess.status,
    needsInstall: repoAccess.needsInstall,
    manageUrl,

    doc,
    activePath: activeNotePath,
    notes,
    folders,

    autosync,
    syncing,
    statusMessage,
  };

  let actions: RepoDataActions = {
    signIn,
    signOut,
    openRepoAccess,

    syncNow,
    setAutosync,
    selectNote,
    createNote,
    createFolder,
    renameNote,
    deleteNote,
    renameFolder,
    deleteFolder,
    updateNoteText,
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
          .listNotes()
          .map((meta) => localStore.loadNote(meta.id))
          .filter((note): note is NoteDoc => note !== null)
          .filter((note) => note.lastSyncedHash !== hashText(note.text))
          .map((note) => ({
            path: note.path,
            text: note.text,
            baseSha: note.lastRemoteSha,
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
