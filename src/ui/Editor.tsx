import { useEffect, useMemo, useState, useRef, useCallback, type ClipboardEvent, type RefObject } from 'react';
import type { MarkdownFile, BinaryFile, AssetUrlFile } from '../storage/local';
import { extractDir } from '../storage/local';
import { normalizePath } from '../lib/util';
import { resolveAssetPreview } from './asset-preview-cache';
import { renderMarkdown } from '../lib/render-markdown';
import type { ImportedAsset } from '../data';
import { SUPPORTED_IMAGE_TYPES } from '../lib/image-processing';

type Props = {
  doc: MarkdownFile;
  // Pass path explicitly to eliminate any chance of routing a change
  // to the wrong note due to stale closures higher up the tree.
  onChange: (path: string, text: string) => void;
  readOnly?: boolean;
  slug: string;
  loadAsset: (path: string) => Promise<BinaryFile | AssetUrlFile | undefined>;
  onImportAssets: (params: { notePath: string; files: File[] }) => Promise<ImportedAsset[]>;
};

export function Editor({ doc, onChange, readOnly = false, slug, loadAsset, onImportAssets }: Props) {
  const [text, setText] = useState(doc.content);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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

  const handlePaste = useCallback(
    async (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (readOnly) return;
      let clipboard = event.clipboardData;
      if (!clipboard) return;
      let files: File[] = [];
      for (let item of Array.from(clipboard.items ?? [])) {
        if (item.kind !== 'file') continue;
        let file = item.getAsFile();
        if (!file) continue;
        let type = (file.type ?? '').toLowerCase();
        if (SUPPORTED_IMAGE_TYPES.has(type)) files.push(file);
      }
      if (files.length === 0) return;
      event.preventDefault();
      let target = textareaRef.current;
      let start = target?.selectionStart ?? text.length;
      let end = target?.selectionEnd ?? text.length;
      let sliceStart = Math.min(start, end);
      let sliceEnd = Math.max(start, end);
      let before = text.slice(0, sliceStart);
      let after = text.slice(sliceEnd);
      try {
        let imported = await onImportAssets({ notePath: doc.path, files });
        if (imported.length === 0) return;
        let insertion = imported.map(toMarkdownSnippet).join('\n\n');
        let hasLeading = before !== '';
        let hasTrailing = after !== '';
        let prefix = hasLeading ? ensureBlockBreakBefore(before) : before;
        let suffix = hasTrailing ? ensureBlockBreakAfter(after) : after;
        if (!hasTrailing && hasLeading) suffix = '\n\n';
        let nextText = `${prefix}${insertion}${suffix}`;
        let caretPosition = prefix.length + insertion.length;
        if (!hasTrailing) caretPosition += suffix.length;
        setText(nextText);
        onChange(doc.path, nextText);
        queueCaretUpdate(textareaRef, caretPosition);
      } catch (error) {
        console.error('vibenote: failed to import pasted assets', error);
      }
    },
    [readOnly, text, onImportAssets, doc.path, onChange]
  );

  return (
    <>
      {!readOnly && (
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => onInput(e.target.value)}
          onPaste={handlePaste}
          spellCheck={false}
        />
      )}
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

function toMarkdownSnippet(asset: ImportedAsset): string {
  return `![${asset.altText}](${asset.markdownPath})`;
}

function ensureBlockBreakBefore(content: string): string {
  if (content.endsWith('\n\n')) return content;
  if (content.endsWith('\n')) return `${content}\n`;
  return `${content}\n\n`;
}

function ensureBlockBreakAfter(content: string): string {
  if (content.startsWith('\n\n')) return content;
  if (content.startsWith('\n')) return `\n${content}`;
  return `\n\n${content}`;
}

function queueCaretUpdate(ref: RefObject<HTMLTextAreaElement>, position: number) {
  let apply = () => {
    let node = ref.current;
    if (!node) return;
    node.selectionStart = position;
    node.selectionEnd = position;
    node.focus();
  };
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(apply);
  } else {
    window.setTimeout(apply, 0);
  }
}
