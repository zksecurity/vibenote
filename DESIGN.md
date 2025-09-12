# GitNote – Design

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
  - Remote: GitHub REST API (contents + commits). For now, mocked functions with clear extension points.
- Sync:
  - Optimistic apply to local CRDT + persist to local storage immediately.
  - Periodic background sync: batch local changes and publish commits to the repo.
  - Merge strategy: pull remote md, import both local and remote into Y.Text, use Y.js to converge, export md, commit the result. (See “CRDT merge with plain text” below.)

## Repository Layout

- Top‑level folder for notes, e.g., `notes/` (configurable).
- One note per file, `notes/<slug>.md`.
- Optional `notes/_index.json` (or `_index.yml`) for metadata (titles, ordering) – not required for MVP.

## Identity & Auth

- MVP: bearer token input stored in local storage (a GitHub Personal Access Token). No server.
- Future: GitHub OAuth (PKCE) with client‑side token storage; or small server to handle OAuth code exchange.

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
   - Load local repo index + notes from local storage.
   - If user has a Git token and repo configured, schedule background sync.
2. Editing a note:
   - Update the Y.Text (CRDT) and save the new md content in local storage immediately.
   - Mark the note as dirty in `SyncQueue` with a local timestamp/version.
3. Background sync (every N seconds or on demand):
   - For each dirty note:
     - Fetch remote md (HEAD) via Git API (if online).
     - Merge local vs remote using Y.Text as above.
     - If the merged text differs from remote, create a commit with message `gitnote: update <note>`.
   - Push commit(s) via Git API.
   - Update local last synced sha / etag per note.

Notes:
- Batch commits: we can aggregate multiple note updates into one commit per sync window.
- Conflict policy: CRDT decides; no manual three‑way textual conflict markers.
- If remote changed but merge produces identical text, skip committing.

## Git Operations (Planned)

MVP will provide placeholders in `src/sync/git-sync.ts` for:

- `configureRemote({ owner, repo, branch, token })`
- `pullNote(path): Promise<{ text: string, sha: string }>`
- `commitBatch([{ path, text, baseSha }], message): Promise<commitSha>`

Implementation options:
- Use GitHub REST API v3 (contents endpoints for simple files). Pros: simple; cons: large repos need GraphQL/trees.
- Use `isomorphic-git` in browser + a CORS‑friendly HTTP backend (later).
- Future server: small proxy for auth/webhooks and to unify git logic.

## Local Storage Format (MVP)

Key namespace: `gitnote:*`

- `gitnote:config` – JSON: `{ owner, repo, branch, token, notesDir }`
- `gitnote:index` – JSON list: `[{ id, path, title, updatedAt }]`
- `gitnote:note:<id>` – JSON: `{ id, path, title, text, updatedAt, lastRemoteSha }`

We avoid storing Y.js updates to keep it simple; instead, we reconstruct `Y.Text` from `text` on open. Later we can store Y updates in `y-indexeddb` for faster loads.

## UI Outline

- Header: repo selector (owner/repo/branch), sync status (idle/syncing/error).
- Sidebar: list of notes (search, new, sort), collapsible.
- Editor: minimal Markdown editor (textarea for MVP), bound to Y.Text.
- Mobile: sidebar overlays; editor is primary.

## Error Handling & Resilience

- Offline: no remote calls, local edits continue.
- Token invalid: show a subtle banner; continue offline.
- Merge failure: unlikely with Y.Text; if remote file deleted, confirm recreate.

## Security

- Token is stored in localStorage for MVP – acceptable for personal usage. Document this clearly in README.
- Future: use OAuth + server to mint short‑lived tokens.

## Testing & Dev

- Unit test small utilities; E2E later.
- Keep code ESM + TS, zero exotic tooling.

## Roadmap

- [ ] Wire GitHub REST API for real pull/commit
- [ ] Switch to IndexedDB for local storage
- [ ] Better editor (CodeMirror + y-codemirror)
- [ ] Presence & collaboration (y-webrtc or y-websocket)
- [ ] Repository browser (folders, images)
- [ ] Webhooks (optional small server) to hint at remote updates
