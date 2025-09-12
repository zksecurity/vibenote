import React, { useMemo, useState, useEffect } from 'react';
import { NoteList } from './NoteList';
import { Editor } from './Editor';
import { LocalStore, type NoteMeta, type NoteDoc } from '../storage/local';

export function App() {
  const store = useMemo(() => new LocalStore(), []);
  const [notes, setNotes] = useState<NoteMeta[]>(store.listNotes());
  const [activeId, setActiveId] = useState<string | null>(notes[0]?.id ?? null);
  const [doc, setDoc] = useState<NoteDoc | null>(activeId ? store.loadNote(activeId) : null);

  useEffect(() => {
    setNotes(store.listNotes());
  }, [store]);

  useEffect(() => {
    setDoc(activeId ? store.loadNote(activeId) : null);
  }, [store, activeId]);

  const onCreate = () => {
    const id = store.createNote();
    setNotes(store.listNotes());
    setActiveId(id);
  };

  const onRename = (id: string, title: string) => {
    store.renameNote(id, title);
    setNotes(store.listNotes());
  };

  const onDelete = (id: string) => {
    store.deleteNote(id);
    const list = store.listNotes();
    setNotes(list);
    if (activeId === id) setActiveId(list[0]?.id ?? null);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="toolbar">
          <button className="btn primary" onClick={onCreate}>New</button>
        </div>
        <NoteList
          notes={notes}
          activeId={activeId}
          onSelect={setActiveId}
          onRename={onRename}
          onDelete={onDelete}
        />
      </aside>
      <section className="content">
        <div className="header">
          <strong>GitNote</strong>
          <span style={{ color: 'var(--muted)' }}>— Offline‑first Markdown + Git</span>
        </div>
        <div className="editor">
          {doc ? (
            <Editor doc={doc} onChange={(text) => store.saveNote(doc.id, text)} />
          ) : (
            <div style={{ padding: 16, color: 'var(--muted)' }}>Select or create a note</div>
          )}
        </div>
      </section>
    </div>
  );
}

