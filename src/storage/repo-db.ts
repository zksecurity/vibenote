// IndexedDB persistence layer for Git-shaped repo state.
// Separates large binary content (file blobs, conflict payloads) from
// JSON-like metadata across four object stores so metadata reads stay fast
// even when repos contain large files.
//
// Public entry point: createRepoDb(name?) → RepoDb
// Each repo is isolated by its repoId string (e.g. "owner/repo").

import type {
  RepoState,
  WorkingFile,
  WorkingFileMeta,
  Path,
  GitSha,
  FileMode,
  FileStatus,
  IndexStage,
  ConflictPayload,
  SnapshotEntry,
  StatusEntry,
  IndexEntry,
} from './repo-types';

export type { RepoDb };
export { createRepoDb };

// --- Public API surface ---

/** Async API for reading and writing Git-shaped repo state to IndexedDB. */
type RepoDb = {
  /** Save (or overwrite) the full repo state, including all file contents. */
  saveRepoState: (state: RepoState) => Promise<void>;
  /** Load the full repo state, or undefined if not found. */
  loadRepoState: (repoId: string) => Promise<RepoState | undefined>;
  /** Delete all stored data for a repo (state, file content, conflicts). */
  deleteRepo: (repoId: string) => Promise<void>;
  /** List all repo IDs that have stored state. */
  listRepoIds: () => Promise<string[]>;
  /** Save (or overwrite) a single working file's content and metadata. */
  saveWorkingFile: (repoId: string, file: WorkingFile) => Promise<void>;
  /** Load a single working file with content, or undefined if not found. */
  loadWorkingFile: (repoId: string, path: Path) => Promise<WorkingFile | undefined>;
  /** Delete a single working file from the working tree. */
  deleteWorkingFile: (repoId: string, path: Path) => Promise<void>;
  /** List metadata for all working files without loading content. */
  listWorkingFilesMeta: (repoId: string) => Promise<WorkingFileMeta[]>;
  /** Close the underlying IDBDatabase connection. */
  close: () => void;
};

// --- DB schema constants ---

const DB_VERSION = 1;
// JSON-like repo metadata (snapshots, branch, index, status, merge, config)
const STORE_META = 'repo-state';
// Working file metadata without content (path, mode, size, mtime, blobSha)
const STORE_FILE_META = 'file-meta';
// Working file binary content, separated for fast metadata-only reads
const STORE_FILES = 'file-content';
// Conflict payloads (base/ours/theirs Uint8Arrays), separated from metadata
const STORE_CONFLICTS = 'conflict-content';

const ALL_STORES = [STORE_META, STORE_FILE_META, STORE_FILES, STORE_CONFLICTS] as const;

// --- Factory ---

/**
 * Open an IndexedDB-backed RepoDb with the given name.
 * Pass a unique name per test for isolation (each name is a separate IDB database).
 */
async function createRepoDb(name = 'vibenote-repo-db'): Promise<RepoDb> {
  const db = await openIdbDatabase(name);
  return {
    saveRepoState: (state) => saveRepoStateToDb(db, state),
    loadRepoState: (repoId) => loadRepoStateFromDb(db, repoId),
    deleteRepo: (repoId) => deleteRepoFromDb(db, repoId),
    listRepoIds: () => listRepoIdsFromDb(db),
    saveWorkingFile: (repoId, file) => saveWorkingFileToDb(db, repoId, file),
    loadWorkingFile: (repoId, path) => loadWorkingFileFromDb(db, repoId, path),
    deleteWorkingFile: (repoId, path) => deleteWorkingFileFromDb(db, repoId, path),
    listWorkingFilesMeta: (repoId) => listWorkingFilesMetaFromDb(db, repoId),
    close: () => db.close(),
  };
}

// --- Internal serialized types (stored in IndexedDB) ---

// Flat snapshot entry as stored: plain strings (no branded types).
type StoredSnapshotEntry = { mode: string; sha: string };

type StoredSnapshot = {
  rootTree: string;
  entries: [string, StoredSnapshotEntry][];
  // baseCommit / remoteCommit overlap — only one is present per snapshot kind
  baseCommit?: string | null;
  remoteCommit?: string | null;
};

