// @vitest-environment node
// Tests for session store persistence.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore } from '../session-store.ts';

describe('session store persistence', () => {
  it('keeps persisting after a failed write, including the change whose write failed', async () => {
    let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibenote-session-store-'));
    let filePath = path.join(dir, 'sessions.json');
    let store = createSessionStore({ filePath, encryptionKey: '0'.repeat(64) });
    await store.init();
    let session = (id: string) => ({
      id,
      userId: 'u',
      login: 'user',
      refreshTokenCiphertext: 'x',
      refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await store.create(session('a'));
    await store.create(session('b'));

    // A directory in place of the temp file makes the next write fail
    await fs.mkdir(`${filePath}.tmp`);
    await expect(store.delete('a')).rejects.toThrow();
    await fs.rmdir(`${filePath}.tmp`);

    await store.delete('b');
    let persisted: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(persisted).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
