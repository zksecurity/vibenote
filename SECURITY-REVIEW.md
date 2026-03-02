# Security Review: Git-Native Shares

**Reviewer**: Linus 🦫 (grumpy, thorough)
**Date**: 2026-03-02
**Files reviewed**:
- `server/src/git-shares.ts`
- `server/src/repo-key-store.ts`
- `server/src/env.ts` (REPO_KEY_STORE_FILE addition)
- `server/src/index.ts` (wiring)
- Reference: `server/src/sharing.ts`, `server/src/common.ts`, `server/src/github-app.ts`
- Design: `docs/GIT-NATIVE-SHARES.md`

---

## Summary

The code is *reasonably* well-structured. It follows the same patterns as `sharing.ts` in many places. But there are several issues ranging from "defeats the stated security goal" to "you should really know better by now." I found **1 HIGH**, **4 MEDIUM**, and **3 LOW** severity issues, plus some informational notes.

---

## Issues

### 1. HIGH — Tier 2 metadata endpoint leaks decrypted `owner/repo` to share URL holders

**Location**: `git-shares.ts`, `GET /v1/git-shares/enc/:keyId/:blob`

```typescript
res.json({ owner, repo, token, path: notePath });
```

**Description**: The entire point of tier 2 encrypted shares is that the URL hides `owner/repo` — the encrypted blob prevents observers (browser history, link previews, server logs of referrers) from learning which repo the note belongs to. Yet this metadata endpoint hands back the decrypted `owner`, `repo`, and `token` in plaintext JSON.

The design doc's security property states: *"Users without repo access, but with access to the share URL, must not learn ANYTHING apart from the shared note content and what the URL itself reveals."* The URL reveals `keyId` and an opaque blob. This endpoint reveals the full repo identity, violating that property.

**Comparison with `sharing.ts`**: The legacy `GET /v1/share-links/:id` only returns `{ id, createdBy: { login } }` — it does NOT return `owner`, `repo`, or `path`. The new code is strictly worse.

**Suggested fix**: Return only what's needed for the viewer to function. At minimum, omit `owner` and `repo`. If the viewer needs `path` for display, consider whether that also leaks information (the path within the repo could reveal project names, etc.). A safe response would be:

```typescript
res.json({ path: notePath });
// or even just: res.json({ ok: true });
```

If the frontend needs owner/repo for something, reconsider the design — you're undermining your own encryption.

---

### 2. MEDIUM — `POST /v1/repo-keys` distinguishes "repo not found" from "insufficient permissions"

**Location**: `git-shares.ts`, `POST /v1/repo-keys` handler

```typescript
// On installation lookup failure:
throw HttpError(404, 'repository not found or app not installed');

// On permission check failure:
throw HttpError(403, 'insufficient permissions');
```

**Description**: An authenticated user can probe whether a private repo exists (and has the GitHub App installed) by observing the difference between a 404 and a 403. If they get a 403, they know the repo exists and the app is installed, they just lack permissions. If they get a 404, they know either the repo doesn't exist or the app isn't installed.

**Comparison with `sharing.ts`**: The existing code is carefully written to return the **same** 404 message for both cases:

```typescript
// sharing.ts — same message regardless of cause:
throw HttpError(404, 'note not found or insufficient permissions to share note');
```

This is the gold standard. The new code fails to meet it.

**Suggested fix**: Use the same status code and message for both branches:

```typescript
const REPO_ACCESS_DENIED = 'repository not found or insufficient permissions';

// replace both the catch block and the permission check:
try {
  installationId = await getRepoInstallationId(env, owner, repo);
} catch {
  throw HttpError(404, REPO_ACCESS_DENIED);
}

const permission = await fetchCollaboratorPermission(installationId, owner, repo, session.login);
if (permission === null || !hasWritePermission(permission)) {
  throw HttpError(404, REPO_ACCESS_DENIED);  // 404, not 403!
}
```

---

### 3. MEDIUM — `POST /v1/repo-keys` leaks `.shares/.key` existence and format after auth

**Location**: `git-shares.ts`, `POST /v1/repo-keys` handler

```typescript
if (keyFileRes.status === 404) throw HttpError(404, '.shares/.key not found in repository');
// ...
throw HttpError(400, 'invalid .shares/.key format');
// ...
throw HttpError(400, '.shares/.key id does not match');
```

