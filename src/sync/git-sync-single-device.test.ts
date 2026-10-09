// Exercise manual sync with one local writer, including edits during requests,
// cached reads, and a lost response after GitHub accepts a foreground commit.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { LocalStore, resetRepoStore, type RepoFile } from '../storage/local';
import { clearBlobCache } from '../storage/blob-cache';
import { computeGitBlobSha } from '../lib/git-hash';
import { MockRemoteRepo } from '../test/mock-remote';
import { syncBidirectional } from './git-sync';
import * as merge from '../merge/merge';

const authModule = vi.hoisted(() => ({ ensureFreshAccessToken: vi.fn() }));
vi.mock('../auth/app-auth', () => authModule);

const SLUG = 'user/repo';
const API = 'https://api.github.com/repos/user/repo';

type CachedResponse = { body: string; status: number; headers: Headers };

describe('single-device manual sync invariant', () => {
  let store: LocalStore;
  let remote: MockRemoteRepo;
  let cachedResponses: Map<string, CachedResponse>;
  let dropNextAcknowledgement: boolean;
  let onRequest: ((request: Request, phase: 'before' | 'after') => void) | undefined;

  beforeEach(async () => {
    authModule.ensureFreshAccessToken.mockResolvedValue('test-token');
    await clearBlobCache();
    vi.spyOn(merge, 'mergeMarkdown');
    remote = new MockRemoteRepo();
    remote.configure('user', 'repo');
    remote.allowToken('test-token');
    store = new LocalStore(SLUG);
    cachedResponses = new Map();
    dropNextAcknowledgement = false;
    onRequest = undefined;

    // Every remote write comes from syncBidirectional: no setFile, worker,
    // autosync timer, second store writer, or synthetic external commit.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      let request = input instanceof Request ? input : new Request(input, init);
      let url = new URL(request.url);
      onRequest?.(request, 'before');
      let cached = cachedResponses.get(url.pathname);
      if (request.method === 'GET' && cached !== undefined && !bypassesCache(request)) {
        onRequest?.(request, 'after');
        return new Response(cached.body, { status: cached.status, headers: cached.headers });
      }
      let response = await remote.handleFetch(request);
      onRequest?.(request, 'after');
      let publishesRef =
        request.method === 'PATCH' || (request.method === 'POST' && url.pathname.endsWith('/git/refs'));
      if (dropNextAcknowledgement && publishesRef && response.ok) {
        dropNextAcknowledgement = false;
        // GitHub has already advanced the branch; only its response is lost.
        throw new TypeError('Network response lost after ref update');
      }
      return response;
    });
  });

  test.each([1, 7, 29, 101])('generated edits and request interleavings, seed %i', async (seed) => {
    let random = seededRandom(seed);
    let expected = new Map([
      ['Note.md', '# First\n\nOriginal paragraph.'],
      ['docs/Other.md', '# Second\n\nOther paragraph.'],
    ]);
    for (let [path, content] of expected) store.createFile(path, content);
    await syncBidirectional(store, SLUG);

    for (let step = 0; step < 50; step += 1) {
      let path = random() % 2 === 0 ? 'Note.md' : 'docs/Other.md';
      let edit = () => {
        let content = mutateText(expected.get(path) ?? '', random());
        expected.set(path, content);
        store.saveFile(path, content);
      };
      edit();

      // Deterministically place an extra edit before/after tree creation or
      // ref publication, so the text can change while its snapshot uploads.
      let trigger = random() % 4;
      onRequest = (request, phase) => {
        let url = new URL(request.url);
        let isTree = request.method === 'POST' && url.pathname.endsWith('/git/trees');
        let isRef = request.method === 'PATCH';
        let matchesEndpoint = trigger < 2 ? isTree : isRef;
        let matchesPhase = trigger % 2 === 0 ? phase === 'before' : phase === 'after';
        if (!matchesEndpoint || !matchesPhase) return;
        onRequest = undefined;
        edit();
      };
      let summary = await syncBidirectional(store, SLUG);
      onRequest = undefined;
      expect(summary.merged, `seed ${seed}, step ${step}`).toBe(0);
      assertLocalContents(store, expected);

      // A fresh LocalStore must pick up the same persisted working copy.
      if (step % 7 === 0) store = new LocalStore(SLUG);
      await syncBidirectional(store, SLUG);
      assertLocalContents(store, expected);
      expect(remote.snapshot()).toEqual(expected);
      expect(merge.mergeMarkdown).not.toHaveBeenCalled();
    }
  });

  test('a cached earlier manual-sync snapshot must not discard acknowledged text', async () => {
    let id = store.createFile('Note.md', 'Original notes.');
    await syncBidirectional(store, SLUG);
    await cacheCurrentNote();
    let latest = 'New paragraph.\n\nOriginal notes.';
    store.saveFile('Note.md', latest);
    // Temporarily use the current remote to acknowledge this manual upload.
    let stale = cachedResponses;
    cachedResponses = new Map();
    await syncBidirectional(store, SLUG);
    cachedResponses = stale;

    await syncBidirectional(store, SLUG);
    expect(loadFile(store, id).content).toBe(latest);
    expect(merge.mergeMarkdown).not.toHaveBeenCalled();
  });

  test('editing after a successful manual sync must not merge with its cached predecessor', async () => {
    let id = store.createFile('Note.md', 'Original notes.');
    await syncBidirectional(store, SLUG);
    await cacheCurrentNote();
    let stale = cachedResponses;
    cachedResponses = new Map();
    store.saveFile('Note.md', 'New paragraph.\n\nOriginal notes.');
    await syncBidirectional(store, SLUG);

    let latest = 'Rewritten paragraph.\n\nOriginal notes.';
    store.saveFile('Note.md', latest);
    cachedResponses = stale;
    await syncBidirectional(store, SLUG);
    expect.soft(loadFile(store, id).content).toBe(latest);
    expect.soft(remote.snapshot().get('Note.md')).toBe(latest);
    expect(merge.mergeMarkdown).not.toHaveBeenCalled();
  });

  test.each([false, true])('lost acknowledgement followed by typing (reload %s)', async (reload) => {
    let id = store.createFile('Note.md', 'Original notes.');
    await syncBidirectional(store, SLUG);
    let uploaded = 'New paragraph.\n\nOriginal notes.';
    store.saveFile('Note.md', uploaded);
    dropNextAcknowledgement = true;
    await expect(syncBidirectional(store, SLUG)).rejects.toThrow('Network response lost');
    expect(remote.snapshot().get('Note.md')).toBe(uploaded);
    expect(loadFile(store, id).content).toBe(uploaded);
    expect(loadFile(store, id).pendingUploads).toMatchObject([
      { path: 'Note.md', remoteSha: await computeGitBlobSha(uploaded) },
    ]);

    if (reload) {
      resetRepoStore(SLUG);
      store = new LocalStore(SLUG);
    }

    let latest = 'Rewritten paragraph.\n\nOriginal notes.';
    store.saveFile('Note.md', latest);
    await syncBidirectional(store, SLUG);
    expect.soft(loadFile(store, id).content).toBe(latest);
    expect.soft(remote.snapshot().get('Note.md')).toBe(latest);
    expect(merge.mergeMarkdown).not.toHaveBeenCalled();
    expect(loadFile(store, id).pendingUploads).toBeUndefined();
  });

  test('retrying a lost acknowledgement without new edits is harmless', async () => {
    let id = store.createFile('Note.md', 'Original notes.');
    await syncBidirectional(store, SLUG);
    let latest = 'New paragraph.\n\nOriginal notes.';
    store.saveFile('Note.md', latest);
    dropNextAcknowledgement = true;
    await expect(syncBidirectional(store, SLUG)).rejects.toThrow('Network response lost');
    await syncBidirectional(store, SLUG);
    expect(loadFile(store, id).content).toBe(latest);
    expect(remote.snapshot().get('Note.md')).toBe(latest);
    expect(merge.mergeMarkdown).not.toHaveBeenCalled();
    expect(loadFile(store, id).pendingUploads).toBeUndefined();
  });

  test('recovers a lost response when publishing a new repository branch', async () => {
    let id = store.createFile('Note.md', 'First upload.');
    dropNextAcknowledgement = true;
    await expect(syncBidirectional(store, SLUG)).rejects.toThrow('Network response lost');
    expect(remote.snapshot().get('Note.md')).toBe('First upload.');
    resetRepoStore(SLUG);
    store = new LocalStore(SLUG);
    store.saveFile('Note.md', 'Newer text after reopening.');
    await syncBidirectional(store, SLUG);
    expect(loadFile(store, id).content).toBe('Newer text after reopening.');
    expect(remote.snapshot().get('Note.md')).toBe('Newer text after reopening.');
    expect(merge.mergeMarkdown).not.toHaveBeenCalled();
    expect(loadFile(store, id).pendingUploads).toBeUndefined();
  });

  test('repeated lost responses and reloads do not accumulate artificial conflicts', async () => {
    let id = store.createFile('Note.md', 'Original notes.');
    await syncBidirectional(store, SLUG);
    for (let version of ['First paragraph.', 'Second paragraph.', 'Third paragraph.']) {
      let text = `${version}\n\nOriginal notes.`;
      store.saveFile('Note.md', text);
      dropNextAcknowledgement = true;
      await expect(syncBidirectional(store, SLUG)).rejects.toThrow('Network response lost');
      expect(loadFile(store, id).content).toBe(text);
      expect(remote.snapshot().get('Note.md')).toBe(text);
      resetRepoStore(SLUG);
      store = new LocalStore(SLUG);
    }
    store.saveFile('Note.md', 'Final paragraph.\n\nOriginal notes.');
    await syncBidirectional(store, SLUG);
    expect(remote.snapshot().get('Note.md')).toBe('Final paragraph.\n\nOriginal notes.');
    expect(merge.mergeMarkdown).not.toHaveBeenCalled();
    expect(loadFile(store, id).pendingUploads).toBeUndefined();
  });

  test('recovers every file in a batch while preserving newer edits to one file', async () => {
    let firstId = store.createFile('Note.md', 'Original first.');
    let secondId = store.createFile('docs/Other.md', 'Original second.');
    await syncBidirectional(store, SLUG);
    store.saveFile('Note.md', 'Uploaded first.');
    store.saveFile('docs/Other.md', 'Uploaded second.');
    dropNextAcknowledgement = true;
    await expect(syncBidirectional(store, SLUG)).rejects.toThrow('Network response lost');
    store.saveFile('Note.md', 'Newer first.');
    await syncBidirectional(store, SLUG);
    expect(remote.snapshot()).toEqual(
      new Map([
        ['Note.md', 'Newer first.'],
        ['docs/Other.md', 'Uploaded second.'],
      ])
    );
    expect(loadFile(store, firstId).pendingUploads).toBeUndefined();
    expect(loadFile(store, secondId).pendingUploads).toBeUndefined();
    expect(merge.mergeMarkdown).not.toHaveBeenCalled();
  });

  test('publication failure leaves a pending record but does not claim it succeeded', async () => {
    let id = store.createFile('Note.md', 'Original notes.');
    await syncBidirectional(store, SLUG);
    let baseline = loadFile(store, id).lastRemoteSha;
    store.saveFile('Note.md', 'Attempted paragraph.');
    onRequest = (request, phase) => {
      if (request.method !== 'PATCH' || phase !== 'before') return;
      expect(loadFile(store, id).pendingUploads).toHaveLength(1);
      throw new TypeError('Request failed before ref update');
    };
    await expect(syncBidirectional(store, SLUG)).rejects.toThrow('Request failed');
    expect(loadFile(store, id).lastRemoteSha).toBe(baseline);
    expect(remote.snapshot().get('Note.md')).toBe('Original notes.');
    onRequest = undefined;
    store.saveFile('Note.md', 'Newer paragraph.');
    await syncBidirectional(store, SLUG);
    expect(remote.snapshot().get('Note.md')).toBe('Newer paragraph.');
    expect(loadFile(store, id).pendingUploads).toBeUndefined();
    expect(merge.mergeMarkdown).not.toHaveBeenCalled();
  });

  test('an external edit differing from a failed upload still takes the normal merge path', async () => {
    let id = store.createFile('Note.md', '# Local\nOriginal local.\n\n# Remote\nOriginal remote.');
    await syncBidirectional(store, SLUG);
    store.saveFile('Note.md', '# Local\nAttempted local.\n\n# Remote\nOriginal remote.');
    onRequest = (request, phase) => {
      if (request.method === 'PATCH' && phase === 'before') {
        throw new TypeError('Request failed before ref update');
      }
    };
    await expect(syncBidirectional(store, SLUG)).rejects.toThrow('Request failed');
    onRequest = undefined;
    remote.setFile('Note.md', '# Local\nOriginal local.\n\n# Remote\nChanged remotely.');
    store.saveFile('Note.md', '# Local\nChanged locally.\n\n# Remote\nOriginal remote.');
    let summary = await syncBidirectional(store, SLUG);
    let expected = '# Local\nChanged locally.\n\n# Remote\nChanged remotely.';
    expect(summary.merged).toBe(1);
    expect(merge.mergeMarkdown).toHaveBeenCalledTimes(1);
    expect(loadFile(store, id).content).toBe(expected);
    expect(remote.snapshot().get('Note.md')).toBe(expected);
  });

  async function cacheCurrentNote() {
    for (let path of ['/git/trees/main?recursive=1', '/contents/Note.md?ref=main']) {
      let response = await remote.handleFetch(`${API}${path}`);
      cachedResponses.set(new URL(`${API}${path}`).pathname, {
        body: await response.text(),
        status: response.status,
        headers: response.headers,
      });
    }
  }
});

