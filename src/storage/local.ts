// Local storage persistence for repo files (markdown notes plus binary assets).
import { normalizePath } from '../lib/util';
import { logError } from '../lib/logging';
import type { RemoteFile } from '../sync/git-sync';

export type { FileKind, FileMeta, RepoFile, MarkdownFile, BinaryFile, AssetUrlFile, RepoStoreSnapshot };

export { basename, stripExtension, extractDir, isMarkdownFile, isBinaryFile, isAssetUrlFile, debugLog };

type FileKind = 'markdown' | 'binary' | 'asset-url';

/**
 * Backwards-compatible serialized format for file metadata
 */
type StoredFileMeta = {
  id: string;
  path: string;
  updatedAt: number;
  kind?: FileKind;
};

/**
 * Backwards-compatible serialized format for stored files.
 */
type StoredFile = StoredFileMeta & {
  text: string;
  lastRemoteSha?: string;
  lastSyncedHash?: string;
};

type FileMeta = {
  id: string;
  path: string;
  updatedAt: number;
  kind: FileKind;
};

type RepoFile = FileMeta & {
  content: string; // markdown uses UTF-8 text, binary uses base64 payloads
  lastRemoteSha?: string;
  lastSyncedHash?: string;
};

type MarkdownFile = RepoFile & { kind: 'markdown' };
type BinaryFile = RepoFile & { kind: 'binary' };
type AssetUrlFile = RepoFile & { kind: 'asset-url' };

function isMarkdownFile(doc: RepoFile): doc is MarkdownFile {
  return doc.kind === 'markdown';
}

function isBinaryFile(doc: RepoFile): doc is BinaryFile {
  return doc.kind === 'binary';
}

function isAssetUrlFile(doc: RepoFile): doc is AssetUrlFile {
  return doc.kind === 'asset-url';
}

function serializeIndex(index: FileMeta[]): string {
  // important: written metadata stays compatible with `StoredFileMeta`
  return JSON.stringify(index satisfies StoredFileMeta[]);
}
function deserializeIndex(raw: string | null): FileMeta[] {
  if (raw === null) return [];
  try {
    let parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeMeta).filter((m) => m !== null);
  } catch {
    return [];
  }
}

function serializeFile(doc: RepoFile): string {
  // important: written files stay compatible with `StoredFile`
  return JSON.stringify(toStoredFile(doc) satisfies StoredFile);
}
function deserializeFile(raw: string | null): RepoFile | null {
  if (raw === null) return null;
  // important: read files stay compatible with `StoredFile`
  try {
    let parsed = JSON.parse(raw);
    return normalizeFile(parsed);
  } catch {
    return null;
  }
}

// --- Debug logging ---
const DEBUG_ENABLED = false;

const NS = 'vibenote';
const REPO_PREFIX = `${NS}:repo`;
const LINK_PREFIX = `${NS}:repo-link`;
const PREFS_SUFFIX = 'prefs';
const FOLDERS_SUFFIX = 'folders';

const WELCOME_NOTE = `# 👋 Welcome to VibeNote

**VibeNote** is a friendly home for your Markdown notes that syncs straight to a GitHub repository you control.

## Why VibeNote?
- ✨ Clean note-taking UI that feels at home on desktop and mobile.
- 🗂️ Your notes are just Markdown files on GitHub, versioned and portable.
- 🔄 One-click sync keeps local edits and remote changes in step.

## Quick start
1. Hit the GitHub button to sign in via the GitHub App authorization flow.
2. Pick the repository VibeNote should sync with.
3. "Get Read/Write Access" to install the VibeNote app on that repo.
4. Create or open a note in the list on the left, and edit it.
5. Use the circular sync icon whenever you want to pull and push changes.

## Transparency for engineers
- 🗃️ Notes live in your browser storage and inside your GitHub repo — we never copy them to our servers.
- 🤝 Automatic conflict resolution handles Markdown merges for you, so you never have to untangle git conflicts.
- 🔐 The VibeNote GitHub App has minimal authority: Read/write is only allowed when a user also has the same permission on GitHub,
  AND only on repos where VibeNote was installed with at least the same permissions.

## Learn more
- 📦 Source code: https://github.com/mitschabaude/vibenote
- 💡 Have ideas or found a bug? Open an issue on GitHub and help shape the roadmap.

Happy writing! ✍️`;

function repoStoragePrefix(slug: string): string {
  return `${REPO_PREFIX}:${encodeSlug(slug)}:`;
}

