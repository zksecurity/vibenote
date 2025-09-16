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

  it('conflicting replacements at same span prefer ours (no concat)', () => {
    let base = 'one two three';
    let ours = 'one TWO three';
    let theirs = 'one deux three';
    let out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe('one TWO three');
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

describe('Yjs merge - extended scenarios', () => {
  it('merges list insertions at different positions', () => {
    let base = `- alpha\n- beta\n- gamma`;
    let ours = `- intro\n${base}\n- omega`;
    let theirs = `- alpha\n- beta remote\n- gamma\n- delta`;
    let out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe(`- intro\n- alpha\n- beta remote\n- gamma\n- delta\n- omega`);
  });

  // fails
  it('handles list reordering and text edits', () => {
    let base = `- item1\n- item2\n- item3`;
    let ours = `- item2\n- item1 updated\n- item3`;
    let theirs = `- item1\n- item2 remote\n- item4`;
    let out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe(`- item2 remote\n- item1 updated\n- item4`);
  });

  it('merges ordered list numbering differences', () => {
    let base = `1. first\n2. second\n3. third`;
    let ours = `1. first\n2. second (local)\n3. third\n4. bonus`;
    let theirs = `1. first remote\n2. second\n3. third`;
    let out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe(`1. first remote\n2. second (local)\n3. third\n4. bonus`);
  });

  // fails
  it('combines paragraph split vs append', () => {
    let base = `Paragraph one. Paragraph two.`;
    let ours = `Paragraph one.\n\nParagraph two extended locally.`;
    let theirs = `Paragraph one remote intro. Paragraph two.`;
    let out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe(`Paragraph one remote intro.\n\nParagraph two extended locally.`);
  });

  it('preserves remote heading insertion with our subheading', () => {
    let base = `# Title\n\nIntro text.`;
    let ours = `${base}\n\n## Local Notes\n- detail`;
    let theirs = `## Remote Intro\n\n${base}`;
    let out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe(`## Remote Intro\n\n# Title\n\nIntro text.\n\n## Local Notes\n- detail`);
  });

  it('handles simultaneous code block and text edits', () => {
    let base = `Here:\n\n\`\`\`js\nconsole.log(1);\n\`\`\`\n\nDone.`;
    let ours = `Here locally:\n\n\`\`\`js\nconsole.log(1);\nconsole.log('ours');\n\`\`\`\n\nDone.`;
    let theirs = `Here:\n\n\`\`\`js\nconsole.log(42);\n\`\`\`\n\nDone remotely.`;
    let out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe(
      `Here locally:\n\n\`\`\`js\nconsole.log(42);\nconsole.log('ours');\n\`\`\`\n\nDone remotely.`
    );
  });

  it('merges overlapping paragraph deletions and insertions', () => {
    let base = `Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.`;
    let ours = `Alpha paragraph.\n\nGamma paragraph.`;
    let theirs = `Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph remote addition.`;
    let out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe(`Alpha paragraph.\n\nGamma paragraph remote addition.`);
  });

  it('combines italic and bold emphasis edits', () => {
    let base = `This is important text.`;
    let ours = `This is *important* text.`;
    let theirs = `This is **important** text.`;
    let out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe(`This is ***important*** text.`);
  });

  // fails
  it('merges competing blockquote and paragraph edits', () => {
    let base = `Quote: life is good.`;
    let ours = `> life is good.\n\nAdded note.`;
    let theirs = `Quote: life is good indeed.`;
    let out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe(`> life is good indeed.\n\nAdded note.`);
  });

  it('appends different sections around same anchor', () => {
    let base = `Start\n\nMiddle\n\nEnd`;
    let ours = `${base}\n\n## Local Section\nContent here.`;
    let theirs = `Start\n\n### Remote Section\nRemote content.\n\nMiddle\n\nEnd`;
    let out = mergeMarkdown(base, ours, theirs);
    expect(out).toBe(
      `Start\n\n### Remote Section\nRemote content.\n\nMiddle\n\nEnd\n\n## Local Section\nContent here.`
    );
  });
});