function loadFile(store: LocalStore, id: string): RepoFile {
  let doc = store.loadFileById(id);
  if (doc === null) throw new Error(`Missing local file ${id}`);
  return doc;
}

function assertLocalContents(store: LocalStore, expected: Map<string, string>) {
  let actual = new Map(store.listFiles().map((meta) => [meta.path, loadFile(store, meta.id).content]));
  expect(actual).toEqual(expected);
}

function bypassesCache(request: Request): boolean {
  let cacheControl = request.headers.get('Cache-Control') ?? '';
  return (
    ['no-store', 'reload', 'no-cache'].includes(request.cache) ||
    /no-cache|no-store/i.test(cacheControl) ||
    new URL(request.url).searchParams.has('cache_bust')
  );
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function mutateText(text: string, value: number): string {
  switch (value % 6) {
    case 0:
      return `${text}\n\nParagraph ${value}: naïve café 🚀.`;
    case 1:
      return `# Heading ${value}\n\n${text}`;
    case 2:
      return text.replace(/Paragraph|paragraph|Heading/g, `Revised ${value}`);
    case 3:
      return Array.from(text)
        .slice(Math.floor(Array.from(text).length / 3))
        .join('');
    case 4:
      return '';
    default:
      return `${text}\n\n- [ ] Task ${value}\n\`\`\`ts\nlet n = ${value};\n\`\`\``;
  }
}
