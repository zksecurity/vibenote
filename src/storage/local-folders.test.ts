import { beforeEach, describe, expect, test } from 'vitest';
import { LocalStore } from './local';

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

describe('LocalStore folder operations', () => {
  beforeEach(() => {
    globalAny.localStorage = new MemoryStorage();
  });

  test('create/rename/move/delete folder updates notes and index', () => {
    let store = new LocalStore('user/repo');
    store.createFolder('', 'a');
    store.createFolder('a', 'b');
    let id1 = store.createNote('One', '1', 'a');
    let id2 = store.createNote('Two', '2', 'a/b');
    expect(store.listFolders().sort()).toEqual(['a', 'a/b']);

    // Rename folder a -> x
    store.renameFolder('a', 'x');
    let paths1 = store
      .listNotes()
      .map((n) => n.path)
      .sort();
    expect(paths1).toEqual(['x/One.md', 'x/b/Two.md']);
    expect(store.listFolders().sort()).toEqual(['x', 'x/b']);

    // Move folder x/b -> y
    store.moveFolder('x/b', 'y');
    let paths2 = store
      .listNotes()
      .map((n) => n.path)
      .sort();
    expect(paths2).toEqual(['x/One.md', 'y/Two.md']);
    expect(store.listFolders().sort()).toEqual(['x', 'y']);

    // Delete folder x removes contained note
    store.deleteFolder('x');
    let ids = store.listNotes().map((n) => n.id);
    expect(ids).toEqual([id2]);
  });
});
