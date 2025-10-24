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

    // Move folder x/b into folder y
    let movedDir = store.moveFolder('x/b', 'y');
    expect(movedDir).toEqual('y/b');
    let paths2 = store
      .listFiles()
      .map((n) => n.path)
      .sort();
    expect(paths2).toEqual(['x/One.md', 'y/b/Two.md']);
    expect(store.listFolders().sort()).toEqual(['x', 'y', 'y/b']);

    // Delete folder x removes contained note
    store.deleteFolder('x');
    let ids = store.listFiles().map((file) => file.id);
    expect(ids).toEqual([id2]);
  });

  test('moveFile keeps name and updates directory', () => {
    let store = new LocalStore('user/repo');
    let id = store.createFile('docs/Note.md', 'body');
    let nextPath = store.moveFile('docs/Note.md', 'Archive');
    expect(nextPath).toEqual('Archive/Note.md');
    let meta = store.listFiles().find((item) => item.id === id);
    expect(meta?.path).toEqual('Archive/Note.md');
    let folders = store.listFolders().sort();
    expect(folders).toEqual(['Archive', 'docs']);
  });
});
