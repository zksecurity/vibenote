# VibeNote – Agent Guide

Read both README.md and DESIGN.md for product and architecture context.
This document captures developer‑focused setup, deployment, and conventions.

## Development Setup

- Prereqs: Node 22+, npm
- Install: `npm install`
- Run the frontend: `npm start` (Vite on `http://localhost:3000`)
- (Typically not needed) Run the backend: `npm run server:start` (Express on `http://localhost:8787` by default)
- Env: Human developer manually copies `.env.example` → `.env` and fills the GitHub App variables (`GITHUB_APP_SLUG`, `GITHUB_OAUTH_*`, `SESSION_JWT_SECRET`, `SESSION_ENCRYPTION_KEY`, `ALLOWED_ORIGINS`, etc.)
  - coding agents MUST NEVER read or write `.env`, actual secrets may be stored there, even in development

## Local dev

- Single command: `npm start`, starts the Vite dev server.
- We usually set `VITE_VIBENOTE_API_BASE` to the _production backend_ when developing the frontend, so you don't have to start the backend. Only after backend changes, make sure that the backend is restarted.
- Node runs TypeScript directly (2025+): use `node path/to/file.ts` for quick scripts; no ts-node/tsx needed.

## UI/UX Conventions

- Mobile-first: modals full-screen on small screens; convenient tap targets.
- Visual direction: light GitHub-inspired shell. Use soft gray backgrounds, white surfaces, GitHub green for primary actions, and muted blue accents. Top bar mirrors GitHub repo view with circular sync icon, repo chip, and avatar. On small screens, repo name becomes the "title" (owner hidden <520px) and header stays within one row.

## Auth

- “Connect GitHub” opens the GitHub App popup flow (`/v1/auth/github/*`), issuing user-scoped OAuth tokens.
- see `docs/AUTH.md` for details

## Security Notes

- Treat access tokens as secrets; never log them or send to third‑party services.

## Coding Guidelines

- VERY IMPORTANT: don't make stylistic changes you were not asked for, and that are not listed in these guidelines. Don't remove comments or similar nonsense.
- Formatting: we use Prettier (repo includes `.prettierrc`).
- Variables: prefer `let` over `const`, except for global constants, functions, or other module‑level constant objects.
- Types: use `type` aliases instead of `interface`.
- Exports: collect all exports at the top of the file (named exports), avoid inline `export` sprinkled through the file. Good Example:

```ts
import { helper } from  "stuff"

export { mainMethod, anotherMethod }

function mainMethod() { // ...
```

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
- Nullish values: In data types, prefer `undefined` (and `?` on object properties) to model inexistent values. Do not use `null` unless there is a specific strong reason. A valid reason to use `null` is if the data type needs to be JSON-stringified.

## Type Checking

- Run `npm run check` after edits to perform a full TypeScript type check. Ensure the codebase type checks cleanly after changes.

## Testing

- Unit tests are stored next to the source code they are testing, in .test.ts files. No separate /tests folder. Run with `npm test`.
- `src/test/setup.ts` loads automatically via Vitest to expose browser-like globals (localStorage, fetch, atob/btoa). Keep new hook/UI tests compatible with that environment instead of redefining globals in each file.
- `src/test/mock-remote.ts` is a GitHub REST stub that powers sync-heavy tests (e.g. `useRepoData` flows). Prefer it when you need to exercise `syncBidirectional` without network calls.

## Commit Conventions

- Do NOT commit untested changes. In particular, do not commit UI changes until verified by the user.
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

## Backend Deployment (GitHub App)

The Express backend lives in `server/src/index.ts`. Deploy it on a VPS (PM2 + NGINX) as described in `docs/DEPLOYMENT.md`. The frontend talks to it via `VIBENOTE_API_BASE` / `VITE_VIBENOTE_API_BASE`.

### API surface (common routes)

- `GET /v1/healthz`
- `GET /v1/auth/github/start`
- `GET /v1/auth/github/callback`
- `GET /v1/app/install-url`
- `GET /v1/app/setup`
- `POST /v1/auth/github/refresh`
- `POST /v1/auth/github/logout`
- `POST /v1/webhooks/github` (placeholder)

All repository reads and writes now happen directly from the client using the user-scoped GitHub App OAuth token. The backend no longer proxies Git operations.

### Environment variables

See `.env.example` and `docs/AUTH.md` for a detailed breakdown of variables and the auth flow.

### Security & Ops quick notes

- The backend no longer stores a GitHub App private key. Only the OAuth client id/secret and the encrypted session store live on the server.
- Ensure frontend origins are exactly listed in `ALLOWED_ORIGINS`.
- Session refresh tokens are encrypted at rest inside `SESSION_STORE_FILE`. Rotate `SESSION_ENCRYPTION_KEY` if compromised (this invalidates all stored refresh tokens).
- Rotate `SESSION_JWT_SECRET` if compromised (all sessions invalidate).

Future improvements: webhook validation/handling, request logging, smarter caching.
