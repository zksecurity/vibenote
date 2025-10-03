import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RepoMetadata } from './lib/backend';
import { LocalStore, markRepoLinked } from './storage/local';

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

  test('seeds welcome note for a new workspace and keeps it editable', async () => {
    const onRecordRecent = vi.fn();
    const { result } = renderHook(() =>
      useRepoData({ slug: 'new', route: { kind: 'new' }, onRecordRecent })
    );

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
    mockGetSessionUser.mockReturnValue({ login: 'mona', name: 'Mona', avatarUrl: 'https://example.com/mona.png' });
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
      expect(onRecordRecent).toHaveBeenCalledWith(
        expect.objectContaining({ slug, connected: true })
      )
    );

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

  test('read-only repos fetch remote notes and refresh on selection', async () => {
    const slug = 'octo/wiki';
    const onRecordRecent = vi.fn();

    mockGetSessionToken.mockReturnValue(null);
    setRepoMetadata(readOnlyMeta);
    mockListNoteFiles.mockResolvedValue([
      { path: 'docs/alpha.md', sha: 'sha-alpha' },
    ]);
    mockPullNote.mockImplementation(async (_config, path: string): Promise<RemoteFile> => ({
      path,
      text: `# ${path}`,
      sha: `sha-${path}`,
    }));

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
      expect(onRecordRecent).toHaveBeenCalledWith(
        expect.objectContaining({ slug, connected: false })
      )
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
});
