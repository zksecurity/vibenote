import { describe, it, expect } from 'vitest';
import { mergeMarkdown } from './merge';

describe('Yjs merge - additional cases', () => {
  it('resolves equal-position inserts deterministically (theirs before ours)', () => {
    let base = 'abc';
    // Insert at position 1 (after 'a')
    let ours = 'aXbc';
    let theirs = 'aYbc';
    let out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe('aYXbc');
  });

  it('merges overlapping deletions as union of ranges', () => {
    let base = '0123456789';
    // ours deletes 2345 (indexes 2..6)
    let ours = '01' + '6789';
    // theirs deletes 4567 (indexes 4..8)
    let theirs = '0123' + '89';
    let out = mergeMarkdown(base, ours, theirs);
    // Expect union delete [2..8) -> remove 234567 -> result 0189
    expect(out).toBe('0189');
  });

  it('conflicting replacements at same span prefer theirs (no concat)', () => {
    let base = 'one two three';
    let ours = 'one TWO three';
    let theirs = 'one deux three';
    let out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe('one deux three');
  });

  it('orders concurrent inserts at start: theirs before ours', () => {
    let base = 'Hello';
    let ours = 'Hi ' + base;
    let theirs = 'Yo ' + base;
    let out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe('Yo Hi Hello');
  });

  it('orders concurrent inserts at end: theirs before ours', () => {
    let base = 'Hello';
    let ours = base + ' A';
    let theirs = base + ' B';
    let out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe('Hello B A');
  });

  it('identical replacements collapse to a single change', () => {
    let base = 'one two three';
    let ours = 'one TWO three';
    let theirs = 'one TWO three';
    let out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe('one TWO three');
  });
});
