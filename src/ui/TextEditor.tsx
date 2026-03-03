// Plain-text editor — used for non-markdown text files (.ts, .json, Makefile, …).
// No preview pane, no asset handling; just a textarea.

import { useEffect, useState } from 'react';
import type { TextFile } from '../storage/local';

export { TextEditor };

type Props = {
  doc: TextFile;
  onChange: (path: string, text: string) => void;
  readOnly?: boolean;
};

function TextEditor({ doc, onChange, readOnly = false }: Props) {
  let [text, setText] = useState(doc.content);

  // Reset when switching to a different file
  useEffect(() => {
    setText(doc.content);
  }, [doc.id]);

  // Reflect external updates (e.g. after sync/merge)
  useEffect(() => {
    if (text !== doc.content) setText(doc.content);
  }, [doc.content]);

  const onInput = (val: string) => {
    if (readOnly) return;
    setText(val);
    onChange(doc.path, val);
  };

  if (readOnly) {
    return <pre className="preview preview-only">{text}</pre>;
  }
  return (
    <textarea
      value={text}
      onChange={(e) => onInput(e.target.value)}
      spellCheck={false}
    />
  );
}
