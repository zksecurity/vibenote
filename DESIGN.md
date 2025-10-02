# VibeNote – Design

This document captures the core architecture, sync logic, and decisions so another LLM can continue the work confidently.

## Goals

- Alternative frontend for GitHub (and other Git hosts) that feels like a modern notes app.
- Offline‑first: edits are immediate, stored in the browser, and resilient to connectivity issues.
- Git as the source of truth: notes are Markdown files in a repo; history remains reviewable via normal Git.
- Conflict‑tolerant: use Y.js (CRDT) to merge plain text in a user‑friendly way.
- No persistent server initially; later we can add a tiny server for auth/webhooks if needed.

## High‑level Architecture

- UI: React + TypeScript + Vite, SPA, mobile‑friendly.
- Merge: Y.js is used for three‑way merges during sync. The in‑app editor is a simple controlled textarea (non‑collaborative); Markdown text is the canonical content persisted locally and pushed to Git.
- Storage:
  - Local: localStorage for MVP (swap to IndexedDB later via `idb-keyval` or `y-indexeddb`).
  - Remote: GitHub REST API (contents + commits) invoked directly from the client using the stored OAuth token.
  - Sync:
  - Optimistic apply: edit the plain text and persist to local storage immediately.
  - Manual `Sync now` trigger today; background sync loop is still planned.
  - Merge strategy: pull remote md, use a Y.js‑backed three‑way merge (ephemeral Y.Doc/Y.Text in memory) to converge local and remote, export md, commit the result. (See “Merge with Y.js” below.)

## Repository Layout

- Notes live at the repository root.
- One note per Markdown file, `<slug>.md`.
- Seeds a README explaining VibeNote when creating a new repo and skips it from the note list.
  - TODO this is currently not working
- Future work can add an index/metadata file when ordering/custom attributes are needed.

## Identity & Auth

- GitHub App user-to-server OAuth provides least-privilege access limited to repos the installer selects.
- Backend responsibilities:
  - Exchange OAuth authorization codes for access + refresh tokens.
  - Store refresh tokens encrypted on disk (`SESSION_ENCRYPTION_KEY`), rotate them on every refresh, and return the new short-lived access token to the browser.
  - Serve `/v1/auth/github/*` endpoints for login, refresh, logout, install/setup redirects, and basic health checks.
  - Never touch repository contents; all GitHub REST calls originate from the browser with the user token.
- Client flow:
  1. User installs the GitHub App (selecting repos or “all repos”).
  2. Popup returns a signed session JWT plus short-lived access token via `postMessage`.
  3. The SPA stores the session token + access-token expiry metadata and issues GitHub REST requests directly.
  4. When the access token is near expiry or GitHub returns 401, the SPA calls `/v1/auth/github/refresh` to obtain a fresh token.
- Security notes:
  - Refresh tokens are encrypted at rest; delete `sessions.json` (or rotate `SESSION_ENCRYPTION_KEY`) to revoke all sessions.
  - No GitHub App private key is stored server-side; compromising the backend without refresh tokens grants no repo access.
  - Rate limits: minimise redundant GitHub calls, cache read responses, and treat 403 “abuse detection” responses as soft-failures with retry backoff.

## Merge with Y.js

- Merge engine (during sync):
  - Create an ephemeral `Y.Doc` and `Y.Text` instances for base, ours (local), and theirs (remote).
  - Use Y.js to converge concurrent insertions/deletions deterministically and export the merged Markdown string.
  - This CRDT state lives only for the duration of the merge; nothing CRDT‑related is persisted.
  - The repository still stores Markdown (not CRDT ops).

## Sync Algorithm (MVP)

1. On app load:
   - Instantiate `LocalStore`, which seeds a welcome note if none exist and materialises the local index from `localStorage`.
   - Load the saved session token and access-token metadata (`vibenote:sessionToken`, `vibenote:app-access-token`) plus remote config (`vibenote:config`).
2. Editing a note:
   - Apply the edit to the plain text and immediately persist the new Markdown to `localStorage`.
   - `LocalStore` updates `updatedAt` and leaves tombstones when notes are deleted or renamed.
