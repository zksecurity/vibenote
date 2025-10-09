// Local storage persistence for repo files (markdown notes plus binary assets).
import { logError } from '../lib/logging';

export type FileKind = 'markdown' | 'binary';

const DEFAULT_MARKDOWN_MIME = 'text/markdown' as const;

type StoredFileMeta = {
  id: string;
  path: string;
  title: string;
  dir: string;
  updatedAt: number;
  kind?: FileKind;
  mime?: string;
};

type StoredFile = StoredFileMeta & {
  text: string;
  lastRemoteSha?: string;
  lastSyncedHash?: string;
};

export type FileMeta = {
  id: string;
  path: string;
  title: string;
  dir: string;
  updatedAt: number;
  kind: FileKind;
  mime: string;
};

export type NoteMeta = FileMeta & { kind: 'markdown' };

export type NoteDoc = NoteMeta & {
  text: string;
  binaryBase64?: undefined;
  lastRemoteSha?: string;
  lastSyncedHash?: string;
};

export type RepoFileDoc =
  | NoteDoc
  | (FileMeta & { kind: 'binary'; text?: undefined; binaryBase64: string; lastRemoteSha?: string; lastSyncedHash?: string });

export { debugLog };

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
  const notes = files.filter((meta): meta is NoteMeta => meta.kind === 'markdown');
  const folders = loadFoldersForSlug(slug);
  return {
    files: Object.freeze(files) as FileMeta[],
    notes: Object.freeze(notes) as NoteMeta[],
    folders: Object.freeze(folders) as string[],
  };
}

