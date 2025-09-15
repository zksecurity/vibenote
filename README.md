# VibeNote

VibeNote is a lightweight, mobile‑friendly, offline‑first note editor that treats a Git repository as its database. It lets you browse repos like a notebook and edit Markdown notes. Notes are stored as regular Markdown files in Git, so they remain portable and reviewable.

- Frontend only (no persistent server required)
- Offline‑first via in‑browser storage + optimistic UI
- Periodic background sync commits to GitHub (or any Git host API)
- CRDT merge (Y.js) for plain‑text collaboration and conflict resolution

See DESIGN.md for a detailed architecture and sync/merge logic.

## Development

See `AGENTS.md` for local setup, environment variables, and serverless API instructions.

## Project layout

- `src/` UI (React + TypeScript) and app logic
- `src/crdt/` Y.js CRDT helpers for Markdown
- `src/storage/` local offline storage (localStorage for MVP)
- `src/sync/` Git sync pipeline (GitHub API placeholder + queues)
- `DESIGN.md` Deep dive into syncing, CRDT merge, file layout, and future serverless options

## Status

This is an MVP scaffold meant to be easy to iterate on by another LLM agent. The current app supports:

- Viewing a pseudo repo + list of notes (from local storage)
- Creating/renaming/selecting notes
- Editing notes in a simple editor with Y.js CRDT locally
- Persisting changes to localStorage immediately (optimistic)
- A stub Git sync pipeline (ready to wire to GitHub REST API)

Production‑grade items (auth, real Git push/pull, better editor, y-websocket, presence) are described and planned in DESIGN.md.

## Deploying

Vercel deployment instructions and preview setup are documented in `AGENTS.md`.

## GitHub OAuth (Device Flow)

This app uses GitHub’s Device Authorization Flow via serverless proxy endpoints (no CORS issues in the browser).

Steps:
- Create a new GitHub OAuth App at https://github.com/settings/developers → New OAuth App.
  - Homepage URL: your Vercel production URL (or `http://localhost:5173` for dev)
  - Authorization callback URL: can be any valid URL (not used by device flow), e.g. your homepage URL
- Copy the Client ID and set it as `GITHUB_CLIENT_ID` (server env var on Vercel; `.env` for `vercel dev`).
- In the app, click “Connect GitHub” and follow the instructions; enter the user code in the opened GitHub page.

Endpoints provided by the app (Vercel functions):
- `POST /api/github/device-code` → calls GitHub device code API
- `POST /api/github/device-token` → polls for access token

For local development of these endpoints, see `AGENTS.md` (using `vercel dev`).

## Auth Modes

**OAuth Device Flow**
- Permissions: `repo` (public + private) per user; broad OAuth scope.
- Tokens: User access token, long‑lived bearer stored locally (MVP).
- Backend: Minimal (serverless proxy to avoid CORS only).
- Repo selection: Any repo user can access; no per‑repo install.
- Private repos: Supported.
- Best for: Fast setup, personal use, minimal backend.

**GitHub App (Planned)**
- Permissions: Fine‑grained (Repository contents: Read & write; Metadata: Read).
- Tokens: Short‑lived installation tokens scoped to selected repos.
- Backend: Required (sign JWT, mint installation tokens; optional API proxy).
- Repo selection: User selects specific repos at install.
- Private repos: Supported; least‑privilege consent screen.
- Best for: Production, org usage, tighter permissions.

## Manual Sync (MVP)

The header has a “Sync Now” button that:
- Compares all local notes to remote files in the configured repo/branch
- Commits changed or new files via GitHub Contents API with message `vibenote: update notes`

To use it:
1. Click “Connect GitHub” and authorize.
2. Click “Repo” to set `{ owner, repo, branch }`.
3. Click “Sync Now”.

Notes:
- For the MVP, conflict resolution relies on full‑text replace and optional Y.Text merging in memory; real background batching is planned.
- If a remote file does not exist, the app will create it.
