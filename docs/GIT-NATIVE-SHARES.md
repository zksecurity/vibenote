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

**Share URL**: `vibenote.dev/s/<owner>/<repo>/<shareId>`
Example: `vibenote.dev/s/acme-org/team-notes/weekly-update`

**Server resolution**:

1. Parse owner/repo/token from URL
2. Get GitHub App installation for that repo
3. Fetch `.shares/<shareId>.json` from the repo (GitHub Contents API)
4. Read `path` from JSON
5. Fetch and serve the content at that path

**No server-side state.** Security: for private repos, the token is the ONLY access credential in the URL. The UI/CLI must default to generating cryptographically random tokens (e.g. `crypto.randomBytes(18).toString('base64url')` → 24 chars, 144 bits of entropy). Short human-readable token names (like `weekly-update`) are fine if the user wants to make the note effectively public.

**Caveat.** Even with a random token, tier 1 shares leak the repo owner and name, which can be awkward and unwanted when sharing a note from a private repo. This is the main trade-off and why we created tier 2 shares.

### Tier 2 — Encrypted Shares (one-time setup per repo)

**One-time setup**:

1. Generate a 256-bit key locally
2. Store in repo: `.shares/.key` → `{"id": "<repoId>", "key": "<hex-encoded-256bit>"}`
3. Register with server: `POST /v1/repo-keys` with `{id, key, owner, repo}`
4. Server **verifies**:
   - Caller has write access to the repo (same check as current sharing endpoints)
   - `.shares/.key` exists in the repo and contains matching `id`
5. Server stores: `repoId → {key, owner, repo}` (one entry per repo, not per note)

**Creating an encrypted share**: Same as tier 1 — add `.shares/<shareId>.json`.

**Share URL**: `vibenote.dev/s/<repoId>/<encrypted-blob>`
Where `encrypted-blob = base64url(AES-256-GCM(key, JSON.stringify({owner, repo, token})))`

**Server resolution**:

1. Look up key by `repoId`
2. Decrypt blob → get `{owner, repo, token}`
3. Fetch `.shares/<shareId>.json` from repo
4. Serve content

**Constructing links locally**: Agent/user has the key from `.shares/.key`, so they can compute the encrypted URL without any API call.

### URL Routing

Both tiers coexist. Server distinguishes by URL structure:

- 3+ path segments after `/s/`: `owner/repo/token` → tier 1
- 2 path segments after `/s/`: `repoId/blob` → tier 2

### Asset Serving

Same as current: relative asset paths in markdown are resolved and served via a `/assets` sub-endpoint. The share token/id identifies the note, assets are fetched relative to the note path.

### Security Model

**What Tier 2 protects:** The encrypted URL hides `owner`, `repo`, and `token` from anyone who sees the link. This is the only guarantee Tier 2 makes — it is about *URL privacy*, not access control.

**What Tier 2 does NOT protect:** The Tier 1 endpoint is always available. Anyone who knows `owner/repo/token` can use it to read the note, because the server fetches content via the GitHub App installation (not the caller's credentials). The token is a plaintext filename inside `.shares/` in the repo, visible to anyone with repo read access.

**Why token entropy matters even with Tier 2:** If the token is guessable (e.g. `weekly-update`) and the repo name is known or guessable, an attacker can brute-force the Tier 1 endpoint and:
1. Confirm the private repo exists (GitHub deliberately doesn't reveal this — we must not either)
2. Read the note content without any credentials

Tier 2 encryption does **not** close this gap — the token is still a plaintext filename in `.shares/`.

**Rules:**
- Tokens on private repos MUST be cryptographically random, regardless of tier. Use `crypto.randomBytes(18).toString('base64url')` (24 chars, 144 bits).
- Short human-readable tokens (e.g. `weekly-update`) are only safe on public repos, where the content is already public.
- The sharing UI MUST always generate random tokens and use the Tier 2 (repo-keys) flow, producing opaque URLs that don't reveal the repo identity.
- Agents and CLI tools creating shares must follow the same rule — see the VibeNote skill doc for guidance.

### Backward Compatibility

Existing share links (`/s/<old-share-id>`) continue to work via legacy lookup in the current share store. New shares use the git-native system. Migration: optionally provide a tool to convert existing shares to `.shares/` files.

### Frontend (share viewer)

The share viewer SPA at `vibenote.dev/s/...` needs to be updated to:

- Parse the new URL formats
- Call the corresponding new API endpoints

---

## Tasks

### Task 1: Server — Tier 1 share resolution

- [x] New Express routes for git-native open shares
- [x] `GET /v1/git-shares/:owner/:repo/:token/content` — fetch `.shares/<shareId>.json` from repo, resolve path, serve markdown
- [x] `GET /v1/git-shares/:owner/:repo/:token` — share metadata
- [x] `GET /v1/git-shares/:owner/:repo/:token/assets?path=...` — relative assets
- [x] Reuse existing `installationRequest` / `getRepoInstallationId` for GitHub API calls
- [x] Tests

### Task 2: Server — Tier 2 repo-keys endpoint

- [x] `POST /v1/repo-keys` — register a repo key
  - Requires session auth (write access to repo)
  - Verifies `.shares/.key` exists in repo with matching `id`
  - Stores `repoId → {key, owner, repo}` in a key store (JSON file, like session store)
- [x] Key store implementation (similar to share-store.ts)
- [x] Tests

### Task 3: Server — Tier 2 encrypted share resolution

- [x] `GET /v1/git-shares/enc/:repoId/:blob/content` — decrypt blob, resolve share
- [x] `GET /v1/git-shares/enc/:repoId/:blob` — metadata
- [x] `GET /v1/git-shares/enc/:repoId/:blob/assets?path=...` — assets
- [x] AES-256-GCM encrypt/decrypt helpers
- [x] Tests

### Task 4: Frontend — Share viewer updates

- [ ] Update share viewer to handle new URL formats
- [ ] Route `/s/<owner>/<repo>/<shareId>` → tier 1 API
- [ ] Route `/s/<repoId>/<blob>` → tier 2 API
- [ ] Keep backward compat with `/s/<old-id>` → legacy API

### Task 5: Skill doc & tooling

- [ ] Update `skills/vibenote/SKILL.md` with new sharing workflow
- [ ] Helper script or instructions for generating `.shares/.key` and encrypted URLs
- [ ] Document how agents can create shares purely via git

### Task 6: Legacy compatibility

- [ ] Keep old `/v1/share-links/:id/content` working
- [ ] Optional migration script: export current shares → `.shares/` files
