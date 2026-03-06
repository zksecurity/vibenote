// Storage pruning: evict locally-cached files that are fully synced with
// the remote and haven't been accessed recently. Safe because robust sync
// means we can re-fetch from GitHub on demand.
//
// This module operates on RepoState and produces a pruned RepoState.
// It does NOT handle re-fetching — callers are responsible for lazy-loading
// files that have been evicted.

import type { RepoState, WorkingFile, Path, GitSha } from '../storage/repo-types';
import { blobSha } from '../git/index';

export { pruneWorkingFiles, computePruningCandidates };
export type { PruneOptions, PruneResult, PruneCandidate };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PruneOptions = {
  /** Maximum number of files to keep locally. Files beyond this are candidates. */
  maxFiles?: number;
  /** Maximum total bytes of file content to keep locally. */
  maxBytes?: number;
  /** Minimum age in milliseconds since last access before a file can be pruned. */
  minAgeMs?: number;
  /** Paths that should never be pruned (e.g. currently open file). */
  pinnedPaths?: Set<string>;
};

type PruneCandidate = {
  path: Path;
  /** Bytes that would be freed by evicting this file. */
  bytes: number;
  /** Last modification time (lower = older = higher pruning priority). */
  mtime: number;
  /** Whether the file is fully synced (identical to base snapshot). */
  isSynced: boolean;
};

type PruneResult = {
  /** The pruned RepoState with evicted files removed from workingFiles. */
  state: RepoState;
  /** Paths that were evicted. */
  evictedPaths: Path[];
  /** Total bytes freed. */
  bytesFreed: number;
};

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Prune working files from a RepoState based on the given options.
 * Only evicts files that are fully synced (content matches BASE snapshot).
 * Returns a new RepoState with evicted files removed.
 */
async function pruneWorkingFiles(
  state: RepoState,
  options: PruneOptions = {},
): Promise<PruneResult> {
  let candidates = await computePruningCandidates(state, options);

  // Determine which candidates to actually evict
  let toEvict = selectForEviction(candidates, state, options);

  if (toEvict.length === 0) {
    return { state, evictedPaths: [], bytesFreed: 0 };
  }

  // Build the pruned working files map
  let prunedFiles = new Map(state.workingFiles);
  let bytesFreed = 0;

  for (let candidate of toEvict) {
    prunedFiles.delete(candidate.path);
    bytesFreed += candidate.bytes;
  }

  let prunedState: RepoState = {
    ...state,
    workingFiles: prunedFiles,
    version: state.version + 1,
  };

  return {
    state: prunedState,
    evictedPaths: toEvict.map(c => c.path),
    bytesFreed,
  };
}

/**
 * Compute which files are candidates for pruning (synced + old enough).
 * Does not actually evict anything — useful for showing UI hints about storage.
 */
async function computePruningCandidates(
  state: RepoState,
  options: PruneOptions = {},
): Promise<PruneCandidate[]> {
  let { minAgeMs = 0, pinnedPaths = new Set() } = options;
  let now = Date.now();
  let candidates: PruneCandidate[] = [];

  for (let [path, file] of state.workingFiles) {
    // Never prune pinned paths
    if (pinnedPaths.has(path)) continue;

    // Check if the file is old enough to be a candidate
    let age = now - (file.mtime ?? 0);
    if (age < minAgeMs) continue;

    // Check if the file is synced (content matches BASE)
    let synced = await isFileSynced(file, state);

    if (!synced) continue;

    candidates.push({
      path,
      bytes: file.content.byteLength,
      mtime: file.mtime ?? 0,
      isSynced: true,
    });
  }

  // Sort by mtime ascending (oldest first — most likely to prune)
  candidates.sort((a, b) => a.mtime - b.mtime);

  return candidates;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Check if a working file's content matches the BASE snapshot (= fully synced). */
async function isFileSynced(file: WorkingFile, state: RepoState): Promise<boolean> {
  let baseEntry = state.base.entries.get(file.path);
  if (baseEntry === undefined) return false;

  // Use cached blob SHA if available, otherwise compute
  let fileSha = file.blobSha;
  if (fileSha === undefined) {
    fileSha = await blobSha(file.content);
  }

  return fileSha === baseEntry.sha;
}

/**
 * Select which candidates to actually evict based on the pruning limits.
 * Prioritizes evicting the oldest files first.
 */
function selectForEviction(
  candidates: PruneCandidate[],
  state: RepoState,
  options: PruneOptions,
): PruneCandidate[] {
  let { maxFiles, maxBytes } = options;

  // If no limits are set, don't evict anything
  if (maxFiles === undefined && maxBytes === undefined) return [];

  let currentFileCount = state.workingFiles.size;
  let currentBytes = 0;
  for (let [, file] of state.workingFiles) {
    currentBytes += file.content.byteLength;
  }

  let toEvict: PruneCandidate[] = [];

  for (let candidate of candidates) {
    let overFileLimit = maxFiles !== undefined && currentFileCount > maxFiles;
    let overByteLimit = maxBytes !== undefined && currentBytes > maxBytes;

    // Stop if we're within both limits
    if (!overFileLimit && !overByteLimit) break;

    toEvict.push(candidate);
    currentFileCount--;
    currentBytes -= candidate.bytes;
  }

  return toEvict;
}
