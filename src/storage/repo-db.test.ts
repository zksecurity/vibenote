// Tests for IndexedDB-backed repo state storage (repo-db.ts).
// Uses fake-indexeddb to run in Node.js without a real browser.
import 'fake-indexeddb/auto';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createRepoDb } from './repo-db';
import type { RepoDb } from './repo-db';
import type { RepoState, WorkingFile, Path, GitSha } from './repo-types';

// Each test gets a unique DB name to guarantee isolation.
let dbCounter = 0;
function freshDbName(): string {
  return `test-vibenote-${++dbCounter}`;
}

// --- Helpers to build typed values ---

function toPath(s: string): Path {
  return s as Path;
}

function toGitSha(s: string): GitSha {
  // Pad to 40 chars so it looks like a real SHA
  return s.padEnd(40, '0') as GitSha;
}

/** Build a minimal valid RepoState for testing. */
function makeRepoState(repoId = 'owner/repo', overrides: Partial<RepoState> = {}): RepoState {
  return {
    repoId,
    remote: { name: 'origin', url: `https://github.com/${repoId}.git` },
    branch: {
      head: { name: 'refs/heads/main', sha: null },
    },
    base: {
      rootTree: toGitSha('basetree'),
      entries: new Map(),
      baseCommit: null,
    },
    remoteSnapshot: {
      rootTree: toGitSha('remotetree'),
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
    version: 1,
    ...overrides,
  };
}

/** Build a minimal WorkingFile with the given text content. */
function makeWorkingFile(path: string, text: string): WorkingFile {
  const content = new TextEncoder().encode(text);
  return {
    path: toPath(path),
    mode: '100644',
    content,
    size: content.byteLength,
    mtime: 1000,
  };
}

// --- Test suite ---

let db: RepoDb;

beforeEach(async () => {
  db = await createRepoDb(freshDbName());
});

afterEach(() => {
  db.close();
});

describe('saveRepoState / loadRepoState', () => {
  test('roundtrip: empty state', async () => {
    const state = makeRepoState();
    await db.saveRepoState(state);
    const loaded = await db.loadRepoState(state.repoId);
    expect(loaded).toBeDefined();
    expect(loaded!.repoId).toBe(state.repoId);
    expect(loaded!.remote.url).toBe(state.remote.url);
    expect(loaded!.branch.head.name).toBe('refs/heads/main');
    expect(loaded!.branch.head.sha).toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.workingFiles.size).toBe(0);
    expect(loaded!.merge.inProgress).toBe(false);
  });

  test('roundtrip: preserves snapshot entries', async () => {
    const p = toPath('notes/hello.md');
    const sha = toGitSha('abc123');
    const state = makeRepoState('o/r', {
      base: {
        rootTree: toGitSha('roottree'),
        entries: new Map([[p, { mode: '100644', sha }]]),
        baseCommit: toGitSha('basecommit'),
      },
      remoteSnapshot: {
        rootTree: toGitSha('remotetree'),
        entries: new Map([[p, { mode: '100755', sha: toGitSha('exec') }]]),
        remoteCommit: toGitSha('remotecommit'),
      },
    });
    await db.saveRepoState(state);
    const loaded = await db.loadRepoState('o/r');
    expect(loaded).toBeDefined();

    const baseEntry = loaded!.base.entries.get(p);
    expect(baseEntry).toBeDefined();
    expect(baseEntry!.mode).toBe('100644');
    expect(baseEntry!.sha).toBe(sha);
    expect(loaded!.base.baseCommit).toBe(toGitSha('basecommit'));

    const remoteEntry = loaded!.remoteSnapshot.entries.get(p);
    expect(remoteEntry!.mode).toBe('100755');
    expect(loaded!.remoteSnapshot.remoteCommit).toBe(toGitSha('remotecommit'));
  });

  test('roundtrip: working files with content', async () => {
    const file = makeWorkingFile('notes/hello.md', '# Hello world');
    const state = makeRepoState('o/r', {
      workingFiles: new Map([[file.path, file]]),
    });
    await db.saveRepoState(state);
    const loaded = await db.loadRepoState('o/r');
    expect(loaded).toBeDefined();
    expect(loaded!.workingFiles.size).toBe(1);
    const loadedFile = loaded!.workingFiles.get(toPath('notes/hello.md'));
    expect(loadedFile).toBeDefined();
    expect(new TextDecoder().decode(loadedFile!.content)).toBe('# Hello world');
    expect(loadedFile!.mode).toBe('100644');
    expect(loadedFile!.size).toBe(file.size);
    expect(loadedFile!.mtime).toBe(1000);
  });

  test('roundtrip: binary file content (Uint8Array)', async () => {
    const content = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG magic bytes
    const file: WorkingFile = {
      path: toPath('img/logo.png'),
      mode: '100644',
      content,
      size: content.byteLength,
    };
    const state = makeRepoState('o/r', { workingFiles: new Map([[file.path, file]]) });
    await db.saveRepoState(state);
    const loaded = await db.loadRepoState('o/r');
    const loadedFile = loaded!.workingFiles.get(toPath('img/logo.png'));
    expect(loadedFile).toBeDefined();
    expect(Array.from(loadedFile!.content)).toEqual(Array.from(content));
  });

  test('roundtrip: merge state with conflicted paths', async () => {
    const p1 = toPath('a.md');
    const p2 = toPath('b.md');
    const state = makeRepoState('o/r', {
      merge: {
        inProgress: true,
        targetCommit: toGitSha('target'),
        conflictedPaths: new Set([p1, p2]),
      },
    });
    await db.saveRepoState(state);
    const loaded = await db.loadRepoState('o/r');
    expect(loaded!.merge.inProgress).toBe(true);
    expect(loaded!.merge.targetCommit).toBe(toGitSha('target'));
    expect(loaded!.merge.conflictedPaths.has(p1)).toBe(true);
    expect(loaded!.merge.conflictedPaths.has(p2)).toBe(true);
    expect(loaded!.merge.conflictedPaths.size).toBe(2);
  });

  test('roundtrip: conflict payloads (Uint8Array fields)', async () => {
    const p = toPath('conflict.md');
    const base = new TextEncoder().encode('base content');
    const ours = new TextEncoder().encode('our content');
    const theirs = new TextEncoder().encode('their content');
    const state = makeRepoState('o/r', {
      merge: {
        inProgress: true,
        conflictedPaths: new Set([p]),
        conflicts: new Map([[p, { base, ours, theirs }]]),
      },
    });
    await db.saveRepoState(state);
    const loaded = await db.loadRepoState('o/r');
    const conflict = loaded!.merge.conflicts?.get(p);
    expect(conflict).toBeDefined();
    expect(new TextDecoder().decode(conflict!.base)).toBe('base content');
    expect(new TextDecoder().decode(conflict!.ours)).toBe('our content');
    expect(new TextDecoder().decode(conflict!.theirs)).toBe('their content');
  });

  test('roundtrip: status map', async () => {
    const p = toPath('modified.md');
    const state = makeRepoState('o/r', {
      status: new Map([
        [p, { path: p, status: 'modified', mode: '100644', headSha: toGitSha('head') }],
      ]),
    });
    await db.saveRepoState(state);
    const loaded = await db.loadRepoState('o/r');
    const entry = loaded!.status.get(p);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('modified');
    expect(entry!.headSha).toBe(toGitSha('head'));
  });

  test('roundtrip: hash cache', async () => {
    const state = makeRepoState('o/r', {
      hashCache: {
        entries: new Map([
          ['path|100|999', toGitSha('blobsha')],
        ]),
      },
    });
    await db.saveRepoState(state);
    const loaded = await db.loadRepoState('o/r');
    expect(loaded!.hashCache.entries.get('path|100|999')).toBe(toGitSha('blobsha'));
  });

  test('roundtrip: branch with upstream', async () => {
    const state = makeRepoState('o/r', {
      branch: {
        head: { name: 'refs/heads/feature', sha: toGitSha('headsha') },
        upstream: { name: 'refs/remotes/origin/feature', sha: toGitSha('remotesha') },
      },
    });
    await db.saveRepoState(state);
    const loaded = await db.loadRepoState('o/r');
    expect(loaded!.branch.head.name).toBe('refs/heads/feature');
    expect(loaded!.branch.head.sha).toBe(toGitSha('headsha'));
    expect(loaded!.branch.upstream?.name).toBe('refs/remotes/origin/feature');
    expect(loaded!.branch.upstream?.sha).toBe(toGitSha('remotesha'));
  });

  test('overwrite: second save replaces first', async () => {
    const state1 = makeRepoState('o/r', { version: 1 });
    const state2 = makeRepoState('o/r', { version: 2 });
    await db.saveRepoState(state1);
    await db.saveRepoState(state2);
    const loaded = await db.loadRepoState('o/r');
    expect(loaded!.version).toBe(2);
  });

  test('overwrite: removed working file is not present after re-save', async () => {
    const file = makeWorkingFile('old.md', 'old');
    await db.saveRepoState(makeRepoState('o/r', { workingFiles: new Map([[file.path, file]]) }));

    // Second save with empty workingFiles
    await db.saveRepoState(makeRepoState('o/r', { workingFiles: new Map() }));
    const loaded = await db.loadRepoState('o/r');
    expect(loaded!.workingFiles.size).toBe(0);
  });

  test('returns undefined for unknown repoId', async () => {
    const result = await db.loadRepoState('nobody/nothing');
    expect(result).toBeUndefined();
  });
});

