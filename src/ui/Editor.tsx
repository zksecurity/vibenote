import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import type { TokenizerAndRendererExtension } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { NoteDoc } from '../storage/local';

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

  const html = useMemo(() => {
    configureDomPurifyOnce();
    configureMarkedOnce();
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
      {!readOnly && <textarea value={text} onChange={(e) => onInput(e.target.value)} spellCheck={false} />}
      <div
        className={`preview${readOnly ? ' preview-only' : ''}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  );
}

// Configure DOMPurify hooks once per module to enforce URL policy
let domPurifyConfigured = false;
let markedConfigured = false;

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

function configureMarkedOnce() {
  if (markedConfigured) return;

  const blockMathExtension: TokenizerAndRendererExtension = {
    name: 'blockMath',
    level: 'block',
    start(src) {
      const match = src.match(/\$\$/);
      return match ? match.index : undefined;
    },
    tokenizer(src) {
      const match = /^\$\$([\s\S]+?)\$\$(?:\n+|$)/.exec(src);
      if (!match) return undefined;
      const text = (match[1] ?? '').trim();
      return {
        type: 'blockMath',
        raw: match[0],
        text,
        displayMode: true,
      };
    },
    renderer(token) {
      try {
        return katex.renderToString(token.text || '', {
          displayMode: true,
          throwOnError: false,
        });
      } catch {
        return token.text || '';
      }
    },
  };

  const inlineMathExtension: TokenizerAndRendererExtension = {
    name: 'inlineMath',
    level: 'inline',
    start(src) {
      const index = src.indexOf('$');
      return index === -1 ? undefined : index;
    },
    tokenizer(src) {
      if (src[0] !== '$' || src[1] === '$') return undefined;
      let index = 1;
      let closing = -1;
      while (index < src.length) {
        const char = src[index];
        if (char === '\\') {
          index += 2;
          continue;
        }
        if (char === '$') {
          closing = index;
          break;
        }
        if (char === '\n') return undefined;
        index += 1;
      }
      if (closing === -1) return undefined;
      const raw = src.slice(0, closing + 1);
      const text = raw.slice(1, -1);
      return {
        type: 'inlineMath',
        raw,
        text,
        displayMode: false,
      };
    },
    renderer(token) {
      try {
        return katex.renderToString(token.text || '', {
          displayMode: false,
          throwOnError: false,
        });
      } catch {
        return token.text || '';
      }
    },
  };

  marked.use({ extensions: [blockMathExtension, inlineMathExtension] });
  markedConfigured = true;
}