// Full repo metadata stored in STORE_META; no working file content or conflict Uint8Arrays.
type StoredRepoMeta = {
  repoId: string;
  remote: { name: string; url: string };
  branch: {
    head: { name: string; sha: string | null };
    upstream?: { name: string; sha: string | null };
  };
  base: StoredSnapshot;
  remoteSnapshot: StoredSnapshot;
  // index entries as [path, entries[]] pairs
  indexEntries: [string, { path: string; mode: string; stage: number; sha: string }[]][];
  // status as [path, entry] pairs
  status: [string, { path: string; status: string; mode?: string; headSha?: string; indexSha?: string; worktreeSha?: string }][];
  // merge: conflicted paths as strings; conflict Uint8Arrays live in STORE_CONFLICTS
  merge: { inProgress: boolean; targetCommit?: string; conflictedPaths: string[] };
  ignore: { patterns: string[] };
  config: { eol?: string; caseSensitive?: boolean; enableRenameDetect?: boolean };
  // hash cache entries as [key, sha] pairs
  hashCacheEntries: [string, string][];
  version: number;
  locks?: { sync: boolean; index: boolean };
};

// Stored in STORE_FILE_META — working file metadata without content.
type StoredFileMeta = {
  repoId: string;
  path: string;
  mode: string;
  size: number;
  mtime?: number;
  blobSha?: string;
};

// Stored in STORE_FILES — working file binary content.
type StoredFileContent = {
  repoId: string;
  path: string;
  content: Uint8Array;
};

// Stored in STORE_CONFLICTS — three-way merge conflict payloads.
type StoredConflict = {
  repoId: string;
  path: string;
  base?: Uint8Array;
  ours?: Uint8Array;
  theirs?: Uint8Array;
};

// --- saveRepoState ---

function saveRepoStateToDb(db: IDBDatabase, state: RepoState): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(Array.from(ALL_STORES), 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(new Error('IDB transaction aborted'));

    // Save JSON-like metadata (no Uint8Arrays)
    tx.objectStore(STORE_META).put(serializeRepoMeta(state));

    // Extract working file metadata and content for separate stores
    const fileMetas: StoredFileMeta[] = [];
    const fileContents: StoredFileContent[] = [];
    for (const [, file] of state.workingFiles) {
      fileMetas.push({
        repoId: state.repoId,
        path: file.path,
        mode: file.mode,
        size: file.size,
        mtime: file.mtime,
        blobSha: file.blobSha,
      });
      fileContents.push({ repoId: state.repoId, path: file.path, content: file.content });
    }

    // Extract conflict payloads
    const conflictData: StoredConflict[] = [];
    if (state.merge.conflicts !== undefined) {
      for (const [path, payload] of state.merge.conflicts) {
        conflictData.push({ repoId: state.repoId, path, base: payload.base, ours: payload.ours, theirs: payload.theirs });
      }
    }

    // Clear old entries for this repo in all three content stores, then write new ones.
    // Uses a counter to wait for all three cursors before writing.
    let cleared = 0;
    const afterClear = () => {
      cleared++;
      if (cleared < 3) return;
      for (const m of fileMetas) tx.objectStore(STORE_FILE_META).put(m);
      for (const f of fileContents) tx.objectStore(STORE_FILES).put(f);
      for (const c of conflictData) tx.objectStore(STORE_CONFLICTS).put(c);
    };

    clearByRepo(tx.objectStore(STORE_FILE_META), state.repoId, afterClear);
    clearByRepo(tx.objectStore(STORE_FILES), state.repoId, afterClear);
    clearByRepo(tx.objectStore(STORE_CONFLICTS), state.repoId, afterClear);
  });
}

// --- loadRepoState ---

