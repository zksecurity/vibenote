# Browser Smoke

Manual browser smoke checks for changes that affect app wiring, routing, repo state, or large UI/data-hook refactors.

Use this alongside the `agent-browser` workflow in `AGENTS.md`.

## When To Run This

Run this checklist when a change touches any of:

- `src/App.tsx`
- `src/data.ts`
- shared routing/state contracts
- repo switching
- file tree selection / navigation sync
- large refactors that should preserve existing UI behavior

## Goal

Catch regressions that unit tests often miss:

- React render loops
- route/state oscillation
- repeated `history.pushState` / `history.replaceState`
- broken repo switching
- writable vs read-only state mismatches

## Checklist

1. Open `http://localhost:3000/`.
2. Let the app settle for 2-3 seconds.
3. Confirm:
   - the URL stabilizes instead of flipping repeatedly
   - there are no React warnings/errors
   - there is no burst of History API updates
4. Open one recent writable repo.
5. In that repo:
   - click between 2-3 files in the tree
   - confirm file selection and URL stay in sync
   - click the sync button once without making edits first
   - confirm it behaves like a no-op and does not destabilize routing/state
   - open a markdown note and press the share icon
   - confirm the dialog opens cleanly, then press cancel without creating/revoking anything
   - open the repo switcher
   - navigate home and back into the repo
   - confirm the workspace still behaves normally
6. Open one public, non-writable repo.
7. In that repo:
   - confirm the read-only state/banner is correct
   - click a file in the tree
   - confirm navigation works without edit affordances or loops

## Notes

- Do not use `/new` as the primary smoke for this checklist. It is a lower-value special case than an actual repo workspace.
- If the change only affects onboarding or the empty/new flow, add a targeted `/new` smoke on top of this checklist rather than replacing it.
- Record what repo(s) you used and any important observations in the task file or PR notes.