describe('multiple repos isolation', () => {
  test('repos do not bleed into each other', async () => {
    const stateA = makeRepoState('alice/notes', { version: 10 });
    const stateB = makeRepoState('bob/notes', { version: 20 });
    await db.saveRepoState(stateA);
    await db.saveRepoState(stateB);

    const loadedA = await db.loadRepoState('alice/notes');
    const loadedB = await db.loadRepoState('bob/notes');
    expect(loadedA!.version).toBe(10);
    expect(loadedB!.version).toBe(20);
  });

  test('working files from different repos are isolated', async () => {
    const fileA = makeWorkingFile('note.md', 'alice content');
    const fileB = makeWorkingFile('note.md', 'bob content');
    await db.saveRepoState(makeRepoState('alice/r', { workingFiles: new Map([[fileA.path, fileA]]) }));
    await db.saveRepoState(makeRepoState('bob/r', { workingFiles: new Map([[fileB.path, fileB]]) }));

    const loadedA = await db.loadRepoState('alice/r');
    const loadedB = await db.loadRepoState('bob/r');
    const fa = loadedA!.workingFiles.get(toPath('note.md'));
    const fb = loadedB!.workingFiles.get(toPath('note.md'));
    expect(new TextDecoder().decode(fa!.content)).toBe('alice content');
    expect(new TextDecoder().decode(fb!.content)).toBe('bob content');
  });

  test('deleting one repo does not affect another', async () => {
    await db.saveRepoState(makeRepoState('alice/r'));
    await db.saveRepoState(makeRepoState('bob/r'));
    await db.deleteRepo('alice/r');
    expect(await db.loadRepoState('alice/r')).toBeUndefined();
    expect(await db.loadRepoState('bob/r')).toBeDefined();
  });
});

