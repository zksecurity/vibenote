import { Buffer } from 'node:buffer';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RepoMetadata } from '../lib/backend';
import { LocalStore, markRepoLinked, recordAutoSyncRun, setLastActiveFileId } from '../storage/local';
import type { RemoteFile } from '../sync/git-sync';
import type { RepoDataState, ImportedAsset } from '../data';

type AuthMocks = {
  signInWithGitHubApp: ReturnType<typeof vi.fn>;
  getSessionToken: ReturnType<typeof vi.fn>;
  getSessionUser: ReturnType<typeof vi.fn>;
  ensureFreshAccessToken: ReturnType<typeof vi.fn>;
  signOutFromGitHubApp: ReturnType<typeof vi.fn>;
};

type BackendMocks = {
  getRepoMetadata: ReturnType<typeof vi.fn>;
  getInstallUrl: ReturnType<typeof vi.fn>;
};

type SyncMocks = {
  buildRemoteConfig: ReturnType<typeof vi.fn>;
  listRepoFiles: ReturnType<typeof vi.fn>;
  pullRepoFile: ReturnType<typeof vi.fn>;
  syncBidirectional: ReturnType<typeof vi.fn>;
};

type LoggingMocks = {
  logError: ReturnType<typeof vi.fn>;
};

type ImageMocks = {
  prepareClipboardImage: ReturnType<typeof vi.fn>;
};

const authModule = vi.hoisted<AuthMocks>(() => ({
  signInWithGitHubApp: vi.fn(),
  getSessionToken: vi.fn(),
  getSessionUser: vi.fn(),
  ensureFreshAccessToken: vi.fn(),
  signOutFromGitHubApp: vi.fn(),
}));

const backendModule = vi.hoisted<BackendMocks>(() => ({
  getRepoMetadata: vi.fn(),
  getInstallUrl: vi.fn(),
}));

const syncModule = vi.hoisted<SyncMocks>(() => ({
  buildRemoteConfig: vi.fn((slug: string) => {
    const [owner, repo] = slug.split('/', 2);
    return { owner: owner ?? '', repo: repo ?? '', branch: 'main' };
  }),
  listRepoFiles: vi.fn(),
  pullRepoFile: vi.fn(),
  syncBidirectional: vi.fn(),
}));

const loggingModule = vi.hoisted<LoggingMocks>(() => ({
  logError: vi.fn(),
}));

const imageModule = vi.hoisted<ImageMocks>(() => ({
  prepareClipboardImage: vi.fn(),
}));

vi.mock('../auth/app-auth', () => ({
  signInWithGitHubApp: authModule.signInWithGitHubApp,
  getSessionToken: authModule.getSessionToken,
  getSessionUser: authModule.getSessionUser,
  ensureFreshAccessToken: authModule.ensureFreshAccessToken,
  signOutFromGitHubApp: authModule.signOutFromGitHubApp,
}));

vi.mock('../lib/backend', () => ({
  getRepoMetadata: backendModule.getRepoMetadata,
  getInstallUrl: backendModule.getInstallUrl,
}));

vi.mock('../lib/logging', () => ({
  logError: loggingModule.logError,
}));

vi.mock('../lib/image-processing', () => ({
  prepareClipboardImage: imageModule.prepareClipboardImage,
}));

vi.mock('../sync/git-sync', async () => {
  const actual = await vi.importActual<typeof import('../sync/git-sync')>('../sync/git-sync');
  return {
    ...actual,
    buildRemoteConfig: syncModule.buildRemoteConfig,
    listRepoFiles: syncModule.listRepoFiles,
    pullRepoFile: syncModule.pullRepoFile,
    syncBidirectional: syncModule.syncBidirectional,
  };
});

// Dynamic import ensures vi.mock hoisting takes effect before the module loads.
let useAppData: typeof import('../data').useAppData;

beforeAll(async () => {
  ({ useAppData } = await import('../data'));
});

const mockSignInWithGitHubApp = authModule.signInWithGitHubApp;
const mockGetSessionToken = authModule.getSessionToken;
const mockGetSessionUser = authModule.getSessionUser;
const mockEnsureFreshAccessToken = authModule.ensureFreshAccessToken;
const mockSignOutFromGitHubApp = authModule.signOutFromGitHubApp;

const mockGetRepoMetadata = backendModule.getRepoMetadata;

const mockBuildRemoteConfig = syncModule.buildRemoteConfig;
const mockListRepoFiles = syncModule.listRepoFiles;
const mockPullRepoFile = syncModule.pullRepoFile;
const mockSyncBidirectional = syncModule.syncBidirectional;
const mockLogError = loggingModule.logError;
const mockPrepareClipboardImage = imageModule.prepareClipboardImage;

const writableMeta: RepoMetadata = {
  isPrivate: true,
  installed: true,
  repoSelected: true,
  defaultBranch: 'main',
  manageUrl: null,
};

const readOnlyMeta: RepoMetadata = {
  isPrivate: false,
  installed: false,
  repoSelected: false,
  defaultBranch: 'main',
  manageUrl: null,
};

function setRepoMetadata(meta: RepoMetadata) {
  mockGetRepoMetadata.mockImplementation(async () => ({ ...meta }));
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject } as const;
}

