import { describe, expect, test } from 'vitest';
import { LocalStore, isMarkdownMeta, isMarkdownDoc } from './local';

describe('LocalStore cross-tab resilience', () => {
  test('stale second instance does not resurrect a deleted note', () => {
    const slug = 'user/repo';
    const storeA = new LocalStore(slug);
    const id1 = storeA.createFile('A.md', 'aaa');
    const id2 = storeA.createFile('B.md', 'bbb');

    // Second tab created before deletion; holds its own in-memory index
    const storeB = new LocalStore(slug);
    expect(
      storeB
        .listFiles()
        .map((n) => n.id)
        .sort()
    ).toEqual([id1, id2].sort());

    // Tab A deletes note A
    storeA.deleteFileById(id1);
    expect(storeA.listFiles().some((n) => n.id === id1)).toBe(false);

    // Tab B performs edits to the remaining note; should NOT re-add deleted id1
    const docB = storeB.loadFile(id2);
    expect(docB).not.toBeNull();
    if (docB) storeB.saveFileContent(docB.id, docB.content + ' updated', 'text/markdown');

    // LocalStorage should still be without id1
    const storeC = new LocalStore(slug);
    expect(storeC.listFiles().some((n) => n.id === id1)).toBe(false);
  });
});
