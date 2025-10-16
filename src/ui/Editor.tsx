import { useEffect, useMemo, useState, useRef } from 'react';
import type { MarkdownFile, BinaryFile, AssetUrlFile } from '../storage/local';
import { extractDir } from '../storage/local';
import { normalizePath } from '../lib/util';
import { resolveAssetPreview } from './asset-preview-cache';
import { renderMarkdown } from '../lib/render-markdown';

type Props = {
  doc: MarkdownFile;
  // Pass path explicitly to eliminate any chance of routing a change
  // to the wrong note due to stale closures higher up the tree.
  onChange: (path: string, text: string) => void;
  readOnly?: boolean;
  slug: string;
  loadAsset: (path: string) => Promise<BinaryFile | AssetUrlFile | undefined>;
};

export function Editor({ doc, onChange, readOnly = false, slug, loadAsset }: Props) {
  const [text, setText] = useState(doc.content);
  const previewRef = useRef<HTMLDivElement | null>(null);

  // Reset editor when switching to a different note
  useEffect(() => {
    setText(doc.content);
  }, [doc.id]);

  // Reflect external updates to the same note (e.g., after sync/merge)
  useEffect(() => {
    if (text !== doc.content) setText(doc.content);
  }, [doc.content]);

  const onInput = (val: string) => {
    if (readOnly) return;
    setText(val);
    onChange(doc.path, val);
  };

  const html = useMemo(() => renderMarkdown(text, 'editor'), [text]);

  // Resolve relative image sources inside the rendered Markdown preview.
  useEffect(() => {
    let container = previewRef.current;
    if (!container) return;
    let cancelled = false;
    let images = Array.from(container.querySelectorAll('img'));
    for (let img of images) {
      if (cancelled) break;
      let annotated = img.getAttribute('data-vibenote-src');
      if (!annotated) {
        let initial = img.getAttribute('src') ?? '';
        if (initial === '') continue;
        img.setAttribute('data-vibenote-src', initial);
        annotated = initial;
      }
      let assetPath = resolveAssetPath(doc.path, annotated);
      if (!assetPath) continue;
      void resolveAssetPreview({ slug, assetPath, loadAsset }).then((preview) => {
        if (cancelled || !preview) return;
        if (img.getAttribute('src') !== preview.url) {
          img.setAttribute('src', preview.url);
        }
        img.setAttribute('data-vibenote-resolved', 'true');
      });
    }
    return () => {
      cancelled = true;
    };
  }, [html, doc.path, slug, loadAsset]);

  return (
    <>
      {!readOnly && <textarea value={text} onChange={(e) => onInput(e.target.value)} spellCheck={false} />}
      <div
        ref={previewRef}
        className={`preview${readOnly ? ' preview-only' : ''}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  );
}

function resolveAssetPath(docPath: string, src: string): string | undefined {
  if (!isRelativeAssetSrc(src)) return undefined;
  let withoutQuery = stripQueryAndHash(src);
  if (withoutQuery === '') return undefined;
  let decoded = decodePathComponent(withoutQuery);
  if (decoded === undefined) return undefined;
  if (decoded.startsWith('/')) {
    return simplifyPath(decoded.slice(1));
  }
  let baseDir = extractDir(docPath);
  let combined = baseDir ? `${baseDir}/${decoded}` : decoded;
  return simplifyPath(combined);
}

function isRelativeAssetSrc(src: string): boolean {
  let trimmed = src.trim();
  if (trimmed === '') return false;
  if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) return false;
  if (trimmed.startsWith('//')) return false;
  if (trimmed.startsWith('#')) return false;
  return true;
}

function stripQueryAndHash(src: string): string {
  let limit = src.length;
  for (let i = 0; i < src.length; i++) {
    let char = src[i];
    if (char === '?' || char === '#') {
      limit = i;
      break;
    }
  }
  return src.slice(0, limit);
}

function simplifyPath(path: string): string {
  let normalized = normalizePath(path) ?? '';
  let segments = normalized.split('/');
  let stack: string[] = [];
  for (let part of segments) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

function decodePathComponent(path: string): string | undefined {
  try {
    return decodeURI(path);
  } catch {
    return undefined;
  }
}
