---
status: done
completed: 2026-03-06
created: 2026-03-06
---

# Sync engine (#75)

## Context

Build the sync engine described in `docs/vibenote-git-sync-design.md`. It uses the git object identity library (`src/git/`) and repo state model (`src/storage/repo-types.ts`) that are already built.

## Goal

Implement the full sync flow: fetch remote tip → compute local diff against BASE → three-way merge → build commit → push → retry on race. Merge policies: markdown (custom 3-way), binary (theirs wins), other text (best-effort fallback).
