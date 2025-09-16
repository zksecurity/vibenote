import { describe, it, expect } from 'vitest';
import { mergeMarkdown } from './merge';

type MergeResult = {
  base: string;
  ours: string;
  theirs: string;
  result: string;
};

function checkMerge({ base, ours, theirs, result }: MergeResult) {
  const out = mergeMarkdown(base, ours, theirs);
  expect(out).toBe(result);
}

it('keeps ours when theirs equals base', () => {
  checkMerge({
    base: 'Hello\nWorld',
    ours: 'Hello brave\nWorld',
    theirs: 'Hello\nWorld',
    result: 'Hello brave\nWorld',
  });
});

it('keeps theirs when ours equals base', () => {
  checkMerge({
    base: 'Hello\nWorld',
    ours: 'Hello\nWorld',
    theirs: 'Hello there\nWorld',
    result: 'Hello there\nWorld',
  });
});

it('merges non-overlapping line edits', () => {
  checkMerge({
    base: 'line1\nline2\nline3',
    ours: 'line1\nline2 local\nline3',
    theirs: 'line1 remote\nline2\nline3',
    result: 'line1 remote\nline2 local\nline3',
  });
});

it('preserves both when same line changed differently', () => {
  checkMerge({
    base: 'title: Hello',
    ours: 'title: Hello Local',
    theirs: 'title: Hello Remote',
    result: 'title: Hello Remote Local',
  });
});

it('merges appended sections from both sides', () => {
  let base = `# Title\n\nIntro paragraph line 1.\n\nIntro paragraph line 2.`;
  let oursAppended = `## Local Subheading\n\nLocal paragraph.\n\nAnother local paragraph.`;
  let theirsAppended = `## Remote Subheading\n\nRemote paragraph.`;
  checkMerge({
    base,
    ours: `${base}\n\n${oursAppended}`,
    theirs: `${base}\n\n${theirsAppended}`,
    result: `${base}\n\n${theirsAppended}\n\n${oursAppended}`,
  });
});
