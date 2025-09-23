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
- CRDT: Y.js with a Y.Text per note; markdown text is the canonical content from/to Git.
- Storage:
  - Local: localStorage for MVP (swap to IndexedDB later via `idb-keyval` or `y-indexeddb`).
  - Remote: GitHub REST API (contents + commits) invoked directly from the client using the stored OAuth token.
  - Sync:
  - Optimistic apply to local CRDT + persist to local storage immediately.
  - Manual `Sync now` trigger today; background sync loop is still planned.
  - Merge strategy: pull remote md, import both local and remote into Y.Text, use Y.js to converge, export md, commit the result. (See “CRDT merge with plain text” below.)

## Repository Layout

- Notes live at the repository root by default (configurable via `notesDir`).
- One note per Markdown file, `<slug>.md`.
- `RepoConfigModal` seeds a README explaining VibeNote when creating a new repo and skips it from the note list.
- Future work can add an index/metadata file when ordering/custom attributes are needed.

## Identity & Auth

- MVP: GitHub Device Authorization Flow. The UI requests a device code via serverless proxy (`api/github/device-code`), polls `api/github/device-token` for the access token, and stores it in `localStorage` under `vibenote:gh-token`.
- Serverless functions (deployed on Vercel) keep the OAuth Client ID secret and avoid browser CORS issues.
- Future: GitHub App mode for least-privilege access (see below) or a refined OAuth flow that avoids storing long-lived tokens client-side.

## GitHub App (Future Option)

Goal: least‑privilege access limited to user‑selected repositories, cleaner consent for private notes, and short‑lived tokens.

- Why a GitHub App:

  - Users select specific repositories at install time (or “all repos”).
  - Permissions are fine‑grained (e.g., Repository contents: Read & write, Metadata: Read).
  - Installation access tokens are short‑lived and scoped to the selected repos only.

- Proposed permissions (initial):

  - Repository contents: Read & write
  - Metadata: Read
  - Avoid Administration (repo creation) to keep consent light; ask users to create a repo manually when needed.

- Backend responsibilities (tiny service or Vercel Functions):

  - Sign an app JWT using the app’s private key.
  - Exchange for an installation access token for a given installation (and optional repo).
  - Optionally proxy GitHub Contents API (read/write) using the installation token to avoid exposing it to the client.

- Client flow (GitHub App mode):

  1. User installs the GitHub App and selects one or more repos.
  2. Client stores minimal identifiers (installation id, owner/repo) — no long‑lived user tokens.
  3. For sync, client calls backend: `POST /api/app/token { installationId, owner, repo }` or directly `POST /api/contents` with the desired operation; backend uses short‑lived installation token.

- Migration strategy:

  - Keep OAuth Device Flow as “Quick start”.
  - Add an “Advanced: GitHub App” option in repo settings.
  - If App mode is selected, disable user tokens and route all sync via backend using installation tokens.
  - Document that private repos remain the default for personal notes; App mode still supports private repos with least privilege.

- Webhooks (optional):

  - Subscribe to push events for selected repos to signal the client that new commits exist, enabling smarter pull/merge prompts.

- Security notes:
  - Installation tokens are short‑lived; backend should not persist them beyond request handling.
  - The app’s private key stays on the server; clients never see it.
  - Rate limits: prefer per‑installation tokens and batch writes where possible.

## CRDT merge with plain text

- Local state: a `Y.Doc` with one `Y.Text` per note (keyed by note id/path).
- Import/export:
  - Import md → set the Y.Text string to the markdown content.
  - Export md ← read the Y.Text string.
- Merge:
  - For a note: create three Y.Text values: base (from last synced), local, remote.
  - Apply Y.js updates to converge local and remote; export the result to text.
  - Since Y.Text is a conflict‑free replicated data type, concurrent insertions/deletions converge deterministically.
- The repo still stores Markdown (not CRDT ops). We re‑create CRDT state from text on load; that’s acceptable because Y.Text convergence for plain text is defined by the current document content.

## Sync Algorithm (MVP)

1. On app load:
   - Instantiate `LocalStore`, which seeds a welcome note if none exist and materialises the local index from `localStorage`.
   - Load any existing GitHub token (`vibenote:gh-token`) and remote config (`vibenote:config`).
2. Editing a note:
   - Apply the edit through a Y.Text instance and immediately persist the new Markdown to `localStorage`.
   - `LocalStore` updates `updatedAt` and leaves tombstones when notes are deleted or renamed.
3. Sync (Manual for now):
   - User clicks “Sync now”, which calls `syncBidirectional(LocalStore)`.
   - For each remote file, pull contents and compare against local `lastRemoteSha`/`lastSyncedHash`.
   - Merge diverged notes via Y.js three-way merge, upload changes with `PUT /contents`, and update sync metadata.
   - Push local deletes/renames using tombstones, and restore remote deletes when local edits exist.
   - Background polling remains on the roadmap so manual sync becomes an escape hatch rather than the primary path.

Notes:

- Batch commits: we can aggregate multiple note updates into one commit per sync window.
- Conflict policy: CRDT decides; no manual three‑way textual conflict markers.
- If remote changed but merge produces identical text, skip committing.

## Git Operations

`src/sync/git-sync.ts` now implements the GitHub Contents API end-to-end:

- `configureRemote` persists `{ owner, repo, branch, notesDir }` in `localStorage`.
- `pullNote`, `listNoteFiles`, `commitBatch`, and `deleteFiles` wrap REST calls and convert Base64 content.
- `syncBidirectional` mediates merges, handles local tombstones, restores remote deletions when needed, and records per-note sync hashes.

Future options still include moving to GraphQL/tree APIs for scale or pushing Git logic to a backend proxy when GitHub App mode lands.

## Local Storage Format (MVP)

Key namespace: `vibenote:*`

- `vibenote:gh-token` – GitHub OAuth access token (device flow output).
- `vibenote:config` – JSON: `{ owner, repo, branch, notesDir }`.
- `vibenote:index` – JSON list: `[{ id, path, title, dir, updatedAt }]`.
- `vibenote:note:<id>` – JSON: `{ id, path, title, dir, text, updatedAt, lastRemoteSha, lastSyncedHash }`.
- `vibenote:folders` – JSON list of folder paths under `notesDir` (e.g., `['a', 'a/b']`).
- `vibenote:tombstones` – Array of delete/rename markers used to reconcile remote deletions safely.

We avoid storing Y.js updates to keep it simple; instead, we reconstruct `Y.Text` from `text` on open. Later we can store Y updates in `y-indexeddb` for faster loads.

## UI Outline

- Header: repo selector (owner/repo/branch), sync status (idle/syncing/error).
- Sidebar: collapsible folder tree with notes; keyboard actions (F2 rename, Del delete). README.md is ignored only at repo root; nested README.md are notes.
- Editor: minimal Markdown editor (textarea for MVP), bound to Y.Text.
- Mobile: sidebar overlays; editor is primary.

## Error Handling & Resilience

- Offline: no remote calls, local edits continue.
- Token invalid: show a subtle banner; continue offline.
- Merge failure: unlikely with Y.Text; if remote file deleted, confirm recreate.
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
