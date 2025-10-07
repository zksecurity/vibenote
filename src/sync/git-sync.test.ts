import { beforeEach, describe, expect, test, vi } from 'vitest';
import { LocalStore, listTombstones } from '../storage/local';
import { MockRemoteRepo } from '../test/mock-remote';

const authModule = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn().mockResolvedValue('test-token'),
}));

vi.mock('../auth/app-auth', () => authModule);

const globalAny = globalThis as {
  fetch?: typeof fetch;
};

describe('syncBidirectional', () => {
  let store: LocalStore;
  let remote: MockRemoteRepo;
  let syncBidirectional: typeof import('./git-sync').syncBidirectional;

  beforeEach(async () => {
    authModule.ensureFreshAccessToken.mockReset();
    authModule.ensureFreshAccessToken.mockResolvedValue('test-token');
    remote = new MockRemoteRepo();
    remote.configure('user', 'repo');
    remote.allowToken('test-token');
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      remote.handleFetch(input, init)
    );
    globalAny.fetch = fetchMock as unknown as typeof fetch;
    const mod = await import('./git-sync');
    syncBidirectional = mod.syncBidirectional;
    store = new LocalStore('user/repo');
  });

  test('pushes new notes and remains stable', async () => {
    const firstId = store.createNote('First', 'first note');
    const secondId = store.createNote('Second', 'second note');
    await syncBidirectional(store, 'user/repo');
    await syncBidirectional(store, 'user/repo');
    expectParity(store, remote);
    expect(listTombstones(store.slug)).toHaveLength(0);
    const firstDoc = store.loadNote(firstId);
    const secondDoc = store.loadNote(secondId);
    expect(firstDoc?.path).toBe('First.md');
    expect(secondDoc?.path).toBe('Second.md');
  });

  test('applies local deletions to remote without resurrection', async () => {
    const id = store.createNote('Ghost', 'haunt me');
    await syncBidirectional(store, 'user/repo');
    store.deleteNote(id);
    await syncBidirectional(store, 'user/repo');
    expectParity(store, remote);
    expect(store.listNotes()).toHaveLength(0);
    expect(listTombstones(store.slug)).toHaveLength(0);
  });

  test('renames move files remotely', async () => {
    const id = store.createNote('Original', 'rename me');
    await syncBidirectional(store, 'user/repo');
    store.renameNote(id, 'Renamed');
    await syncBidirectional(store, 'user/repo');
    expectParity(store, remote);
    const notes = store.listNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.path).toBe('Renamed.md');
    expect([...remote.snapshot().keys()]).toEqual(['Renamed.md']);
  });

  test('rename removes old remote path after prior sync', async () => {
    const id = store.createNote('test', 'body');
    await syncBidirectional(store, 'user/repo');
    expect([...remote.snapshot().keys()]).toEqual(['test.md']);
    store.renameNote(id, 'test2');
    await syncBidirectional(store, 'user/repo');
    const remoteFiles = [...remote.snapshot().keys()].sort();
    expect(remoteFiles).toEqual(['test2.md']);
    expectParity(store, remote);
  });

  test('rename with remote edits keeps both copies in sync', async () => {
    const id = store.createNote('draft', 'original body');
    await syncBidirectional(store, 'user/repo');
    remote.setFile('draft.md', 'remote update');
    store.renameNote(id, 'draft-renamed');
    await syncBidirectional(store, 'user/repo');
    const paths = [...remote.snapshot().keys()].sort();
    expect(paths).toEqual(['draft-renamed.md', 'draft.md']);
    expectParity(store, remote);
    const localPaths = store
      .listNotes()
      .map((n) => n.path)
      .sort();
    expect(localPaths).toEqual(['draft-renamed.md', 'draft.md']);
  });

  test('pulls new remote notes', async () => {
    remote.setFile('Remote.md', '# remote');
    await syncBidirectional(store, 'user/repo');
    expectParity(store, remote);
    const notes = store.listNotes();
    expect(notes).toHaveLength(1);
    const doc = store.loadNote(notes[0]?.id ?? '');
    expect(doc?.text).toBe('# remote');
  });

  test('removes notes when deleted remotely', async () => {
    const id = store.createNote('Shared', 'shared text');
    await syncBidirectional(store, 'user/repo');
    remote.deleteDirect('Shared.md');
    await syncBidirectional(store, 'user/repo');
    expectParity(store, remote);
    expect(store.listNotes()).toHaveLength(0);
  });

  test('ignores non-Markdown files when syncing', async () => {
    remote.setFile('data.json', '{"keep":true}');
    remote.setFile('image.png', 'binary');
    store.createNote('OnlyNote', '# hello');
    await syncBidirectional(store, 'user/repo');
    const snapshot = remote.snapshot();
    expect(snapshot.get('data.json')).toBe('{"keep":true}');
    expect(snapshot.get('image.png')).toBe('binary');
    expect(snapshot.get('OnlyNote.md')).toBe('# hello');
  });

  test('pulls nested Markdown files', async () => {
    remote.setFile('nested/Nested.md', '# nested');
    await syncBidirectional(store, 'user/repo');
    const notes = store.listNotes();
    expect(notes).toHaveLength(1);
    const doc = store.loadNote(notes[0]?.id ?? '');
    expect(doc?.path).toBe('nested/Nested.md');
    expect(doc?.dir).toBe('nested');
    expect(doc?.text).toBe('# nested');
  });

  test('listNoteFiles includes nested markdown', async () => {
    const mod = await import('./git-sync');
    remote.setFile('nested/Nested.md', '# nested');
    let cfg = mod.buildRemoteConfig('user/repo');
    let entries = await mod.listNoteFiles(cfg);
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(['nested/Nested.md']);
  });

  test('includes README.md files from the repository', async () => {
    remote.setFile('README.md', 'root readme');
    remote.setFile('sub/README.md', 'sub readme');
    await syncBidirectional(store, 'user/repo');
    const paths = store
      .listNotes()
      .map((n) => n.path)
      .sort();
    expect(paths).toEqual(['README.md', 'sub/README.md']);
  });
});

function expectParity(store: LocalStore, remote: MockRemoteRepo) {
  const localMap = new Map<string, string>();
  for (const meta of store.listNotes()) {
    const doc = store.loadNote(meta.id);
    if (doc) localMap.set(meta.path, doc.text);
  }
  const remoteMap = remote.snapshot();
  expect([...remoteMap.keys()].sort()).toEqual([...localMap.keys()].sort());
  for (const [path, text] of localMap.entries()) {
    expect(remoteMap.get(path)).toBe(text);
  }
}
