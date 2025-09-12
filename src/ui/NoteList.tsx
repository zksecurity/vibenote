import React, { useState } from 'react';
import type { NoteMeta } from '../storage/local';

interface Props {
  notes: NoteMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

export function NoteList({ notes, activeId, onSelect, onRename, onDelete }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState('');

  const startEdit = (n: NoteMeta) => { setEditing(n.id); setTitle(n.title); };
  const submit = (id: string) => { onRename(id, title.trim() || 'Untitled'); setEditing(null); };

  return (
    <div className="note-list">
      {notes.map((n) => (
        <div
          key={n.id}
          className={`note-item ${activeId === n.id ? 'active' : ''}`}
          onClick={() => onSelect(n.id)}
        >
          {editing === n.id ? (
            <form
              onSubmit={(e) => { e.preventDefault(); submit(n.id); }}
              onClick={(e) => e.stopPropagation()}
            >
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
            </form>
          ) : (
            <div style={{ display:'flex', justifyContent:'space-between', gap:8 }}>
              <div>
                <div>{n.title || 'Untitled'}</div>
                <div style={{ color:'var(--muted)', fontSize:12 }}>{new Date(n.updatedAt).toLocaleString()}</div>
              </div>
              <div style={{ display:'flex', gap:6 }} onClick={(e)=>e.stopPropagation()}>
                <button className="btn" onClick={() => startEdit(n)}>Rename</button>
                <button className="btn" onClick={() => onDelete(n.id)}>Delete</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

