// Tests for the new sync engine (sync-engine.ts).
// Uses an in-memory mock GitHubRemote to test all sync scenarios
// without network calls.

import { describe, it, expect, beforeEach } from 'vitest';
import { performSync, computeStatus, computeDiff } from './sync-engine';
import type { GitHubRemote } from './sync-engine';
import { blobSha } from '../git/index';
import type { GitSha, Path, FileMode } from '../git/types';
import type {
  RepoState,
  WorkingFile,
  BaseSnapshot,
  RemoteSnapshot,
  SnapshotEntry,
} from '../storage/repo-types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

function toPath(s: string): Path {
  return s as Path;
}

function toSha(s: string): GitSha {
  return s as GitSha;
}

function makeWorkingFile(path: string, text: string, sha?: GitSha): WorkingFile {
  let content = enc.encode(text);
  return {
    path: toPath(path),
    mode: '100644' as Exclude<FileMode, '040000'>,
    content,
    size: content.byteLength,
    blobSha: sha,
    mtime: Date.now(),
  };
}

function makeEmptyBase(): BaseSnapshot {
  return {
    rootTree: toSha('empty-tree'),
    entries: new Map(),
    baseCommit: null,
  };
}

function makeBase(files: Array<{ path: string; sha: string }>): BaseSnapshot {
  let entries = new Map<Path, SnapshotEntry>();
  for (let f of files) {
    entries.set(toPath(f.path), { mode: '100644', sha: toSha(f.sha) });
  }
  return {
    rootTree: toSha('base-tree'),
    entries,
    baseCommit: toSha('base-commit'),
  };
}

