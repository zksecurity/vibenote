---
status: done
created: 2026-03-05
completed: 2026-03-05
blocked-by: implement-sync-e2e-harness
assigned: codex-manager
---

# Validate the end-to-end sync harness against real app needs

Review the finished harness critically and verify that it actually protects the refactor work it was meant to de-risk.

This is not just "tests are green". The task is to check whether the new coverage is meaningful, stable, and aligned with the intended storage/git refactor.

Must-haves:

- Run the relevant checks.
- Review whether the chosen flow truly crosses the important boundaries.
- Identify any obvious blind spots that should be captured as follow-up tasks rather than silently ignored.

Success will be validated by:

- This task file contains a short validation note with findings.
- The harness is either accepted as sufficient for the next refactor step or rejected with concrete reasons.
- Any follow-up work is described clearly enough to spin out into separate tasks if needed.

## Validation note

- The new harness passes with `npm test -- src/data/data.integration.test.ts`.
- The adjacent sync suites still pass:
  - `npm test -- src/sync/sync.integration.test.ts src/sync/git-sync.test.ts src/sync/git-sync-multi.test.ts src/sync/git-sync-stale.test.ts`
- The repo still type-checks with `npm run check`.

## Findings

- The harness crosses the important boundary that was previously missing: `useRepoData` now drives the real sync layer against the shared GitHub mock.
- The covered flow is meaningful for the upcoming storage/git refactor because it exercises:
  - remote import into local state
  - local edit persistence
  - real manual sync
  - remote-to-local pull behavior that updates the active file

## Acceptance

- Accepted as sufficient for the next refactor step.
- This is not the final word on end-to-end coverage, but it is a credible first safety net for the storage/git work.

## Follow-up blind spots

- Autosync behavior through the same real harness.
- Full auth/backend integration if that area becomes volatile.
- Browser-level regression coverage for the user-facing sync workflow.
