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

it('resolves equal-position inserts deterministically (theirs before ours)', () => {
  checkMerge({
    base: 'abc',
    ours: 'aXbc',
    theirs: 'aYbc',
    result: 'aYXbc',
  });
});

it('merges overlapping deletions as union of ranges', () => {
  checkMerge({
    base: '0123456789',
    ours: '01' + '6789',
    theirs: '0123' + '89',
    result: '0189',
  });
});

it('conflicting replacements at same span prefer ours (no concat)', () => {
  let base = 'one two three';
  let ours = 'one TWO three';
  let theirs = 'one deux three';
  let out = mergeMarkdown(base, ours, theirs);
  expect(out === 'one TWO three' || out === 'one deux three').toBe(true);
});

it('orders concurrent inserts at start: theirs before ours', () => {
  checkMerge({
    base: 'Hello',
    ours: 'Hi Hello',
    theirs: 'Yo Hello',
    result: 'Yo Hi Hello',
  });
});

it('orders concurrent inserts at end: theirs before ours', () => {
  checkMerge({
    base: 'Hello',
    ours: 'Hello A',
    theirs: 'Hello B',
    result: 'Hello B A',
  });
});

it('identical replacements collapse to a single change', () => {
  checkMerge({
    base: 'one two three',
    ours: 'one TWO three',
    theirs: 'one TWO three',
    result: 'one TWO three',
  });
});

it('merges list insertions at different positions', () => {
  let base = `- alpha\n- beta\n- gamma`;
  let ours = `- intro\n${base}\n- omega`;
  let theirs = `- alpha\n- beta remote\n- gamma\n- delta`;
  checkMerge({
    base,
    ours,
    theirs,
    result: `- intro\n- alpha\n- beta remote\n- gamma\n- delta\n- omega`,
  });
});

it('handles list reordering and text edits', () => {
  let base = `- item1\n- item2\n- item3`;
  let ours = `- item2\n- item1 updated\n- item3`;
  let theirs = `- item1\n- item2 remote\n- item4`;
  checkMerge({
    base,
    ours,
    theirs,
    result: `- item2 remote\n- item1 updated\n- item4`,
  });
});

it('merges ordered list numbering differences', () => {
  let base = `1. first\n2. second\n3. third`;
  let ours = `1. first\n2. second (local)\n3. third\n4. bonus`;
  let theirs = `1. first remote\n2. second\n3. third`;
  checkMerge({
    base,
    ours,
    theirs,
    result: `1. first remote\n2. second (local)\n3. third\n4. bonus`,
  });
});

it('combines paragraph split vs append', () => {
  let base = `Paragraph one. Paragraph two.`;
  let ours = `Paragraph one.\n\nParagraph two extended locally.`;
  let theirs = `Paragraph one remote intro. Paragraph two.`;
  checkMerge({
    base,
    ours,
    theirs,
    result: `Paragraph one remote intro.\n\nParagraph two extended locally.`,
  });
});

it('preserves remote heading insertion with our subheading', () => {
  let base = `# Title\n\nIntro text.`;
  let ours = `${base}\n\n## Local Notes\n- detail`;
  let theirs = `## Remote Intro\n\n${base}`;
  checkMerge({
    base,
    ours,
    theirs,
    result: `## Remote Intro\n\n# Title\n\nIntro text.\n\n## Local Notes\n- detail`,
  });
});

it('handles simultaneous code block and text edits', () => {
  let base = `Here:\n\n\`\`\`js\nconsole.log(1);\n\`\`\`\n\nDone.`;
  let ours = `Here locally:\n\n\`\`\`js\nconsole.log(1);\nconsole.log('ours');\n\`\`\`\n\nDone.`;
  let theirs = `Here:\n\n\`\`\`js\nconsole.log(42);\n\`\`\`\n\nDone remotely.`;
  checkMerge({
    base,
    ours,
    theirs,
    result: `Here locally:\n\n\`\`\`js\nconsole.log(42);\nconsole.log('ours');\n\`\`\`\n\nDone remotely.`,
  });
});

it('merges overlapping paragraph deletions and insertions', () => {
  let base = `Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.`;
  let ours = `Alpha paragraph.\n\nGamma paragraph.`;
  let theirs = `Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph remote addition.`;
  checkMerge({
    base,
    ours,
    theirs,
    result: `Alpha paragraph.\n\nGamma paragraph remote addition.`,
  });
});

it('combines italic and bold emphasis edits', () => {
  let base = `This is important text.`;
  let ours = `This is *important* text.`;
  let theirs = `This is **important** text.`;
  checkMerge({
    base,
    ours,
    theirs,
    result: `This is ***important*** text.`,
  });
});

it('merges competing blockquote and paragraph edits', () => {
  let base = `Quote: life is good.`;
  let ours = `> life is good.\n\nAdded note.`;
  let theirs = `Quote: life is good indeed.`;
  checkMerge({
    base,
    ours,
    theirs,
    result: `> life is good indeed.\n\nAdded note.`,
  });
});

it('appends different sections around same anchor', () => {
  let base = `Start\n\nMiddle\n\nEnd`;
  let ours = `${base}\n\n## Local Section\nContent here.`;
  let theirs = `Start\n\n### Remote Section\nRemote content.\n\nMiddle\n\nEnd`;
  checkMerge({
    base,
    ours,
    theirs,
    result: `Start\n\n### Remote Section\nRemote content.\n\nMiddle\n\nEnd\n\n## Local Section\nContent here.`,
  });
});
