export type NoteMeta = {
  id: string;
  path: string;
  title: string;
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
const LEGACY_INDEX_KEY = legacyKey('index');
const LEGACY_TOMBSTONES_KEY = legacyKey('tombstones');
const LEGACY_NOTE_PREFIX = legacyKey('note');

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

type LocalStoreOptions = {
  seedWelcome?: boolean;
  notesDir?: string;
};

export class LocalStore {
  private slug: string;
  private index: NoteMeta[];
  private notesDir: string;
  private indexKey: string;
  private notePrefix: string;

  constructor(slugOrOpts: string | LocalStoreOptions = {}, maybeOpts: LocalStoreOptions = {}) {
    let slug: string;
    let opts: LocalStoreOptions;
    if (typeof slugOrOpts === 'string') {
      slug = normalizeSlug(slugOrOpts);
      opts = maybeOpts ?? {};
    } else {
      opts = slugOrOpts;
      slug = guessLegacySlug();
    }
    this.slug = slug;
    this.notesDir = opts.notesDir ?? '';
    this.indexKey = repoKey(this.slug, 'index');
    this.notePrefix = `${repoKey(this.slug, 'note')}:`;
    migrateLegacyNamespaceIfNeeded(this.slug);
    this.index = this.loadIndex();
    let shouldSeed = opts.seedWelcome ?? true;
    if (shouldSeed && this.index.length === 0) {
      this.createNote('Welcome', WELCOME_NOTE);
      this.index = this.loadIndex();
    }
  }

  getSlug(): string {
    return this.slug;
  }

  setNotesDir(dir: string) {
    this.notesDir = dir;
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

  createNote(title = 'Untitled', text = ''): string {
    let id = crypto.randomUUID();
    let safe = ensureValidTitle(title || 'Untitled');
    let displayTitle = title.trim() || 'Untitled';
    let path = joinPath(this.notesDir, `${safe}.md`);
    let meta: NoteMeta = { id, path, title: displayTitle, updatedAt: Date.now() };
    let doc: NoteDoc = { ...meta, text };
    let idx = this.loadIndex();
    idx.push(meta);
    localStorage.setItem(this.indexKey, JSON.stringify(idx));
    localStorage.setItem(this.noteKey(id), JSON.stringify(doc));
    this.index = idx;
    debugLog(this.slug, 'createNote', { id, path, title: displayTitle });
    return id;
  }

  renameNote(id: string, title: string) {
    let doc = this.loadNote(id);
    if (!doc) return;
    let fromPath = doc.path;
    let safe = ensureValidTitle(title || 'Untitled');
    let path = joinPath(this.notesDir, `${safe}.md`);
    let updatedAt = Date.now();
    let next: NoteDoc = { ...doc, title: safe, path, updatedAt };
    let pathChanged = fromPath !== path;
    if (pathChanged) {
      delete next.lastRemoteSha;
      delete next.lastSyncedHash;
    }
    localStorage.setItem(this.noteKey(id), JSON.stringify(next));
    this.touchIndex(id, { title: safe, path, updatedAt });
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
    for (let file of files) {
      let id = crypto.randomUUID();
      let title = basename(file.path).replace(/\.md$/i, '');
      let meta: NoteMeta = { id, path: file.path, title, updatedAt: now };
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
    this.index = index;
    debugLog(this.slug, 'replaceWithRemote', { count: files.length });
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

  private noteKey(id: string): string {
    return `${this.notePrefix}${id}`;
  }
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

export function markSynced(
  slug: string,
  id: string,
  patch: { remoteSha?: string; syncedHash?: string }
) {
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
  let next: NoteDoc = { ...doc, path: toPath, updatedAt };
  localStorage.setItem(key, JSON.stringify(next));
  let idx = loadIndexForSlug(slug);
  let j = idx.findIndex((n) => n.id === id);
  if (j >= 0) {
    let old = idx[j] as NoteMeta;
    idx[j] = { id: old.id, path: toPath, title: old.title, updatedAt };
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

function legacyKey(s: string): string {
  return `${NS}:${s}`;
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

export function guessLegacySlug(): string {
  let raw = localStorage.getItem(legacyKey('config'));
  if (!raw) return 'new';
  try {
    let cfg = JSON.parse(raw) as { owner?: string; repo?: string };
    if (typeof cfg.owner === 'string' && typeof cfg.repo === 'string') {
      return `${cfg.owner}/${cfg.repo}`;
    }
  } catch {}
  return 'new';
}

function readLegacyRepoConfig(): { owner: string; repo: string } | null {
  let raw = localStorage.getItem(legacyKey('config'));
  if (!raw) return null;
  try {
    let cfg = JSON.parse(raw) as { owner?: string; repo?: string };
    if (typeof cfg.owner === 'string' && typeof cfg.repo === 'string') {
      return { owner: cfg.owner, repo: cfg.repo };
    }
  } catch {}
  return null;
}

function migrateLegacyNamespaceIfNeeded(targetSlug: string) {
  const newIndexKey = repoKey(targetSlug, 'index');
  if (localStorage.getItem(newIndexKey)) return;
  // Only migrate legacy data into the matching legacy slug to avoid polluting other namespaces
  const legacyCfg = readLegacyRepoConfig();
  if (!legacyCfg) return;
  const legacySlug = `${legacyCfg.owner}/${legacyCfg.repo}`;
  if (legacySlug !== targetSlug) return;
  const legacyIndexRaw = localStorage.getItem(LEGACY_INDEX_KEY);
  if (!legacyIndexRaw) return;
  let legacyIndex: NoteMeta[];
  try {
    legacyIndex = JSON.parse(legacyIndexRaw) as NoteMeta[];
  } catch {
    return;
  }
  localStorage.setItem(newIndexKey, legacyIndexRaw);
  for (let note of legacyIndex) {
    let legacyNoteKey = `${LEGACY_NOTE_PREFIX}:${note.id}`;
    let noteRaw = localStorage.getItem(legacyNoteKey);
    if (!noteRaw) continue;
    localStorage.setItem(`${repoKey(targetSlug, 'note')}:${note.id}`, noteRaw);
    localStorage.removeItem(legacyNoteKey);
  }
  localStorage.removeItem(LEGACY_INDEX_KEY);
  let legacyTombs = localStorage.getItem(LEGACY_TOMBSTONES_KEY);
  if (legacyTombs) {
    localStorage.setItem(repoKey(targetSlug, 'tombstones'), legacyTombs);
    localStorage.removeItem(LEGACY_TOMBSTONES_KEY);
  }
}

export function listKnownRepoSlugs(): string[] {
  let prefix = `${REPO_PREFIX}:`;
  let suffix = ':index';
  let slugs = new Set<string>();
  for (let i = 0; i < localStorage.length; i++) {
    let key = localStorage.key(i);
    if (!key) continue;
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      let encoded = key.slice(prefix.length, key.length - suffix.length);
      let slug = decodeSlug(encoded);
      if (slug) slugs.add(slug);
    }
  }
  if (localStorage.getItem(LEGACY_INDEX_KEY)) {
    slugs.add(guessLegacySlug());
  }
  return Array.from(slugs).sort();
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
    return parsed.filter(
      (item) => typeof item?.slug === 'string' && typeof item?.lastOpenedAt === 'number'
    );
  } catch {
    return [];
  }
}

function saveRecentRepos(entries: RecentRepo[]) {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(entries));
}

export function listRecentRepos(): RecentRepo[] {
  const legacy = readLegacyRepoConfig();
  const now = Date.now();
  const sixMonthsMs = 1000 * 60 * 60 * 24 * 30 * 6; // approx 6 months
  // Purge very old entries and the placeholder 'new'
  let entries = loadRecentRepos()
    .filter((entry) => entry.slug !== 'new')
    .filter((entry) => now - entry.lastOpenedAt <= sixMonthsMs);
  let mapped = entries.map((entry) => ({
    ...entry,
    connected: entry.connected ?? isRepoLinked(entry.slug),
  }));

  if (legacy) {
    const slug = `${legacy.owner}/${legacy.repo}`;
    const exists = mapped.some((entry) => entry.slug === slug);
    if (!exists) {
      markRepoLinked(slug);
      localStorage.removeItem(legacyKey('config'));
      mapped.unshift({
        slug,
        owner: legacy.owner,
        repo: legacy.repo,
        lastOpenedAt: Date.now(),
        connected: true,
      });
    }
  }

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
  if (localStorage.getItem(linkKey(slug)) !== null) return true;
  const legacy = readLegacyRepoConfig();
  if (legacy && `${legacy.owner}/${legacy.repo}` === slug) {
    markRepoLinked(slug);
    localStorage.removeItem(legacyKey('config'));
    return true;
  }
  return false;
}

function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);
  return (h >>> 0).toString(16);
}
