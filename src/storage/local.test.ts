import { describe, expect, test } from 'vitest';
import { LocalStore } from './local';

describe('LocalStore cross-tab resilience', () => {
  test('stale second instance does not resurrect a deleted note', () => {
    const slug = 'user/repo';
    const a = new LocalStore(slug);
    const id1 = a.createNote('A', 'aaa');
    const id2 = a.createNote('B', 'bbb');

    // Second tab created before deletion; holds its own in-memory index
    const b = new LocalStore(slug);
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
    const c = new LocalStore(slug);
    expect(c.listNotes().some((n) => n.id === id1)).toBe(false);
  });
});
