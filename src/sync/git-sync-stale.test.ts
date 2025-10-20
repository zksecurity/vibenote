import { beforeEach, describe, expect, test, vi } from 'vitest';
import { LocalStore, listTombstones } from '../storage/local';
import { MockRemoteRepo } from '../test/mock-remote';

const authModule = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn().mockResolvedValue('test-token'),
}));

vi.mock('../auth/app-auth', () => authModule);

const globalAny = globalThis as { fetch?: typeof fetch };

describe('syncBidirectional with stale ref reads enabled', () => {
  let store: LocalStore;
  let remote: MockRemoteRepo;
  let syncBidirectional: typeof import('./git-sync').syncBidirectional;

  beforeEach(async () => {
    authModule.ensureFreshAccessToken.mockReset();
    authModule.ensureFreshAccessToken.mockResolvedValue('test-token');
    remote = new MockRemoteRepo();
    remote.configure('user', 'repo');
    remote.allowToken('test-token');
    remote.enableStaleReads({ enabled: true, windowMs: 5_000 });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => remote.handleFetch(input, init));
    globalAny.fetch = fetchMock as unknown as typeof fetch;
    const mod = await import('./git-sync');
    syncBidirectional = mod.syncBidirectional;
    store = new LocalStore('user/repo');
  });

  test('second consecutive edit hits 422 due to stale head', async () => {
    store.createFile('Note.md', 'v1');
    await syncBidirectional(store, 'user/repo');

    store.saveFile('Note.md', 'v2');
    await syncBidirectional(store, 'user/repo');

    store.saveFile('Note.md', 'v3');
    await expect(syncBidirectional(store, 'user/repo')).rejects.toMatchObject({ status: 422 });
  });

  test('rename then edit fails under stale reads', async () => {
    store.createFile('Draft.md', 'first');
    await syncBidirectional(store, 'user/repo');

    store.renameFile('Draft.md', 'Draft v2');
    await expect(syncBidirectional(store, 'user/repo')).rejects.toMatchObject({ status: 422 });

    store.saveFile('Draft v2.md', 'second');
    await expect(syncBidirectional(store, 'user/repo')).rejects.toMatchObject({ status: 422 });
    expect(listTombstones(store.slug)).not.toHaveLength(0);
  });
});
