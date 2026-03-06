# VibeNote – Agent Guide

Refer to README.md and DESIGN.md for product and architecture context.

This document captures developer-focused guidelines and conventions, and is VERY IMPORTANT to understand and follow.

## Development

- Node 22+, npm, TypeScript
- Type check: `npm run check`
- Test: `npm test`

### Type Checking

- Run `npm run check` after edits to perform a full TypeScript type check. Ensure the codebase type checks cleanly after changes.

### Testing

- Unit tests are stored next to the source code they are testing, in .test.ts files. No separate /tests folder. Run with `npm test`.
- `src/test/setup.ts` loads automatically via Vitest to expose browser-like globals (localStorage, fetch, atob/btoa). Keep new hook/UI tests compatible with that environment instead of redefining globals in each file.
- `src/test/mock-remote.ts` is a GitHub REST stub that powers sync-heavy tests (e.g. `useRepoData` flows). Prefer it when you need to exercise `syncBidirectional` without network calls.

### E2E / Browser Testing

When shipping a UI feature, verify the full flow end-to-end in the browser using `npx agent-browser` before calling it done. This catches wiring and UI bugs that unit tests won't catch.

Typical workflow:

1. The dev server must be running (`npm start` — the human developer usually has this up).
2. **First run requires auth**: open headed, ask the user to sign in, then save state so future runs are headless:
   ```bash
   npx agent-browser --headed open http://localhost:3000
   # ask user to sign in, then:
   npx agent-browser state save .browser-auth.json
   ```
   The file is gitignored and persists across restarts — you only need to do this once.
3. **Subsequent runs**: load saved state and test headlessly:
   ```bash
   npx agent-browser state load .browser-auth.json
   npx agent-browser open http://localhost:3000
   ```
4. Always clean up: `npx agent-browser close`

The dev frontend talks to the **production backend** (see `VITE_VIBENOTE_API_BASE` in `.env`), so e2e tests exercise real API flows — shares get committed to GitHub, sync hits the real server, etc.

### Commit Conventions

- Do NOT commit unless asked. Even if you were asked to commit within a session, don't commit more changes in the same session without being asked.

### Other dev notes

- Run the frontend: `npm start` (Vite on `http://localhost:3000`). The human developer usually has this running.
- Run the backend: `npm run server:start` — typically not needed since `VITE_VIBENOTE_API_BASE` points to the production backend.
- **IMPORTANT — Env**: The human developer manually fills `.env` with GitHub App secrets. Coding agents MUST NEVER read or write `.env`, even in development.
- Node runs TypeScript directly (2025+): use `node path/to/file.ts` for quick scripts; no ts-node/tsx needed.

## Product and architecture

### UI/UX Conventions

- Mobile-first: modals full-screen on small screens; convenient tap targets.
- Visual direction: light GitHub-inspired shell. Use soft gray backgrounds, white surfaces, GitHub green for primary actions, and muted blue accents. Top bar mirrors GitHub repo view with circular sync icon, repo chip, and avatar. On small screens, repo name becomes the "title" (owner hidden <520px) and header stays within one row.

### Frontend Architecture

- `src/ui/RepoView.tsx` is the primary workspace screen. It renders the navigation shell (header, repo switcher, file tree, editor) and only owns ephemeral UI state such as dropdown toggles, sidebar visibility, and keyboard shortcuts.
- RepoView consumes `useRepoData` from `src/data.ts`. The hook centralises session/auth, local storage, autosync timers, and GitHub interactions. It exposes `{ state, actions }` to the UI.
- Components must call the hook’s actions (e.g. `createNote`, `renameFolder`, `syncNow`) instead of talking to storage or sync modules directly. This keeps side effects in one layer and allows hooks/tests to mock behaviour easily.

### Auth (GitHub App)

- “Connect GitHub” opens the GitHub App popup flow (`/v1/auth/github/*`), issuing user-scoped OAuth tokens.
- see `docs/AUTH.md` for details

### Backend

The Express backend lives in `server/src/index.ts`. Deployed on a VPS (PM2 + NGINX) as described in `docs/DEPLOYMENT.md`. The frontend talks to it via `VITE_VIBENOTE_API_BASE`.

All repository reads and writes happen directly from the client using the user-scoped GitHub App OAuth token. The backend no longer proxies Git operations.

See `.env.example` and `docs/AUTH.md` for a detailed breakdown of variables and the auth flow.

## Code Guidelines

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
- React: Don't memoize everything. Only use `useMemo()` for expensive computations, not for trivial stuff.
  - example: use `useMemo()` when the logic involves reading from `localStorage`
  - example: do NOT use `useMemo()` when the logic just filters an array
- React: Do not use `useCallback()` (unless you have a strong reason). Just recreating callbacks on every render is usually fast, and will ensure they are never stale.
- Prefer putting dense logic into simple top-level `function`s, instead of creating spaghetti of inline declared callbacks that implicitly depend on in-scope variables.
