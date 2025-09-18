import { beforeEach, describe, expect, test } from 'vitest';
import { LocalStore, listTombstones } from '../storage/local';

declare const Buffer: { from(data: string, encoding: string): { toString(enc: string): string } };

const globalAny = globalThis as { localStorage?: Storage; fetch?: typeof fetch; atob?: typeof atob; btoa?: typeof btoa };

if (!globalAny.atob) {
  globalAny.atob = (data: string) => Buffer.from(data, 'base64').toString('binary');
}

if (!globalAny.btoa) {
  globalAny.btoa = (data: string) => Buffer.from(data, 'binary').toString('base64');
}

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key) ?? null : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

type RemoteFile = { text: string; sha: string };

class MockRemoteRepo {
  private files = new Map<string, RemoteFile>();
  private commits = 0;
  private readonly dirTrim = /^\/+|\/+$/g;
  private owner = '';
  private repo = '';
  private sequence = 0;

  configure(owner: string, repo: string) {
    this.owner = owner;
    this.repo = repo;
  }

  snapshot(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [path, file] of this.files.entries()) {
      result.set(path, file.text);
    }
    return result;
  }

  setFile(path: string, text: string) {
    this.files.set(path, { text, sha: this.computeSha(text) });
  }

  deleteDirect(path: string) {
    this.files.delete(path);
  }

  private computeSha(text: string): string {
    this.sequence += 1;
    return `sha-${this.sequence}-${this.simpleHash(text)}`;
  }

  private nextCommit(): string {
    this.commits += 1;
    return `commit-${this.commits}`;
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

    const contentsMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents(.*)$/);
    if (contentsMatch) {
      const [, owner, repo, rest] = contentsMatch;
      if (owner !== this.owner || repo !== this.repo) {
        return this.makeResponse(404, { message: 'not found' });
      }
      const rawPath = (rest ?? '').replace(/^\//, '');
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
      const [, owner, repo, sha] = blobMatch;
      if (owner !== this.owner || repo !== this.repo) {
        return this.makeResponse(404, { message: 'not found' });
      }
      for (const file of this.files.values()) {
        if (file.sha === sha) {
          return this.makeResponse(200, { content: Buffer.from(file.text, 'utf8').toString('base64') });
        }
      }
      return this.makeResponse(404, { message: 'not found' });
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
    const entries: Array<{ type: string; name: string; path: string; sha: string }> = [];
    const prefix = dir ? `${dir.replace(this.dirTrim, '')}/` : '';
    for (const [path, file] of this.files.entries()) {
      if (prefix && !path.startsWith(prefix)) continue;
      if (prefix) {
        const rest = path.slice(prefix.length);
        if (rest.includes('/')) continue;
      } else if (path.includes('/')) {
        continue;
      }
      entries.push({ type: 'file', name: path.slice(path.lastIndexOf('/') + 1), path, sha: file.sha });
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
  let configureRemote: typeof import('./git-sync').configureRemote;

beforeEach(async () => {
  globalAny.localStorage = new MemoryStorage();
  remote = new MockRemoteRepo();
  remote.configure('user', 'repo');
  globalAny.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
    return remote.handleFetch(new URL(raw), init);
  };
  const mod = await import('./git-sync');
  syncBidirectional = mod.syncBidirectional;
  configureRemote = mod.configureRemote;
  configureRemote({ owner: 'user', repo: 'repo', branch: 'main', notesDir: '' });
  store = new LocalStore({ seedWelcome: false });
});

  test('pushes new notes and remains stable', async () => {
    const firstId = store.createNote('First', 'first note');
    const secondId = store.createNote('Second', 'second note');
    await syncBidirectional(store);
    await syncBidirectional(store);
    expectParity(store, remote);
    expect(listTombstones()).toHaveLength(0);
    const firstDoc = store.loadNote(firstId);
    const secondDoc = store.loadNote(secondId);
    expect(firstDoc?.path).toBe('First.md');
    expect(secondDoc?.path).toBe('Second.md');
  });

  test('applies local deletions to remote without resurrection', async () => {
    const id = store.createNote('Ghost', 'haunt me');
    await syncBidirectional(store);
    store.deleteNote(id);
    await syncBidirectional(store);
    expectParity(store, remote);
    expect(store.listNotes()).toHaveLength(0);
    expect(listTombstones()).toHaveLength(0);
  });

  test('renames move files remotely', async () => {
    const id = store.createNote('Original', 'rename me');
    await syncBidirectional(store);
    store.renameNote(id, 'Renamed');
    await syncBidirectional(store);
    expectParity(store, remote);
    const notes = store.listNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.path).toBe('Renamed.md');
    expect([...remote.snapshot().keys()]).toEqual(['Renamed.md']);
  });

  test('rename removes old remote path after prior sync', async () => {
    const id = store.createNote('test', 'body');
    await syncBidirectional(store);
    expect([...remote.snapshot().keys()]).toEqual(['test.md']);
    store.renameNote(id, 'test2');
    await syncBidirectional(store);
    const remoteFiles = [...remote.snapshot().keys()].sort();
    expect(remoteFiles).toEqual(['test2.md']);
    expectParity(store, remote);
  });

  test('rename with remote edits keeps both copies in sync', async () => {
    const id = store.createNote('draft', 'original body');
    await syncBidirectional(store);
    remote.setFile('draft.md', 'remote update');
    store.renameNote(id, 'draft-renamed');
    await syncBidirectional(store);
    const paths = [...remote.snapshot().keys()].sort();
    expect(paths).toEqual(['draft-renamed.md', 'draft.md']);
    expectParity(store, remote);
    const localPaths = store.listNotes().map((n) => n.path).sort();
    expect(localPaths).toEqual(['draft-renamed.md', 'draft.md']);
  });

  test('pulls new remote notes', async () => {
    remote.setFile('Remote.md', '# remote');
    await syncBidirectional(store);
    expectParity(store, remote);
    const notes = store.listNotes();
    expect(notes).toHaveLength(1);
    const doc = store.loadNote(notes[0]?.id ?? '');
    expect(doc?.text).toBe('# remote');
  });

  test('removes notes when deleted remotely', async () => {
    const id = store.createNote('Shared', 'shared text');
    await syncBidirectional(store);
    remote.deleteDirect('Shared.md');
    await syncBidirectional(store);
    expectParity(store, remote);
    expect(store.listNotes()).toHaveLength(0);
  });

  test('ignores non-Markdown files when syncing', async () => {
    remote.setFile('data.json', '{"keep":true}');
    remote.setFile('image.png', 'binary');
    store.createNote('OnlyNote', '# hello');
    await syncBidirectional(store);
    const snapshot = remote.snapshot();
    expect(snapshot.get('data.json')).toBe('{"keep":true}');
    expect(snapshot.get('image.png')).toBe('binary');
    expect(snapshot.get('OnlyNote.md')).toBe('# hello');
  });

  test('leaves nested Markdown files untouched', async () => {
    remote.setFile('nested/Nested.md', '# nested');
    await syncBidirectional(store);
    const snapshot = remote.snapshot();
    expect(snapshot.get('nested/Nested.md')).toBe('# nested');
    expect(store.listNotes()).toHaveLength(0);
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
