import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RepoMetadata } from './lib/backend';
import type { Route } from './ui/routing';
import { LocalStore, markRepoLinked, recordAutoSyncRun, setLastActiveNoteId } from './storage/local';

type RemoteFile = { path: string; text: string; sha: string };

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
  listNoteFiles: ReturnType<typeof vi.fn>;
  pullNote: ReturnType<typeof vi.fn>;
  syncBidirectional: ReturnType<typeof vi.fn>;
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
  listNoteFiles: vi.fn(),
  pullNote: vi.fn(),
  syncBidirectional: vi.fn(),
}));

vi.mock('./auth/app-auth', () => ({
  signInWithGitHubApp: authModule.signInWithGitHubApp,
  getSessionToken: authModule.getSessionToken,
  getSessionUser: authModule.getSessionUser,
  ensureFreshAccessToken: authModule.ensureFreshAccessToken,
  signOutFromGitHubApp: authModule.signOutFromGitHubApp,
}));

vi.mock('./lib/backend', () => ({
  getRepoMetadata: backendModule.getRepoMetadata,
  getInstallUrl: backendModule.getInstallUrl,
}));

vi.mock('./sync/git-sync', () => ({
  buildRemoteConfig: syncModule.buildRemoteConfig,
  listNoteFiles: syncModule.listNoteFiles,
  pullNote: syncModule.pullNote,
  syncBidirectional: syncModule.syncBidirectional,
}));

let useRepoData: typeof import('./data').useRepoData;

beforeAll(async () => {
  ({ useRepoData } = await import('./data'));
});

const mockSignInWithGitHubApp = authModule.signInWithGitHubApp;
const mockGetSessionToken = authModule.getSessionToken;
const mockGetSessionUser = authModule.getSessionUser;
const mockEnsureFreshAccessToken = authModule.ensureFreshAccessToken;
const mockSignOutFromGitHubApp = authModule.signOutFromGitHubApp;

const mockGetRepoMetadata = backendModule.getRepoMetadata;

const mockBuildRemoteConfig = syncModule.buildRemoteConfig;
const mockListNoteFiles = syncModule.listNoteFiles;
const mockPullNote = syncModule.pullNote;
const mockSyncBidirectional = syncModule.syncBidirectional;

const writableMeta: RepoMetadata = {
  isPrivate: true,
  installed: true,
  repoSelected: true,
  defaultBranch: 'main',
  manageUrl: null,
  rateLimited: false,
};

