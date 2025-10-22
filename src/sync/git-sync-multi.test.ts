// Multi-device sync regression tests that exercise cross-device note and folder workflows.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LocalStore, resetRepoStore, listTombstones } from '../storage/local';
import { MockRemoteRepo } from '../test/mock-remote';

const authModule = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn().mockResolvedValue('test-token'),
}));

vi.mock('../auth/app-auth', () => authModule);

const globalAny = globalThis as {
  fetch?: typeof fetch;
};

type Device = {
  name: string;
  storage: Storage;
  store: LocalStore;
};

class EphemeralStorage implements Storage {
  private backing = new Map<string, string>();

  get length(): number {
    return this.backing.size;
  }

  clear(): void {
    this.backing.clear();
  }

  getItem(key: string): string | null {
    return this.backing.has(key) ? this.backing.get(key) ?? null : null;
  }

  key(index: number): string | null {
    return Array.from(this.backing.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.backing.delete(key);
  }

  setItem(key: string, value: string): void {
    this.backing.set(key, value);
  }
}

// Clone Storage snapshots so devices can branch from the same starting point.
function cloneStorage(source: Storage): Storage {
  let snapshot = new EphemeralStorage();
  for (let index = 0; index < source.length; index++) {
    let key = source.key(index);
    if (!key) continue;
    let value = source.getItem(key);
    if (value !== null) snapshot.setItem(key, value);
  }
  return snapshot;
}

// Swap the global localStorage reference to emulate switching active devices.
function useStorage(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
      value: storage,
      configurable: true,
    });
  }
}

const REPO_SLUG = 'user/repo';

function attachStore(storage: Storage): LocalStore {
  useStorage(storage);
  resetRepoStore(REPO_SLUG);
  return new LocalStore(REPO_SLUG);
}

function createDevice(name: string, source?: Storage): Device {
  let storage = source ? cloneStorage(source) : new EphemeralStorage();
  let store = attachStore(storage);
  return { name, storage, store };
}

function useDevice(device: Device): LocalStore {
  device.store = attachStore(device.storage);
  return device.store;
}

function filePaths(store: LocalStore): string[] {
  return store
    .listFiles()
    .map((file) => file.path)
    .sort();
}

function remotePaths(repo: MockRemoteRepo): string[] {
  return [...repo.snapshot().keys()].sort();
}

