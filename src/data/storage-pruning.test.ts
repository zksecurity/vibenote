// Tests for storage pruning logic.

import { describe, it, expect } from 'vitest';
import { pruneWorkingFiles, computePruningCandidates } from './storage-pruning';
import { createEmptyRepoState } from './repo-state-store';
import { blobSha } from '../git/index';
import type { RepoState, WorkingFile, Path, GitSha, SnapshotEntry } from '../storage/repo-types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function toPath(s: string): Path {
  return s as Path;
}

function toSha(s: string): GitSha {
  return s as GitSha;
}

function makeFile(path: string, content: string, mtime: number, sha?: GitSha): WorkingFile {
  let bytes = enc.encode(content);
  return {
    path: toPath(path),
    mode: '100644',
    content: bytes,
    size: bytes.byteLength,
    mtime,
    blobSha: sha,
  };
}

async function makeStateWithFiles(
  files: Array<{ path: string; content: string; mtime: number; synced: boolean }>,
): Promise<RepoState> {
  let state = createEmptyRepoState('test/repo');
  let baseEntries = new Map<Path, SnapshotEntry>();

  for (let f of files) {
    let bytes = enc.encode(f.content);
    let sha = await blobSha(bytes);
    let file = makeFile(f.path, f.content, f.mtime, sha);
    state.workingFiles.set(toPath(f.path), file);

    if (f.synced) {
      // File matches BASE = fully synced
      baseEntries.set(toPath(f.path), { mode: '100644', sha });
    }
  }

  state.base = {
    rootTree: toSha('base-tree'),
    entries: baseEntries,
    baseCommit: toSha('base-commit'),
  };

  return state;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computePruningCandidates', () => {
  it('returns only synced files as candidates', async () => {
    let state = await makeStateWithFiles([
      { path: 'synced.md', content: 'synced content', mtime: 1000, synced: true },
      { path: 'dirty.md', content: 'local only', mtime: 500, synced: false },
    ]);

    let candidates = await computePruningCandidates(state);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.path).toBe('synced.md');
    expect(candidates[0]!.isSynced).toBe(true);
  });

  it('respects minAgeMs', async () => {
    let now = Date.now();
    let state = await makeStateWithFiles([
      { path: 'old.md', content: 'old', mtime: now - 100_000, synced: true },
      { path: 'recent.md', content: 'recent', mtime: now - 1_000, synced: true },
    ]);

    let candidates = await computePruningCandidates(state, { minAgeMs: 50_000 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.path).toBe('old.md');
  });

  it('respects pinnedPaths', async () => {
    let state = await makeStateWithFiles([
      { path: 'pinned.md', content: 'keep me', mtime: 1000, synced: true },
      { path: 'prunable.md', content: 'can go', mtime: 500, synced: true },
    ]);

    let candidates = await computePruningCandidates(state, {
      pinnedPaths: new Set(['pinned.md']),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.path).toBe('prunable.md');
  });

  it('sorts candidates oldest first', async () => {
    let state = await makeStateWithFiles([
      { path: 'newer.md', content: 'newer', mtime: 3000, synced: true },
      { path: 'oldest.md', content: 'oldest', mtime: 1000, synced: true },
      { path: 'middle.md', content: 'middle', mtime: 2000, synced: true },
    ]);

    let candidates = await computePruningCandidates(state);
    expect(candidates.map(c => c.path)).toEqual([
      'oldest.md',
      'middle.md',
      'newer.md',
    ]);
  });

  it('returns empty for no synced files', async () => {
    let state = await makeStateWithFiles([
      { path: 'dirty1.md', content: 'local1', mtime: 1000, synced: false },
      { path: 'dirty2.md', content: 'local2', mtime: 2000, synced: false },
    ]);

    let candidates = await computePruningCandidates(state);
    expect(candidates).toHaveLength(0);
  });
});

describe('pruneWorkingFiles', () => {
  it('does nothing when no limits are set', async () => {
    let state = await makeStateWithFiles([
      { path: 'file.md', content: 'content', mtime: 1000, synced: true },
    ]);

    let result = await pruneWorkingFiles(state);
    expect(result.evictedPaths).toHaveLength(0);
    expect(result.bytesFreed).toBe(0);
    expect(result.state).toBe(state); // same reference
  });

  it('evicts oldest synced files when over maxFiles', async () => {
    let state = await makeStateWithFiles([
      { path: 'old1.md', content: 'old 1', mtime: 1000, synced: true },
      { path: 'old2.md', content: 'old 2', mtime: 2000, synced: true },
      { path: 'new.md', content: 'new', mtime: 3000, synced: true },
    ]);

    let result = await pruneWorkingFiles(state, { maxFiles: 2 });
    expect(result.evictedPaths).toHaveLength(1);
    expect(result.evictedPaths[0]).toBe('old1.md');
    expect(result.state.workingFiles.size).toBe(2);
    expect(result.state.workingFiles.has(toPath('old1.md'))).toBe(false);
    expect(result.state.workingFiles.has(toPath('new.md'))).toBe(true);
  });

  it('evicts files when over maxBytes', async () => {
    // Each file is ~5 bytes
    let state = await makeStateWithFiles([
      { path: 'a.md', content: 'aaaaa', mtime: 1000, synced: true },
      { path: 'b.md', content: 'bbbbb', mtime: 2000, synced: true },
      { path: 'c.md', content: 'ccccc', mtime: 3000, synced: true },
    ]);

    // Allow only ~10 bytes → need to evict 1 file
    let result = await pruneWorkingFiles(state, { maxBytes: 10 });
    expect(result.evictedPaths).toHaveLength(1);
    expect(result.evictedPaths[0]).toBe('a.md'); // oldest first
    expect(result.bytesFreed).toBe(5);
  });

  it('never evicts dirty (unsynced) files', async () => {
    let state = await makeStateWithFiles([
      { path: 'dirty.md', content: 'local changes', mtime: 1000, synced: false },
      { path: 'synced.md', content: 'synced', mtime: 2000, synced: true },
    ]);

    // maxFiles=1 should only evict synced file, never the dirty one
    let result = await pruneWorkingFiles(state, { maxFiles: 1 });
    // Can't get below maxFiles because dirty file can't be evicted
    expect(result.state.workingFiles.has(toPath('dirty.md'))).toBe(true);
  });

  it('increments version after pruning', async () => {
    let state = await makeStateWithFiles([
      { path: 'old.md', content: 'old', mtime: 1000, synced: true },
      { path: 'new.md', content: 'new', mtime: 2000, synced: true },
    ]);
    state.version = 5;

    let result = await pruneWorkingFiles(state, { maxFiles: 1 });
    expect(result.state.version).toBe(6);
  });

  it('respects pinnedPaths during eviction', async () => {
    let state = await makeStateWithFiles([
      { path: 'pinned.md', content: 'pinned', mtime: 1000, synced: true },
      { path: 'other.md', content: 'other', mtime: 2000, synced: true },
      { path: 'newest.md', content: 'newest', mtime: 3000, synced: true },
    ]);

    let result = await pruneWorkingFiles(state, {
      maxFiles: 1,
      pinnedPaths: new Set(['pinned.md']),
    });
    // pinned.md should survive even though it's the oldest
    expect(result.state.workingFiles.has(toPath('pinned.md'))).toBe(true);
    // other.md should be evicted (oldest unpinned)
    expect(result.state.workingFiles.has(toPath('other.md'))).toBe(false);
  });
});