// Shared per-slug cache so every LocalStore instance observes the same state and
// we only bind one storage listener for cross-tab updates.
function ensureRepoSubscribers(slug: string): RepoSubscribers {
  const normalized = normalizeSlug(slug);
  let shared = repoSubscribers.get(normalized);
  const currentStorage =
    typeof window !== 'undefined'
      ? window.localStorage
      : (globalThis as { localStorage?: Storage }).localStorage;
  if (!shared) {
    shared = {
      snapshot: readRepoSnapshot(normalized),
      listeners: new Set(),
      storageRef: currentStorage,
    };
    if (typeof window !== 'undefined') {
      const prefix = repoStoragePrefix(normalized);
      const handler = (event: StorageEvent) => {
        if (event.storageArea !== window.localStorage) return;
        if (!event.key || !event.key.startsWith(prefix)) return;
        emitRepoChange(normalized);
      };
      window.addEventListener('storage', handler);
      shared.storageListener = handler;
    }
    repoSubscribers.set(normalized, shared);
  } else if (shared.storageRef !== currentStorage && currentStorage) {
    shared.storageRef = currentStorage;
    refreshRepoSnapshot(normalized, shared);
  }
  return shared;
}

function refreshRepoSnapshot(slug: string, shared = ensureRepoSubscribers(slug)) {
  shared.snapshot = readRepoSnapshot(slug);
}

function emitRepoChange(slug: string) {
  const shared = repoSubscribers.get(normalizeSlug(slug));
  if (!shared) return;
  refreshRepoSnapshot(slug, shared);
  for (const listener of Array.from(shared.listeners)) {
    try {
      listener();
    } catch (error) {
      logError(error);
    }
  }
}

function readRepoSnapshot(slug: string): RepoStoreSnapshot {
  const files = loadIndexForSlug(slug)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const folders = loadFoldersForSlug(slug);
  return {
    files: Object.freeze(files) as FileMeta[],
    folders: Object.freeze(folders) as string[],
  };
}

type RepoStoreSnapshot = {
  files: FileMeta[];
  folders: string[];
};

type RepoSubscribers = {
  snapshot: RepoStoreSnapshot;
  listeners: Set<() => void>;
  storageListener?: (event: StorageEvent) => void;
  storageRef?: Storage;
};

const repoSubscribers = new Map<string, RepoSubscribers>();
const storeCache = new Map<string, LocalStore>();

export function getRepoStore(slug: string): LocalStore {
  const normalized = normalizeSlug(slug);
  let store = storeCache.get(normalized);
  if (!store) {
    store = new LocalStore(normalized);
    storeCache.set(normalized, store);
  }
  return store;
}

export function resetRepoStore(slug: string) {
  const normalized = normalizeSlug(slug);
  const shared = repoSubscribers.get(normalized);
  if (shared?.storageListener && typeof window !== 'undefined') {
    window.removeEventListener('storage', shared.storageListener);
  }
  repoSubscribers.delete(normalized);
  storeCache.delete(normalized);
}

function resetAllRepoStores() {
  for (const key of repoSubscribers.keys()) {
    resetRepoStore(key);
  }
  storeCache.clear();
}

export class LocalStore {
  slug: string;
  private index: FileMeta[];
  private indexKey: string;
  private notePrefix: string;
  private foldersKey: string;

  constructor(slug: string) {
    slug = normalizeSlug(slug);
    this.slug = slug;
    this.indexKey = repoKey(this.slug, 'index');
    this.notePrefix = `${repoKey(this.slug, 'note')}:`;
    this.foldersKey = repoKey(this.slug, FOLDERS_SUFFIX);
    this.index = this.loadIndex();
    // ensure `folders` index is built
    // TODO do we need this? we should assume a certain local storage layout and parse strictly to assert it is satisfied
    // that layout should be documented clearly in the form of types and zod schemas
    this.backfillFolders();
    if (slug === 'new' && this.index.length === 0) {
      this.createFile('README.md', WELCOME_NOTE);
      this.index = this.loadIndex();
    }
    ensureRepoSubscribers(this.slug);
  }

  getSnapshot(): RepoStoreSnapshot {
    const shared = ensureRepoSubscribers(this.slug);
    return shared.snapshot;
  }

  subscribe(listener: () => void): () => void {
    const shared = ensureRepoSubscribers(this.slug);
    shared.listeners.add(listener);
    return () => {
      shared.listeners.delete(listener);
    };
  }

  listFiles(): FileMeta[] {
    const snapshot = ensureRepoSubscribers(this.slug).snapshot;
    this.index = snapshot.files;
    return snapshot.files.slice();
  }

  loadFileById(id: string): RepoFile | null {
    let raw = localStorage.getItem(this.noteKey(id));
    return deserializeFile(raw);
  }

  saveFile(path: string, content: string) {
    let meta = this.findMetaByPath(path);
    if (meta === undefined) return;
    this.saveFileById(meta.id, content);
  }