function loadRepoStateFromDb(db: IDBDatabase, repoId: string): Promise<RepoState | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(Array.from(ALL_STORES), 'readonly');
    tx.onerror = () => reject(tx.error);

    let storedMeta: StoredRepoMeta | undefined;
    let fileMetas: StoredFileMeta[] = [];
    let fileContents: StoredFileContent[] = [];
    let conflicts: StoredConflict[] = [];
    // Wait for: 1 get + 3 cursor scans
    let pending = 4;

    const done = () => {
      pending--;
      if (pending > 0) return;
      if (storedMeta === undefined) {
        resolve(undefined);
        return;
      }
      try {
        const contentMap = new Map<string, Uint8Array>(fileContents.map((f) => [f.path, f.content]));
        const conflictMap = new Map<string, StoredConflict>(conflicts.map((c) => [c.path, c]));
        resolve(deserializeRepoState(storedMeta, fileMetas, contentMap, conflictMap));
      } catch (e) {
        reject(e);
      }
    };

    // 1. Repo metadata
    const metaReq = tx.objectStore(STORE_META).get(repoId);
    metaReq.onsuccess = () => {
      storedMeta = metaReq.result;
      done();
    };
    metaReq.onerror = () => reject(metaReq.error);

    // 2. Working file metadata
    collectByRepo<StoredFileMeta>(tx.objectStore(STORE_FILE_META), repoId, (items) => {
      fileMetas = items;
      done();
    });

    // 3. Working file content
    collectByRepo<StoredFileContent>(tx.objectStore(STORE_FILES), repoId, (items) => {
      fileContents = items;
      done();
    });

    // 4. Conflict payloads
    collectByRepo<StoredConflict>(tx.objectStore(STORE_CONFLICTS), repoId, (items) => {
      conflicts = items;
      done();
    });
  });
}

// --- deleteRepo ---

function deleteRepoFromDb(db: IDBDatabase, repoId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(Array.from(ALL_STORES), 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(new Error('IDB transaction aborted'));

    tx.objectStore(STORE_META).delete(repoId);
    clearByRepo(tx.objectStore(STORE_FILE_META), repoId, () => {});
    clearByRepo(tx.objectStore(STORE_FILES), repoId, () => {});
    clearByRepo(tx.objectStore(STORE_CONFLICTS), repoId, () => {});
  });
}

// --- listRepoIds ---

function listRepoIdsFromDb(db: IDBDatabase): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_META], 'readonly');
    const req = tx.objectStore(STORE_META).getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error);
  });
}

// --- Individual file operations ---

function saveWorkingFileToDb(db: IDBDatabase, repoId: string, file: WorkingFile): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_FILE_META, STORE_FILES], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(new Error('IDB transaction aborted'));

    tx.objectStore(STORE_FILE_META).put({
      repoId,
      path: file.path,
      mode: file.mode,
      size: file.size,
      mtime: file.mtime,
      blobSha: file.blobSha,
    } satisfies StoredFileMeta);

    tx.objectStore(STORE_FILES).put({
      repoId,
      path: file.path,
      content: file.content,
    } satisfies StoredFileContent);
  });
}

function loadWorkingFileFromDb(db: IDBDatabase, repoId: string, path: Path): Promise<WorkingFile | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_FILE_META, STORE_FILES], 'readonly');
    tx.onerror = () => reject(tx.error);

    let meta: StoredFileMeta | undefined;
    let contentEntry: StoredFileContent | undefined;
    let pending = 2;

    const done = () => {
      pending--;
      if (pending > 0) return;
      if (meta === undefined) {
        resolve(undefined);
        return;
      }
      const content = contentEntry?.content ?? new Uint8Array(0);
      resolve(deserializeWorkingFile(meta, content));
    };

    const key = [repoId, path] as IDBValidKey;

    const metaReq = tx.objectStore(STORE_FILE_META).get(key);
    metaReq.onsuccess = () => {
      meta = metaReq.result;
      done();
    };
    metaReq.onerror = () => reject(metaReq.error);

    const contentReq = tx.objectStore(STORE_FILES).get(key);
    contentReq.onsuccess = () => {
      contentEntry = contentReq.result;
      done();
    };
    contentReq.onerror = () => reject(contentReq.error);
  });
}

function deleteWorkingFileFromDb(db: IDBDatabase, repoId: string, path: Path): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_FILE_META, STORE_FILES], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(new Error('IDB transaction aborted'));

    const key = [repoId, path] as IDBValidKey;
    tx.objectStore(STORE_FILE_META).delete(key);
    tx.objectStore(STORE_FILES).delete(key);
  });
}

