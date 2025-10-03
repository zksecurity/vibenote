import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, vi } from 'vitest';

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

beforeEach(() => {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
      value: storage,
      configurable: true,
    });
    Object.defineProperty(window, 'open', {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, 'confirm', {
      value: vi.fn().mockReturnValue(true),
      configurable: true,
      writable: true,
    });
  }

  vi.stubGlobal('fetch', vi.fn());
  vi.stubGlobal('atob', (data: string) => Buffer.from(data, 'base64').toString('binary'));
  vi.stubGlobal('btoa', (data: string) => Buffer.from(data, 'binary').toString('base64'));

  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'atob', {
      value: globalThis.atob,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, 'btoa', {
      value: globalThis.btoa,
      configurable: true,
      writable: true,
    });
  }

  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'trace').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});