describe('deleteRepo', () => {
  test('removes all data for the repo', async () => {
    const file = makeWorkingFile('a.md', 'text');
    const state = makeRepoState('o/r', {
      workingFiles: new Map([[file.path, file]]),
      merge: {
        inProgress: false,
        conflictedPaths: new Set([file.path]),
        conflicts: new Map([[file.path, { base: new TextEncoder().encode('base') }]]),
      },
    });
    await db.saveRepoState(state);
    await db.deleteRepo('o/r');
    expect(await db.loadRepoState('o/r')).toBeUndefined();
    expect(await db.listWorkingFilesMeta('o/r')).toEqual([]);
  });
});

describe('listRepoIds', () => {
  test('returns all stored repo IDs', async () => {
    await db.saveRepoState(makeRepoState('alice/notes'));
    await db.saveRepoState(makeRepoState('bob/diary'));
    const ids = await db.listRepoIds();
    expect(ids.sort()).toEqual(['alice/notes', 'bob/diary']);
  });

  test('returns empty array when no repos are stored', async () => {
    const ids = await db.listRepoIds();
    expect(ids).toEqual([]);
  });
});

describe('individual file operations', () => {
  test('saveWorkingFile / loadWorkingFile roundtrip', async () => {
    // Need a repo state to exist first, but individual file ops are independent
    const file = makeWorkingFile('notes/hello.md', '# Hello');
    await db.saveWorkingFile('owner/repo', file);
    const loaded = await db.loadWorkingFile('owner/repo', toPath('notes/hello.md'));
    expect(loaded).toBeDefined();
    expect(new TextDecoder().decode(loaded!.content)).toBe('# Hello');
    expect(loaded!.mode).toBe('100644');
    expect(loaded!.size).toBe(file.size);
  });

  test('loadWorkingFile returns undefined for unknown path', async () => {
    const result = await db.loadWorkingFile('owner/repo', toPath('not/there.md'));
    expect(result).toBeUndefined();
  });

  test('saveWorkingFile updates an existing file', async () => {
    const path = toPath('doc.md');
    const v1 = { ...makeWorkingFile('doc.md', 'v1'), mtime: 100 };
    const v2Bytes = new TextEncoder().encode('v2');
    const v2: WorkingFile = { path, mode: '100644', content: v2Bytes, size: v2Bytes.byteLength, mtime: 200 };

    await db.saveWorkingFile('o/r', v1);
    await db.saveWorkingFile('o/r', v2);
    const loaded = await db.loadWorkingFile('o/r', path);
    expect(new TextDecoder().decode(loaded!.content)).toBe('v2');
    expect(loaded!.mtime).toBe(200);
  });

  test('deleteWorkingFile removes the file', async () => {
    const file = makeWorkingFile('bye.md', 'goodbye');
    await db.saveWorkingFile('o/r', file);
    await db.deleteWorkingFile('o/r', toPath('bye.md'));
    const result = await db.loadWorkingFile('o/r', toPath('bye.md'));
    expect(result).toBeUndefined();
  });

  test('deleteWorkingFile is a no-op for unknown path', async () => {
    // Should not throw
    await db.deleteWorkingFile('o/r', toPath('ghost.md'));
  });

  test('listWorkingFilesMeta returns metadata without content', async () => {
    const f1 = makeWorkingFile('a.md', 'alpha');
    const f2 = makeWorkingFile('b.md', 'beta');
    await db.saveWorkingFile('o/r', f1);
    await db.saveWorkingFile('o/r', f2);
    const metas = await db.listWorkingFilesMeta('o/r');
    expect(metas).toHaveLength(2);
    const paths = metas.map((m) => m.path).sort();
    expect(paths).toEqual(['a.md', 'b.md']);
    // No content field on metadata
    for (const m of metas) {
      expect('content' in m).toBe(false);
    }
  });

  test('listWorkingFilesMeta returns empty array for unknown repo', async () => {
    const metas = await db.listWorkingFilesMeta('nobody/nothing');
    expect(metas).toEqual([]);
  });

  test('individual file saves are isolated by repoId', async () => {
    const file = makeWorkingFile('shared.md', 'repo-a');
    await db.saveWorkingFile('a/r', file);
    const result = await db.loadWorkingFile('b/r', toPath('shared.md'));
    expect(result).toBeUndefined();
  });
});