describe('syncBidirectional multi-device', () => {
  let remote: MockRemoteRepo;
  let syncBidirectional: typeof import('./git-sync').syncBidirectional;
  let fetchBlobSpy: any;

  beforeEach(async () => {
    authModule.ensureFreshAccessToken.mockReset();
    authModule.ensureFreshAccessToken.mockResolvedValue('test-token');
    remote = new MockRemoteRepo();
    remote.configure('user', 'repo');
    remote.allowToken('test-token');
    let fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => remote.handleFetch(input, init));
    globalAny.fetch = fetchMock as unknown as typeof fetch;
    let module = await import('./git-sync');
    syncBidirectional = module.syncBidirectional;
    fetchBlobSpy = vi.spyOn(module, 'fetchBlob');
    resetRepoStore(REPO_SLUG);
  });

  afterEach(() => {
    fetchBlobSpy?.mockRestore();
    resetRepoStore(REPO_SLUG);
  });

  test('device two pulls newly created note', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    storeOne.createFile('Fresh.md', 'body');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['Fresh.md']);

    let deviceTwo = createDevice('device-two');
    let storeTwo = deviceTwo.store;
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(filePaths(storeTwo)).toEqual(['Fresh.md']);
    expect(remotePaths(remote)).toEqual(['Fresh.md']);
  });

  test('rename on device one propagates to device two', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    storeOne.createFile('Draft.md', 'seed content');
    await syncBidirectional(storeOne, REPO_SLUG);

    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.renameFile('Draft.md', 'Draft Renamed');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['Draft Renamed.md']);

    let storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(filePaths(storeTwo)).toEqual(['Draft Renamed.md']);
    expect(remotePaths(remote)).toEqual(['Draft Renamed.md']);
  });

  test('renaming on device one with edits on device two does not keep the old path', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    storeOne.createFile('Draft.md', 'seed content');
    await syncBidirectional(storeOne, REPO_SLUG);

    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.renameFile('Draft.md', 'Draft Renamed');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['Draft Renamed.md']);

    let storeTwo = useDevice(deviceTwo);
    storeTwo.saveFile('Draft.md', 'local edits from device two');
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(filePaths(storeTwo)).toEqual(['Draft Renamed.md']);
    expect(remotePaths(remote)).toEqual(['Draft Renamed.md']);
  });

  test('rename chooses the correct note when another note shares the same content', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    let cloneId = storeOne.createFile('Clone.md', 'shared body');
    let draftId = storeOne.createFile('Draft.md', 'shared body');
    await syncBidirectional(storeOne, REPO_SLUG);

    let deviceTwo = createDevice('device-two', deviceOne.storage);

    let storeTwo = useDevice(deviceTwo);
    storeTwo.saveFile('Clone.md', 'clone offline edits');

    storeOne = useDevice(deviceOne);
    storeOne.renameFile('Draft.md', 'Draft Renamed');
    await syncBidirectional(storeOne, REPO_SLUG);

    storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    let renamed = storeTwo.loadFileById(draftId);
    expect(renamed?.path).toBe('Draft Renamed.md');
    expect(renamed?.content).toBe('shared body');
    expect(renamed?.id).toBe(draftId);

    let clone = storeTwo.loadFileById(cloneId);
    expect(clone?.path).toBe('Clone.md');
    expect(clone?.content).toBe('clone offline edits');
    expect(clone?.id).toBe(cloneId);
  });

  test('device two removes a note deleted on device one', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    storeOne.createFile('Shared.md', 'shared text');
    await syncBidirectional(storeOne, REPO_SLUG);
    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.deleteFile('Shared.md');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual([]);

    let storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(filePaths(storeTwo)).toEqual([]);
    expect(remotePaths(remote)).toEqual([]);
  });

  test('device two pulls newly created asset placeholder', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    storeOne.createFile('assets/logo.png', Buffer.from('logo').toString('base64'));
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['assets/logo.png']);

    let deviceTwo = createDevice('device-two');
    let storeTwo = deviceTwo.store;
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(filePaths(storeTwo)).toEqual(['assets/logo.png']);
    const pulled = storeTwo.loadFileById(storeTwo.listFiles()[0]?.id ?? '');
    expect(pulled?.kind).toBe('asset-url');
    expect(pulled?.content).toMatch(/^gh-blob:/);
    expect(remotePaths(remote)).toEqual(['assets/logo.png']);
  });

  test('renaming an asset placeholder propagates to other devices', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    storeOne.createFile('logo.png', Buffer.from('logo').toString('base64'));
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['logo.png']);

    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.renameFile('logo.png', 'brand');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['brand.png']);

    let storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(filePaths(storeTwo)).toEqual(['brand.png']);
    expect(remotePaths(remote)).toEqual(['brand.png']);
    const pulled = storeTwo.loadFileById(storeTwo.listFiles()[0]?.id ?? '');
    expect(pulled?.kind).toBe('asset-url');
  });

  test('asset-url rename on device one while device two has offline edits', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    const initialPayload = Buffer.from('camera-v1').toString('base64');
    let id = storeOne.createFile('media/camera.png', initialPayload);
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['media/camera.png']);

    let deviceTwo = createDevice('device-two', deviceOne.storage);

    // rename on device one, sync
    storeOne = useDevice(deviceOne);
    storeOne.renameFile('media/camera.png', 'camera-updated');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['media/camera-updated.png']);
    expect(remote.snapshot().get('media/camera-updated.png')).toBe(initialPayload);

    // edit on device two concurrently, sync
    let storeTwo = useDevice(deviceTwo);
    const payloadAfterEdit = Buffer.from('local-offline-edit').toString('base64');
    // this changes the 'kind' back to 'binary'! but after sync it will be 'asset-url' again
    storeTwo.saveFile('media/camera.png', payloadAfterEdit, 'binary');
    await syncBidirectional(storeTwo, REPO_SLUG);

    // device two has the renamed path, and an asset-url placeholder
    let docTwo = storeTwo.loadFileById(id);
    expect(docTwo?.path).toBe('media/camera-updated.png');
    expect(docTwo?.kind).toBe('asset-url');
    expect(docTwo?.content).toMatch(/^gh-blob:/);

    // changes are reconciled on the remote: both rename and edit are preserved
    expect(remotePaths(remote)).toEqual(['media/camera-updated.png']);
    expect(remote.snapshot().get('media/camera-updated.png')).toBe(payloadAfterEdit);
  });

  test('asset-url placeholders propagate between devices and support renames', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    const assetPayload = Buffer.from('placeholder-image').toString('base64');
    storeOne.createFile('images/photo.png', assetPayload);
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['images/photo.png']);

    let deviceTwo = createDevice('device-two');
    let storeTwo = deviceTwo.store;
    await syncBidirectional(storeTwo, REPO_SLUG);

    const filesTwo = storeTwo.listFiles();
    expect(filesTwo.map((f) => f.path)).toEqual(['images/photo.png']);
    const docTwo = storeTwo.loadFileById(filesTwo[0]?.id ?? '');
    expect(docTwo?.kind).toBe('asset-url');
    expect(docTwo?.content).toMatch(/^gh-blob:/);
    expect(docTwo?.lastRemoteSha).toBeDefined();
    if (docTwo?.lastRemoteSha) {
      const blobRes = await remote.handleFetch(
        `https://api.github.com/repos/user/repo/git/blobs/${docTwo.lastRemoteSha}`,
        { method: 'GET' }
      );
      const blobJson = await blobRes.json();
      expect(typeof blobJson.content).toBe('string');
      expect(blobJson.content.length).toBeGreaterThan(0);
    }
    expect(remotePaths(remote)).toEqual(['images/photo.png']);

    storeTwo.renameFile('images/photo.png', 'photo-renamed');
    expect(filePaths(storeTwo)).toEqual(['images/photo-renamed.png']);
    const renamedDocBeforeSync = storeTwo.loadFileById(filesTwo[0]?.id ?? '');
    expect(renamedDocBeforeSync?.kind).toBe('asset-url');
    expect(renamedDocBeforeSync?.lastRemoteSha).toBeDefined();
    expect(listTombstones(REPO_SLUG).length).toBeGreaterThan(0);
    const renameTombstone = listTombstones(REPO_SLUG).find(
      (t) => t.type === 'rename' && t.from === 'images/photo.png' && t.to === 'images/photo-renamed.png'
    );
    expect(renameTombstone).toBeDefined();
    const summary = await syncBidirectional(storeTwo, REPO_SLUG);
    expect(fetchBlobSpy?.mock.calls.length ?? 0).toBe(0);
    expect(summary.pushed).toBeGreaterThan(0);
    expect(filePaths(storeTwo)).toEqual(['images/photo-renamed.png']);
    expect(remotePaths(remote)).toEqual(['images/photo-renamed.png']);
    expect(listTombstones(REPO_SLUG)).toHaveLength(0);

    storeOne = useDevice(deviceOne);
    await syncBidirectional(storeOne, REPO_SLUG);
    const updatedMeta = storeOne.listFiles().find((f) => f.path === 'images/photo-renamed.png');
    const updatedDoc = storeOne.loadFileById(updatedMeta?.id ?? '');
    expect(updatedDoc?.path).toBe('images/photo-renamed.png');
    if (updatedDoc?.kind === 'asset-url') {
      expect(updatedDoc.content).toMatch(/^gh-blob:/);
    } else {
      expect(updatedDoc?.kind).toBe('binary');
      expect(updatedDoc?.content).toBe(assetPayload);
    }

    const remoteContent = remote.snapshot().get('images/photo-renamed.png');
    expect(remoteContent).toBe(assetPayload);
  });

  test('remote updates to asset placeholders sync to all devices', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    storeOne.createFile('images/camera.png', Buffer.from('camera').toString('base64'));
    await syncBidirectional(storeOne, REPO_SLUG);

    let deviceTwo = createDevice('device-two', deviceOne.storage);
    let storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    remote.setFile('images/camera.png', 'remote-update');

    storeOne = useDevice(deviceOne);
    await syncBidirectional(storeOne, REPO_SLUG);
    const docOneMeta = storeOne.listFiles().find((f) => f.path === 'images/camera.png');
    const docOne = storeOne.loadFileById(docOneMeta?.id ?? '');
    expect(docOne?.kind).toBe('asset-url');
    expect(docOne?.content).toMatch(/^gh-blob:/);

    storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);
    const docTwoMeta = storeTwo.listFiles().find((f) => f.path === 'images/camera.png');
    const docTwo = storeTwo.loadFileById(docTwoMeta?.id ?? '');
    expect(docTwo?.kind).toBe('asset-url');
    expect(docTwo?.content).toMatch(/^gh-blob:/);
    expect(remote.snapshot().get('images/camera.png')).toBe('remote-update');
  });

  test('conflicting edits on asset placeholders keep the remote version', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    storeOne.createFile('images/diagram.png', Buffer.from('diagram').toString('base64'));
    await syncBidirectional(storeOne, REPO_SLUG);

    let deviceTwo = createDevice('device-two', deviceOne.storage);
    let storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    storeTwo.saveFile('images/diagram.png', Buffer.from('local-edit').toString('base64'), 'binary');
    remote.setFile('images/diagram.png', 'remote-edit');

    const summary = await syncBidirectional(storeTwo, REPO_SLUG);
    expect(summary.pulled).toBeGreaterThan(0);
    const docTwoMeta = storeTwo.listFiles().find((f) => f.path === 'images/diagram.png');
    const docTwo = storeTwo.loadFileById(docTwoMeta?.id ?? '');
    expect(docTwo?.kind).toBe('asset-url');
    expect(docTwo?.content).toMatch(/^gh-blob:/);
    expect(remote.snapshot().get('images/diagram.png')).toBe('remote-edit');

    storeOne = useDevice(deviceOne);
    await syncBidirectional(storeOne, REPO_SLUG);
    const docOneMeta = storeOne.listFiles().find((f) => f.path === 'images/diagram.png');
    const docOne = storeOne.loadFileById(docOneMeta?.id ?? '');
    expect(docOne?.kind).toBe('asset-url');
    expect(docOne?.content).toMatch(/^gh-blob:/);
    expect(remote.snapshot().get('images/diagram.png')).toBe('remote-edit');
  });

  test('device two removes an asset placeholder deleted on device one', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    storeOne.createFile('assets/chart.svg', Buffer.from('<svg/>').toString('base64'));
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['assets/chart.svg']);

    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.deleteFile('assets/chart.svg');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual([]);

    let storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(filePaths(storeTwo)).toEqual([]);
    expect(remotePaths(remote)).toEqual([]);
  });

  test('asset placeholder deleted on device one while device two has offline edits', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    const initialPayload = Buffer.from('whiteboard').toString('base64');
    storeOne.createFile('media/whiteboard.png', initialPayload);
    await syncBidirectional(storeOne, REPO_SLUG);

    let deviceTwo = createDevice('device-two', deviceOne.storage);
    let storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);
    const fileMetaTwo = storeTwo.listFiles().find((f) => f.path === 'media/whiteboard.png');
    expect(fileMetaTwo).toBeDefined();

    storeOne = useDevice(deviceOne);
    storeOne.deleteFile('media/whiteboard.png');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual([]);

    storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);
    expect(filePaths(storeTwo)).toEqual([]);
    expect(remotePaths(remote)).toEqual([]);
  });

  test('device two with local edits resurrects a note removed on device one', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    storeOne.createFile('Keep.md', 'shared text');
    await syncBidirectional(storeOne, REPO_SLUG);
    let deviceTwo = createDevice('device-two', deviceOne.storage);

    let storeTwo = useDevice(deviceTwo);
    storeTwo.saveFile('Keep.md', 'offline edits from device two');

    storeOne = useDevice(deviceOne);
    storeOne.deleteFile('Keep.md');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual([]);

    storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(filePaths(storeTwo)).toEqual(['Keep.md']);
    expect(remotePaths(remote)).toEqual(['Keep.md']);
  });

  test('folder rename on device one updates paths on device two', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    storeOne.createFile('docs/Doc.md', 'body');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(filePaths(storeOne)).toEqual(['docs/Doc.md']);
    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.renameFolder('docs', 'guides');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['guides/Doc.md']);

    let storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(filePaths(storeTwo)).toEqual(['guides/Doc.md']);
    expect(storeTwo.listFolders()).toEqual(['guides']);
    expect(remotePaths(remote)).toEqual(['guides/Doc.md']);
  });

  test('folder rename preserves offline edits on device two', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    let noteId = storeOne.createFile('docs/Doc.md', 'body');
    await syncBidirectional(storeOne, REPO_SLUG);

    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.renameFolder('docs', 'guides');
    await syncBidirectional(storeOne, REPO_SLUG);

    let storeTwo = useDevice(deviceTwo);
    storeTwo.saveFile('docs/Doc.md', 'offline edit after rename');
    await syncBidirectional(storeTwo, REPO_SLUG);

    let updated = storeTwo.loadFileById(noteId);
    expect(updated?.path).toBe('guides/Doc.md');
    expect(updated?.content).toBe('offline edit after rename');
    expect(remote.snapshot().get('guides/Doc.md')).toBe('offline edit after rename');
  });

  test('folder deletion on device one removes its notes on device two', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    storeOne.createFile('docs/Doc.md', 'body');
    storeOne.createFile('docs/nested/Nested.md', 'body');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(filePaths(storeOne)).toEqual(['docs/Doc.md', 'docs/nested/Nested.md']);
    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.deleteFolder('docs');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual([]);

    let storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(filePaths(storeTwo)).toEqual([]);
    expect(storeTwo.listFolders()).toEqual([]);
    expect(remotePaths(remote)).toEqual([]);
  });
});