  private saveFileById(id: string, content: string) {
    let doc = this.loadFileById(id);
    if (!doc) return;
    let updatedAt = Date.now();
    let next: RepoFile = { ...doc, content, updatedAt };
    localStorage.setItem(this.noteKey(id), serializeFile(next));
    this.touchIndex(id, { updatedAt });
    debugLog(this.slug, 'saveFile', { id, path: doc.path, updatedAt });
    emitRepoChange(this.slug);
  }

  createFile(path: string, content: string, params: { kind?: FileKind } = {}): string {
    let id = crypto.randomUUID();
    path = normalizePath(path);
    let kind = params.kind ?? inferKindFromPath(path);
    let updatedAt = Date.now();
    let dir = extractDir(path);
    let safeName = ensureValidFileName(basename(path));
    path = joinPath(dir, safeName);
    let meta: FileMeta = { id, path, updatedAt, kind };
    debugLog(this.slug, 'createFile', { id, path, kind });
    let doc: RepoFile = { ...meta, content };
    let idx = this.loadIndex();
    idx.push(meta);
    localStorage.setItem(this.indexKey, serializeIndex(idx));
    localStorage.setItem(this.noteKey(meta.id), serializeFile(doc));
    this.index = idx;
    ensureFolderForSlug(this.slug, dir);
    emitRepoChange(this.slug);
    return id;
  }

  /**
   * Renames a file, preserving its extension.
   *
   * `newName` must be the new file name EXCLUDING extension.
   */
  renameFile(path: string, newName: string): string | undefined {
    let meta = this.findMetaByPath(path);
    if (meta === undefined) return undefined;

    // get previous extension from path, and determine new path
    let ext = extractExtensionWithDot(basename(meta.path));
    let newFileName = newName + ext;

    let doc = this.loadFileById(meta.id);
    if (!doc) return undefined;
    let safeName = ensureValidFileName(newFileName);
    let normDir = normalizeDir(extractDir(doc.path));
    let toPath = joinPath(normDir, safeName);
    if (toPath === doc.path) return doc.path;
    let next = this.applyRename(doc, toPath);
    return next.path;
  }

  // internal rename method that also supports moving files between folders
  private applyRename(doc: RepoFile, path: string): RepoFile {
    let fromPath = doc.path;
    let updatedAt = Date.now();
    let next: RepoFile = { ...doc, path, updatedAt };
    let pathChanged = fromPath !== path;
    if (pathChanged) {
      if (doc.kind === 'asset-url') {
        next.lastRemoteSha = doc.lastRemoteSha;
        next.lastSyncedHash = doc.lastSyncedHash;
      } else {
        delete next.lastRemoteSha;
        delete next.lastSyncedHash;
      }
    }
    localStorage.setItem(this.noteKey(doc.id), serializeFile(next));
    this.touchIndex(doc.id, { path, updatedAt });
    ensureFolderForSlug(this.slug, extractDir(path));
    if (pathChanged) {
      recordRenameTombstone(this.slug, {
        from: fromPath,
        to: path,
        lastRemoteSha: doc.lastRemoteSha,
        renamedAt: updatedAt,
      });
    }
    debugLog(this.slug, 'applyRename', { id: doc.id, fromPath, toPath: path, pathChanged });
    emitRepoChange(this.slug);
    return next;
  }

  deleteFile(path: string): boolean {
    let meta = this.findMetaByPath(path);
    if (meta === undefined) return false;
    this.deleteFileById(meta.id);
    return true;
  }

  deleteFileById(id: string) {
    let doc = this.loadFileById(id);
    let idx = this.loadIndex().filter((n) => n.id !== id);
    localStorage.setItem(this.indexKey, serializeIndex(idx));
    if (doc) {
      recordDeleteTombstone(this.slug, {
        path: doc.path,
        lastRemoteSha: doc.lastRemoteSha,
        deletedAt: Date.now(),
      });
    }
    localStorage.removeItem(this.noteKey(id));
    this.index = idx;
    rebuildFolderIndex(this.slug);
    debugLog(this.slug, 'deleteFileById', { id, path: doc?.path });
    emitRepoChange(this.slug);
  }

  replaceWithRemote(files: RemoteFile[]) {
    let previous = this.loadIndex();
    for (let note of previous) {
      localStorage.removeItem(this.noteKey(note.id));
    }
    let now = Date.now();
    let index: FileMeta[] = [];
    let folderSet = new Set<string>();
    for (let { path, kind, content, sha } of files) {
      let id = crypto.randomUUID();
      let dir = extractDir(path);
      if (dir !== '') folderSet.add(dir);
      let meta: FileMeta = { id, path, updatedAt: now, kind };
      let doc: RepoFile = {
        ...meta,
        content,
        lastRemoteSha: sha,
        lastSyncedHash: computeSyncedHash(kind, content, sha),
      };
      index.push(meta);
      localStorage.setItem(this.noteKey(id), serializeFile(doc));
    }
    localStorage.setItem(this.indexKey, serializeIndex(index));
    localStorage.setItem(this.foldersKey, JSON.stringify(Array.from(folderSet).sort()));
    this.index = index;
    debugLog(this.slug, 'replaceWithRemote', { count: files.length });
    emitRepoChange(this.slug);
  }

