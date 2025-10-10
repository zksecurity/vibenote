import { useEffect, useMemo, useState } from 'react';
import type { FileKind, FileMeta, RepoFile } from '../storage/local';
import { normalizePath } from '../lib/util';
import { basename, extractDir, hashText, stripExtension } from '../storage/local';
import { logError } from '../lib/logging';
import { buildRemoteConfig, listRepoFiles, pullRepoFile } from '../sync/git-sync';

export { useReadOnlyFiles };

function useReadOnlyFiles(params: {
  slug: string;
  isReadOnly: boolean;
  defaultBranch?: string;
  desiredPath?: string;
}) {
  let { slug, isReadOnly, defaultBranch, desiredPath } = params;
  let [files, setFiles] = useState<FileMeta[]>([]);
  let [activeFile, setActiveFile] = useState<RepoFile | undefined>(undefined);
  desiredPath = desiredPath === undefined ? undefined : normalizePath(desiredPath);

  // Drop read-only data once we gain write access or lose read access.
  useEffect(() => {
    if (isReadOnly) return;
    setFiles((prev) => (prev.length === 0 ? prev : []));
    setActiveFile(undefined);
  }, [isReadOnly]);

  // Populate the read-only note list straight from GitHub when we lack write access.
  useEffect(() => {
    if (!isReadOnly) return;
    let cancelled = false;
    (async () => {
      try {
        let cfg = buildRemoteConfig(slug, defaultBranch);
        let entries = await listRepoFiles(cfg);
        let mapped = entries.map(toFile);
        if (cancelled) return;
        setFiles(mapped);
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
    for (let note of files) {
      if (note.dir === '') continue;
      let current = note.dir.replace(/(^\/+|\/+?$)/g, '');
      while (current) {
        set.add(current);
        let idx = current.lastIndexOf('/');
        current = idx >= 0 ? current.slice(0, idx) : '';
      }
    }
    return Array.from(set).sort();
  }, [files]);

  useEffect(() => {
    if (!isReadOnly) return;
    if (files.length === 0) return;
    let target: FileMeta | undefined;
    if (desiredPath !== undefined) {
      target = files.find((note) => normalizePath(note.path) === desiredPath);
      if (!target) {
        target = files.find((note) => note.path.toLowerCase() === 'readme.md');
      }
    } else {
      target = files.find((note) => note.path.toLowerCase() === 'readme.md');
    }
    if (!target) return;
    if (activeFile?.id === target.id) return;
    void loadFile(target);
  }, [isReadOnly, files, desiredPath, activeFile?.id]);

  async function loadFile(entry: FileMeta) {
    let cfg = buildRemoteConfig(slug, defaultBranch);
    try {
      let remote = await pullRepoFile(cfg, entry.path);
      if (!remote) return;
      setActiveFile({
        id: entry.id,
        path: entry.path,
        title: entry.title,
        dir: entry.dir,
        content: remote.content,
        updatedAt: Date.now(),
        lastRemoteSha: remote.sha,
        lastSyncedHash: hashText(remote.content),
        kind: remote.kind,
        mime: remote.mime,
      });
    } catch (error) {
      logError(error);
    }
  }

  return {
    // exposed state
    files,
    activeFile,
    folders,

    // exposed actions

    /**
     * Fetch the latest contents when a read-only file is selected from the tree.
     */
    async selectFile(id: string | undefined) {
      if (id === undefined) {
        setActiveFile(undefined);
        return;
      }
      if (!isReadOnly) return;
      let entry = files.find((note) => note.id === id);
      if (!entry) return;
      await loadFile(entry);
    },

    reset() {
      setFiles([]);
      setActiveFile(undefined);
    },
  };
}

function toFile({ path, kind, mime }: { path: string; kind: FileKind; mime: string }): FileMeta {
  let title = stripExtension(basename(path));
  let dir = extractDir(path);
  return { id: path, path, title, dir, updatedAt: 0, kind, mime };
}