function makeRepoState(overrides: Partial<RepoState> = {}): RepoState {
  return {
    repoId: 'test/repo',
    remote: { name: 'origin', url: 'https://github.com/test/repo.git' },
    branch: {
      head: { name: 'refs/heads/main', sha: null },
    },
    base: makeEmptyBase(),
    remoteSnapshot: {
      rootTree: toSha('empty-tree'),
      entries: new Map(),
      remoteCommit: null,
    },
    workingFiles: new Map(),
    index: { entries: new Map() },
    status: new Map(),
    merge: { inProgress: false, conflictedPaths: new Set() },
    ignore: { patterns: [] },
    config: {},
    hashCache: { entries: new Map() },
    version: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory mock GitHub remote
// ---------------------------------------------------------------------------

type MockFile = { content: Uint8Array; sha: string };
type MockCommit = { treeSha: string; files: Map<string, MockFile>; parents: string[] };

class MockGitHub implements GitHubRemote {
  private files = new Map<string, MockFile>();
  private blobs = new Map<string, Uint8Array>();
  private commits = new Map<string, MockCommit>();
  private trees = new Map<string, Map<Path, SnapshotEntry>>();
  private branchTip: string | undefined;
  private commitCounter = 0;
  private treeCounter = 0;
  private rejectNextRefUpdate = false;

  /** Set up the remote with initial files. */
  async setFiles(entries: Array<{ path: string; text: string }>) {
    this.files.clear();
    for (let entry of entries) {
      let content = enc.encode(entry.text);
      let sha = await blobSha(content);
      this.files.set(entry.path, { content, sha });
      this.blobs.set(sha, content);
    }
    // Create a tree + commit for this state
    let treeEntries = new Map<Path, SnapshotEntry>();
    for (let [path, file] of this.files) {
      treeEntries.set(toPath(path), { mode: '100644', sha: toSha(file.sha) });
    }
    let treeSha = `tree-${++this.treeCounter}`;
    this.trees.set(treeSha, treeEntries);

    let commitSha = `commit-${++this.commitCounter}`;
    let commitFiles = new Map(this.files);
    this.commits.set(commitSha, { treeSha, files: commitFiles, parents: [] });
    this.branchTip = commitSha;
  }

  /** Simulate an external push (add/modify files on remote). */
  async externalPush(entries: Array<{ path: string; text: string }>) {
    for (let entry of entries) {
      let content = enc.encode(entry.text);
      let sha = await blobSha(content);
      this.files.set(entry.path, { content, sha });
      this.blobs.set(sha, content);
    }
    let treeEntries = new Map<Path, SnapshotEntry>();
    for (let [path, file] of this.files) {
      treeEntries.set(toPath(path), { mode: '100644', sha: toSha(file.sha) });
    }
    let treeSha = `tree-${++this.treeCounter}`;
    this.trees.set(treeSha, treeEntries);

    let parent = this.branchTip;
    let commitSha = `commit-${++this.commitCounter}`;
    this.commits.set(commitSha, {
      treeSha,
      files: new Map(this.files),
      parents: parent !== undefined ? [parent] : [],
    });
    this.branchTip = commitSha;
  }

  /** Simulate an external deletion on remote. */
  async externalDelete(paths: string[]) {
    for (let path of paths) {
      this.files.delete(path);
    }
    let treeEntries = new Map<Path, SnapshotEntry>();
    for (let [path, file] of this.files) {
      treeEntries.set(toPath(path), { mode: '100644', sha: toSha(file.sha) });
    }
    let treeSha = `tree-${++this.treeCounter}`;
    this.trees.set(treeSha, treeEntries);

    let parent = this.branchTip;
    let commitSha = `commit-${++this.commitCounter}`;
    this.commits.set(commitSha, {
      treeSha,
      files: new Map(this.files),
      parents: parent !== undefined ? [parent] : [],
    });
    this.branchTip = commitSha;
  }

  /** Get the snapshot that would be the BASE after syncing with current remote. */
  getBaseSnapshot(): BaseSnapshot {
    if (this.branchTip === undefined) {
      return makeEmptyBase();
    }
    let commit = this.commits.get(this.branchTip)!;
    let tree = this.trees.get(commit.treeSha)!;
    return {
      rootTree: toSha(commit.treeSha),
      entries: new Map(tree),
      baseCommit: toSha(this.branchTip),
    };
  }

  /** Make the next ref update fail (simulating a race condition). */
  simulateRace() {
    this.rejectNextRefUpdate = true;
  }

  // --- GitHubRemote implementation ---

  async fetchBranchTip(): Promise<string | undefined> {
    return this.branchTip;
  }

  async fetchCommit(sha: string): Promise<{ treeSha: string; parents: string[] }> {
    let commit = this.commits.get(sha);
    if (commit === undefined) throw new Error(`Unknown commit: ${sha}`);
    return { treeSha: commit.treeSha, parents: commit.parents };
  }

  async fetchTree(treeSha: string): Promise<Map<Path, SnapshotEntry>> {
    let tree = this.trees.get(treeSha);
    if (tree === undefined) return new Map();
    return new Map(tree);
  }

  async fetchBlob(sha: string): Promise<Uint8Array> {
    let blob = this.blobs.get(sha);
    if (blob === undefined) throw new Error(`Unknown blob: ${sha}`);
    return blob;
  }

  async createBlob(content: Uint8Array): Promise<string> {
    let sha = await blobSha(content);
    this.blobs.set(sha, new Uint8Array(content));
    return sha;
  }

  async createTree(
    entries: Array<{ path: string; mode: string; sha: string | null }>,
    baseTree?: string,
  ): Promise<string> {
    // Start from base tree if provided
    let resultEntries = new Map<Path, SnapshotEntry>();
    if (baseTree !== undefined) {
      let base = this.trees.get(baseTree);
      if (base !== undefined) {
        for (let [path, entry] of base) {
          resultEntries.set(path, entry);
        }
      }
    }

    // Apply changes
    for (let entry of entries) {
      if (entry.sha === null) {
        resultEntries.delete(toPath(entry.path));
      } else {
        resultEntries.set(toPath(entry.path), {
          mode: entry.mode as FileMode,
          sha: toSha(entry.sha),
        });
      }
    }

    let treeSha = `tree-${++this.treeCounter}`;
    this.trees.set(treeSha, resultEntries);

    // Update internal files map to reflect the tree
    this.files.clear();
    for (let [path, entry] of resultEntries) {
      let blob = this.blobs.get(entry.sha);
      if (blob !== undefined) {
        this.files.set(path, { content: blob, sha: entry.sha });
      }
    }

    return treeSha;
  }

  async createCommit(params: {
    treeSha: string;
    parents: string[];
    message: string;
  }): Promise<string> {
    let commitSha = `commit-${++this.commitCounter}`;
    let tree = this.trees.get(params.treeSha);
    let commitFiles = new Map<string, MockFile>();
    if (tree !== undefined) {
      for (let [path, entry] of tree) {
        let blob = this.blobs.get(entry.sha);
        if (blob !== undefined) {
          commitFiles.set(path, { content: blob, sha: entry.sha });
        }
      }
    }
    this.commits.set(commitSha, {
      treeSha: params.treeSha,
      files: commitFiles,
      parents: params.parents,
    });
    return commitSha;
  }

  async updateBranchRef(_branch: string, commitSha: string): Promise<void> {
    if (this.rejectNextRefUpdate) {
      this.rejectNextRefUpdate = false;
      let err = new Error('fast-forward required') as Error & { status: number };
      err.status = 422;
      throw err;
    }
    this.branchTip = commitSha;
  }

  async createBranchRef(_branch: string, commitSha: string): Promise<void> {
    this.branchTip = commitSha;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeDiff', () => {
  it('detects added files', async () => {
    let base = makeEmptyBase();
    let files = new Map<Path, WorkingFile>();
    files.set(toPath('hello.md'), makeWorkingFile('hello.md', 'hello world'));

    let diffs = await computeDiff(base, files);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.type).toBe('added');
    expect(diffs[0]!.path).toBe('hello.md');
  });

  it('detects modified files', async () => {
    let content = enc.encode('original');
    let sha = await blobSha(content);
    let base = makeBase([{ path: 'note.md', sha }]);

    let files = new Map<Path, WorkingFile>();
    files.set(toPath('note.md'), makeWorkingFile('note.md', 'modified'));

    let diffs = await computeDiff(base, files);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.type).toBe('modified');
  });

  it('detects deleted files', async () => {
    let base = makeBase([{ path: 'gone.md', sha: 'abc123' }]);
    let files = new Map<Path, WorkingFile>();

    let diffs = await computeDiff(base, files);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.type).toBe('deleted');
    expect(diffs[0]!.path).toBe('gone.md');
  });

  it('returns empty for unchanged files', async () => {
    let content = enc.encode('same');
    let sha = await blobSha(content);
    let base = makeBase([{ path: 'same.md', sha }]);

    let files = new Map<Path, WorkingFile>();
    files.set(toPath('same.md'), makeWorkingFile('same.md', 'same', sha));

    let diffs = await computeDiff(base, files);
    expect(diffs).toHaveLength(0);
  });
});