**Description**: After the access check passes, three distinct error messages reveal whether `.shares/.key` exists, whether it's valid JSON, and whether the ID matches. While the caller does have write access at this point (so they *could* check themselves), the server is being unnecessarily chatty. An attacker who compromises a session token with write access to a repo could use these detailed errors to understand the repo's sharing configuration without making any GitHub API calls themselves.

More importantly, this sets a bad precedent. The existing `sharing.ts` avoids distinguishable errors even in authenticated paths.

**Severity note**: This is MEDIUM rather than HIGH because the caller is already authenticated with write access. But the code should still be tighter.

**Suggested fix**: Consolidate to a single error message after the access check:

```typescript
throw HttpError(400, 'repo key setup failed — check that .shares/.key exists and matches');
```

---

### 4. MEDIUM — Tier 1 unauthenticated endpoints leak error cause

**Location**: `git-shares.ts`, `fetchRepoFile`

```typescript
async function fetchRepoFile(...): Promise<Response> {
  let installationId: number;
  try {
    installationId = await getRepoInstallationId(env, owner, repo);
  } catch {
    throw HttpError(404, 'repository not found or app not installed');
  }
  // ...
  if (res.status === 404) throw HttpError(404, 'content not found');
```

**Description**: For tier 1 open shares (`/v1/git-shares/:owner/:repo/:token/content`), the caller already knows `owner` and `repo` from the URL, so leaking repo existence is less damaging. However, the two distinct 404 messages — `'repository not found or app not installed'` vs `'content not found'` — still let an attacker distinguish between "the repo/app setup is wrong" and "the specific token doesn't exist." This helps enumerate valid vs invalid share tokens.

For tier 2, after decryption, the same `fetchRepoFile` is called. The error messages could theoretically help an attacker with a valid key but who's brute-forcing tokens, though the encrypted blob makes this less practical.

**Comparison with `sharing.ts`**: The legacy `getShareRecord` throws a single `'share not found'` for any lookup failure. It never reaches GitHub API with invalid data.

**Suggested fix**: Use a single error message for all 404 cases in the unauthenticated flow:

```typescript
throw HttpError(404, 'share not found');
```

---

### 5. MEDIUM — Token minimum length is 1 character

**Location**: `git-shares.ts`

```typescript
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
```

**Description**: A share token can be as short as a single character. For private repos using tier 1 (open shares), the token is the *only* security credential in the URL. With 63 possible characters and minimum length 1, an attacker could enumerate all single-character tokens with 63 requests. Even 4-character tokens yield only ~16 million combinations — easily brute-forceable.

**Comparison with `sharing.ts`**: The legacy system generates 18 random bytes (144 bits of entropy) and validates with `{10,}` minimum length:

```typescript
// sharing.ts
function isValidShareId(id: string): boolean {
  return /^[A-Za-z0-9_-]{10,}$/.test(id);
}
```

**Suggested fix**: Enforce a minimum length that provides adequate entropy. 16+ characters (96+ bits at ~6 bits/char) would be reasonable:

```typescript
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
```

Yes, this means repo owners can't use cute short token names. Security is more important than aesthetics. Deal with it.

---

### 6. LOW — Timing side-channel on `repoKeyStore.get(keyId)` vs decryption path

**Location**: `git-shares.ts`, `getEncShareParams`

```typescript
const keyRecord = repoKeyStore.get(keyId);
if (!keyRecord) throw HttpError(404, 'key not found');
// ... then proceeds to decrypt ...
```

**Description**: When `keyId` doesn't exist, the response returns immediately. When it does exist, there's AES-256-GCM decryption, JSON parsing, and validation. The timing difference reveals whether a `keyId` is registered. Since `keyId` values are likely short identifiers (validated as `{1,64}` alphanumeric), an attacker could enumerate valid keyIds by measuring response times.

**Practical impact**: Low, since knowing a `keyId` alone doesn't help without the encryption key. But it reveals which repos have encrypted sharing enabled.

**Suggested fix**: Add a constant-time delay or perform a dummy decryption when the key is not found. Or, more practically, just acknowledge this as an accepted risk and document it.

---

### 7. LOW — No `ref` (branch) parameter in `fetchRepoFile`

