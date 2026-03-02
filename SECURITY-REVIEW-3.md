# Security Review: Git-Native Shares (PR)

**Reviewer**: Linus 🦫 (grumpy, thorough)
**Date**: 2026-03-02
**Files reviewed**:
- `server/src/git-shares.ts`
- `server/src/repo-key-store.ts`
- `server/src/env.ts` (REPO_KEY_STORE_FILE addition)
- `server/src/index.ts` (wiring)
- `docs/GIT-NATIVE-SHARES.md` (design doc)

**Reference**: `server/src/sharing.ts`, `server/src/common.ts`, `server/src/github-app.ts`, `server/src/share-assets.ts`

---

## Summary

The code is better than I expected, which irritates me. The error indistinguishability patterns are mostly solid, the AES-256-GCM usage is correct, and the path traversal defenses are adequate. But "mostly" and "adequate" aren't good enough for security-critical code. I found one HIGH issue that enables denial-of-service against other users' encrypted shares, and several MEDIUM issues that need attention.

---

## Issues

### GS-01 — HIGH: KeyId collision allows DoS against other users' encrypted shares

**Location**: `git-shares.ts` — `POST /v1/repo-keys` endpoint; `repo-key-store.ts` — `set()` method

**Description**: The `repoKeyStore` uses `id` (the keyId) as the sole map key. Any authenticated user with write access to *any* repo can register a keyId that collides with another user's keyId, overwriting their key record. This silently breaks all existing encrypted share URLs for the victim's repo.

**Attack scenario**:
1. Alice has repo `alice/notes` with `.shares/.key` containing `{"id": "k1"}` and registered key on server
2. Alice's encrypted share URLs use keyId `k1`
3. Bob (who has write access to `bob/stuff`) creates `.shares/.key` with `{"id": "k1"}` in his repo
4. Bob calls `POST /v1/repo-keys` with `{id: "k1", key: <his_key>, owner: "bob", repo: "stuff"}`
5. Server verifies Bob has write access to `bob/stuff`, sees `.shares/.key` with matching id, and **overwrites** Alice's record
6. All of Alice's encrypted share URLs now fail (decryption fails or owner/repo mismatch)

Bob only needs to know Alice's keyId, which is visible in encrypted share URLs (`/s/<keyId>/<blob>`).

**Suggested fix**: Use a composite key for storage, e.g. `${owner}/${repo}` or `${owner}/${repo}/${id}`. Alternatively, reject registration if a record with the same `id` already exists for a *different* owner/repo (allow re-registration for the same repo, which is a key rotation use case). Example:

```typescript
const existing = repoKeyStore.get(id);
if (existing && (existing.owner !== owner || existing.repo !== repo)) {
  throw HttpError(409, 'key id already registered'); // or use REPO_ACCESS_DENIED to avoid leaking
}
```

**Comparison with sharing.ts**: Not applicable — `sharing.ts` generates server-side IDs with `crypto.randomBytes(18)`, making collisions astronomically unlikely. The git-native design lets clients choose the keyId, which is the root cause.

---

### GS-02 — MEDIUM: 502 response on non-404 GitHub errors leaks repo/app existence for unauthenticated tier 2 endpoints

**Location**: `git-shares.ts` — `fetchRepoFile()`, lines:

```typescript
if (!res.ok) {
    throw HttpError(502, 'internal error');
}
```

**Description**: For tier 2 encrypted shares, the owner/repo are supposed to be hidden — that's the whole point of encryption. But if GitHub returns a non-404 error (e.g., 403 rate limit, 500 server error), the response is 502 "internal error" instead of the usual 404 "share not found". This distinguishes between:
- Invalid/non-existent repo → 404 (from `getRepoInstallationId` catch)
- Valid repo, file not found → 404
- Valid repo, GitHub error → 502

An attacker probing with crafted encrypted blobs could observe a 502 and conclude the decrypted owner/repo corresponds to a real repo with the GitHub App installed.

**Exploitability**: Low in practice — requires a transient GitHub error to coincide with the probe. But the principle matters.

**Suggested fix**: Catch all non-404 errors in the unauthenticated code paths and return the same 404 generic error:

