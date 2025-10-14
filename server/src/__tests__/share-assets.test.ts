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
});
