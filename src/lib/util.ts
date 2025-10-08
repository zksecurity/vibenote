/**
 * Shared utility functions.
 */

export { normalizePath, pathsEqual };

function normalizePath(path: string): string;
function normalizePath(path: string | undefined): string | undefined;
function normalizePath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

function pathsEqual(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  return normalizePath(a) === normalizePath(b);
}
