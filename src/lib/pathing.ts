// Helpers for working with repo-relative paths (resolving and generating links).
export { relativePathBetween, ensureTrailingSlash, COMMON_ASSET_DIR };

import { normalizePath } from './util';

const COMMON_ASSET_DIR = 'assets';

function relativePathBetween(fromPath: string, toPath: string): string {
  let fromNormalized = normalizePath(fromPath) ?? '';
  let toNormalized = normalizePath(toPath) ?? '';
  let fromDir = trimFileName(fromNormalized);
  let fromSegments = splitPath(fromDir);
  let toSegments = splitPath(toNormalized);
  let shared = sharedSegmentLength(fromSegments, toSegments);
  let upward: string[] = [];
  for (let i = shared; i < fromSegments.length; i++) {
    upward.push('..');
  }
  let downward = toSegments.slice(shared);
  let combined = [...upward, ...downward].filter((segment) => segment !== '');
  if (combined.length === 0) return '.';
  return combined.join('/');
}

function ensureTrailingSlash(path: string): string {
  let normalized = normalizePath(path) ?? '';
  if (normalized === '') return '';
  if (normalized.endsWith('/')) return normalized;
  return `${normalized}/`;
}

function trimFileName(path: string): string {
  if (path === '') return '';
  let idx = path.lastIndexOf('/');
  if (idx < 0) return '';
  return path.slice(0, idx);
}

function splitPath(path: string): string[] {
  if (path === '') return [];
  return path.split('/');
}

function sharedSegmentLength(a: string[], b: string[]): number {
  let limit = Math.min(a.length, b.length);
  let i = 0;
  for (; i < limit; i++) {
    if (a[i] !== b[i]) break;
  }
  return i;
}
