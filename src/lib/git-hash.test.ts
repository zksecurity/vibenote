// Tests for Git blob SHA computation
import { describe, expect, test } from 'vitest';
import { computeGitBlobSha, computeGitBlobShaFromBase64 } from './git-hash';

describe('computeGitBlobSha', () => {
  // Verified against: echo -n "hello world" | git hash-object --stdin
  test('computes correct sha for "hello world"', async () => {
    let sha = await computeGitBlobSha('hello world');
    expect(sha).toBe('95d09f2b10159347eece71399a7e2e907ea3df4f');
  });

  // Verified against: echo -n "" | git hash-object --stdin
  test('computes correct sha for empty string', async () => {
    let sha = await computeGitBlobSha('');
    expect(sha).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  // Verified against: echo -n "test content with newline\n" | git hash-object --stdin
  test('computes correct sha for content with newline', async () => {
    let sha = await computeGitBlobSha('test content with newline\n');
    expect(sha).toBe('092e47610185fd3a9aa2bef42891dd7356864ce7');
  });

  // Verified against: printf 'hello\x00world' | git hash-object --stdin
  test('computes correct sha for content with null byte', async () => {
    let sha = await computeGitBlobSha('hello\x00world');
    expect(sha).toBe('db12d84d7d09898766cc3d68c37aa7d58f6c3702');
  });

  // UTF-8 multibyte characters: "héllo" has 6 bytes (é is 2 bytes in UTF-8)
  // Verified against: printf 'héllo' | git hash-object --stdin
  test('computes correct sha for UTF-8 multibyte content', async () => {
    let sha = await computeGitBlobSha('héllo');
    expect(sha).toBe('e507eb59f765207ed66c258795260c8bedbee89c');
  });
});

describe('computeGitBlobShaFromBase64', () => {
  // "hello world" in base64 is "aGVsbG8gd29ybGQ="
  test('computes correct sha from base64 content', async () => {
    let sha = await computeGitBlobShaFromBase64('aGVsbG8gd29ybGQ=');
    expect(sha).toBe('95d09f2b10159347eece71399a7e2e907ea3df4f');
  });

  // Empty string in base64 is ""
  test('computes correct sha for empty base64', async () => {
    let sha = await computeGitBlobShaFromBase64('');
    expect(sha).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });
});
