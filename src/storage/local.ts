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
  private notesDir = 'notes';

  constructor() {
    this.index = this.loadIndex();
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
    const path = `${this.notesDir}/${slugify(title || 'untitled')}.md`;
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
    const path = `${this.notesDir}/${slugify(title || 'untitled')}.md`;
    const updatedAt = Date.now();
    const next: NoteDoc = { ...doc, title, path, updatedAt };
    localStorage.setItem(k(`note:${id}`), JSON.stringify(next));
    this.touchIndex(id, { title, path, updatedAt });
  }

  deleteNote(id: string) {
    const idx = this.loadIndex().filter(n => n.id !== id);
    localStorage.setItem(k('index'), JSON.stringify(idx));
    localStorage.removeItem(k(`note:${id}`));
    this.index = idx;
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
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

