# Git-Native Shares — Design & Task Tracker

## Overview

Replace server-side share storage with git-native `.shares/` folder in each repo.
Two tiers: open (no API needed) and encrypted (one-time API setup per repo).

## Design

### Tier 1 — Open Shares (pure git)

**Creating a share**: Add a JSON file to `.shares/` in the repo:

```
.shares/weekly-update.json → {"path": "notes/weekly-update.md"}
```

The filename (minus `.json`) becomes the token / URL slug.

**Share URL**: `vibenote.dev/s/<owner>/<repo>/<token>`
Example: `vibenote.dev/s/acme-org/team-notes/weekly-update`

**Server resolution**:
1. Parse owner/repo/token from URL
2. Get GitHub App installation for that repo
3. Fetch `.shares/<token>.json` from the repo (GitHub Contents API)
4. Read `path` from JSON
5. Fetch and serve the content at that path

**No server-side state.** Security: the token name must be unguessable if the repo is private, or use tier 2.

### Tier 2 — Encrypted Shares (one-time setup per repo)

**One-time setup**:
1. Generate a 256-bit key locally
2. Store in repo: `.shares/.key` → `{"id": "<keyId>", "key": "<hex-encoded-256bit>"}`
3. Register with server: `POST /v1/repo-keys` with `{id, key, owner, repo}`
4. Server **verifies**:
   - Caller has write access to the repo (same check as current sharing endpoints)
   - `.shares/.key` exists in the repo and contains matching `id`
5. Server stores: `keyId → {key, owner, repo}` (one entry per repo, not per note)

**Creating an encrypted share**: Same as tier 1 — add `.shares/<token>.json`.

**Share URL**: `vibenote.dev/s/<keyId>/<encrypted-blob>`
Where `encrypted-blob = base64url(AES-256-GCM(key, JSON.stringify({owner, repo, token})))`

**Server resolution**:
1. Look up key by `keyId`
2. Decrypt blob → get `{owner, repo, token}`
3. Fetch `.shares/<token>.json` from repo
4. Serve content

**Constructing links locally**: Agent/user has the key from `.shares/.key`, so they can compute the encrypted URL without any API call.

### URL Routing

Both tiers coexist. Server distinguishes by URL structure:
- 3+ path segments after `/s/`: `owner/repo/token` → tier 1
- 2 path segments after `/s/`: `keyId/blob` → tier 2

### Asset Serving

Same as current: relative asset paths in markdown are resolved and served via a `/assets` sub-endpoint. The share token/id identifies the note, assets are fetched relative to the note path.

### Backward Compatibility

Existing share links (`/s/<old-share-id>`) continue to work via legacy lookup in the current share store. New shares use the git-native system. Migration: optionally provide a tool to convert existing shares to `.shares/` files.

### Frontend (share viewer)

The share viewer SPA at `vibenote.dev/s/...` needs to be updated to:
- Parse the new URL formats
- Call the corresponding new API endpoints

---

## Tasks

### Task 1: Server — Tier 1 share resolution
- [ ] New Express routes for git-native open shares
- [ ] `GET /v1/git-shares/:owner/:repo/:token/content` — fetch `.shares/<token>.json` from repo, resolve path, serve markdown
- [ ] `GET /v1/git-shares/:owner/:repo/:token` — share metadata
- [ ] `GET /v1/git-shares/:owner/:repo/:token/assets?path=...` — relative assets
- [ ] Reuse existing `installationRequest` / `getRepoInstallationId` for GitHub API calls
- [ ] Tests

### Task 2: Server — Tier 2 repo-keys endpoint
- [ ] `POST /v1/repo-keys` — register a repo key
  - Requires session auth (write access to repo)
  - Verifies `.shares/.key` exists in repo with matching `id`
  - Stores `keyId → {key, owner, repo}` in a key store (JSON file, like session store)
- [ ] Key store implementation (similar to share-store.ts)
- [ ] Tests

### Task 3: Server — Tier 2 encrypted share resolution
- [ ] `GET /v1/git-shares/enc/:keyId/:blob/content` — decrypt blob, resolve share
- [ ] `GET /v1/git-shares/enc/:keyId/:blob` — metadata
- [ ] `GET /v1/git-shares/enc/:keyId/:blob/assets?path=...` — assets
- [ ] AES-256-GCM encrypt/decrypt helpers
- [ ] Tests

### Task 4: Frontend — Share viewer updates
- [ ] Update share viewer to handle new URL formats
- [ ] Route `/s/<owner>/<repo>/<token>` → tier 1 API
- [ ] Route `/s/<keyId>/<blob>` → tier 2 API
- [ ] Keep backward compat with `/s/<old-id>` → legacy API

### Task 5: Skill doc & tooling
- [ ] Update `skills/vibenote/SKILL.md` with new sharing workflow
- [ ] Helper script or instructions for generating `.shares/.key` and encrypted URLs
- [ ] Document how agents can create shares purely via git

### Task 6: Legacy compatibility
- [ ] Keep old `/v1/share-links/:id/content` working
- [ ] Optional migration script: export current shares → `.shares/` files
