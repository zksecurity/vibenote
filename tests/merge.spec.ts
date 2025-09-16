import { describe, it, expect } from 'vitest';
import { mergeMarkdown } from '../src/merge/merge';

describe('mergeMarkdown - basics', () => {
  it('keeps ours when theirs equals base', () => {
    const base = 'Hello\nWorld';
    const ours = 'Hello brave\nWorld';
    const theirs = base;
    const out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe(ours);
  });

  it('keeps theirs when ours equals base', () => {
    const base = 'Hello\nWorld';
    const ours = base;
    const theirs = 'Hello there\nWorld';
    const out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe(theirs);
  });

  it('merges non-overlapping line edits', () => {
    const base = 'line1\nline2\nline3';
    const ours = 'line1\nline2 local\nline3';
    const theirs = 'line1 remote\nline2\nline3';
    const out = mergeMarkdown(base, ours, theirs);
    expect(out.includes('line1 remote')).toBe(true);
    expect(out.includes('line2 local')).toBe(true);
    expect(out.includes('line3')).toBe(true);
  });

  it('preserves both when same line changed differently', () => {
    const base = 'title: Hello';
    const ours = 'title: Hello Local';
    const theirs = 'title: Hello Remote';
    const out = mergeMarkdown(base, ours, theirs);
    // We accept either perfect merge or conservative union (ours plus remote-only appended)
    expect(out.includes('Hello Local')).toBe(true);
    expect(out.includes('Hello Remote')).toBe(true);
  });
});