describe('useAppData', () => {
  beforeEach(() => {
    localStorage.clear();

    mockSignInWithGitHubApp.mockReset();
    mockGetSessionToken.mockReset();
    mockGetSessionUser.mockReset();
    mockEnsureFreshAccessToken.mockReset();
    mockSignOutFromGitHubApp.mockReset();

    mockGetRepoMetadata.mockReset();
    mockBuildRemoteConfig.mockReset();
    mockListRepoFiles.mockReset();
    mockPullRepoFile.mockReset();
    mockSyncBidirectional.mockReset();
    mockLogError.mockReset();
    mockPrepareClipboardImage.mockReset();

    mockGetSessionToken.mockReturnValue(null);
    mockGetSessionUser.mockReturnValue(null);
    mockEnsureFreshAccessToken.mockResolvedValue('access-token');
    mockSignInWithGitHubApp.mockResolvedValue(null);

    mockListRepoFiles.mockResolvedValue([]);

    mockBuildRemoteConfig.mockImplementation((slug: string) => {
      const [owner, repo] = slug.split('/', 2);
      return { owner: owner ?? '', repo: repo ?? '', branch: 'main' };
    });

    setRepoMetadata(writableMeta);
  });

  // New workspaces should immediately surface the seeded welcome note without contacting remote APIs.
  test('seeds welcome note for a new workspace and keeps it editable', async () => {
    const { result } = renderHook(() => useAppData({ kind: 'new' }));

    expect(result.current.state.canEdit).toBe(true);
    expect(result.current.state.canSync).toBe(false);
    expect(result.current.state.files).toHaveLength(1);
    expect(result.current.state.files[0]?.path).toBe('README.md');
    const welcomePath = result.current.state.files[0]?.path;
    expect(welcomePath).toBeDefined();

    act(() => {
      result.current.dispatch({ type: 'select-file', path: welcomePath });
    });

    await waitFor(() => expect(result.current.state.activeFile?.path).toBe(welcomePath));
    expect(result.current.state.activeFile?.content).toContain('Welcome to VibeNote');
    // 'new' workspace never records recents
    expect(result.current.state.recents).toHaveLength(0);
  });

  test('tracks active note path on the new route', async () => {
    const store = new LocalStore('new');
    const alphaId = store.createFile('Alpha.md', 'alpha text');
    const welcome = store.listFiles().find((note) => note.path === 'README.md');
    const alpha = store.loadFileById(alphaId);
    if (!alpha) throw new Error('Failed to seed alpha note');
    if (!welcome) throw new Error('Missing welcome note');

    const { result } = renderHook(() => useAppData({ kind: 'new', notePath: alpha.path }));

    await waitFor(() => expect(result.current.state.activePath).toBe(alpha.path));
    expect(result.current.state.activeFile?.content).toBe('alpha text');

    act(() => {
      result.current.dispatch({ type: 'select-file', path: welcome.path });
    });

    await waitFor(() => expect(result.current.state.activePath).toBe(welcome.path));
  });

  test('activates the route note path when the file exists locally', async () => {
    const slug = 'acme/docs';
    const store = new LocalStore(slug);
    store.createFile('Alpha.md', '# Alpha');
    const targetId = store.createFile('Beta.md', '# Beta');
    const target = store.loadFileById(targetId);
    if (target === null) throw new Error('Failed to load newly created note');
    markRepoLinked(slug);

    mockGetSessionToken.mockReturnValue('session-token');
    mockGetSessionUser.mockReturnValue({
      login: 'mona',
      name: 'Mona',
      avatarUrl: 'https://example.com/mona.png',
    });
    setRepoMetadata(writableMeta);

    const { result } = renderHook(() =>
      useAppData({ kind: 'repo', owner: 'acme', repo: 'docs', notePath: target.path })
    );

    await waitFor(() => expect(result.current.state.activePath).toBe(target.path));
    expect(result.current.state.activeFile?.path).toBe(target.path);
  });

  test('state.files includes markdown and image entries for writable repos', async () => {
    const slug = 'acme/assets';
    const store = new LocalStore(slug);
    store.createFile('Guide.md', '# usage');
    store.createFile('art/logo.png', Buffer.from('png-data', 'utf8').toString('base64'));
    markRepoLinked(slug);

    mockGetSessionToken.mockReturnValue('token');
    mockGetSessionUser.mockReturnValue({
      login: 'octo',
      name: 'Octo',
      avatarUrl: 'https://example.com/octo.png',
    });
    setRepoMetadata(writableMeta);

    const { result } = renderHook(() => useAppData({ kind: 'repo', owner: 'acme', repo: 'assets' }));

    await waitFor(() => expect(result.current.state.files.length).toBe(2));
    const byPath = new Map(result.current.state.files.map((file) => [file.path, file.kind]));
    expect(byPath.get('Guide.md')).toBe('markdown');
    expect(byPath.get('art/logo.png')).toBe('binary');
  });

  test('loads a read-only note that matches the route note path', async () => {
    setRepoMetadata(readOnlyMeta);
    mockListRepoFiles.mockResolvedValue([{ path: 'guides/Intro.md', sha: 'sha-intro', kind: 'markdown' }]);
    mockPullRepoFile.mockResolvedValue({
      path: 'guides/Intro.md',
      content: '# Intro',
      sha: 'sha-intro',
      kind: 'markdown',
    });

    const { result } = renderHook(() =>
      useAppData({ kind: 'repo', owner: 'acme', repo: 'docs', notePath: 'guides/Intro.md' })
    );

    await waitFor(() => expect(result.current.state.activePath).toBe('guides/Intro.md'));
    await waitFor(() => expect(result.current.state.activeFile?.content).toBe('# Intro'));
    expect(mockPullRepoFile).toHaveBeenCalledWith(expect.anything(), 'guides/Intro.md');
  });

  // Writable repos should sync on demand and reflect updated auth/session state without losing edits.
  test('syncing a linked repo updates storage, reports status, and refreshes auth state', async () => {
    const slug = 'acme/docs';

    const seededUuid = '00000000-0000-0000-0000-000000000001';
    const uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce(seededUuid);
    const seedStore = new LocalStore(slug);
    const noteId = seedStore.createFile('Seed.md', 'initial text');
    const notePath = seedStore.loadFileById(noteId)?.path;
    if (!notePath) throw new Error('Missing note path after seeding');
    uuidSpy.mockRestore();
    markRepoLinked(slug);

    mockGetSessionToken.mockReturnValue('session-token');
    mockGetSessionUser.mockReturnValue({
      login: 'mona',
      name: 'Mona',
      avatarUrl: 'https://example.com/mona.png',
    });
    setRepoMetadata(writableMeta);
    mockSyncBidirectional.mockResolvedValue({
      pulled: 1,
      pushed: 2,
      merged: 0,
      deletedRemote: 0,
      deletedLocal: 0,
    });
    mockSignInWithGitHubApp.mockResolvedValue({
      token: 'fresh-token',
      user: { login: 'hubot', name: null, avatarUrl: 'https://example.com/hubot.png' },
    });

    const { result } = renderHook(() => useAppData({ kind: 'repo', owner: 'acme', repo: 'docs' }));

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));
    await waitFor(() => expect(result.current.state.files).toHaveLength(1));

    expect(result.current.state.canEdit).toBe(true);
    expect(result.current.state.canSync).toBe(true);

    // Once the repo is reachable and linked, it should appear in recents.
    await waitFor(() =>
      expect(result.current.state.recents).toContainEqual(
        expect.objectContaining({ slug, connected: true })
      )
    );

    act(() => {
      result.current.dispatch({ type: 'select-file', path: notePath });
    });

    await waitFor(() => expect(result.current.state.activeFile?.path).toBe(notePath));

    act(() => {
      result.current.dispatch({ type: 'save-file', path: notePath, text: 'updated text' });
    });

    const storedAfterEdit = new LocalStore(slug).loadFileById(noteId);
    expect(storedAfterEdit?.content).toBe('updated text');

    await act(async () => {
      await result.current.dispatch({ type: 'sync-now' });
    });

    expect(mockSyncBidirectional).toHaveBeenCalledTimes(1);
    const [storeArg, slugArg] = mockSyncBidirectional.mock.calls[0]!;
    expect(storeArg).toBeInstanceOf(LocalStore);
    expect(slugArg).toBe(slug);
    expect(result.current.state.statusMessage).toBe('Synced: pulled 1, pushed 2');

    await act(async () => {
      await result.current.dispatch({ type: 'sign-in' });
    });

    expect(mockSignInWithGitHubApp).toHaveBeenCalledTimes(1);
    expect(result.current.state.hasSession).toBe(true);
    expect(result.current.state.user).toEqual(expect.objectContaining({ login: 'hubot' }));
  });

  test('syncing a linked repo refreshes the active file contents after store updates', async () => {
    const slug = 'acme/docs';

    const store = new LocalStore(slug);
    const noteId = store.createFile('Seed.md', 'initial text');
    const notePath = store.loadFileById(noteId)?.path;
    if (!notePath) throw new Error('Missing note path after seeding');
    markRepoLinked(slug);

    mockGetSessionToken.mockReturnValue('session-token');
    mockGetSessionUser.mockReturnValue({
      login: 'mona',
      name: 'Mona',
      avatarUrl: 'https://example.com/mona.png',
    });
    setRepoMetadata(writableMeta);
    mockSyncBidirectional.mockImplementationOnce(async (localStore: LocalStore, _slug: string) => {
      localStore.saveFile(notePath, 'remote text');
      return {
        pulled: 1,
        pushed: 0,
        merged: 0,
        deletedRemote: 0,
        deletedLocal: 0,
      };
    });

    const { result } = renderHook(() => useAppData({ kind: 'repo', owner: 'acme', repo: 'docs' }));

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));

    act(() => {
      result.current.dispatch({ type: 'select-file', path: notePath });
    });

    await waitFor(() => expect(result.current.state.activeFile?.content).toBe('initial text'));

    await act(async () => {
      await result.current.dispatch({ type: 'sync-now' });
    });

    await waitFor(() => expect(result.current.state.activeFile?.content).toBe('remote text'));
  });

  test('sync surfaces detailed message when GitHub returns 422', async () => {
    const slug = 'acme/docs';

    mockGetSessionToken.mockReturnValue('session-token');
    mockGetSessionUser.mockReturnValue({
      login: 'hubot',
      name: null,
      avatarUrl: 'https://example.com/hubot.png',
    });
    markRepoLinked(slug);

    const ghError = Object.assign(new Error('GitHub request failed (422)'), {
      status: 422,
      path: '/repos/acme/docs/git/refs/heads/main',
      body: { message: 'Update is not a fast-forward' },
      syncContexts: [{ operation: 'delete', paths: ['Ready.md'] }],
    });
    mockSyncBidirectional.mockRejectedValue(ghError);

    const { result } = renderHook(() => useAppData({ kind: 'repo', owner: 'acme', repo: 'docs' }));

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));
    await waitFor(() => expect(result.current.state.canSync).toBe(true));

    await act(async () => {
      await result.current.dispatch({ type: 'sync-now' });
    });

    expect(mockSyncBidirectional).toHaveBeenCalledWith(expect.any(LocalStore), slug);
    expect(result.current.state.statusMessage).toBe(
      'Sync failed: GitHub returned 422 while updating refs/heads/main for Ready.md (Update is not a fast-forward). Please report this bug.'
    );
    expect(mockLogError).toHaveBeenCalledWith(ghError);
  });

  test('importPastedAssets creates binary assets and returns markdown-friendly paths', async () => {
    const slug = 'acme/docs';

    const uuidSpy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-0000-0000-000000000101')
      .mockReturnValueOnce('00000000-0000-0000-0000-000000000202')
      .mockReturnValueOnce('00000000-0000-0000-0000-000000000303');

    try {
      const seedStore = new LocalStore(slug);
      const noteId = seedStore.createFile('docs/nested/guide.md', '# guide');
      const notePath = seedStore.loadFileById(noteId)?.path;
      if (!notePath) throw new Error('Missing seeded note path');
      markRepoLinked(slug);

      mockGetSessionToken.mockReturnValue('session-token');
      mockGetSessionUser.mockReturnValue({
        login: 'mona',
        name: 'Mona',
        avatarUrl: 'https://example.com/mona.png',
      });
      setRepoMetadata(writableMeta);

      mockPrepareClipboardImage.mockResolvedValue({
        base64: Buffer.from('compressed-image').toString('base64'),
        ext: 'png',
        mimeType: 'image/png',
        width: 1200,
        height: 800,
        wasCompressed: true,
        sourceBytes: 6_000_000,
        outputBytes: 1_200_000,
        folder: 'assets',
      });

      const { result } = renderHook(() => useAppData({ kind: 'repo', owner: 'acme', repo: 'docs' }));

      await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));
      await waitFor(() => expect(result.current.state.canEdit).toBe(true));

      act(() => {
        result.current.dispatch({ type: 'select-file', path: notePath });
      });

      await waitFor(() => expect(result.current.state.activeFile?.path).toBe(notePath));

      let imported: ImportedAsset[] = [];

      await act(async () => {
        imported = await result.current.dispatch({
          type: 'import-pasted-assets',
          notePath,
          files: [new File(['binary'], 'paste.png', { type: 'image/png' })],
        });
      });

      expect(mockPrepareClipboardImage).toHaveBeenCalledTimes(1);
      expect(imported).toHaveLength(1);
      const entry = imported[0];
      expect(entry).toBeDefined();
      if (!entry) throw new Error('Missing imported asset metadata');
      expect(entry.assetPath.startsWith('assets/pasted-image-')).toBe(true);
      expect(entry.markdownPath.startsWith('../../assets/pasted-image-')).toBe(true);
      expect(entry.altText.startsWith('Pasted image ')).toBe(true);

      await waitFor(() =>
        expect(result.current.state.files.some((meta) => meta.path === entry.assetPath && meta.kind === 'binary')).toBe(
          true
        )
      );

      let refreshedStore = new LocalStore(slug);
      let createdMeta = refreshedStore.listFiles().find((meta) => meta.path === entry.assetPath);
      expect(createdMeta?.kind).toBe('binary');
      let createdDoc = createdMeta ? refreshedStore.loadFileById(createdMeta.id) : null;
      expect(createdDoc?.content).toBe(Buffer.from('compressed-image').toString('base64'));
    } finally {
      uuidSpy.mockRestore();
    }
  });

  // Read-only repos should list remote notes and refresh on selection.
  test('read-only repos surface notes and refresh on selection', async () => {
    const slug = 'octo/wiki';

    mockGetSessionToken.mockReturnValue(null);
    setRepoMetadata(readOnlyMeta);
    mockListRepoFiles.mockResolvedValue([{ path: 'docs/alpha.md', sha: 'sha-alpha', kind: 'markdown' }]);
    mockPullRepoFile.mockImplementation(
      async (_config, path: string): Promise<RemoteFile> => ({
        path,
        content: `# ${path}`,
        sha: `sha-${path}`,
        kind: 'markdown',
      })
    );

    const { result } = renderHook(() => useAppData({ kind: 'repo', owner: 'octo', repo: 'wiki' }));

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));
    expect(result.current.state.canEdit).toBe(false);
    expect(result.current.state.canRead).toBe(true);

    await waitFor(() => expect(result.current.state.files.length).not.toBe(0));
    expect(result.current.state.files).toEqual([
      expect.objectContaining({ id: 'docs/alpha.md', path: 'docs/alpha.md' }),
    ]);
    expect(result.current.state.activePath).toBeUndefined();
    expect(result.current.state.activeFile).toBeUndefined();

    // Once the repo is reachable (read-only), it should appear in recents as not connected.
    await waitFor(() =>
      expect(result.current.state.recents).toContainEqual(
        expect.objectContaining({ slug, connected: false })
      )
    );

    act(() => {
      result.current.dispatch({ type: 'select-file', path: 'docs/alpha.md' });
    });

    await waitFor(() => expect(result.current.state.activeFile?.content).toBe('# docs/alpha.md'));
    expect(mockPullRepoFile).toHaveBeenCalledTimes(1);

    mockPullRepoFile.mockClear();
    mockPullRepoFile.mockResolvedValue({
      path: 'docs/alpha.md',
      content: '# updated remote',
      sha: 'sha-updated',
      kind: 'markdown',
    });

    act(() => {
      result.current.dispatch({ type: 'select-file', path: 'docs/alpha.md' });
    });

    await waitFor(() => expect(result.current.state.activeFile?.content).toBe('# updated remote'));
    expect(mockPullRepoFile).toHaveBeenCalledTimes(1);
  });

  test('read-only repos list README without auto-selecting it', async () => {
    mockGetSessionToken.mockReturnValue(null);
    setRepoMetadata(readOnlyMeta);
    mockListRepoFiles.mockResolvedValue([
      { path: 'docs/alpha.md', sha: 'sha-alpha', kind: 'markdown' },
      { path: 'README.md', sha: 'sha-readme', kind: 'markdown' },
    ]);
    mockPullRepoFile.mockImplementation(
      async (_config, path: string): Promise<RemoteFile> => ({
        path,
        content: `# ${path}`,
        sha: `sha-${path}`,
        kind: 'markdown',
      })
    );

    const { result } = renderHook(() => useAppData({ kind: 'repo', owner: 'octo', repo: 'wiki' }));

    await waitFor(() => expect(result.current.state.files.length).toBe(2));
    expect(result.current.state.activePath).toBe('README.md');
    await waitFor(() => expect(result.current.state.activeFile?.path).toBe('README.md'));
    expect(mockPullRepoFile).toHaveBeenCalledWith(expect.anything(), 'README.md');
  });

  test('linked repos focus README after initial import', async () => {
    const slug = 'acme/docs';

    mockGetSessionToken.mockReturnValue('session-token');
    mockGetSessionUser.mockReturnValue({
      login: 'hubot',
      name: 'Hubot',
      avatarUrl: 'https://example.com/hubot.png',
    });
    setRepoMetadata(writableMeta);
    mockListRepoFiles.mockResolvedValue([
      { path: 'notes/first.md', sha: 'sha-first', kind: 'markdown' },
      { path: 'README.md', sha: 'sha-readme', kind: 'markdown' },
    ]);
    mockPullRepoFile.mockImplementation(
      async (_config, path: string): Promise<RemoteFile> => ({
        path,
        content: `# ${path}`,
        sha: `sha-${path}`,
        kind: 'markdown',
      })
    );

    const uuidSpy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-0000-0000-000000000111')
      .mockReturnValueOnce('00000000-0000-0000-0000-000000000222');

    const { result } = renderHook(() => useAppData({ kind: 'repo', owner: 'acme', repo: 'docs' }));

    await waitFor(() => expect(result.current.state.files.length).toBe(2));
    const readmeEntry = result.current.state.files.find((file) => file.path === 'README.md');
    await waitFor(() => expect(result.current.state.activePath).toBe('README.md'));
    await waitFor(() => expect(result.current.state.activeFile?.path).toBe('README.md'));
    expect(readmeEntry?.id).toBe('00000000-0000-0000-0000-000000000222');

    uuidSpy.mockRestore();
  });

  // During the repo access check, the active document should never flicker away in the UI.
  test('doc remains loaded while repo access resolves', async () => {
    const slug = 'acme/docs';

    const seededUuid = '00000000-0000-0000-0000-000000000042';
    const uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce(seededUuid);
    const seedStore = new LocalStore(slug);
    const noteId = seedStore.createFile('Seed.md', 'initial text');
    setLastActiveFileId(slug, noteId);
    markRepoLinked(slug);
    uuidSpy.mockRestore();

    mockGetSessionToken.mockReturnValue('session-token');
    mockGetSessionUser.mockReturnValue({
      login: 'mona',
      name: 'Mona',
      avatarUrl: 'https://example.com/mona.png',
    });

    const pendingMeta = createDeferred<RepoMetadata>();
    mockGetRepoMetadata.mockImplementation(() => pendingMeta.promise);

    const seenDocIds: Array<string | undefined> = [];
    const seenNeedsInstall: boolean[] = [];
    const seenCanEdit: boolean[] = [];
    const { result } = renderHook(() => {
      const value = useAppData({ kind: 'repo', owner: 'acme', repo: 'docs' });
      seenDocIds.push(value.state.activeFile?.id);
      seenNeedsInstall.push(needsInstall(value.state) || needsSessionRefresh(value.state));
      seenCanEdit.push(value.state.canEdit);
      return value;
    });

    expect(result.current.state.activeFile?.id).toBe(noteId);

    await act(async () => {
      pendingMeta.resolve({ ...writableMeta });
      await pendingMeta.promise;
    });

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));
    expect(result.current.state.activeFile?.id).toBe(noteId);
    expect(seenDocIds.every((id) => id === noteId)).toBe(true);
    expect(seenNeedsInstall.every((flag) => flag === false)).toBe(true);
    expect(seenCanEdit.every((flag) => flag === true)).toBe(true);
  });

  // Autosync should run quietly in the background without flickering UI state.
  test('autosync schedules background sync without surfacing UI noise', async () => {
    const slug = 'acme/docs';

    const uuidSpy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-0000-0000-000000000051');
    const store = new LocalStore(slug);
    const noteId = store.createFile('Seed.md', 'initial text');
    const notePath = store.loadFileById(noteId)?.path;
    if (!notePath) throw new Error('Missing note path after seeding');
    uuidSpy.mockRestore();
    markRepoLinked(slug);
    recordAutoSyncRun(slug, Date.now() - 120_000);

    mockGetSessionToken.mockReturnValue('session-token');
    mockGetSessionUser.mockReturnValue({
      login: 'mona',
      name: 'Mona',
      avatarUrl: 'https://example.com/mona.png',
    });
    setRepoMetadata(writableMeta);
    mockSyncBidirectional.mockResolvedValue({
      pulled: 0,
      pushed: 1,
      merged: 0,
      deletedRemote: 0,
      deletedLocal: 0,
    });

    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');

    const { result } = renderHook(() => useAppData({ kind: 'repo', owner: 'acme', repo: 'docs' }));

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));

    act(() => {
      result.current.dispatch({ type: 'select-file', path: notePath });
    });

    await waitFor(() => expect(result.current.state.activeFile?.path).toBe(notePath));

    act(() => {
      result.current.dispatch({ type: 'set-autosync', enabled: true });
    });

    mockSyncBidirectional.mockClear();
    setTimeoutSpy.mockClear();

    act(() => {
      result.current.dispatch({ type: 'save-file', path: notePath, text: 'updated text' });
    });

    const lastCall = setTimeoutSpy.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const [timeoutFn, delay] = lastCall ?? [];
    expect(typeof timeoutFn).toBe('function');
    expect(Number(delay)).toBeGreaterThanOrEqual(10_000);

    await act(async () => {
      (timeoutFn as () => void)();
    });

    await waitFor(() => expect(mockSyncBidirectional).toHaveBeenCalledWith(expect.any(LocalStore), slug));
    expect(result.current.state.autosync).toBe(true);
    expect(result.current.state.statusMessage).toBeUndefined();

    setTimeoutSpy.mockRestore();
  });

  // Switching to another repo should swap all derived state without leaking the previous doc.
  test('switching repositories replaces local state without leaking the previous doc', async () => {
    const slugA = 'acme/docs';
    const slugB = 'acme/wiki';

    const storeA = new LocalStore(slugA);
    const noteA = storeA.createFile('A.md', 'text a');
    const noteAPath = storeA.loadFileById(noteA)?.path;
    if (!noteAPath) throw new Error('Missing path for note A');
    markRepoLinked(slugA);

    const storeB = new LocalStore(slugB);
    const noteB = storeB.createFile('B.md', 'text b');
    const noteBPath = storeB.loadFileById(noteB)?.path;
    if (!noteBPath) throw new Error('Missing path for note B');
    markRepoLinked(slugB);

    mockGetSessionToken.mockReturnValue('session-token');
    mockGetSessionUser.mockReturnValue({
      login: 'mona',
      name: 'Mona',
      avatarUrl: 'https://example.com/mona.png',
    });

    mockGetRepoMetadata.mockImplementation(async (_owner: string, repo: string) => {
      if (repo === 'docs') return { ...writableMeta };
      if (repo === 'wiki') return { ...writableMeta };
      throw new Error(`unexpected repo ${repo}`);
    });

    const seenDocIds: Array<string | undefined> = [];
    const seenNeedsInstall: boolean[] = [];

    const { result } = renderHook(() => {
      const value = useAppData({ kind: 'repo', owner: 'acme', repo: 'docs' });
      seenDocIds.push(value.state.activeFile?.id);
      seenNeedsInstall.push(needsInstall(value.state));
      return value;
    });

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));

    act(() => {
      result.current.dispatch({ type: 'select-file', path: noteAPath });
    });

    await waitFor(() => expect(result.current.state.activeFile?.id).toBe(noteA));

    // Switch to repo B via dispatch — no rerender needed.
    act(() => {
      result.current.dispatch({ type: 'route-changed', route: { kind: 'repo', owner: 'acme', repo: 'wiki' } });
    });

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));

    act(() => {
      result.current.dispatch({ type: 'select-file', path: noteBPath });
    });

    await waitFor(() => expect(result.current.state.activeFile?.id).toBe(noteB));

    expect(seenNeedsInstall.every((flag) => flag === false)).toBe(true);
    expect(seenDocIds.at(-1)).toBe(noteB);
  });

  // The needs-relogin flow should keep the doc visible and toggle the banner off after re-auth.
  test('token refresh flow preserves the current doc while awaiting GitHub access', async () => {
    const slug = 'acme/private';

    const store = new LocalStore(slug);
    const noteId = store.createFile('Secret.md', 'classified');
    const notePath = store.loadFileById(noteId)?.path;
    if (!notePath) throw new Error('Missing path for private repo note');
    markRepoLinked(slug);

    mockGetSessionToken.mockReturnValue('session-token');
    mockGetSessionUser.mockReturnValue({
      login: 'mona',
      name: 'Mona',
      avatarUrl: 'https://example.com/mona.png',
    });

    const installMeta: RepoMetadata = {
      ...writableMeta,
      repoSelected: false,
      installed: true,
      isPrivate: true,
    };

    const firstMeta = createDeferred<RepoMetadata>();
    mockGetRepoMetadata.mockImplementation(() => firstMeta.promise);
    mockSignInWithGitHubApp.mockResolvedValue({
      token: 'fresh-token',
      user: { login: 'mona', name: 'Mona', avatarUrl: '' },
    });

    const seenUserActionRequired: boolean[] = [];
    const seenRepoLinked: boolean[] = [];

    const { result } = renderHook(() => {
      const value = useAppData({ kind: 'repo', owner: 'acme', repo: 'private' });
      seenUserActionRequired.push(needsInstall(value.state) || needsSessionRefresh(value.state));
      seenRepoLinked.push(value.state.repoLinked);
      return value;
    });

    act(() => {
      firstMeta.resolve(installMeta);
    });

    expect(result.current.state.repoLinked).toBe(true);

    mockGetRepoMetadata.mockResolvedValue({ ...writableMeta });

    await act(async () => {
      await result.current.dispatch({ type: 'sign-in' });
    });

    act(() => {
      result.current.dispatch({ type: 'select-file', path: notePath });
    });

    await waitFor(() => expect(result.current.state.activeFile?.id).toBe(noteId));
    expect(seenUserActionRequired.every((flag) => !flag)).toBe(true);
    expect(seenRepoLinked.every((flag) => flag)).toBe(true);
  });

  test('auth refresh failure surfaces re-login prompt without clearing notes', async () => {
    const slug = 'acme/lost-auth';

    const store = new LocalStore(slug);
    const noteId = store.createFile('Draft.md', 'pending changes');
    const notePath = store.loadFileById(noteId)?.path;
    if (!notePath) throw new Error('Missing path for lost-auth note');
    markRepoLinked(slug);

    mockGetSessionToken.mockReturnValue('session-token');
    mockGetSessionUser.mockReturnValue({
      login: 'mona',
      name: 'Mona',
      avatarUrl: 'https://example.com/mona.png',
    });

    const lostAuthMeta: RepoMetadata = {
      isPrivate: true,
      installed: false,
      repoSelected: false,
      defaultBranch: null,
      manageUrl: null,
      errorMessage: 'Bad credentials',
      errorKind: 'auth',
    };

    const firstMeta = createDeferred<RepoMetadata>();
    mockGetRepoMetadata.mockImplementation(() => firstMeta.promise);
    mockSignInWithGitHubApp.mockResolvedValue({
      token: 'fresh-token',
      user: { login: 'mona', name: 'Mona', avatarUrl: '' },
    });

    const { result } = renderHook(() =>
      useAppData({ kind: 'repo', owner: 'acme', repo: 'lost-auth' })
    );

    act(() => {
      firstMeta.resolve(lostAuthMeta);
    });

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('error'));
    expect(needsSessionRefresh(result.current.state)).toBe(true);
    expect(result.current.state.repoLinked).toBe(true);
    expect(result.current.state.repoErrorType).toBe('auth');

    expect(result.current.state.activeFile).toBeUndefined();
    expect(result.current.state.files.some((meta) => meta.id === noteId)).toBe(true);

    mockGetRepoMetadata.mockResolvedValue({ ...writableMeta });

    await act(async () => {
      await result.current.dispatch({ type: 'sign-in' });
    });

    await waitFor(() => expect(needsInstall(result.current.state)).toBe(false));
    expect(result.current.state.repoLinked).toBe(true);
    await waitFor(() => expect(result.current.state.repoErrorType).toBeUndefined());
    act(() => {
      result.current.dispatch({ type: 'select-file', path: notePath });
    });
    await waitFor(() => expect(result.current.state.activeFile?.id).toBe(noteId));
  });

  // Switching notes in read-only mode should respect loading states without toggling install banners.
  test('read-only selection keeps install state stable', async () => {
    const slug = 'octo/wiki';

    mockGetSessionToken.mockReturnValue(null);
    setRepoMetadata(readOnlyMeta);

    mockListRepoFiles.mockResolvedValue([
      { path: 'docs/alpha.md', sha: 'sha-alpha', kind: 'markdown' },
      { path: 'docs/beta.md', sha: 'sha-beta', kind: 'markdown' },
    ]);

    mockPullRepoFile.mockImplementation(
      async (_config, path: string): Promise<RemoteFile> => ({
        path,
        content: `# ${path}`,
        sha: `sha-${path}`,
        kind: 'markdown',
      })
    );

    const seenNeedsInstall: boolean[] = [];
    const seenRepoLinked: boolean[] = [];

    const { result } = renderHook(() => {
      const value = useAppData({ kind: 'repo', owner: 'octo', repo: 'wiki' });
      seenNeedsInstall.push(needsInstall(value.state));
      seenRepoLinked.push(value.state.repoLinked);
      return value;
    });

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));
    await waitFor(() => expect(result.current.state.files.length).not.toBe(0));
    expect(result.current.state.activePath).toBeUndefined();
    act(() => {
      result.current.dispatch({ type: 'select-file', path: 'docs/alpha.md' });
    });
    await waitFor(() => expect(result.current.state.activeFile?.path).toBe('docs/alpha.md'));
    act(() => {
      result.current.dispatch({ type: 'select-file', path: 'docs/beta.md' });
    });

    await waitFor(() => expect(result.current.state.activeFile?.path).toBe('docs/beta.md'));
    expect(needsInstall(result.current.state)).toBe(false);
    expect(seenNeedsInstall.every((flag) => flag === false)).toBe(true);
    expect(seenRepoLinked.every((flag) => flag === false)).toBe(true);
  });

  // Regression test for issue #91: switching files on public repos should not cause infinite loops.
  // The bug was caused by race conditions between selectFile() and the auto-load effect.
  test('read-only file selection does not oscillate between files', async () => {
    mockGetSessionToken.mockReturnValue(null);
    setRepoMetadata(readOnlyMeta);

    mockListRepoFiles.mockResolvedValue([
      { path: 'README.md', sha: 'sha-readme', kind: 'markdown' },
      { path: 'docs/guide.md', sha: 'sha-guide', kind: 'markdown' },
    ]);

    // Track activePath on every render to detect oscillation between files.
    let activePathHistory: (string | undefined)[] = [];
    let pullCount = 0;

    mockPullRepoFile.mockImplementation(async (_config, path: string): Promise<RemoteFile> => {
      pullCount++;
      // Simulate network delay
      await new Promise((r) => setTimeout(r, 10));
      return { path, content: `# ${path}`, sha: `sha-${path}`, kind: 'markdown' };
    });

    const { result } = renderHook(() => {
      const value = useAppData({ kind: 'repo', owner: 'octo', repo: 'public' });
      activePathHistory.push(value.state.activePath);
      return value;
    });

    await waitFor(() => expect(result.current.state.files.length).toBe(2));

    // Select docs/guide.md
    act(() => {
      result.current.dispatch({ type: 'select-file', path: 'docs/guide.md' });
    });

    // Wait for selection to complete
    await waitFor(() => expect(result.current.state.activeFile?.path).toBe('docs/guide.md'));

    // Check that we didn't oscillate - path history should not have repeated back-and-forth
    // A healthy history might be: [undefined, undefined, ..., 'README.md', ..., 'docs/guide.md']
    // An oscillating history would be: ['docs/guide.md', 'README.md', 'docs/guide.md', ...]
    let oscillations = 0;
    for (let i = 2; i < activePathHistory.length; i++) {
      if (activePathHistory[i] === activePathHistory[i - 2] && activePathHistory[i] !== activePathHistory[i - 1]) {
        oscillations++;
      }
    }
    expect(oscillations).toBe(0);

    // Also verify we didn't make excessive pull requests (would indicate concurrent loads)
    expect(pullCount).toBeLessThanOrEqual(2); // At most: initial README + selected file
  });

  // Signing out should clear local data and disable syncing.
  test('signing out clears local state and disables syncing', async () => {
    const slug = 'acme/docs';

    const store = new LocalStore(slug);
    const noteId = store.createFile('Seed.md', 'content');
    const notePath = store.loadFileById(noteId)?.path;
    if (!notePath) throw new Error('Missing path for sign-out test');
    markRepoLinked(slug);

    mockGetSessionToken.mockReturnValue('session-token');
    mockGetSessionUser.mockReturnValue({
      login: 'mona',
      name: 'Mona',
      avatarUrl: 'https://example.com/mona.png',
    });
    setRepoMetadata(writableMeta);
    mockSignOutFromGitHubApp.mockResolvedValue(undefined);

    const { result } = renderHook(() => useAppData({ kind: 'repo', owner: 'acme', repo: 'docs' }));

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));

    act(() => {
      result.current.dispatch({ type: 'select-file', path: notePath });
    });

    await waitFor(() => expect(result.current.state.activeFile?.id).toBe(noteId));

    await act(async () => {
      await result.current.dispatch({ type: 'sign-out' });
    });

    expect(mockSignOutFromGitHubApp).toHaveBeenCalledTimes(1);
    expect(result.current.state.hasSession).toBe(false);
    expect(result.current.state.user).toBeUndefined();
    expect(result.current.state.activeFile).toBeUndefined();
    expect(result.current.state.canSync).toBe(false);
    expect(result.current.state.repoLinked).toBe(false);
    expect(needsInstall(result.current.state)).toBe(false);
    expect(new LocalStore(slug).listFiles()).toHaveLength(0);
  });
});

function needsInstall(state: RepoDataState) {
  return state.hasSession && state.repoErrorType === 'not-found';
}

function needsSessionRefresh(state: RepoDataState) {
  return state.repoLinked && state.repoErrorType === 'auth';
}
