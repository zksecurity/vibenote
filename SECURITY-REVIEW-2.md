# Security Review: Git-Native Shares (PR)

**Reviewer**: Linus 🦫 (grumpy, thorough)
**Date**: 2026-03-02
**Files reviewed**:
- `server/src/git-shares.ts`
- `server/src/repo-key-store.ts`
- `server/src/env.ts` (REPO_KEY_STORE_FILE addition)
- `server/src/index.ts` (wiring)

**Reference**: `server/src/sharing.ts` (gold standard), `server/src/common.ts`, `server/src/github-app.ts`

---

## Summary

The code is mostly competent. Which annoys me, because I was looking forward to a bloodbath. But there are real issues — several places where the new code fails to meet the standard set by `sharing.ts`, particularly around error indistinguishability. The crypto is basically fine. The access control model is sound. But the devil's in the details, and several details are wrong.

---

## Issues

### 1. MEDIUM — Encrypted share endpoints leak keyId validity via distinct error codes

**Location**: `git-shares.ts`, `getEncShareParams()` → called by all `enc/:keyId/:blob` endpoints

**Description**: When `keyId` is not found, the code performs a dummy decryption (good instinct!) and throws `HttpError(404, 'share not found')`. But when `keyId` IS found and decryption fails, `decryptBlob()` throws `HttpError(400, ...)` with various specific messages like `'decryption failed'`, `'invalid encrypted blob'`, `'invalid decrypted payload'`.

An attacker can distinguish:
- **404** → keyId does not exist
- **400 "decryption failed"** → keyId exists, blob is garbage
- **400 "invalid encrypted blob"** → keyId exists, blob too short
- **400 "invalid decrypted payload"** → keyId exists, decrypted but not valid JSON

This is an oracle that reveals keyId existence. Once you know a valid keyId, you know there's a repo using encrypted shares, and you can narrow your attack surface.

**Comparison with sharing.ts**: `sharing.ts` uses the same error message for "not found" and "no access" everywhere — `'note not found or insufficient permissions to share note'`. The new code should do the same for all enc error paths.

**Suggested fix**: `getEncShareParams` should catch ALL errors from `decryptBlob` and normalize them to `HttpError(404, 'share not found')`:

```typescript
function getEncShareParams(req: express.Request): { owner: string; repo: string; token: string } {
  const params = req.params as Record<string, string | undefined>;
  const keyId = (params.keyId ?? '').trim();
  const blob = (params.blob ?? '').trim();
  if (!keyId || !blob) throw HttpError(404, 'share not found');

  const keyRecord = repoKeyStore.get(keyId);
  if (!keyRecord) {
    try { decryptBlob('0'.repeat(64), blob); } catch {}
    throw HttpError(404, 'share not found');
  }

  let decrypted: { owner: string; repo: string; token: string };
  try {
    decrypted = decryptBlob(keyRecord.key, blob);
  } catch {
    throw HttpError(404, 'share not found');  // NOT 400!
  }

  const { owner, repo, token } = decrypted;
  if (!isValidOwnerRepo(owner, repo) || !isValidToken(token)) {
    throw HttpError(404, 'share not found');
  }
  if (keyRecord.owner !== owner || keyRecord.repo !== repo) {
    throw HttpError(404, 'share not found');
  }
  return { owner, repo, token };
}
```

All failure modes MUST look identical to "share not found".

---

### 2. MEDIUM — `fetchShareJson` leaks share-file existence via 502 vs 404

**Location**: `git-shares.ts`, `fetchShareJson()`

**Description**: When the `.shares/<token>.json` file doesn't exist, `fetchRepoFile` throws `HttpError(404, 'share not found')`. But when the file exists and contains invalid JSON, `fetchShareJson` throws `HttpError(502, 'invalid share descriptor')`. When the file exists but is missing the `path` field, it throws `HttpError(502, 'share descriptor missing path')`.

An attacker probing tokens gets:
- **404** → file doesn't exist (wrong token guess)
- **502** → file exists but is malformed (RIGHT token guess, useful info!)