```typescript
if (!res.ok) {
    throw HttpError(404, 'share not found');
}
```

Log the actual error server-side for debugging. The authenticated `POST /v1/repo-keys` endpoint can keep 502 since the caller already demonstrated repo access.

**Comparison with sharing.ts**: In `sharing.ts`, content fetching only happens *after* access control verification, so 502s from `fetchShareContent` don't leak information to unauthorized users. The new code fetches content on unauthenticated endpoints, making this a meaningful difference.

---

### GS-03 — MEDIUM: Imperfect timing side-channel mitigation for invalid keyId

**Location**: `git-shares.ts` — `getEncShareParams()`:

```typescript
if (!keyRecord) {
    // Dummy decryption to avoid timing side-channel revealing valid keyIds
    try { decryptBlob('0'.repeat(64), blob); } catch {}
    throw HttpError(404, GENERIC);
}
```

**Description**: The intent is good — performing a dummy decryption when the keyId is not found to make the timing similar. However:

1. The dummy decryption with a zero key will almost always fail at the GCM auth tag verification step. A valid keyId path may succeed in decryption and then proceed to JSON parsing and validation. The timing profiles can differ.
2. On the valid-keyId path, if decryption succeeds, additional work follows: `isValidOwnerRepo`, `isValidToken`, owner/repo comparison against keyRecord, then `fetchShareJson` (a GitHub API call!). The invalid-keyId path does none of this.
3. The overall response time difference between "invalid keyId" (fast: dummy decrypt + throw) and "valid keyId" (slow: real decrypt + GitHub API calls) is substantial and measurable over the network.

**Suggested fix**: The dummy decryption is a decent start but insufficient by itself. Consider:
- Always performing the `fetchShareJson` call (with dummy params) on the invalid-keyId path to equalize timing, OR
- Using a constant-time comparison for keyId lookup (though the Map lookup is the bigger concern), OR
- Accepting that keyIds are semi-public (visible in URLs) and documenting this as a known property rather than pretending they're secret

The third option is probably the most honest. KeyIds aren't secrets — they're in URLs. Timing-probing for valid keyIds reveals less than just observing shared URLs.

**Comparison with sharing.ts**: `sharing.ts` doesn't have this pattern — share IDs are looked up directly with identical 404 responses for missing records, and there's no encryption layer where "keyId validity" is a separate concern.

---

### GS-04 — MEDIUM: No Content-Disposition or Content-Type restriction on served assets

**Location**: `git-shares.ts` — `serveAsset()`:

```typescript
const contentType = ghRes.headers.get('Content-Type') ?? 'application/octet-stream';
```

**Description**: Assets are served with whatever Content-Type GitHub returns. If the asset endpoints are on the same origin as the main application, this enables stored XSS: an attacker with repo write access could commit an SVG with embedded JavaScript or an HTML file, share it via a note that references it, and any viewer of the shared note would execute the script in the app's origin.

The `share-assets.ts` blocks `.html`/`.htm` extensions via `BLOCKED_ASSET_EXTENSIONS`, but does NOT block `.svg` (which can contain `<script>` tags and event handlers). Also, GitHub may return `text/html` content type for non-HTML files in some edge cases.

**Suggested fix**:
1. Add `.svg` to `BLOCKED_ASSET_EXTENSIONS` in `share-assets.ts`, OR
2. Set `Content-Disposition: attachment` on all asset responses, OR
3. Override Content-Type to safe values (e.g., force `image/svg+xml` without `+xml` processing), OR
4. Serve assets from a separate origin/subdomain (best but most work)

**Comparison with sharing.ts**: **Same issue exists in `sharing.ts`** — this is a pre-existing vulnerability, not introduced by this PR. But since we're reviewing, it's worth flagging. Both implementations should be fixed.

---

### GS-05 — LOW: `ref` field from share JSON not type-validated

**Location**: `git-shares.ts` — `fetchShareJson()`:

```typescript
let parsed: { path?: string; ref?: string };
// ...
return { path: sanitized, ref: parsed.ref };
```

