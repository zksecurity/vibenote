---
status: done
created: 2026-03-05
completed: 2026-03-05
assigned: codex-manager
---

# Close the e2e testing loop for sync-heavy flows

This is the umbrella task for the high-value part of issue `#67`: establish a reliable end-to-end testing loop for the app paths that depend on GitHub-backed sync behavior.

The intent is not to perfect every testing workflow. The intent is to make storage/git refactors safer by giving us fast, credible coverage for the flows most likely to break across frontend, backend, auth, storage, and sync boundaries.

Must-haves:

- We can exercise meaningful sync-heavy app behavior end-to-end without depending on live GitHub.
- The solution is good enough to support upcoming refactors in the data, storage, and git layers.
- The resulting workflow is understandable and maintainable by future agents and humans.

Success will be validated by:

- A concrete test path exists and runs in the repo.
- The path covers at least one real multi-layer flow that would catch regressions unit tests are likely to miss.
- The implementation is documented well enough that a follow-up refactor can rely on it.

Planned child tasks:

- `audit-sync-flow-test-gaps`
- `design-shared-github-mock`
- `implement-sync-e2e-harness`
- `validate-sync-e2e-harness`

## Outcome

The first high-value slice is complete: the repo now has a writable-repo integration test that connects the real data hook to the real sync layer through the shared GitHub mock.

That is enough to de-risk the next storage/git refactor step without expanding this work into a larger browser or auth-integration project.
