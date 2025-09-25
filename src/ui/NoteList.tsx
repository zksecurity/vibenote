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

  const startEdit = (n: NoteMeta) => {
    setEditing(n.id);
    setTitle(n.title);
  };

  const submit = (id: string) => {
    onRename(id, title.trim() || 'Untitled');
    setEditing(null);
    setTitle('');
  };

  const cancel = () => {
    setEditing(null);
    setTitle('');
  };

  return (
    <div className="note-list">
      {notes.map((n) => (
        <div
          key={n.id}
          className={`note-item ${activeId === n.id ? 'active' : ''} ${editing === n.id ? 'editing' : ''}`}
          onClick={() => onSelect(n.id)}
        >
          {editing === n.id ? (
            <form
              className="note-item-edit"
              onSubmit={(e) => {
                e.preventDefault();
                submit(n.id);
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
              <div className="note-item-edit-actions">
                <button type="submit" className="btn primary small">
                  Save
                </button>
                <button type="button" className="btn subtle small" onClick={cancel}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="note-item-row">
              <div className="note-item-text">
                <div className="note-item-title">{n.title || 'Untitled'}</div>
                <div className="note-item-meta">{new Date(n.updatedAt).toLocaleString()}</div>
              </div>
              <div className="note-item-actions" onClick={(e) => e.stopPropagation()}>
                <button className="btn subtle small" type="button" onClick={() => startEdit(n)}>
                  Rename
                </button>
                <button className="btn subtle small danger" type="button" onClick={() => onDelete(n.id)}>
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
