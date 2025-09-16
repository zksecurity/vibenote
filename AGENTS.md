VibeNote – Agent Guide

Read both README.md and DESIGN.md for product and architecture context. This document captures developer‑focused setup, deployment, and conventions.

Development Setup

- Prereqs: Node 18+, npm
- Install: `npm install`
- Run UI: `npm run dev` (Vite on `http://localhost:5173`)
- Run API (serverless): `npm run dev:api` (Vercel functions on `http://localhost:3000`)
- Env: copy `.env.example` → `.env` and set `GITHUB_CLIENT_ID` (GitHub OAuth App Client ID)
- Proxy: Vite proxies `/api/*` → `http://localhost:3000` (see `vite.config.ts`)

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
  - Body (optional): one or two bullets if extra context helps reviewers.

- Group related changes; avoid mega‑commits unless it’s a cohesive feature.
- Open small PRs; rely on Vercel Preview URLs for review.

UI/UX Conventions

- Mobile‑first: modals full‑screen on small screens; larger tap targets.
- Avoid `alert()`; prefer in‑app modals/toasts for flow steps and messages.

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
- Exports: collect all exports at the top of the file (named exports), avoid inline `export` sprinkled through implementations.
- Type safety: use strong types; do not use `any`; avoid `as` casts; avoid non‑null assertions (`!`), except if it's obvious from the surrounding code that the value cannot be nullish. If narrowing is required, use proper type guards.

Type Checking

- Run `npm run check` to perform a full TypeScript type check. Ensure the codebase type checks cleanly after changes.

Testing

- Unit tests are stored next to the source code they are testing, in .test.ts files. No separate /tests folder.

Agent Conventions

- When you make a change that is either trivial or that you already confirmed to be successful by running tests (i.e., it doesn't require manual testing/quality control from the UI), then commit the change right away.
- When we introduce new conventions or useful workflows, record them in this AGENTS.md so future work is consistent.
