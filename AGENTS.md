GitNote – Agent Guide

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

- Keep commit messages concise; no mandatory prefixes like `feat(...)`.
- Group related changes; avoid mega‑commits unless it’s a cohesive feature.
- Open small PRs; rely on Vercel Preview URLs for review.

UI/UX Conventions

- Mobile‑first: modals full‑screen on small screens; larger tap targets.
- Avoid `alert()`; prefer in‑app modals/toasts for flow steps and messages.
- Header actions order: 1) Sync Now 2) Repo status/pill 3) Account (or Connect GitHub).

Auth Modes

- Default: OAuth Device Flow via serverless proxy; requests `repo` scope.
- Planned: GitHub App (selected repos, least‑privilege) — see DESIGN.md.

Security Notes

- Treat access tokens as secrets; never log them or send to third‑party services.
- Device Flow tokens are bearer tokens; store only client‑side and clear on sign‑out.
