import { useMemo, useState, useEffect } from 'react';
import { FileTree, type FileEntry } from './FileTree';
import { Editor } from './Editor';
import {
  LocalStore,
  clearAllTombstones,
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
  ensureAppUserAvatarCached,
  clearSession as clearAppSession,
  type AppUser,
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
  repoExists,
  listNoteFiles,
  commitBatch,
  syncBidirectional,
  type RemoteConfig,
} from '../sync/git-sync';
import { hashText } from '../storage/local';
import { RepoSwitcher } from './RepoSwitcher';
import { Toggle } from './Toggle';
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

type NotesRepoStatus = {
  loading: boolean;
  exists: boolean;
  accessible: boolean;
  defaultBranch: string | null;
  manageUrl: string | null;
  error: string | null;
};

function makeNotesRepoStatus(): NotesRepoStatus {
  return {
    loading: false,
    exists: false,
    accessible: false,
    defaultBranch: null,
    manageUrl: null,
    error: null,
  };
}

export function RepoView(props: RepoViewProps) {
  return <RepoViewInner key={props.slug} {...props} />;
}

function RepoViewInner({ slug, route, navigate, onRecordRecent }: RepoViewProps) {
  const store = useMemo(() => {
    if (route.kind === 'repo') {
      return new LocalStore(slug, { seedWelcome: false });
    }
    return new LocalStore(slug);
  }, [slug, route.kind]);
  const isScratchpad = slug === 'new';
  const [notes, setNotes] = useState<NoteMeta[]>(() => store.listNotes());
  const [folders, setFolders] = useState<string[]>(() => store.listFolders());
  // Restore the previously active note as early as possible so the editor does not flicker to empty state.
  const [activeId, setActiveId] = useState<string | null>(() => {
    if (isScratchpad) return null;
    const stored = getLastActiveNoteId(slug);
    if (!stored) return null;
    const available = store.listNotes();
    return available.some((note) => note.id === stored) ? stored : null;
  });
  const [doc, setDoc] = useState<NoteDoc | null>(null);
  const [collapsedFolders, setCollapsedFoldersState] = useState<Record<string, boolean>>(() => {
    let expanded = slug === 'new' ? [] : getExpandedFolders(slug);
    return buildCollapsedMap(expanded, store.listFolders());
  });
  type ReadOnlyNote = { id: string; path: string; title: string; dir: string; sha?: string };
  const [readOnlyNotes, setReadOnlyNotes] = useState<ReadOnlyNote[]>([]);
  const [readOnlyLoading, setReadOnlyLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selection, setSelection] = useState<
    { kind: 'folder'; dir: string } | { kind: 'file'; id: string } | null
  >(null);
  const [newEntry, setNewEntry] = useState<{
    kind: 'file' | 'folder';
    parentDir: string;
    key: number;
  } | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(getAppSessionToken());
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [notesRepoStatus, setNotesRepoStatus] = useState<NotesRepoStatus>(() => makeNotesRepoStatus());
  const [notesRepoRefresh, setNotesRepoRefresh] = useState(0);
  const [seedingNotesRepo, setSeedingNotesRepo] = useState(false);
  const initialAppUser = useMemo(() => getAppSessionUser(), []);
  const [ownerLogin, setOwnerLogin] = useState<string | null>(initialAppUser?.login ?? null);
  const [linked, setLinked] = useState(() => slug !== 'new' && isRepoLinked(slug));
  const [user, setUser] = useState<AppUser | null>(initialAppUser);
  const userAvatarSrc = user?.avatarDataUrl ?? user?.avatarUrl ?? undefined;
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; href?: string } | null>(null);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [accessState, setAccessState] = useState<'unknown' | 'reachable' | 'unreachable'>('unknown');
  const [repoMeta, setRepoMeta] = useState<RepoMetadata | null>(null);
  const [hasMetadataResolved, setHasMetadataResolved] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [publicRepoMeta, setPublicRepoMeta] = useState<{
    isPrivate: boolean;
    defaultBranch: string | null;
  } | null>(null);
  const [publicRateLimited, setPublicRateLimited] = useState(false);
  const [, setPublicMetaError] = useState<string | null>(null);
  const manageUrl = repoMeta?.manageUrl ?? null;
  const recommendedRepoSlug = ownerLogin ? `${ownerLogin}/notes` : null;
  const recommendedRepoParts = recommendedRepoSlug ? recommendedRepoSlug.split('/', 2) : [];
  const recommendedRepoOwner = recommendedRepoParts[0] ?? null;
  const recommendedRepoName = recommendedRepoParts[1] ?? null;
  const buildConfigWithMeta = () => {
    const cfg: RemoteConfig = buildRemoteConfig(slug);
    const branch = repoMeta?.defaultBranch ?? publicRepoMeta?.defaultBranch;
    if (branch) cfg.branch = branch;
    return cfg;
  };
  const metadataAllowsEdit = !!repoMeta?.repoSelected;
  const canEdit =
    isScratchpad ||
    (!!sessionToken && (metadataAllowsEdit || ((!hasMetadataResolved || !!metadataError) && linked)));
  const repoIsPublic =
    repoMeta?.isPrivate === false || (!repoMeta?.repoSelected && publicRepoMeta?.isPrivate === false);
  const repoIsPrivate = repoMeta?.isPrivate === true || publicRepoMeta?.isPrivate === true;
  const isPublicReadonly = repoIsPublic && !canEdit;
  const needsInstallForPrivate = repoIsPrivate && !canEdit;
  const isRateLimited = !metadataError && (publicRateLimited || repoMeta?.rateLimited === true);
  const [refreshTick, setRefreshTick] = useState(0);
  const initialPullRef = useState({ done: false })[0];
  const [autosync, setAutosync] = useState<boolean>(() => (slug !== 'new' ? isAutosyncEnabled(slug) : false));
  const autoSyncTimerRef = useState<{ id: number | null }>({ id: null })[0];
  const autoSyncBusyRef = useState<{ busy: boolean }>({ busy: false })[0];
  const AUTO_SYNC_MIN_INTERVAL_MS = 60_000; // not too often
  const AUTO_SYNC_DEBOUNCE_MS = 10_000;

  useEffect(() => {
    if (slug === 'new') return;
    if (activeId) return;
    let stored = getLastActiveNoteId(slug);
    if (!stored) return;
    let exists = store.listNotes().some((n) => n.id === stored);
    if (exists) setActiveId(stored);
  }, [slug, store, activeId]);

  useEffect(() => {
    if (slug === 'new') return;
    setLastActiveNoteId(slug, activeId ?? null);
  }, [activeId, slug]);

  useEffect(() => {
    let cancelled = false;
    if (!user || user.avatarDataUrl || !user.avatarUrl) return;
    (async () => {
      const updated = await ensureAppUserAvatarCached();
      if (!cancelled && updated && updated.avatarDataUrl) {
        setUser(updated);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.avatarDataUrl, user?.avatarUrl, ensureAppUserAvatarCached]);

  useEffect(() => {
    let expanded = slug === 'new' ? [] : getExpandedFolders(slug);
    let next = buildCollapsedMap(expanded, store.listFolders());
    setCollapsedFoldersState((prev) => (collapsedMapsEqual(prev, next) ? prev : next));
  }, [slug, store]);

  useEffect(() => {
    setCollapsedFoldersState((prev) => {
      let next = syncCollapsedWithFolders(prev, folders);
      return collapsedMapsEqual(prev, next) ? prev : next;
    });
  }, [folders]);

  useEffect(() => {
    if (!isScratchpad) return;
    if (!sessionToken || !ownerLogin) {
      setNotesRepoStatus(makeNotesRepoStatus());
      return;
    }
    let cancelled = false;
    setNotesRepoStatus((prev) => ({ ...prev, loading: true, error: null }));
    (async () => {
      try {
        const meta = await apiGetRepoMetadata(ownerLogin, 'notes');
        let accessible = Boolean(meta.repoSelected);
        if (!accessible && meta.repositorySelection === 'all') accessible = true;
        let exists = accessible;
        if (!exists) {
          if (typeof meta.isPrivate === 'boolean') exists = true;
          if (meta.defaultBranch) exists = true;
        }
        if (!exists) {
          try {
            exists = await repoExists(ownerLogin, 'notes');
          } catch {
            // ignore secondary check errors
          }
        }
        if (cancelled) return;
        setNotesRepoStatus({
          loading: false,
          exists,
          accessible,
          defaultBranch: meta.defaultBranch ?? null,
          manageUrl: meta.manageUrl ?? null,
          error: null,
        });
      } catch (error) {
        if (cancelled) return;
        setNotesRepoStatus({
          loading: false,
          exists: false,
          accessible: false,
          defaultBranch: null,
          manageUrl: null,
          error: error instanceof Error ? error.message : 'unknown-error',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isScratchpad, sessionToken, ownerLogin, notesRepoRefresh]);

  useEffect(() => {
    if (slug !== 'new') {
      let expanded: string[] = [];
      for (let dir in collapsedFolders) {
        if (!Object.prototype.hasOwnProperty.call(collapsedFolders, dir)) continue;
        if (dir === '') continue;
        if (collapsedFolders[dir] === false) expanded.push(dir);
      }
      setExpandedFolders(slug, expanded);
    }
  }, [collapsedFolders, slug]);

  useEffect(() => {
    if (route.kind !== 'repo') return;
    if (accessState !== 'reachable') return; // only record reachable repos
    onRecordRecent({
      slug,
      owner: route.owner,
      repo: route.repo,
      connected: canEdit && linked,
    });
  }, [slug, route, linked, onRecordRecent, accessState, canEdit]);

  // When we navigate to a reachable repo we haven't linked locally yet, auto-load its notes
  useEffect(() => {
    (async () => {
      if (route.kind !== 'repo') return;
      if (accessState !== 'reachable') return;
      if (!canEdit) return;
      if (linked) return;
      if (initialPullRef.done) return;
      try {
        const cfg: RemoteConfig = buildConfigWithMeta();
        const entries = await listNoteFiles(cfg);
        const files: { path: string; text: string; sha?: string }[] = [];
        for (const e of entries) {
          const rf = await pullNote(cfg, e.path);
          if (rf) files.push({ path: rf.path, text: rf.text, sha: rf.sha });
        }
        store.replaceWithRemote(files);
        let synced = store.listNotes();
        setNotes(synced);
        setActiveId((prev) => {
          if (prev) return prev;
          if (slug !== 'new') {
            let stored = getLastActiveNoteId(slug);
            if (stored && synced.some((n) => n.id === stored)) return stored;
          }
          return null;
        });
        markRepoLinked(slug);
        setLinked(true);
        setSyncMsg('Loaded repository');
      } catch (e) {
        console.error(e);
      } finally {
        initialPullRef.done = true;
      }
    })();
  }, [route, accessState, linked, slug, store, initialPullRef, canEdit]);

  // Determine repository access via backend metadata
  useEffect(() => {
    let cancelled = false;
    if (route.kind !== 'repo') {
      setAccessState('unknown');
      return;
    }
    setHasMetadataResolved(false);
    setMetadataError(null);
    (async () => {
      try {
        const meta = await apiGetRepoMetadata(route.owner, route.repo);
        if (!cancelled) {
          setRepoMeta(meta);
          if (meta.repoSelected) {
            setAccessState('reachable');
            setPublicRepoMeta(null);
            setPublicRateLimited(false);
            setPublicMetaError(null);
          } else if (meta.isPrivate === false) {
            setAccessState('reachable');
          } else if (meta.isPrivate === true) {
            setAccessState('unreachable');
          } else {
            setAccessState('unknown');
          }
        }
        setHasMetadataResolved(true);
      } catch (err) {
        if (!cancelled) setAccessState('unknown');
        setMetadataError(err instanceof Error ? err.message : 'unknown-error');
        setHasMetadataResolved(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route]);

  useEffect(() => {
    if (route.kind !== 'repo') return;
    if (repoMeta?.repoSelected) return;
    if (repoMeta?.isPrivate === true) return;
    if (publicRepoMeta || publicRateLimited) return;
    let cancelled = false;
    (async () => {
      try {
        setPublicMetaError(null);
        const info = await fetchPublicRepoInfo(route.owner, route.repo);
        if (cancelled) return;
        if (info.ok && typeof info.isPrivate === 'boolean') {
          setPublicRepoMeta({
            isPrivate: info.isPrivate,
            defaultBranch: info.defaultBranch ?? null,
          });
          setPublicRateLimited(false);
          setPublicMetaError(null);
          setAccessState(info.isPrivate ? 'unreachable' : 'reachable');
        } else if (info.rateLimited) {
          setPublicRateLimited(true);
        } else if (info.notFound) {
          setPublicRepoMeta({ isPrivate: true, defaultBranch: null });
          setAccessState('unreachable');
        } else {
          setPublicMetaError(info.message ?? 'unknown-error');
          console.warn('vibenote: public repo metadata fetch failed', info);
        }
      } catch (err) {
        if (!cancelled) {
          setPublicMetaError(err instanceof Error ? err.message : 'unknown-error');
          console.warn('vibenote: public repo metadata fetch error', err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route, repoMeta?.installed, repoMeta?.isPrivate, publicRepoMeta, publicRateLimited]);

  useEffect(() => {
    if (!isPublicReadonly) {
      setReadOnlyNotes([]);
      setReadOnlyLoading(false);
      return;
    }
    let cancelled = false;
    setReadOnlyLoading(true);
    (async () => {
      try {
        const cfg = buildConfigWithMeta();
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
          setDoc({
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
          setDoc(null);
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
  }, [isPublicReadonly, slug, repoMeta?.defaultBranch, publicRepoMeta?.defaultBranch]);

  useEffect(() => {
    if (!canEdit) return;
    const nextNotes = store.listNotes();
    const nextFolders = store.listFolders();
    setNotes(nextNotes);
    setFolders(nextFolders);
    setActiveId((prev) => {
      if (prev && nextNotes.some((n) => n.id === prev)) return prev;
      return nextNotes[0]?.id ?? null;
    });
  }, [store, canEdit]);

  useEffect(() => {
    if (!canEdit) return;
    setDoc(activeId ? store.loadNote(activeId) : null);
  }, [store, activeId, canEdit]);

  // Cross-tab coherence: listen to localStorage changes for this repo slug
  useEffect(() => {
    if (!canEdit) return;
    const encodedSlug = encodeURIComponent(slug);
    const prefix = `vibenote:repo:${encodedSlug}:`;
    let timer: number | null = null;
    const scheduleRefresh = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        // Re-read index and doc to reflect changes
        const nextNotes = store.listNotes();
        const nextFolders = store.listFolders();
        setNotes(nextNotes);
        setFolders(nextFolders);
        setActiveId((prev) => {
          if (prev && nextNotes.some((n) => n.id === prev)) return prev;
          if (prev) return nextNotes[0]?.id ?? null;
          return prev;
        });
        // Nudge dependent effects
        setRefreshTick((t) => t + 1);
      }, 150);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== window.localStorage) return;
      if (!e.key) return; // some browsers
      if (!e.key.startsWith(prefix)) return;
      scheduleRefresh();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [slug, store]);

  const scheduleAutoSync = (debounceMs: number = AUTO_SYNC_DEBOUNCE_MS) => {
    if (!autosync) return;
    if (route.kind !== 'repo') return;
    if (!sessionToken || !linked || slug === 'new' || !canEdit) return;
    // Respect min interval across tabs
    let last = getLastAutoSyncAt(slug) ?? 0;
    let now = Date.now();
    let dueIn = Math.max(0, AUTO_SYNC_MIN_INTERVAL_MS - (now - last));
    let delay = Math.max(debounceMs, dueIn);
    if (autoSyncTimerRef.id !== null) window.clearTimeout(autoSyncTimerRef.id);
    autoSyncTimerRef.id = window.setTimeout(() => {
      autoSyncTimerRef.id = null;
      void runAutoSync();
    }, delay);
  };

  const runAutoSync = async () => {
    if (autoSyncBusyRef.busy) return;
    autoSyncBusyRef.busy = true;
    setSyncing(true);
    try {
      if (!sessionToken || !linked || slug === 'new' || !canEdit) return;
      let summary = await syncBidirectional(store, slug);
      recordAutoSyncRun(slug);
      setNotes(store.listNotes());
      setDoc((prev) => (prev ? store.loadNote(prev.id) : null));
      // Keep status banner quiet for background runs
      // Optionally, we could set a subtle message only when changes were synced.
      void summary;
    } catch (err) {
      // Quietly ignore background errors to avoid noise; console for developers
      console.error(err);
    } finally {
      autoSyncBusyRef.busy = false;
      setSyncing(false);
    }
  };

  const onCreate = () => {
    if (!canEdit) return;
    let parentDir = '';
    if (selection?.kind === 'folder') parentDir = selection.dir;
    if (selection?.kind === 'file') {
      let n = notes.find((x) => x.id === selection.id);
      if (n) parentDir = (n.dir as string) || '';
    }
    setNewEntry({ kind: 'file', parentDir, key: Date.now() });
  };

  const onCreateFolder = (parentDir: string) => {
    if (!canEdit) return;
    setNewEntry({ kind: 'folder', parentDir, key: Date.now() });
  };

  const onRenameFolder = (dir: string, newName: string) => {
    if (!canEdit) return;
    try {
      store.renameFolder(dir, newName);
      setNotes(store.listNotes());
      setFolders(store.listFolders());
      scheduleAutoSync();
    } catch (e) {
      console.error(e);
      setSyncMsg('Invalid folder name.');
    }
  };

  // Move is deferred to later (drag & drop); not supported for now
  const onMoveFolder = (_fromDir: string, _toDir?: string) => {};

  const onDeleteFolder = (dir: string) => {
    if (!canEdit) return;
    // Skip confirmation if folder (and subtree) contains no files
    let hasNotes = notes.some((n) => {
      let d = (n.dir as string) || '';
      return d === dir || d.startsWith(dir + '/');
    });
    if (hasNotes) {
      if (!window.confirm('Delete folder and all contained notes?')) return;
    }
    store.deleteFolder(dir);
    const list = store.listNotes();
    setNotes(list);
    setFolders(store.listFolders());
    if (activeId && !list.some((n) => n.id === activeId)) setActiveId(list[0]?.id ?? null);
    scheduleAutoSync();
  };

  const onRename = (id: string, title: string) => {
    if (!canEdit) return;
    try {
      store.renameNote(id, title);
      setNotes(store.listNotes());
      setFolders(store.listFolders());
      scheduleAutoSync();
    } catch (e) {
      console.error(e);
      setSyncMsg('Invalid title. Avoid / and control characters.');
    }
  };

  const onDelete = (id: string) => {
    if (!canEdit) return;
    store.deleteNote(id);
    const list = store.listNotes();
    setNotes(list);
    setFolders(store.listFolders());
    if (activeId === id) setActiveId(list[0]?.id ?? null);
    scheduleAutoSync();
  };

  const onConnect = async () => {
    try {
      const result = await signInWithGitHubApp();
      if (result) {
        setSessionToken(result.token);
        setUser(result.user);
        setOwnerLogin(result.user.login);
      }
    } catch (e) {
      console.error(e);
      setSyncMsg('Failed to sign in');
    }
  };

  const openAccessSetup = async () => {
    try {
      // the app is already installed and we go straight into the right user's settings to manage repos
      if (manageUrl && repoMeta?.repoSelected === false) {
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

  const onSeedNotesRepo = async () => {
    if (!recommendedRepoSlug || !sessionToken) {
      setSyncMsg('Connect GitHub first');
      return;
    }
    const [owner, repo] = recommendedRepoSlug.split('/', 2);
    if (!owner || !repo) {
      setSyncMsg('Missing repository information');
      return;
    }
    setSyncMsg(null);
    setSeedingNotesRepo(true);
    setNotesRepoStatus((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const config = buildRemoteConfig(recommendedRepoSlug);
      const docs = store
        .listNotes()
        .map((meta) => store.loadNote(meta.id))
        .filter((doc): doc is NoteDoc => !!doc);
      const filesMap = new Map<string, { path: string; text: string }>();
      for (const doc of docs) {
        filesMap.set(doc.path, { path: doc.path, text: doc.text || '' });
      }
      const readmePath = 'README.md';
      if (!filesMap.has(readmePath)) {
        const readme = `# Notes\n\nThis repository is synced with [VibeNote](https://github.com/mitschabaude/vibenote).\n\n- Your notes are plain Markdown files.\n- Use VibeNote to edit locally and sync changes back to GitHub.\n\nHappy writing!\n`;
        filesMap.set(readmePath, { path: readmePath, text: readme });
      }
      const files = Array.from(filesMap.values());
      await commitBatch(config, files, 'vibenote: seed notes repository');
      markRepoLinked(recommendedRepoSlug);
      setAutosyncEnabled(recommendedRepoSlug, true);
      onRecordRecent({ slug: recommendedRepoSlug, owner, repo, connected: true });
      const entries = await listNoteFiles(config);
      const remoteFiles: { path: string; text: string; sha?: string }[] = [];
      for (const entry of entries) {
        const remoteFile = await pullNote(config, entry.path);
        if (remoteFile) {
          remoteFiles.push({ path: remoteFile.path, text: remoteFile.text, sha: remoteFile.sha });
        }
      }
      const targetStore = new LocalStore(recommendedRepoSlug, { seedWelcome: false });
      targetStore.replaceWithRemote(remoteFiles);
      setNotesRepoRefresh((tick) => tick + 1);
      navigate({ kind: 'repo', owner, repo });
    } catch (error) {
      console.error(error);
      setSyncMsg('Failed to seed repository');
      const message = error instanceof Error ? error.message : 'Could not seed repository';
      setNotesRepoStatus((prev) => ({ ...prev, loading: false, error: message }));
    } finally {
      setSeedingNotesRepo(false);
    }
  };

  const ensureOwnerAndOpen = async () => {
    if (!ownerLogin) {
      const u = getAppSessionUser();
      setOwnerLogin(u?.login ?? null);
    }
    setShowSwitcher(true);
  };

  // Keyboard shortcuts: Cmd/Ctrl+K and "g" then "r" open the repo switcher
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
        void ensureOwnerAndOpen();
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
        void ensureOwnerAndOpen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ownerLogin]);

  const GitHubIcon = () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.11 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.91.08 2.11.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );

  const ExternalLinkIcon = () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M10.5 2a.5.5 0 0 0 0 1h2.293L7.146 8.646a.5.5 0 1 0 .708.708L13.5 3.707V6a.5.5 0 0 0 1 0V2.5a.5.5 0 0 0-.5-.5H10.5Z" />
      <path d="M3.75 3A1.75 1.75 0 0 0 2 4.75v7.5C2 13.44 2.56 14 3.25 14h7.5c.69 0 1.25-.56 1.25-1.25V9.5a.5.5 0 0 0-1 0v3.25a.25.25 0 0 1-.25.25h-7.5a.25.25 0 0 1-.25-.25v-7.5c0-.138.112-.25.25-.25H7a.5.5 0 0 0 0-1H3.75Z" />
    </svg>
  );

  const NotesIcon = () => (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M3 1.75A1.75 1.75 0 0 1 4.75 0h6.5A1.75 1.75 0 0 1 13 1.75v12.5A1.75 1.75 0 0 1 11.25 16h-6.5A1.75 1.75 0 0 1 3 14.25Zm1.5.75a.75.75 0 0 0-.75.75v10.5c0 .414.336.75.75.75h6.5a.75.75 0 0 0 .75-.75V3.25a.75.75 0 0 0-.75-.75ZM5 4.5A.5.5 0 0 1 5.5 4h3a.5.5 0 0 1 0 1h-3A.5.5 0 0 1 5 4.5Zm0 2.75A.75.75 0 0 1 5.75 6.5h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 5 7.25Zm0 2.75c0-.414.336-.75.75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 5 10Z" />
    </svg>
  );

  const CloseIcon = () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M3.22 3.22a.75.75 0 0 1 1.06 0L8 6.94l3.72-3.72a.75.75 0 1 1 1.06 1.06L9.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L8 9.06l-3.72 3.72a.75.75 0 1 1-1.06-1.06L6.94 8 3.22 4.28a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );

  const SyncIcon = ({ spinning }: { spinning: boolean }) => (
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

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

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

  // Session-based user is restored from localStorage on init (see getAppSessionUser())

  // Kick off an autosync on load/connect when enabled
  useEffect(() => {
    if (route.kind !== 'repo') return;
    if (!autosync) return;
    if (!sessionToken || !linked || slug === 'new' || !canEdit) return;
    scheduleAutoSync(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.kind, autosync, sessionToken, linked, slug, canEdit]);

  // Periodic background autosync to pick up remote-only changes
  useEffect(() => {
    if (route.kind !== 'repo') return;
    if (!autosync || !sessionToken || !linked || slug === 'new' || !canEdit) return;
    let id = window.setInterval(() => scheduleAutoSync(0), 180_000); // every 3 minutes
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.kind, autosync, sessionToken, linked, slug, canEdit]);

  // Attempt a final background push via Service Worker when the page is closing.
  useEffect(() => {
    const shouldFlush = () => false; // SW flush disabled for GitHub App backend v1
    const onPageHide = () => {
      if (!shouldFlush()) return;
      const sendViaSW = async () => {
        try {
          if (!('serviceWorker' in navigator)) return false;
          const reg = await navigator.serviceWorker.ready;
          const ctrl = reg?.active;
          if (!ctrl) return false;
          // Compute minimal changed set: only notes whose text differs from lastSyncedHash
          const files = store
            .listNotes()
            .map((m) => store.loadNote(m.id))
            .filter((d): d is NonNullable<typeof d> => !!d)
            .filter((d) => d.lastSyncedHash !== hashText(d.text || ''))
            .map((d) => ({ path: d.path, text: d.text || '', baseSha: d.lastRemoteSha }));
          if (files.length === 0) return true;
          const [owner, repo] = slug.split('/', 2);
          void files;
          void owner;
          void repo;
          return true;
        } catch {
          return false;
        }
      };
      // Try SW-based flush
      void sendViaSW();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onPageHide();
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [autosync, linked, slug, store]);

  const onSignOut = () => {
    clearAppSession();
    clearAllLocalData();
    store.replaceWithRemote([]);
    setSessionToken(null);
    setUser(null);
    setOwnerLogin(null);
    setLinked(false);
    setAutosync(false);
    setMenuOpen(false);
    setNotes([]);
    setFolders([]);
    setReadOnlyNotes([]);
    setMetadataError(null);
    setPublicRepoMeta(null);
    setPublicRateLimited(false);
    setPublicMetaError(null);
    setNewEntry(null);
    setActiveId(null);
    setDoc(null);
    setRepoMeta(null);
    setAccessState('unknown');
    setNotesRepoStatus(makeNotesRepoStatus());
    setNotesRepoRefresh((tick) => tick + 1);
    initialPullRef.done = false;
    setSyncMsg('Signed out');
  };

  const onSyncNow = async () => {
    try {
      setSyncMsg(null);
      setSyncing(true);
      if (!sessionToken || !linked || slug === 'new' || !canEdit) {
        setSyncMsg('Connect GitHub and configure repo first');
        return;
      }
      const summary = await syncBidirectional(store, slug);
      recordAutoSyncRun(slug);
      const parts: string[] = [];
      if (summary.pulled) parts.push(`pulled ${summary.pulled}`);
      if (summary.merged) parts.push(`merged ${summary.merged}`);
      if (summary.pushed) parts.push(`pushed ${summary.pushed}`);
      if (summary.deletedRemote) parts.push(`deleted remote ${summary.deletedRemote}`);
      if (summary.deletedLocal) parts.push(`deleted local ${summary.deletedLocal}`);
      setSyncMsg(parts.length ? `Synced: ${parts.join(', ')}` : 'Up to date');
    } catch (err) {
      console.error(err);
      setSyncMsg('Sync failed');
    } finally {
      setSyncing(false);
      setNotes(store.listNotes());
      // Ensure the active editor reflects merged/pulled text
      setDoc(activeId ? store.loadNote(activeId) : null);
    }
  };

  const isRepoUnreachable =
    route.kind === 'repo' && accessState === 'unreachable' && !isPublicReadonly && !needsInstallForPrivate;
  const showSidebar =
    isScratchpad || (notes.length > 0 && linked) || (isPublicReadonly && readOnlyNotes.length > 0);
  const layoutClass = showSidebar ? (isRepoUnreachable ? 'single' : '') : 'single';
  const noteList = isPublicReadonly ? readOnlyNotes : notes;
  const folderList = useMemo(() => {
    if (isPublicReadonly) {
      const set = new Set<string>();
      for (const note of readOnlyNotes) {
        if (note.dir) set.add(note.dir);
      }
      return Array.from(set).sort();
    }
    return folders;
  }, [folders, isPublicReadonly, readOnlyNotes]);
  const onboardingConnectDone = !!sessionToken;
  const onboardingRepoLoading = notesRepoStatus.loading;
  const onboardingRepoAccessible = onboardingConnectDone && notesRepoStatus.accessible;
  const onboardingRepoExists = onboardingConnectDone && notesRepoStatus.exists;
  const onboardingRepoSeeded = onboardingRepoAccessible && !!notesRepoStatus.defaultBranch;
  const repoStatusError = !onboardingRepoAccessible && notesRepoStatus.error ? notesRepoStatus.error : null;
  const seedError =
    onboardingRepoAccessible && !onboardingRepoSeeded && notesRepoStatus.error ? notesRepoStatus.error : null;
  const createRepoUrl = 'https://github.com/new?name=notes&visibility=private';

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
                className={`btn ghost repo-btn`}
                onClick={ensureOwnerAndOpen}
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
            <button
              type="button"
              className="btn ghost repo-btn align-workspace repo-btn-empty"
              onClick={() => ensureOwnerAndOpen()}
              title="Choose repository"
            >
              <GitHubIcon />
              <span className="repo-label">
                {recommendedRepoOwner && recommendedRepoName ? (
                  <>
                    <span className="repo-owner">{recommendedRepoOwner}/</span>
                    <span>{recommendedRepoName}</span>
                  </>
                ) : (
                  <span>Choose repository</span>
                )}
              </span>
            </button>
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
              {linked && !isRepoUnreachable && canEdit && (
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
              {user ? (
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
              ) : (
                <button className="btn secondary" onClick={onConnect}>
                  Refresh GitHub login
                </button>
              )}
            </>
          )}
        </div>
      </header>
      <div className={`app-layout ${layoutClass}`}>
        {isRepoUnreachable ? (
          <section className="workspace" style={{ width: '100%' }}>
            <div className="workspace-body">
              <div className="empty-state">
                <h2>Can’t access this repository</h2>
                <p>
                  You don’t have permission to view{' '}
                  <strong>{route.kind === 'repo' ? `${route.owner}/${route.repo}` : ''}</strong> with the
                  current GitHub device token.
                </p>
                <p>
                  Sign out and sign in with a token that has access, or switch to a different repository from
                  the header.
                </p>
              </div>
            </div>
          </section>
        ) : (
          <>
            {showSidebar && (
              <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
                <div className="sidebar-header">
                  <div className="sidebar-title">
                    <div className="sidebar-title-main">
                      <span>Notes</span>
                      <span className="note-count">{noteList.length}</span>
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
                {canEdit && (
                  <div className="sidebar-actions">
                    <button className="btn primary" onClick={onCreate}>
                      New note
                    </button>
                    <button
                      className="btn secondary"
                      onClick={() => {
                        let parentDir = '';
                        if (selection?.kind === 'folder') parentDir = selection.dir;
                        if (selection?.kind === 'file') {
                          let n = noteList.find((x) => x.id === selection.id);
                          if (n) parentDir = (n.dir as string) || '';
                        }
                        onCreateFolder(parentDir);
                      }}
                    >
                      New folder
                    </button>
                  </div>
                )}
                <div className="sidebar-body">
                  <FileTree
                    files={
                      noteList.map((n) => ({
                        id: n.id,
                        name: n.title || 'Untitled',
                        path: n.path,
                        dir: (n.dir as string) || '',
                      })) as FileEntry[]
                    }
                    folders={folderList}
                    activeId={activeId}
                    collapsed={collapsedFolders}
                    onCollapsedChange={(next) =>
                      setCollapsedFoldersState((prev) =>
                        collapsedMapsEqual(prev, next) ? prev : syncCollapsedWithFolders(next, folders)
                      )
                    }
                    onSelectionChange={(sel) => setSelection(sel as any)}
                    onSelectFile={(id) => {
                      if (!canEdit) {
                        setActiveId(id);
                        setSidebarOpen(false);
                        const entry = readOnlyNotes.find((n) => n.id === id);
                        if (!entry) return;
                        const cfg = buildConfigWithMeta();
                        void (async () => {
                          try {
                            const remote = await pullNote(cfg, entry.path);
                            if (!remote) return;
                            setDoc({
                              id: entry.id,
                              path: entry.path,
                              title: entry.title,
                              dir: entry.dir,
                              text: remote.text,
                              updatedAt: Date.now(),
                              lastRemoteSha: remote.sha,
                              lastSyncedHash: hashText(remote.text),
                            });
                          } catch (e) {
                            console.error(e);
                          }
                        })();
                        return;
                      }
                      setActiveId(id);
                      setSidebarOpen(false);
                    }}
                    onRenameFile={canEdit ? onRename : () => undefined}
                    onDeleteFile={canEdit ? onDelete : () => undefined}
                    onCreateFile={
                      canEdit
                        ? (dir, name) => {
                            let id = store.createNote(name, '', dir);
                            setNotes(store.listNotes());
                            setFolders(store.listFolders());
                            setActiveId(id);
                            scheduleAutoSync();
                            return id;
                          }
                        : () => undefined
                    }
                    onCreateFolder={
                      canEdit
                        ? (parentDir, name) => {
                            try {
                              store.createFolder(parentDir, name);
                              setFolders(store.listFolders());
                            } catch (e) {
                              console.error(e);
                              setSyncMsg('Invalid folder name.');
                            }
                          }
                        : () => undefined
                    }
                    onRenameFolder={canEdit ? onRenameFolder : () => undefined}
                    onDeleteFolder={canEdit ? onDeleteFolder : () => undefined}
                    newEntry={canEdit ? newEntry : null}
                    onFinishCreate={() => canEdit && setNewEntry(null)}
                  />
                </div>
                {route.kind === 'repo' && linked && canEdit ? (
                  <div className="repo-autosync-toggle">
                    <Toggle
                      checked={autosync}
                      onChange={(enabled) => {
                        setAutosync(enabled);
                        setAutosyncEnabled(slug, enabled);
                        if (enabled) scheduleAutoSync(0);
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
                        {route.owner}/{route.repo}{' '}
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
                    {isScratchpad ? (
                      <div className="onboarding-banner">
                        <div className="onboarding-header">
                          <h3>Get your notes repo ready</h3>
                          <p>
                            Complete the checklist to move your local notes into GitHub and start syncing with
                            VibeNote.
                          </p>
                        </div>
                        <ol className="onboarding-steps">
                          <li className={`onboarding-step ${onboardingConnectDone ? 'done' : ''}`}>
                            <div className="onboarding-step-main">
                              <div className="onboarding-step-title">Connect GitHub</div>
                              <p className="onboarding-step-desc">
                                Sign in with your GitHub account so VibeNote can link your repository.
                              </p>
                            </div>
                            {onboardingConnectDone ? (
                              <span className="onboarding-step-status">
                                Connected as @{user?.login ?? ownerLogin ?? 'you'}
                              </span>
                            ) : (
                              <button className="btn primary" onClick={onConnect}>
                                Connect GitHub
                              </button>
                            )}
                          </li>
                          <li className={`onboarding-step ${onboardingRepoAccessible ? 'done' : ''}`}>
                            <div className="onboarding-step-main">
                              <div className="onboarding-step-title">Create your notes repository</div>
                              <p className="onboarding-step-desc">
                                We recommend a private repository named <code>{recommendedRepoName ?? 'notes'}</code>.
                              </p>
                            </div>
                            <div className="onboarding-step-actions">
                              {!onboardingConnectDone ? (
                                <p className="onboarding-step-hint">Connect GitHub to create your repository.</p>
                              ) : onboardingRepoLoading ? (
                                <p className="onboarding-step-hint">Checking repository…</p>
                              ) : onboardingRepoAccessible ? (
                                <span className="onboarding-step-status">
                                  Ready: {recommendedRepoSlug ?? 'notes'}
                                </span>
                              ) : onboardingRepoExists ? (
                                notesRepoStatus.manageUrl ? (
                                  <a
                                    className="btn secondary"
                                    href={notesRepoStatus.manageUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Grant access on GitHub
                                  </a>
                                ) : (
                                  <p className="onboarding-step-hint">
                                    Open GitHub to allow the VibeNote app to access {recommendedRepoSlug ?? 'your repo'}.
                                  </p>
                                )
                              ) : (
                                <a className="btn secondary" href={createRepoUrl} target="_blank" rel="noreferrer">
                                  Create on GitHub
                                </a>
                              )}
                              {repoStatusError ? (
                                <p className="onboarding-step-error">{repoStatusError}</p>
                              ) : null}
                            </div>
                          </li>
                          <li className={`onboarding-step ${onboardingRepoSeeded ? 'done' : ''}`}>
                            <div className="onboarding-step-main">
                              <div className="onboarding-step-title">Make the first commit</div>
                              <p className="onboarding-step-desc">
                                Seed the repository with your current local notes and a README.
                              </p>
                            </div>
                            <div className="onboarding-step-actions">
                              {!onboardingRepoAccessible ? (
                                <p className="onboarding-step-hint">Finish the steps above to enable syncing.</p>
                              ) : onboardingRepoSeeded ? (
                                <span className="onboarding-step-status">Repository seeded</span>
                              ) : (
                                <button
                                  className="btn primary"
                                  onClick={onSeedNotesRepo}
                                  disabled={seedingNotesRepo || onboardingRepoLoading}
                                >
                                  {seedingNotesRepo ? 'Seeding…' : 'Make first commit'}
                                </button>
                              )}
                              {seedError ? <p className="onboarding-step-error">{seedError}</p> : null}
                            </div>
                          </li>
                        </ol>
                      </div>
                    ) : null}
                    {metadataError && (
                      <div className="alert warning">
                        <span className="badge">Offline</span>
                        <span className="alert-text">
                          Could not reach GitHub. You can still edit notes offline.
                        </span>
                      </div>
                    )}
                    {metadataError == null && isRateLimited && (
                      <div className="alert warning">
                        <span className="badge">Limited</span>
                        <span className="alert-text">
                          GitHub rate limits temporarily prevent checking repository access. Public
                          repositories remain viewable; retry shortly for private access checks.
                        </span>
                      </div>
                    )}
                    {isPublicReadonly && (
                      <div className="alert">
                        <span className="badge">Read-only</span>
                        <span className="alert-text">
                          You can view, but not edit files in this repository.
                        </span>
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
                          readOnly={isPublicReadonly || needsInstallForPrivate || !canEdit}
                          onChange={(id, text) => {
                            store.saveNote(id, text);
                            scheduleAutoSync();
                          }}
                        />
                      </div>
                    ) : isPublicReadonly ? (
                      <div className="empty-state">
                        <h2>Browse on GitHub to view files</h2>
                        <p>This repository has no notes cached locally yet.</p>
                        <p>
                          Open the repository on GitHub or select a file from the sidebar to load it in
                          VibeNote.
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
                        {syncMsg && <p className="empty-state-status">{syncMsg}</p>}
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
          </>
        )}
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
      {toast && (
        <div className="toast">
          <span>{toast.text}</span>
          {toast.href && (
            <a className="btn subtle" href={toast.href} target="_blank" rel="noreferrer">
              Open
            </a>
          )}
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

function syncCollapsedWithFolders(
  current: Record<string, boolean>,
  folders: string[]
): Record<string, boolean> {
  let expanded: string[] = [];
  for (let dir in current) {
    if (!Object.prototype.hasOwnProperty.call(current, dir)) continue;
    if (dir === '') continue;
    if (current[dir] === false) expanded.push(dir);
  }
  return buildCollapsedMap(expanded, folders);
}

function collapsedMapsEqual(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  let keysA = Object.keys(a);
  let keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (let key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
