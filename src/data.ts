import { useMemo, useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
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
  hashText,
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
import { fetchPublicRepoInfo } from './lib/github-public';
import {
  buildRemoteConfig,
  pullNote,
  listNoteFiles,
  syncBidirectional,
  type RemoteConfig,
  type SyncSummary,
} from './sync/git-sync';
import type { Route } from './ui/routing';

const AUTO_SYNC_MIN_INTERVAL_MS = 60_000;
const AUTO_SYNC_DEBOUNCE_MS = 10_000;

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

type RepoNoteListItem = NoteMeta | ReadOnlyNote;

export { useRepoData };
export type {
  RepoAccessState,
  RepoDataInputs,
  RepoDataState,
  RepoDataActions,
  RepoNoteListItem,
  ReadOnlyNote,
};

type RepoDataState = {
  // session state
  sessionToken: string | null;
  user: AppUser | null;

  // repo access state
  // TODO clean up
  repoAccess: RepoAccessState;
  linked: boolean;
  canEdit: boolean;
  isReadOnly: boolean;
  syncMessage: string | null;
  needsInstallForPrivate: boolean;
  isRateLimited: boolean;
  isMetadataError: boolean;
  manageUrl: string | null;

  // current note state
  doc: NoteDoc | null;
  activeId: string | null;
  activeNotes: RepoNoteListItem[];
  activeFolders: string[];
  readOnlyLoading: boolean; // TODO why don't we have a loading state when fetching writable notes?

  // sync state
  autosync: boolean;
  syncing: boolean;
};

type RepoDataActions = {
  connect: () => Promise<void>;
  openAccessSetup: () => Promise<void>;
  signOut: () => Promise<void>;
  syncNow: () => Promise<void>;
  setAutosync: (enabled: boolean) => void;
  selectNote: (id: string | null) => Promise<void>;
  createNote: (dir: string, name: string) => string | null;
  createFolder: (parentDir: string, name: string) => void;
  renameNote: (id: string, title: string) => void;
  deleteNote: (id: string) => void;
  renameFolder: (dir: string, newName: string) => void;
  deleteFolder: (dir: string) => void;
  updateNoteText: (id: string, text: string) => void;
};

function useRepoData({ slug, route, onRecordRecent }: RepoDataInputs): {
  state: RepoDataState;
  actions: RepoDataActions;
} {
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
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  // Track whether this repo slug has already been linked to GitHub sync.
  const [linked, setLinked] = useState(() => isRepoLinked(slug));

  // Keep the signed-in GitHub App user details for header UI.
  const [user, setUser] = useState(getAppSessionUser);

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
  async function loadReadOnlyNote(id: string) {
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
  }

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
          const stored = getLastActiveNoteId(slug);
          if (stored && synced.some((n) => n.id === stored)) return stored;
          return null;
        });
        markRepoLinked(slug);
        setLinked(true);
        setSyncMessage('Loaded repository');
      } catch (error) {
        console.error(error);
      } finally {
        initialPullRef.current.done = true;
      }
    })();
  }, [route, repoAccess.level, linked, slug, store, canEdit, repoAccess.defaultBranch, notifyStoreListeners]);

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
      } catch (error) {
        console.error(error);
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
  }, [route.kind, sessionToken, linked, slug, canEdit, store, repoAccess.defaultBranch]);

  // CLICK HANDLERS

  // "Connect GitHub" button in the header
  const connect = async () => {
    try {
      const result = await signInWithGitHubApp();
      if (result) {
        setSessionToken(result.token);
        setUser(result.user);
      }
    } catch (error) {
      console.error(error);
      setSyncMessage('Failed to sign in');
    }
  };

  // "Get Write Access" or "Get Read/Write Access" button
  const openAccessSetup = async () => {
    try {
      if (manageUrl && repoAccess.metadata?.repoSelected === false) {
        window.open(manageUrl, '_blank', 'noopener');
        return;
      }
      if (route.kind !== 'repo') return;
      const url = await apiGetInstallUrl(route.owner, route.repo, window.location.href);
      window.open(url, '_blank', 'noopener');
    } catch (error) {
      console.error(error);
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
    clearAllLocalData();
    store.replaceWithRemote([]);
    notifyStoreListeners();
    setSessionToken(null);
    setUser(null);
    setLinked(false);
    setAutosync(false);
    setReadOnlyNotes([]);
    setActiveId(null);
    setReadOnlyDoc(null);
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
      console.error(error);
      setSyncMessage('Sync failed');
    }
  };

  const updateNoteText = (id: string, text: string) => {
    if (!canEdit) return;
    store.saveNote(id, text);
    scheduleAutoSync();
  };

  const createNote = (dir: string, name: string) => {
    if (!canEdit) return null;
    const id = store.createNote(name, '', dir);
    notifyStoreListeners();
    setActiveId(id);
    scheduleAutoSync();
    return id;
  };

  const createFolder = (parentDir: string, name: string) => {
    if (!canEdit) return;
    try {
      store.createFolder(parentDir, name);
      notifyStoreListeners();
    } catch (error) {
      console.error(error);
      setSyncMessage('Invalid folder name.');
      return;
    }
    scheduleAutoSync();
  };

  const renameNote = (id: string, title: string) => {
    if (!canEdit) return;
    try {
      store.renameNote(id, title);
      notifyStoreListeners();
      scheduleAutoSync();
    } catch (error) {
      console.error(error);
      setSyncMessage('Invalid title. Avoid / and control characters.');
    }
  };

  const deleteNote = (id: string) => {
    if (!canEdit) return;
    store.deleteNote(id);
    notifyStoreListeners();
    const list = store.listNotes();
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
      store.renameFolder(dir, newName);
      notifyStoreListeners();
      scheduleAutoSync();
    } catch (error) {
      console.error(error);
      setSyncMessage('Invalid folder name.');
    }
  };

  const deleteFolder = (dir: string) => {
    if (!canEdit) return;
    const notes = store.listNotes();
    const hasNotes = notes.some((note) => {
      const directory = note.dir ?? '';
      return directory === dir || directory.startsWith(dir + '/');
    });
    if (hasNotes && !window.confirm('Delete folder and all contained notes?')) return;
    store.deleteFolder(dir);
    notifyStoreListeners();
    const list = store.listNotes();
    setActiveId((prev) => {
      if (!prev) return prev;
      return list.some((note) => note.id === prev) ? prev : list[0]?.id ?? null;
    });
    scheduleAutoSync();
  };

  const selectNote = async (id: string | null) => {
    setActiveId(id);
    if (!id) {
      if (!canEdit) setReadOnlyDoc(null);
      return;
    }
    if (!canEdit) {
      await loadReadOnlyNote(id);
    }
  };

  // Persist the active note id so future visits resume on the same file (when permitted).
  useEffect(() => {
    if (!canEdit) return;
    setLastActiveNoteId(slug, activeId ?? null);
  }, [activeId, slug, canEdit]);

  const state: RepoDataState = {
    sessionToken,
    user,
    repoAccess,
    linked,
    canEdit,
    isReadOnly,
    doc,
    activeId,
    activeNotes,
    activeFolders,
    readOnlyLoading,
    autosync,
    syncing,
    syncMessage,
    needsInstallForPrivate,
    isRateLimited,
    isMetadataError,
    manageUrl,
  };

  const actions: RepoDataActions = {
    connect,
    openAccessSetup,
    signOut,
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
      } catch (error) {
        console.error('vibenote: repo store listener failed', error);
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
  } as const;
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
      } catch (error) {
        if (options.silent) {
          console.error(error);
          return null;
        }
        throw error;
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

type ActiveNoteParams = {
  slug: string;
  store: LocalStore;
  notes: NoteMeta[];
  canEdit: boolean;
};

function useActiveNote({ slug, store, notes, canEdit }: ActiveNoteParams) {
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

function remoteConfigForSlug(slug: string, branch: string | null): RemoteConfig {
  const cfg: RemoteConfig = buildRemoteConfig(slug);
  if (branch) cfg.branch = branch;
  return cfg;
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
