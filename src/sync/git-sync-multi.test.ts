// Multi-device sync regression tests that exercise cross-device note and folder workflows.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LocalStore, resetRepoStore } from '../storage/local';
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

function notePaths(store: LocalStore): string[] {
  return store
    .listNotes()
    .map((note) => note.path)
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
    storeOne.createNote('Fresh', 'body');
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
    let noteId = storeOne.createNote('Draft', 'seed content');
    await syncBidirectional(storeOne, REPO_SLUG);

    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.renameNote(noteId, 'Draft Renamed');
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
    let noteId = storeOne.createNote('Draft', 'seed content');
    await syncBidirectional(storeOne, REPO_SLUG);

    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.renameNote(noteId, 'Draft Renamed');
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual(['Draft Renamed.md']);

    let storeTwo = useDevice(deviceTwo);
    storeTwo.saveNote(noteId, 'local edits from device two');
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(notePaths(storeTwo)).toEqual(['Draft Renamed.md']);
    expect(remotePaths(remote)).toEqual(['Draft Renamed.md']);
  });

  test('rename chooses the correct note when another note shares the same content', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    let cloneId = storeOne.createNote('Clone', 'shared body');
    let draftId = storeOne.createNote('Draft', 'shared body');
    await syncBidirectional(storeOne, REPO_SLUG);

    let deviceTwo = createDevice('device-two', deviceOne.storage);

    let storeTwo = useDevice(deviceTwo);
    storeTwo.saveNote(cloneId, 'clone offline edits');

    storeOne = useDevice(deviceOne);
    storeOne.renameNote(draftId, 'Draft Renamed');
    await syncBidirectional(storeOne, REPO_SLUG);

    storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    let renamed = storeTwo.loadNote(draftId);
    expect(renamed?.path).toBe('Draft Renamed.md');
    expect(renamed?.text).toBe('shared body');
    expect(renamed?.id).toBe(draftId);

    let clone = storeTwo.loadNote(cloneId);
    expect(clone?.path).toBe('Clone.md');
    expect(clone?.text).toBe('clone offline edits');
    expect(clone?.id).toBe(cloneId);
  });

  test('device two removes a note deleted on device one', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    let noteId = storeOne.createNote('Shared', 'shared text');
    await syncBidirectional(storeOne, REPO_SLUG);
    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.deleteNote(noteId);
    await syncBidirectional(storeOne, REPO_SLUG);
    expect(remotePaths(remote)).toEqual([]);

    let storeTwo = useDevice(deviceTwo);
    await syncBidirectional(storeTwo, REPO_SLUG);

    expect(notePaths(storeTwo)).toEqual([]);
    expect(remotePaths(remote)).toEqual([]);
  });

  test('device two with local edits resurrects a note removed on device one', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    let noteId = storeOne.createNote('Keep', 'shared text');
    await syncBidirectional(storeOne, REPO_SLUG);
    let deviceTwo = createDevice('device-two', deviceOne.storage);

    let storeTwo = useDevice(deviceTwo);
    storeTwo.saveNote(noteId, 'offline edits from device two');

    storeOne = useDevice(deviceOne);
    storeOne.deleteNote(noteId);
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
    storeOne.createNote('Doc', 'body', 'docs');
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
    let noteId = storeOne.createNote('Doc', 'body', 'docs');
    await syncBidirectional(storeOne, REPO_SLUG);

    let deviceTwo = createDevice('device-two', deviceOne.storage);

    storeOne = useDevice(deviceOne);
    storeOne.renameFolder('docs', 'guides');
    await syncBidirectional(storeOne, REPO_SLUG);

    let storeTwo = useDevice(deviceTwo);
    storeTwo.saveNote(noteId, 'offline edit after rename');
    await syncBidirectional(storeTwo, REPO_SLUG);

    let updated = storeTwo.loadNote(noteId);
    expect(updated?.path).toBe('guides/Doc.md');
    expect(updated?.text).toBe('offline edit after rename');
    expect(remote.snapshot().get('guides/Doc.md')).toBe('offline edit after rename');
  });

  test('folder deletion on device one removes its notes on device two', async () => {
    let deviceOne = createDevice('device-one');
    let storeOne = deviceOne.store;
    storeOne.createNote('Doc', 'body', 'docs');
    storeOne.createNote('Nested', 'body', 'docs/nested');
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
