# Git-Native Shares — Design & Task Tracker

## Overview

Replace server-side share storage with git-native `.shares/` folder in each repo.
Two tiers: open (no API needed) and opaque (one-time API setup per repo).

## Design

### Tier 1 — Open Shares (pure git)

**Creating a share**: Add a plain-text file to `.shares/` in the repo:

```
.shares/weekly-update → notes/weekly-update.md
```

The filename becomes the shareId / URL slug. The file content is just the note path — no JSON wrapper.

**Share URL**: `vibenote.dev/s/<owner>/<repo>/<shareId>`
Example: `vibenote.dev/s/acme-org/team-notes/weekly-update`

**Server resolution**:

1. Parse owner/repo/shareId from URL
2. Get GitHub App installation for that repo
3. Fetch `.shares/<shareId>` from the repo (GitHub Contents API)
4. Read the file content as the note path (plain text)
5. Fetch and serve the content at that path

**No server-side state.** Security: for private repos, the shareId is the ONLY access credential in the URL. The UI/CLI must default to generating cryptographically random shareIds (e.g. `crypto.randomBytes(16).toString('base64url')` → 22 chars, 128 bits of entropy). Short human-readable names (like `weekly-update`) are fine if the user wants to make the note effectively public.

**Caveat.** Even with a random shareId, tier 1 shares leak the repo owner and name, which can be awkward and unwanted when sharing a note from a private repo. This is the main trade-off and why we created tier 2 shares.

### Tier 2 — Opaque Shares (one-time setup per repo)

**One-time setup**:

1. Generate a random repoId locally: `crypto.randomBytes(8).toString('base64url')` (11 chars)
2. Store in repo: `.shares/.repo-id` → the raw repoId string (11-char base64url, no JSON)
3. Register with server: `POST /v1/repo-id` with `{repoId, owner, repo}`
4. Server **verifies**:
   - Caller has write access to the repo (same check as current sharing endpoints)
   - `.shares/.repo-id` exists in the repo and contains matching `repoId`
5. Server stores: `repoId → {owner, repo}` (one entry per repo, not per note)

**Creating an opaque share**: Same as tier 1 — add `.shares/<shareId>`. Generate a random shareId: `crypto.randomBytes(16).toString('base64url')` (22 chars, 128 bits).

**Share URL**: `vibenote.dev/s/<segment>`
Where `segment = base64url(repoId_bytes[8] || shareId_bytes[16])` — a single 32-char opaque string.

**Server resolution**:

1. Decode segment (24 bytes): first 8 bytes → repoId, last 16 bytes → shareId
2. Look up repoId → get owner/repo
3. Fetch `.shares/<shareId>.json` from repo
4. Serve content

**Constructing links locally**: The client has the repoId (from `.shares/.repo-id`) and generates a random shareId. The opaque URL segment can be computed without any server round-trip.

**Caveat.** This system of constructing opaque URLs lets you correlate that two shares come from the same repo. We think this is fine for the use case and accepted it as a deliberate trade-off in return for simplicity and small server state.

### URL Routing

Both tiers coexist. Server distinguishes by Express route segment count:

- 3 path segments after `/v1/git-shares/`: `owner/repo/shareId` → tier 1
- 1 path segment after `/v1/git-shares/`: `<opaque segment>` → tier 2

### Asset Serving

Same as current: relative asset paths in markdown are resolved and served via an `/assets` sub-endpoint. The shareId identifies the note; assets are fetched relative to the note path.

### Security Model

**What Tier 2 protects:** The opaque URL hides `owner`, `repo`, and `shareId` from anyone who sees the link. This is purely _URL privacy_ — it does not add access control beyond what the shareId entropy already provides.

**What Tier 2 does NOT protect:** The Tier 1 endpoint is always available to anyone who knows `owner/repo/shareId`. The shareId is a plaintext filename inside `.shares/` in the repo, visible to anyone with repo read access.

