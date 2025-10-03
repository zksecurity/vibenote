import { beforeAll, describe, expect, test } from 'vitest';

let buildReadme: (repoName: string) => string;

beforeAll(async () => {
  const mod = await import('./readme');
  buildReadme = mod.buildReadme;
});

describe('buildReadme', () => {
  test('uses repo name as heading', () => {
    const readme = buildReadme('notes-repo');
    expect(readme.startsWith('# notes-repo')).toBe(true);
  });

  test('includes welcome copy', () => {
    const readme = buildReadme('anything');
    expect(readme).toContain('managed by [VibeNote]');
    expect(readme).toContain('vibenote.dev');
  });
});
