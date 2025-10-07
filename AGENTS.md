# VibeNote – Agent Guide

Read both README.md and DESIGN.md for product and architecture context.
This document captures developer‑focused setup, technical architecture and IMPORTANT code conventions.

## Development Setup

- Node 22+, npm
- Test: `npm test`
- TypeScript type check: `npm run check`

### Setup details you might not need

- Run the frontend: `npm start` (Vite on `http://localhost:3000`)
  - Human developer will have this running. He can provide feedback on UI changes and test changes manually if necessary.
- (Typically not needed) Run the backend: `npm run server:start`
  - We usually set `VITE_VIBENOTE_API_BASE` to the _production backend_ when developing the frontend, so we don't have to start the backend.
- Env: Human developer manually fills `.env` with GitHub App variables. Coding agents MUST NEVER read or write `.env`, actual secrets may be stored there, even in development.
- Node runs TypeScript directly (2025+): use `node path/to/file.ts` for quick scripts; no ts-node/tsx needed.

## UI/UX Conventions

- Mobile-first: modals full-screen on small screens; convenient tap targets.
- Visual direction: light GitHub-inspired shell. Use soft gray backgrounds, white surfaces, GitHub green for primary actions, and muted blue accents. Top bar mirrors GitHub repo view with circular sync icon, repo chip, and avatar. On small screens, repo name becomes the "title" (owner hidden <520px) and header stays within one row.

## Frontend Architecture

- `src/ui/RepoView.tsx` is the primary workspace screen. It renders the navigation shell (header, repo switcher, file tree, editor) and only owns ephemeral UI state such as dropdown toggles, sidebar visibility, and keyboard shortcuts.
- RepoView consumes `useRepoData` from `src/data.ts`. The hook centralises session/auth, local storage, autosync timers, and GitHub interactions. It exposes `{ state, actions }` to the UI.
- Components must call the hook’s actions (e.g. `createNote`, `renameFolder`, `syncNow`) instead of talking to storage or sync modules directly. This keeps side effects in one layer and allows hooks/tests to mock behaviour easily.

## Auth (GitHub App)

- “Connect GitHub” opens the GitHub App popup flow (`/v1/auth/github/*`), issuing user-scoped OAuth tokens.
- see `docs/AUTH.md` for details

## Security Notes

- Treat access tokens as secrets; never log them or send to third‑party services.

## Coding Guidelines

- Don't make stylistic changes you were not asked for, and that are not listed in these guidelines.
- VERY IMPORTANT: Don't remove comments. When moving code around, keep the comments 1:1.
- When asked to refactor stuff, don't change any logic that doesn't need changing. Instead, propose tangential changes to the user, to be done as a second step of the refactor.
- Sprinkle small comments throughout your code, that explain dense logic at a high level. Add a comment at the top of a file explaining its purpose.
- Formatting: we use Prettier (repo includes `.prettierrc`).
- Filenames use kebab case, like my-lib.ts. Except for React component files with the typical PascalCase.
- Variables: prefer `let` over `const`. Except for functions, global constants, or other module‑level constant objects.
- Types: use `type` aliases instead of `interface`.
- Exports: collect all exports at the top of the file with named exports. Avoid inline `export` sprinkled through the file.
- Export types using the `type` qualifier: `export type { MyType }` or `export { type MyType }`
- Type safety: use strong types
  - do not use `any`
  - avoid `as` casts
  - avoid non‑null assertions (`!`), except if obvious from the surrounding code that the value cannot be nullish
  - If narrowing is required, use proper type guards.
- Avoid confusing boolean coercions: For values that are not boolean, prefer explicit value checks over truthy tests on `value` or `!value`:
  - `if (value !== undefined)` rather than `if (value)`
  - `if (text === "")` rather than `if (!text)`
  - `number !== 0 && array.includes(number)` rather than `number && array.includes(number)`
- Function arguments: Use an inline type instead of a separate type alias for types that are only used once.
- When writing shared modules, prefer placing exported/high-level APIs at the top of the file and push low-level helpers toward the bottom, so readers can grasp intent before implementation details.
- Nullish values: In data types, prefer `undefined` (and `?` on object properties) to model inexistent values. Do NOT use `null`, unless there is a specific strong reason. A valid reason to use `null` is if the data type needs to be JSON-stringified.
- React: Don't memoize everything. Only use `useMemo()` for expensive computations, not for trivial stuff like ternary operators. Do not use `useCallback()` unless asked or you have a strong reason. Just recreating callbacks on every render is usually fast, and will ensure they are never stale.
- Prefer putting dense logic into simple top-level `function`s, instead of creating spaghetti of inline declared callbacks that implicitly depend on in-scope variables.

## Type Checking

- Run `npm run check` after edits to perform a full TypeScript type check. Ensure the codebase type checks cleanly after changes.

## Testing

- Unit tests are stored next to the source code they are testing, in .test.ts files. No separate /tests folder. Run with `npm test`.
- `src/test/setup.ts` loads automatically via Vitest to expose browser-like globals (localStorage, fetch, atob/btoa). Keep new hook/UI tests compatible with that environment instead of redefining globals in each file.
- `src/test/mock-remote.ts` is a GitHub REST stub that powers sync-heavy tests (e.g. `useRepoData` flows). Prefer it when you need to exercise `syncBidirectional` without network calls.

## Commit Conventions

- Do NOT commit unless asked. Even if you were asked to commit within a session, don't commit more changes in the same session without being asked.
- Commit messages: short, high‑level, no function names.
  - Aim for 50–65 chars in the subject.
  - Summarize the user‑visible change or intent, not the mechanics.
  - Avoid prefixes like `feat(...)` and internal details (e.g., file or function names).
  - Examples:
    - Good: "Shorten device flow and improve mobile modal"
    - Good: "Sync removes deleted notes"
    - Good: "Import notes from connected repo"
    - Avoid: "Add deleteFiles() and use in App.tsx"
    - Avoid: "Refactor RepoConfigModal.tsx for CTA"
  - Body: not needed
- Group related changes; avoid mega‑commits unless it’s a cohesive feature.

## Agent Conventions

- When we introduce new conventions or useful workflows, record them in this AGENTS.md so future work is consistent.

## Backend Deployment

The Express backend lives in `server/src/index.ts`. Deployed on a VPS (PM2 + NGINX) as described in `docs/DEPLOYMENT.md`. The frontend talks to it via `VITE_VIBENOTE_API_BASE`.

All repository reads and writes happen directly from the client using the user-scoped GitHub App OAuth token. The backend no longer proxies Git operations.

See `.env.example` and `docs/AUTH.md` for a detailed breakdown of variables and the auth flow.
