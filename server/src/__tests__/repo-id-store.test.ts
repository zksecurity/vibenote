// @vitest-environment node
// Tests for repo id store persistence.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRepoIdStore } from '../repo-id-store.ts';

describe('repo id store', () => {
  it('only keeps a binding once it is persisted, so a retry persists it', async () => {
    let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibenote-repo-id-store-'));
    let filePath = path.join(dir, 'repo-ids.json');
    let store = createRepoIdStore({ filePath });
    await store.init();
    let record = { repoId: 'AAAAAAAAAAA', owner: 'o', repo: 'r', githubRepoId: 1, registeredAt: 'now' };

    // A directory in place of the temp file makes the write fail
    await fs.mkdir(`${filePath}.tmp`);
    await expect(store.set(record)).rejects.toThrow();
    expect(store.get(record.repoId)).toBeUndefined();
    expect(store.getByRepo('o', 'r')).toBeUndefined();

    await fs.rmdir(`${filePath}.tmp`);
    await store.set(record);
    let persisted: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(persisted).toEqual({ records: [record] });
    await fs.rm(dir, { recursive: true, force: true });
  });
});