**Description**: The `path` field is thoroughly validated (string check, `.md` extension, path traversal). The `ref` field is declared as `string | undefined` in the type annotation but never actually checked to be a string. If a malicious `.shares/<token>.json` contains `"ref": 12345` or `"ref": {"evil": true}`, `parsed.ref` would be a number or object. When passed to `encodeURIComponent(ref)` in `fetchRepoFile`, it would be coerced via `.toString()`, resulting in "12345" or "[object Object]" — likely a 404 from GitHub.

**Impact**: Not exploitable for access control bypass, but sloppy. Type assertions aren't runtime checks.

**Suggested fix**:

```typescript
const ref = typeof parsed.ref === 'string' ? parsed.ref : undefined;
return { path: sanitized, ref };
```

**Comparison with sharing.ts**: `sharing.ts` uses a fixed `branch` from `parseShareBody` with `asTrimmedString()` which properly coerces to empty string for non-strings. Better discipline.

---

### GS-06 — LOW: fetchCollaboratorPermission leaks GitHub error details in authenticated endpoint

**Location**: `git-shares.ts` — `fetchCollaboratorPermission()`:

```typescript
throw HttpError(502, `github error ${res.status}: ${text}`);
```

**Description**: For non-404/403 GitHub errors, the raw GitHub API response body is included in the error message returned to the client. This could contain internal GitHub error details, rate limit information, or other data useful to an attacker.

**Impact**: Low — this only occurs in the authenticated `POST /v1/repo-keys` endpoint, and only for unusual GitHub API errors. But it's still information leakage.

**Suggested fix**: Log the full error server-side and return a generic message:

```typescript
console.error(`[vibenote] github collaborator check error: ${res.status} ${text}`);
throw HttpError(502, 'internal error');
```

**Comparison with sharing.ts**: `sharing.ts` has the **exact same pattern** in its `fetchCollaboratorPermission`. Consistent, but consistently mediocre.

---

### GS-07 — LOW: No rate limiting on unauthenticated share resolution endpoints

**Location**: All `GET /v1/git-shares/...` endpoints

**Description**: The tier 1 and tier 2 share resolution endpoints are unauthenticated and have no rate limiting. While the token space is large (base64url, 4-128 chars), short tokens (4 chars = ~16M possibilities) could be brute-forced. More importantly, each failed request triggers a GitHub API call (`getRepoInstallationId`), which could exhaust the GitHub App's rate limit.

**Suggested fix**: Add rate limiting per IP on the share resolution endpoints. Even a generous limit (100 req/min) would prevent automated scanning while allowing legitimate use.

**Comparison with sharing.ts**: Same lack of rate limiting on `GET /v1/share-links/:id/content`. Pre-existing gap, but the git-native design makes it more relevant because tokens can be shorter and user-chosen rather than `crypto.randomBytes(18)`.

---

### GS-08 — INFO: Key material stored at rest in plaintext JSON

**Location**: `repo-key-store.ts` — `#persist()` method

**Description**: AES-256 encryption keys are stored in a JSON file on disk in plaintext hex. The file has restrictive permissions (`0o600`), which is appropriate, but if the server's filesystem is compromised, all tier 2 encryption keys are exposed, allowing decryption of all encrypted share URLs.

**Impact**: This is inherent to the architecture — the server needs the key to decrypt blobs. Noting for completeness.

**Suggested fix**: Consider encrypting the key store file at rest using the existing `SESSION_ENCRYPTION_KEY` pattern (or a dedicated key). This adds defense-in-depth: a filesystem read (e.g., via an unrelated path traversal vulnerability) wouldn't directly yield the encryption keys.

**Comparison with sharing.ts**: `sharing.ts` uses `share-store.ts` which stores `owner/repo/path` in plaintext too — but those aren't cryptographic secrets. `session-store.ts` encrypts sensitive session data. The key store should follow the session store's example.

---

### GS-09 — INFO: No verification that POST /v1/repo-keys key matches .shares/.key content

**Location**: `git-shares.ts` — `POST /v1/repo-keys`:

```typescript
if (!keyFileContent || keyFileContent.id !== id) {
    throw HttpError(404, REPO_ACCESS_DENIED);
}
```

