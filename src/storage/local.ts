export interface NoteMeta {
  id: string;
  path: string; // notes/<slug>.md
  title: string;
  updatedAt: number;
}

export interface NoteDoc extends NoteMeta {
  text: string;
  lastRemoteSha?: string;
}

const NS = 'gitnote';
const k = (s: string) => `${NS}:${s}`;

export class LocalStore {
  private index: NoteMeta[];
  private notesDir = '';

  constructor() {
    this.index = this.loadIndex();
    this.migrateLegacyNotesDir();
    if (this.index.length === 0) {
      // Seed with a welcome note
      const id = this.createNote('Welcome', `# Welcome to GitNote\n\nStart editing…`);
      this.index = this.loadIndex();
    }
  }

  listNotes(): NoteMeta[] { return this.index.slice().sort((a,b)=>b.updatedAt-a.updatedAt); }

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
    const safe = ensureValidTitle(title || 'Untitled');
    const path = joinPath(this.notesDir, `${safe}.md`);
    const updatedAt = Date.now();
    const next: NoteDoc = { ...doc, title: safe, path, updatedAt };
    localStorage.setItem(k(`note:${id}`), JSON.stringify(next));
    this.touchIndex(id, { title: safe, path, updatedAt });
  }

  deleteNote(id: string) {
    const idx = this.loadIndex().filter(n => n.id !== id);
    localStorage.setItem(k('index'), JSON.stringify(idx));
    localStorage.removeItem(k(`note:${id}`));
    this.index = idx;
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
      const doc: NoteDoc = { ...meta, text: f.text, lastRemoteSha: f.sha };
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
    try { return JSON.parse(raw) as NoteMeta[]; } catch { return []; }
  }

  private touchIndex(id: string, patch: Partial<NoteMeta>) {
    const idx = this.loadIndex();
    const i = idx.findIndex(n => n.id === id);
    if (i >= 0) idx[i] = { ...idx[i], ...patch } as NoteMeta;
    localStorage.setItem(k('index'), JSON.stringify(idx));
    this.index = idx;
  }

  private migrateLegacyNotesDir() {
    const idx = this.loadIndex();
    let changed = false;
    for (let i = 0; i < idx.length; i++) {
      const meta = idx[i];
      if (meta.path.startsWith('notes/')) {
        const newPath = basename(meta.path);
        if (newPath !== meta.path) {
          const doc = this.loadNote(meta.id);
          const updatedAt = Date.now();
          const nextMeta: NoteMeta = { ...meta, path: newPath, updatedAt };
          idx[i] = nextMeta;
          if (doc) {
            const nextDoc: NoteDoc = { ...doc, path: newPath, updatedAt };
            localStorage.setItem(k(`note:${meta.id}`), JSON.stringify(nextDoc));
          }
          changed = true;
        }
      }
    }
    if (changed) {
      localStorage.setItem(k('index'), JSON.stringify(idx));
      this.index = idx;
    }
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

function joinPath(dir: string, file: string) {
  if (!dir) return file;
  return `${dir.replace(/\/+$/,'')}/${file.replace(/^\/+/, '')}`;
}
