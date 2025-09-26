import { beforeEach, describe, expect, test } from 'vitest';
import { LocalStore, pruneRepoStorage, hashText, markSynced } from './local';

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

const globalAny = globalThis as { localStorage?: Storage };

describe('LocalStore cross-tab resilience', () => {
  beforeEach(() => {
    globalAny.localStorage = new MemoryStorage();
  });

  test('stale second instance does not resurrect a deleted note', () => {
    const slug = 'user/repo';
    const a = new LocalStore(slug, { seedWelcome: false });
    const id1 = a.createNote('A', 'aaa');
    const id2 = a.createNote('B', 'bbb');

    // Second tab created before deletion; holds its own in-memory index
    const b = new LocalStore(slug, { seedWelcome: false });
    expect(
      b
        .listNotes()
        .map((n) => n.id)
        .sort()
    ).toEqual([id1, id2].sort());

    // Tab A deletes note A
    a.deleteNote(id1);
    expect(a.listNotes().some((n) => n.id === id1)).toBe(false);

    // Tab B performs edits to the remaining note; should NOT re-add deleted id1
    const docB = b.loadNote(id2);
    expect(docB).not.toBeNull();
    if (docB) b.saveNote(docB.id, docB.text + ' updated');

    // LocalStorage should still be without id1
    const c = new LocalStore(slug, { seedWelcome: false });
    expect(c.listNotes().some((n) => n.id === id1)).toBe(false);
  });
});

describe('pruneRepoStorage', () => {
  beforeEach(() => {
    globalAny.localStorage = new MemoryStorage();
  });

  const indexKeyFor = (slug: string) => `vibenote:repo:${encodeURIComponent(slug)}:index`;
  const noteKeyFor = (slug: string, id: string) => `vibenote:repo:${encodeURIComponent(slug)}:note:${id}`;

  test('prunes stale synced notes and preserves unsynced text', () => {
    let slug = 'user/repo';
    let store = new LocalStore(slug, { seedWelcome: false });
    let syncedId = store.createNote('A', 'alpha content');
    let unsyncedId = store.createNote('B', 'beta content');

    markSynced(slug, syncedId, { remoteSha: 'sha-alpha', syncedHash: hashText('alpha content') });

    let past = Date.now() - 1000 * 60 * 60 * 24 * 60;
    let syncedDoc = store.loadNote(syncedId);
    if (!syncedDoc) throw new Error('synced doc missing');
    let updatedDoc = { ...syncedDoc, updatedAt: past };
    globalAny.localStorage?.setItem(noteKeyFor(slug, syncedId), JSON.stringify(updatedDoc));
    let metas = store.listNotes();
    let updatedMetas = metas.map((meta) => (meta.id === syncedId ? { ...meta, updatedAt: past } : meta));
    globalAny.localStorage?.setItem(indexKeyFor(slug), JSON.stringify(updatedMetas));

    pruneRepoStorage(slug, { keepRecent: 0, maxAgeMs: 0, maxChars: 0 });

    let prunedDoc = store.loadNote(syncedId);
    expect(prunedDoc?.isPruned).toBe(true);
    expect(prunedDoc?.text).toBe('');

    let retainedDoc = store.loadNote(unsyncedId);
    expect(retainedDoc?.isPruned).not.toBe(true);
    expect(retainedDoc?.text).toBe('beta content');
  });
});
