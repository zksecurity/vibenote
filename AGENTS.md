VibeNote – Agent Guide

Read both README.md and DESIGN.md for product and architecture context. This document captures developer‑focused setup, deployment, and conventions.

Development Setup

- Prereqs: Node 18+, npm
- Install: `npm install`
- Run dev (UI + API): `npm start` (Vercel dev on `http://localhost:3000`)
- Env: copy `.env.example` → `.env` and set `GITHUB_CLIENT_ID` (GitHub OAuth App Client ID)
- Routing: `vercel dev` runs Vite on the same origin and serves `/api/*` via its router. Vite’s `/api` proxy is automatically disabled in this mode (see `vite.config.ts`).

Local dev

- Single command: `npm start`
  - Opens `http://localhost:3000/` for the UI; `/api/*` served by Vercel functions.
- Node runs TypeScript directly (2025+): use `node path/to/file.ts` for quick scripts; no ts-node/tsx needed.

Local Auth (Device Flow)

- Click “Connect GitHub” → DeviceCodeModal shows the code; click “Open GitHub” and paste the code.
- The client polls `/api/github/device-token` and stores the user token locally on success.
- Tokens are stored in `localStorage` (MVP). Do not log or persist them elsewhere.

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

- Default: OAuth Device Flow via serverless proxy; requests `repo` scope.
- Planned: GitHub App (selected repos, least‑privilege) — see DESIGN.md.

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

Type Checking

- Run `npm run check` to perform a full TypeScript type check. Ensure the codebase type checks cleanly after changes.

Testing

- Unit tests are stored next to the source code they are testing, in .test.ts files. No separate /tests folder.

Agent Conventions

- When you make a change that is simple enough and doesn't touch UI, try to confirm its correctness directly by running tests, and if successful, commit the change right away.
- Do NOT commit UI changes until verified by the user
- When we introduce new conventions or useful workflows, record them in this AGENTS.md so future work is consistent.

## Backend Deployment (GitHub App)

The standalone backend in `server/` (see `OAUTH_REFACTOR.md`) provides the GitHub App authentication endpoints and repo/file/commit API after migrating away from the Device Flow.

Overview

- Express server (TypeScript) – entrypoint: `server/src/index.ts`
- No database; all state is transient (JWT sessions, installation lookups via GitHub API)
- Installation tokens minted on demand; never expose GitHub tokens directly to the client
- CORS allow‑list driven by `ALLOWED_ORIGINS`

Endpoints (prefix `/v1`)

- Health: `GET /v1/healthz`
- Auth popup: `GET /v1/auth/github/start`, `GET /v1/auth/github/callback`
- App install: `GET /v1/app/install-url`, `GET /v1/app/setup`
- Repo metadata: `GET /v1/repos/:owner/:repo/metadata`
- Tree listing: `GET /v1/repos/:owner/:repo/tree?ref=<branch>`
- File fetch: `GET /v1/repos/:owner/:repo/file?path=...&ref=<branch>`
- Commit (write): `POST /v1/repos/:owner/:repo/commit` (JSON body; session required)
- Webhooks placeholder: `POST /v1/webhooks/github` (currently no‑op)

Environment Variables
See `.env.example` for reference. Required for production:

```
GITHUB_APP_ID=            # numeric app id
GITHUB_APP_SLUG=          # app slug
GITHUB_OAUTH_CLIENT_ID=   # app OAuth client id
GITHUB_OAUTH_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY_BASE64= # base64 of the PEM (or set GITHUB_APP_PRIVATE_KEY_PATH or GITHUB_APP_PRIVATE_KEY)
SESSION_JWT_SECRET=       # long random string
ALLOWED_ORIGINS=https://your-frontend.example
PORT=8787
```

Optional:

- `GITHUB_WEBHOOK_SECRET` (future webhook validation)

Private Key Options
Provide exactly one of:

- `GITHUB_APP_PRIVATE_KEY_BASE64` – base64 of full PEM file
- `GITHUB_APP_PRIVATE_KEY_PATH` – absolute path to PEM on disk
- `GITHUB_APP_PRIVATE_KEY` – inline PEM with literal `\n` newlines

Building / Running
Node 22+ can execute TypeScript directly; we rely on that (no ts-node / tsx).

PM2 (recommended persistent process):

```
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 status
```

See `ecosystem.config.cjs` for settings.

```

Security Notes
- Never expose the private key outside the server VM or container.
- Keep the server behind a reverse proxy (rate limiting, TLS termination).
- Rotate `SESSION_JWT_SECRET` if compromised (invalidates sessions).
- Lock down inbound firewall to only 80/443 (not the internal 8787 port directly) if possible.

Frontend Integration
- Point the UI to the backend via a runtime config variable (planned: `VIBENOTE_API_BASE`).
- Ensure the frontend origin (scheme+host+port) is listed verbatim in `ALLOWED_ORIGINS`.

Troubleshooting
- 400 @ `/v1/auth/github/callback`: GitHub App callback URL mismatch or expired state token.
- CORS error: Origin not exactly (string‑equal) listed in `ALLOWED_ORIGINS`.
- 403 commit: App not installed, or repo not selected in a selected‑repos installation.
- Unknown default branch: App not installed and public metadata fetch failed (private repo) → user must install app.

Future Enhancements (Not Yet Implemented)
- Webhook signature verification + event handling (installation, push) for caching.
- Rate limiting / request logging middleware.
- Optional ETag/If-None-Match caching for tree and file responses.

```
