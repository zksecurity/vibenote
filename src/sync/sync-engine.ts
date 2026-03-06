// New sync engine implementing the design from docs/vibenote-git-sync-design.md.
// Operates on the Git-shaped RepoState model (src/storage/repo-types.ts) and
// uses the git object library (src/git/) for SHA computation.
//
// The sync flow is: fetch remote → diff against BASE → three-way merge →
// build commit → push → retry on race.
//
// This module has no React dependencies. It is a pure async state machine
// that takes a RepoState and a GitHubRemote adapter, and returns a new RepoState.

import { blobSha, buildTree, commitSha } from '../git/index';
import type { GitSha, Path, FileMode } from '../git/types';
import { mergeMarkdown } from '../merge/merge';
import type {
  RepoState,
  SnapshotEntry,
  TreeSnapshot,
  WorkingFile,
  BaseSnapshot,
  RemoteSnapshot,
  Signature,
} from '../storage/repo-types';

export { performSync, computeStatus, computeDiff };
export type { GitHubRemote, SyncResult, SyncSummary, FileDiff, DiffType };

// ---------------------------------------------------------------------------
// GitHub remote adapter — abstraction over the REST API so we can mock it
// ---------------------------------------------------------------------------

/** Minimal GitHub API surface needed by the sync engine. */
type GitHubRemote = {
  /** Fetch the current branch tip commit SHA. Returns undefined if the branch doesn't exist yet. */
  fetchBranchTip: (branch: string) => Promise<string | undefined>;

  /** Fetch the commit object to get its tree SHA and parent SHAs. */
  fetchCommit: (sha: string) => Promise<{ treeSha: string; parents: string[] }>;

  /** Fetch the recursive tree listing (flat path map). */
  fetchTree: (treeSha: string) => Promise<Map<Path, SnapshotEntry>>;

  /** Fetch raw file content by blob SHA. */
  fetchBlob: (sha: string) => Promise<Uint8Array>;

  /** Create a blob on GitHub and return its SHA. */
  createBlob: (content: Uint8Array) => Promise<string>;

  /** Create a tree object on GitHub. Returns the new tree SHA. */
  createTree: (
    entries: Array<{ path: string; mode: string; sha: string | null }>,
    baseTree?: string,
  ) => Promise<string>;

  /** Create a commit object on GitHub. Returns the new commit SHA. */
  createCommit: (params: {
    treeSha: string;
    parents: string[];
    message: string;
    author?: { name: string; email: string; date: string };
    committer?: { name: string; email: string; date: string };
  }) => Promise<string>;

  /** Update the branch ref to point at a new commit. Non-force by default. */
  updateBranchRef: (branch: string, commitSha: string) => Promise<void>;

  /** Create a new branch ref pointing at a commit. */
  createBranchRef: (branch: string, commitSha: string) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Sync result types
// ---------------------------------------------------------------------------

type SyncSummary = {
  pulled: number;
  pushed: number;
  merged: number;
  deletedLocal: number;
  deletedRemote: number;
};

type SyncResult = {
  state: RepoState;
  summary: SyncSummary;
};

// ---------------------------------------------------------------------------
// Diff types
// ---------------------------------------------------------------------------

type DiffType = 'added' | 'modified' | 'deleted';

type FileDiff = {
  path: Path;
  type: DiffType;
  /** Blob SHA of the file in the working tree (undefined for deletions). */
  workingSha?: GitSha;
  /** Blob SHA of the file in the base snapshot (undefined for additions). */
  baseSha?: GitSha;
};

// ---------------------------------------------------------------------------
// Main sync entry point
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;

/**
 * One-click sync: fetch remote, diff, merge, commit, push, retry on race.
 *
 * Takes the current repo state and a GitHub remote adapter, returns the
 * new state after sync with a summary of what happened.
 */
async function performSync(
  state: RepoState,
  remote: GitHubRemote,
): Promise<SyncResult> {
  let current = state;
  let retries = 0;

  while (retries <= MAX_RETRIES) {
    let result = await attemptSync(current, remote);
    if (result.retry) {
      // Race condition: someone else pushed. Refetch and retry.
      retries++;
      current = result.state;
      continue;
    }
    return { state: result.state, summary: result.summary };
  }

  // Exhausted retries — return the state as-is with a zero summary
  return {
    state: current,
    summary: { pulled: 0, pushed: 0, merged: 0, deletedLocal: 0, deletedRemote: 0 },
  };
}

// ---------------------------------------------------------------------------
// Single sync attempt
// ---------------------------------------------------------------------------

type AttemptResult = {
  state: RepoState;
  summary: SyncSummary;
  retry: boolean;
};

async function attemptSync(
  state: RepoState,
  remote: GitHubRemote,
): Promise<AttemptResult> {
  let summary: SyncSummary = { pulled: 0, pushed: 0, merged: 0, deletedLocal: 0, deletedRemote: 0 };
  let branch = extractBranchName(state.branch.head.name);

  // Step 1: Fetch current remote tip
  let remoteTipSha = await remote.fetchBranchTip(branch);
  let isInitialCommit = remoteTipSha === undefined;

  // Step 2: Build the remote snapshot
  let remoteSnapshot: RemoteSnapshot;
  if (isInitialCommit) {
    // Empty remote — no commits yet
    remoteSnapshot = {
      rootTree: '' as GitSha,
      entries: new Map(),
      remoteCommit: null,
    };
  } else {
    let commitInfo = await remote.fetchCommit(remoteTipSha!);
    let remoteEntries = await remote.fetchTree(commitInfo.treeSha);
    remoteSnapshot = {
      rootTree: commitInfo.treeSha as GitSha,
      entries: remoteEntries,
      remoteCommit: remoteTipSha as GitSha,
    };
  }

  // Step 3: Compute local diff against BASE
  let localDiff = await computeDiff(state.base, state.workingFiles);
  let hasLocalChanges = localDiff.length > 0;

  // Step 4: Detect remote changes
  let remoteChanged = state.base.baseCommit !== remoteSnapshot.remoteCommit;

  // Case A: no changes at all
  if (!hasLocalChanges && !remoteChanged) {
    let newState = {
      ...state,
      remoteSnapshot,
      version: state.version + 1,
    };
    return { state: newState, summary, retry: false };
  }

  // Case B: local changes only (fast-forward push)
  if (hasLocalChanges && !remoteChanged) {
    let pushResult = await pushLocalChanges(state, remote, localDiff, branch, isInitialCommit);
    if (pushResult.raceDetected) {
      return { state: { ...state, remoteSnapshot }, summary, retry: true };
    }
    return { state: pushResult.state, summary: pushResult.summary, retry: false };
  }

  // Case C: remote changed (possibly with local changes too → merge)
  // First, pull remote changes into local working files
  let mergeResult = await mergeRemoteChanges(
    state,
    remote,
    remoteSnapshot,
    localDiff,
  );

  // If there were local changes that survived the merge, push the merged result
  if (mergeResult.needsPush) {
    let mergedDiff = await computeDiff(
      // Use the remote snapshot as the new base for the push
      { ...remoteSnapshot, baseCommit: remoteSnapshot.remoteCommit },
      mergeResult.state.workingFiles,
    );

    if (mergedDiff.length > 0) {
      let pushResult = await pushLocalChanges(
        mergeResult.state,
        remote,
        mergedDiff,
        branch,
        false, // not initial — remote already has commits
        remoteSnapshot.remoteCommit ?? undefined, // merge parent
      );

      if (pushResult.raceDetected) {
        return { state: mergeResult.state, summary: mergeResult.summary, retry: true };
      }

      // Combine summaries
      let combinedSummary: SyncSummary = {
        pulled: mergeResult.summary.pulled + pushResult.summary.pulled,
        pushed: mergeResult.summary.pushed + pushResult.summary.pushed,
        merged: mergeResult.summary.merged + pushResult.summary.merged,
        deletedLocal: mergeResult.summary.deletedLocal + pushResult.summary.deletedLocal,
        deletedRemote: mergeResult.summary.deletedRemote + pushResult.summary.deletedRemote,
      };

      return { state: pushResult.state, summary: combinedSummary, retry: false };
    }
  }

  // Only remote changes, no push needed
  return { state: mergeResult.state, summary: mergeResult.summary, retry: false };
}

// ---------------------------------------------------------------------------
// Compute diff: working files vs BASE snapshot
// ---------------------------------------------------------------------------

/**
 * Compare working files against the BASE snapshot to find local changes.
 * Returns a list of diffs (added, modified, deleted).
 */
async function computeDiff(
  base: BaseSnapshot,
  workingFiles: Map<Path, WorkingFile>,
): Promise<FileDiff[]> {
  let diffs: FileDiff[] = [];

  // Check for modified and added files
  for (let [path, file] of workingFiles) {
    let bSha = await ensureBlobSha(file);
    let baseEntry = base.entries.get(path);

    if (baseEntry === undefined) {
      // Added file
      diffs.push({ path, type: 'added', workingSha: bSha });
    } else if (baseEntry.sha !== bSha) {
      // Modified file
      diffs.push({ path, type: 'modified', workingSha: bSha, baseSha: baseEntry.sha });
    }
  }

  // Check for deleted files (in base but not in working)
  for (let [path, entry] of base.entries) {
    if (!workingFiles.has(path)) {
      diffs.push({ path, type: 'deleted', baseSha: entry.sha });
    }
  }

  return diffs;
}

// ---------------------------------------------------------------------------
// Push local changes to remote
// ---------------------------------------------------------------------------

type PushResult = {
  state: RepoState;
  summary: SyncSummary;
  raceDetected: boolean;
};

async function pushLocalChanges(
  state: RepoState,
  remote: GitHubRemote,
  diffs: FileDiff[],
  branch: string,
  isInitialCommit: boolean,
  mergeParent?: string,
): Promise<PushResult> {
  let summary: SyncSummary = { pulled: 0, pushed: 0, merged: 0, deletedLocal: 0, deletedRemote: 0 };

  // Create blobs for new/modified files
  let treeEntries: Array<{ path: string; mode: string; sha: string | null }> = [];
  let blobShas = new Map<string, GitSha>();

  for (let diff of diffs) {
    if (diff.type === 'deleted') {
      treeEntries.push({ path: diff.path, mode: '100644', sha: null });
      summary.deletedRemote++;
    } else {
      let file = state.workingFiles.get(diff.path);
      if (file === undefined) continue;

      let fileSha = await ensureBlobSha(file);

      // Create the blob on GitHub
      let remoteBlobSha = await remote.createBlob(file.content);
      if (remoteBlobSha !== fileSha) {
        // SHA mismatch — our local computation disagrees with GitHub
        throw new Error(
          `Blob SHA mismatch for ${diff.path}: local ${fileSha}, GitHub ${remoteBlobSha}`,
        );
      }

      treeEntries.push({ path: diff.path, mode: file.mode, sha: fileSha });
      blobShas.set(diff.path, fileSha);
      summary.pushed++;
    }
  }

  // Create tree on GitHub (with base_tree for incremental updates)
  let baseTree = isInitialCommit ? undefined : state.base.rootTree;
  let newTreeSha = await remote.createTree(treeEntries, baseTree);

  // Create commit
  let parents: string[] = [];
  if (!isInitialCommit && state.base.baseCommit !== null) {
    parents.push(state.base.baseCommit);
  }
  if (mergeParent !== undefined) {
    parents.push(mergeParent);
  }

  let newCommitSha = await remote.createCommit({
    treeSha: newTreeSha,
    parents,
    message: 'vibenote: sync changes',
  });

  // Update the branch ref
  try {
    if (isInitialCommit) {
      await remote.createBranchRef(branch, newCommitSha);
    } else {
      await remote.updateBranchRef(branch, newCommitSha);
    }
  } catch (err: unknown) {
    // Check if this is a race condition (422 = fast-forward required)
    if (isRefUpdateError(err)) {
      return { state, summary: { pulled: 0, pushed: 0, merged: 0, deletedLocal: 0, deletedRemote: 0 }, raceDetected: true };
    }
    throw err;
  }

  // Build the new snapshot from working files
  let newEntries = new Map<Path, SnapshotEntry>();
  // Start with base entries
  for (let [path, entry] of state.base.entries) {
    newEntries.set(path, entry);
  }
  // Apply diffs
  for (let diff of diffs) {
    if (diff.type === 'deleted') {
      newEntries.delete(diff.path);
    } else {
      let file = state.workingFiles.get(diff.path);
      let sha = blobShas.get(diff.path);
      if (file !== undefined && sha !== undefined) {
        newEntries.set(diff.path, { mode: file.mode, sha });
      }
    }
  }

  let newBase: BaseSnapshot = {
    rootTree: newTreeSha as GitSha,
    entries: newEntries,
    baseCommit: newCommitSha as GitSha,
  };

  let newRemote: RemoteSnapshot = {
    rootTree: newTreeSha as GitSha,
    entries: new Map(newEntries),
    remoteCommit: newCommitSha as GitSha,
  };

  // Update working files with computed blob SHAs (cache them)
  let updatedWorkingFiles = new Map(state.workingFiles);
  for (let [path, sha] of blobShas) {
    let file = updatedWorkingFiles.get(path as Path);
    if (file !== undefined) {
      updatedWorkingFiles.set(path as Path, { ...file, blobSha: sha });
    }
  }

  let newState: RepoState = {
    ...state,
    base: newBase,
    remoteSnapshot: newRemote,
    workingFiles: updatedWorkingFiles,
    merge: { inProgress: false, conflictedPaths: new Set() },
    version: state.version + 1,
  };

  return { state: newState, summary, raceDetected: false };
}

// ---------------------------------------------------------------------------
// Merge remote changes into local working files
// ---------------------------------------------------------------------------

type MergeResult = {
  state: RepoState;
  summary: SyncSummary;
  /** Whether local changes exist after the merge and need to be pushed. */
  needsPush: boolean;
};

async function mergeRemoteChanges(
  state: RepoState,
  remote: GitHubRemote,
  remoteSnapshot: RemoteSnapshot,
  localDiff: FileDiff[],
): Promise<MergeResult> {
  let summary: SyncSummary = { pulled: 0, pushed: 0, merged: 0, deletedLocal: 0, deletedRemote: 0 };
  let updatedFiles = new Map(state.workingFiles);
  let hasLocalChanges = localDiff.length > 0;
  let localDiffPaths = new Set(localDiff.map(d => d.path));

  // Build sets for quick lookup
  let baseEntries = state.base.entries;
  let remoteEntries = remoteSnapshot.entries;

  // Track which paths the remote changed
  let remoteAdded = new Map<Path, SnapshotEntry>();
  let remoteModified = new Map<Path, SnapshotEntry>();
  let remoteDeleted = new Set<Path>();

  // Find remote additions and modifications
  for (let [path, entry] of remoteEntries) {
    let baseEntry = baseEntries.get(path);
    if (baseEntry === undefined) {
      remoteAdded.set(path, entry);
    } else if (baseEntry.sha !== entry.sha) {
      remoteModified.set(path, entry);
    }
  }

  // Find remote deletions
  for (let [path] of baseEntries) {
    if (!remoteEntries.has(path)) {
      remoteDeleted.add(path);
    }
  }

  // Process remote additions
  for (let [path, entry] of remoteAdded) {
    if (localDiffPaths.has(path)) {
      // Both added the same path — use remote version (theirs wins for conflicts)
      // unless it's markdown, in which case we try to merge
      let localFile = updatedFiles.get(path);
      if (localFile !== undefined && isMarkdownPath(path)) {
        let remoteContent = await remote.fetchBlob(entry.sha);
        let merged = mergeMarkdown('', decodeUtf8(localFile.content), decodeUtf8(remoteContent));
        updatedFiles.set(path, {
          ...localFile,
          content: encodeUtf8(merged),
          size: encodeUtf8(merged).byteLength,
          blobSha: undefined, // invalidate cache
          mtime: Date.now(),
        });
        summary.merged++;
      } else {
        // Remote wins
        let remoteContent = await remote.fetchBlob(entry.sha);
        updatedFiles.set(path, {
          path,
          mode: entry.mode as Exclude<FileMode, '040000'>,
          content: remoteContent,
          size: remoteContent.byteLength,
          mtime: Date.now(),
        });
        summary.pulled++;
      }
    } else {
      // No local change for this path — just pull
      let remoteContent = await remote.fetchBlob(entry.sha);
      updatedFiles.set(path, {
        path,
        mode: entry.mode as Exclude<FileMode, '040000'>,
        content: remoteContent,
        size: remoteContent.byteLength,
        mtime: Date.now(),
      });
      summary.pulled++;
    }
  }

  // Process remote modifications
  for (let [path, entry] of remoteModified) {
    if (localDiffPaths.has(path)) {
      // Both sides changed — three-way merge
      let localFile = updatedFiles.get(path);
      if (localFile === undefined) continue;

      let baseEntry = baseEntries.get(path);
      if (baseEntry === undefined) continue;

      if (isMarkdownPath(path)) {
        // Markdown: custom three-way merge
        let baseContent = await remote.fetchBlob(baseEntry.sha);
        let remoteContent = await remote.fetchBlob(entry.sha);
        let merged = mergeMarkdown(
          decodeUtf8(baseContent),
          decodeUtf8(localFile.content),
          decodeUtf8(remoteContent),
        );
        updatedFiles.set(path, {
          ...localFile,
          content: encodeUtf8(merged),
          size: encodeUtf8(merged).byteLength,
          blobSha: undefined, // invalidate cache
          mtime: Date.now(),
        });
        summary.merged++;
      } else if (isBinaryPath(path)) {
        // Binary: theirs wins
        let remoteContent = await remote.fetchBlob(entry.sha);
        updatedFiles.set(path, {
          ...localFile,
          content: remoteContent,
          size: remoteContent.byteLength,
          blobSha: entry.sha,
          mtime: Date.now(),
        });
        summary.pulled++;
      } else {
        // Other text: remote wins for now (best-effort fallback)
        let remoteContent = await remote.fetchBlob(entry.sha);
        updatedFiles.set(path, {
          ...localFile,
          content: remoteContent,
          size: remoteContent.byteLength,
          blobSha: entry.sha,
          mtime: Date.now(),
        });
        summary.pulled++;
      }
    } else {
      // Only remote changed — pull
      let localFile = updatedFiles.get(path);
      let remoteContent = await remote.fetchBlob(entry.sha);
      let mode = localFile?.mode ?? (entry.mode as Exclude<FileMode, '040000'>);
      updatedFiles.set(path, {
        path,
        mode,
        content: remoteContent,
        size: remoteContent.byteLength,
        blobSha: entry.sha,
        mtime: Date.now(),
      });
      summary.pulled++;
    }
  }

  // Process remote deletions
  for (let path of remoteDeleted) {
    if (localDiffPaths.has(path)) {
      // Locally modified but remotely deleted — keep local version (restore)
      // This will be pushed back in the next step
      summary.pushed++;
    } else {
      // Not locally modified — delete locally
      updatedFiles.delete(path);
      summary.deletedLocal++;
    }
  }

  // Update base and remote snapshots to reflect the remote state
  let newBase: BaseSnapshot = {
    rootTree: remoteSnapshot.rootTree,
    entries: new Map(remoteSnapshot.entries),
    baseCommit: remoteSnapshot.remoteCommit,
  };

  // Check if we still have local changes to push after merging
  let postMergeDiff = await computeDiff(newBase, updatedFiles);
  let needsPush = postMergeDiff.length > 0;

  let newState: RepoState = {
    ...state,
    base: newBase,
    remoteSnapshot,
    workingFiles: updatedFiles,
    merge: { inProgress: false, conflictedPaths: new Set() },
    version: state.version + 1,
  };

  return { state: newState, summary, needsPush };
}

// ---------------------------------------------------------------------------
// Compute file status relative to BASE (for UI display)
// ---------------------------------------------------------------------------

type FileStatusInfo = {
  path: Path;
  status: 'unmodified' | 'modified' | 'added' | 'deleted';
};

/**
 * Compute the status of all files relative to BASE.
 * Useful for showing dirty indicators in the UI.
 */
async function computeStatus(
  base: BaseSnapshot,
  workingFiles: Map<Path, WorkingFile>,
): Promise<FileStatusInfo[]> {
  let statuses: FileStatusInfo[] = [];

  for (let [path, file] of workingFiles) {
    let fileSha = await ensureBlobSha(file);
    let baseEntry = base.entries.get(path);

    if (baseEntry === undefined) {
      statuses.push({ path, status: 'added' });
    } else if (baseEntry.sha !== fileSha) {
      statuses.push({ path, status: 'modified' });
    } else {
      statuses.push({ path, status: 'unmodified' });
    }
  }

  for (let [path] of base.entries) {
    if (!workingFiles.has(path)) {
      statuses.push({ path, status: 'deleted' });
    }
  }

  return statuses;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ensure a working file has a cached blob SHA, computing it if needed. */
async function ensureBlobSha(file: WorkingFile): Promise<GitSha> {
  if (file.blobSha !== undefined) return file.blobSha;
  let sha = await blobSha(file.content);
  // Mutate the cache in place — this is intentional for performance
  (file as { blobSha: GitSha }).blobSha = sha;
  return sha;
}

/** Check if a ref update error is a race condition (422 status). */
function isRefUpdateError(err: unknown): boolean {
  if (err !== null && typeof err === 'object' && 'status' in err) {
    return (err as { status: number }).status === 422;
  }
  return false;
}

/** Extract the short branch name from a full ref like "refs/heads/main". */
function extractBranchName(ref: string): string {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('refs/tags/')) return ref.slice('refs/tags/'.length);
  return ref;
}

/** Check if a path is a markdown file. */
function isMarkdownPath(path: string): boolean {
  let lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

/** Check if a path is a binary file (images, pdfs, etc.). */
function isBinaryPath(path: string): boolean {
  let lower = path.toLowerCase();
  let binaryExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
    '.pdf', '.zip', '.tar', '.gz',
    '.mp3', '.mp4', '.wav', '.ogg',
    '.woff', '.woff2', '.ttf', '.otf',
  ];
  return binaryExtensions.some(ext => lower.endsWith(ext));
}

const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

function encodeUtf8(text: string): Uint8Array {
  return _encoder.encode(text);
}

function decodeUtf8(bytes: Uint8Array): string {
  return _decoder.decode(bytes);
}
