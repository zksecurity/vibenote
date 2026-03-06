// Reactive in-memory store for a single repo's state, backed by IndexedDB.
// Provides file operations (create, rename, move, delete, save) that operate
// on the RepoState.workingFiles map, and a subscription model for React.
//
// This is the V2 replacement for the localStorage-based LocalStore in storage/local.ts.

import type {
  RepoState,
  WorkingFile,
  WorkingFileMeta,
  Path,
  GitSha,
  BaseSnapshot,
  RemoteSnapshot,
} from '../storage/repo-types';
import type { RepoDb } from '../storage/repo-db';
import { blobSha } from '../git/index';

export { RepoStateStore, createEmptyRepoState };
export type { FileInfo, FolderList };

// ---------------------------------------------------------------------------
// Types exposed to consumers
// ---------------------------------------------------------------------------

/** Simplified file metadata for UI display (comparable to old FileMeta). */
type FileInfo = {
  id: string; // = path (in V2, paths are the canonical identity)
  path: string;
  updatedAt: number;
};

type FolderList = string[];

type Snapshot = {
  files: FileInfo[];
  folders: FolderList;
};

// ---------------------------------------------------------------------------
// Factory for empty repo state
// ---------------------------------------------------------------------------

function createEmptyRepoState(repoId: string, branch = 'main'): RepoState {
  return {
    repoId,
    remote: { name: 'origin', url: `https://github.com/${repoId}.git` },
    branch: {
      head: { name: `refs/heads/${branch}`, sha: null },
    },
    base: {
      rootTree: '' as GitSha,
      entries: new Map(),
      baseCommit: null,
    },
    remoteSnapshot: {
      rootTree: '' as GitSha,
      entries: new Map(),
      remoteCommit: null,
    },
    workingFiles: new Map(),
    index: { entries: new Map() },
    status: new Map(),
    merge: { inProgress: false, conflictedPaths: new Set() },
    ignore: { patterns: [] },
    config: {},
    hashCache: { entries: new Map() },
    version: 0,
  };
}

// ---------------------------------------------------------------------------
// RepoStateStore — reactive wrapper around RepoState
// ---------------------------------------------------------------------------

const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

class RepoStateStore {
  private _state: RepoState;
  private _db: RepoDb | undefined;
  private _listeners = new Set<() => void>();
  private _snapshot: Snapshot;
  private _saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(state: RepoState, db?: RepoDb) {
    this._state = state;
    this._db = db;
    this._snapshot = this._buildSnapshot();
  }

  /** The current repo ID / slug. */
  get repoId(): string {
    return this._state.repoId;
  }

  /** Direct access to the underlying RepoState (for sync engine). */
  get state(): RepoState {
    return this._state;
  }

  /** Replace the entire state (e.g. after sync). */
  setState(next: RepoState) {
    this._state = next;
    this._onChanged();
  }

  // --- React subscription model ---

  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Get a stable snapshot for useSyncExternalStore. */
  getSnapshot(): Snapshot {
    return this._snapshot;
  }

  // --- File operations ---

  /** List all working files as simplified metadata. */
  listFiles(): FileInfo[] {
    return this._snapshot.files;
  }

  /** List all folders derived from file paths. */
  listFolders(): FolderList {
    return this._snapshot.folders;
  }

  /** Load a file's full content by path. */
  loadFile(path: string): { path: string; content: string; kind: string } | undefined {
    let file = this._state.workingFiles.get(path as Path);
    if (file === undefined) return undefined;
    let content = _decoder.decode(file.content);
    let kind = kindFromPath(path);
    return { path: file.path, content, kind };
  }

  /** Create a new file. Returns the path (which is also the ID in V2). */
  createFile(path: string, content: string): string {
    let normalizedPath = normalizePath(path);
    let contentBytes = _encoder.encode(content);
    let file: WorkingFile = {
      path: normalizedPath as Path,
      mode: '100644',
      content: contentBytes,
      size: contentBytes.byteLength,
      mtime: Date.now(),
    };
    this._state.workingFiles.set(normalizedPath as Path, file);
    this._onChanged();
    return normalizedPath;
  }

  /** Save (overwrite) a file's content. */
  saveFile(path: string, content: string) {
    let file = this._state.workingFiles.get(path as Path);
    if (file === undefined) return;
    let contentBytes = _encoder.encode(content);
    this._state.workingFiles.set(path as Path, {
      ...file,
      content: contentBytes,
      size: contentBytes.byteLength,
      blobSha: undefined, // invalidate cached hash
      mtime: Date.now(),
    });
    this._onChanged();
  }

  /** Rename a file (change the last path segment). Returns the new path. */
  renameFile(path: string, newName: string): string | undefined {
    let file = this._state.workingFiles.get(path as Path);
    if (file === undefined) return undefined;
    let dir = extractDir(path);
    let newPath = dir === '' ? newName : `${dir}/${newName}`;
    let normalizedNew = normalizePath(newPath);
    if (this._state.workingFiles.has(normalizedNew as Path)) return undefined;
    this._state.workingFiles.delete(path as Path);
    this._state.workingFiles.set(normalizedNew as Path, {
      ...file,
      path: normalizedNew as Path,
      mtime: Date.now(),
    });
    this._onChanged();
    return normalizedNew;
  }