**Why shareId entropy matters even with Tier 2:** If the shareId is guessable (e.g. `weekly-update`) and the repo name is known or guessable, an attacker can brute-force the Tier 1 endpoint and:

1. Confirm the private repo exists (GitHub deliberately doesn't reveal this — we must not either)
2. Read the note content without any credentials

**Rules:**

- ShareIds on private repos MUST be cryptographically random, regardless of tier. Use `crypto.randomBytes(16).toString('base64url')` (22 chars, 128 bits).
- Short human-readable shareIds (e.g. `weekly-update`) are only safe on public repos, where the content is already public.
- The sharing UI MUST always generate random shareIds and use the Tier 2 (opaque URL) flow.
- Agents and CLI tools creating shares must follow the same rule — see the VibeNote skill doc for guidance.

### No Backward Compatibility

We do not intend existing share links (`/s/<old-share-id>`) to continue to work after the code refactor is complete. No migration/backwards-compat path should be added. Instead, we first roll out new server endpoints next to the old ones, and at one point will just switch the UI to the new endpoints and remove the old ones entirely.

### Frontend (share viewer)

The share viewer SPA at `vibenote.dev/s/...` needs to be updated to:

- Parse the new URL formats
- Call the corresponding new API endpoints

---

## Tasks

### Task 1: Server — Tier 1 share resolution

- [x] New Express routes for git-native open shares
- [x] `GET /v1/git-shares/:owner/:repo/:shareId/content` — fetch `.shares/<shareId>` from repo, resolve path, serve markdown
- [x] `GET /v1/git-shares/:owner/:repo/:shareId` — share metadata
- [x] `GET /v1/git-shares/:owner/:repo/:shareId/assets?path=...` — relative assets
- [x] Reuse existing `installationRequest` / `getRepoInstallationId` for GitHub API calls
- [x] Tests

### Task 2: Server — Tier 2 repo ID registration endpoint

- [x] `POST /v1/repo-id` — register a repoId for a repo
  - Requires session auth (write access to repo)
  - Verifies `.shares/.repo-id` exists in repo and contains matching `repoId`
  - Stores `repoId → {owner, repo}` in a key store (JSON file, like session store)
- [x] Key store implementation (similar to share-store.ts)
- [x] Tests

### Task 3: Server — Tier 2 opaque share resolution

- [x] `GET /v1/git-shares/:segment/content` — decode segment, resolve share
- [x] `GET /v1/git-shares/:segment` — metadata
- [x] `GET /v1/git-shares/:segment/assets?path=...` — assets
- [x] Tests

### Task 4: Agent-friendly repo ID registration

`POST /v1/repo-id` requires no authentication. Proof of write access is the presence of
`.shares/.repo-id` in the repo with matching content, verified server-side via the GitHub App
installation token. Only someone who could push that file can pass the check.
After registration, the entire share-creation flow is pure git — no further API calls needed.

- [x] Remove session auth requirement from `POST /v1/repo-id`
- [x] `.shares/.repo-id` file verification is the sole access proof
- [x] Tests

### Task 5: Refactor `.shares` file format

Replace the JSON share descriptor with a plain-text file containing just the note path.
Simpler for agents and humans to create — `echo "notes/foo.md" > .shares/<shareId>`.

- [x] Server: fetch `.shares/<shareId>` (no `.json` extension) and read content as the path directly
- [x] Drop the `ref` field (was JSON-only; always serve latest)
- [x] Update tests
- [x] Migrate existing `.shares/*.json` files in the repo

### Task 6: Frontend — Share viewer updates

- [ ] Update share viewer to handle new URL formats
- [ ] Route `/s/<owner>/<repo>/<shareId>` → tier 1 API
- [ ] Route `/s/<segment>` → tier 2 API
- [ ] Delete legacy API which is no longer supported by the UI

### Task 7: Skill doc & tooling

- [ ] Update `skills/vibenote/SKILL.md` with new sharing workflow
- [ ] Helper script or instructions for generating `.shares/.repo-id` and opaque URLs
- [ ] Document how agents can create shares purely via git
