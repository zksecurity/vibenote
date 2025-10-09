import { useEffect, useMemo, useState } from 'react';
import 'katex/dist/katex.min.css';
import type { NoteDoc } from '../storage/local';
import { renderMarkdown } from '../lib/markdown';

type Props = {
  doc: NoteDoc;
  // Pass path explicitly to eliminate any chance of routing a change
  // to the wrong note due to stale closures higher up the tree.
  onChange: (path: string, text: string) => void;
  readOnly?: boolean;
};

export function Editor({ doc, onChange, readOnly = false }: Props) {
  const [text, setText] = useState(doc.text);

  // Reset editor when switching to a different note
  useEffect(() => {
    setText(doc.text);
  }, [doc.id]);

  // Reflect external updates to the same note (e.g., after sync/merge)
  useEffect(() => {
    if (text !== doc.text) setText(doc.text);
  }, [doc.text]);

  const onInput = (val: string) => {
    if (readOnly) return;
    setText(val);
    onChange(doc.path, val);
  };

  const html = useMemo(() => renderMarkdown(text), [text]);

  return (
    <>
      {!readOnly && <textarea value={text} onChange={(e) => onInput(e.target.value)} spellCheck={false} />}
      <div
        className={`preview${readOnly ? ' preview-only' : ''}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  );
}
