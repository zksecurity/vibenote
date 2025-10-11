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
    const firstId = store.createFile('First.md', 'first note');
    const secondId = store.createFile('Second.md', 'second note');
    await syncBidirectional(store, 'user/repo');
    await syncBidirectional(store, 'user/repo');
    expectParity(store, remote);
    expect(listTombstones(store.slug)).toHaveLength(0);
    const firstDoc = store.loadFileById(firstId);
    const secondDoc = store.loadFileById(secondId);
    expect(firstDoc?.path).toBe('First.md');
    expect(secondDoc?.path).toBe('Second.md');
  });

  test('applies local deletions to remote without resurrection', async () => {
    store.createFile('Ghost.md', 'haunt me');
    await syncBidirectional(store, 'user/repo');
    store.deleteFile('Ghost.md');
    await syncBidirectional(store, 'user/repo');
    expectParity(store, remote);
    expect(store.listFiles()).toHaveLength(0);
    expect(listTombstones(store.slug)).toHaveLength(0);
  });

  test('renames move files remotely', async () => {
    store.createFile('Original.md', 'rename me');
    await syncBidirectional(store, 'user/repo');
    store.renameFile('Original.md', 'Renamed');
    await syncBidirectional(store, 'user/repo');
    expectParity(store, remote);
    const notes = store.listFiles();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.path).toBe('Renamed.md');
    expect([...remote.snapshot().keys()]).toEqual(['Renamed.md']);
  });

  test('rename removes old remote path after prior sync', async () => {
    store.createFile('test.md', 'body');
    await syncBidirectional(store, 'user/repo');
    expect([...remote.snapshot().keys()]).toEqual(['test.md']);
    store.renameFile('test.md', 'test2');
    await syncBidirectional(store, 'user/repo');
    const remoteFiles = [...remote.snapshot().keys()].sort();
    expect(remoteFiles).toEqual(['test2.md']);
    expectParity(store, remote);
  });

  test('rename with remote edits keeps both copies in sync', async () => {
    store.createFile('draft.md', 'original body');
    await syncBidirectional(store, 'user/repo');
    remote.setFile('draft.md', 'remote update');
    store.renameFile('draft.md', 'draft-renamed');
    await syncBidirectional(store, 'user/repo');
    const paths = [...remote.snapshot().keys()].sort();
    expect(paths).toEqual(['draft-renamed.md', 'draft.md']);
    expectParity(store, remote);
    const localPaths = store
      .listFiles()
      .map((n) => n.path)
      .sort();
    expect(localPaths).toEqual(['draft-renamed.md', 'draft.md']);
  });

  test('rename revert does not push redundant commits', async () => {
    store.createFile('first-name.md', 'body');
    await syncBidirectional(store, 'user/repo');
    const headBeforeRename = await getRemoteHeadSha(remote);

    store.renameFile('first-name.md', 'second-name');
    store.renameFile('second-name.md', 'first-name');

    await syncBidirectional(store, 'user/repo');

    const headAfterSync = await getRemoteHeadSha(remote);
    expect(headAfterSync).toBe(headBeforeRename);
    expectParity(store, remote);
  });

  test('pulls new remote notes', async () => {
    remote.setFile('Remote.md', '# remote');
    await syncBidirectional(store, 'user/repo');
    expectParity(store, remote);
    const notes = store.listFiles();
    expect(notes).toHaveLength(1);
    const doc = store.loadFileById(notes[0]?.id ?? '');
    expect(doc?.content).toBe('# remote');
  });

  test('removes notes when deleted remotely', async () => {
    store.createFile('Shared.md', 'shared text');
    await syncBidirectional(store, 'user/repo');
    remote.deleteDirect('Shared.md');
    await syncBidirectional(store, 'user/repo');
    expectParity(store, remote);
    expect(store.listFiles()).toHaveLength(0);
  });

  test('syncs tracked image files while ignoring unrelated blobs', async () => {
    remote.setFile('data.json', '{"keep":true}');
    remote.setFile('image.png', 'asset');
    store.createFile('OnlyNote.md', '# hello');
    await syncBidirectional(store, 'user/repo');
    const snapshot = remote.snapshot();
    expect(snapshot.get('data.json')).toBe('{"keep":true}');
    expect(snapshot.get('image.png')).toBe('asset');
    expect(snapshot.get('OnlyNote.md')).toBe('# hello');
    const files = store.listFiles();
    const imageMeta = files.find((f) => f.path === 'image.png');
    expect(imageMeta).toBeDefined();
    if (imageMeta) {
      const imageDoc = store.loadFileById(imageMeta.id);
      expect(imageDoc?.kind).toBe('asset-url');
      expect(imageDoc?.content).toMatch(/^gh-blob:/);
    }
    expectParity(store, remote);
  });

  test('pulls nested Markdown files', async () => {
    remote.setFile('nested/Nested.md', '# nested');
    await syncBidirectional(store, 'user/repo');
    const notes = store.listFiles();
    expect(notes).toHaveLength(1);
    const doc = store.loadFileById(notes[0]?.id ?? '');
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
    const doc = store.loadFileById(asset.id);
    expect(doc?.kind).toBe('asset-url');
    expect(doc?.content).toMatch(/^gh-blob:/);
    expectParity(store, remote);
  });

  test('pulls binary assets via blob fallback when contents payload is empty', async () => {
    const payload = 'high-res-image';
    const expectedBase64 = Buffer.from(payload, 'utf8').toString('base64');
    remote.setFile('assets/large.png', payload);
    const originalFetch = globalAny.fetch!;
    let capturedSha: string | null = null;
    const interceptFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method.toUpperCase() === 'GET' && url.pathname === '/repos/user/repo/contents/assets/large.png') {
        const upstream = await originalFetch(input, init);
        const json = await upstream.json();
        capturedSha = typeof json?.sha === 'string' ? json.sha : null;
        return new Response(
          JSON.stringify({ ...json, content: '' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (
        request.method.toUpperCase() === 'GET' &&
        capturedSha &&
        url.pathname === `/repos/user/repo/git/blobs/${capturedSha}`
      ) {
        return new Response(
          JSON.stringify({ sha: capturedSha, content: expectedBase64, encoding: 'base64' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return originalFetch(input, init);
    });

    globalAny.fetch = interceptFetch as unknown as typeof fetch;
    try {
      await syncBidirectional(store, 'user/repo');
    } finally {
      globalAny.fetch = originalFetch;
    }
    const files = store.listFiles();
    const asset = files.find((f) => f.path === 'assets/large.png');
    expect(asset).toBeDefined();
    if (!asset) return;
    const doc = store.loadFileById(asset.id);
    expect(doc?.kind).toBe('asset-url');
    expect(doc?.content).toMatch(/^gh-blob:/);
    expect(capturedSha).toBeTruthy();
    expectParity(store, remote);
  });

  test('tracks remote binary renames by sha/hash', async () => {
    const payload = Buffer.from('asset', 'utf8').toString('base64');
    const id = store.createFile('logo.png', payload);
    await syncBidirectional(store, 'user/repo');
    const before = store.loadFileById(id);
    expect(before?.lastSyncedHash).toBeDefined();
    remote.deleteDirect('logo.png');
    remote.setFile('assets/logo.png', payload);
    if (before?.lastSyncedHash) {
      const lookup = findBySyncedHash(store.slug, before.lastSyncedHash);
      expect(lookup?.id).toBe(id);
    }

    await syncBidirectional(store, 'user/repo');

    const paths = store
      .listFiles()
      .map((f) => f.path)
      .sort();
    expect(paths).toContain('assets/logo.png');
    expect(paths).not.toContain('logo.png');
    const renamedFile = store.listFiles().find((f) => f.path === 'assets/logo.png');
    expect(renamedFile).toBeDefined();
    expectParity(store, remote);
  });

  test('listRepoFiles includes nested markdown', async () => {
    const mod = await import('./git-sync');
    remote.setFile('nested/Nested.md', '# nested');
    let cfg = mod.buildRemoteConfig('user/repo');
    let entries = await mod.listRepoFiles(cfg);
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
      .listFiles()
      .map((n) => n.path)
      .sort();
    expect(paths).toEqual(['README.md', 'sub/README.md']);
  });
});

type RemoteHeadPayload = {
  object?: { sha?: string };
};

async function getRemoteHeadSha(remote: MockRemoteRepo, branch = 'main'): Promise<string> {
  const response = await remote.handleFetch(
    `https://api.github.com/repos/user/repo/git/ref/heads/${branch}`,
    { method: 'GET' }
  );
  const payload = (await response.json()) as RemoteHeadPayload;
  if (!response.ok) {
    throw new Error(`remote head lookup failed with status ${response.status}`);
  }
  const sha = typeof payload.object?.sha === 'string' ? payload.object.sha : '';
  expect(sha).not.toBe('');
  return sha;
}

function expectParity(store: LocalStore, remote: MockRemoteRepo) {
  const localDocs = new Map<string, ReturnType<LocalStore['loadFileById']>>();
  for (const meta of store.listFiles()) {
    const doc = store.loadFileById(meta.id);
    if (!doc) continue;
    localDocs.set(meta.path, doc);
  }
  const remoteMap = remote.snapshot();
  const trackedRemoteKeys = [...remoteMap.keys()].filter(isTrackedPath).sort();
  expect(trackedRemoteKeys).toEqual([...localDocs.keys()].sort());
  for (const [path, doc] of localDocs.entries()) {
    const remoteContent = remoteMap.get(path);
    if (doc?.kind === 'markdown') {
      expect(remoteContent).toBe(doc.content);
    } else if (doc?.kind === 'binary') {
      const decoded = Buffer.from(doc.content, 'base64').toString('utf8');
      expect(remoteContent).toBe(decoded);
    } else if (doc?.kind === 'asset-url') {
      expect(remoteContent).toBeDefined();
    }
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
