// Adapter that implements the GitHubRemote interface using GitHub's REST API.
// Bridges the sync engine to the real GitHub backend.

import { ensureFreshAccessToken } from '../auth/app-auth';
import type { GitHubRemote } from './sync-engine';
import type { Path, FileMode } from '../git/types';
import type { SnapshotEntry } from '../storage/repo-types';

export { createGitHubAdapter };

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Create a GitHubRemote adapter for a specific repo.
 * All API calls use the current user's OAuth token.
 */
function createGitHubAdapter(owner: string, repo: string): GitHubRemote {
  let ownerEnc = encodeURIComponent(owner);
  let repoEnc = encodeURIComponent(repo);

  return {
    async fetchBranchTip(branch: string): Promise<string | undefined> {
      let token = await requireToken();
      let branchEnc = encodeURIComponent(branch);
      // Cache-bust to avoid stale ref reads
      let path = `/repos/${ownerEnc}/${repoEnc}/git/ref/heads/${branchEnc}?cache_bust=${Date.now()}`;
      let res = await githubRequest(token, 'GET', path);
      if (res.status === 404) return undefined;
      if (!res.ok) await throwGitHubError(res, path);
      let json = await res.json();
      let sha = json?.object?.sha;
      if (typeof sha !== 'string') throw new Error('Unexpected ref payload');
      return sha;
    },

    async fetchCommit(sha: string): Promise<{ treeSha: string; parents: string[] }> {
      let token = await requireToken();
      let path = `/repos/${ownerEnc}/${repoEnc}/git/commits/${encodeURIComponent(sha)}`;
      let res = await githubRequest(token, 'GET', path);
      if (!res.ok) await throwGitHubError(res, path);
      let json = await res.json();
      let treeSha = json?.tree?.sha;
      if (typeof treeSha !== 'string') throw new Error('Missing tree SHA in commit');
      let parents: string[] = Array.isArray(json?.parents)
        ? json.parents.map((p: { sha?: string }) => String(p?.sha ?? ''))
        : [];
      return { treeSha, parents };
    },

    async fetchTree(treeSha: string): Promise<Map<Path, SnapshotEntry>> {
      let token = await requireToken();
      let path = `/repos/${ownerEnc}/${repoEnc}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`;
      let res = await githubRequest(token, 'GET', path);
      if (!res.ok) await throwGitHubError(res, path);
      let json = await res.json();
      let entries = new Map<Path, SnapshotEntry>();
      if (Array.isArray(json?.tree)) {
        for (let entry of json.tree) {
          if (entry?.type !== 'blob') continue;
          let entryPath = String(entry.path ?? '');
          let mode = String(entry.mode ?? '100644');
          let sha = String(entry.sha ?? '');
          if (entryPath === '' || sha === '') continue;
          entries.set(entryPath as Path, {
            mode: normalizeMode(mode),
            sha: sha as any, // GitSha brand
          });
        }
      }
      return entries;
    },

    async fetchBlob(sha: string): Promise<Uint8Array> {
      let token = await requireToken();
      let path = `/repos/${ownerEnc}/${repoEnc}/git/blobs/${encodeURIComponent(sha)}`;
      let res = await githubRequest(token, 'GET', path);
      if (!res.ok) await throwGitHubError(res, path);
      let json = await res.json();
      let content = String(json?.content ?? '');
      let encoding = String(json?.encoding ?? 'base64');
      if (encoding === 'base64') {
        return base64ToBytes(content.replace(/\s+/g, ''));
      }
      // UTF-8 fallback
      return new TextEncoder().encode(content);
    },

    async createBlob(content: Uint8Array): Promise<string> {
      let token = await requireToken();
      let path = `/repos/${ownerEnc}/${repoEnc}/git/blobs`;
      let base64 = bytesToBase64(content);
      let res = await githubRequest(token, 'POST', path, {
        content: base64,
        encoding: 'base64',
      });
      if (!res.ok) await throwGitHubError(res, path);
      let json = await res.json();
      let sha = json?.sha;
      if (typeof sha !== 'string' || sha === '') throw new Error('Missing blob SHA');
      return sha;
    },

    async createTree(
      entries: Array<{ path: string; mode: string; sha: string | null }>,
      baseTree?: string,
    ): Promise<string> {
      let token = await requireToken();
      let path = `/repos/${ownerEnc}/${repoEnc}/git/trees`;
      let treeItems = entries.map(e => ({
        path: e.path,
        mode: e.mode as '100644' | '100755' | '040000' | '160000' | '120000',
        type: 'blob' as const,
        sha: e.sha,
      }));
      let body: { tree: typeof treeItems; base_tree?: string } = { tree: treeItems };
      if (baseTree !== undefined) body.base_tree = baseTree;
      let res = await githubRequest(token, 'POST', path, body);
      if (!res.ok) await throwGitHubError(res, path);
      let json = await res.json();
      let sha = json?.sha;
      if (typeof sha !== 'string') throw new Error('Missing tree SHA');
      return sha;
    },

    async createCommit(params: {
      treeSha: string;
      parents: string[];
      message: string;
      author?: { name: string; email: string; date: string };
      committer?: { name: string; email: string; date: string };
    }): Promise<string> {
      let token = await requireToken();
      let path = `/repos/${ownerEnc}/${repoEnc}/git/commits`;
      let body: Record<string, unknown> = {
        message: params.message,
        tree: params.treeSha,
        parents: params.parents,
      };
      if (params.author !== undefined) body.author = params.author;
      if (params.committer !== undefined) body.committer = params.committer;
      let res = await githubRequest(token, 'POST', path, body);
      if (!res.ok) await throwGitHubError(res, path);
      let json = await res.json();
      let sha = json?.sha;
      if (typeof sha !== 'string') throw new Error('Missing commit SHA');
      return sha;
    },

    async updateBranchRef(branch: string, commitSha: string): Promise<void> {
      let token = await requireToken();
      let branchEnc = encodeURIComponent(branch);
      let path = `/repos/${ownerEnc}/${repoEnc}/git/refs/heads/${branchEnc}`;
      let res = await githubRequest(token, 'PATCH', path, {
        sha: commitSha,
        force: false,
      });
      if (!res.ok) {
        let err = new Error(`Ref update failed (${res.status})`) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
    },

    async createBranchRef(branch: string, commitSha: string): Promise<void> {
      let token = await requireToken();
      let path = `/repos/${ownerEnc}/${repoEnc}/git/refs`;
      let res = await githubRequest(token, 'POST', path, {
        ref: `refs/heads/${branch}`,
        sha: commitSha,
      });
      if (!res.ok && res.status !== 422) {
        await throwGitHubError(res, path);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function requireToken(): Promise<string> {
  let token = await ensureFreshAccessToken();
  if (token === undefined || token === null || token === '') {
    throw new Error('GitHub authentication required');
  }
  return token;
}

async function githubRequest(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  let headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${GITHUB_API_BASE}${path}`, init);
}

async function throwGitHubError(res: Response, path: string): Promise<never> {
  let err = new Error(`GitHub request failed (${res.status})`) as Error & {
    status: number;
    path: string;
  };
  err.status = res.status;
  err.path = path;
  throw err;
}

/** Normalize a mode string from the API to our FileMode union. */
function normalizeMode(mode: string): FileMode {
  if (mode === '100644' || mode === '100755' || mode === '120000' || mode === '040000') return mode;
  // Default to regular file for unknown modes
  return '100644';
}

function base64ToBytes(base64: string): Uint8Array {
  let binary = atob(base64);
  let bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}
