---
status: done
created: 2026-03-05
---

# Git object identity library

## Context

We're rebuilding Vibenote's data layer to be Git-shaped at the object level. Read `docs/vibenote-git-sync-design.md` for the full design direction — especially the sections on object identity, Git hashes, and the testing strategy.

This task builds the foundational library: pure functions that compute Git-compatible blob, tree, and commit SHAs. Everything else (sync, storage, merge) builds on this.

## Parallel work notice

Another agent is working on **repo state model + IndexedDB storage** at the same time (see `tasks/repo-state-storage.md`). That work lives in different files and won't conflict with yours. If you see new files appearing in `src/` that you didn't create, that's the other agent — ignore them.

## Goal

Create a module (suggest `src/git/` directory) of pure functions that:

1. **Compute blob SHAs** from file content (`Uint8Array`), matching Git's `blob <size>\0<content>` format exactly.
2. **Compute tree SHAs** from a list of tree entries (mode, name, child SHA), matching Git's binary tree format with canonical entry ordering.
3. **Compute commit SHAs** from a commit object (tree, parents, author, committer, message), matching Git's canonical commit text format.
4. **Build tree objects from flat path maps.** Given a flat `Map<path, { mode, sha }>` (like `git ls-tree -r`), reconstruct the nested tree hierarchy and compute the root tree SHA. This is needed later for turning working files into committable trees.

These are pure functions. No storage, no network, no React, no side effects.

## Required reading

- `docs/vibenote-git-sync-design.md` — sections on object identity, Git hashes, tree/blob/commit formats, and testing strategy
- `AGENTS.md` — project coding guidelines

## Must-haves

- Blob, tree, and commit SHA computation produce byte-for-byte identical results to real Git.
- Flat-path-map → nested tree reconstruction works correctly (including deeply nested paths, single-file trees, empty directories if applicable).
- Comprehensive tests using the real `git` CLI as oracle (create objects with `git hash-object`, `git mktree`, `git commit-tree`, then compare SHAs).
- Edge cases covered: empty blob, empty tree, UTF-8 filenames, filenames with spaces, executable mode, merge commits (multiple parents), various timezone offsets.
- Types are well-defined (branded `GitSha` type, `Path` type, etc. — see the design doc for suggestions).

## Validation

1. `npm run check` clean.
2. `npm test` green — all new tests pass, no regressions.
3. Tests demonstrate oracle comparison against real `git` CLI output.
