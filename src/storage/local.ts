export interface NoteMeta {
  id: string;
  path: string; // path to note file (e.g., "Title.md")
  title: string;
  updatedAt: number;
}

export interface NoteDoc extends NoteMeta {
  text: string;
  lastRemoteSha?: string;
  // Hash of text at last successful sync (pull or push)
  lastSyncedHash?: string;
}

const NS = 'vibenote';
const k = (s: string) => `${NS}:${s}`;

export class LocalStore {
  private index: NoteMeta[];
  private notesDir = '';

  constructor() {
    this.index = this.loadIndex();
    if (this.index.length === 0) {
      // Seed with a welcome note
      const id = this.createNote('Welcome', `# Welcome to VibeNote\n\nStart editing…`);
      this.index = this.loadIndex();
    }
  }

  listNotes(): NoteMeta[] {
    return this.index.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  loadNote(id: string): NoteDoc | null {
    const raw = localStorage.getItem(k(`note:${id}`));
    if (!raw) return null;
    return JSON.parse(raw) as NoteDoc;
  }

  saveNote(id: string, text: string) {
    const doc = this.loadNote(id);
    if (!doc) return;
    const updatedAt = Date.now();
    const next: NoteDoc = { ...doc, text, updatedAt };
    localStorage.setItem(k(`note:${id}`), JSON.stringify(next));
    this.touchIndex(id, { updatedAt });
  }

  createNote(title = 'Untitled', text = ''): string {
    const id = crypto.randomUUID();
    const safe = ensureValidTitle(title || 'Untitled');
    const path = joinPath(this.notesDir, `${safe}.md`);
    const meta: NoteMeta = { id, path, title, updatedAt: Date.now() };
    const doc: NoteDoc = { ...meta, text };
    const idx = this.loadIndex();
    idx.push(meta);
    localStorage.setItem(k('index'), JSON.stringify(idx));
    localStorage.setItem(k(`note:${id}`), JSON.stringify(doc));
    this.index = idx;
    return id;
  }

  renameNote(id: string, title: string) {
    const doc = this.loadNote(id);
    if (!doc) return;
    const fromPath = doc.path;
    const safe = ensureValidTitle(title || 'Untitled');
    const path = joinPath(this.notesDir, `${safe}.md`);
    const updatedAt = Date.now();
    const next: NoteDoc = { ...doc, title: safe, path, updatedAt };
    localStorage.setItem(k(`note:${id}`), JSON.stringify(next));
    this.touchIndex(id, { title: safe, path, updatedAt });
    if (fromPath !== path) {
      recordRenameTombstone({ from: fromPath, to: path, lastRemoteSha: doc.lastRemoteSha, renamedAt: Date.now() });
    }
  }

  deleteNote(id: string) {
    const doc = this.loadNote(id);
    const idx = this.loadIndex().filter((n) => n.id !== id);
    localStorage.setItem(k('index'), JSON.stringify(idx));
    if (doc) {
      // Record tombstone for safe remote delete handling
      recordDeleteTombstone({ path: doc.path, lastRemoteSha: doc.lastRemoteSha, deletedAt: Date.now() });
    }
    localStorage.removeItem(k(`note:${id}`));
    this.index = idx;
  }

  // Reset local notes to the initial welcome state (used on sign out)
  resetToWelcome(): string {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key === k('index') || key.startsWith(k('note:'))) toRemove.push(key);
    }
    for (const key of toRemove) localStorage.removeItem(key);
    // Seed welcome note
    const id = this.createNote('Welcome', `# Welcome to VibeNote\n\nStart editing…`);
    this.index = this.loadIndex();
    return id;
  }

  // Replace the entire local store with files from remote
  replaceWithRemote(files: { path: string; text: string; sha?: string }[]) {
    // Clear existing notes
    const prev = this.loadIndex();
    for (const n of prev) {
      localStorage.removeItem(k(`note:${n.id}`));
    }
    // Build new index/docs
    const now = Date.now();
    const index: NoteMeta[] = [];
    for (const f of files) {
      const id = crypto.randomUUID();
      const title = basename(f.path).replace(/\.md$/i, '');
      const meta: NoteMeta = { id, path: f.path, title, updatedAt: now };
      const doc: NoteDoc = { ...meta, text: f.text, lastRemoteSha: f.sha, lastSyncedHash: hashText(f.text) };
      index.push(meta);
      localStorage.setItem(k(`note:${id}`), JSON.stringify(doc));
    }
    localStorage.setItem(k('index'), JSON.stringify(index));
    this.index = index;
  }

  // --- internals ---
  private loadIndex(): NoteMeta[] {
    const raw = localStorage.getItem(k('index'));
    if (!raw) return [];
    try {
      return JSON.parse(raw) as NoteMeta[];
    } catch {
      return [];
    }
  }

  private touchIndex(id: string, patch: Partial<NoteMeta>) {
    const idx = this.loadIndex();
    const i = idx.findIndex((n) => n.id === id);
    if (i >= 0) idx[i] = { ...idx[i], ...patch } as NoteMeta;
    localStorage.setItem(k('index'), JSON.stringify(idx));
    this.index = idx;
  }
}

