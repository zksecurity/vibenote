import { useMemo, useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
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
  ensureFreshAccessToken,
  signOutFromGitHubApp,
  type AppUser,
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
import type { Route } from './ui/routing';

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
const AUTO_SYNC_POLL_INTERVALL = 180_000;

type RepoNoteListItem = NoteMeta | ReadOnlyNote;

type RepoDataState = {
  // session state
  sessionToken: string | null;
  user: AppUser | null;

  // repo access state
  canEdit: boolean;
  canRead: boolean;
  canSync: boolean;
  needsInstall: boolean;
  repoQueryStatus: RepoQueryStatus;
  manageUrl: string | null;

  // repo content
  doc: NoteDoc | null;
  activeId: string | null;
  notes: RepoNoteListItem[];
  folders: string[];

  // sync state
  autosync: boolean;
  syncing: boolean;

  // general info
  statusMessage: string | null;
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
  selectNote: (id: string | null) => Promise<void>;
  createNote: (dir: string, name: string) => string | null;
  createFolder: (parentDir: string, name: string) => void;
  renameNote: (id: string, title: string) => void;
  deleteNote: (id: string) => void;
  renameFolder: (dir: string, newName: string) => void;
  deleteFolder: (dir: string) => void;
  updateNoteText: (id: string, text: string) => void;
};

type RepoDataInputs = {
  slug: string;
  route: Route;
  onRecordRecent: (entry: {
    slug: string;
    owner?: string;
    repo?: string;
    title?: string;
    connected?: boolean;
  }) => void;
};

function useRepoData({ slug, route, onRecordRecent }: RepoDataInputs): {
  state: RepoDataState;
  actions: RepoDataActions;
} {
  // ORIGINAL STATE AND MAIN HOOKS
  // Local storage wrapper
  const { notes: localNotes, folders: localFolders } = useLocalRepoSnapshot(slug);

  // Store the current GitHub App session token to toggle authenticated features instantly.
  const [sessionToken, setSessionToken] = useState(getAppSessionToken);

  // Carry the latest sync status message shown across the workspace.
  // TODO make this disappear after a timeout
  const [statusMessage, setSyncMessage] = useState<string | null>(null);

  // Track whether this repo slug has already been linked to GitHub sync.
  const [linked, setLinked] = useState(() => isRepoLinked(slug));

  // Keep the signed-in GitHub App user details for header UI.
  const [user, setUser] = useState(getAppSessionUser);

  // Query GitHub for repo access state and other metadata.
  const repoAccess = useRepoAccess({ route, sessionToken });

  // DERIVED STATE (and hooks that depend on it)

  const { defaultBranch, manageUrl } = repoAccess;
  const accessStatusReady =
    repoAccess.status === 'ready' || repoAccess.status === 'rate-limited' || repoAccess.status === 'error';

  // in readonly mode, we store nothing locally and just fetch content from github no demand
  const isReadOnly = repoAccess.level === 'read';
  const {
    notes: readOnlyNotes,
    doc: readOnlyDoc,
    folders: readOnlyFolders,
    selectDoc: selectReadOnlyDoc,
    reset: resetReadOnlyState,
  } = useReadOnlyNotes({ slug, isReadOnly, defaultBranch });

  // whether we treat the repo as locally writable
  // note that we are optimistic about write access until the access check completes,
  // to avoid flickering the UI when revisiting a known writable repo
  const canEdit =
    route.kind === 'new' ||
    (!!sessionToken && (repoAccess.level === 'write' || (!accessStatusReady && linked)));

  const { autosync, setAutosync, scheduleAutoSync, performSync, syncing } = useSync({
    slug,
    route,
    sessionToken,
    linked,
    canEdit,
  });

  // Derive the notes/folders from whichever source is powering the tree.
  const notes = isReadOnly ? readOnlyNotes : localNotes;
  const folders = isReadOnly ? readOnlyFolders : localFolders;

  const { activeId, setActiveId } = useActiveNote({ slug, notes, canEdit });

  const localDoc = useMemo(() => {
    if (!canEdit) return null;
    if (!activeId) return null;
    return getRepoStore(slug).loadNote(activeId);
  }, [canEdit, activeId, slug, localNotes]);

  const doc = canEdit ? localDoc : readOnlyDoc;

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

  const initialPullRef = useRef({ done: false });

  // Kick off the one-time remote import when visiting a writable repo we have not linked yet.
  useEffect(() => {
    (async () => {
      if (route.kind !== 'repo') return;
      if (repoAccess.level !== 'write') return;
      if (!canEdit) return;
      if (linked) return;
      if (initialPullRef.current.done) return;
      try {
        const cfg: RemoteConfig = buildRemoteConfig(slug, repoAccess.defaultBranch);
        const entries = await listNoteFiles(cfg);
        const files: { path: string; text: string; sha?: string }[] = [];
        for (const e of entries) {
          const rf = await pullNote(cfg, e.path);
          if (rf) files.push({ path: rf.path, text: rf.text, sha: rf.sha });
        }
        const localStore = getRepoStore(slug);
        localStore.replaceWithRemote(files);
        const synced = localStore.listNotes();
        setActiveId((prev) => {
          if (prev) return prev;
          const stored = getLastActiveNoteId(slug);
          if (stored && synced.some((n) => n.id === stored)) return stored;
          return null;
        });
        markRepoLinked(slug);
        setLinked(true);
        setSyncMessage('Loaded repository');
      } catch (error) {
        logError(error);
      } finally {
        initialPullRef.current.done = true;
      }
    })();
  }, [route, repoAccess.level, linked, slug, canEdit, defaultBranch]);

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
        const cfg = buildRemoteConfig(slug, defaultBranch);
        const localStore = getRepoStore(slug);
        const pending = localStore
          .listNotes()
          .map((meta) => localStore.loadNote(meta.id))
          .filter((note): note is NoteDoc => !!note)
          .filter((note) => note.lastSyncedHash !== hashText(note.text ?? ''))
          .map((note) => ({
            path: note.path,
            text: note.text ?? '',
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
  }, [route.kind, sessionToken, linked, slug, canEdit, defaultBranch]);

  // CLICK HANDLERS

  // "Connect GitHub" button in the header
  const signIn = async () => {
    try {
      const result = await signInWithGitHubApp();
      if (result) {
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
      if (manageUrl && repoAccess.metadata?.repoSelected === false) {
        window.open(manageUrl, '_blank', 'noopener');
        return;
      }
      if (route.kind !== 'repo') return;
      const url = await apiGetInstallUrl(route.owner, route.repo, window.location.href);
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
    setSessionToken(null);
    setUser(null);
    setLinked(false);
    setAutosync(false);
    resetReadOnlyState();
    setActiveId(null);
    initialPullRef.current.done = false;

    setSyncMessage('Signed out');
  };

  // "Sync" button in the header
  const syncNow = async () => {
    try {
      setSyncMessage(null);
      if (!sessionToken || !linked || slug === 'new' || !canEdit) {
        setSyncMessage('Connect GitHub and configure repo first');
        return;
      }
      const summary = await performSync();
      const parts: string[] = [];
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

  const updateNoteText = (id: string, text: string) => {
    if (!canEdit) return;
    getRepoStore(slug).saveNote(id, text);
    scheduleAutoSync();
  };

  const createNote = (dir: string, name: string) => {
    if (!canEdit) return null;
    const id = getRepoStore(slug).createNote(name, '', dir);
    setActiveId(id);
    scheduleAutoSync();
    return id;
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

  const renameNote = (id: string, title: string) => {
    if (!canEdit) return;
    try {
      getRepoStore(slug).renameNote(id, title);
      scheduleAutoSync();
    } catch (error) {
      logError(error);
      setSyncMessage('Invalid title. Avoid / and control characters.');
    }
  };

  const deleteNote = (id: string) => {
    if (!canEdit) return;
    const localStore = getRepoStore(slug);
    localStore.deleteNote(id);
    const list = localStore.listNotes();
    const nextId = list[0]?.id ?? null;
    setActiveId((prev) => {
      if (prev && prev !== id) return prev;
      return nextId;
    });
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
    const localStore = getRepoStore(slug);
    const notes = localStore.listNotes();
    const hasNotes = notes.some((note) => {
      const directory = note.dir ?? '';
      return directory === dir || directory.startsWith(dir + '/');
    });
    if (hasNotes && !window.confirm('Delete folder and all contained notes?')) return;
    localStore.deleteFolder(dir);
    const list = localStore.listNotes();
    setActiveId((prev) => {
      if (!prev) return prev;
      return list.some((note) => note.id === prev) ? prev : list[0]?.id ?? null;
    });
    scheduleAutoSync();
  };

  const selectNote = async (id: string | null) => {
    setActiveId(id);
    await selectReadOnlyDoc(id);
  };

  const state: RepoDataState = {
    sessionToken,
    user,

    canRead: canEdit || isReadOnly,
    canEdit,
    canSync: linked && canEdit,
    repoQueryStatus: repoAccess.status,
    needsInstall: repoAccess.needsInstall,

    doc,
    activeId,
    notes,
    folders,

    autosync,
    syncing,
    statusMessage,
    manageUrl,
  };

  const actions: RepoDataActions = {
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
  const storeRef = useRef<ReturnType<typeof getRepoStore>>();
  if (storeRef.current?.slug !== slug) {
    storeRef.current = getRepoStore(slug);
  }
  const store = storeRef.current;
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
  metadata: RepoMetadata | null;
  defaultBranch?: string;
  error: string | null;
  rateLimited: boolean;
  needsInstall: boolean;
  manageUrl: string | null;
  isPrivate: boolean | null;
};

const initialAccessState: RepoAccessState = {
  level: 'none',
  status: 'unknown',
  metadata: null,
  defaultBranch: undefined,
  error: null,
  rateLimited: false,
  needsInstall: false,
  manageUrl: null,
  isPrivate: null,
};

function useRepoAccess(params: { route: Route; sessionToken: string | null }): RepoAccessState {
  let { route, sessionToken } = params;
  let owner = route.kind === 'repo' ? route.owner : null;
  let repo = route.kind === 'repo' ? route.repo : null;

  // Track the evolving access status/metadata for the active repository target.
  let [state, setState] = useState<RepoAccessState>(initialAccessState);

  // Query GitHub (and the public fallback) whenever the targeted repo changes.
  useEffect(() => {
    if (!owner || !repo) return;
    let cancelled = false;
    (async () => {
      try {
        const meta = await apiGetRepoMetadata(owner, repo);
        const next = deriveAccessFromMetadata({ meta, sessionToken });
        if (!cancelled) {
          setState((prev) => (areAccessStatesEqual(prev, next) ? prev : next));
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'unknown-error';
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
  }, [owner, repo, sessionToken]);

  if (!owner || !repo) return initialAccessState;
  return state;
}

function deriveAccessFromMetadata({
  meta,
  sessionToken,
}: {
  meta: RepoMetadata;
  sessionToken: string | null;
}): RepoAccessState {
  let hasSession = !!sessionToken;

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
    error: null,
    rateLimited: meta.rateLimited === true,
    needsInstall: hasSession && level === 'none',
    manageUrl: meta.manageUrl ?? null,
    isPrivate: meta.isPrivate,
  };
}

function useSync(params: {
  slug: string;
  route: Route;
  sessionToken: string | null;
  linked: boolean;
  canEdit: boolean;
}) {
  const { slug, route, sessionToken, linked, canEdit } = params;
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
    async (options: { silent?: boolean } = {}): Promise<SyncSummary | null> => {
      if (inFlightRef.current) return null;
      inFlightRef.current = true;
      setSyncing(true);
      try {
        if (!sessionToken || !linked || slug === 'new' || !canEdit) return null;
        const store = getRepoStore(slug);
        const summary = await syncBidirectional(store, slug);
        recordAutoSyncRun(slug);
        return summary;
      } catch (error) {
        if (options.silent) {
          logError(error);
          return null;
        }
        throw error;
      } finally {
        inFlightRef.current = false;
        setSyncing(false);
      }
    },
    [sessionToken, linked, slug, canEdit]
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
    const id = window.setInterval(() => scheduleAutoSync(0), AUTO_SYNC_POLL_INTERVALL);
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

  return { autosync, setAutosync, scheduleAutoSync, performSync, syncing };
}

function useActiveNote({
  slug,
  notes,
  canEdit,
}: {
  slug: string;
  notes: { id: string }[];
  canEdit: boolean;
}) {
  // Track the currently focused note id for the editor and file tree.
  const [activeId, setActiveId] = useState<string | null>(() => {
    const stored = getLastActiveNoteId(slug);
    if (!stored) return null;
    return notes.some((note) => note.id === stored) ? stored : null;
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

  // Remove selection when the activeId disappears from the list.
  useEffect(() => {
    setActiveId((prev) => {
      if (prev && notes.some((note) => note.id === prev)) return prev;
      return null;
    });
  }, [notes]);

  return { activeId, setActiveId };
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
