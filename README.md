# GitNote

GitNote is a lightweight, mobile‑friendly, offline‑first note editor that treats a Git repository as its database. It lets you browse repos like a notebook and edit Markdown notes. Notes are stored as regular Markdown files in Git, so they remain portable and reviewable.

- Frontend only (no persistent server required)
- Offline‑first via in‑browser storage + optimistic UI
- Periodic background sync commits to GitHub (or any Git host API)
- CRDT merge (Y.js) for plain‑text collaboration and conflict resolution

See DESIGN.md for a detailed architecture and sync/merge logic.

## Quick start

1. Install dependencies

```
npm install
```

2. Start dev server

```
npm run dev
```

3. Open http://localhost:5173

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
