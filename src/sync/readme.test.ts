import { beforeAll, describe, expect, test } from 'vitest';

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key) ?? null : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

const globalAny = globalThis as { localStorage?: Storage };

let buildReadme: (repoName: string) => string;

beforeAll(async () => {
  globalAny.localStorage = new MemoryStorage();
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
