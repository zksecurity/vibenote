VibeNote – Agent Guide

Read both README.md and DESIGN.md for product and architecture context. This document captures developer‑focused setup, deployment, and conventions.

Development Setup

- Prereqs: Node 22+, npm
- Install: `npm install`
- Run dev (UI + API): `npm start` (Vercel dev on `http://localhost:3000`)
- Env: copy `.env.example` → `.env` and fill the GitHub App variables (`GITHUB_APP_*`, `SESSION_JWT_SECRET`, `ALLOWED_ORIGINS`, etc.). `GITHUB_CLIENT_ID` is optional legacy support for Device Flow.
- Routing: `vercel dev` runs Vite on the same origin and serves `/api/*` via the Vercel router. No manual proxy setup is required.

Local dev

- Single command: `npm start`
  - Opens `http://localhost:3000/` for the UI; `/api/*` served by Vercel functions.
- Node runs TypeScript directly (2025+): use `node path/to/file.ts` for quick scripts; no ts-node/tsx needed.

Local Auth (GitHub App)

- “Connect GitHub” opens the GitHub App popup flow (`/v1/auth/github/*`).
- The backend signs JWT sessions; no GitHub tokens persist in localStorage.
- Legacy Device Flow endpoints live in `api/_legacy_github/_*.ts` (prefixed with `_` so Vercel ignores them). Only revive them intentionally if you bring back Device Flow.

Deploying to Vercel

- Framework: Vite (build to `dist/`). `vercel.json` is provided.
- Project env var: `GITHUB_CLIENT_ID` for both Preview and Production.
- Auto previews: When linked to GitHub, Vercel builds a Preview for each PR.
- First deploy: import repo → confirm build (`npm run build`) and output (`dist`) → add env var → deploy.

Commit & PR Conventions

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

UI/UX Conventions

- Mobile-first: modals full-screen on small screens; convenient tap targets.
- Visual direction: light GitHub-inspired shell. Use soft gray backgrounds, white surfaces, GitHub green for primary actions, and muted blue accents. Top bar mirrors GitHub repo view with circular sync icon, repo chip, and avatar. On small screens, repo name becomes the "title" (owner hidden <520px) and header stays within one row.

Auth Modes

- Default: GitHub App popup (per repo/owner install).
- Legacy: Device Flow (disabled by default; endpoints kept in `_legacy_github`).

Security Notes

- Treat access tokens as secrets; never log them or send to third‑party services.
- Device Flow tokens are bearer tokens; store only client‑side and clear on sign‑out.

Coding Guidelines

- Formatting: use Prettier (repo includes `.prettierrc`).
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
- When writing shared modules, prefer placing exported/high-level APIs at the top of the file and push low-level helpers toward the bottom, so readers can grasp intent before implementation details.
- Nullish values: In data types, prefer `undefined` (and `?` on object properties) to model inexistent values. Do not use `null` unless there is a specific strong reason. A valid reason to use `null` is if the data type needs to be JSON-stringified.

Type Checking

- Run `npm run check` to perform a full TypeScript type check. Ensure the codebase type checks cleanly after changes.

Testing

- Unit tests are stored next to the source code they are testing, in .test.ts files. No separate /tests folder.

Agent Conventions

- When you make a change that is simple enough and doesn't touch UI, try to confirm its correctness directly by running tests, and if successful, commit the change right away.
- Do NOT commit UI changes until verified by the user
- When we introduce new conventions or useful workflows, record them in this AGENTS.md so future work is consistent.

## Backend Deployment (GitHub App)

We share the same backend logic (`server/src/api.ts`) across two deployment targets:

1. **Serverless API (Vercel `/api`)** — primary deployment. Configure the GitHub App env vars in Vercel. The Hobby plan allows at most **12** functions per deployment; we currently ship 11 active routes. Legacy Device Flow handlers live in `api/_legacy_github/_*.ts` so they don’t count toward the limit.
2. **Express server (server/src/index.ts)** — the PM2/NGINX VPS setup in `docs/DEPLOYMENT.md`. Keep it as fallback or when we need stateful features later.

Switch between them by changing `VIBENOTE_API_BASE` (and keeping the env variables in sync).

See DEPLOYMENT.md for instructions to deploy the backend (mostly automatic with Vercel, based on scripts in this repo on a VPS.)

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

See `.env.example` for a detailed breakdown.

### Security & Ops quick notes

- The backend no longer stores a GitHub App private key. Only the OAuth client id/secret and the encrypted session store live on the server.
- Ensure frontend origins are exactly listed in `ALLOWED_ORIGINS`.
- Session refresh tokens are encrypted at rest inside `SESSION_STORE_FILE`. Rotate `SESSION_ENCRYPTION_KEY` if compromised (this invalidates all stored refresh tokens).
- Rotate `SESSION_JWT_SECRET` if compromised (all sessions invalidate).

Future improvements: webhook validation/handling, request logging, smarter caching.