function listWorkingFilesMetaFromDb(db: IDBDatabase, repoId: string): Promise<WorkingFileMeta[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_FILE_META], 'readonly');
    tx.onerror = () => reject(tx.error);

    collectByRepo<StoredFileMeta>(tx.objectStore(STORE_FILE_META), repoId, (items) => {
      resolve(items.map((m) => deserializeWorkingFileMeta(m)));
    });
  });
}

// --- Serialization ---

function serializeRepoMeta(state: RepoState): StoredRepoMeta {
  return {
    repoId: state.repoId,
    remote: { name: state.remote.name, url: state.remote.url },
    branch: {
      head: { name: state.branch.head.name, sha: state.branch.head.sha },
      upstream:
        state.branch.upstream !== undefined
          ? { name: state.branch.upstream.name, sha: state.branch.upstream.sha }
          : undefined,
    },
    base: {
      rootTree: state.base.rootTree,
      entries: Array.from(state.base.entries.entries()).map(([p, e]) => [p, { mode: e.mode, sha: e.sha }]),
      baseCommit: state.base.baseCommit,
    },
    remoteSnapshot: {
      rootTree: state.remoteSnapshot.rootTree,
      entries: Array.from(state.remoteSnapshot.entries.entries()).map(([p, e]) => [p, { mode: e.mode, sha: e.sha }]),
      remoteCommit: state.remoteSnapshot.remoteCommit,
    },
    indexEntries: Array.from(state.index.entries.entries()).map(([p, entries]) => [
      p,
      entries.map((e) => ({ path: e.path, mode: e.mode, stage: e.stage, sha: e.sha })),
    ]),
    status: Array.from(state.status.entries()).map(([p, s]) => [
      p,
      {
        path: s.path,
        status: s.status,
        mode: s.mode,
        headSha: s.headSha,
        indexSha: s.indexSha,
        worktreeSha: s.worktreeSha,
      },
    ]),
    merge: {
      inProgress: state.merge.inProgress,
      targetCommit: state.merge.targetCommit,
      // conflictedPaths is a Set<Path>; store as plain string array
      conflictedPaths: Array.from(state.merge.conflictedPaths),
    },
    ignore: { patterns: state.ignore.patterns },
    config: { eol: state.config.eol, caseSensitive: state.config.caseSensitive, enableRenameDetect: state.config.enableRenameDetect },
    hashCacheEntries: Array.from(state.hashCache.entries.entries()),
    version: state.version,
    locks: state.locks,
  };
}

// --- Deserialization ---

