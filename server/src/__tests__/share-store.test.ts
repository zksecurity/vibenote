// Tests for the file-backed ShareStore implementation.
import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createShareStore } from '../share-store.ts';

const SAMPLE = {
  id: 'abc123sample',
  owner: 'octo',
  repo: 'notes',
  branch: 'main',
  path: 'docs/demo.md',
  createdByUserId: 'u1',
  createdByLogin: 'octo-dev',
  installationId: 42,
} as const;

describe('ShareStore', () => {
  let filePath: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'share-store-'));
    filePath = path.join(dir, 'shares.json');
  });

  it('creates, finds, revokes, and persists share records', async () => {
    const store = createShareStore({ filePath });
    await store.init();

    const created = await store.create(SAMPLE);
    expect(created.id).toBe(SAMPLE.id);
    expect(created.status).toBe('active');

    const found = store.findActiveByNote(SAMPLE.owner, SAMPLE.repo, SAMPLE.path);
    expect(found?.id).toBe(SAMPLE.id);

    await store.revoke(SAMPLE.id, { revokedByLogin: 'octo-dev', revokedByUserId: 'u1' });
    expect(store.findActiveByNote(SAMPLE.owner, SAMPLE.repo, SAMPLE.path)).toBeUndefined();

    const reloaded = createShareStore({ filePath });
    await reloaded.init();
    expect(reloaded.get(SAMPLE.id)?.status).toBe('revoked');
    expect(reloaded.findActiveByNote(SAMPLE.owner, SAMPLE.repo, SAMPLE.path)).toBeUndefined();
  });
});
