VibeNote – GitHub App Migration Plan

Scope: Replace OAuth Device Flow with a GitHub App + small, stable backend. Keep the current repo switcher UX. Support user and org repos. No DB.

Phases

1. App Setup (owner action)

- Create GitHub App (Any account can install)
- Callback: https://api.vibenote.dev/v1/auth/github/callback
- Setup URL: https://api.vibenote.dev/v1/app/setup
- Webhook URL: https://api.vibenote.dev/v1/webhooks/github (secret set)
- Permissions: Repository Contents (Read & write), Repository Metadata (Read-only)
- OAuth scopes: read:user, user:email (optional)
- Save: App ID, App slug, Private key (PEM), OAuth client ID/secret, Webhook secret

2. Backend MVP (this change)

- Node + TypeScript server running on a VPS (single stable base URL)
- Endpoints (prefix /v1):
  - Auth: /auth/github/start, /auth/github/callback (popup login → session JWT)
  - Install flow: /app/install-url, /app/setup (round-trip state → return user to repo)
  - Repo: /repos/:owner/:repo/metadata (installed? selected? default branch)
  - Data: /repos/:owner/:repo/tree, /repos/:owner/:repo/file (installed token or public unauth)
  - Write: /repos/:owner/:repo/commit (installation token; batches changes into one commit)
- Security: CORS allow-list, HMAC/JWT state, no secrets to client, no DB

3. Frontend Integration

- Auth popup to backend, store only VibeNote session JWT locally
- RepoView calls /metadata to decide UI state
- Public read (not installed) is client-first direct to GitHub with backend fallback
- Editor/FileTree swap to backend for tree/file/commit
- CTAs: Public → “Get Write Access”, Private → “Get Read/Write Access”

4. Install Flow Polish

- Handle selected-repos installations: deep-link to manage page when repo not added
- Success/pending banners after setup redirect

5. Decommission Device Flow

- Remove DeviceCodeModal and token storage
- Trim envs and docs

6. Optional Enhancements

- Webhooks (installation, installation_repositories, push) for cache invalidation
- “My installations” listing (session-scoped; still no DB)

Environment (backend)

- GITHUB_APP_ID, GITHUB_APP_SLUG
- GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET
- GITHUB_APP_PRIVATE_KEY_BASE64 (base64 of PEM) or GITHUB_APP_PRIVATE_KEY_PATH
- GITHUB_WEBHOOK_SECRET
- SESSION_JWT_SECRET (JWT signing key)
- ALLOWED_ORIGINS (comma-separated)
- PORT (default 8787)

Operational Notes

- Backend mints installation tokens on-demand with the app’s private key
- Client never receives GitHub tokens
- Public repos without installation are read-only; private requires installation (or repo selection) to view/edit
