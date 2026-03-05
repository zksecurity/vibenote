// Contract tests for the app-scoped data hook consumed by the UI shell.
import { act, renderHook, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RepoMetadata } from '../lib/backend';
import type { AppNavigationState } from '../data';
import { clearAllLocalData, listRecentRepos, recordRecentRepo } from '../storage/local';
import type { Route } from '../ui/routing';

type AuthMocks = {
  signInWithGitHubApp: ReturnType<typeof vi.fn>;
  getSessionToken: ReturnType<typeof vi.fn>;
  getSessionUser: ReturnType<typeof vi.fn>;
  signOutFromGitHubApp: ReturnType<typeof vi.fn>;
  getAccessTokenRecord: ReturnType<typeof vi.fn>;
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
  repoExists: ReturnType<typeof vi.fn>;
};

type LoggingMocks = {
  logError: ReturnType<typeof vi.fn>;
};

const authModule = vi.hoisted<AuthMocks>(() => ({
  signInWithGitHubApp: vi.fn(),
  getSessionToken: vi.fn(),
  getSessionUser: vi.fn(),
  signOutFromGitHubApp: vi.fn(),
  getAccessTokenRecord: vi.fn(),
}));

const backendModule = vi.hoisted<BackendMocks>(() => ({
  getRepoMetadata: vi.fn(),
  getInstallUrl: vi.fn(),
}));

const syncModule = vi.hoisted<SyncMocks>(() => ({
  buildRemoteConfig: vi.fn((slug: string) => {
    let [owner, repo] = slug.split('/', 2);
    return { owner: owner ?? '', repo: repo ?? '', branch: 'main' };
  }),
  listRepoFiles: vi.fn(),
  pullRepoFile: vi.fn(),
  syncBidirectional: vi.fn(),
  repoExists: vi.fn(),
}));

const loggingModule = vi.hoisted<LoggingMocks>(() => ({
  logError: vi.fn(),
}));

vi.mock('../auth/app-auth', () => ({
  signInWithGitHubApp: authModule.signInWithGitHubApp,
  getSessionToken: authModule.getSessionToken,
  getSessionUser: authModule.getSessionUser,
  signOutFromGitHubApp: authModule.signOutFromGitHubApp,
  getAccessTokenRecord: authModule.getAccessTokenRecord,
}));

vi.mock('../lib/backend', () => ({
  getRepoMetadata: backendModule.getRepoMetadata,
  getInstallUrl: backendModule.getInstallUrl,
}));

vi.mock('../lib/logging', () => ({
  logError: loggingModule.logError,
}));

vi.mock('../sync/git-sync', async () => {
  let actual = await vi.importActual<typeof import('../sync/git-sync')>('../sync/git-sync');
  return {
    ...actual,
    buildRemoteConfig: syncModule.buildRemoteConfig,
    listRepoFiles: syncModule.listRepoFiles,
    pullRepoFile: syncModule.pullRepoFile,
    syncBidirectional: syncModule.syncBidirectional,
    repoExists: syncModule.repoExists,
  };
});

let useAppData: typeof import('../data').useAppData;

beforeAll(async () => {
  ({ useAppData } = await import('../data'));
});

let mockSignInWithGitHubApp = authModule.signInWithGitHubApp;
let mockGetSessionToken = authModule.getSessionToken;
let mockGetSessionUser = authModule.getSessionUser;
let mockSignOutFromGitHubApp = authModule.signOutFromGitHubApp;
let mockGetAccessTokenRecord = authModule.getAccessTokenRecord;
let mockGetRepoMetadata = backendModule.getRepoMetadata;
let mockGetInstallUrl = backendModule.getInstallUrl;
let mockBuildRemoteConfig = syncModule.buildRemoteConfig;
let mockListRepoFiles = syncModule.listRepoFiles;
let mockPullRepoFile = syncModule.pullRepoFile;
let mockSyncBidirectional = syncModule.syncBidirectional;
let mockRepoExists = syncModule.repoExists;

let publicMeta: RepoMetadata = {
  isPrivate: false,
  installed: false,
  repoSelected: false,
  defaultBranch: 'main',
  manageUrl: null,
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  let promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject } as const;
}

function renderAppData(initialRoute: Route) {
  return renderHook(
    ({ route }: { route: Route }) => {
      let [routeState, setRouteState] = useState<Route>(route);

      useEffect(() => {
        setRouteState((prev) => (routesEqual(prev, route) ? prev : route));
      }, [route]);

      let value = useAppData({ route: routeState });

      useEffect(() => {
        let nextRoute = routeFromNavigation(value.state.navigation);
        if (nextRoute === undefined) return;
        setRouteState((prev) => (routesEqual(prev, nextRoute) ? prev : nextRoute));
      }, [value.state.navigation]);

      return value;
    },
    { initialProps: { route: initialRoute } }
  );
}

