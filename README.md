# VibeNote

VibeNote is a lightweight, mobile‑friendly, offline‑first note editor that treats a Git repository as its database. It lets you browse repos like a notebook and edit Markdown notes. Notes are stored as regular Markdown files in Git, so they remain portable and reviewable.

- Lightweight Express backend issues GitHub App tokens and stores encrypted session refresh tokens
- Offline‑first via in‑browser storage + optimistic UI
- Periodic background sync commits to GitHub (or any Git host API)
- Y.js‑backed merge for conflict resolution during sync (no live collaboration)

See DESIGN.md for a detailed architecture and sync/merge logic.

## Development

See `AGENTS.md` for local setup, environment variables, and backend instructions.

## Project layout

- `src/ui/` React UI, modals, and the app shell
- `src/auth/` GitHub App auth helpers (popup flow, access-token refresh)
- `src/storage/` local offline storage (localStorage for MVP, plus tombstones, folder index)
- `src/merge/` Y.js‑backed merge helpers for Markdown
- `src/sync/` GitHub REST integration for pull/push/delete and bidirectional sync
- `DESIGN.md` Deep dive into syncing, CRDT merge, file layout, and backend architecture

## Deploying

Backend deployment instructions (PM2/NGINX) are documented in `AGENTS.md`.

## GitHub App Backend

VibeNote authenticates via a GitHub App that issues user-to-server OAuth tokens. The Express backend (in `server/`) performs the OAuth exchange, stores encrypted refresh tokens on disk, and exposes `/v1/auth/github/*` endpoints for login, refresh, logout, and install redirects. All repository reads and writes run directly in the browser with the short-lived access token; the backend never touches repo content.

## Manual Sync (MVP)

The header has a “Sync Now” button that:

- Compares all local notes to remote files in the configured repo/branch
- Commits changed or new files via GitHub Contents API with message `vibenote: update notes`

To use it:

1. Click “Connect GitHub” and authorize.
2. Click “Repo” to set `{ owner, repo, branch }`.
3. Click “Sync Now”.

Notes:

- Notes can be nested in folders; the sidebar shows a collapsible tree. README.md is ignored only at the repository root; nested README.md files are treated as notes.
- Conflict resolution uses a Y.js three‑way merge during sync. The in‑app editor is not collaborative and does not use Y.js.
- If a remote file does not exist, the app will create it.
