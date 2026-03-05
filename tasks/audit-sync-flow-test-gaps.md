---
status: done
created: 2026-03-05
completed: 2026-03-05
assigned: codex-manager
---

# Audit current test coverage for sync-heavy flows

Identify what the repo already tests well, what is only tested in isolation, and which cross-layer flows are currently undercovered.

The goal is to give the project manager a grounded view of where an end-to-end harness will pay off most. This should guide scope, not create a large design document.

Must-haves:

- Review the existing frontend, backend, and sync-related tests.
- Identify a short list of high-value user flows that are currently not covered end-to-end.
- Call out any existing helpers or mocks that should be reused instead of replaced.

Success will be validated by:

- A concise written summary is added to this task file.
- The summary names the most important missing flow or flows to target first.
- The summary is specific enough to drive the design and implementation tasks that follow.

## Findings

### Existing coverage is already strong in two separate layers

- `src/sync/git-sync.test.ts`, `src/sync/git-sync-multi.test.ts`, `src/sync/git-sync-stale.test.ts`, and `src/sync/sync.integration.test.ts` cover the sync engine itself in depth.
- Those tests already use `src/test/mock-remote.ts`, which behaves like a GitHub REST stub and exercises real `syncBidirectional` behavior against a remote-like API surface.
- `src/data/data.test.ts` covers `useRepoData` behavior well at the hook level: initial loading, writable vs read-only access, manual sync actions, autosync scheduling, auth edge cases, and route/state interactions.
- `server/src/__tests__/git-shares.test.ts` provides a real Express integration harness for share endpoints, but that coverage is mostly orthogonal to the storage/git refactor.

### The main gap is the seam between the hook and the sync engine

- The hook tests mock `listRepoFiles`, `pullRepoFile`, and `syncBidirectional`, so they do not verify that the real data layer wiring drives the real sync/storage stack correctly.
- The sync tests verify the sync engine against the mock remote, but they do not mount `useRepoData` or exercise the user-facing actions that trigger sync behavior.
- There is no single test path that starts from the real data hook actions and ends in the GitHub-like remote state while also checking the local store and user-visible state.

### Highest-value missing flows

- A writable repo flow that mounts `useRepoData` with the real sync module and a shared GitHub mock, then verifies remote import, local edit, and sync behavior together.
- A follow-up variant that proves remote changes round-trip back into the active file through the same path.
- Autosync is also a useful candidate, but it is a second step after the manual sync path is covered end-to-end.

### Recommended first target

- Start with one tight writable-repo flow rather than full browser e2e or full frontend+backend auth integration.
- The best first target appears to be:
  - visit a writable repo backed by the GitHub mock
  - import remote files into local state through the real data-layer path
  - edit via `useRepoData` actions
  - call `syncNow`
  - verify both local state and remote state
- If scope allows, extend the same test with a simulated remote change and a second sync to verify pull behavior updates the active file.

### Reuse candidates

- Reuse `src/test/mock-remote.ts` as the shared GitHub mock instead of inventing a second fake API.
- Reuse the existing `renderHook`-based `useRepoData` test style unless a stronger integration harness becomes clearly necessary.
- Reuse the current backend metadata mocks for the first iteration; the storage/git refactor does not require full auth-server integration as the first milestone.

### Current validation status

- I could not execute the current test suites in this checkout because `npm test` fails with `sh: 1: vitest: not found`, which indicates dependencies are not installed locally here.
- The audit conclusions above are based on reading the existing tests and helpers rather than running them in this environment.
