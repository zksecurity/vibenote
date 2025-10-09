import { describe, expect, it } from 'vitest';
import { extractMarkdownAssets, rewriteMarkdownAssets } from './markdown-assets';

describe('markdown asset discovery', () => {
  it('finds relative markdown links and images', () => {
    let markdown = `
![Cover](./images/cover.png)
Look at [attachment](docs/manual.pdf)
<img src="./badges/status.svg" />
`;
    let refs = extractMarkdownAssets(markdown);
    expect(refs.map((ref) => ref.normalized)).toEqual(['images/cover.png', 'docs/manual.pdf', 'badges/status.svg']);
  });

  it('keeps distinct raw values for the same normalized path', () => {
    let markdown = '![A](assets/logo.png) ![B](./assets/logo.png?size=small)';
    let refs = extractMarkdownAssets(markdown);
    expect(refs.length).toBe(2);
    let first = refs[0];
    let second = refs[1];
    if (!first || !second) {
      throw new Error('expected two asset references');
    }
    expect(first.normalized).toBe('assets/logo.png');
    expect(second.normalized).toBe('assets/logo.png');
    expect(first.raw).not.toEqual(second.raw);
  });
});

describe('markdown asset rewrite', () => {
  it('replaces asset urls with provided mapping', () => {
    let markdown = '![Cover](images/cover.png?raw=1)';
    let map = new Map<string, string>([['images/cover.png?raw=1', 'asset_0001.png']]);
    let rewritten = rewriteMarkdownAssets(markdown, map);
    expect(rewritten).toContain('asset_0001.png');
    expect(rewritten).not.toContain('?raw=1');
  });
});
