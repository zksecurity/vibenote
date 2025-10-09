import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { LocalStore, listTombstones, findBySyncedHash } from '../storage/local';
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
    const firstId = createMarkdown(store, 'First', 'first note');
    const secondId = createMarkdown(store, 'Second', 'second note');
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
    const id = createMarkdown(store, 'Ghost', 'haunt me');
    await syncBidirectional(store, 'user/repo');
    store.deleteNote(id);
    await syncBidirectional(store, 'user/repo');
    expectParity(store, remote);
    expect(store.listNotes()).toHaveLength(0);
    expect(listTombstones(store.slug)).toHaveLength(0);
  });

  test('renames move files remotely', async () => {
    const id = createMarkdown(store, 'Original', 'rename me');
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
    const id = createMarkdown(store, 'test', 'body');
    await syncBidirectional(store, 'user/repo');
    expect([...remote.snapshot().keys()]).toEqual(['test.md']);
    store.renameNote(id, 'test2');
    await syncBidirectional(store, 'user/repo');
    const remoteFiles = [...remote.snapshot().keys()].sort();
    expect(remoteFiles).toEqual(['test2.md']);
    expectParity(store, remote);
  });

  test('rename with remote edits keeps both copies in sync', async () => {
    const id = createMarkdown(store, 'draft', 'original body');
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
    expect(doc?.content).toBe('# remote');
  });

  test('removes notes when deleted remotely', async () => {
    const id = createMarkdown(store, 'Shared', 'shared text');
    await syncBidirectional(store, 'user/repo');
    remote.deleteDirect('Shared.md');
    await syncBidirectional(store, 'user/repo');
    expectParity(store, remote);
    expect(store.listNotes()).toHaveLength(0);
  });

  test('syncs tracked image files while ignoring unrelated blobs', async () => {
    remote.setFile('data.json', '{"keep":true}');
    remote.setFile('image.png', 'asset');
    createMarkdown(store, 'OnlyNote', '# hello');
    await syncBidirectional(store, 'user/repo');
    const snapshot = remote.snapshot();
    expect(snapshot.get('data.json')).toBe('{"keep":true}');
    expect(snapshot.get('image.png')).toBe('asset');
    expect(snapshot.get('OnlyNote.md')).toBe('# hello');
    const files = store.listFiles();
    const imageMeta = files.find((f) => f.path === 'image.png');
    expect(imageMeta).toBeDefined();
    if (imageMeta) {
      const imageDoc = store.loadFile(imageMeta.id);
      expect(imageDoc?.content).toBe(Buffer.from('asset', 'utf8').toString('base64'));
    }
    expectParity(store, remote);
  });

  test('pulls nested Markdown files', async () => {
    remote.setFile('nested/Nested.md', '# nested');
    await syncBidirectional(store, 'user/repo');
    const notes = store.listNotes();
    expect(notes).toHaveLength(1);
    const doc = store.loadNote(notes[0]?.id ?? '');
    expect(doc?.path).toBe('nested/Nested.md');
    expect(doc?.dir).toBe('nested');
    expect(doc?.content).toBe('# nested');
  });

  test('pulls binary image assets from remote', async () => {
    remote.setFile('assets/logo.png', 'image-data');
    await syncBidirectional(store, 'user/repo');
    const files = store.listFiles();
    const asset = files.find((f) => f.path === 'assets/logo.png');
    expect(asset).toBeDefined();
    if (!asset) return;
    const doc = store.loadFile(asset.id);
    expect(doc?.content).toBe(Buffer.from('image-data', 'utf8').toString('base64'));
    expect(doc?.kind ?? 'binary').toBe('binary');
    expectParity(store, remote);
  });

  test('tracks remote binary renames by sha/hash', async () => {
    const payload = Buffer.from('asset', 'utf8').toString('base64');
    const id = createBinary(store, 'logo.png', payload, 'image/png');
    await syncBidirectional(store, 'user/repo');
    const before = store.loadFile(id);
    expect(before?.lastSyncedHash).toBeDefined();
    remote.deleteDirect('logo.png');
    remote.setFile('assets/logo.png', payload);
    if (before?.lastSyncedHash) {
      const lookup = findBySyncedHash(store.slug, before.lastSyncedHash);
      expect(lookup?.id).toBe(id);
    }

    await syncBidirectional(store, 'user/repo');

    const paths = store.listFiles().map((f) => f.path).sort();
    expect(paths).toContain('assets/logo.png');
    expect(paths).not.toContain('logo.png');
    const renamedFile = store.listFiles().find((f) => f.path === 'assets/logo.png');
    expect(renamedFile).toBeDefined();
    expectParity(store, remote);
  });

  test('listNoteFiles includes nested markdown', async () => {
    const mod = await import('./git-sync');
    remote.setFile('nested/Nested.md', '# nested');
    let cfg = mod.buildRemoteConfig('user/repo');
    let entries = await mod.listNoteFiles(cfg);
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(['nested/Nested.md']);
  });

  test('listRepoFiles returns markdown and image entries', async () => {
    const mod = await import('./git-sync');
    remote.setFile('docs/Doc.md', '# hi');
    remote.setFile('assets/logo.png', 'img');
    let cfg = mod.buildRemoteConfig('user/repo');
    let entries = await mod.listRepoFiles(cfg);
    const byPath = new Map(entries.map((entry) => [entry.path, entry.kind]));
    expect(byPath.get('docs/Doc.md')).toBe('markdown');
    expect(byPath.get('assets/logo.png')).toBe('binary');
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
  for (const meta of store.listFiles()) {
    const doc = store.loadFile(meta.id);
    if (!doc) continue;
    if (doc.kind === 'binary') {
      const decoded = Buffer.from(doc.content, 'base64').toString('utf8');
      localMap.set(meta.path, decoded);
    } else {
      localMap.set(meta.path, doc.content);
    }
  }
  const remoteMap = remote.snapshot();
  const trackedRemoteKeys = [...remoteMap.keys()].filter(isTrackedPath).sort();
  expect(trackedRemoteKeys).toEqual([...localMap.keys()].sort());
  for (const [path, text] of localMap.entries()) {
    expect(remoteMap.get(path)).toBe(text);
  }
}

function isTrackedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith('.md') ||
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.gif') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.svg') ||
    lower.endsWith('.avif')
  );
}
function createMarkdown(store: LocalStore, title: string, text: string, dir = '') {
  return store.createFile({
    path: dir ? `${dir}/${title}.md` : `${title}.md`,
    dir,
    title,
    content: text,
    kind: 'markdown',
    mime: 'text/markdown',
  });
}

function createBinary(store: LocalStore, path: string, base64: string, mime: string) {
  return store.createFile({ path, content: base64, kind: 'binary', mime });
}