**Location**: `git-shares.ts`, `fetchRepoFile`

```typescript
`/repos/.../contents/${encodeAssetPath(filePath)}`
// no ?ref= parameter
```

**Description**: Unlike `sharing.ts` which explicitly tracks and uses a `branch` parameter, the new code always fetches from the repo's default branch. This means:

1. If a repo changes its default branch, all existing share URLs break silently
2. Shares can't target non-default branches (draft branches, etc.)
3. There's no way to pin a share to a specific ref for reproducibility

The `.shares/<token>.json` descriptor could include a `ref` field, but it's not currently parsed or used.

**Suggested fix**: Add an optional `ref` field to the share descriptor JSON and pass it to GitHub API calls. Default to the repo's default branch if omitted.

---

### 8. LOW — Encryption key stored as hex in `repo-key-store.ts` with no at-rest encryption

**Location**: `repo-key-store.ts`

**Description**: AES-256 encryption keys are stored as plaintext hex strings in a JSON file. While the file permissions are set to `0o600` (owner read/write only), this means:

1. Any process running as the same user can read all repo keys
2. Backups of this file expose all keys
3. No integration with secret managers or key vaults

**Comparison**: The existing `session-store.ts` uses `SESSION_ENCRYPTION_KEY` for encrypting session data at rest. The repo key store does not encrypt its contents.

**Suggested fix**: Encrypt the key store file using a separate encryption key (similar to how session store works), or at minimum document this as a known limitation and ensure the deployment guide covers file-level encryption / volume encryption.

---

## Informational Notes

### INFO — `fetchRepoFile` error message leaks GitHub API details

**Location**: `git-shares.ts`

```typescript
throw HttpError(502, `github error ${res.status}: ${text}`);
```

In the unauthenticated share-serving paths, a non-404 GitHub error will return the raw GitHub API error text to the caller. This could leak internal details about the GitHub App configuration. Consider returning a generic `'internal error'` message for non-404 failures in unauthenticated paths.

### INFO — No rate limiting on decryption endpoints

The encrypted share endpoints perform AES-256-GCM decryption on every request with no rate limiting. While AES-GCM is fast and this is unlikely to be a practical DoS vector (network I/O dominates), it's worth noting. If you ever add heavier crypto operations, remember this.

### INFO — Cache key for tier 2 includes the full encrypted blob

```typescript
function encCacheKey(keyId: string, blob: string): string {
  return `enc:${keyId}/${blob}`;
}
```

Base64url-encoded encrypted blobs can be long. These are used as Map keys for the asset cache. Not a security issue per se, but could lead to memory pressure if many distinct encrypted URLs are requested. The cache has no size limit.

### INFO — Design observation on tier 1 security model

For tier 1, the security of private repo shares depends entirely on the unguessability of the token chosen by the user/agent. Unlike the legacy system where the server generates cryptographically random IDs, the token is user-chosen. Combined with issue #5 (minimum length of 1), this puts the security burden on the user. The design doc acknowledges this ("the token name must be unguessable if the repo is private, or use tier 2") but the code doesn't enforce it.

---

## What's Actually Good (grudgingly)

- AES-256-GCM usage is correct: 12-byte IV, 16-byte auth tag, 32-byte key. The `iv || ciphertext || authTag` layout is standard.
- Decryption failures are caught and return a generic error (no padding oracle risk with GCM).
- The decrypted `owner/repo` is verified against the registered key record — prevents using a valid key to decrypt blobs meant for a different repo.
- Path traversal prevention (`..` check, `.md` extension requirement, `resolveAssetPath` + allowlist) matches the existing code.
- Asset serving uses the same allowlist pattern as `sharing.ts`.
- Input validation on owner/repo format prevents injection into GitHub API URLs.
- The repo key store uses atomic writes (write to `.tmp`, then rename).
- `handleErrors` wrapping is consistent.

---

## Verdict

The code is *okay* but has a showstopper in issue #1 (tier 2 metadata endpoint defeats its own encryption purpose) and meaningful gaps in error indistinguishability compared to the gold-standard `sharing.ts`. Fix issues #1, #2, and #5 before merging. The rest can be addressed in follow-ups but should be tracked.

Don't ship this until at least the HIGH and the first two MEDIUMs are fixed. I'm watching.

— Linus 🦫
