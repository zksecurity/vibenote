---
status: done
created: 2026-03-05
completed: 2026-03-05
assigned: codex-manager
---

# Implement the first end-to-end sync test harness

Build the first working version of the test path defined by the audit and design tasks.

The intent is to produce a practical harness, not a grand framework. It should cover the first high-value scenario well enough to start protecting the upcoming refactor.

Must-haves:

- Add runnable tests or supporting code in the repo that exercise the chosen multi-layer flow.
- Use a shared GitHub mock strategy consistent with the design task.
- Keep the solution maintainable and scoped to the agreed first milestone.

Success will be validated by:

- The new test path runs in the normal project test workflow, or there is a clearly justified reason if a separate invocation is required.
- The covered flow would fail if the relevant storage/git/sync behavior regressed.
- The task file records what was implemented and any limitations that remain.

## Implemented

- Added [src/data/data.integration.test.ts](/mnt/data-2tb/zks/vibenote/src/data/data.integration.test.ts), a writable-repo integration test for `useRepoData`.
- The test keeps auth and repo-metadata boundaries mocked, but uses:
  - the real `useRepoData` hook
  - the real sync implementation
  - the existing shared GitHub mock in `src/test/mock-remote.ts`
- The covered flow is:
  - remote repo starts with files
  - `useRepoData` imports them into local state
  - a local edit is made through hook actions
  - `syncNow` pushes the edit to the remote
  - a later remote change is pulled back into the active file through the same path

## Why this is the right first milestone

- It closes the highest-value gap found in the audit: the seam between the hook and the real sync/storage layer.
- It reuses the existing mock remote instead of introducing new infrastructure.
- It fits the current Vitest workflow cleanly and stays small enough to land before the larger refactor.

## Limitations

- This first harness does not cover autosync timers yet.
- It does not cover browser-level flows.
- It does not cover a full frontend+backend auth round-trip.

Those remain valid follow-up work, but they are not required for the storage/git refactor to start with a credible safety net.
