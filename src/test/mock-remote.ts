/**
 * In-memory GitHub API stub used by hook and sync tests. It records file/tree
 * state, accepts authenticated REST calls, and responds like the minimal set of
 * GitHub endpoints that `syncBidirectional` exercises so we can run full syncs
 * without touching the network.
 */
import { Buffer } from 'node:buffer';

type RemoteFile = { text: string; sha: string };

type CommitRecord = {
  treeSha: string;
  files: Map<string, RemoteFile>;
  parents: string[];
};

type TreeRecord = Map<string, RemoteFile>;

type InstallationInfo = {
  token?: string;
};

class MockRemoteRepo {
  private files = new Map<string, RemoteFile>();
  private commits = 0;
  private owner = '';
  private repo = '';
  private sequence = 0;
  private readonly defaultBranch = 'main';
  private treeSequence = 0;
  private blobs = new Map<string, string>();
  private headByBranch = new Map<string, string>();
  private treeRecords = new Map<string, TreeRecord>();
  private commitRecords = new Map<string, CommitRecord>();
  private installations = new Map<string, InstallationInfo>();
  private pendingHeadAdvance = new Set<string>();
  private simulateStale = false;
  private staleWindowMs = 0;
  private staleRefByBranch = new Map<string, { commit: string; until: number }>();

  configure(owner: string, repo: string) {
    this.owner = owner;
    this.repo = repo;
  }

  allowToken(token: string) {
    this.installations.set(token, {});
  }

  enableStaleReads(options: { enabled: boolean; windowMs?: number } = { enabled: true }) {
    this.simulateStale = options.enabled;
    this.staleWindowMs = options.windowMs ?? 200;
    this.staleRefByBranch.clear();
  }

