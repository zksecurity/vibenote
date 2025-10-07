import { useEffect, useMemo, useState } from 'react';

import type { NoteDoc } from '../storage/local';
import { hashText } from '../storage/local';
import { logError } from '../lib/logging';
import { buildRemoteConfig, listNoteFiles, pullNote } from '../sync/git-sync';

export { useReadOnlyNotes };
export type { ReadOnlyNote };

type ReadOnlyNote = { id: string; path: string; title: string; dir: string; sha?: string };

function useReadOnlyNotes(params: { slug: string; isReadOnly: boolean; defaultBranch?: string }) {
  let { slug, isReadOnly, defaultBranch } = params;
  let [notes, setNotes] = useState<ReadOnlyNote[]>([]);
  let [doc, setDoc] = useState<NoteDoc | null>(null);

  // Drop read-only data once we gain write access or lose read access.
  useEffect(() => {
    if (isReadOnly) return;
    setNotes((prev) => (prev.length === 0 ? prev : []));
    setDoc(null);
  }, [isReadOnly]);

  // Populate the read-only note list straight from GitHub when we lack write access.
  useEffect(() => {
    if (!isReadOnly) return;
    let cancelled = false;
    (async () => {
      try {
        let cfg = buildRemoteConfig(slug, defaultBranch);
        let entries = await listNoteFiles(cfg);
        let mapped = entries.map(toNote);
        if (cancelled) return;
        setNotes(mapped);
      } catch (error) {
        logError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isReadOnly, defaultBranch]);

  let folders = useMemo(() => {
    let set = new Set<string>();
    for (let note of notes) {
      if (note.dir === '') continue;
      let current = note.dir.replace(/(^\/+|\/+?$)/g, '');
      while (current) {
        set.add(current);
        let idx = current.lastIndexOf('/');
        current = idx >= 0 ? current.slice(0, idx) : '';
      }
    }
    return Array.from(set).sort();
  }, [notes]);

  return {
    // exposed state
    notes,
    doc,
    folders,

    // exposed actions

    /**
     * Fetch the latest contents when a read-only file is selected from the tree.
     */
    async loadNote(id: string) {
      let entry = notes.find((note) => note.id === id);
      if (!entry) return;
      let cfg = buildRemoteConfig(slug, defaultBranch);
      try {
        let remote = await pullNote(cfg, entry.path);
        if (!remote) return;
        setDoc({
          id: entry.id,
          path: entry.path,
          title: entry.title,
          dir: entry.dir,
          text: remote.text,
          updatedAt: Date.now(),
          lastRemoteSha: remote.sha,
          lastSyncedHash: hashText(remote.text),
        });
      } catch (error) {
        logError(error);
      }
    },

    clearDoc() {
      setDoc(null);
    },

    reset() {
      setNotes([]);
      setDoc(null);
    },
  };
}

function toNote({ path, sha }: { path: string; sha?: string }): ReadOnlyNote {
  const title = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const dir = (() => {
    const idx = path.lastIndexOf('/');
    return idx >= 0 ? path.slice(0, idx) : '';
  })();
  return { id: path, path, title, dir, sha };
}
