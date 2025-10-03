import { beforeEach, describe, expect, test, vi } from 'vitest';
import { LocalStore, listTombstones } from '../storage/local';

const authModule = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn().mockResolvedValue('test-token'),
}));

vi.mock('../auth/app-auth', () => authModule);

const globalAny = globalThis as {
  fetch?: typeof fetch;
};

type RemoteFile = { text: string; sha: string };

class MockRemoteRepo {
  private files = new Map<string, RemoteFile>();
  private commits = 0;
  private readonly dirTrim = /^\/+|\/+$/g;
  private owner = '';
  private repo = '';
  private sequence = 0;
  private readonly defaultBranch = 'main';
  private treeSequence = 0;
  private blobs = new Map<string, string>();
  private headByBranch = new Map<string, string>();
  private treeRecords = new Map<string, Map<string, RemoteFile>>();
  private commitRecords = new Map<string, { treeSha: string; files: Map<string, RemoteFile>; parents: string[] }>();

  configure(owner: string, repo: string) {
    this.owner = owner;
    this.repo = repo;
  }

  private cloneFiles(source: Map<string, RemoteFile>): Map<string, RemoteFile> {
    const clone = new Map<string, RemoteFile>();
    for (const [path, file] of source.entries()) {
      clone.set(path, { text: file.text, sha: file.sha });
    }
    return clone;
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

  private parseBody(body?: BodyInit | null): any {
    if (!body) return null;
    const text = typeof body === 'string' ? body : (body as any).toString();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private matchesRepo(owner: string, repo: string): boolean {
    return owner === this.owner && repo === this.repo;
  }

  private getCommitSnapshot(commitSha: string): Map<string, RemoteFile> | null {
    const record = this.commitRecords.get(commitSha);
    if (!record) return null;
    return this.cloneFiles(record.files);
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

  private simpleHash(text: string): string {
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h) ^ text.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
  }

  async handleFetch(url: URL, init?: RequestInit) {
    const method = (init?.method ?? 'GET').toUpperCase();
    const pathname = url.pathname;
    if (pathname === `/repos/${this.owner}/${this.repo}` && method === 'GET') {
      return this.makeResponse(200, {});
    }

    if (pathname === '/user/repos' && method === 'POST') {
      return this.makeResponse(201, {});
    }

    const refGetMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/([^/]+)$/);
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
      return this.makeResponse(200, {
        ref: `refs/heads/${branch}`,
        object: { sha: head, type: 'commit' },
      });
    }

    if (pathname === `/repos/${this.owner}/${this.repo}/git/refs` && method === 'POST') {
      const body = this.parseBody(init?.body);
      const ref = typeof body?.ref === 'string' ? body.ref : '';
      const sha = typeof body?.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/heads/') || !this.commitRecords.has(sha)) {
        return this.makeResponse(422, { message: 'invalid ref' });
      }
      const branch = ref.replace('refs/heads/', '');
      this.setHead(branch, sha);
      return this.makeResponse(201, { ref, object: { sha, type: 'commit' } });
    }