function deserializeRepoState(
  stored: StoredRepoMeta,
  fileMetas: StoredFileMeta[],
  contentMap: Map<string, Uint8Array>,
  conflictMap: Map<string, StoredConflict>
): RepoState {
  // Reconstruct snapshot entries
  let baseEntries = new Map<Path, SnapshotEntry>();
  for (const [p, e] of stored.base.entries) {
    baseEntries.set(toPath(p), { mode: parseFileMode(e.mode), sha: toGitSha(e.sha) });
  }

  let remoteEntries = new Map<Path, SnapshotEntry>();
  for (const [p, e] of stored.remoteSnapshot.entries) {
    remoteEntries.set(toPath(p), { mode: parseFileMode(e.mode), sha: toGitSha(e.sha) });
  }

  // Reconstruct working files, joining metadata with content
  let workingFiles = new Map<Path, WorkingFile>();
  for (const meta of fileMetas) {
    const p = toPath(meta.path);
    const content = contentMap.get(meta.path) ?? new Uint8Array(0);
    workingFiles.set(p, deserializeWorkingFile(meta, content));
  }

  // Reconstruct index
  let indexEntries = new Map<Path, IndexEntry[]>();
  for (const [p, entries] of stored.indexEntries) {
    indexEntries.set(
      toPath(p),
      entries.map((e) => ({
        path: toPath(e.path),
        mode: parseFileMode(e.mode),
        stage: parseIndexStage(e.stage),
        sha: toGitSha(e.sha),
      }))
    );
  }

  // Reconstruct status
  let status = new Map<Path, StatusEntry>();
  for (const [p, s] of stored.status) {
    const path = toPath(p);
    status.set(path, {
      path,
      status: parseFileStatus(s.status),
      mode: s.mode !== undefined ? parseFileMode(s.mode) : undefined,
      headSha: s.headSha !== undefined ? toGitSha(s.headSha) : undefined,
      indexSha: s.indexSha !== undefined ? toGitSha(s.indexSha) : undefined,
      worktreeSha: s.worktreeSha !== undefined ? toGitSha(s.worktreeSha) : undefined,
    });
  }

  // Reconstruct merge state
  let conflictedPaths = new Set<Path>(stored.merge.conflictedPaths.map(toPath));
  let conflicts: Map<Path, ConflictPayload> | undefined;
  if (conflictMap.size > 0) {
    conflicts = new Map<Path, ConflictPayload>();
    for (const [p, c] of conflictMap) {
      conflicts.set(toPath(p), { base: c.base, ours: c.ours, theirs: c.theirs });
    }
  }

  // Reconstruct hash cache
  let hashCacheEntries = new Map<string, GitSha>();
  for (const [key, sha] of stored.hashCacheEntries) {
    hashCacheEntries.set(key, toGitSha(sha));
  }

  return {
    repoId: stored.repoId,
    remote: { name: stored.remote.name, url: stored.remote.url },
    branch: {
      head: {
        name: parseRefName(stored.branch.head.name),
        sha: stored.branch.head.sha !== null ? toGitSha(stored.branch.head.sha) : null,
      },
      upstream:
        stored.branch.upstream !== undefined
          ? {
              name: parseRemoteRefName(stored.branch.upstream.name),
              sha: stored.branch.upstream.sha !== null ? toGitSha(stored.branch.upstream.sha) : null,
            }
          : undefined,
    },
    base: {
      rootTree: toGitSha(stored.base.rootTree),
      entries: baseEntries,
      baseCommit: stored.base.baseCommit !== null && stored.base.baseCommit !== undefined ? toGitSha(stored.base.baseCommit) : null,
    },
    remoteSnapshot: {
      rootTree: toGitSha(stored.remoteSnapshot.rootTree),
      entries: remoteEntries,
      remoteCommit:
        stored.remoteSnapshot.remoteCommit !== null && stored.remoteSnapshot.remoteCommit !== undefined
          ? toGitSha(stored.remoteSnapshot.remoteCommit)
          : null,
    },
    workingFiles,
    index: { entries: indexEntries },
    status,
    merge: {
      inProgress: stored.merge.inProgress,
      targetCommit: stored.merge.targetCommit !== undefined ? toGitSha(stored.merge.targetCommit) : undefined,
      conflictedPaths,
      conflicts,
    },
    ignore: { patterns: stored.ignore.patterns },
    config: {
      eol: stored.config.eol as RepoState['config']['eol'],
      caseSensitive: stored.config.caseSensitive,
      enableRenameDetect: stored.config.enableRenameDetect,
    },
    hashCache: { entries: hashCacheEntries },
    version: stored.version,
    locks: stored.locks,
  };
}

function deserializeWorkingFile(meta: StoredFileMeta, content: Uint8Array): WorkingFile {
  return {
    path: toPath(meta.path),
    mode: parseWorkingFileMode(meta.mode),
    content,
    size: meta.size,
    mtime: meta.mtime,
    blobSha: meta.blobSha !== undefined ? toGitSha(meta.blobSha) : undefined,
  };
}

function deserializeWorkingFileMeta(meta: StoredFileMeta): WorkingFileMeta {
  return {
    path: toPath(meta.path),
    mode: parseWorkingFileMode(meta.mode),
    size: meta.size,
    mtime: meta.mtime,
    blobSha: meta.blobSha !== undefined ? toGitSha(meta.blobSha) : undefined,
  };
}

// --- Validation / parsing helpers ---
// These use exhaustive checks so TypeScript can narrow to the correct literal type
// without needing an `as` cast. Throws on invalid stored data.

