// Integration tests for the writable repo data flow using the real sync layer.
import { act, renderHook, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { beforeAll, beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import type { RepoMetadata } from '../lib/backend';
import type { RepoRoute } from '../ui/routing';
import { MockRemoteRepo } from '../test/mock-remote';

type AuthMocks = {
  signInWithGitHubApp: ReturnType<typeof vi.fn>;
  getSessionToken: ReturnType<typeof vi.fn>;
  getSessionUser: ReturnType<typeof vi.fn>;
  ensureFreshAccessToken: ReturnType<typeof vi.fn>;
  signOutFromGitHubApp: ReturnType<typeof vi.fn>;
  getAccessTokenRecord: ReturnType<typeof vi.fn>;
};

type BackendMocks = {
  getRepoMetadata: ReturnType<typeof vi.fn>;
  getInstallUrl: ReturnType<typeof vi.fn>;
};

const authModule = vi.hoisted<AuthMocks>(() => ({
  signInWithGitHubApp: vi.fn(),
  getSessionToken: vi.fn(),
  getSessionUser: vi.fn(),
  ensureFreshAccessToken: vi.fn(),
  signOutFromGitHubApp: vi.fn(),
  getAccessTokenRecord: vi.fn(),
}));

const backendModule = vi.hoisted<BackendMocks>(() => ({
  getRepoMetadata: vi.fn(),
  getInstallUrl: vi.fn(),
}));

vi.mock('../auth/app-auth', () => ({
  signInWithGitHubApp: authModule.signInWithGitHubApp,
  getSessionToken: authModule.getSessionToken,
  getSessionUser: authModule.getSessionUser,
  ensureFreshAccessToken: authModule.ensureFreshAccessToken,
  signOutFromGitHubApp: authModule.signOutFromGitHubApp,
  getAccessTokenRecord: authModule.getAccessTokenRecord,
}));

vi.mock('../lib/backend', () => ({
  getRepoMetadata: backendModule.getRepoMetadata,
  getInstallUrl: backendModule.getInstallUrl,
}));

let useRepoData: typeof import('../data').useRepoData;

beforeAll(async () => {
  ({ useRepoData } = await import('../data'));
});

const mockGetSessionToken = authModule.getSessionToken;
const mockGetSessionUser = authModule.getSessionUser;
const mockEnsureFreshAccessToken = authModule.ensureFreshAccessToken;
const mockGetAccessTokenRecord = authModule.getAccessTokenRecord;
const mockGetRepoMetadata = backendModule.getRepoMetadata;
const mockGetInstallUrl = backendModule.getInstallUrl;

const writableMeta: RepoMetadata = {
  isPrivate: true,
  installed: true,
  repoSelected: true,
  defaultBranch: 'main',
  manageUrl: null,
};

type RecordRecentFn = (entry: { slug: string; owner?: string; repo?: string; connected?: boolean }) => void;

function renderRepoData(initial: { slug: string; route: RepoRoute; recordRecent: RecordRecentFn }) {
  return renderHook(
    ({ slug, route, recordRecent }: { slug: string; route: RepoRoute; recordRecent: RecordRecentFn }) => {
      let [routeState, setRouteState] = useState<RepoRoute>(route);
      useEffect(() => {
        setRouteState(route);
      }, [route]);
      return useRepoData({
        slug,
        route: routeState,
        recordRecent,
        setActivePath: (nextPath, options) => {
          setRouteState((prev) => {
            if (prev.kind !== 'repo') return prev;
            return { ...prev, notePath: nextPath };
          });
        },
      });
    },
    { initialProps: initial }
  );
}

describe('useRepoData integration', () => {
  let remote: MockRemoteRepo;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();

    remote = new MockRemoteRepo();
    remote.configure('acme', 'docs');
    remote.allowToken('access-token');

    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => remote.handleFetch(input, init));
    vi.stubGlobal('fetch', fetchMock);

    mockGetSessionToken.mockReset();
    mockGetSessionUser.mockReset();
    mockEnsureFreshAccessToken.mockReset();
    mockGetAccessTokenRecord.mockReset();
    mockGetRepoMetadata.mockReset();
    mockGetInstallUrl.mockReset();

    mockGetSessionToken.mockReturnValue('session-token');
    mockGetSessionUser.mockReturnValue({
      login: 'mona',
      name: 'Mona',
      avatarUrl: 'https://example.com/mona.png',
    });
    mockEnsureFreshAccessToken.mockResolvedValue('access-token');
    mockGetAccessTokenRecord.mockReturnValue({ token: 'access-token', expiresAt: Date.now() + 60_000 });
    mockGetRepoMetadata.mockResolvedValue({ ...writableMeta });
    mockGetInstallUrl.mockResolvedValue('https://github.com/apps/vibenote/installations/new');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('imports remote files, pushes local edits, and pulls remote updates through the real sync path', async () => {
    let slug = 'acme/docs';
    let recordRecent = vi.fn<RecordRecentFn>();

    remote.setFile('README.md', '# Remote readme');
    remote.setFile('Guide.md', 'initial guide');

    let { result } = renderRepoData({
      slug,
      route: { kind: 'repo', owner: 'acme', repo: 'docs' },
      recordRecent,
    });

    await waitFor(() => expect(result.current.state.repoQueryStatus).toBe('ready'));
    await waitFor(() => expect(result.current.state.repoLinked).toBe(true));
    await waitFor(() =>
      expect(result.current.state.files.map((file) => file.path).sort()).toEqual(['Guide.md', 'README.md'])
    );
    await waitFor(() => expect(result.current.state.activeFile?.path).toBe('README.md'));
    await waitFor(() => expect(result.current.state.activeFile?.content).toBe('# Remote readme'));

    act(() => {
      result.current.actions.saveFile('README.md', '# Local edit');
    });

    await act(async () => {
      await result.current.actions.syncNow();
    });

    expect(remote.snapshot().get('README.md')).toBe('# Local edit');
    expect(result.current.state.statusMessage).toContain('Synced:');
    expect(result.current.state.statusMessage).toContain('pushed 1');

    remote.setFile('README.md', '# Remote update');

    await act(async () => {
      await result.current.actions.syncNow();
    });

    await waitFor(() => expect(result.current.state.activeFile?.content).toBe('# Remote update'));
    expect(remote.snapshot().get('README.md')).toBe('# Remote update');
  });
});
