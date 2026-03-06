// Tests for RepoStateStore — the reactive in-memory store for repo state.

import { describe, it, expect, vi } from 'vitest';
import { RepoStateStore, createEmptyRepoState } from './repo-state-store';

describe('RepoStateStore', () => {
  function makeStore() {
    let state = createEmptyRepoState('test/repo');
    return new RepoStateStore(state);
  }

  describe('file operations', () => {
    it('creates a file and lists it', () => {
      let store = makeStore();
      let path = store.createFile('notes/hello.md', '# Hello');
      expect(path).toBe('notes/hello.md');

      let files = store.listFiles();
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe('notes/hello.md');
    });

    it('loads file content', () => {
      let store = makeStore();
      store.createFile('test.md', 'content here');
      let loaded = store.loadFile('test.md');
      expect(loaded).toBeDefined();
      expect(loaded!.content).toBe('content here');
      expect(loaded!.kind).toBe('markdown');
    });

    it('saves file content', () => {
      let store = makeStore();
      store.createFile('test.md', 'original');
      store.saveFile('test.md', 'updated');
      let loaded = store.loadFile('test.md');
      expect(loaded!.content).toBe('updated');
    });

    it('renames a file', () => {
      let store = makeStore();
      store.createFile('notes/old.md', 'content');
      let newPath = store.renameFile('notes/old.md', 'new.md');
      expect(newPath).toBe('notes/new.md');
      expect(store.loadFile('notes/old.md')).toBeUndefined();
      expect(store.loadFile('notes/new.md')!.content).toBe('content');
    });

    it('moves a file to another directory', () => {
      let store = makeStore();
      store.createFile('src/file.md', 'content');
      let newPath = store.moveFile('src/file.md', 'dest');
      expect(newPath).toBe('dest/file.md');
      expect(store.loadFile('src/file.md')).toBeUndefined();
      expect(store.loadFile('dest/file.md')!.content).toBe('content');
    });

    it('moves a file to root directory', () => {
      let store = makeStore();
      store.createFile('nested/file.md', 'content');
      let newPath = store.moveFile('nested/file.md', '');
      expect(newPath).toBe('file.md');
      expect(store.loadFile('file.md')!.content).toBe('content');
    });

    it('deletes a file', () => {
      let store = makeStore();
      store.createFile('delete-me.md', 'gone');
      let deleted = store.deleteFile('delete-me.md');
      expect(deleted).toBe(true);
      expect(store.loadFile('delete-me.md')).toBeUndefined();
      expect(store.listFiles()).toHaveLength(0);
    });

    it('returns false when deleting nonexistent file', () => {
      let store = makeStore();
      let deleted = store.deleteFile('nope.md');
      expect(deleted).toBe(false);
    });

    it('prevents rename to existing path', () => {
      let store = makeStore();
      store.createFile('a.md', 'a');
      store.createFile('b.md', 'b');
      let result = store.renameFile('a.md', 'b.md');
      expect(result).toBeUndefined();
      // Both files should still exist unchanged
      expect(store.loadFile('a.md')!.content).toBe('a');
      expect(store.loadFile('b.md')!.content).toBe('b');
    });
  });

  describe('folder operations', () => {
    it('derives folders from file paths', () => {
      let store = makeStore();
      store.createFile('src/components/Button.md', '');
      store.createFile('docs/guide.md', '');
      let folders = store.listFolders();
      expect(folders).toContain('src');
      expect(folders).toContain('src/components');
      expect(folders).toContain('docs');
    });

    it('renames a folder', () => {
      let store = makeStore();
      store.createFile('old-name/file1.md', 'a');
      store.createFile('old-name/sub/file2.md', 'b');
      let newDir = store.renameFolder('old-name', 'new-name');
      expect(newDir).toBe('new-name');
      expect(store.loadFile('new-name/file1.md')!.content).toBe('a');
      expect(store.loadFile('new-name/sub/file2.md')!.content).toBe('b');
      expect(store.loadFile('old-name/file1.md')).toBeUndefined();
    });

    it('moves a folder', () => {
      let store = makeStore();
      store.createFile('src/file.md', 'content');
      let newDir = store.moveFolder('src', 'dest');
      expect(newDir).toBe('dest/src');
      expect(store.loadFile('dest/src/file.md')!.content).toBe('content');
      expect(store.loadFile('src/file.md')).toBeUndefined();
    });

    it('deletes a folder and all contents', () => {
      let store = makeStore();
      store.createFile('dir/a.md', 'a');
      store.createFile('dir/sub/b.md', 'b');
      store.createFile('other.md', 'keep');
      store.deleteFolder('dir');
      expect(store.listFiles()).toHaveLength(1);
      expect(store.listFiles()[0]!.path).toBe('other.md');
    });
  });

  describe('subscription model', () => {
    it('notifies listeners on file create', () => {
      let store = makeStore();
      let listener = vi.fn();
      store.subscribe(listener);
      store.createFile('test.md', 'content');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('notifies listeners on file save', () => {
      let store = makeStore();
      store.createFile('test.md', 'original');
      let listener = vi.fn();
      store.subscribe(listener);
      store.saveFile('test.md', 'updated');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('notifies listeners on delete', () => {
      let store = makeStore();
      store.createFile('test.md', 'content');
      let listener = vi.fn();
      store.subscribe(listener);
      store.deleteFile('test.md');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('unsubscribe stops notifications', () => {
      let store = makeStore();
      let listener = vi.fn();
      let unsub = store.subscribe(listener);
      store.createFile('a.md', 'a');
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
      store.createFile('b.md', 'b');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('snapshot is stable when no changes', () => {
      let store = makeStore();
      store.createFile('test.md', 'content');
      let snap1 = store.getSnapshot();
      let snap2 = store.getSnapshot();
      expect(snap1).toBe(snap2); // referential equality
    });

    it('snapshot changes on mutation', () => {
      let store = makeStore();
      store.createFile('test.md', 'content');
      let snap1 = store.getSnapshot();
      store.saveFile('test.md', 'updated');
      let snap2 = store.getSnapshot();
      expect(snap1).not.toBe(snap2);
    });
  });

  describe('state management', () => {
    it('setState replaces the entire state', () => {
      let store = makeStore();
      store.createFile('old.md', 'old');

      let newState = createEmptyRepoState('test/repo');
      let enc = new TextEncoder();
      let content = enc.encode('new content');
      newState.workingFiles.set('new.md' as any, {
        path: 'new.md' as any,
        mode: '100644',
        content,
        size: content.byteLength,
        mtime: Date.now(),
      });

      store.setState(newState);
      expect(store.loadFile('old.md')).toBeUndefined();
      expect(store.loadFile('new.md')!.content).toBe('new content');
    });

    it('exposes the raw state for sync engine', () => {
      let store = makeStore();
      store.createFile('test.md', 'content');
      let raw = store.state;
      expect(raw.workingFiles.size).toBe(1);
      expect(raw.repoId).toBe('test/repo');
    });
  });
});
