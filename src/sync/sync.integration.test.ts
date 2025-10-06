import { beforeEach, describe, expect, test, vi } from 'vitest';
import { syncBidirectional } from './git-sync';
import { LocalStore, markRepoLinked } from '../storage/local';
import { MockRemoteRepo } from '../test/mock-remote';
import * as appAuth from '../auth/app-auth';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(appAuth, 'ensureFreshAccessToken').mockResolvedValue('access-token');
});

describe('syncBidirectional integration', () => {
  test('renaming a folder moves all contained files on the remote', async () => {
    const slug = 'acme/notes';

    const remote = new MockRemoteRepo();
    remote.configure('acme', 'notes');
    remote.allowToken('access-token');
    remote.setFile('docs/Alpha.md', 'alpha text');
    remote.setFile('docs/Beta.md', 'beta text');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => remote.handleFetch(input, init)
    );

    try {
      const store = new LocalStore(slug);
      store.createNote('Alpha', 'alpha text', 'docs');
      store.createNote('Beta', 'beta text', 'docs');
      markRepoLinked(slug);

      await syncBidirectional(store, slug);

      store.renameFolder('docs', 'guides');

      await syncBidirectional(store, slug);

      const localPaths = new LocalStore(slug)
        .listNotes()
        .map((note) => note.path)
        .sort();
      expect(localPaths).toEqual(['guides/Alpha.md', 'guides/Beta.md']);

      const remotePaths = [...remote.snapshot().keys()].sort();
      expect(remotePaths).toEqual(['guides/Alpha.md', 'guides/Beta.md']);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
