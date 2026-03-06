// Canonical TypeScript types for the Git-shaped repo state model.
// Follows the design documented in docs/vibenote-git-sync-design.md.
// These types are used by the IndexedDB storage layer (repo-db.ts) and
// will eventually replace the localStorage-based local.ts layer.

export type {
  GitSha,
  Path,
  FileMode,
  SnapshotEntry,
  TreeSnapshot,
  BaseSnapshot,
  RemoteSnapshot,
  WorkingFile,
  WorkingFileMeta,
  IndexStage,
  IndexEntry,
  IndexState,
  FileStatus,
  StatusEntry,
  ConflictPayload,
  MergeState,
  Ref,
  RemoteRef,
  RemoteConfig,
  BranchState,
  Signature,
  PendingCommit,
  HashCache,
  IgnoreRules,
  RepoConfig,
  RepoState,
};

// --- Core opaque branded types ---

/**
 * A Git object SHA-1 hash (40 hex chars).
 * Branded to prevent mixing with arbitrary strings.
 */
type GitSha = string & { readonly __brand: 'GitSha' };

/**
 * A repo-relative file path (e.g. "notes/journal.md").
 * Branded for type safety; always forward-slash separated, no leading slash.
 */
type Path = string & { readonly __brand: 'Path' };

/**
 * Git file mode string.
 * 100644 = regular file, 100755 = executable, 120000 = symlink, 040000 = directory (tree).
 */
type FileMode = '100644' | '100755' | '120000' | '040000';

// --- Tree snapshots ---

/** A single entry in a flat tree snapshot: mode + SHA of the blob or subtree. */
type SnapshotEntry = {
  mode: FileMode;
  sha: GitSha;
};

/**
 * A recursive flat path-map snapshot of a Git tree, equivalent to `git ls-tree -r`.
 * Flat maps are preferred over nested trees for easier diffing, merging, and dirty detection.
 */
type TreeSnapshot = {
  /** Root tree object SHA. */
  rootTree: GitSha;
  /** Flat map of all repo-relative paths → entries. */
  entries: Map<Path, SnapshotEntry>;
};

/**
 * The BASE snapshot: last commit/tree that local state was synced against.
 * Serves as the merge base in the three-way Sync.
 */
type BaseSnapshot = TreeSnapshot & {
  /** Last synced commit SHA. null means no sync has occurred yet. */
  baseCommit: GitSha | null;
};

/**
 * The REMOTE snapshot: latest fetched remote branch tip.
 * Compared against BASE to detect remote changes since the last sync.
 */
type RemoteSnapshot = TreeSnapshot & {
  /** Most recently fetched remote commit SHA. null if not yet fetched. */
  remoteCommit: GitSha | null;
};

// --- Working files ---

/** A file in the local working tree — the user-visible current state. */
type WorkingFile = {
  path: Path;
  /** Git file mode; directories (040000) are never working files. */
  mode: Exclude<FileMode, '040000'>;
  /** Raw file bytes. */
  content: Uint8Array;
  size: number;
  /** Logical modification timestamp (app-defined, not OS mtime). */
  mtime?: number;
  /** Cached blob SHA for current content; avoids re-hashing when unchanged. */
  blobSha?: GitSha;
};

/** Working file metadata without binary content — used for fast listing. */
type WorkingFileMeta = Omit<WorkingFile, 'content'>;

// --- Index / staging area ---

/**
 * Git index stage numbers.
 * 0 = normal staged; 1 = merge base; 2 = ours; 3 = theirs.
 */
type IndexStage = 0 | 1 | 2 | 3;

/** A single entry in the Git index. */
type IndexEntry = {
  path: Path;
  mode: FileMode;
  stage: IndexStage;
  sha: GitSha;
};

/**
 * The Git index (staging area).
 * During merges, a single path can have multiple entries at different stages.
 */
type IndexState = {
  entries: Map<Path, IndexEntry[]>;
};

// --- Status model ---

type FileStatus = 'unmodified' | 'modified' | 'added' | 'deleted' | 'untracked' | 'conflicted';

type StatusEntry = {
  path: Path;
  status: FileStatus;
  mode?: FileMode;
  headSha?: GitSha;
  indexSha?: GitSha;
  worktreeSha?: GitSha;
};

// --- Merge state ---

/** The three content versions involved in a three-way merge conflict. */
type ConflictPayload = {
  base?: Uint8Array;
  ours?: Uint8Array;
  theirs?: Uint8Array;
};

/** Bookkeeping for an in-progress merge (e.g. during Sync). */
type MergeState = {
  inProgress: boolean;
  targetCommit?: GitSha;
  /** Paths with conflicts from the last sync (auto-resolved or not). */
  conflictedPaths: Set<Path>;
  /** Raw three-way content for each conflicted path; useful for retries and debugging. */
  conflicts?: Map<Path, ConflictPayload>;
};

// --- Refs and remote configuration ---

type Ref = {
  name: `refs/heads/${string}` | `refs/tags/${string}`;
  sha: GitSha | null;
};

type RemoteRef = {
  name: `refs/remotes/${string}/${string}`;
  sha: GitSha | null;
};

type RemoteConfig = {
  name: string;
  url: string;
};

type BranchState = {
  head: Ref;
  upstream?: RemoteRef;
};

// --- Commit envelope ---

type Signature = {
  name: string;
  email: string;
  /** Unix seconds. */
  timestamp: number;
  timezoneOffsetMinutes: number;
};

/** The data needed to construct a Git commit object before it's hashed and pushed. */
type PendingCommit = {
  tree: GitSha;
  parents: GitSha[];
  author: Signature;
  committer: Signature;
  message: string;
};

// --- Caches and configuration ---

/**
 * Cache of computed blob SHAs.
 * Keys are a stable serialization of (path, size, mtime) — avoids re-hashing unchanged files.
 */
type HashCache = {
  entries: Map<string, GitSha>;
};

type IgnoreRules = {
  patterns: string[];
};

type RepoConfig = {
  eol?: 'lf' | 'crlf' | 'as-is';
  caseSensitive?: boolean;
  enableRenameDetect?: boolean;
};

// --- Top-level repo state ---

/**
 * The complete local repo state.
 * Separates the three main snapshots (BASE, REMOTE, working files), plus index,
 * merge state, refs, and config. Designed to be persisted in IndexedDB via repo-db.ts.
 */
type RepoState = {
  repoId: string;

  remote: RemoteConfig;
  branch: BranchState;

  /** Last-synced tree — the merge base for the next Sync. */
  base: BaseSnapshot;
  /** Latest fetched remote tree. */
  remoteSnapshot: RemoteSnapshot;

  /** Current local working content, keyed by path. */
  workingFiles: Map<Path, WorkingFile>;
  /** Git index (staging area), used internally during merges. */
  index: IndexState;
  /** Per-path status relative to HEAD. */
  status: Map<Path, StatusEntry>;
  /** Merge bookkeeping for in-progress or recently completed syncs. */
  merge: MergeState;

  ignore: IgnoreRules;
  config: RepoConfig;
  /** Cached blob SHAs to avoid re-hashing unchanged files. */
  hashCache: HashCache;

  /** Monotonically increasing version counter for optimistic concurrency. */
  version: number;
  locks?: {
    sync: boolean;
    index: boolean;
  };
};