function basename(p: string) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function ensureValidTitle(title: string): string {
  const t = title.trim();
  if (!t) return 'Untitled';
  if (t === '.' || t === '..') return 'Untitled';
  if (/[\/\0]/.test(t)) {
    // Disallow slash and null; simplest guard for path traversal
    throw new Error('Invalid title: contains illegal characters');
  }
  return t;
}

// namespace migration removed

function joinPath(dir: string, file: string) {
  if (!dir) return file;
  return `${dir.replace(/\/+$/, '')}/${file.replace(/^\/+/, '')}`;
}

// --- Tombstones and utils ---
export type DeleteTombstone = { type: 'delete'; path: string; lastRemoteSha?: string; deletedAt: number };
export type RenameTombstone = { type: 'rename'; from: string; to: string; lastRemoteSha?: string; renamedAt: number };
export type Tombstone = DeleteTombstone | RenameTombstone;

const TOMBSTONES_KEY = k('tombstones');

export function listTombstones(): Tombstone[] {
  const raw = localStorage.getItem(TOMBSTONES_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as Tombstone[];
    if (!Array.isArray(arr)) return [];
    return arr;
  } catch {
    return [];
  }
}

function saveTombstones(ts: Tombstone[]) {
  localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(ts));
}

export function recordDeleteTombstone(t: { path: string; lastRemoteSha?: string; deletedAt: number }) {
  const ts = listTombstones();
  ts.push({ type: 'delete', path: t.path, lastRemoteSha: t.lastRemoteSha, deletedAt: t.deletedAt });
  saveTombstones(ts);
}

export function recordRenameTombstone(t: { from: string; to: string; lastRemoteSha?: string; renamedAt: number }) {
  const ts = listTombstones();
  ts.push({ type: 'rename', from: t.from, to: t.to, lastRemoteSha: t.lastRemoteSha, renamedAt: t.renamedAt });
  saveTombstones(ts);
}

export function removeTombstones(predicate: (t: Tombstone) => boolean) {
  const ts = listTombstones().filter((t) => !predicate(t));
  saveTombstones(ts);
}

export function clearAllTombstones() {
  localStorage.removeItem(TOMBSTONES_KEY);
}

export function markSynced(id: string, patch: { remoteSha?: string; syncedHash?: string }) {
  const docRaw = localStorage.getItem(k(`note:${id}`));
  if (!docRaw) return;
  let doc: NoteDoc;
  try {
    doc = JSON.parse(docRaw) as NoteDoc;
  } catch {
    return;
  }
  const next: NoteDoc = { ...doc };
  if (patch.remoteSha !== undefined) next.lastRemoteSha = patch.remoteSha;
  if (patch.syncedHash !== undefined) next.lastSyncedHash = patch.syncedHash;
  localStorage.setItem(k(`note:${id}`), JSON.stringify(next));
}

export function updateNoteText(id: string, text: string) {
  const docRaw = localStorage.getItem(k(`note:${id}`));
  if (!docRaw) return;
  let doc: NoteDoc;
  try {
    doc = JSON.parse(docRaw) as NoteDoc;
  } catch {
    return;
  }
  const updatedAt = Date.now();
  const next: NoteDoc = { ...doc, text, updatedAt };
  localStorage.setItem(k(`note:${id}`), JSON.stringify(next));
}

export function findByPath(path: string): { id: string; doc: NoteDoc } | null {
  const idxRaw = localStorage.getItem(k('index'));
  if (!idxRaw) return null;
  let idx: NoteMeta[];
  try {
    idx = JSON.parse(idxRaw) as NoteMeta[];
  } catch {
    return null;
  }
  for (const n of idx) {
    if (n.path === path) {
      const dr = localStorage.getItem(k(`note:${n.id}`));
      if (!dr) continue;
      try {
        const d = JSON.parse(dr) as NoteDoc;
        return { id: n.id, doc: d };
      } catch {}
    }
  }
  return null;
}

export function moveNotePath(id: string, toPath: string) {
  const docRaw = localStorage.getItem(k(`note:${id}`));
  if (!docRaw) return;
  let doc: NoteDoc;
  try {
    doc = JSON.parse(docRaw) as NoteDoc;
  } catch {
    return;
  }
  const updatedAt = Date.now();
  const next: NoteDoc = { ...doc, path: toPath, updatedAt };
  localStorage.setItem(k(`note:${id}`), JSON.stringify(next));
  // reflect in index
  const idx = ((): NoteMeta[] => {
    const raw = localStorage.getItem(k('index'));
    if (!raw) return [];
    try { return JSON.parse(raw) as NoteMeta[]; } catch { return []; }
  })();
  const j = idx.findIndex((n) => n.id === id);
  if (j >= 0) {
    const old = idx[j] as NoteMeta;
    idx[j] = { id: old.id, path: toPath, title: old.title, updatedAt };
  }
  localStorage.setItem(k('index'), JSON.stringify(idx));
}

function hashText(text: string): string {
  // simple, deterministic non-cryptographic hash
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);
  // Convert to unsigned and hex
  return (h >>> 0).toString(16);
}
