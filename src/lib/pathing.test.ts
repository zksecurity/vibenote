import { describe, expect, test } from 'vitest';
import { relativePathBetween, ensureTrailingSlash } from './pathing';

describe('relativePathBetween', () => {
  test('returns direct asset path when originating from repo root', () => {
    let result = relativePathBetween('Note.md', 'assets/image.png');
    expect(result).toBe('assets/image.png');
  });

  test('navigates up directories for nested notes', () => {
    let result = relativePathBetween('docs/nested/guide.md', 'assets/paste.png');
    expect(result).toBe('../../assets/paste.png');
  });

  test('handles sibling directories gracefully', () => {
    let result = relativePathBetween('docs/guide.md', 'docs/images/chart.png');
    expect(result).toBe('images/chart.png');
  });
});

describe('ensureTrailingSlash', () => {
  test('appends slash when missing', () => {
    expect(ensureTrailingSlash('assets')).toBe('assets/');
  });

  test('leaves existing trailing slash untouched', () => {
    expect(ensureTrailingSlash('assets/')).toBe('assets/');
  });

  test('returns empty string for empty input', () => {
    expect(ensureTrailingSlash('')).toBe('');
  });
});
