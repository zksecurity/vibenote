---
status: active
created: 2026-03-05
---

# Clean up the data layer ↔ UI boundary (#99)

## Context

We're preparing to rebuild the data layer (storage, git/sync, app state) from scratch as "V2". Before that, we need the current boundary between data and UI to be crisp, so V2 can be a drop-in replacement behind the same API surface.

Today, `useRepoData` in `src/data.ts` already returns `{ state, actions }` — the shape is mostly right. But there are a few things that need to change to make it a clean, swappable contract.

## Goal

Refactor the current `useRepoData` hook and its consumers so that:

1. **Actions are data, not function calls.** The UI dispatches action objects (`dispatch({ type: 'create-note', dir, name })`) instead of calling `actions.createNote(dir, name)`. Define a discriminated union `Action` type and a single `dispatch(action: Action)` function. Internally, `dispatch` can just call the existing action functions — no logic changes needed.

2. **The data layer is app-level, not per-repo.** Today `useRepoData` takes a `slug` and is mounted per-repo. Lift it so there's a single app-level hook (call it `useAppData` or similar) that handles session/auth, repo transitions, and recents — things that are already global but awkwardly live inside a per-repo hook.

3. **Routing is bidirectional but outside the data layer.** Today the UI passes `setActivePath` and `recordRecent` callbacks *into* the data hook, so the data layer can drive navigation. Remove those inputs. Instead:
   - Route changes flow **in** to the data layer as actions: `dispatch({ type: 'route-changed', route })`.
   - The data layer expresses "where the user is" as **state** (e.g. `activePath`, `activeSlug`).
   - A thin UI adapter syncs the two: URL changes → dispatch, state changes → `navigate(...)`.
   - The data layer never knows about URLs or calls navigate.

## Must-haves

- The app works exactly as before from a user's perspective. No behavioral changes.
- All existing tests pass (`npm test`).
- `npm run check` passes with no type errors.
- The `Action` union type and `dispatch` function are exported and used by all UI consumers. No UI component calls action functions directly.
- `setActivePath` and `recordRecent` are no longer inputs to the data hook.
- The data hook is instantiated once at the app level, not per-repo.

## Validation

1. `npm run check` clean.
2. `npm test` green.
3. Manual review: grep confirms no UI file imports or calls action functions directly (only `dispatch`). `setActivePath` and `recordRecent` don't appear as data hook inputs.
4. We will do a browser smoke test after the code changes.
