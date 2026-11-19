// Tests for the service worker's cache cleanup on activation.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

describe('service worker activation', () => {
  it("deletes outdated worker caches and keeps the app's blob cache", async () => {
    let names = new Set([
      'vibenote-app-shell-v0',
      'vibenote-app-shell-v1',
      'vibenote-asset-v1',
      'vibenote/blob-cache/v1',
    ]);
    let listeners = new Map<string, (event: unknown) => void>();
    let pending: Promise<unknown>[] = [];
    let context = {
      URL,
      self: {
        addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
        skipWaiting: () => undefined,
        clients: { claim: async () => undefined },
      },
      caches: {
        keys: async () => [...names],
        delete: async (name: string) => names.delete(name),
      },
    };
    let source = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
    vm.runInNewContext(source, context);

    listeners.get('activate')?.({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
    expect([...names].sort()).toEqual([
      'vibenote-app-shell-v1',
      'vibenote-asset-v1',
      'vibenote/blob-cache/v1',
    ]);
  });
});
