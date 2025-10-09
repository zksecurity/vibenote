// Multi-device sync regression tests that exercise cross-device note and folder workflows.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LocalStore, resetRepoStore, isMarkdownMeta, isMarkdownDoc } from '../storage/local';
import { MockRemoteRepo } from '../test/mock-remote';

const authModule = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn().mockResolvedValue('test-token'),
}));

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

function listMarkdown(store: LocalStore) {
  return store.listFiles().filter(isMarkdownMeta);
}

function loadMarkdown(store: LocalStore, id: string) {
  let doc = store.loadFile(id);
  return doc && isMarkdownDoc(doc) ? doc : null;
}

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

function notePaths(store: LocalStore): string[] {
  return listMarkdown(store)
    .map((note) => note.path)
    .sort();
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

  beforeEach(async () => {
    authModule.ensureFreshAccessToken.mockReset();
    authModule.ensureFreshAccessToken.mockResolvedValue('test-token');
    remote = new MockRemoteRepo();
    remote.configure('user', 'repo');
    remote.allowToken('test-token');
    let fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      remote.handleFetch(input, init)
    );
    globalAny.fetch = fetchMock as unknown as typeof fetch;
    let module = await import('./git-sync');
    syncBidirectional = module.syncBidirectional;
    resetRepoStore(REPO_SLUG);
  });

  afterEach(() => {
    resetRepoStore(REPO_SLUG);
  });

  test('device two pulls newly created note', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    createMarkdown(storeOne, 'Fresh', 'body');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['Fresh.md']);

    let deviceTwo = createDevice('device-two');
    let storeTwo = deviceTwo.store;
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(notePaths(storeTwo)).toEqual(['Fresh.md']);
    expect(remotePaths(remote)).toEqual(['Fresh.md']);
  });

  test('rename on device one propagates to device two', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    let noteId = createMarkdown(storeOne, 'Draft', 'seed content');
    await syncBidirectional(storeOne, REPO_SLUG);

    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.renameFileById(noteId, 'Draft Renamed');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['Draft Renamed.md']);

    let storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(notePaths(storeTwo)).toEqual(['Draft Renamed.md']);
    expect(remotePaths(remote)).toEqual(['Draft Renamed.md']);
  });

  test('renaming on device one with edits on device two does not keep the old path', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    let noteId = createMarkdown(storeOne, 'Draft', 'seed content');
    await syncBidirectional(storeOne, REPO_SLUG);

    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.renameFileById(noteId, 'Draft Renamed');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['Draft Renamed.md']);

    let storeTwo = useDevice(deviceTwo);
    storeTwo.saveFileContent(noteId, 'local edits from device two', 'text/markdown');
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(notePaths(storeTwo)).toEqual(['Draft Renamed.md']);
    expect(remotePaths(remote)).toEqual(['Draft Renamed.md']);
  });

  test('rename chooses the correct note when another note shares the same content', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    let cloneId = createMarkdown(storeOne, 'Clone', 'shared body');
    let draftId = createMarkdown(storeOne, 'Draft', 'shared body');
    await syncBidirectional(storeOne, REPO_SLUG);

    let deviceTwo = createDevice('device-two', deviceOne.storage);

    let storeTwo = useDevice(deviceTwo);
    storeTwo.saveFileContent(cloneId, 'clone offline edits', 'text/markdown');

    storeOne = useDevice(deviceOne);
    storeOne.renameFileById(draftId, 'Draft Renamed');
    await syncBidirectional(storeOne, REPO_SLUG);

    storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    let renamed = loadMarkdown(storeTwo, draftId);
    expect(renamed?.path).toBe('Draft Renamed.md');
    expect(renamed?.content).toBe('shared body');
    expect(renamed?.id).toBe(draftId);

    let clone = loadMarkdown(storeTwo, cloneId);
    expect(clone?.path).toBe('Clone.md');
    expect(clone?.content).toBe('clone offline edits');
    expect(clone?.id).toBe(cloneId);
  });

  test('device two removes a note deleted on device one', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    let noteId = createMarkdown(storeOne, 'Shared', 'shared text');
    await syncBidirectional(storeOne, REPO_SLUG);
    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.deleteFileById(noteId);
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual([]);

    let storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(notePaths(storeTwo)).toEqual([]);
    expect(remotePaths(remote)).toEqual([]);
  });

  test('device two pulls newly created binary asset', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    createBinary(storeOne, 'assets/logo.png', Buffer.from('logo').toString('base64'), 'image/png');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['assets/logo.png']);

    let deviceTwo = createDevice('device-two');
    let storeTwo = deviceTwo.store;
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(filePaths(storeTwo)).toEqual(['assets/logo.png']);
    expect(remotePaths(remote)).toEqual(['assets/logo.png']);
  });

  test('renaming a binary asset propagates to other devices', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    createBinary(storeOne, 'logo.png', Buffer.from('logo').toString('base64'), 'image/png');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['logo.png']);

    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.renameFile('logo.png', 'brand.png');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['brand.png']);

    let storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(filePaths(storeTwo)).toEqual(['brand.png']);
    expect(remotePaths(remote)).toEqual(['brand.png']);
  });

  test('device two removes a binary asset deleted on device one', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    createBinary(storeOne, 'assets/chart.svg', Buffer.from('<svg/>').toString('base64'), 'image/svg+xml');
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

  test('device two with local edits resurrects a note removed on device one', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    let noteId = createMarkdown(storeOne, 'Keep', 'shared text');
    await syncBidirectional(storeOne, REPO_SLUG);
    let deviceTwo = createDevice('device-two', deviceOne.storage);

    let storeTwo = useDevice(deviceTwo);
    storeTwo.saveFileContent(noteId, 'offline edits from device two', 'text/markdown');

    storeOne = useDevice(deviceOne);
    storeOne.deleteFileById(noteId);
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual([]);

    storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(notePaths(storeTwo)).toEqual(['Keep.md']);
    expect(remotePaths(remote)).toEqual(['Keep.md']);
  });

  test('folder rename on device one updates paths on device two', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    createMarkdown(storeOne, 'Doc', 'body', 'docs');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(notePaths(storeOne)).toEqual(['docs/Doc.md']);
    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.renameFolder('docs', 'guides');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['guides/Doc.md']);

    let storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(notePaths(storeTwo)).toEqual(['guides/Doc.md']);
    expect(storeTwo.listFolders()).toEqual(['guides']);
    expect(remotePaths(remote)).toEqual(['guides/Doc.md']);
  });

  test('folder rename preserves offline edits on device two', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    let noteId = createMarkdown(storeOne, 'Doc', 'body', 'docs');
    await syncBidirectional(storeOne, REPO_SLUG);

    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.renameFolder('docs', 'guides');
    await syncBidirectional(storeOne, REPO_SLUG);

    let storeTwo = useDevice(deviceTwo);
    storeTwo.saveFileContent(noteId, 'offline edit after rename', 'text/markdown');
    await syncBidirectional(storeTwo, REPO_SLUG);

    let updated = loadMarkdown(storeTwo, noteId);
    expect(updated?.path).toBe('guides/Doc.md');
    expect(updated?.content).toBe('offline edit after rename');
    expect(remote.snapshot().get('guides/Doc.md')).toBe('offline edit after rename');
  });

  test('folder deletion on device one removes its notes on device two', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    createMarkdown(storeOne, 'Doc', 'body', 'docs');
    createMarkdown(storeOne, 'Nested', 'body', 'docs/nested');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(notePaths(storeOne)).toEqual(['docs/Doc.md', 'docs/nested/Nested.md']);
    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.deleteFolder('docs');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual([]);

    let storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(notePaths(storeTwo)).toEqual([]);
    expect(storeTwo.listFolders()).toEqual([]);
    expect(remotePaths(remote)).toEqual([]);
  });
});
