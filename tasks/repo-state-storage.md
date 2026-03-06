---
status: done
completed: 2026-03-06
created: 2026-03-05
---

# Repo state model + IndexedDB storage (#79)

## Context

We're rebuilding Vibenote's data layer to be Git-shaped at the object level. Read `docs/vibenote-git-sync-design.md` for the full design direction — especially the sections on the conceptual model, suggested TypeScript types, and the flat-map rationale.

Currently, all repo data lives in `localStorage` (see `src/storage/local.ts`). This task replaces that with a proper storage backend (IndexedDB) and defines the canonical TypeScript types for repo state.

## Parallel work notice

Another agent is working on **Git object identity** at the same time (see `tasks/git-object-identity.md`). That work will produce pure functions in a `src/git/` directory and won't conflict with your files. If you see new files appearing there, that's the other agent — ignore them.

Your work should reference the branded types (`GitSha`, `Path`, `FileMode`) that the design doc describes. If the git-objects agent hasn't created them yet, define them yourself in a shared types file — we'll reconcile later.

## Goal

1. **Define the repo state types.** The design doc has detailed suggestions — use them as a starting point, but adapt as you see fit. The key structures are:
   - Tree snapshots (BASE, REMOTE) as flat path maps
   - Working files with content, mode, and optional cached blob SHA
   - Index/staging area (even if hidden from UX — useful for merge internals)
   - Status entries
   - Merge state
   - Refs and branch state
   - The top-level `RepoState` that composes all of the above

2. **Implement IndexedDB persistence.** Store and retrieve repo state efficiently. Consider:
   - File content (potentially large `Uint8Array`s) should be stored efficiently — possibly in a separate object store from metadata
   - Multiple repos need to coexist (keyed by repo ID / slug)
   - Reads should be fast for common access patterns (get a single file's content, list all file metadata, get the full snapshot)
   - The API should be async and clean — the rest of the app will call these functions, not touch IndexedDB directly

3. **Migrate existing local.ts surface.** The current `src/storage/local.ts` exports functions like `getRepoStore`, `computeSyncedHash`, etc. that the app uses today. You don't need to make the old code call the new storage yet (that's a later task), but understand what it does so the new storage can eventually replace it.

## Required reading

- `docs/vibenote-git-sync-design.md` — sections on the conceptual model, TypeScript types, and flat-map rationale
- `src/storage/local.ts` — the current storage implementation you're replacing
- `AGENTS.md` — project coding guidelines

## Must-haves

- Well-defined TypeScript types for the full repo state model.
- IndexedDB storage layer with a clean async API: open/close, read/write repo state, read/write individual files, list files.
- Multiple repos supported (isolated by slug/repo ID).
- Tests covering: store and retrieve repo state, store and retrieve file content, multiple repos don't leak into each other, basic error handling.
- No React dependencies — this is a plain TypeScript module.

## Validation

1. `npm run check` clean.
2. `npm test` green — all new tests pass, no regressions.
3. Review: types align with the design doc's conceptual model (three snapshots, flat maps, merge state, refs).