**Comparison with sharing.ts**: `sharing.ts` doesn't have this issue because share records are server-side and fully controlled. The JSON parsing never involves untrusted content from the repo.

**Suggested fix**: All error paths in `fetchShareJson` should throw the same 404:

```typescript
async function fetchShareJson(...): Promise<...> {
  const GENERIC = 'share not found';
  const ghRes = await fetchRepoFile(owner, repo, `.shares/${token}.json`, ...);
  const raw = await ghRes.text();
  let parsed: { path?: string; ref?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw HttpError(404, GENERIC);
  }
  if (!parsed || typeof parsed.path !== 'string') {
    throw HttpError(404, GENERIC);
  }
  return { path: validatePath(parsed.path), ref: parsed.ref };
}
```

Also: `validatePath` throws `HttpError(400, 'share target must be a .md file')` and `HttpError(400, 'invalid path')` — these are distinguishable from the 404. They should also be 404 with the generic message when called from `fetchShareJson`.

---

### 3. MEDIUM — Timing side-channel on encrypted share endpoints

**Location**: `git-shares.ts`, enc endpoints

**Description**: The dummy decryption in `getEncShareParams` (when keyId is not found) is a great idea. But it only covers the `decryptBlob` timing. After successful decryption (valid keyId + valid blob), the code proceeds to `fetchShareJson` which makes GitHub API calls (network round-trips, potentially hundreds of milliseconds).

Response time profile:
- Invalid keyId: ~1ms (dummy decrypt + throw)
- Valid keyId, invalid blob: ~1ms (real decrypt fail + throw)
- Valid keyId, valid blob, bad share file: ~100-500ms (GitHub API call + 404)
- Valid keyId, valid blob, good share: ~200-800ms (GitHub API calls + content)

