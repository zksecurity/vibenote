// Tests around backend.ts behavior
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getRepoMetadata } from './backend';

const ensureFreshAccessTokenMock = vi.hoisted(() => vi.fn());
const refreshAccessTokenNowMock = vi.hoisted(() => vi.fn());
const getApiBaseMock = vi.hoisted(() => vi.fn(() => 'https://api.example.dev'));

const fetchPublicRepoInfoMock = vi.hoisted(() => vi.fn());

vi.mock('../auth/app-auth', () => ({
  ensureFreshAccessToken: ensureFreshAccessTokenMock,
  refreshAccessTokenNow: refreshAccessTokenNowMock,
  getApiBase: getApiBaseMock,
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
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('treats private repo as needing install when refresh fails after 401', async () => {
    ensureFreshAccessTokenMock.mockResolvedValue('expired-token');
    refreshAccessTokenNowMock.mockResolvedValue(null);
    fetchPublicRepoInfoMock.mockResolvedValue({
      ok: false,
      isPrivate: true,
      defaultBranch: null,
      rateLimited: false,
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
    expect(metadata.rateLimited).toBe(false);
  });
});