**Description**: The server verifies that `.shares/.key` exists and its `id` matches the request, but does NOT verify that the `key` field in `.shares/.key` matches the `key` in the POST body. A user with write access could register a different key than what's in the repo.

**Impact**: Not exploitable — the user already has write access, and the registered owner/repo are checked during decryption. At worst, this causes their own encrypted URLs to not work (if they register a key different from what the client uses to encrypt).

**Suggested fix**: Optionally verify `keyFileContent.key === key` for consistency. However, there's also an argument that the server shouldn't read the key from the repo at all (the key only needs to be in the POST body). The `.shares/.key` check is really just an authorization ceremony.

---

## Verified Security Properties ✓

To be grudgingly fair, these things are done correctly:

1. **Path information not leaked from metadata endpoints**: Tier 1 metadata returns `{ owner, repo, token }` (all already in URL). Tier 2 metadata returns `{ ok: true }`. The internal `path` from `.shares/<token>.json` is never exposed to clients. ✓

2. **Error indistinguishability on POST /v1/repo-keys**: All failure modes (no installation, no permission, no .key file, parse error, id mismatch) return the same `404 "repository not found or insufficient permissions"`. This matches the pattern from `sharing.ts`. ✓

3. **AES-256-GCM usage**: 12-byte IV ✓, 16-byte auth tag ✓, 32-byte key ✓, proper use of `createDecipheriv` with `setAuthTag` ✓. The IV is prepended and auth tag appended in the standard `iv || ciphertext || tag` layout. ✓

4. **Decrypted owner/repo verified against key record**: `getEncShareParams` checks `keyRecord.owner !== owner || keyRecord.repo !== repo` after decryption, preventing an attacker from crafting a blob that points to a different repo than what the key was registered for. ✓

5. **Path traversal prevention**: Token validated with `[A-Za-z0-9_-]` regex (no slashes/dots). Path from share JSON checked for `..`, stripped of leading slashes, backslashes converted, `.md` extension enforced. Asset paths resolved through `resolveAssetPath` with normalization and `../` rejection. ✓

6. **Input validation**: Owner/repo validated with `[A-Za-z0-9._-]{1,100}`. Token validated with `[A-Za-z0-9_-]{4,128}`. Key id validated with `[A-Za-z0-9_-]{1,64}`. Key validated as 64 hex chars. ✓

7. **No auth required for share reading**: The unguessable URL is the credential. Tier 1 requires knowing owner/repo/token. Tier 2 requires knowing keyId and having a validly encrypted blob (which requires the key). ✓

8. **Encrypted share error indistinguishability**: `getEncShareParams` catches all `decryptBlob` errors and returns generic "share not found". Invalid keyId, decryption failure, invalid payload, owner/repo mismatch — all return the same 404. ✓

---

## Recommendations Summary

| ID | Severity | Summary | Effort |
|----|----------|---------|--------|
| GS-01 | HIGH | KeyId collision enables DoS against other users' shares | Small — add uniqueness check |
| GS-02 | MEDIUM | 502 vs 404 leaks repo existence on tier 2 endpoints | Small — map non-404 to 404 |
| GS-03 | MEDIUM | Timing side-channel on keyId validity | Medium — document or equalize |
| GS-04 | MEDIUM | SVG/XSS via asset Content-Type pass-through | Small — block SVG or add CSP |
| GS-05 | LOW | `ref` field not type-checked | Tiny |
| GS-06 | LOW | GitHub error details leaked in 502 responses | Tiny |
| GS-07 | LOW | No rate limiting on unauthenticated endpoints | Medium |
| GS-08 | INFO | Key material plaintext at rest | Medium |
| GS-09 | INFO | Key not verified against .shares/.key content | Tiny |

**Blocking for merge**: GS-01 (HIGH), GS-02 (MEDIUM)
**Should fix before production**: GS-03, GS-04, GS-05, GS-06
**Nice to have**: GS-07, GS-08, GS-09

---

*Grudging acknowledgment: the code is well-structured, follows the patterns from `sharing.ts` reasonably well, and the encrypted share design is sound. The error message discipline is good — much better than most code I review. But "better than most" is a low bar. Fix GS-01 and GS-02 before merging.*