  snapshot(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [path, file] of this.files.entries()) {
      result.set(path, file.text);
    }
    return result;
  }

  setFile(path: string, text: string) {
    const file = { text, sha: this.computeSha(text) };
    this.files.set(path, file);
    this.blobs.set(file.sha, file.text);
    this.recordManualCommit();
  }

  deleteDirect(path: string) {
    const existed = this.files.delete(path);
    if (existed) {
      this.recordManualCommit();
    }
  }

  async handleFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = this.ensureRequest(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    const requiresAuth = request.method.toUpperCase() !== 'GET';
    if (requiresAuth && !this.isAuthorized(request.headers)) {
      return this.makeResponse(401, { message: 'Unauthorized' });
    }

    if (url.pathname === `/repos/${this.owner}/${this.repo}` && method === 'GET') {
      return this.makeResponse(200, {
        default_branch: this.defaultBranch,
        permissions: { push: true },
        private: false,
      });
    }

    const refGetMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/([^/]+)$/);
    if (refGetMatch && method === 'GET') {
      const owner = refGetMatch[1] ?? '';
      const repo = refGetMatch[2] ?? '';
      const branchSegment = refGetMatch[3] ?? '';
      if (!this.matchesRepo(owner, repo)) {
        return this.makeResponse(404, { message: 'not found' });
      }
      const branch = decodeURIComponent(branchSegment);
      const head = this.headByBranch.get(branch);
      if (!head) {
        return this.makeResponse(404, { message: 'not found' });
      }
      const bypassCache = this.simulateStale && url.searchParams.has('cache_bust');
      if (bypassCache) {
        this.staleRefByBranch.delete(branch);
      }
      const stale = this.simulateStale && !bypassCache ? this.staleRefByBranch.get(branch) : undefined;
      const now = Date.now();
      const shaToServe =
        stale && stale.until > now && this.commitRecords.has(stale.commit) ? stale.commit : head;
      return this.makeResponse(200, {
        ref: `refs/heads/${branch}`,
        object: { sha: shaToServe, type: 'commit' },
      });
    }

    const refPatchMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/([^/]+)$/);
    if (refPatchMatch && method === 'PATCH') {
      const body = (await this.parseBody(request)) ?? {};
      const sha = typeof body?.sha === 'string' ? String(body.sha) : '';
      const branch = decodeURIComponent(refPatchMatch[3] ?? '');
      const force = body?.force === true;
      if (!sha) {
        return this.makeResponse(422, { message: 'missing sha' });
      }
      if (this.pendingHeadAdvance.has(branch) && force !== true) {
        this.pendingHeadAdvance.delete(branch);
        this.createSyntheticCommit(branch);
      }
      const commit = this.commitRecords.get(sha);
      if (!commit) {
        return this.makeResponse(422, { message: 'unknown commit' });
      }
      const currentHead = this.headByBranch.get(branch);
      if (currentHead && force !== true && !this.isDescendant(sha, currentHead)) {
        return this.makeResponse(422, {
          message: 'fast-forward required',
          currentHead,
          attempted: sha,
        });
      }
      this.setHead(branch, sha);
      if (this.simulateStale) {
        this.staleRefByBranch.set(branch, { commit: currentHead ?? sha, until: Date.now() + this.staleWindowMs });
      }
      return this.makeResponse(200, {
        ref: `refs/heads/${branch}`,
        object: { sha, type: 'commit' },
      });
    }

    const treeGetMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^/]+)$/);
    if (treeGetMatch && method === 'GET') {
      const owner = treeGetMatch[1] ?? '';
      const repo = treeGetMatch[2] ?? '';
      if (!this.matchesRepo(owner, repo)) {
        return this.makeResponse(404, { message: 'not found' });
      }
      const treeSegment = treeGetMatch[3] ?? '';
      const recursive = url.searchParams.get('recursive') === '1';
      const record = this.treeRecords.get(`tree-${treeSegment}`) ?? this.treeRecords.get(treeSegment);
      if (!record) {
        const branchHead = this.headByBranch.get(treeSegment);
        if (!branchHead) {
          return this.makeResponse(200, {
            sha: `tree-empty-${treeSegment}`,
            tree: [],
          });
        }
        const commit = this.commitRecords.get(branchHead);
        if (!commit) return this.makeResponse(404, { message: 'not found' });
        return this.makeResponse(200, {
          sha: commit.treeSha,
          tree: this.formatTree(commit.files, recursive),
        });
      }
      return this.makeResponse(200, {
        sha: treeSegment,
        tree: this.formatTree(record, recursive),
      });
    }

    const blobGetMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/([^/]+)$/);
    if (blobGetMatch && method === 'GET') {
      const owner = blobGetMatch[1] ?? '';
      const repo = blobGetMatch[2] ?? '';
      if (!this.matchesRepo(owner, repo)) {
        return this.makeResponse(404, { message: 'not found' });
      }
      const sha = blobGetMatch[3] ?? '';
      const blob = this.blobs.get(sha);
      if (blob === undefined) {
        return this.makeResponse(404, { message: 'not found' });
      }
      return this.makeResponse(200, {
        sha,
        content: Buffer.from(blob, 'utf8').toString('base64'),
        encoding: 'base64',
      });
    }

    const commitGetMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/commits\/([^/]+)$/);
    if (commitGetMatch && method === 'GET') {
      const owner = commitGetMatch[1] ?? '';
      const repo = commitGetMatch[2] ?? '';
      if (!this.matchesRepo(owner, repo)) {
        return this.makeResponse(404, { message: 'not found' });
      }
      const sha = commitGetMatch[3] ?? '';
      const record = this.commitRecords.get(sha);
      if (!record) return this.makeResponse(404, { message: 'not found' });
      return this.makeResponse(200, {
        sha,
        tree: { sha: record.treeSha },
        parents: record.parents.map((parentSha) => ({ sha: parentSha })),
      });
    }

    const createRefMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/);
    if (createRefMatch && method === 'POST') {
      const body = (await this.parseBody(request)) ?? {};
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      const branch = ref.replace('refs/heads/', '');
      if (
        !ref.startsWith('refs/heads/') ||
        !this.commitRecords.has(sha) ||
        this.headByBranch.has(branch)
      ) {
        return this.makeResponse(422, { message: 'invalid ref' });
      }
      this.setHead(branch, sha);
      return this.makeResponse(201, { ref, object: { sha, type: 'commit' } });
    }

    const createBlobMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/blobs$/);
    if (createBlobMatch && method === 'POST') {
      const owner = createBlobMatch[1] ?? '';
      const repo = createBlobMatch[2] ?? '';
      if (!this.matchesRepo(owner, repo)) {
        return this.makeResponse(404, { message: 'not found' });
      }
      const body = (await this.parseBody(request)) ?? {};
      const encoding = typeof body?.encoding === 'string' ? body.encoding : '';
      const content = typeof body?.content === 'string' ? body.content : '';
      if (encoding !== 'base64' || !content) {
        return this.makeResponse(422, { message: 'invalid blob payload' });
      }
      const sha = this.computeSha(content);
      this.blobs.set(sha, content);
      return this.makeResponse(201, { sha });
    }

    const createTreeMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees$/);
    if (createTreeMatch && method === 'POST') {
      const body = (await this.parseBody(request)) ?? {};
      const entries: Array<{
        path?: string;
        mode?: string;
        type?: string;
        content?: string;
        sha?: string | null;
      }> = Array.isArray(body.tree) ? body.tree : [];
      const nextTree = new Map<string, RemoteFile>();
      const deleted = new Set<string>();
      let base = this.files;
      if (typeof body.base_tree === 'string') {
        const baseTree = this.treeRecords.get(body.base_tree);
        if (baseTree) base = this.cloneFiles(baseTree);
      }
      for (const entry of entries) {
        if (!entry.path) continue;
        if (entry.sha === null) {
          deleted.add(entry.path);
          continue;
        }
        if (entry.type === 'blob' && typeof entry.content === 'string') {
          const text = entry.content;
          const sha = this.computeSha(text);
          nextTree.set(entry.path, { text, sha });
          this.blobs.set(sha, text);
        } else if (entry.sha) {
          const blob = this.blobs.get(entry.sha);
          if (blob !== undefined) {
            nextTree.set(entry.path, { text: blob, sha: entry.sha });
          }
        }
      }
      const combined = this.cloneFiles(base);
      for (const [path, file] of nextTree.entries()) {
        combined.set(path, file);
      }
      for (const path of deleted) {
        combined.delete(path);
      }
      const treeSha = this.nextTree();
      this.treeRecords.set(treeSha, combined);
      return this.makeResponse(201, { sha: treeSha, tree: this.formatTree(combined, true) });
    }

    const createCommitMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/commits$/);
    if (createCommitMatch && method === 'POST') {
      const body = (await this.parseBody(request)) ?? {};
      const treeSha = typeof body.tree === 'string' ? body.tree : '';
      const parents: string[] = Array.isArray(body.parents) ? body.parents : [];
      const tree = this.treeRecords.get(treeSha);
      if (!tree) return this.makeResponse(404, { message: 'missing tree' });
      const commitSha = this.nextCommit();
      this.commitRecords.set(commitSha, {
        treeSha,
        files: this.cloneFiles(tree),
        parents,
      });
      return this.makeResponse(201, { sha: commitSha });
    }

    const contentGetMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (contentGetMatch && method === 'GET') {
      const path = decodeURIComponent(contentGetMatch[3] ?? '');
      const file = this.files.get(path);
      if (!file) return this.makeResponse(404, { message: 'not found' });
      return this.makeResponse(200, {
        path,
        sha: file.sha,
        content: Buffer.from(file.text, 'utf8').toString('base64'),
      });
    }

    const contentPutMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (contentPutMatch && method === 'PUT') {
      const path = decodeURIComponent(contentPutMatch[3] ?? '');
      const body = (await this.parseBody(request)) ?? {};
      const content =
        typeof body.content === 'string' ? Buffer.from(body.content, 'base64').toString('utf8') : '';
      if (!content) return this.makeResponse(400, { message: 'missing content' });
      const sha = this.computeSha(content);
      this.files.set(path, { text: content, sha });
      this.recordManualCommit();
      return this.makeResponse(200, { content: { sha } });
    }

    const deleteFileMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (deleteFileMatch && method === 'DELETE') {
      const path = decodeURIComponent(deleteFileMatch[3] ?? '');
      const existed = this.files.delete(path);
      if (existed) this.recordManualCommit();
      return this.makeResponse(200, { content: null });
    }

    return this.makeResponse(404, { message: 'not found' });
  }

  // Schedule a synthetic commit before the next ref update to simulate an external writer.
  advanceHeadOnNextUpdate(branch: string = this.defaultBranch) {
    this.pendingHeadAdvance.add(branch);
  }

  private createSyntheticCommit(branch: string) {
    const snapshot = this.cloneFiles(this.files);
    const treeSha = this.nextTree();
    this.treeRecords.set(treeSha, this.cloneFiles(snapshot));
    const parent = this.headByBranch.get(branch);
    const commitSha = this.nextCommit();
    this.commitRecords.set(commitSha, {
      treeSha,
      files: this.cloneFiles(snapshot),
      parents: parent ? [parent] : [],
    });
    this.setHead(branch, commitSha);
  }

  private isDescendant(descendant: string, ancestor: string): boolean {
    if (descendant === ancestor) return true;
    const visited = new Set<string>();
    const queue: string[] = [descendant];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      const commit = this.commitRecords.get(current);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  private ensureRequest(input: RequestInfo | URL, init?: RequestInit): Request {
    if (input instanceof Request) return input;
    if (typeof input === 'string' || input instanceof URL) {
      return new Request(input.toString(), init);
    }
    return new Request(String(input), init);
  }

  private isAuthorized(headers: Headers): boolean {
    const token = headers.get('Authorization');
    if (!token) return false;
    const match = token.match(/Bearer\s+(.*)$/);
    if (!match) return false;
    return this.installations.has(match[1] ?? '');
  }

  private cloneFiles(source: Map<string, RemoteFile>): Map<string, RemoteFile> {
    const clone = new Map<string, RemoteFile>();
    for (const [path, file] of source.entries()) {
      clone.set(path, { text: file.text, sha: file.sha });
    }
    return clone;
  }

  private matchesRepo(owner: string, repo: string): boolean {
    return owner === this.owner && repo === this.repo;
  }

  private computeSha(text: string): string {
    this.sequence += 1;
    return `sha-${this.sequence}-${this.simpleHash(text)}`;
  }

  private nextCommit(): string {
    this.commits += 1;
    return `commit-${this.commits}`;
  }

  private nextTree(): string {
    this.treeSequence += 1;
    return `tree-${this.treeSequence}`;
  }

  private simpleHash(text: string): string {
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h) ^ text.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
  }

  private async parseBody(request: Request): Promise<any> {
    const text = await request.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private setHead(branch: string, commitSha: string) {
    const record = this.commitRecords.get(commitSha);
    if (!record) return;
    this.headByBranch.set(branch, commitSha);
    this.files = this.cloneFiles(record.files);
    for (const file of record.files.values()) {
      this.blobs.set(file.sha, file.text);
    }
  }

  private recordManualCommit() {
    const snapshot = this.cloneFiles(this.files);
    const treeSha = this.nextTree();
    this.treeRecords.set(treeSha, snapshot);
    const parent = this.headByBranch.get(this.defaultBranch);
    const commitSha = this.nextCommit();
    const parents = parent ? [parent] : [];
    this.commitRecords.set(commitSha, {
      treeSha,
      files: this.cloneFiles(snapshot),
      parents,
    });
    this.setHead(this.defaultBranch, commitSha);
  }

  private formatTree(files: Map<string, RemoteFile>, recursive: boolean) {
    const entries: Array<{ path: string; type: string; sha: string }> = [];
    for (const [path, file] of files.entries()) {
      entries.push({ path, type: 'blob', sha: file.sha });
      if (!recursive) break;
    }
    return entries;
  }

  private makeResponse(status: number, body: any): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export { MockRemoteRepo };
