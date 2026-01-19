import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileKind, FileMeta, RepoFile } from '../storage/local';
import { normalizePath } from '../lib/util';
import { extractDir, hashText } from '../storage/local';
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

  // Track loading state to prevent concurrent loads and race conditions.
  // When selectFile() initiates a load, we set this to the target path.
  // The auto-load effect skips if a manual selection is in progress.
  let loadingRef = useRef<string | null>(null);

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
      if (extractDir(note.path) === '') continue;
      let current = extractDir(note.path).replace(/(^\/+|\/+?$)/g, '');
      while (current) {
        set.add(current);
        let idx = current.lastIndexOf('/');
        current = idx >= 0 ? current.slice(0, idx) : '';
      }
    }
    return Array.from(set).sort();
  }, [files]);

  // Auto-load file based on desiredPath (from URL).
  // Skip if a manual selection (selectFile) is already in progress to avoid races.
  useEffect(() => {
    if (!isReadOnly) return;
    if (files.length === 0) return;
    // Skip auto-load if selectFile() is currently loading a file
    if (loadingRef.current !== null) return;
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
    void loadFile(target.path, target);
  }, [isReadOnly, files, desiredPath, activeFile?.id]);

  async function loadFile(targetPath: string, entry: FileMeta) {
    // Mark that we're loading this specific path
    loadingRef.current = targetPath;
    let cfg = buildRemoteConfig(slug, defaultBranch);
    try {
      let remote = await pullRepoFile(cfg, entry.path);
      // Only update if this is still the active load request (prevents stale updates)
      if (loadingRef.current !== targetPath) return;
      if (!remote) {
        loadingRef.current = null;
        return;
      }
      // Don't clear loadingRef here - let it stay set until the NEXT loadFile call or selectFile(undefined).
      // This prevents the auto-load effect from re-triggering between setActiveFile and the next render.
      // The ref will be naturally superseded when a new file is selected.
      setActiveFile({
        id: entry.id,
        path: entry.path,
        content: remote.content,
        updatedAt: Date.now(),
        lastRemoteSha: remote.sha,
        lastSyncedHash: hashText(remote.content),
        kind: remote.kind,
      });
    } catch (error) {
      logError(error);
      // Only clear on error so we can retry
      if (loadingRef.current === targetPath) {
        loadingRef.current = null;
      }
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
        loadingRef.current = null;
        return;
      }
      if (!isReadOnly) return;
      let entry = files.find((note) => note.id === id);
      if (!entry) return;
      await loadFile(entry.path, entry);
    },

    reset() {
      setFiles([]);
      setActiveFile(undefined);
    },
  };
}

function toFile({ path, kind }: { path: string; kind: FileKind }): FileMeta {
  return { id: path, path, updatedAt: 0, kind };
}