  // --- Folder APIs ---
  listFolders(): string[] {
    const snapshot = ensureRepoSubscribers(this.slug).snapshot;
    return snapshot.folders.slice();
  }

  createFolder(parentDir: string, name: string) {
    let parent = normalizeDir(parentDir);
    let folderName = ensureValidFolderName(name);
    let target = normalizeDir(joinPath(parent, folderName));
    if (target === '') return; // no root creation
    let folders = new Set(this.listFolders());
    // Prevent duplicates at same path
    if (folders.has(target)) return;
    // Prevent creating nested parents without hierarchy; add all ancestor segments
    for (let p of ancestorsOf(target)) folders.add(p);
    localStorage.setItem(this.foldersKey, JSON.stringify(Array.from(folders).sort()));
    debugLog(this.slug, 'folder:create', { target });
    emitRepoChange(this.slug);
  }

  renameFolder(oldDir: string, newName: string) {
    let from = normalizeDir(oldDir);
    if (from === '') return;
    let parent = parentDirOf(from);
    let to = normalizeDir(joinPath(parent, ensureValidFolderName(newName)));
    this.moveFolder(from, to);
  }

  moveFolder(fromDir: string, toDir: string) {
    let from = normalizeDir(fromDir);
    let to = normalizeDir(toDir);
    if (from === '' || to === '') return;
    // Prevent moving into own subtree
    if (to === from || to.startsWith(from + '/')) return;
    let folders = new Set(this.listFolders());
    if (!folders.has(from)) return;
    // Move folder entries under from → to
    let updated = new Set<string>();
    for (let d of folders) {
      if (d === from || d.startsWith(from + '/')) {
        let rest = d.slice(from.length);
        let next = normalizeDir(to + rest);
        updated.add(next);
      } else {
        updated.add(d);
      }
    }
    // Update notes under moved folder
    let idx = this.loadIndex();
    for (let meta of idx) {
      let dir = normalizeDir(extractDir(meta.path));
      if (dir === from || dir.startsWith(from + '/')) {
        let rest = dir.slice(from.length);
        let nextDir = normalizeDir(to + rest);
        this.moveFileToDir(meta.id, nextDir);
      }
    }
    localStorage.setItem(this.foldersKey, JSON.stringify(Array.from(updated).sort()));
    debugLog(this.slug, 'folder:move', { from, to });
    emitRepoChange(this.slug);
  }

  deleteFolder(dir: string) {
    let target = normalizeDir(dir);
    if (target === '') return;
    let folders = new Set(this.listFolders());
    if (!folders.has(target)) return;
    // Gather all folders to remove
    let toRemove: string[] = [];
    for (let d of folders) {
      if (d === target || d.startsWith(target + '/')) toRemove.push(d);
    }
    for (let d of toRemove) folders.delete(d);
    localStorage.setItem(this.foldersKey, JSON.stringify(Array.from(folders).sort()));
    // Delete contained notes (record tombstones)
    let idx = this.loadIndex();
    for (let meta of idx.slice()) {
      let dir = normalizeDir(extractDir(meta.path));
      if (dir === target || dir.startsWith(target + '/')) {
        this.deleteFileById(meta.id);
      }
    }
    debugLog(this.slug, 'folder:delete', { dir: target });
    emitRepoChange(this.slug);
  }

  moveFileToDir(id: string, dir: string) {
    let doc = this.loadFileById(id);
    if (!doc) return;
    let normDir = normalizeDir(dir);
    let fileName = basename(doc.path);
    let safeFileName = ensureValidFileName(fileName);
    let nextPath = joinPath(normDir, safeFileName);
    if (nextPath === doc.path) return;
    this.applyRename(doc, nextPath);
  }

  findMetaByPath(path: string): FileMeta | undefined {
    let normalized = normalizePath(path);
    let idx = this.loadIndex();
    return idx.find((meta) => normalizePath(meta.path) === normalized);
  }

  private loadIndex(): FileMeta[] {
    let raw = localStorage.getItem(this.indexKey);
    return deserializeIndex(raw);
  }

  private touchIndex(id: string, patch: Partial<FileMeta>) {
    let idx = this.loadIndex();
    let i = idx.findIndex((n) => n.id === id);
    if (i >= 0) idx[i] = { ...idx[i]!, ...patch };
    localStorage.setItem(this.indexKey, serializeIndex(idx));
    this.index = idx;
    debugLog(this.slug, 'touchIndex', { id, patch });
  }

