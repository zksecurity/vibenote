import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { LocalStore, listTombstones, clearAllTombstones } from './local';

describe('LocalStore cross-tab resilience', () => {
  test('stale second instance does not resurrect a deleted note', () => {
    const slug = 'user/repo';
    const a = new LocalStore(slug);
    const id1 = a.createFile('A.md', 'aaa');
    const id2 = a.createFile('B.md', 'bbb');

    // Second tab created before deletion; holds its own in-memory index
    const b = new LocalStore(slug);
    expect(
      b
        .listFiles()
        .map((n) => n.id)
        .sort()
    ).toEqual([id1, id2].sort());

    // Tab A deletes note A
    a.deleteFileById(id1);
    expect(a.listFiles().some((n) => n.id === id1)).toBe(false);

    // Tab B performs edits to the remaining note; should NOT re-add deleted id1
    const docB = b.loadFile(id2);
    expect(docB).not.toBeNull();
    if (docB) b.saveFileContent(docB.id, docB.content + ' updated', 'text/markdown');

    // LocalStorage should still be without id1
    const c = new LocalStore(slug);
    expect(c.listFiles().some((n) => n.id === id1)).toBe(false);
  });

  test('rename tombstones collapse when a rename is reverted', () => {
    let slug = `user/repo-${randomUUID()}`;
    let store = new LocalStore(slug);
    let id = store.createFile('First.md', 'body');
    store.renameFileById(id, 'Second.md');
    store.renameFileById(id, 'First.md');
    expect(listTombstones(slug)).toEqual([]);
    clearAllTombstones(slug);
  });

  test('rename tombstones merge when a file is renamed multiple times', () => {
    let slug = `user/repo-${randomUUID()}`;
    let store = new LocalStore(slug);
    let id = store.createFile('Start.md', 'body');
    store.renameFileById(id, 'Middle.md');
    store.renameFileById(id, 'End.md');
    let tombstones = listTombstones(slug);
    expect(tombstones).toHaveLength(1);
    let entry = tombstones[0];
    expect(entry).toMatchObject({ type: 'rename', from: 'Start.md', to: 'End.md' });
    clearAllTombstones(slug);
  });
});
