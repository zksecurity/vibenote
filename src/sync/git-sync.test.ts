// Unit tests for git-sync repo reachability helpers.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RepoMetadata } from '../lib/backend';

type BackendMocks = {
  getRepoMetadata: ReturnType<typeof vi.fn>;
};

type PublicMocks = {
  fetchPublicRepoInfo: ReturnType<typeof vi.fn>;
};

const backendModule = vi.hoisted<BackendMocks>(() => ({
  getRepoMetadata: vi.fn(),
}));

const publicModule = vi.hoisted<PublicMocks>(() => ({
  fetchPublicRepoInfo: vi.fn(),
}));

vi.mock('../lib/backend', async () => {
  let actual = await vi.importActual<typeof import('../lib/backend')>('../lib/backend');
  return {
    ...actual,
    getRepoMetadata: backendModule.getRepoMetadata,
  };
});

vi.mock('../lib/github-public', async () => {
  let actual = await vi.importActual<typeof import('../lib/github-public')>('../lib/github-public');
  return {
    ...actual,
    fetchPublicRepoInfo: publicModule.fetchPublicRepoInfo,
  };
});

let repoExists: typeof import('./git-sync').repoExists;

beforeEach(async () => {
  ({ repoExists } = await import('./git-sync'));
});

describe('repoExists', () => {
  beforeEach(() => {
    backendModule.getRepoMetadata.mockReset();
    publicModule.fetchPublicRepoInfo.mockReset();
  });

  it('does not treat owner-level installation as proof that a repo exists', async () => {
    let metadata: RepoMetadata = {
      isPrivate: null,
      installed: true,
      repoSelected: false,
      defaultBranch: null,
      manageUrl: null,
      errorKind: 'not-found',
    };
    backendModule.getRepoMetadata.mockResolvedValue(metadata);
    publicModule.fetchPublicRepoInfo.mockResolvedValue({
      ok: false,
      notFound: true,
      status: 404,
    });

    await expect(repoExists('mitschabaude', 'montgom')).resolves.toBe(false);
  });

  it('accepts repos that are selected in the current installation', async () => {
    let metadata: RepoMetadata = {
      isPrivate: true,
      installed: true,
      repoSelected: true,
      defaultBranch: 'main',
      manageUrl: null,
    };
    backendModule.getRepoMetadata.mockResolvedValue(metadata);

    await expect(repoExists('acme', 'private-notes')).resolves.toBe(true);
  });
});