  // TODO get rid of
  private backfillFolders() {
    let idx = this.loadIndex();
    let folderSet = new Set<string>(this.listFolders());
    for (let meta of idx) {
      let dir = extractDir(meta.path);
      if (dir !== '') {
        folderSet.add(normalizeDir(dir));
      }
    }
    localStorage.setItem(this.foldersKey, JSON.stringify(Array.from(folderSet).sort()));
  }

  private noteKey(id: string): string {
    return `${this.notePrefix}${id}`;
  }
}

// --- Internal helpers for LocalStore ---

function extractDir(fullPath: string): string {
  let p = fullPath;
  let i = p.lastIndexOf('/');
  let dir = i >= 0 ? p.slice(0, i) : '';
  return normalizeDir(dir);
}

function normalizeDir(dir: string): string {
  let d = (dir || '').trim();
  d = d.replace(/(^\/+|\/+?$)/g, '');
  if (d === '.' || d === '..') d = '';
  return d;
}

function ensureValidFolderName(name: string): string {
  let t = name.trim();
  if (t === '' || t === '.' || t === '..') throw new Error('Invalid folder name');
  if (/[\\/\0]/.test(t)) throw new Error('Invalid folder name');
  return t;
}

function parentDirOf(dir: string): string {
  let d = normalizeDir(dir);
  if (d === '') return '';
  let i = d.lastIndexOf('/');
  return i >= 0 ? d.slice(0, i) : '';
}

function ancestorsOf(dir: string): string[] {
  let d = normalizeDir(dir);
  if (d === '') return [];
  let parts = d.split('/');
  let out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    out.push(parts.slice(0, i + 1).join('/'));
  }
  return out;
}

type DeleteTombstone = {
  type: 'delete';
  path: string;
  lastRemoteSha?: string;
  deletedAt: number;
};

type RenameTombstone = {
  type: 'rename';
  from: string;
  to: string;
  lastRemoteSha?: string;
  renamedAt: number;
};

type Tombstone = DeleteTombstone | RenameTombstone;

export function listTombstones(slug: string): Tombstone[] {
  let raw = localStorage.getItem(repoKey(slug, 'tombstones'));
  if (!raw) return [];
  try {
    let arr = JSON.parse(raw) as Tombstone[];
    if (!Array.isArray(arr)) return [];
    return arr;
  } catch {
    return [];
  }
}

function saveTombstones(slug: string, ts: Tombstone[]) {
  localStorage.setItem(repoKey(slug, 'tombstones'), JSON.stringify(ts));
}

export function recordDeleteTombstone(
  slug: string,
  t: {
    path: string;
    lastRemoteSha?: string;
    deletedAt: number;
  }
) {
  let ts = listTombstones(slug);
  ts.push({ type: 'delete', path: t.path, lastRemoteSha: t.lastRemoteSha, deletedAt: t.deletedAt });
  saveTombstones(slug, ts);
  debugLog(slug, 'tombstone:delete:add', { path: t.path });
}

export function recordRenameTombstone(
  slug: string,
  t: {
    from: string;
    to: string;
    lastRemoteSha?: string;
    renamedAt: number;
  }
) {
  let ts = listTombstones(slug);

  let revertIndex = ts.findIndex(
    (item) => item.type === 'rename' && item.from === t.to && item.to === t.from
  );
  if (revertIndex >= 0) {
    let next = ts.filter((_, idx) => idx !== revertIndex);
    saveTombstones(slug, next);
    debugLog(slug, 'tombstone:rename:collapse-revert', { from: t.from, to: t.to });
    return;
  }

  let chainIndex = ts.findIndex((item) => item.type === 'rename' && item.to === t.from);
  if (chainIndex >= 0) {
    let current = ts[chainIndex];
    if (!current || current.type !== 'rename') {
      // If the slot is unexpectedly missing or not a rename, fall back to regular append.
      debugLog(slug, 'tombstone:rename:collapse-chain-skip', { from: t.from, to: t.to });
    } else {
      ts[chainIndex] = {
        type: 'rename',
        from: current.from,
        to: t.to,
        lastRemoteSha: current.lastRemoteSha,
        renamedAt: t.renamedAt,
      };
      saveTombstones(slug, ts);
      debugLog(slug, 'tombstone:rename:collapse-chain', { from: current.from, to: t.to });
      return;
    }
  }

  ts.push({
    type: 'rename',
    from: t.from,
    to: t.to,
    lastRemoteSha: t.lastRemoteSha,
    renamedAt: t.renamedAt,
  });
  saveTombstones(slug, ts);
  debugLog(slug, 'tombstone:rename:add', { from: t.from, to: t.to });
}

export function removeTombstones(slug: string, predicate: (t: Tombstone) => boolean) {
  let ts = listTombstones(slug).filter((t) => !predicate(t));
  saveTombstones(slug, ts);
  debugLog(slug, 'tombstone:remove:filtered', { remaining: ts.length });
}