describe('computeStatus', () => {
  it('classifies files correctly', async () => {
    let content = enc.encode('unchanged');
    let sha = await blobSha(content);
    let base = makeBase([
      { path: 'unchanged.md', sha },
      { path: 'modified.md', sha: 'old-sha' },
      { path: 'deleted.md', sha: 'del-sha' },
    ]);

    let files = new Map<Path, WorkingFile>();
    files.set(toPath('unchanged.md'), makeWorkingFile('unchanged.md', 'unchanged', sha));
    files.set(toPath('modified.md'), makeWorkingFile('modified.md', 'new content'));
    files.set(toPath('added.md'), makeWorkingFile('added.md', 'brand new'));

    let statuses = await computeStatus(base, files);
    let byPath = new Map(statuses.map(s => [s.path, s.status]));

    expect(byPath.get(toPath('unchanged.md'))).toBe('unmodified');
    expect(byPath.get(toPath('modified.md'))).toBe('modified');
    expect(byPath.get(toPath('added.md'))).toBe('added');
    expect(byPath.get(toPath('deleted.md'))).toBe('deleted');
  });
});

describe('performSync', () => {
  let github: MockGitHub;

  beforeEach(() => {
    github = new MockGitHub();
  });

  // ----- Case A: No changes -----

  it('no-ops when nothing changed', async () => {
    await github.setFiles([{ path: 'README.md', text: '# Hello' }]);
    let base = github.getBaseSnapshot();
    let files = new Map<Path, WorkingFile>();
    let readmeContent = enc.encode('# Hello');
    let readmeSha = await blobSha(readmeContent);
    files.set(toPath('README.md'), makeWorkingFile('README.md', '# Hello', readmeSha));

    let state = makeRepoState({
      base,
      remoteSnapshot: { ...base, remoteCommit: base.baseCommit },
      workingFiles: files,
    });

    let result = await performSync(state, github);
    expect(result.summary.pulled).toBe(0);
    expect(result.summary.pushed).toBe(0);
    expect(result.summary.merged).toBe(0);
  });

  // ----- Case B: Local changes only -----

  it('pushes local-only changes', async () => {
    await github.setFiles([{ path: 'note.md', text: 'original' }]);
    let base = github.getBaseSnapshot();

    let files = new Map<Path, WorkingFile>();
    let originalContent = enc.encode('original');
    let originalSha = await blobSha(originalContent);
    // Keep note.md unchanged in base, but modify locally
    files.set(toPath('note.md'), makeWorkingFile('note.md', 'modified locally'));

    let state = makeRepoState({
      base,
      remoteSnapshot: { ...base, remoteCommit: base.baseCommit },
      workingFiles: files,
    });

    let result = await performSync(state, github);
    expect(result.summary.pushed).toBe(1);
    expect(result.summary.pulled).toBe(0);
    // Base should be updated to the new commit
    expect(result.state.base.baseCommit).not.toBe(base.baseCommit);
  });

  it('pushes new files to empty remote', async () => {
    // Empty remote (no commits)
    let files = new Map<Path, WorkingFile>();
    files.set(toPath('first.md'), makeWorkingFile('first.md', 'my first note'));

    let state = makeRepoState({ workingFiles: files });

    let result = await performSync(state, github);
    expect(result.summary.pushed).toBe(1);
    expect(result.state.base.baseCommit).not.toBeNull();
  });

  it('pushes locally deleted files', async () => {
    await github.setFiles([
      { path: 'keep.md', text: 'keep me' },
      { path: 'remove.md', text: 'delete me' },
    ]);
    let base = github.getBaseSnapshot();

    // Only keep one file locally
    let keepContent = enc.encode('keep me');
    let keepSha = await blobSha(keepContent);
    let files = new Map<Path, WorkingFile>();
    files.set(toPath('keep.md'), makeWorkingFile('keep.md', 'keep me', keepSha));

    let state = makeRepoState({
      base,
      remoteSnapshot: { ...base, remoteCommit: base.baseCommit },
      workingFiles: files,
    });

    let result = await performSync(state, github);
    expect(result.summary.deletedRemote).toBe(1);
    expect(result.state.base.entries.has(toPath('remove.md'))).toBe(false);
  });

  // ----- Case C: Remote changes only -----

  it('pulls remote-only changes', async () => {
    await github.setFiles([{ path: 'note.md', text: 'original' }]);
    let base = github.getBaseSnapshot();

    // Set up local state matching the base
    let originalContent = enc.encode('original');
    let originalSha = await blobSha(originalContent);
    let files = new Map<Path, WorkingFile>();
    files.set(toPath('note.md'), makeWorkingFile('note.md', 'original', originalSha));

    // Simulate external push
    await github.externalPush([{ path: 'note.md', text: 'updated remotely' }]);

    let state = makeRepoState({
      base,
      remoteSnapshot: { ...base, remoteCommit: base.baseCommit },
      workingFiles: files,
    });

    let result = await performSync(state, github);
    expect(result.summary.pulled).toBe(1);
    expect(result.summary.pushed).toBe(0);

    // Working file should have the remote content
    let updated = result.state.workingFiles.get(toPath('note.md'));
    expect(updated).toBeDefined();
    expect(dec.decode(updated!.content)).toBe('updated remotely');
  });

  it('pulls new remote files', async () => {
    await github.setFiles([{ path: 'existing.md', text: 'existing' }]);
    let base = github.getBaseSnapshot();

    let existingContent = enc.encode('existing');
    let existingSha = await blobSha(existingContent);
    let files = new Map<Path, WorkingFile>();
    files.set(toPath('existing.md'), makeWorkingFile('existing.md', 'existing', existingSha));

    // External push adds a new file
    await github.externalPush([{ path: 'new-remote.md', text: 'new from remote' }]);

    let state = makeRepoState({
      base,
      remoteSnapshot: { ...base, remoteCommit: base.baseCommit },
      workingFiles: files,
    });

    let result = await performSync(state, github);
    expect(result.summary.pulled).toBe(1);
    expect(result.state.workingFiles.has(toPath('new-remote.md'))).toBe(true);
    let newFile = result.state.workingFiles.get(toPath('new-remote.md'))!;
    expect(dec.decode(newFile.content)).toBe('new from remote');
  });

  it('handles remote deletions', async () => {
    await github.setFiles([
      { path: 'keep.md', text: 'keep' },
      { path: 'gone.md', text: 'will be deleted' },
    ]);
    let base = github.getBaseSnapshot();

    let keepContent = enc.encode('keep');
    let keepSha = await blobSha(keepContent);
    let goneContent = enc.encode('will be deleted');
    let goneSha = await blobSha(goneContent);
    let files = new Map<Path, WorkingFile>();
    files.set(toPath('keep.md'), makeWorkingFile('keep.md', 'keep', keepSha));
    files.set(toPath('gone.md'), makeWorkingFile('gone.md', 'will be deleted', goneSha));

    // Remote deletes 'gone.md'
    await github.externalDelete(['gone.md']);

    let state = makeRepoState({
      base,
      remoteSnapshot: { ...base, remoteCommit: base.baseCommit },
      workingFiles: files,
    });

    let result = await performSync(state, github);
    expect(result.summary.deletedLocal).toBe(1);
    expect(result.state.workingFiles.has(toPath('gone.md'))).toBe(false);
  });

  // ----- Case C: Both changed — merge -----

  it('merges markdown when both sides changed', async () => {
    await github.setFiles([{ path: 'note.md', text: 'line 1\nline 2\nline 3' }]);
    let base = github.getBaseSnapshot();

    // Local changes: modify line 2
    let files = new Map<Path, WorkingFile>();
    files.set(toPath('note.md'), makeWorkingFile('note.md', 'line 1\nlocal change\nline 3'));

    // Remote changes: modify line 3
    await github.externalPush([{ path: 'note.md', text: 'line 1\nline 2\nremote change' }]);

    let state = makeRepoState({
      base,
      remoteSnapshot: { ...base, remoteCommit: base.baseCommit },
      workingFiles: files,
    });

    let result = await performSync(state, github);
    expect(result.summary.merged).toBe(1);
    // The merged content should have both changes
    let merged = result.state.workingFiles.get(toPath('note.md'));
    expect(merged).toBeDefined();
    let mergedText = dec.decode(merged!.content);
    expect(mergedText).toContain('local change');
    expect(mergedText).toContain('remote change');
  });

  it('remote wins for binary conflicts', async () => {
    await github.setFiles([{ path: 'image.png', text: 'original-binary' }]);
    let base = github.getBaseSnapshot();

    // Local changes to binary
    let files = new Map<Path, WorkingFile>();
    files.set(toPath('image.png'), makeWorkingFile('image.png', 'local-binary'));

    // Remote changes to binary
    await github.externalPush([{ path: 'image.png', text: 'remote-binary' }]);

    let state = makeRepoState({
      base,
      remoteSnapshot: { ...base, remoteCommit: base.baseCommit },
      workingFiles: files,
    });

    let result = await performSync(state, github);
    expect(result.summary.pulled).toBe(1);
    let updated = result.state.workingFiles.get(toPath('image.png'));
    expect(dec.decode(updated!.content)).toBe('remote-binary');
  });

  it('keeps locally modified file when remote deletes it', async () => {
    await github.setFiles([{ path: 'note.md', text: 'original' }]);
    let base = github.getBaseSnapshot();

    // Local modification
    let files = new Map<Path, WorkingFile>();
    files.set(toPath('note.md'), makeWorkingFile('note.md', 'locally modified'));

    // Remote deletion
    await github.externalDelete(['note.md']);

    let state = makeRepoState({
      base,
      remoteSnapshot: { ...base, remoteCommit: base.baseCommit },
      workingFiles: files,
    });

    let result = await performSync(state, github);
    // Should keep the local file and push it back
    expect(result.state.workingFiles.has(toPath('note.md'))).toBe(true);
    expect(result.summary.pushed).toBeGreaterThanOrEqual(1);
  });

  // ----- Race condition handling -----

  it('retries on race condition', async () => {
    await github.setFiles([{ path: 'note.md', text: 'original' }]);
    let base = github.getBaseSnapshot();

    let files = new Map<Path, WorkingFile>();
    files.set(toPath('note.md'), makeWorkingFile('note.md', 'local edit'));

    let state = makeRepoState({
      base,
      remoteSnapshot: { ...base, remoteCommit: base.baseCommit },
      workingFiles: files,
    });

    // Make the first ref update fail
    github.simulateRace();

    let result = await performSync(state, github);
    // Should still succeed after retry
    expect(result.summary.pushed).toBe(1);
    expect(result.state.base.baseCommit).not.toBe(base.baseCommit);
  });

  // ----- Mixed scenarios -----

  it('handles simultaneous add and remote changes', async () => {
    await github.setFiles([{ path: 'existing.md', text: 'existing' }]);
    let base = github.getBaseSnapshot();

    let existingContent = enc.encode('existing');
    let existingSha = await blobSha(existingContent);
    let files = new Map<Path, WorkingFile>();
    files.set(toPath('existing.md'), makeWorkingFile('existing.md', 'existing', existingSha));
    // Add a new local file
    files.set(toPath('new-local.md'), makeWorkingFile('new-local.md', 'new local content'));

    // Remote modifies existing
    await github.externalPush([{ path: 'existing.md', text: 'remote update' }]);

    let state = makeRepoState({
      base,
      remoteSnapshot: { ...base, remoteCommit: base.baseCommit },
      workingFiles: files,
    });

    let result = await performSync(state, github);
    // Should pull the remote change and push the new local file
    expect(result.summary.pulled).toBe(1);
    expect(result.summary.pushed).toBe(1);
    expect(dec.decode(result.state.workingFiles.get(toPath('existing.md'))!.content)).toBe('remote update');
    expect(result.state.workingFiles.has(toPath('new-local.md'))).toBe(true);
  });

  it('increments version after sync', async () => {
    await github.setFiles([{ path: 'note.md', text: 'content' }]);
    let base = github.getBaseSnapshot();

    let content = enc.encode('content');
    let sha = await blobSha(content);
    let files = new Map<Path, WorkingFile>();
    files.set(toPath('note.md'), makeWorkingFile('note.md', 'content', sha));

    let state = makeRepoState({
      base,
      remoteSnapshot: { ...base, remoteCommit: base.baseCommit },
      workingFiles: files,
      version: 5,
    });

    let result = await performSync(state, github);
    expect(result.state.version).toBeGreaterThan(5);
  });

  it('clears merge state after successful sync', async () => {
    await github.setFiles([{ path: 'note.md', text: 'original' }]);
    let base = github.getBaseSnapshot();

    let files = new Map<Path, WorkingFile>();
    files.set(toPath('note.md'), makeWorkingFile('note.md', 'modified'));

    let state = makeRepoState({
      base,
      remoteSnapshot: { ...base, remoteCommit: base.baseCommit },
      workingFiles: files,
      merge: {
        inProgress: true,
        conflictedPaths: new Set([toPath('old-conflict.md')]),
        targetCommit: toSha('old-target'),
      },
    });

    let result = await performSync(state, github);
    expect(result.state.merge.inProgress).toBe(false);
    expect(result.state.merge.conflictedPaths.size).toBe(0);
  });
});
