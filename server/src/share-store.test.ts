import { describe, expect, it, beforeEach } from 'vitest';
import { createShareStore } from './share-store';
import fs from 'node:fs/promises';
import path from 'node:path';

const TMP_DIR = path.join(process.cwd(), '.tmp-test');

async function tempFile(name: string): Promise<string> {
  await fs.mkdir(TMP_DIR, { recursive: true });
  return path.join(TMP_DIR, name);
}

describe('share store', () => {
  beforeEach(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  it('creates, retrieves, and disables shares', async () => {
    let file = await tempFile('shares.json');
    let store = createShareStore({ filePath: file });
    await store.init();

    let sample = {
      id: 'share123',
      mode: 'unlisted' as const,
      gistId: 'gist1',
      gistOwner: 'octocat',
      primaryFile: 'note.md',
      primaryEncoding: 'utf8' as const,
      assets: [],
      title: 'Doc',
      createdBy: { userId: 'user1', githubLogin: 'octocat' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isDisabled: false,
      includeAssets: true,
      sourceRepo: 'octo/repo',
      sourcePath: 'docs/doc.md',
      metadata: { noteBytes: 10, assetBytes: 0 },
    };
    await store.create(sample);

    let fetched = store.getById('share123');
    expect(fetched?.title).toBe('Doc');
    expect(fetched?.isDisabled).toBe(false);

    await store.disable('share123');
    let afterDisable = store.getById('share123');
    expect(afterDisable?.isDisabled).toBe(true);
  });
});