export function clearAllTombstones(slug: string) {
  localStorage.removeItem(repoKey(slug, 'tombstones'));
  debugLog(slug, 'tombstone:clearAll', {});
}

export function markSynced(slug: string, id: string, patch: { remoteSha?: string; syncedHash?: string }) {
  let key = `${repoKey(slug, 'note')}:${id}`;
  let doc = loadFileForKey(slug, id);
  if (!doc) return;
  if (patch.remoteSha !== undefined) doc.lastRemoteSha = patch.remoteSha;
  if (patch.syncedHash !== undefined) doc.lastSyncedHash = patch.syncedHash;
  localStorage.setItem(key, serializeFile(doc));
  debugLog(slug, 'markSynced', { id, patch });
  emitRepoChange(slug);
}

export function updateFile(slug: string, id: string, content: string, kind?: FileKind) {
  mutateFile(slug, id, (doc) => {
    let updatedAt = Date.now();
    let next: RepoFile = { ...doc, content, updatedAt };
    if (kind !== undefined) {
      next.kind = kind;
    }
    return { doc: next };
  });
}

export function findFileByPath(slug: string, path: string): { id: string; doc: RepoFile } | null {
  let idx = loadIndexForSlug(slug);
  for (let meta of idx) {
    if (meta.path !== path) continue;
    let doc = loadFileForKey(slug, meta.id);
    if (!doc) continue;
    return { id: meta.id, doc };
  }
  return null;
}

export function findByRemoteSha(
  slug: string,
  remoteSha: string | undefined
): { id: string; doc: RepoFile } | null {
  if (!remoteSha) return null;
  let idx = loadIndexForSlug(slug);
  for (let meta of idx) {
    let doc = loadFileForKey(slug, meta.id);
    if (!doc) continue;
    if (doc.lastRemoteSha === remoteSha) {
      return { id: meta.id, doc };
    }
  }
  return null;
}

export function findBySyncedHash(
  slug: string,
  syncedHash: string | undefined
): { id: string; doc: RepoFile } | null {
  if (!syncedHash) return null;
  let idx = loadIndexForSlug(slug);
  for (let meta of idx) {
    let doc = loadFileForKey(slug, meta.id);
    if (!doc) continue;
    if (doc.lastSyncedHash === syncedHash) {
      return { id: meta.id, doc };
    }
  }
  return null;
}

export function moveFilePath(slug: string, id: string, toPath: string) {
  let normalizedPath = normalizePath(toPath);
  mutateFile(slug, id, (doc) => {
    if (doc.path === normalizedPath) return null;
    let dir = extractDir(normalizedPath);
    let title = stripExtension(basename(normalizedPath));
    let updatedAt = Date.now();
    return {
      doc: { ...doc, path: normalizedPath, dir, title, updatedAt },
      indexPatch: { path: normalizedPath, dir, title },
    };
  });
  rebuildFolderIndex(slug);
  emitRepoChange(slug);
}

function loadIndexForSlug(slug: string): FileMeta[] {
  let raw = localStorage.getItem(repoKey(slug, 'index'));
  return deserializeIndex(raw);
}

function rebuildFolderIndex(slug: string) {
  // Recompute folder metadata so cross-device sync drops empty directories.
  let idx = loadIndexForSlug(slug);
  let folderSet = new Set<string>();
  for (let note of idx) {
    let dir = normalizeDir(extractDir(note.path));
    if (dir === '') continue;
    for (let ancestor of ancestorsOf(dir)) folderSet.add(ancestor);
  }
  localStorage.setItem(repoKey(slug, FOLDERS_SUFFIX), JSON.stringify(Array.from(folderSet).sort()));
}

function loadFoldersForSlug(slug: string): string[] {
  let raw = localStorage.getItem(repoKey(slug, FOLDERS_SUFFIX));
  if (!raw) return [];
  try {
    let parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((dir) => typeof dir === 'string');
  } catch {
    return [];
  }
}

function touchIndexUpdatedAt(slug: string, id: string, updatedAt: number, patch?: Partial<FileMeta>) {
  let idx = loadIndexForSlug(slug);
  let i = idx.findIndex((n) => n.id === id);
  if (i >= 0) idx[i] = { ...idx[i]!, updatedAt, ...patch };
  localStorage.setItem(repoKey(slug, 'index'), serializeIndex(idx));
}

type DocMutationResult = { doc: RepoFile; indexPatch?: Partial<FileMeta> } | null;