const readOnlyMeta: RepoMetadata = {
  isPrivate: false,
  installed: false,
  repoSelected: false,
  defaultBranch: 'main',
  manageUrl: null,
  rateLimited: false,
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

describe('useRepoData', () => {
  beforeEach(() => {
    mockSignInWithGitHubApp.mockReset();
    mockGetSessionToken.mockReset();
    mockGetSessionUser.mockReset();
    mockEnsureFreshAccessToken.mockReset();
    mockSignOutFromGitHubApp.mockReset();

    mockGetRepoMetadata.mockReset();
    mockBuildRemoteConfig.mockReset();
    mockListNoteFiles.mockReset();
    mockPullNote.mockReset();
    mockSyncBidirectional.mockReset();

    mockGetSessionToken.mockReturnValue(null);
    mockGetSessionUser.mockReturnValue(null);
    mockEnsureFreshAccessToken.mockResolvedValue('access-token');
    mockSignInWithGitHubApp.mockResolvedValue(null);

    mockBuildRemoteConfig.mockImplementation((slug: string) => {
      const [owner, repo] = slug.split('/', 2);
      return { owner: owner ?? '', repo: repo ?? '', branch: 'main' };
    });

    setRepoMetadata(writableMeta);
  });

  // New workspaces should immediately surface the seeded welcome note without contacting remote APIs.
  test('seeds welcome note for a new workspace and keeps it editable', async () => {
    const onRecordRecent = vi.fn();
    const { result } = renderHook(() => useRepoData({ slug: 'new', route: { kind: 'new' }, onRecordRecent }));

    expect(result.current.state.canEdit).toBe(true);
    expect(result.current.state.canSync).toBe(false);
    expect(result.current.state.activeNotes).toHaveLength(1);
    expect(result.current.state.activeNotes[0]?.title).toBe('Welcome');
    const welcomeId = result.current.state.activeNotes[0]?.id;
    expect(welcomeId).toBeDefined();

    act(() => {
      result.current.actions.selectNote(welcomeId ?? null);
    });

    await waitFor(() => expect(result.current.state.doc?.id).toBe(welcomeId));
    expect(result.current.state.doc?.text).toContain('Welcome to VibeNote');
    expect(onRecordRecent).not.toHaveBeenCalled();
  });

  // Writable repos should sync on demand and reflect updated auth/session state without losing edits.
  test('syncing a linked repo updates storage, reports status, and refreshes auth state', async () => {
    const slug = 'acme/docs';
    const onRecordRecent = vi.fn();

    const seededUuid = '00000000-0000-0000-0000-000000000001';
    const uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce(seededUuid);
    const seedStore = new LocalStore(slug);
    const noteId = seedStore.createNote('Seed', 'initial text');
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

    const { result } = renderHook(() =>
      useRepoData({ slug, route: { kind: 'repo', owner: 'acme', repo: 'docs' }, onRecordRecent })
    );

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));
    await waitFor(() => expect(result.current.state.activeNotes).toHaveLength(1));

    expect(result.current.state.canEdit).toBe(true);
    expect(result.current.state.canSync).toBe(true);

    await waitFor(() =>
      expect(onRecordRecent).toHaveBeenCalledWith(expect.objectContaining({ slug, connected: true }))
    );

    await act(async () => {
      await result.current.actions.selectNote(noteId);
    });

    await act(async () => {
      await result.current.actions.selectNote(noteId);
    });

    await act(async () => {
      await result.current.actions.selectNote(noteId);
    });

    await waitFor(() => expect(result.current.state.doc?.id).toBe(noteId));

    act(() => {
      result.current.actions.updateNoteText(noteId, 'updated text');
    });

    const storedAfterEdit = new LocalStore(slug).loadNote(noteId);
    expect(storedAfterEdit?.text).toBe('updated text');

    await act(async () => {
      await result.current.actions.syncNow();
    });

    expect(mockSyncBidirectional).toHaveBeenCalledTimes(1);
    const [storeArg, slugArg] = mockSyncBidirectional.mock.calls[0]!;
    expect(storeArg).toBeInstanceOf(LocalStore);
    expect(slugArg).toBe(slug);
    expect(result.current.state.statusMessage).toBe('Synced: pulled 1, pushed 2');

    await act(async () => {
      await result.current.actions.signIn();
    });

    expect(mockSignInWithGitHubApp).toHaveBeenCalledTimes(1);
    expect(result.current.state.sessionToken).toBe('fresh-token');
    expect(result.current.state.user).toEqual(expect.objectContaining({ login: 'hubot' }));
  });

  // Read-only repos should list remote notes and fetch content lazily while keeping install state stable.
  test('read-only repos fetch remote notes and refresh on selection', async () => {
    const slug = 'octo/wiki';
    const onRecordRecent = vi.fn();

    mockGetSessionToken.mockReturnValue(null);
    setRepoMetadata(readOnlyMeta);
    mockListNoteFiles.mockResolvedValue([{ path: 'docs/alpha.md', sha: 'sha-alpha' }]);
    mockPullNote.mockImplementation(
      async (_config, path: string): Promise<RemoteFile> => ({
        path,
        text: `# ${path}`,
        sha: `sha-${path}`,
      })
    );

    const { result } = renderHook(() =>
      useRepoData({ slug, route: { kind: 'repo', owner: 'octo', repo: 'wiki' }, onRecordRecent })
    );

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));
    expect(result.current.state.canEdit).toBe(false);
    expect(result.current.state.canRead).toBe(true);

    await waitFor(() => expect(result.current.state.readOnlyLoading).toBe(false));
    expect(result.current.state.activeNotes).toEqual([
      expect.objectContaining({ id: 'docs/alpha.md', title: 'alpha' }),
    ]);
    expect(result.current.state.doc?.text).toBe('# docs/alpha.md');

    await waitFor(() =>
      expect(onRecordRecent).toHaveBeenCalledWith(expect.objectContaining({ slug, connected: false }))
    );

    mockPullNote.mockClear();
    mockPullNote.mockResolvedValue({
      path: 'docs/alpha.md',
      text: '# updated remote',
      sha: 'sha-updated',
    });

    await act(async () => {
      await result.current.actions.selectNote('docs/alpha.md');
    });

    await waitFor(() => expect(result.current.state.doc?.text).toBe('# updated remote'));
    expect(mockPullNote).toHaveBeenCalledTimes(1);
  });

  // During the repo access check, the active document should never flicker away in the UI.
  test('doc remains loaded while repo access resolves', async () => {
    const slug = 'acme/docs';
    const onRecordRecent = vi.fn();

    const seededUuid = '00000000-0000-0000-0000-000000000042';
    const uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce(seededUuid);
    const seedStore = new LocalStore(slug);
    const noteId = seedStore.createNote('Seed', 'initial text');
    setLastActiveNoteId(slug, noteId);
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

    const seenDocIds: Array<string | null | undefined> = [];
    const seenReadOnlyLoading: boolean[] = [];
    const seenNeedsInstall: boolean[] = [];
    const seenCanEdit: boolean[] = [];
    const { result } = renderHook(() => {
      const value = useRepoData({
        slug,
        route: { kind: 'repo', owner: 'acme', repo: 'docs' },
        onRecordRecent,
      });
      seenDocIds.push(value.state.doc?.id);
      seenReadOnlyLoading.push(value.state.readOnlyLoading);
      seenNeedsInstall.push(value.state.needsInstall);
      seenCanEdit.push(value.state.canEdit);
      return value;
    });

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('checking'));
    expect(result.current.state.doc?.id).toBe(noteId);

    await act(async () => {
      pendingMeta.resolve({ ...writableMeta });
      await pendingMeta.promise;
    });

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));
    expect(result.current.state.doc?.id).toBe(noteId);
    expect(seenDocIds.every((id) => id === noteId)).toBe(true);
    expect(seenReadOnlyLoading.every((flag) => flag === false)).toBe(true);
    expect(seenNeedsInstall.every((flag) => flag === false)).toBe(true);
    expect(seenCanEdit.every((flag) => flag === true)).toBe(true);
  });

  // Autosync should run quietly in the background without flickering UI state.
  test('autosync schedules background sync without surfacing UI noise', async () => {
    const slug = 'acme/docs';
    const onRecordRecent = vi.fn();

    const uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce(
      '00000000-0000-0000-0000-000000000051'
    );
    const store = new LocalStore(slug);
    const noteId = store.createNote('Seed', 'initial text');
    uuidSpy.mockRestore();
    markRepoLinked(slug);
    recordAutoSyncRun(slug, Date.now() - 120_000);

    mockGetSessionToken.mockReturnValue('session-token');
    mockGetSessionUser.mockReturnValue({ login: 'mona', name: 'Mona', avatarUrl: 'https://example.com/mona.png' });
    setRepoMetadata(writableMeta);
    mockSyncBidirectional.mockResolvedValue({
      pulled: 0,
      pushed: 1,
      merged: 0,
      deletedRemote: 0,
      deletedLocal: 0,
    });

    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');

    const { result } = renderHook(() =>
      useRepoData({ slug, route: { kind: 'repo', owner: 'acme', repo: 'docs' }, onRecordRecent })
    );

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));

    await act(async () => {
      await result.current.actions.selectNote(noteId);
    });

    await waitFor(() => expect(result.current.state.doc?.id).toBe(noteId));

    act(() => {
      result.current.actions.setAutosync(true);
    });

    mockSyncBidirectional.mockClear();
    setTimeoutSpy.mockClear();

    act(() => {
      result.current.actions.updateNoteText(noteId, 'updated text');
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
    expect(result.current.state.readOnlyLoading).toBe(false);
    expect(result.current.state.statusMessage).toBe(null);

    setTimeoutSpy.mockRestore();
  });

  // Switching to another repo should swap all derived state without leaking the previous doc.
  test('switching repositories replaces local state without leaking the previous doc', async () => {
    const onRecordRecent = vi.fn();

    const slugA = 'acme/docs';
    const slugB = 'acme/wiki';

    const storeA = new LocalStore(slugA);
    const noteA = storeA.createNote('A', 'text a');
    markRepoLinked(slugA);

    const storeB = new LocalStore(slugB);
    const noteB = storeB.createNote('B', 'text b');
    markRepoLinked(slugB);

    mockGetSessionToken.mockReturnValue('session-token');
    mockGetSessionUser.mockReturnValue({ login: 'mona', name: 'Mona', avatarUrl: 'https://example.com/mona.png' });

    mockGetRepoMetadata.mockImplementation(async (_owner: string, repo: string) => {
      if (repo === 'docs') return { ...writableMeta };
      if (repo === 'wiki') return { ...writableMeta };
      throw new Error(`unexpected repo ${repo}`);
    });

    const seenDocIds: Array<string | null | undefined> = [];
    const seenNeedsInstall: boolean[] = [];

    const { result, rerender } = renderHook(
      (props: { slug: string; route: Route; onRecordRecent: typeof onRecordRecent }) => {
        const value = useRepoData(props);
        seenDocIds.push(value.state.doc?.id);
        seenNeedsInstall.push(value.state.needsInstall);
        return value;
      },
      { initialProps: { slug: slugA, route: { kind: 'repo', owner: 'acme', repo: 'docs' }, onRecordRecent } }
    );

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));

    await act(async () => {
      await result.current.actions.selectNote(noteA);
    });

    await waitFor(() => expect(result.current.state.doc?.id).toBe(noteA));

    act(() => {
      rerender({ slug: slugB, route: { kind: 'repo', owner: 'acme', repo: 'wiki' }, onRecordRecent });
    });

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));

    await act(async () => {
      await result.current.actions.selectNote(noteB);
    });

    await waitFor(() => expect(result.current.state.doc?.id).toBe(noteB));

    expect(seenNeedsInstall.every((flag) => flag === false)).toBe(true);
    expect(seenDocIds.at(-1)).toBe(noteB);
  });

  // The needs-install flow should keep the doc visible and toggle the banner off after re-auth.
  test('needs-install flow preserves the current doc while awaiting GitHub access', async () => {
    const slug = 'acme/private';
    const onRecordRecent = vi.fn();

    const store = new LocalStore(slug);
    const noteId = store.createNote('Secret', 'classified');
    markRepoLinked(slug);

    mockGetSessionToken.mockReturnValue('session-token');
    mockGetSessionUser.mockReturnValue({ login: 'mona', name: 'Mona', avatarUrl: 'https://example.com/mona.png' });

    const installMeta: RepoMetadata = {
      ...writableMeta,
      repoSelected: false,
      installed: true,
      isPrivate: true,
    };

    const firstMeta = createDeferred<RepoMetadata>();
    mockGetRepoMetadata.mockImplementation(() => firstMeta.promise);
    mockSignInWithGitHubApp.mockResolvedValue({ token: 'fresh-token', user: { login: 'mona', name: 'Mona', avatarUrl: '' } });

    const seenNeedsInstall: boolean[] = [];

    const { result } = renderHook(() => {
      const value = useRepoData({ slug, route: { kind: 'repo', owner: 'acme', repo: 'private' }, onRecordRecent });
      seenNeedsInstall.push(value.state.needsInstall);
      return value;
    });

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('checking'));
    act(() => {
      firstMeta.resolve(installMeta);
    });

    await waitFor(() => expect(result.current.state.needsInstall).toBe(true));

    mockGetRepoMetadata.mockResolvedValue({ ...writableMeta });

    await act(async () => {
      await result.current.actions.signIn();
    });

    await waitFor(() => expect(result.current.state.needsInstall).toBe(false));

    await act(async () => {
      await result.current.actions.selectNote(noteId);
    });

    await waitFor(() => expect(result.current.state.doc?.id).toBe(noteId));
    expect(seenNeedsInstall.includes(true)).toBe(true);
  });

  // Switching notes in read-only mode should respect loading states without toggling install banners.
  test('read-only selection keeps install state stable', async () => {
    const slug = 'octo/wiki';
    const onRecordRecent = vi.fn();

    mockGetSessionToken.mockReturnValue(null);
    setRepoMetadata(readOnlyMeta);

    mockListNoteFiles.mockResolvedValue([
      { path: 'docs/alpha.md', sha: 'sha-alpha' },
      { path: 'docs/beta.md', sha: 'sha-beta' },
    ]);

    mockPullNote
      .mockResolvedValueOnce({ path: 'docs/alpha.md', text: '# docs/alpha.md', sha: 'sha-alpha' })
      .mockResolvedValueOnce({ path: 'docs/beta.md', text: '# docs/beta.md', sha: 'sha-beta' });

    const seenNeedsInstall: boolean[] = [];
    const seenReadOnlyLoading: boolean[] = [];

    const { result } = renderHook(() => {
      const value = useRepoData({ slug, route: { kind: 'repo', owner: 'octo', repo: 'wiki' }, onRecordRecent });
      seenNeedsInstall.push(value.state.needsInstall);
      seenReadOnlyLoading.push(value.state.readOnlyLoading);
      return value;
    });

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));
    await waitFor(() => expect(result.current.state.readOnlyLoading).toBe(false));

    await act(async () => {
      await result.current.actions.selectNote('docs/beta.md');
    });

    await waitFor(() => expect(result.current.state.doc?.path).toBe('docs/beta.md'));
    expect(result.current.state.readOnlyLoading).toBe(false);
    expect(result.current.state.needsInstall).toBe(false);
    expect(seenNeedsInstall.every((flag) => flag === false)).toBe(true);
    const loadingTransitions = seenReadOnlyLoading.filter(Boolean).length;
    expect(loadingTransitions).toBeLessThanOrEqual(1);
  });

  // Signing out should clear local data and disable syncing.
  test('signing out clears local state and disables syncing', async () => {
    const slug = 'acme/docs';
    const onRecordRecent = vi.fn();

    const store = new LocalStore(slug);
    const noteId = store.createNote('Seed', 'content');
    markRepoLinked(slug);

    mockGetSessionToken.mockReturnValue('session-token');
    mockGetSessionUser.mockReturnValue({ login: 'mona', name: 'Mona', avatarUrl: 'https://example.com/mona.png' });
    setRepoMetadata(writableMeta);
    mockSignOutFromGitHubApp.mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useRepoData({ slug, route: { kind: 'repo', owner: 'acme', repo: 'docs' }, onRecordRecent })
    );

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));

    await act(async () => {
      await result.current.actions.selectNote(noteId);
    });

    await waitFor(() => expect(result.current.state.doc?.id).toBe(noteId));

    await act(async () => {
      await result.current.actions.signOut();
    });

    expect(mockSignOutFromGitHubApp).toHaveBeenCalledTimes(1);
    expect(result.current.state.sessionToken).toBeNull();
    expect(result.current.state.user).toBeNull();
    expect(result.current.state.doc).toBeNull();
    expect(result.current.state.canSync).toBe(false);
    expect(result.current.state.needsInstall).toBe(false);
    expect(new LocalStore(slug).listNotes()).toHaveLength(0);
  });
});
