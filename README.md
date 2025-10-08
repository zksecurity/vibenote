# VibeNote

VibeNote is a lightweight, mobile‑friendly, offline‑first note editor that treats a Git repository as its database. It lets you browse repos like a notebook and edit Markdown notes. Notes are stored as regular Markdown files in Git, so they remain portable and reviewable.

- Lightweight Express backend issues GitHub App tokens and stores encrypted session refresh tokens
- Offline‑first via in‑browser storage + optimistic UI
- Periodic background sync commits to GitHub (or any Git host API)
- Y.js‑backed merge for conflict resolution during sync (no live collaboration)

See DESIGN.md for a detailed architecture and sync/merge logic.

## Development

See `AGENTS.md` for setup and code guidelines, and `docs/` for more specific pieces of documentation.

`DESIGN.md` has the original design and architecture notes.