function setRepoMetadata(meta: RepoMetadata) {
  mockGetRepoMetadata.mockResolvedValue({ ...meta });
}

function routeFromNavigation(navigation: AppNavigationState): Route | undefined {
  if (navigation.screen === 'home') return { kind: 'home' };
  if (navigation.screen !== 'workspace' || navigation.target === undefined) return undefined;
  if (navigation.target.repo.kind === 'new') {
    return { kind: 'new', notePath: navigation.target.notePath };
  }
  return {
    kind: 'repo',
    owner: navigation.target.repo.owner,
    repo: navigation.target.repo.repo,
    notePath: navigation.target.notePath,
  };
}

function routesEqual(a: Route | undefined, b: Route | undefined) {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'home' && b.kind === 'home') return true;
  if (a.kind === 'start' && b.kind === 'start') return true;
  if (a.kind === 'new' && b.kind === 'new') return a.notePath === b.notePath;
  if (a.kind === 'repo' && b.kind === 'repo') {
    return a.owner === b.owner && a.repo === b.repo && a.notePath === b.notePath;
  }
  return false;
}

describe('useAppData contract', () => {
  beforeEach(() => {
    clearAllLocalData();

    mockSignInWithGitHubApp.mockReset();
    mockGetSessionToken.mockReset();
    mockGetSessionUser.mockReset();
    mockSignOutFromGitHubApp.mockReset();
    mockGetAccessTokenRecord.mockReset();
    mockGetRepoMetadata.mockReset();
    mockGetInstallUrl.mockReset();
    mockBuildRemoteConfig.mockReset();
    mockListRepoFiles.mockReset();
    mockPullRepoFile.mockReset();
    mockSyncBidirectional.mockReset();
    mockRepoExists.mockReset();

    mockGetSessionToken.mockReturnValue(null);
    mockGetSessionUser.mockReturnValue(null);
    mockSignInWithGitHubApp.mockResolvedValue(null);
    mockSignOutFromGitHubApp.mockResolvedValue(undefined);
    mockGetAccessTokenRecord.mockReturnValue(undefined);
    mockGetInstallUrl.mockResolvedValue('https://github.com/apps/vibenote/installations/new');

    mockBuildRemoteConfig.mockImplementation((slug: string) => {
      let [owner, repo] = slug.split('/', 2);
      return { owner: owner ?? '', repo: repo ?? '', branch: 'main' };
    });
    mockListRepoFiles.mockResolvedValue([]);
    mockPullRepoFile.mockResolvedValue(undefined);
    mockSyncBidirectional.mockResolvedValue(undefined);
    mockRepoExists.mockResolvedValue(false);

    setRepoMetadata(publicMeta);
  });

  test('resolves an empty home route to the new workspace contract', async () => {
    let { result } = renderAppData({ kind: 'home' });

    await waitFor(() => expect(result.current.state.workspace?.document.activePath).toBe('README.md'));

    expect(result.current.state.navigation.screen).toBe('workspace');
    expect(result.current.state.navigation.target).toEqual({
      repo: { kind: 'new', slug: 'new' },
      notePath: 'README.md',
    });
    expect(result.current.state.workspace?.target).toEqual({ kind: 'new', slug: 'new' });
  });

  test('derives the start route from the most recent repository', async () => {
    recordRecentRepo({ slug: 'acme/docs', owner: 'acme', repo: 'docs' });

    let { result } = renderAppData({ kind: 'start' });

    await waitFor(() => expect(result.current.state.navigation.screen).toBe('workspace'));

    let target = result.current.state.navigation.target;
    if (target === undefined || target.repo.kind !== 'github') {
      throw new Error('Expected a GitHub workspace target');
    }

    expect(target.repo.owner).toBe('acme');
    expect(target.repo.repo).toBe('docs');
    expect(target.repo.slug).toBe('acme/docs');
    expect(result.current.state.repos.recents.map((entry) => entry.slug)).toEqual(['acme/docs']);
  });

  test('opens a repo via dispatch, records it in recents, and can return home', async () => {
    let { result } = renderAppData({ kind: 'new' });

    act(() => {
      result.current.dispatch({
        type: 'repo.activate',
        repo: { kind: 'github', owner: 'acme', repo: 'docs' },
      });
    });

    await waitFor(() => expect(result.current.state.workspace?.access.status).toBe('ready'));
    await waitFor(() => expect(result.current.state.repos.recents[0]?.slug).toBe('acme/docs'));

    let target = result.current.state.navigation.target;
    if (target === undefined || target.repo.kind !== 'github') {
      throw new Error('Expected a GitHub workspace target');
    }

    expect(target.repo.owner).toBe('acme');
    expect(target.repo.repo).toBe('docs');
    expect(listRecentRepos()[0]?.slug).toBe('acme/docs');

    act(() => {
      result.current.dispatch({ type: 'navigation.go-home' });
    });

    expect(result.current.state.navigation.screen).toBe('home');
    expect(result.current.state.workspace).toBeUndefined();
  });

  test('surfaces note creation and rename through navigation and document state', async () => {
    let { result } = renderAppData({ kind: 'new' });

    act(() => {
      result.current.dispatch({ type: 'note.create', parentDir: '', name: 'Plan' });
    });

    await waitFor(() => expect(result.current.state.navigation.target?.notePath).toBe('Plan.md'));
    await waitFor(() => expect(result.current.state.workspace?.document.activeFile?.path).toBe('Plan.md'));

    act(() => {
      result.current.dispatch({ type: 'file.rename', path: 'Plan.md', name: 'Roadmap' });
    });

    await waitFor(() => expect(result.current.state.navigation.target?.notePath).toBe('Roadmap.md'));
    expect(result.current.state.workspace?.document.activeFile?.path).toBe('Roadmap.md');
    expect(result.current.state.workspace?.tree.files.some((file) => file.path === 'Roadmap.md')).toBe(true);
  });

  test('remaps the selected note path when a parent folder is renamed', async () => {
    let { result } = renderAppData({ kind: 'new' });

    act(() => {
      result.current.dispatch({ type: 'folder.create', parentDir: '', name: 'docs' });
      result.current.dispatch({ type: 'note.create', parentDir: 'docs', name: 'Guide' });
    });

    await waitFor(() => expect(result.current.state.navigation.target?.notePath).toBe('docs/Guide.md'));

    act(() => {
      result.current.dispatch({ type: 'folder.rename', path: 'docs', name: 'guides' });
    });

    await waitFor(() => expect(result.current.state.navigation.target?.notePath).toBe('guides/Guide.md'));
    expect(result.current.state.workspace?.document.activeFile?.path).toBe('guides/Guide.md');
    expect(result.current.state.workspace?.tree.files.some((file) => file.path === 'guides/Guide.md')).toBe(true);
  });

  test('tracks repo probe state and ignores stale probe results', async () => {
    let firstProbe = createDeferred<boolean>();
    let secondProbe = createDeferred<boolean>();
    mockRepoExists
      .mockImplementationOnce(() => firstProbe.promise)
      .mockImplementationOnce(() => secondProbe.promise);

    let { result } = renderAppData({ kind: 'home' });

    act(() => {
      result.current.dispatch({ type: 'repo.probe', owner: 'acme', repo: 'docs' });
    });

    expect(result.current.state.repos.probe).toEqual({
      status: 'checking',
      owner: 'acme',
      repo: 'docs',
    });

    act(() => {
      result.current.dispatch({ type: 'repo.probe', owner: 'space', repo: 'wiki' });
    });

    expect(result.current.state.repos.probe).toEqual({
      status: 'checking',
      owner: 'space',
      repo: 'wiki',
    });

    await act(async () => {
      firstProbe.resolve(true);
      await firstProbe.promise;
    });

    expect(result.current.state.repos.probe).toEqual({
      status: 'checking',
      owner: 'space',
      repo: 'wiki',
    });

    await act(async () => {
      secondProbe.resolve(false);
      await secondProbe.promise;
    });

    await waitFor(() =>
      expect(result.current.state.repos.probe).toEqual({
        status: 'ready',
        owner: 'space',
        repo: 'wiki',
        exists: false,
      })
    );
  });

  test('reflects sign-in and sign-out outcomes through session state', async () => {
    mockSignInWithGitHubApp.mockResolvedValue({
      token: 'session-token',
      user: {
        login: 'mona',
        name: 'Mona Lisa',
        avatarUrl: 'https://example.com/mona.png',
      },
    });

    let { result } = renderAppData({ kind: 'new' });

    act(() => {
      result.current.dispatch({ type: 'session.sign-in' });
    });

    await waitFor(() => expect(result.current.state.session.status).toBe('signed-in'));
    expect(result.current.state.session.user?.login).toBe('mona');

    act(() => {
      result.current.dispatch({ type: 'session.sign-out' });
    });

    await waitFor(() => expect(result.current.state.session.status).toBe('signed-out'));
    expect(result.current.state.session.user).toBeUndefined();
  });
});
