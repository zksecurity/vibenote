---
status: done
created: 2026-03-05
completed: 2026-03-06
assigned: subagent-define-action-protocol
---

# Adapt the current implementation to the new app-level contract

Make the current data-layer implementation conform to the new contract without attempting the full storage/git rewrite yet.

The intent is to prove that the contract works in the real app and to leave the codebase in a state where a later rewrite can swap implementations behind the same boundary.

Must-haves:

- The UI consumes the new contract rather than the old callback-oriented surface.
- The current implementation continues to preserve existing product behavior.
- App-level concerns covered by the contract are wired through the new boundary cleanly.
- The change does not quietly expand into the storage/git rewrite itself.

Success will be validated by:

- The adapted implementation runs in the app and existing behavior still works.
- The task file records what changed and any compatibility compromises that remain.
- The result is clearly usable as the old implementation behind a future-swappable contract.

## Results

### What changed

- Added an app-level hook in `src/data.ts` that exposes `{ state, dispatch, helpers }` over the current implementation.
- Kept the existing repo/workspace logic underneath, but removed `recordRecent` and `setActivePath` from `useRepoData` inputs.
- Moved recent-repo ownership into the data layer and exposed repo probe state there for `RepoSwitcher`.
- Added a thin route-sync adapter in `App.tsx`: the app reads `state.navigation` and updates the URL from outside the data layer.
- Switched `HomeView`, `RepoView`, and `RepoSwitcher` to dispatch typed intents instead of consuming the old callback bag or importing recents/probe helpers directly.

### Compatibility compromises kept for the transition

- `useRepoData` still exists as the current repo-scoped implementation, now wrapped with internal route-sync state so existing workspace behavior can continue behind the new app hook.
- `statusMessage` is still carried through the adapted workspace state to preserve the existing status banner, even though the long-term contract work aims to remove it.
- Pasted asset import now uses one narrow helper on the app hook instead of a broad action-result model, because the editor still needs immediate insertion metadata.
- The repo probe state lives under app repo state as a transition detail so `RepoSwitcher` can stop calling `repoExists()` directly.

### Verification

- `npm run check`
- `npm test -- src/data/data.test.ts src/data/data.integration.test.ts`

### Follow-up fix

- Removed the last direct navigation escape hatch for going home.
- `RepoView` no longer receives an `onGoHome` prop from `App.tsx`.
- Home navigation now goes through `dispatch({ type: 'navigation.go-home' })`, and `App.tsx` still performs the URL sync externally from `state.navigation`.

### Follow-up validation

- `npm run check`
- `npm test`

### Remaining follow-up

- Add dedicated contract tests for `useAppData`, since the current focused coverage is still mostly repo-hook-centric.
- Revisit the temporary `statusMessage` and narrow import helper once the later rewrite replaces the current implementation behind the same contract.
