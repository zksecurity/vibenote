import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
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

  const html = useMemo(() => {
    configureDomPurifyOnce();
    const out = marked.parse(text, { async: false });
    const raw = typeof out === 'string' ? out : '';
    // Sanitize to prevent XSS; hooks enforce URL policy and link hygiene
    return DOMPurify.sanitize(raw, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['target', 'rel'],
    });
  }, [text]);

  return (
    <>
      <textarea value={text} onChange={(e) => onInput(e.target.value)} spellCheck={false} />
      <div className="preview" dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}

// Configure DOMPurify hooks once per module to enforce URL policy
let domPurifyConfigured = false;

function configureDomPurifyOnce() {
  if (domPurifyConfigured) return;
  // Block dangerous URL schemes on href/src; drop malformed URLs
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    const name = data.attrName as string;
    if (name !== 'href' && name !== 'src') return;
    const value = (data.attrValue as string) || '';
    try {
      const url = new URL(value, window.location.href);
      const scheme = url.protocol.toLowerCase();
      if (scheme === 'data:' || scheme === 'javascript:') {
        data.keepAttr = false;
        (data as any).attrValue = '';
      }
    } catch {
      data.keepAttr = false;
      (data as any).attrValue = '';
    }
  });
  // Add safe attributes for external links
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if ((node as Element).tagName === 'A') {
      const a = node as HTMLAnchorElement;
      const href = a.getAttribute('href') || '';
      try {
        const url = new URL(href, window.location.href);
        const isExternal = url.origin !== window.location.origin;
        if (isExternal) {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        }
      } catch {
        // ignore
      }
    }
  });
  domPurifyConfigured = true;
}
