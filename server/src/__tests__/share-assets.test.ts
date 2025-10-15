import { describe, expect, it } from 'vitest';
import {
  extractRelativeAssetRefs,
  resolveAssetPath,
  decodeAssetParam,
  collectAssetPaths,
} from '../share-assets.ts';

describe('share asset helpers', () => {
  it('extracts inline image references with encoded paths', () => {
    const markdown = '![Diagram](zkSecurity%20wiki/Audit%20Playbook/playbook.png)';
    const refs = extractRelativeAssetRefs(markdown);
    expect(refs).toContain('zkSecurity%20wiki/Audit%20Playbook/playbook.png');
    const normalized = resolveAssetPath(
      'docs/shared-note.md',
      decodeAssetParam('zkSecurity%20wiki/Audit%20Playbook/playbook.png')
    );
    expect(normalized).toBe('docs/zkSecurity wiki/Audit Playbook/playbook.png');
    const paths = collectAssetPaths('docs/shared-note.md', markdown);
    expect(paths.has('docs/zkSecurity wiki/Audit Playbook/playbook.png')).toBe(true);
  });

  it('handles assets when note is nested and markdown uses ./ prefix', () => {
    const markdown = '![Diagram](./Audit%20Playbook/playbook.png)';
    const refs = extractRelativeAssetRefs(markdown);
    expect(refs).toContain('./Audit%20Playbook/playbook.png');
    const normalized = resolveAssetPath(
      'zkSecurity wiki/shared-note.md',
      decodeAssetParam('./Audit%20Playbook/playbook.png')
    );
    expect(normalized).toBe('zkSecurity wiki/Audit Playbook/playbook.png');
    const paths = collectAssetPaths('zkSecurity wiki/shared-note.md', markdown);
    expect(paths.has('zkSecurity wiki/Audit Playbook/playbook.png')).toBe(true);

    // Simulate viewer rewrite that already expands the note dir
    const normalizedDirect = resolveAssetPath(
      'zkSecurity wiki/shared-note.md',
      decodeAssetParam('zkSecurity%20wiki/Audit%20Playbook/playbook.png')
    );
    expect(normalizedDirect).toBe('zkSecurity wiki/Audit Playbook/playbook.png');
  });

  it('extracts reference-style image definitions', () => {
    const markdown = `
![diagram][diagram-ref]

[diagram-ref]: zkSecurity%20wiki/Audit%20Playbook/playbook.png "Diagram"
`;
    const refs = extractRelativeAssetRefs(markdown);
    expect(refs).toContain('zkSecurity%20wiki/Audit%20Playbook/playbook.png');
  });

  it('ignores external references', () => {
    const markdown = '![External](https://example.com/image.png)';
    const refs = extractRelativeAssetRefs(markdown);
    expect(refs).toHaveLength(0);
  });

  it('collects attachment links while skipping markdown files', () => {
    const markdown = `
[Slides](attachments/talk.pdf)
[Neighbour](../other-note.md)
[Sibling note](linked-note.md)
<a href="files/budget.csv">Budget</a>
`;
    const paths = collectAssetPaths('notes/shared.md', markdown);
    expect(paths.has('notes/attachments/talk.pdf')).toBe(true);
    expect(paths.has('notes/files/budget.csv')).toBe(true);
    expect(paths.has('notes/other-note.md')).toBe(false);
    expect(paths.has('notes/linked-note.md')).toBe(false);
    expect(paths.size).toBe(2);
  });

  it('collects media sources from html tags', () => {
    const markdown = `
<video src="media/intro.mp4"></video>
<audio src="media/theme.mp3"></audio>
<source src="media/intro.webm" type="video/webm" />
<track src="media/captions.vtt" kind="captions" />
`;
    const paths = collectAssetPaths('notes/shared.md', markdown);
    expect(paths.has('notes/media/intro.mp4')).toBe(true);
    expect(paths.has('notes/media/theme.mp3')).toBe(true);
    expect(paths.has('notes/media/intro.webm')).toBe(true);
    expect(paths.has('notes/media/captions.vtt')).toBe(true);
  });
});
