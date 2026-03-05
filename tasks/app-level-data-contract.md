---
status: active
created: 2026-03-05
assigned: codex-manager
---

# Define the app-level UI/data contract for issue #99

This is the umbrella task for issue `#99`: cleanly separate the data layer from the UI before rewriting storage and git behavior.

The main outcome we want is not a rewritten data layer. The main outcome is a stable contract that the current implementation can satisfy now and a future implementation can replace later.

Two architectural decisions shape this task:

- The UI should express intents as action data, rather than depending on a bag of bespoke callback methods.
- The data layer should likely live at app scope, not only at single-repo scope, so it can own concerns like repo switching and recently visited repositories alongside the active workspace state.

Must-haves:

- The intended UI/data boundary is explicit rather than implicit in the current hook implementation.
- The contract covers the real app-level concerns the UI depends on, including current workspace state and multi-repo concerns.
- The contract is implementation-agnostic enough that a rewritten data layer can slot in behind it without forcing UI rewrites.
- The current implementation is adapted to this contract without taking on the full storage/git rewrite yet.

Success will be validated by:

- There is a clear contract for state and action-intent flow that the UI can consume.
- The UI depends only on that contract, not on ad hoc internals of the current data layer.
- The contract is protected by tests that a future replacement implementation can run against.
- The scope remains focused on boundary definition and adaptation, not the later rewrite itself.

Planned child tasks:

- `audit-ui-and-app-state-ownership`
- `define-action-data-protocol`
- `define-app-data-state-contract`
- `adapt-current-implementation-to-app-contract`
- `add-ui-data-contract-tests`
