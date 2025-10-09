import { describe, expect, test } from 'vitest';
import { LocalStore } from './local';

function createMarkdown(store: LocalStore, title: string, text: string, dir = '') {
  return store.createFile({
    path: dir ? `${dir}/${title}.md` : `${title}.md`,
    dir,
    title,
    content: text,
    kind: 'markdown',
    mime: 'text/markdown',
  });
}

describe('LocalStore folder operations', () => {
  test('create/rename/move/delete folder updates notes and index', () => {
    let store = new LocalStore('user/repo');
    store.createFolder('', 'a');
    store.createFolder('a', 'b');
  let id1 = createMarkdown(store, 'One', '1', 'a');
  let id2 = createMarkdown(store, 'Two', '2', 'a/b');
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
