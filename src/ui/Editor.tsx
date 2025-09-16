import React, { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { marked } from 'marked';
import type { NoteDoc } from '../storage/local';

interface Props {
  doc: NoteDoc;
  onChange: (text: string) => void;
}

export function Editor({ doc, onChange }: Props) {
  const ydoc = useMemo(() => new Y.Doc(), [doc.id]);
  const ytext = useMemo(() => ydoc.getText('md'), [ydoc]);
  const [text, setText] = useState(doc.text);

  // Initialize from current text
  useEffect(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, doc.text);
    setText(doc.text);
  }, [doc.id]);

  // Reflect external updates to the same note (e.g., after sync)
  useEffect(() => {
    const current = ytext.toString();
    if (current !== doc.text) {
      ydoc.transact(() => {
        ytext.delete(0, ytext.length);
        ytext.insert(0, doc.text);
      });
      setText(doc.text);
    }
  }, [doc.text, ydoc, ytext]);

  // Subscribe to CRDT changes
  useEffect(() => {
    const sub = () => {
      const t = ytext.toString();
      setText(t);
      onChange(t);
    };
    ytext.observe(sub);
    return () => ytext.unobserve(sub);
  }, [ytext, onChange]);

  const onInput = (val: string) => {
    // Apply edit through CRDT to simulate collaborative semantics
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, val);
    });
  };

  const html = useMemo(() => marked.parse(text), [text]);

  return (
    <>
      <textarea
        value={text}
        onChange={(e) => onInput(e.target.value)}
        spellCheck={false}
      />
      <div className="preview" dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}