export type RepoStoreSnapshot = {
  files: FileMeta[];
  notes: NoteMeta[];
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
      this.createNote('Welcome', WELCOME_NOTE);
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

  listNotes(): NoteMeta[] {
    // Defensive: refresh from storage to avoid returning stale data across tabs
    // [VNDBG] This read is safe and avoids UI from showing entries that were removed elsewhere.
    const snapshot = ensureRepoSubscribers(this.slug).snapshot;
    this.index = snapshot.files;
    return snapshot.notes.slice();
  }

  listFiles(): FileMeta[] {
    const snapshot = ensureRepoSubscribers(this.slug).snapshot;
    this.index = snapshot.files;
    return snapshot.files.slice();
  }

  loadNote(id: string): NoteDoc | null {
    let raw = localStorage.getItem(this.noteKey(id));
    if (!raw) return null;
    try {
      let doc = normalizeDoc(JSON.parse(raw));
      return doc && doc.kind === 'markdown' ? (doc as NoteDoc) : null;
    } catch {
      return null;
    }
  }

  loadFile(id: string): RepoFileDoc | null {
    let raw = localStorage.getItem(this.noteKey(id));
    if (!raw) return null;
    try {
      return normalizeDoc(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  saveNote(id: string, text: string) {
    let doc = this.loadNote(id);
    if (!doc) return;
    let updatedAt = Date.now();
    let next: NoteDoc = { ...doc, text, updatedAt };
    localStorage.setItem(this.noteKey(id), JSON.stringify(next));
    debugLog(this.slug, 'saveNote', { id, path: doc.path, updatedAt });
    this.touchIndex(id, { updatedAt });
    emitRepoChange(this.slug);
  }

  createNote(title = 'Untitled', text = '', dir: string = ''): string {
    let id = crypto.randomUUID();
    let safe = ensureValidTitle(title || 'Untitled');
    let displayTitle = title.trim() || 'Untitled';
    let normDir = normalizeDir(dir);
    let path = joinPath(normDir, `${safe}.md`);
    let meta: NoteMeta = {
      id,
      path,
      title: displayTitle,
      dir: normDir,
      updatedAt: Date.now(),
      kind: 'markdown',
      mime: DEFAULT_MARKDOWN_MIME,
    };
    let doc: NoteDoc = { ...meta, text };
    let idx = this.loadIndex();
    idx.push(meta);
    localStorage.setItem(this.indexKey, JSON.stringify(idx));
    localStorage.setItem(this.noteKey(id), JSON.stringify(doc));
    this.index = idx;
    this.addFolder(normDir);
    debugLog(this.slug, 'createNote', { id, path, title: displayTitle });
    emitRepoChange(this.slug);
    return id;
  }

  createBinaryFile(path: string, base64: string, mime?: string): string {
    let id = crypto.randomUUID();
    let normPath = path.replace(/^\/+/, '');
    let dir = extractDir(normPath);
    let title = basename(normPath);
    let now = Date.now();
    let meta: FileMeta = {
      id,
      path: normPath,
      title,
      dir,
      updatedAt: now,
      kind: 'binary',
      mime: mime ?? inferMimeFromPath(normPath),
    };
    let doc: RepoFileDoc = {
      ...meta,
      kind: 'binary',
      binaryBase64: base64,
      lastRemoteSha: undefined,
      lastSyncedHash: undefined,
    };
    let idx = this.loadIndex();
    idx.push(meta);
    localStorage.setItem(this.indexKey, JSON.stringify(idx));
    const stored: StoredFile = {
      id,
      path: normPath,
      title,
      dir,
      updatedAt: now,
      kind: 'binary',
      mime: doc.mime,
      text: base64,
      lastRemoteSha: undefined,
      lastSyncedHash: undefined,
    };
    localStorage.setItem(this.noteKey(id), JSON.stringify({ ...stored, binaryBase64: base64 }));
    this.index = idx;
    ensureFolderForSlug(this.slug, dir);
    debugLog(this.slug, 'createBinary', { id, path: normPath });
    emitRepoChange(this.slug);
    return id;
  }

  renameFile(path: string, newName: string): string | undefined {
    let meta = this.findMetaByPath(path);
    if (!meta) return undefined;
    if (meta.kind === 'markdown') {
      let trimmed = newName.replace(/\.md$/i, '');
      this.renameNote(meta.id, trimmed);
      let updated = this.loadNote(meta.id);
      return updated?.path;
    }
    return this.renameBinary(meta.id, newName);
  }

  deleteFile(path: string): boolean {
    let meta = this.findMetaByPath(path);
    if (!meta) return false;
    this.deleteNote(meta.id);
    return true;
  }

  renameNote(id: string, title: string) {
    let doc = this.loadNote(id);
    if (!doc) return;
    let fromPath = doc.path;
    let safe = ensureValidTitle(title || 'Untitled');
    let normDir = normalizeDir(doc.dir);
    let path = joinPath(normDir, `${safe}.md`);
    let updatedAt = Date.now();
    let next: NoteDoc = { ...doc, title: safe, path, dir: normDir, updatedAt };
    let pathChanged = fromPath !== path;
    if (pathChanged) {
      delete next.lastRemoteSha;
      delete next.lastSyncedHash;
    }
    localStorage.setItem(this.noteKey(id), JSON.stringify(next));
    this.touchIndex(id, { title: safe, path, dir: normDir, updatedAt });
    if (pathChanged) {
      recordRenameTombstone(this.slug, {
        from: fromPath,
        to: path,
        lastRemoteSha: doc.lastRemoteSha,
        renamedAt: updatedAt,
      });
    }
    debugLog(this.slug, 'renameNote', { id, fromPath, toPath: path, pathChanged });
    emitRepoChange(this.slug);
  }

  private renameBinary(id: string, newName: string): string | undefined {
    let doc = this.loadFile(id);
    if (!doc || doc.kind !== 'binary') return undefined;
    let safeName = ensureValidFileName(newName);
    let normDir = normalizeDir(doc.dir);
    let toPath = joinPath(normDir, safeName);
    if (toPath === doc.path) return doc.path;
    let updatedAt = Date.now();
    let next: RepoFileDoc = {
      ...doc,
      title: safeName,
      path: toPath,
      dir: normDir,
      updatedAt,
      lastRemoteSha: undefined,
      lastSyncedHash: undefined,
    };
    const stored: StoredFile = {
      id,
      path: toPath,
      title: safeName,
      dir: normDir,
      updatedAt,
      kind: 'binary',
      mime: next.mime,
      text: next.binaryBase64,
      lastRemoteSha: undefined,
      lastSyncedHash: undefined,
    };
    localStorage.setItem(this.noteKey(id), JSON.stringify({ ...stored, binaryBase64: next.binaryBase64 }));
    this.touchIndex(id, {
      title: safeName,
      path: toPath,
      dir: normDir,
      updatedAt,
      kind: 'binary',
      mime: doc.mime,
    });
    ensureFolderForSlug(this.slug, normDir);
    recordRenameTombstone(this.slug, {
      from: doc.path,
      to: toPath,
      lastRemoteSha: doc.lastRemoteSha,
      renamedAt: updatedAt,
    });
    emitRepoChange(this.slug);
    return toPath;
  }

  deleteNote(id: string) {
    let doc = this.loadFile(id);
    let idx = this.loadIndex().filter((n) => n.id !== id);
    localStorage.setItem(this.indexKey, JSON.stringify(idx));
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
    debugLog(this.slug, 'deleteNote', { id, path: doc?.path });
    emitRepoChange(this.slug);
  }

  resetToWelcome(): string {
    let toRemove: string[] = [];
    let prefix = `${this.notePrefix}`;
    for (let i = 0; i < localStorage.length; i++) {
      let key = localStorage.key(i);
      if (!key) continue;
      if (key === this.indexKey || key.startsWith(prefix)) toRemove.push(key);
    }
    for (let key of toRemove) localStorage.removeItem(key);
    let id = this.createNote('Welcome', WELCOME_NOTE);
    this.index = this.loadIndex();
    emitRepoChange(this.slug);
    return id;
  }

  replaceWithRemote(
    files: Array<{
      path: string;
      text?: string;
      binaryBase64?: string;
      mime?: string;
      kind?: FileKind;
      sha?: string;
    }>
  ) {
    let previous = this.loadIndex();
    for (let note of previous) {
      localStorage.removeItem(this.noteKey(note.id));
    }
    let now = Date.now();
    let index: FileMeta[] = [];
    let folderSet = new Set<string>();
    for (let file of files) {
      let id = crypto.randomUUID();
      let kind = file.kind ?? inferKindFromPath(file.path);
      let dir = extractDir(file.path);
      if (dir !== '') folderSet.add(dir);
      if (kind === 'binary') {
        let base64 = file.binaryBase64 ?? '';
        let mime = file.mime ?? inferMimeFromPath(file.path);
        let title = basename(file.path);
        let meta: FileMeta = { id, path: file.path, title, dir, updatedAt: now, kind: 'binary', mime };
        let doc: RepoFileDoc = {
          id,
          path: file.path,
          title,
          dir,
          updatedAt: now,
          kind: 'binary',
          mime,
          binaryBase64: base64,
          lastRemoteSha: file.sha,
          lastSyncedHash: hashText(base64),
        };
        index.push(meta);
        localStorage.setItem(this.noteKey(id), JSON.stringify(doc));
        continue;
      }
      let text = file.text ?? '';
      let title = basename(file.path).replace(/\.md$/i, '');
      let meta: NoteMeta = {
        id,
        path: file.path,
        title,
        dir,
        updatedAt: now,
        kind: 'markdown',
        mime: DEFAULT_MARKDOWN_MIME,
      };
      let doc: NoteDoc = {
        ...meta,
        text,
        lastRemoteSha: file.sha,
        lastSyncedHash: hashText(text),
      };
      index.push(meta);
      localStorage.setItem(this.noteKey(id), JSON.stringify(doc));
    }
    localStorage.setItem(this.indexKey, JSON.stringify(index));
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
      let dir = normalizeDir(meta.dir);
      if (dir === from || dir.startsWith(from + '/')) {
        let rest = dir.slice(from.length);
        let nextDir = normalizeDir(to + rest);
        this.moveNoteToDir(meta.id, nextDir);
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
      let dir = normalizeDir(meta.dir);
      if (dir === target || dir.startsWith(target + '/')) {
        this.deleteNote(meta.id);
      }
    }
    debugLog(this.slug, 'folder:delete', { dir: target });
    emitRepoChange(this.slug);
  }

  moveNoteToDir(id: string, dir: string) {
    let doc = this.loadNote(id);
    if (!doc) return;
    let fromPath = doc.path;
    let normDir = normalizeDir(dir);
    let toPath = joinPath(normDir, `${ensureValidTitle(doc.title)}.md`);
    if (toPath === fromPath) return;
    let updatedAt = Date.now();
    let next: NoteDoc = { ...doc, dir: normDir, path: toPath, updatedAt };
    delete next.lastRemoteSha;
    delete next.lastSyncedHash;
    localStorage.setItem(this.noteKey(id), JSON.stringify(next));
    this.touchIndex(id, { dir: normDir, path: toPath, updatedAt });
    recordRenameTombstone(this.slug, {
      from: fromPath,
      to: toPath,
      lastRemoteSha: doc.lastRemoteSha,
      renamedAt: updatedAt,
    });
    // Ensure folder index contains target and ancestors
    let folders = new Set(this.listFolders());
    for (let a of ancestorsOf(normDir)) folders.add(a);
    localStorage.setItem(this.foldersKey, JSON.stringify(Array.from(folders).sort()));
    debugLog(this.slug, 'note:moveDir', { id, toDir: normDir });
  }

  private findMetaByPath(path: string): FileMeta | null {
    let normalized = normalizeFilePath(path);
    let idx = this.loadIndex();
    for (let meta of idx) {
      if (normalizeFilePath(meta.path) === normalized) return meta;
    }
    return null;
  }

  private loadIndex(): FileMeta[] {
    let raw = localStorage.getItem(this.indexKey);
    if (!raw) return [];
    try {
      let parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      let result: FileMeta[] = [];
      for (let entry of parsed) {
        let meta = normalizeMeta(entry);
        if (meta) result.push(meta);
      }
      return result;
    } catch {
      return [];
    }
  }

  private touchIndex(id: string, patch: Partial<FileMeta>) {
    let idx = this.loadIndex();
    let i = idx.findIndex((n) => n.id === id);
    if (i >= 0) {
      let updated = normalizeMeta({ ...idx[i]!, ...patch }) ?? idx[i]!;
      idx[i] = updated;
    }
    localStorage.setItem(this.indexKey, JSON.stringify(idx));
    this.index = idx;
    debugLog(this.slug, 'touchIndex', { id, patch });
  }

  // TODO get rid of
  private backfillFolders() {
    let idx = this.loadIndex();
    let folderSet = new Set<string>(this.listFolders());
    for (let meta of idx) {
      if (meta.dir !== '') {
        folderSet.add(normalizeDir(meta.dir));
      }
    }
    localStorage.setItem(this.foldersKey, JSON.stringify(Array.from(folderSet).sort()));
  }

  private addFolder(dir: string) {
    let d = normalizeDir(dir);
    if (d === '') return;
    let set = new Set<string>(this.listFolders());
    for (let a of ancestorsOf(d)) set.add(a);
    localStorage.setItem(this.foldersKey, JSON.stringify(Array.from(set).sort()));
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

function normalizeFilePath(path: string): string {
  return path.replace(/^\/+/, '');
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

export type DeleteTombstone = {
  type: 'delete';
  path: string;
  lastRemoteSha?: string;
  deletedAt: number;
};

export type RenameTombstone = {
  type: 'rename';
  from: string;
  to: string;
  lastRemoteSha?: string;
  renamedAt: number;
};

export type Tombstone = DeleteTombstone | RenameTombstone;

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
  let next: RepoFileDoc = { ...doc };
  if (patch.remoteSha !== undefined) next.lastRemoteSha = patch.remoteSha;
  if (patch.syncedHash !== undefined) next.lastSyncedHash = patch.syncedHash;
  const stored: StoredFile = {
    id: next.id,
    path: next.path,
    title: next.title,
    dir: next.dir,
    updatedAt: next.updatedAt,
    kind: next.kind,
    mime: next.mime,
    text: next.kind === 'binary' ? next.binaryBase64 : next.text,
    lastRemoteSha: next.lastRemoteSha,
    lastSyncedHash: next.lastSyncedHash,
  };
  const serialized =
    next.kind === 'binary' ? { ...stored, binaryBase64: next.binaryBase64 } : stored;
  localStorage.setItem(key, JSON.stringify(serialized));
  debugLog(slug, 'markSynced', { id, patch });
  emitRepoChange(slug);
}

export function updateNoteText(slug: string, id: string, text: string) {
  let key = `${repoKey(slug, 'note')}:${id}`;
  let doc = loadFileForKey(slug, id);
  if (!doc || doc.kind !== 'markdown') return;
  let updatedAt = Date.now();
  let next: NoteDoc = { ...doc, text, updatedAt };
  localStorage.setItem(key, JSON.stringify(next));
  touchIndexUpdatedAt(slug, id, updatedAt, { kind: 'markdown', mime: DEFAULT_MARKDOWN_MIME });
  debugLog(slug, 'updateNoteText', { id, updatedAt });
  emitRepoChange(slug);
}

export function updateBinaryContent(slug: string, id: string, base64: string, mime?: string) {
  let key = `${repoKey(slug, 'note')}:${id}`;
  let doc = loadFileForKey(slug, id);
  if (!doc) return;
  let updatedAt = Date.now();
  let inferredMime = mime ?? doc.mime ?? inferMimeFromPath(doc.path);
  let next: RepoFileDoc;
  if (doc.kind === 'binary') {
    next = { ...doc, binaryBase64: base64, mime: inferredMime, updatedAt };
  } else {
    next = {
      id: doc.id,
      path: doc.path,
      title: doc.title,
      dir: doc.dir,
      updatedAt,
      kind: 'binary',
      mime: inferredMime,
      binaryBase64: base64,
      lastRemoteSha: doc.lastRemoteSha,
    };
  }
  next.lastSyncedHash = hashText(base64);
  const stored: StoredFile = {
    id: next.id,
    path: next.path,
    title: next.title,
    dir: next.dir,
    updatedAt,
    kind: next.kind,
    mime: next.mime,
    text: base64,
    lastRemoteSha: next.lastRemoteSha,
    lastSyncedHash: next.lastSyncedHash,
  };
  localStorage.setItem(key, JSON.stringify({ ...stored, binaryBase64: base64 }));
  touchIndexUpdatedAt(slug, id, updatedAt, { kind: next.kind, mime: next.mime });
  debugLog(slug, 'updateBinary', { id, updatedAt });
  emitRepoChange(slug);
}

export function findByPath(slug: string, path: string): { id: string; doc: NoteDoc } | null {
  let idx = loadIndexForSlug(slug);
  for (let meta of idx) {
    if (meta.path !== path) continue;
    let doc = loadFileForKey(slug, meta.id);
    if (!doc || doc.kind !== 'markdown') continue;
    return { id: meta.id, doc };
  }
  return null;
}

export function findFileByPath(slug: string, path: string): { id: string; doc: RepoFileDoc } | null {
  let idx = loadIndexForSlug(slug);
  for (let meta of idx) {
    if (meta.path !== path) continue;
    let doc = loadFileForKey(slug, meta.id);
    if (!doc) continue;
    return { id: meta.id, doc };
  }
  return null;
}

export function findByRemoteSha(slug: string, remoteSha: string | undefined): { id: string; doc: NoteDoc } | null {
  if (!remoteSha) return null;
  let idx = loadIndexForSlug(slug);
  for (let note of idx) {
    let dr = localStorage.getItem(`${repoKey(slug, 'note')}:${note.id}`);
    if (!dr) continue;
    try {
      let doc = JSON.parse(dr) as NoteDoc;
      if (doc.lastRemoteSha === remoteSha) {
        return { id: note.id, doc };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function findBySyncedHash(slug: string, syncedHash: string | undefined): { id: string; doc: NoteDoc } | null {
  if (!syncedHash) return null;
  let idx = loadIndexForSlug(slug);
  for (let note of idx) {
    let dr = localStorage.getItem(`${repoKey(slug, 'note')}:${note.id}`);
    if (!dr) continue;
    try {
      let doc = JSON.parse(dr) as NoteDoc;
      if (doc.lastSyncedHash === syncedHash) {
        return { id: note.id, doc };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function moveNotePath(slug: string, id: string, toPath: string) {
  let doc = loadFileForKey(slug, id);
  if (!doc || doc.kind !== 'markdown') return;
  let key = `${repoKey(slug, 'note')}:${id}`;
  let updatedAt = Date.now();
  let nextDir = extractDir(toPath);
  let next: NoteDoc = { ...doc, path: toPath, dir: nextDir, updatedAt };
  localStorage.setItem(key, JSON.stringify(next));
  let idx = loadIndexForSlug(slug);
  let j = idx.findIndex((n) => n.id === id);
  if (j >= 0) {
    let merged = normalizeMeta({ ...idx[j]!, path: toPath, dir: nextDir, updatedAt });
    if (merged) idx[j] = merged;
  }
  localStorage.setItem(repoKey(slug, 'index'), JSON.stringify(idx));
  rebuildFolderIndex(slug);
  debugLog(slug, 'moveNotePath', { id, toPath });
  emitRepoChange(slug);
}

function loadIndexForSlug(slug: string): FileMeta[] {
  let raw = localStorage.getItem(repoKey(slug, 'index'));
  if (!raw) return [];
  try {
    let parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    let list: FileMeta[] = [];
    for (let entry of parsed) {
      let meta = normalizeMeta(entry);
      if (meta) list.push(meta);
    }
    return list;
  } catch {
    return [];
  }
}

function rebuildFolderIndex(slug: string) {
  // Recompute folder metadata so cross-device sync drops empty directories.
  let idx = loadIndexForSlug(slug);
  let folderSet = new Set<string>();
  for (let note of idx) {
    let dir = normalizeDir(note.dir);
    if (dir === '') continue;
    for (let ancestor of ancestorsOf(dir)) folderSet.add(ancestor);
  }
  localStorage.setItem(
    repoKey(slug, FOLDERS_SUFFIX),
    JSON.stringify(Array.from(folderSet).sort())
  );
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
  if (i >= 0) {
    let merged = normalizeMeta({ ...idx[i]!, updatedAt, ...patch });
    if (merged) idx[i] = merged;
  }
  localStorage.setItem(repoKey(slug, 'index'), JSON.stringify(idx));
}

function loadFileForKey(slug: string, id: string): RepoFileDoc | null {
  let raw = localStorage.getItem(`${repoKey(slug, 'note')}:${id}`);
  if (!raw) return null;
  try {
    return normalizeDoc(JSON.parse(raw));
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

function inferKindFromPath(path: string): FileKind {
  return /\.md$/i.test(path) ? 'markdown' : 'binary';
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};

function inferMimeFromPath(path: string): string {
  if (/\.md$/i.test(path)) return DEFAULT_MARKDOWN_MIME;
  let idx = path.lastIndexOf('.');
  if (idx < 0 || idx === path.length - 1) return 'application/octet-stream';
  let ext = path.slice(idx + 1).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function normalizeMeta(raw: unknown): FileMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  let stored = raw as StoredFileMeta;
  if (typeof stored.id !== 'string') return null;
  if (typeof stored.path !== 'string') return null;
  let path = stored.path.replace(/^\/+/g, '').replace(/\/+$/g, '') || stored.path;
  let dir = normalizeDir(typeof stored.dir === 'string' ? stored.dir : extractDir(path));
  let updatedAt =
    typeof stored.updatedAt === 'number' && Number.isFinite(stored.updatedAt) ? stored.updatedAt : Date.now();
  let inferredKind =
    stored.kind === 'markdown' || stored.kind === 'binary' ? stored.kind : inferKindFromPath(path) ?? 'markdown';
  let baseTitle =
    typeof stored.title === 'string' && stored.title.trim() ? stored.title : basename(path);
  if (inferredKind === 'markdown' && baseTitle.toLowerCase().endsWith('.md')) {
    baseTitle = baseTitle.replace(/\.md$/i, '');
  }
  let mime =
    typeof stored.mime === 'string' && stored.mime.trim()
      ? stored.mime
      : inferredKind === 'markdown'
        ? DEFAULT_MARKDOWN_MIME
        : inferMimeFromPath(path);
  return { id: stored.id, path, title: baseTitle, dir, updatedAt, kind: inferredKind, mime };
}

function normalizeDoc(raw: unknown): RepoFileDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  let stored = raw as StoredFile;
  let meta = normalizeMeta(stored);
  if (!meta) return null;
  let lastRemoteSha =
    typeof stored.lastRemoteSha === 'string' ? stored.lastRemoteSha : undefined;
  let lastSyncedHash =
    typeof stored.lastSyncedHash === 'string' ? stored.lastSyncedHash : undefined;
  let text =
    typeof stored.text === 'string'
      ? stored.text
      : typeof (raw as any)?.binaryBase64 === 'string'
        ? String((raw as any).binaryBase64)
        : '';
  if (meta.kind === 'markdown') {
    return { ...meta, kind: 'markdown', text, lastRemoteSha, lastSyncedHash };
  }
  return { ...meta, kind: 'binary', binaryBase64: text, lastRemoteSha, lastSyncedHash };
}

function ensureValidTitle(title: string): string {
  let t = title.trim();
  if (!t) return 'Untitled';
  if (t === '.' || t === '..') return 'Untitled';
  if (/[\\/\0]/.test(t)) {
    throw new Error('Invalid title: contains illegal characters');
  }
  return t;
}

function ensureValidFileName(name: string): string {
  let trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') throw new Error('Invalid file name');
  if (/[\\/\0]/.test(trimmed)) throw new Error('Invalid file name');
  return trimmed;
}

function joinPath(dir: string, file: string) {
  if (!dir) return file;
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
  title?: string;
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
  title?: string;
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

export function getLastActiveNoteId(slug: string): string | undefined {
  let prefs = getRepoPrefs(slug);
  return typeof prefs.lastActiveNoteId === 'string' ? prefs.lastActiveNoteId : undefined;
}

export function setLastActiveNoteId(slug: string, id: string | null) {
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

export function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);
  return (h >>> 0).toString(16);
}