  /** Move a file to a different directory. Returns the new path. */
  moveFile(path: string, targetDir: string): string | undefined {
    let file = this._state.workingFiles.get(path as Path);
    if (file === undefined) return undefined;
    let name = basename(path);
    let newPath = targetDir === '' ? name : `${targetDir}/${name}`;
    let normalizedNew = normalizePath(newPath);
    if (this._state.workingFiles.has(normalizedNew as Path)) return undefined;
    this._state.workingFiles.delete(path as Path);
    this._state.workingFiles.set(normalizedNew as Path, {
      ...file,
      path: normalizedNew as Path,
      mtime: Date.now(),
    });
    this._onChanged();
    return normalizedNew;
  }

  /** Delete a file by path. Returns true if the file existed. */
  deleteFile(path: string): boolean {
    let existed = this._state.workingFiles.delete(path as Path);
    if (existed) this._onChanged();
    return existed;
  }

  /** Create a folder (implicitly — folders exist because files have paths). */
  createFolder(parentDir: string, name: string) {
    // In the new model, folders are implicit. We just need to store the
    // folder in a set so the UI can show empty folders.
    // For now, create a .gitkeep file to make the folder exist.
    let folderPath = parentDir === '' ? name : `${parentDir}/${name}`;
    let keepPath = `${folderPath}/.gitkeep`;
    let normalizedKeep = normalizePath(keepPath);
    if (!this._state.workingFiles.has(normalizedKeep as Path)) {
      this.createFile(normalizedKeep, '');
    }
  }

  /** Rename a folder. Returns the new folder path. */
  renameFolder(dir: string, newName: string): string | undefined {
    let parentDir = extractDir(dir);
    let newDir = parentDir === '' ? newName : `${parentDir}/${newName}`;
    return this._moveFolder(dir, newDir);
  }

  /** Move a folder into a target directory. Returns the new folder path. */
  moveFolder(dir: string, targetDir: string): string | undefined {
    let name = basename(dir);
    let newDir = targetDir === '' ? name : `${targetDir}/${name}`;
    return this._moveFolder(dir, newDir);
  }

  /** Delete a folder and all files inside it. */
  deleteFolder(dir: string) {
    let prefix = dir + '/';
    let toDelete: Path[] = [];
    for (let [path] of this._state.workingFiles) {
      if (path === dir || path.startsWith(prefix)) {
        toDelete.push(path);
      }
    }
    for (let path of toDelete) {
      this._state.workingFiles.delete(path);
    }
    if (toDelete.length > 0) this._onChanged();
  }

  // --- Persistence ---

  /** Persist current state to IndexedDB (debounced). */
  scheduleSave() {
    if (this._db === undefined) return;
    if (this._saveTimer !== undefined) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = undefined;
      void this._persistToDb();
    }, 500);
  }

  /** Force an immediate persist. */
  async forceSave() {
    if (this._db === undefined) return;
    if (this._saveTimer !== undefined) {
      clearTimeout(this._saveTimer);
      this._saveTimer = undefined;
    }
    await this._persistToDb();
  }

  // --- Internal helpers ---

  private _moveFolder(fromDir: string, toDir: string): string | undefined {
    let prefix = fromDir + '/';
    let moves: Array<{ oldPath: Path; newPath: Path; file: WorkingFile }> = [];
    for (let [path, file] of this._state.workingFiles) {
      if (path.startsWith(prefix)) {
        let suffix = path.slice(prefix.length);
        let newPath = `${toDir}/${suffix}` as Path;
        moves.push({ oldPath: path, newPath, file });
      }
    }
    if (moves.length === 0) return undefined;
    for (let { oldPath, newPath, file } of moves) {
      this._state.workingFiles.delete(oldPath);
      this._state.workingFiles.set(newPath, {
        ...file,
        path: newPath,
        mtime: Date.now(),
      });
    }
    this._onChanged();
    return toDir;
  }

  private _onChanged() {
    this._snapshot = this._buildSnapshot();
    this.scheduleSave();
    for (let listener of this._listeners) {
      listener();
    }
  }

  private _buildSnapshot(): Snapshot {
    let files: FileInfo[] = [];
    let folderSet = new Set<string>();

    for (let [path, file] of this._state.workingFiles) {
      files.push({
        id: path,
        path,
        updatedAt: file.mtime ?? 0,
      });
      // Collect all ancestor folders
      let dir = extractDir(path);
      while (dir !== '') {
        if (folderSet.has(dir)) break;
        folderSet.add(dir);
        dir = extractDir(dir);
      }
    }

    // Sort files by path for stable rendering
    files.sort((a, b) => a.path.localeCompare(b.path));
    let folders = Array.from(folderSet).sort();

    return { files, folders };
  }

  private async _persistToDb() {
    if (this._db === undefined) return;
    try {
      await this._db.saveRepoState(this._state);
    } catch (err) {
      console.warn('vibenote: failed to persist repo state', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function extractDir(path: string): string {
  let lastSlash = path.lastIndexOf('/');
  if (lastSlash === -1) return '';
  return path.slice(0, lastSlash);
}

function basename(path: string): string {
  let lastSlash = path.lastIndexOf('/');
  if (lastSlash === -1) return path;
  return path.slice(lastSlash + 1);
}

function normalizePath(path: string): string {
  return path.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

function kindFromPath(path: string): string {
  let lower = path.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  let binaryExts = [
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
    '.pdf', '.zip', '.tar', '.gz',
    '.mp3', '.mp4', '.wav', '.ogg',
    '.woff', '.woff2', '.ttf', '.otf',
  ];
  if (binaryExts.some(ext => lower.endsWith(ext))) return 'binary';
  return 'text';
}