    const refUpdateMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/([^/]+)$/);
    if (refUpdateMatch && method === 'PATCH') {
      const owner = refUpdateMatch[1] ?? '';
      const repo = refUpdateMatch[2] ?? '';
      const branchSegment = refUpdateMatch[3] ?? '';
      if (!this.matchesRepo(owner, repo)) {
        return this.makeResponse(404, { message: 'not found' });
      }
      const payload = this.parseBody(init?.body);
      const sha = typeof payload?.sha === 'string' ? payload.sha : '';
      if (!this.commitRecords.has(sha)) {
        return this.makeResponse(404, { message: 'commit not found' });
      }
      const branch = decodeURIComponent(branchSegment);
      this.setHead(branch, sha);
      return this.makeResponse(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    }

    if (pathname === `/repos/${this.owner}/${this.repo}/git/trees` && method === 'POST') {
      const body = this.parseBody(init?.body);
      const entries = Array.isArray(body?.tree) ? body.tree : [];
      const baseTreeValue = typeof body?.base_tree === 'string' ? body.base_tree : null;
      const baseSnapshot = baseTreeValue && this.treeRecords.has(baseTreeValue)
        ? this.cloneFiles(this.treeRecords.get(baseTreeValue) ?? this.files)
        : this.cloneFiles(this.files);
      const updatedEntries: Array<{ path: string; type: string; sha: string }> = [];
      for (const entry of entries) {
        if (!entry || typeof entry.path !== 'string') continue;
        const path = entry.path;
        if (entry.sha === null) {
          baseSnapshot.delete(path);
          continue;
        }
        if (typeof entry.content === 'string') {
          const text = entry.content;
          const sha = this.computeSha(text);
          baseSnapshot.set(path, { text, sha });
          this.blobs.set(sha, text);
          updatedEntries.push({ path, type: 'blob', sha });
        }
      }
      const treeSha = this.nextTree();
      this.treeRecords.set(treeSha, baseSnapshot);
      return this.makeResponse(201, { sha: treeSha, tree: updatedEntries });
    }

    const treeGetMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^/]+)$/);
    if (treeGetMatch && method === 'GET') {
      const owner = treeGetMatch[1] ?? '';
      const repo = treeGetMatch[2] ?? '';
      const refSegment = treeGetMatch[3] ?? '';
      if (!this.matchesRepo(owner, repo)) {
        return this.makeResponse(404, { message: 'not found' });
      }
      const ref = decodeURIComponent(refSegment);
      let snapshot: Map<string, RemoteFile> | null = null;
      if (this.headByBranch.has(ref)) {
        const commitSha = this.headByBranch.get(ref)!;
        snapshot = this.getCommitSnapshot(commitSha);
      } else if (this.treeRecords.has(ref)) {
        snapshot = this.cloneFiles(this.treeRecords.get(ref)!);
      } else if (this.commitRecords.has(ref)) {
        const commit = this.commitRecords.get(ref)!;
        snapshot = this.cloneFiles(commit.files);
      }
      if (!snapshot) {
        snapshot = this.cloneFiles(this.files);
      }
      const tree = Array.from(snapshot.entries()).map(([path, file]) => ({
        path,
        type: 'blob',
        sha: file.sha,
      }));
      return this.makeResponse(200, { tree });
    }

    const commitGetMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/commits\/([^/]+)$/);
    if (commitGetMatch && method === 'GET') {
      const owner = commitGetMatch[1] ?? '';
      const repo = commitGetMatch[2] ?? '';
      const sha = commitGetMatch[3] ?? '';
      if (!this.matchesRepo(owner, repo)) {
        return this.makeResponse(404, { message: 'not found' });
      }
      const record = this.commitRecords.get(sha);
      if (!record) {
        return this.makeResponse(404, { message: 'not found' });
      }
      return this.makeResponse(200, { sha, tree: { sha: record.treeSha }, parents: record.parents });
    }

    if (pathname === `/repos/${this.owner}/${this.repo}/git/commits` && method === 'POST') {
      const body = this.parseBody(init?.body);
      const treeSha = typeof body?.tree === 'string' ? body.tree : '';
      if (!treeSha || !this.treeRecords.has(treeSha)) {
        return this.makeResponse(422, { message: 'invalid tree' });
      }
      const commitSha = this.nextCommit();
      const parents = Array.isArray(body?.parents) ? body.parents.map((p: unknown) => String(p)) : [];
      const filesSnapshot = this.cloneFiles(this.treeRecords.get(treeSha)!);
      this.commitRecords.set(commitSha, { treeSha, files: filesSnapshot, parents });
      return this.makeResponse(201, { sha: commitSha, tree: { sha: treeSha }, parents });
    }

    const contentsMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents(.*)$/);
    if (contentsMatch) {
      const owner = contentsMatch[1] ?? '';
      const repo = contentsMatch[2] ?? '';
      const rest = contentsMatch[3] ?? '';
      if (!this.matchesRepo(owner, repo)) {
        return this.makeResponse(404, { message: 'not found' });
      }
      const rawPath = rest.replace(/^\//, '');
      if (method === 'GET') {
        return this.handleGetContents(rawPath);
      }
      if (method === 'PUT') {
        return this.handlePutContents(rawPath, init?.body);
      }
      if (method === 'DELETE') {
        return this.handleDeleteContents(rawPath, init?.body);
      }
    }

    const blobMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/([^/]+)$/);
    if (blobMatch && method === 'GET') {
      const owner = blobMatch[1] ?? '';
      const repo = blobMatch[2] ?? '';
      const sha = blobMatch[3] ?? '';
      if (!this.matchesRepo(owner, repo)) {
        return this.makeResponse(404, { message: 'not found' });
      }
      const text = this.blobs.get(sha);
      if (!text) {
        return this.makeResponse(404, { message: 'not found' });
      }
      return this.makeResponse(200, {
        content: Buffer.from(text, 'utf8').toString('base64'),
      });
    }

    return this.makeResponse(404, { message: 'not found' });
  }

  private handleGetContents(rawPath: string) {
    const decoded = decodeURIComponent(rawPath);
    const path = decoded.replace(this.dirTrim, '');
    if (!path) {
      return this.makeResponse(200, this.directoryListing(''));
    }
    const file = this.files.get(path);
    if (file) {
      return this.makeResponse(200, {
        path,
        name: path.slice(path.lastIndexOf('/') + 1),
        type: 'file',
        sha: file.sha,
        content: Buffer.from(file.text, 'utf8').toString('base64'),
      });
    }
    return this.makeResponse(200, this.directoryListing(path));
  }

  private handlePutContents(rawPath: string, body?: BodyInit | null) {
    if (!body) return this.makeResponse(400, { message: 'missing body' });
    const json = JSON.parse(body.toString()) as { content: string; sha?: string };
    const text = Buffer.from(json.content, 'base64').toString('utf8');
    const path = decodeURIComponent(rawPath.replace(this.dirTrim, ''));
    const existing = this.files.get(path);
    if (existing) {
      if (!json.sha || json.sha !== existing.sha) {
        return this.makeResponse(409, { message: 'sha mismatch' });
      }
    } else if (json.sha) {
      return this.makeResponse(404, { message: 'missing file for sha' });
    }
    const sha = this.computeSha(text);
    this.files.set(path, { text, sha });
    this.blobs.set(sha, text);
    return this.makeResponse(200, {
      content: { path, sha },
      commit: { sha: this.nextCommit() },
    });
  }

  private handleDeleteContents(rawPath: string, body?: BodyInit | null) {
    if (!body) return this.makeResponse(400, { message: 'missing body' });
    const json = JSON.parse(body.toString()) as { sha?: string };
    const path = decodeURIComponent(rawPath.replace(this.dirTrim, ''));
    const existing = this.files.get(path);
    if (!existing) {
      return this.makeResponse(404, { message: 'not found' });
    }
    if (json.sha && json.sha !== existing.sha) {
      return this.makeResponse(409, { message: 'sha mismatch' });
    }
    this.files.delete(path);
    return this.makeResponse(200, { commit: { sha: this.nextCommit() } });
  }

  private directoryListing(dir: string) {
    const entries: Array<{ type: string; name: string; path: string; sha?: string }> = [];
    const prefix = dir ? `${dir.replace(this.dirTrim, '')}/` : '';
    const seenDirs = new Set<string>();
    for (const [path, file] of this.files.entries()) {
      if (prefix && !path.startsWith(prefix)) continue;
      const rest = prefix ? path.slice(prefix.length) : path;
      const slash = rest.indexOf('/');
      if (slash >= 0) {
        const childDir = rest.slice(0, slash);
        if (!seenDirs.has(childDir)) {
          seenDirs.add(childDir);
          const full = `${(prefix + childDir).replace(this.dirTrim, '')}`;
          entries.push({ type: 'dir', name: childDir, path: full });
        }
        continue;
      }
      entries.push({ type: 'file', name: rest, path, sha: file.sha });
    }
    return entries;
  }

  private makeResponse(status: number, data: unknown) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

