---
status: done
created: 2026-03-05
completed: 2026-03-06
assigned: subagent-app-contract-tests
---

# Add tests that protect the UI/data contract

Add tests that lock in the contract the UI depends on, so a future rewritten data layer can prove compatibility without reusing the current internals.

The purpose is not to test every implementation detail. The purpose is to protect the boundary that issue `#99` is creating.

Must-haves:

- The tests cover the most important state and action flows the UI contract promises.
- The tests focus on contract behavior, not incidental internal structure.
- The test coverage is strong enough to support the later data-layer rewrite with confidence.

Success will be validated by:

- The repo gains runnable tests that assert the new boundary behavior.
- The tests would catch meaningful regressions in the contract even if internals were rewritten.
- The task file records what is covered and what remains intentionally out of scope.

## Results

Added a dedicated `useAppData` contract suite in `src/data/app-data-contract.test.ts`.

### Covered

- Route-to-state derivation at app scope:
  - empty `home` routes resolve to the new-workspace contract
  - `start` routes resolve from the most recent repo entry
- App-level navigation dispatch:
  - `repo.activate` opens the targeted workspace
  - `navigation.go-home` returns to the home screen and clears `workspace`
- App-owned recent-repo behavior:
  - activating a readable repo updates `state.repos.recents`
- Workspace contract outcomes observed through app state:
  - `note.create` updates selected note state without relying on callback return values
  - `file.rename` updates both navigation state and the resolved document path
  - `folder.rename` remaps the selected note path through contract state
- App-level probe behavior:
  - `repo.probe` exposes `checking` and final result state
  - stale probe responses are ignored
- Session contract behavior:
  - `session.sign-in` and `session.sign-out` are asserted via `state.session`

### Intentional gaps

- The suite does not try to exhaustively test every action mapping from `dispatch`; low-level file/folder mutation details are still covered better by existing repo-store tests.
- `helpers.importPastedAssets` is intentionally out of scope here because the contract focus is `state` plus `dispatch`, and the helper remains a temporary transition escape hatch.
- Sync and share flows are not deeply re-covered here; existing tests already exercise those paths closer to the current implementation, and this suite is meant to lock the app-facing boundary first.