// TODO this seems like a shit abstraction to me
function mutateFile(slug: string, id: string, mutate: (doc: RepoFile) => DocMutationResult) {
  let key = `${repoKey(slug, 'note')}:${id}`;
  let current = loadFileForKey(slug, id);
  if (!current) return;
  let result = mutate(current);
  if (!result) return;
  let next = result.doc;
  let updatedAt =
    typeof next.updatedAt === 'number' && Number.isFinite(next.updatedAt) ? next.updatedAt : Date.now();
  let indexPatch: Partial<FileMeta> = { kind: next.kind, ...result.indexPatch };
  localStorage.setItem(key, serializeFile(next));
  touchIndexUpdatedAt(slug, id, updatedAt, indexPatch);
  debugLog(slug, 'updateFile', { id, updatedAt });
  emitRepoChange(slug);
}

function loadFileForKey(slug: string, id: string): RepoFile | null {
  let raw = localStorage.getItem(`${repoKey(slug, 'note')}:${id}`);
  if (!raw) return null;
  try {
    return normalizeFile(JSON.parse(raw));
  } catch {
    return null;
  }
}

function ensureFolderForSlug(slug: string, dir: string) {
  let folders = new Set(loadFoldersForSlug(slug));
  if (dir !== '') {
    for (let ancestor of ancestorsOf(dir)) folders.add(ancestor);
  }
  localStorage.setItem(repoKey(slug, FOLDERS_SUFFIX), JSON.stringify(Array.from(folders).sort()));
}

function basename(p: string) {
  let i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function ensureValidFileName(name: string): string {
  let trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') throw Error('Invalid file name');
  if (/[\\/\0]/.test(trimmed)) throw Error('Invalid file name: contains illegal characters');
  return trimmed;
}

function stripExtension(baseName: string): string {
  let idx = baseName.lastIndexOf('.');
  if (idx < 0) return baseName;
  return baseName.slice(0, idx);
}

function extractExtensionWithDot(baseName: string): string {
  let idx = baseName.lastIndexOf('.');
  if (idx < 0) return '';
  return baseName.slice(idx);
}

function inferKindFromPath(path: string): FileKind {
  return /\.md$/i.test(path) ? 'markdown' : 'binary';
}

function normalizeMeta(raw: unknown): FileMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  let stored = raw as Partial<StoredFileMeta>;
  if (typeof stored.id !== 'string') return null;
  if (typeof stored.path !== 'string') return null;
  let path = stored.path.replace(/^\/+/g, '').replace(/\/+$/g, '') || stored.path;
  let updatedAt =
    typeof stored.updatedAt === 'number' && Number.isFinite(stored.updatedAt) ? stored.updatedAt : Date.now();
  let inferredKind = typeof stored.kind === 'string' ? stored.kind : 'markdown';
  return { id: stored.id, path, updatedAt, kind: inferredKind };
}

function toStoredFile(doc: RepoFile): StoredFile {
  return {
    id: doc.id,
    path: doc.path,
    updatedAt: doc.updatedAt,
    kind: doc.kind,
    text: doc.content,
    lastRemoteSha: doc.lastRemoteSha,
    lastSyncedHash: doc.lastSyncedHash,
  };
}

function normalizeFile(raw: unknown): RepoFile | null {
  if (raw === null || typeof raw !== 'object') return null;
  let stored = raw as StoredFile;
  let meta = normalizeMeta(stored);
  if (!meta) return null;
  let lastRemoteSha = typeof stored.lastRemoteSha === 'string' ? stored.lastRemoteSha : undefined;
  let lastSyncedHash = typeof stored.lastSyncedHash === 'string' ? stored.lastSyncedHash : undefined;
  let content = typeof stored.text === 'string' ? stored.text : '';
  return { ...meta, content, lastRemoteSha, lastSyncedHash };
}

function joinPath(dir: string, file: string) {
  if (dir === '') return file;
  return `${dir.replace(/\/+$/, '')}/${file.replace(/^\/+/, '')}`;
}

function repoKey(slug: string, suffix: string): string {
  return `${REPO_PREFIX}:${encodeSlug(slug)}:${suffix}`;
}

function encodeSlug(slug: string): string {
  return encodeURIComponent(slug);
}

function linkKey(slug: string): string {
  return `${LINK_PREFIX}:${encodeSlug(slug)}`;
}

function debugLog(slug: string, op: string, data: object) {
  if (!DEBUG_ENABLED) return;
  console.debug('[VNDBG]', { slug, op, ...data });
  console.trace('[VNDBG trace]', op);
}

function normalizeSlug(slug: string): string {
  let trimmed = slug.trim();
  if (!trimmed) return 'new';
  return trimmed;
}

export type RecentRepo = {
  slug: string;
  owner?: string;
  repo?: string;
  connected?: boolean;
  lastOpenedAt: number;
};

const RECENTS_KEY = `${NS}:recents`;

function loadRecentRepos(): RecentRepo[] {
  let raw = localStorage.getItem(RECENTS_KEY);
  if (!raw) return [];
  try {
    let parsed = JSON.parse(raw) as RecentRepo[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => typeof item?.slug === 'string' && typeof item?.lastOpenedAt === 'number');
  } catch {
    return [];
  }
}