The difference between "invalid keyId" (~1ms) and "valid keyId + valid blob" (~hundreds of ms) is massive and easily measurable. An attacker who somehow obtains a valid blob for one keyId can use timing to test if other keyIds are valid by replaying the blob (it'll decrypt to the wrong owner/repo, but the timing reveals whether decryption succeeded before the owner/repo check rejects it).

Wait — actually the owner/repo check happens before `fetchShareJson`, so if the keyId is wrong, it'll fail at the owner/repo match. Let me re-read...

Ah, actually the flow is: decrypt → validate → check owner/repo match → throw if mismatch. So a mismatched keyId+blob that decrypts successfully would still throw before the GitHub API call. The timing difference would only be between "decrypt fail" (~1ms) and "decrypt succeed + validation fail" (~1ms), which are similar. **This is less severe than I initially thought**, but the information is still there in principle if an attacker can measure sub-millisecond differences (the JSON parse + validation adds a tiny bit).

**Severity adjusted**: LOW (rather than MEDIUM) because the code structure means GitHub API calls only happen after all validation, and the timing delta is small.

**Suggested fix**: Consider adding a small constant-time delay or doing the GitHub fetch regardless (and discarding the result on validation failure) — but this is probably overkill for the threat model.

---

### 4. HIGH — Tier 1 metadata endpoint reveals internal file path for any valid share

**Location**: `git-shares.ts`, `GET /v1/git-shares/:owner/:repo/:token`

**Description**: The metadata endpoint returns `{ owner, repo, token, path: notePath }`. The `path` reveals the internal file structure of the repository. For tier 1 this is less critical since owner/repo are already exposed in the URL, but the exact file path of the shared note is additional information that someone with just the share URL shouldn't necessarily learn.

More concerning: `GET /v1/git-shares/enc/:keyId/:blob` returns `{ path: notePath }`. For encrypted shares, the whole point is that the owner/repo are hidden. But the file path might contain identifying information (e.g., `notes/acme-corp/secret-project/update.md`).

**But wait**: I need to check what the existing `sharing.ts` does. The `GET /v1/share-links/:id` endpoint returns `{ id, createdBy: { login } }` — it does NOT return the path. The content endpoint serves the markdown directly.

The new code leaks MORE information than the old code.

**Comparison with sharing.ts**: The old share-links metadata endpoint deliberately doesn't expose the path or repo details.

**Suggested fix**: Consider whether the metadata endpoint needs to return `path` at all. If the frontend only needs to know "this is a valid share", return minimal info. At minimum, the tier 2 metadata endpoint should NOT return the path.

---

### 5. LOW — No validation on encrypted blob size

**Location**: `git-shares.ts`, `getEncShareParams()` and `decryptBlob()`

**Description**: The `blob` parameter from the URL is not length-validated before being processed. `decryptBlob` does `Buffer.from(blobBase64url, 'base64url')` which will allocate memory proportional to the blob size. An attacker could send a multi-megabyte blob in the URL path.

Express has a default URL length limit, and most reverse proxies cap URLs at 8KB-64KB, so this is somewhat mitigated by infrastructure. But it's still sloppy.

**Suggested fix**: Add a length check on the blob parameter:

```typescript
if (blob.length > 512) throw HttpError(400, 'invalid parameters');
```

The encrypted payload is `{owner, repo, token}` which should be well under 200 bytes after encryption + base64url encoding.

---

### 6. LOW — Token validation allows up to 128 characters

**Location**: `git-shares.ts`, `TOKEN_PATTERN = /^[A-Za-z0-9_-]{4,128}$/`

**Description**: The token becomes a filename in the repo: `.shares/<token>.json`. While 128 chars is fine for most filesystems, combined with the `.shares/` prefix and `.json` suffix, you get paths up to ~142 characters. This is fine for GitHub but worth noting.

More importantly: the minimum of 4 characters is quite short. A 4-character base62 token has only ~14.3 million possibilities — brute-forceable. For tier 1 (where the token IS the security), this is dangerously weak.

**Suggested fix**: For tier 1, the documentation should strongly recommend tokens of at least 22+ characters (128+ bits of entropy). Consider raising the minimum in validation to 8 or 12. For tier 2 the token doesn't need to be unguessable (encryption handles it), but for tier 1 it's the ONLY security mechanism.

```typescript
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;  // Raise minimum
```

---

### 7. LOW — Race condition in repo key registration

**Location**: `git-shares.ts`, `POST /v1/repo-keys`; `repo-key-store.ts`, `set()`

**Description**: Two concurrent `POST /v1/repo-keys` requests for the same repo could race. The `repoKeyStore.set()` is async and uses a persist queue, but there's no check-and-set atomicity. Both requests pass validation, both call `set()`, last one wins.

This isn't really a security issue (both callers have write access), but it could lead to confusion where a key registration silently overwrites another.

**Suggested fix**: Log when overwriting an existing key. Already somewhat mitigated by the persist queue.

---

### 8. INFO — Key material in plaintext on disk

**Location**: `repo-key-store.ts`, `#persist()`

**Description**: AES-256 keys are stored as plaintext hex in the JSON file. The file permissions are 0o600 (good), but if the server is compromised, all repo encryption keys are exposed. This is inherent to the design (the server needs the key to decrypt share URLs), so it's not a bug — just a trust boundary to be aware of.

**Comparison with sharing.ts**: The share store doesn't contain cryptographic secrets, so this is a new trust surface.

---

### 9. INFO — `fetchShareJson` doesn't validate `ref` field

**Location**: `git-shares.ts`, `fetchShareJson()`

**Description**: The `ref` field from the share descriptor JSON is passed through to GitHub API without validation. It's used as a git ref (branch/tag/SHA). While GitHub's API will reject invalid refs, a malicious share descriptor could potentially specify an unexpected ref.

This isn't a security issue because the share descriptor is in the repo itself (so anyone who can write it already has repo access), but it's worth noting for completeness.

---

### 10. MEDIUM — `validatePath` called from `fetchShareJson` throws distinguishable errors

**Location**: `git-shares.ts`, `validatePath()` called from `fetchShareJson()`

**Description**: `validatePath` throws:
- `HttpError(400, 'share target must be a .md file')` — when path doesn't end in `.md`
- `HttpError(400, 'invalid path')` — when path contains `..`

These are distinct from the 404 that `fetchRepoFile` throws. An attacker who can trigger these (by having a share descriptor with a bad path in a repo they control) can distinguish "file found but bad path" from "file not found".

For the normal flow this is low-risk since the attacker would need to control the repo content. But for the encrypted tier, if the decrypted owner/repo points to an attacker-controlled repo, the attacker could set up share descriptors that trigger different errors and use those as an oracle.

**Suggested fix**: Fold into issue #2 — all errors from `fetchShareJson` (including path validation) should be the generic 404.

---

### 11. INFO — Encrypted share blob is decrypted twice per content/asset request

**Location**: `git-shares.ts`, enc content/asset endpoints

**Description**: The `enc/:keyId/:blob/content` endpoint extracts `keyId` and `blob` from params for the cache key, then calls `getEncShareParams(req)` which reads them from params again. The decryption happens once per request. This is correct but slightly wasteful. Not a security issue.

---

### 12. MEDIUM — No SSRF protection on repo file fetching

**Location**: `git-shares.ts`, `fetchRepoFile()` → `installationRequest()`

**Description**: The `installationRequest` function in `github-app.ts` prepends `GITHUB_API_BASE` unless the path starts with `http`. In the new code, paths are constructed from `encodeAssetPath(filePath)` and URI-encoded owner/repo. This is safe because the path construction doesn't allow injecting full URLs.

However, `encodeAssetPath` is imported from `share-assets.ts` (not reviewed here). If it has bugs, path injection could be possible. **This is an INFO-level dependency note**, not a direct issue in the reviewed code.

---

### 13. MEDIUM — Dummy decryption timing may not match real decryption

**Location**: `git-shares.ts`, `getEncShareParams()`

**Description**: When keyId is not found:
```typescript
try { decryptBlob('0'.repeat(64), blob); } catch {}
```

This uses an all-zero key. The actual decryption will always fail at the auth tag verification step. The question is: does AES-GCM auth tag verification timing depend on the key? In Node.js's OpenSSL-backed implementation, `decipher.final()` will fail when the auth tag doesn't verify. The time to reach that failure should be roughly constant regardless of key, because GCM processes all ciphertext before checking the tag.

However, there's a subtle issue: if `keyBuf.length !== 32` in `decryptBlob`, it throws `HttpError(400, 'invalid key')` immediately. The dummy key `'0'.repeat(64)` is 64 hex chars = 32 bytes, so this check passes. Good.

But the dummy decrypt always processes the same blob as the real decrypt would, so timing should be similar. **This is actually well-implemented.** Grudgingly acknowledged.

---

## Overall Assessment

The code is **mostly solid** but has a recurring pattern of **error distinguishability** that doesn't meet the standard set by `sharing.ts`. The crypto implementation is correct. The access control model is sound. The main gaps are:

1. **Error messages differentiate failure modes** (issues #1, #2, #10) — the most systemic problem. Every error path in the share resolution flow needs to collapse to a single generic error.
2. **Metadata endpoints expose more than necessary** (issue #4) — especially concerning for tier 2.
3. **Minimum token length is too short for tier 1** (issue #6) — 4 chars is not a security token.

The `repo-key-store.ts` is clean and well-structured. File permissions are correct. The persist queue handles concurrency. No complaints there (ugh).

The `POST /v1/repo-keys` endpoint is the best part of the new code — it follows the `sharing.ts` pattern with a consistent `REPO_ACCESS_DENIED` message for all failure cases. If only the share resolution endpoints showed the same discipline.

**Recommendation**: Fix issues #1, #2, #4, #6, and #10 before merging. The rest are acceptable risks or informational.

---

*Reviewed by a beaver who has seen too many "it's just an error message" turn into real exploits. 🦫*