function parseFileMode(s: string): FileMode {
  if (s === '100644' || s === '100755' || s === '120000' || s === '040000') return s;
  throw new Error(`Invalid FileMode in storage: ${s}`);
}

function parseWorkingFileMode(s: string): Exclude<FileMode, '040000'> {
  if (s === '100644' || s === '100755' || s === '120000') return s;
  throw new Error(`Invalid working file mode in storage: ${s}`);
}

function parseFileStatus(s: string): FileStatus {
  if (
    s === 'unmodified' ||
    s === 'modified' ||
    s === 'added' ||
    s === 'deleted' ||
    s === 'untracked' ||
    s === 'conflicted'
  )
    return s;
  throw new Error(`Invalid FileStatus in storage: ${s}`);
}

function parseIndexStage(n: number): IndexStage {
  if (n === 0 || n === 1 || n === 2 || n === 3) return n;
  throw new Error(`Invalid IndexStage in storage: ${n}`);
}

// Template literal types can't be narrowed from startsWith(), so we validate
// and then use `as`. The runtime check ensures the data is correct.
function parseRefName(s: string): `refs/heads/${string}` | `refs/tags/${string}` {
  if (s.startsWith('refs/heads/') || s.startsWith('refs/tags/')) {
    return s as `refs/heads/${string}` | `refs/tags/${string}`;
  }
  throw new Error(`Invalid ref name in storage: ${s}`);
}

function parseRemoteRefName(s: string): `refs/remotes/${string}/${string}` {
  if (s.startsWith('refs/remotes/')) {
    return s as `refs/remotes/${string}/${string}`;
  }
  throw new Error(`Invalid remote ref name in storage: ${s}`);
}

// Phantom brand constructors — safe because GitSha/Path are compile-time-only brands.
function toGitSha(s: string): GitSha {
  return s as GitSha;
}

function toPath(s: string): Path {
  return s as Path;
}

// --- IDB utility helpers ---

/** Opens and upgrades the IndexedDB database, creating stores on first run. */
function openIdbDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (event.oldVersion < 1) {
        // Repo-level JSON metadata (no large binaries)
        db.createObjectStore(STORE_META, { keyPath: 'repoId' });

        // Working file metadata — compound key [repoId, path]
        const fileMetaStore = db.createObjectStore(STORE_FILE_META, { keyPath: ['repoId', 'path'] });
        fileMetaStore.createIndex('by-repo', 'repoId');

        // Working file content — compound key [repoId, path]
        const filesStore = db.createObjectStore(STORE_FILES, { keyPath: ['repoId', 'path'] });
        filesStore.createIndex('by-repo', 'repoId');

        // Conflict payloads — compound key [repoId, path]
        const conflictsStore = db.createObjectStore(STORE_CONFLICTS, { keyPath: ['repoId', 'path'] });
        conflictsStore.createIndex('by-repo', 'repoId');
      }
    };
  });
}

/**
 * Deletes all records for a repoId from an object store that has a 'by-repo' index.
 * Calls `onDone` synchronously after queuing all deletes (within the same transaction).
 */
function clearByRepo(store: IDBObjectStore, repoId: string, onDone: () => void): void {
  const range = IDBKeyRange.only(repoId);
  const req = store.index('by-repo').openCursor(range);
  req.onsuccess = () => {
    const cursor = req.result;
    if (cursor !== null) {
      cursor.delete();
      cursor.continue();
    } else {
      onDone();
    }
  };
}

/**
 * Collects all records for a repoId from an object store via the 'by-repo' index.
 * Calls `onDone` with the full array when the cursor is exhausted.
 */
function collectByRepo<T>(store: IDBObjectStore, repoId: string, onDone: (items: T[]) => void): void {
  const range = IDBKeyRange.only(repoId);
  const req = store.index('by-repo').openCursor(range);
  const items: T[] = [];
  req.onsuccess = () => {
    const cursor = req.result;
    if (cursor !== null) {
      items.push(cursor.value as T);
      cursor.continue();
    } else {
      onDone(items);
    }
  };
}
