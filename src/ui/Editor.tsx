import React, { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import type { NoteDoc } from '../storage/local';

interface Props {
  doc: NoteDoc;
  // Pass id explicitly to eliminate any chance of routing a change
  // to the wrong note due to stale closures higher up the tree.
  onChange: (id: string, text: string) => void;
}

export function Editor({ doc, onChange }: Props) {
  const [text, setText] = useState(doc.text);

  // Reset editor when switching to a different note
  useEffect(() => {
    setText(doc.text);
  }, [doc.id]);

  // Reflect external updates to the same note (e.g., after sync/merge)
  useEffect(() => {
    if (text !== doc.text) setText(doc.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.text]);

  const onInput = (val: string) => {
    setText(val);
    onChange(doc.id, val);
  };

  const html = useMemo(() => marked.parse(text), [text]);

  return (
    <>
      <textarea value={text} onChange={(e) => onInput(e.target.value)} spellCheck={false} />
      <div className="preview" dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}