describe('config and misc fields', () => {
  test('roundtrip: eol config', async () => {
    const state = makeRepoState('o/r', { config: { eol: 'lf', caseSensitive: true } });
    await db.saveRepoState(state);
    const loaded = await db.loadRepoState('o/r');
    expect(loaded!.config.eol).toBe('lf');
    expect(loaded!.config.caseSensitive).toBe(true);
  });

  test('roundtrip: locks', async () => {
    const state = makeRepoState('o/r', { locks: { sync: true, index: false } });
    await db.saveRepoState(state);
    const loaded = await db.loadRepoState('o/r');
    expect(loaded!.locks?.sync).toBe(true);
    expect(loaded!.locks?.index).toBe(false);
  });

  test('roundtrip: index entries', async () => {
    const p = toPath('merge.md');
    const state = makeRepoState('o/r', {
      index: {
        entries: new Map([
          [
            p,
            [
              { path: p, mode: '100644', stage: 1, sha: toGitSha('base') },
              { path: p, mode: '100644', stage: 2, sha: toGitSha('ours') },
              { path: p, mode: '100644', stage: 3, sha: toGitSha('theirs') },
            ],
          ],
        ]),
      },
    });
    await db.saveRepoState(state);
    const loaded = await db.loadRepoState('o/r');
    const entries = loaded!.index.entries.get(p);
    expect(entries).toHaveLength(3);
    expect(entries![0]!.stage).toBe(1);
    expect(entries![1]!.stage).toBe(2);
    expect(entries![2]!.stage).toBe(3);
    expect(entries![0]!.sha).toBe(toGitSha('base'));
  });
});