describe('syncBidirectional', () => {
  let store: LocalStore;
  let remote: MockRemoteRepo;
  let syncBidirectional: typeof import('./git-sync').syncBidirectional;

  beforeEach(async () => {
    authModule.ensureFreshAccessToken.mockReset();
    authModule.ensureFreshAccessToken.mockResolvedValue('test-token');
    remote = new MockRemoteRepo();
    remote.configure('user', 'repo');
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      return remote.handleFetch(new URL(raw), init);
    });
    globalAny.fetch = fetchMock as unknown as typeof fetch;
    const mod = await import('./git-sync');
    syncBidirectional = mod.syncBidirectional;
    store = new LocalStore('user/repo');
  });

  test('pushes new notes and remains stable', async () => {
    const firstId = store.createNote('First', 'first note');
    const secondId = store.createNote('Second', 'second note');
    await syncBidirectional(store, 'user/repo');
    await syncBidirectional(store, 'user/repo');
    expectParity(store, remote);
    expect(listTombstones(store.slug)).toHaveLength(0);
    const firstDoc = store.loadNote(firstId);
    const secondDoc = store.loadNote(secondId);
    expect(firstDoc?.path).toBe('First.md');
    expect(secondDoc?.path).toBe('Second.md');
  });

  test('applies local deletions to remote without resurrection', async () => {
    const id = store.createNote('Ghost', 'haunt me');
    await syncBidirectional(store, 'user/repo');
    store.deleteNote(id);
    await syncBidirectional(store, 'user/repo');
    expectParity(store, remote);
    expect(store.listNotes()).toHaveLength(0);
    expect(listTombstones(store.slug)).toHaveLength(0);
  });

  test('renames move files remotely', async () => {
    const id = store.createNote('Original', 'rename me');
    await syncBidirectional(store, 'user/repo');
    store.renameNote(id, 'Renamed');
    await syncBidirectional(store, 'user/repo');
    expectParity(store, remote);
    const notes = store.listNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.path).toBe('Renamed.md');
    expect([...remote.snapshot().keys()]).toEqual(['Renamed.md']);
  });

  test('rename removes old remote path after prior sync', async () => {
    const id = store.createNote('test', 'body');
    await syncBidirectional(store, 'user/repo');
    expect([...remote.snapshot().keys()]).toEqual(['test.md']);
    store.renameNote(id, 'test2');
    await syncBidirectional(store, 'user/repo');
    const remoteFiles = [...remote.snapshot().keys()].sort();
    expect(remoteFiles).toEqual(['test2.md']);
    expectParity(store, remote);
  });

  test('rename with remote edits keeps both copies in sync', async () => {
    const id = store.createNote('draft', 'original body');
    await syncBidirectional(store, 'user/repo');
    remote.setFile('draft.md', 'remote update');
    store.renameNote(id, 'draft-renamed');
    await syncBidirectional(store, 'user/repo');
    const paths = [...remote.snapshot().keys()].sort();
    expect(paths).toEqual(['draft-renamed.md', 'draft.md']);
    expectParity(store, remote);
    const localPaths = store
      .listNotes()
      .map((n) => n.path)
      .sort();
    expect(localPaths).toEqual(['draft-renamed.md', 'draft.md']);
  });

  test('pulls new remote notes', async () => {
    remote.setFile('Remote.md', '# remote');
    await syncBidirectional(store, 'user/repo');
    expectParity(store, remote);
    const notes = store.listNotes();
    expect(notes).toHaveLength(1);
    const doc = store.loadNote(notes[0]?.id ?? '');
    expect(doc?.text).toBe('# remote');
  });

  test('removes notes when deleted remotely', async () => {
    const id = store.createNote('Shared', 'shared text');
    await syncBidirectional(store, 'user/repo');
    remote.deleteDirect('Shared.md');
    await syncBidirectional(store, 'user/repo');
    expectParity(store, remote);
    expect(store.listNotes()).toHaveLength(0);
  });

  test('ignores non-Markdown files when syncing', async () => {
    remote.setFile('data.json', '{"keep":true}');
    remote.setFile('image.png', 'binary');
    store.createNote('OnlyNote', '# hello');
    await syncBidirectional(store, 'user/repo');
    const snapshot = remote.snapshot();
    expect(snapshot.get('data.json')).toBe('{"keep":true}');
    expect(snapshot.get('image.png')).toBe('binary');
    expect(snapshot.get('OnlyNote.md')).toBe('# hello');
  });

  test('pulls nested Markdown files', async () => {
    remote.setFile('nested/Nested.md', '# nested');
    await syncBidirectional(store, 'user/repo');
    const notes = store.listNotes();
    expect(notes).toHaveLength(1);
    const doc = store.loadNote(notes[0]?.id ?? '');
    expect(doc?.path).toBe('nested/Nested.md');
    expect(doc?.dir).toBe('nested');
    expect(doc?.text).toBe('# nested');
  });

  test('listNoteFiles includes nested markdown', async () => {
    const mod = await import('./git-sync');
    remote.setFile('nested/Nested.md', '# nested');
    let cfg = mod.buildRemoteConfig('user/repo');
    let entries = await mod.listNoteFiles(cfg);
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(['nested/Nested.md']);
  });

  test('excludes README.md regardless of directory', async () => {
    remote.setFile('README.md', 'root readme');
    remote.setFile('sub/README.md', 'sub readme');
    await syncBidirectional(store, 'user/repo');
    const paths = store
      .listNotes()
      .map((n) => n.path)
      .sort();
    expect(paths).toEqual([]);
  });
});

function expectParity(store: LocalStore, remote: MockRemoteRepo) {
  const localMap = new Map<string, string>();
  for (const meta of store.listNotes()) {
    const doc = store.loadNote(meta.id);
    if (doc) localMap.set(meta.path, doc.text);
  }
  const remoteMap = remote.snapshot();
  expect([...remoteMap.keys()].sort()).toEqual([...localMap.keys()].sort());
  for (const [path, text] of localMap.entries()) {
    expect(remoteMap.get(path)).toBe(text);
  }
}
