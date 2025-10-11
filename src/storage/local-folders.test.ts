import { describe, expect, test } from 'vitest';
import { LocalStore } from './local';

describe('LocalStore folder operations', () => {
  test('create/rename/move/delete folder updates notes and index', () => {
    let store = new LocalStore('user/repo');
    store.createFolder('', 'a');
    store.createFolder('a', 'b');
    let id1 = store.createFile('a/One.md', '1');
    let id2 = store.createFile('a/b/Two.md', '2');
    expect(store.listFolders().sort()).toEqual(['a', 'a/b']);

    // Rename folder a -> x
    store.renameFolder('a', 'x');
    let paths1 = store
      .listFiles()
      .map((n) => n.path)
      .sort();
    expect(paths1).toEqual(['x/One.md', 'x/b/Two.md']);
    expect(store.listFolders().sort()).toEqual(['x', 'x/b']);

    // Move folder x/b -> y
    store.moveFolder('x/b', 'y');
    let paths2 = store
      .listFiles()
      .map((n) => n.path)
      .sort();
    expect(paths2).toEqual(['x/One.md', 'y/Two.md']);
    expect(store.listFolders().sort()).toEqual(['x', 'y']);

    // Delete folder x removes contained note
    store.deleteFolder('x');
    let ids = store.listFiles().map((file) => file.id);
    expect(ids).toEqual([id2]);
  });
});
