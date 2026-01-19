// Tests around backend.ts behavior
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getRepoMetadata } from './backend';

const ensureFreshAccessTokenMock = vi.hoisted(() => vi.fn());
const refreshAccessTokenNowMock = vi.hoisted(() => vi.fn());
const getApiBaseMock = vi.hoisted(() => vi.fn(() => 'https://api.example.dev'));
const getSessionTokenMock = vi.hoisted(() => vi.fn());

const fetchPublicRepoInfoMock = vi.hoisted(() => vi.fn());

vi.mock('../auth/app-auth', () => ({
  ensureFreshAccessToken: ensureFreshAccessTokenMock,
  refreshAccessTokenNow: refreshAccessTokenNowMock,
  getApiBase: getApiBaseMock,
  getSessionToken: getSessionTokenMock,
}));

vi.mock('./github-public', () => ({
  fetchPublicRepoInfo: fetchPublicRepoInfoMock,
}));

describe('getRepoMetadata auth fallbacks', () => {
  let fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    ensureFreshAccessTokenMock.mockReset();
    refreshAccessTokenNowMock.mockReset();
    fetchPublicRepoInfoMock.mockReset();
    getSessionTokenMock.mockReset();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('treats private repo as needing install when refresh fails after 401', async () => {
    getSessionTokenMock.mockReturnValue('session-token');
    ensureFreshAccessTokenMock.mockResolvedValue('expired-token');
    refreshAccessTokenNowMock.mockResolvedValue(null);
    fetchPublicRepoInfoMock.mockResolvedValue({
      ok: false,
      isPrivate: true,
      defaultBranch: null,
      notFound: false,
    });

    fetchMock.mockImplementation(async (input) => {
      let url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : '';
      if (url === 'https://api.github.com/repos/acme/widgets') {
        return new Response(JSON.stringify({ message: 'Bad credentials' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    let metadata = await getRepoMetadata('acme', 'widgets');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshAccessTokenNowMock).toHaveBeenCalledTimes(1);
    expect(fetchPublicRepoInfoMock).toHaveBeenCalledWith('acme', 'widgets');
    expect(metadata.installed).toBe(false);
    expect(metadata.repoSelected).toBe(false);
    expect(metadata.isPrivate).toBe(true);
    expect(metadata.defaultBranch).toBeNull();
    expect(metadata.manageUrl).toBeUndefined();
    expect(metadata.errorKind).toBe('auth');
  });

  test('returns auth error when session exists but access token refresh fails upfront', async () => {
    // Scenario: User has a session token but ensureFreshAccessToken fails immediately
    // (e.g., refresh token expired). Should show re-login prompt, not "repo not found".
    getSessionTokenMock.mockReturnValue('session-token');
    ensureFreshAccessTokenMock.mockResolvedValue(null);
    fetchPublicRepoInfoMock.mockResolvedValue({
      ok: false,
      isPrivate: true,
      defaultBranch: null,
      notFound: true, // Public API would return 404 for private repo
    });

    let metadata = await getRepoMetadata('acme', 'private-repo');

    // Should NOT make any authenticated GitHub API calls since we have no token
    expect(fetchMock).not.toHaveBeenCalled();
    // Should still query public API for repo info
    expect(fetchPublicRepoInfoMock).toHaveBeenCalledWith('acme', 'private-repo');
    // Critically: errorKind should be 'auth', not 'not-found'
    expect(metadata.errorKind).toBe('auth');
    expect(metadata.isPrivate).toBe(true);
  });
});
