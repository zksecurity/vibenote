import { describe, expect, test } from 'vitest';
import { LocalStore, isMarkdownMeta, isMarkdownDoc } from './local';

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
});