3. Sync (Manual for now):
   - User clicks “Sync now”, which calls `syncBidirectional(LocalStore)`.
   - For each remote file, pull contents and compare against local `lastRemoteSha`/`lastSyncedHash`.
   - Merge diverged notes via Y.js three-way merge, upload changes with `PUT /contents`, and update sync metadata.
   - Push local deletes/renames using tombstones, and restore remote deletes when local edits exist.
   - Background polling remains on the roadmap so manual sync becomes an escape hatch rather than the primary path.

Notes:

- Batch commits: we can aggregate multiple note updates into one commit per sync window.
- Conflict policy: the Y.js merge engine decides; no manual three‑way textual conflict markers.
- If remote changed but merge produces identical text, skip committing.

## Git Operations

`src/sync/git-sync.ts` now talks to the GitHub Git Data API directly from the browser:

- `configureRemote` persists `{ owner, repo, branch }` in `localStorage`.
- `pullNote`, `listNoteFiles`, and `fetchBlob` fetch via REST using the short-lived user token (with public fallbacks).
- `commitBatch`, `putFile`, and `deleteFiles` build trees/commits client-side and update refs with the same token.
- `syncBidirectional` mediates merges, handles local tombstones, restores remote deletions when needed, and records per-note sync hashes.

Future options still include moving to GraphQL/tree APIs for scale or introducing a proxy for organisations that disallow browser-side tokens.

## Local Storage Format (MVP)

Key namespace: `vibenote:*`

- `vibenote:gh-token` – GitHub OAuth access token (device flow output).
- `vibenote:config` – JSON: `{ owner, repo, branch }`.
- `vibenote:index` – JSON list: `[{ id, path, title, dir, updatedAt }]`.
- `vibenote:note:<id>` – JSON: `{ id, path, title, dir, text, updatedAt, lastRemoteSha, lastSyncedHash }`.
- `vibenote:folders` – JSON list of folder paths (e.g., `['a', 'a/b']`).
- `vibenote:tombstones` – Array of delete/rename markers used to reconcile remote deletions safely.

## UI Outline

- Header: repo selector (owner/repo/branch), sync status (idle/syncing/error).
- Sidebar: collapsible folder tree with notes; keyboard actions (F2 rename, Del delete). README.md is ignored only at repo root; nested README.md are notes.
- Editor: minimal Markdown editor (textarea).
- Mobile: sidebar overlays; editor is primary.

## Error Handling & Resilience

- Offline: no remote calls, local edits continue.
- Token invalid: show a subtle banner; continue offline.
- Merge failure: unlikely with the Y.js merge engine; if a remote file is deleted, confirm recreate.
- Sign out clears the token/config, resets local notes to the welcome state, and removes tombstones.

## Security

- Device Flow tokens are long-lived bearer tokens stored in `localStorage`. This is acceptable for personal usage but not ideal for multi-device teams; document risks clearly and provide sign-out.
- Serverless proxies keep the OAuth Client ID server-side and avoid exposing user tokens beyond the browser.
- Roadmap includes GitHub App mode to replace bearer tokens with short-lived installation tokens and potentially move sync calls behind a backend proxy.

## Testing & Dev

- Unit test small utilities; E2E later.
- Keep code ESM + TS, zero exotic tooling.

## Roadmap

- [x] Wire GitHub REST API for real pull/commit
- [ ] Switch to IndexedDB for local storage
- [x] Automatic background sync loop (manual “Sync now” remains as manual override)
- [ ] Better editor (CodeMirror + y-codemirror)
- [ ] Presence & collaboration (y-webrtc or y-websocket)
- [ ] Repository browser (folders, images)
- [ ] GitHub App mode (selected repos, least-privilege permissions, short-lived installation tokens)

### Repo rename handling (future)

If a repository is renamed on GitHub, the app should detect it and offer a guided update:

- Detection: calls to `GET /repos/{owner}/{repo}` or Contents API may return redirect/moved semantics or 404 with a URL hint. When we see a mismatch, prompt the user.
- UX: show a dialog to update the slug to the new `owner/repo`. Keep local notes under the same namespace until confirmed, then migrate the namespace keys to the new slug.
- Safety: no data loss; only rename the local namespace and update recents/linked markers. Remote sync continues with the new slug after confirmation.
