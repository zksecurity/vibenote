// Tests for git-native share creation.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../auth/app-auth', () => ({
  ensureFreshAccessToken: vi.fn(async () => 'token'),
  getApiBase: () => 'https://api.vibenote.test',
}));

import { createGitShare, lookupCachedShare } from './git-share-ops';

let deletedPaths: string[] = [];

// Stub GitHub and the backend; `resolvedOwner` is what the backend reports for the new link.
function stubFetch(resolvedOwner: string | undefined) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/contents/.shares/.repo-id')) {
        return Response.json({ sha: 'repo-id-sha', content: btoa('AAAAAAAAAAA') });
      }
      if (init?.method === 'PUT') return Response.json({ content: { sha: 'descriptor-sha' } });
      if (init?.method === 'DELETE') {
        deletedPaths.push(new URL(url).pathname);
        return Response.json({});
      }
      if (url === 'https://api.vibenote.test/v1/repo-id') return Response.json({ ok: true });
      if (url.startsWith('https://api.vibenote.test/v1/git-shares/')) {
        return resolvedOwner === undefined
          ? Response.json({ error: 'share not found' }, { status: 404 })
          : Response.json({ owner: resolvedOwner });
      }
      throw Error(`unexpected fetch ${url}`);
    })
  );
}

describe('createGitShare', () => {
  it('returns the opaque link once it resolves to this repository owner', async () => {
    stubFetch('Acme');
    let link = await createGitShare('acme', 'notes-a', 'notes/hello.md');
    expect(link.url).toMatch(/\/s\/[A-Za-z0-9_-]{32}$/);
    expect(lookupCachedShare('acme', 'notes-a', 'notes/hello.md')).toEqual(link);
  });

  it('refuses a link that resolves elsewhere or not at all', async () => {
    // Another repository registered this repo's id first, or the share is not served
    stubFetch('attacker');
    await expect(createGitShare('acme', 'notes-b', 'notes/hello.md')).rejects.toThrow(
      'share link does not resolve to this repository'
    );
    stubFetch(undefined);
    await expect(createGitShare('acme', 'notes-c', 'notes/hello.md')).rejects.toThrow(
      'share link does not resolve to this repository'
    );

    // The unusable descriptors were removed again and never cached
    expect(deletedPaths).toHaveLength(2);
    expect(deletedPaths.every((p) => p.includes('/contents/.shares/opaque/'))).toBe(true);
    expect(lookupCachedShare('acme', 'notes-b', 'notes/hello.md')).toBeNull();
    expect(lookupCachedShare('acme', 'notes-c', 'notes/hello.md')).toBeNull();
  });
});
