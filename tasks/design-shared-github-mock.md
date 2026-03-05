---
status: done
created: 2026-03-05
completed: 2026-03-05
assigned: codex-manager
---

# Design a shared GitHub mock for end-to-end sync tests

Define the shape of a polished GitHub mock that can support meaningful end-to-end tests spanning the relevant frontend and backend layers.

The point is to decide what the harness should simulate and how it should fit into this repo, without overcommitting to unnecessary infrastructure.

Must-haves:

- Propose a testable target flow or flows for the first iteration.
- Explain how the mock will be shared or reused across the layers that need it.
- Respect the existing testing setup and reuse current helpers where sensible.

Success will be validated by:

- A concise design note is added to this task file.
- The note gives enough direction that an implementation agent can proceed without guessing the product goal.
- The proposed scope stays tight enough to land before the larger refactor work begins.

## Audit input

- The repo already has strong sync-engine coverage and strong hook-level coverage, but the two are tested mostly in isolation.
- The first design milestone should therefore focus on the seam between `useRepoData` and the real sync/storage implementation.

## Proposed first-iteration target

Design the harness around one meaningful writable-repo flow:

- mount `useRepoData` for a writable repo
- back the repo with the existing GitHub mock in `src/test/mock-remote.ts`
- let the real data-layer code import remote files into local state
- edit through hook actions
- run a real sync
- verify user-visible state, local persistence, and remote state together

This should stay intentionally narrower than:

- full browser automation
- full frontend+backend auth integration
- a generalized test platform for every future flow

Those may become follow-up tasks, but they are not necessary to de-risk the storage/git refactor.

## Design constraints

- Prefer reusing `MockRemoteRepo` over creating a second mock stack.
- Prefer fitting into the current Vitest-based workflow.
- Keep the design maintainable by future agents; avoid introducing infrastructure whose value is only hypothetical.
- Leave room to extend the same harness later for autosync or auth-related paths if the first milestone succeeds.
