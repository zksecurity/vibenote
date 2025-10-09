import { describe, expect, test } from 'vitest';
import { LocalStore, isMarkdownMeta, isMarkdownDoc } from './local';

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

function listMarkdown(store: LocalStore) {
  return store.listFiles().filter(isMarkdownMeta);
}

function loadMarkdown(store: LocalStore, id: string) {
  let doc = store.loadFile(id);
  return doc && isMarkdownDoc(doc) ? doc : null;
}

describe('LocalStore cross-tab resilience', () => {
  test('stale second instance does not resurrect a deleted note', () => {
    const slug = 'user/repo';
    const a = new LocalStore(slug);
    const id1 = createMarkdown(a, 'A', 'aaa');
    const id2 = createMarkdown(a, 'B', 'bbb');

    // Second tab created before deletion; holds its own in-memory index
    const b = new LocalStore(slug);
    expect(listMarkdown(b).map((n) => n.id).sort()).toEqual([id1, id2].sort());

    // Tab A deletes note A
    a.deleteFileById(id1);
    expect(listMarkdown(a).some((n) => n.id === id1)).toBe(false);

    // Tab B performs edits to the remaining note; should NOT re-add deleted id1
    const docB = loadMarkdown(b, id2);
    expect(docB).not.toBeNull();
    if (docB) b.saveFileContent(docB.id, docB.content + ' updated', 'text/markdown');

    // LocalStorage should still be without id1
    const c = new LocalStore(slug);
    expect(listMarkdown(c).some((n) => n.id === id1)).toBe(false);
  });
});