function saveRecentRepos(entries: RecentRepo[]) {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(entries));
}

export function listRecentRepos(): RecentRepo[] {
  const now = Date.now();
  const threeMonthsMs = 1000 * 60 * 60 * 24 * 30 * 3; // approx 3 months
  // Purge old entries and the placeholder 'new'
  let entries = loadRecentRepos()
    .filter((entry) => entry.slug !== 'new')
    .filter((entry) => now - entry.lastOpenedAt <= threeMonthsMs);
  let mapped = entries.map((entry) => ({
    ...entry,
    connected: entry.connected ?? isRepoLinked(entry.slug),
  }));

  const sorted = mapped.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  // Persist pruning so storage stays tidy
  saveRecentRepos(sorted);
  return sorted;
}

export function recordRecentRepo(entry: {
  slug: string;
  owner?: string;
  repo?: string;
  connected?: boolean;
}) {
  let now = Date.now();
  // Start from pruned list
  const sixMonthsMs = 1000 * 60 * 60 * 24 * 30 * 6;
  let entries = loadRecentRepos()
    .filter((item) => item.slug !== entry.slug)
    .filter((item) => now - item.lastOpenedAt <= sixMonthsMs);
  let connected = entry.connected ?? isRepoLinked(entry.slug);
  entries.unshift({ ...entry, connected, lastOpenedAt: now });
  if (entries.length > 10) entries = entries.slice(0, 10);
  saveRecentRepos(entries);
}

export function markRepoLinked(slug: string) {
  localStorage.setItem(linkKey(slug), JSON.stringify({ linkedAt: Date.now() }));
}

export function clearRepoLink(slug: string) {
  localStorage.removeItem(linkKey(slug));
}

export function isRepoLinked(slug: string): boolean {
  return localStorage.getItem(linkKey(slug)) !== null;
}

export function clearAllLocalData() {
  const remove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key.startsWith(`${NS}:`)) remove.push(key);
  }
  for (const key of remove) localStorage.removeItem(key);
  resetAllRepoStores();
}

// --- Per-repository preferences ---
export type RepoPrefs = {
  autosync?: boolean;
  lastAutoSyncAt?: number;
  lastActiveNoteId?: string;
  expandedFolders?: string[];
};

function prefsKey(slug: string): string {
  return repoKey(slug, PREFS_SUFFIX);
}

export function getRepoPrefs(slug: string): RepoPrefs {
  let raw = localStorage.getItem(prefsKey(slug));
  if (!raw) return {};
  try {
    let parsed = JSON.parse(raw) as RepoPrefs;
    if (parsed && typeof parsed === 'object') return parsed;
    return {};
  } catch {
    return {};
  }
}

export function setRepoPrefs(slug: string, patch: Partial<RepoPrefs>) {
  let current = getRepoPrefs(slug);
  let next: RepoPrefs = { ...current, ...patch };
  localStorage.setItem(prefsKey(slug), JSON.stringify(next));
}

export function isAutosyncEnabled(slug: string): boolean {
  let prefs = getRepoPrefs(slug);
  return prefs.autosync === true;
}

export function setAutosyncEnabled(slug: string, enabled: boolean) {
  setRepoPrefs(slug, { autosync: enabled });
}

export function getLastAutoSyncAt(slug: string): number | undefined {
  let prefs = getRepoPrefs(slug);
  return prefs.lastAutoSyncAt;
}

export function recordAutoSyncRun(slug: string, at: number = Date.now()) {
  setRepoPrefs(slug, { lastAutoSyncAt: at });
}

export function getLastActiveFileId(slug: string): string | undefined {
  let prefs = getRepoPrefs(slug);
  return typeof prefs.lastActiveNoteId === 'string' ? prefs.lastActiveNoteId : undefined;
}

export function setLastActiveFileId(slug: string, id: string | null) {
  setRepoPrefs(slug, { lastActiveNoteId: id ?? undefined });
}

export function getExpandedFolders(slug: string): string[] {
  let prefs = getRepoPrefs(slug);
  let list = Array.isArray(prefs.expandedFolders) ? prefs.expandedFolders : [];
  return list.filter((dir) => typeof dir === 'string');
}

export function setExpandedFolders(slug: string, dirs: string[]) {
  let unique = Array.from(new Set(dirs.filter((dir) => typeof dir === 'string' && dir !== '')));
  unique.sort();
  setRepoPrefs(slug, { expandedFolders: unique });
}

export function computeSyncedHash(kind: FileKind, content: string, remoteSha?: string): string {
  if (kind === 'asset-url') {
    return remoteSha ?? hashText(content);
  }
  return hashText(content);
}

export function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);
  return (h >>> 0).toString(16);
}
