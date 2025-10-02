export type NoteMeta = {
  id: string;
  path: string;
  title: string;
  dir?: string; // "" for root
  updatedAt: number;
};

export type NoteDoc = NoteMeta & {
  text: string;
  lastRemoteSha?: string;
  lastSyncedHash?: string;
};

export { debugLog };

// --- Debug logging ---
const DEBUG_ENABLED = true;

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
1. Create or open a note in the list on the left.
2. Hit the GitHub button to connect your account via the device flow.
3. Choose the repository VibeNote should sync with (or let it create one).
4. Use the circular sync icon whenever you want to pull and push changes.

## Transparency for engineers
- 🗃️ Notes live in your browser storage and inside your GitHub repo — we never copy them to our servers.
- 🔐 The GitHub device-flow token stays in 'localStorage'; it is never sent to VibeNote infrastructure.
- 🤝 Automatic conflict resolution handles Markdown merges for you, so you do not have to untangle git conflicts.

## Learn more
- 📦 Source code: https://github.com/mitschabaude/vibenote
- 💡 Have ideas or found a bug? Open an issue on GitHub and help shape the roadmap.

Happy writing! ✍️`;

export class LocalStore {
  slug: string;
  private index: NoteMeta[];
  private indexKey: string;
  private notePrefix: string;
  private foldersKey: string;

  constructor(slug: string, { seedWelcome = false } = {}) {
    slug = normalizeSlug(slug);
    this.slug = slug;
    this.indexKey = repoKey(this.slug, 'index');
    this.notePrefix = `${repoKey(this.slug, 'note')}:`;
    this.foldersKey = repoKey(this.slug, FOLDERS_SUFFIX);
    this.index = this.loadIndex();
    // Migration/backfill: ensure dir is present and folders index is built
    this.backfillDirsAndFolders();
    if (seedWelcome && this.index.length === 0) {
      this.createNote('Welcome', WELCOME_NOTE);
      this.index = this.loadIndex();
    }
  }

  listNotes(): NoteMeta[] {
    // Defensive: refresh from storage to avoid returning stale data across tabs
    // [VNDBG] This read is safe and avoids UI from showing entries that were removed elsewhere.
    this.index = this.loadIndex();
    return this.index.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  loadNote(id: string): NoteDoc | null {
    let raw = localStorage.getItem(this.noteKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as NoteDoc;
  }

  saveNote(id: string, text: string) {
    let doc = this.loadNote(id);
    if (!doc) return;
    let updatedAt = Date.now();
    let next: NoteDoc = { ...doc, text, updatedAt };
    localStorage.setItem(this.noteKey(id), JSON.stringify(next));
    debugLog(this.slug, 'saveNote', { id, path: doc.path, updatedAt });
    this.touchIndex(id, { updatedAt });
  }

  createNote(title = 'Untitled', text = '', dir: string = ''): string {
    let id = crypto.randomUUID();
    let safe = ensureValidTitle(title || 'Untitled');
    let displayTitle = title.trim() || 'Untitled';
    let normDir = normalizeDir(dir);
    let path = joinPath(normDir, `${safe}.md`);
    let meta: NoteMeta = { id, path, title: displayTitle, dir: normDir, updatedAt: Date.now() };
    let doc: NoteDoc = { ...meta, text };
    let idx = this.loadIndex();
    idx.push(meta);
    localStorage.setItem(this.indexKey, JSON.stringify(idx));
    localStorage.setItem(this.noteKey(id), JSON.stringify(doc));
    this.index = idx;
    this.addFolder(normDir);
    debugLog(this.slug, 'createNote', { id, path, title: displayTitle });
    return id;
  }

  renameNote(id: string, title: string) {
    let doc = this.loadNote(id);
    if (!doc) return;
    let fromPath = doc.path;
    let safe = ensureValidTitle(title || 'Untitled');
    let normDir = normalizeDir(doc.dir ?? extractDir(fromPath));
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
  }

  deleteNote(id: string) {
    let doc = this.loadNote(id);
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
    debugLog(this.slug, 'deleteNote', { id, path: doc?.path });
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
    return id;
  }

  replaceWithRemote(files: { path: string; text: string; sha?: string }[]) {
    let previous = this.loadIndex();
    for (let note of previous) {
      localStorage.removeItem(this.noteKey(note.id));
    }
    let now = Date.now();
    let index: NoteMeta[] = [];
    let folderSet = new Set<string>();
    for (let file of files) {
      let id = crypto.randomUUID();
      let title = basename(file.path).replace(/\.md$/i, '');
      let dir = extractDir(file.path);
      if (dir !== '') folderSet.add(dir);
      let meta: NoteMeta = { id, path: file.path, title, dir, updatedAt: now };
      let doc: NoteDoc = {
        ...meta,
        text: file.text,
        lastRemoteSha: file.sha,
        lastSyncedHash: hashText(file.text),
      };
      index.push(meta);
      localStorage.setItem(this.noteKey(id), JSON.stringify(doc));
    }
    localStorage.setItem(this.indexKey, JSON.stringify(index));
    localStorage.setItem(this.foldersKey, JSON.stringify(Array.from(folderSet).sort()));
    this.index = index;
    debugLog(this.slug, 'replaceWithRemote', { count: files.length });
  }

  // --- Folder APIs ---
  listFolders(): string[] {
    let raw = localStorage.getItem(this.foldersKey);
    if (!raw) return [];
    try {
      let arr = JSON.parse(raw) as string[];
      if (!Array.isArray(arr)) return [];
      return arr.filter((d) => typeof d === 'string');
    } catch {
      return [];
    }
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
      let dir = normalizeDir(meta.dir ?? extractDir(meta.path));
      if (dir === from || dir.startsWith(from + '/')) {
        let rest = dir.slice(from.length);
        let nextDir = normalizeDir(to + rest);
        this.moveNoteToDir(meta.id, nextDir);
      }
    }
    localStorage.setItem(this.foldersKey, JSON.stringify(Array.from(updated).sort()));
    debugLog(this.slug, 'folder:move', { from, to });
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
      let dir = normalizeDir(meta.dir ?? extractDir(meta.path));
      if (dir === target || dir.startsWith(target + '/')) {
        this.deleteNote(meta.id);
      }
    }
    debugLog(this.slug, 'folder:delete', { dir: target });
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

  private loadIndex(): NoteMeta[] {
    let raw = localStorage.getItem(this.indexKey);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as NoteMeta[];
    } catch {
      return [];
    }
  }

  private touchIndex(id: string, patch: Partial<NoteMeta>) {
    let idx = this.loadIndex();
    let i = idx.findIndex((n) => n.id === id);
    if (i >= 0) idx[i] = { ...idx[i], ...patch } as NoteMeta;
    localStorage.setItem(this.indexKey, JSON.stringify(idx));
    this.index = idx;
    debugLog(this.slug, 'touchIndex', { id, patch });
  }

  private backfillDirsAndFolders() {
    let idx = this.loadIndex();
    let changed = false;
    let folderSet = new Set<string>(this.listFolders());
    for (let i = 0; i < idx.length; i++) {
      let meta = idx[i];
      if (!meta) continue;
      let needDir = meta.dir === undefined;
      if (needDir) {
        let dir = extractDir(meta.path);
        if (dir !== '') folderSet.add(dir);
        idx[i] = { ...meta, dir } as NoteMeta;
        // Also patch the stored document
        let dr = localStorage.getItem(this.noteKey(meta.id));
        if (dr) {
          try {
            let doc = JSON.parse(dr) as NoteDoc;
            let next: NoteDoc = { ...doc, dir };
            localStorage.setItem(this.noteKey(meta.id), JSON.stringify(next));
          } catch {}
        }
        changed = true;
      } else if ((meta.dir ?? '') !== '') {
        folderSet.add(normalizeDir(meta.dir ?? ''));
      }
    }
    if (changed) localStorage.setItem(this.indexKey, JSON.stringify(idx));
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
  let docRaw = localStorage.getItem(key);
  if (!docRaw) return;
  let doc: NoteDoc;
  try {
    doc = JSON.parse(docRaw) as NoteDoc;
  } catch {
    return;
  }
  let next: NoteDoc = { ...doc };
  if (patch.remoteSha !== undefined) next.lastRemoteSha = patch.remoteSha;
  if (patch.syncedHash !== undefined) next.lastSyncedHash = patch.syncedHash;
  localStorage.setItem(key, JSON.stringify(next));
  debugLog(slug, 'markSynced', { id, patch });
}

export function updateNoteText(slug: string, id: string, text: string) {
  let key = `${repoKey(slug, 'note')}:${id}`;
  let docRaw = localStorage.getItem(key);
  if (!docRaw) return;
  let doc: NoteDoc;
  try {
    doc = JSON.parse(docRaw) as NoteDoc;
  } catch {
    return;
  }
  let updatedAt = Date.now();
  let next: NoteDoc = { ...doc, text, updatedAt };
  localStorage.setItem(key, JSON.stringify(next));
  touchIndexUpdatedAt(slug, id, updatedAt);
  debugLog(slug, 'updateNoteText', { id, updatedAt });
}

export function findByPath(slug: string, path: string): { id: string; doc: NoteDoc } | null {
  let idxRaw = localStorage.getItem(repoKey(slug, 'index'));
  if (!idxRaw) return null;
  let idx: NoteMeta[];
  try {
    idx = JSON.parse(idxRaw) as NoteMeta[];
  } catch {
    return null;
  }
  for (let note of idx) {
    if (note.path !== path) continue;
    let dr = localStorage.getItem(`${repoKey(slug, 'note')}:${note.id}`);
    if (!dr) continue;
    try {
      let doc = JSON.parse(dr) as NoteDoc;
      return { id: note.id, doc };
    } catch {
      continue;
    }
  }
  return null;
}

export function moveNotePath(slug: string, id: string, toPath: string) {
  let key = `${repoKey(slug, 'note')}:${id}`;
  let docRaw = localStorage.getItem(key);
  if (!docRaw) return;
  let doc: NoteDoc;
  try {
    doc = JSON.parse(docRaw) as NoteDoc;
  } catch {
    return;
  }
  let updatedAt = Date.now();
  let nextDir = extractDir(toPath);
  let next: NoteDoc = { ...doc, path: toPath, dir: nextDir, updatedAt };
  localStorage.setItem(key, JSON.stringify(next));
  let idx = loadIndexForSlug(slug);
  let j = idx.findIndex((n) => n.id === id);
  if (j >= 0) {
    let old = idx[j] as NoteMeta;
    idx[j] = { id: old.id, path: toPath, title: old.title, dir: nextDir, updatedAt } as NoteMeta;
  }
  localStorage.setItem(repoKey(slug, 'index'), JSON.stringify(idx));
  debugLog(slug, 'moveNotePath', { id, toPath });
}

function loadIndexForSlug(slug: string): NoteMeta[] {
  let raw = localStorage.getItem(repoKey(slug, 'index'));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as NoteMeta[];
  } catch {
    return [];
  }
}

function touchIndexUpdatedAt(slug: string, id: string, updatedAt: number) {
  let idx = loadIndexForSlug(slug);
  let i = idx.findIndex((n) => n.id === id);
  if (i >= 0) idx[i] = { ...idx[i], updatedAt } as NoteMeta;
  localStorage.setItem(repoKey(slug, 'index'), JSON.stringify(idx));
}

function basename(p: string) {
  let i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
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

function decodeSlug(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function linkKey(slug: string): string {
  return `${LINK_PREFIX}:${encodeSlug(slug)}`;
}

function debugLog(slug: string, op: string, data: object) {
  if (!DEBUG_ENABLED) return;
  // eslint-disable-next-line no-console
  console.debug('[VNDBG]', { slug, op, ...data });
  // eslint-disable-next-line no-console
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
