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
- Save: App slug, OAuth client ID/secret, Webhook secret

2. Backend MVP (this change)

- Node + TypeScript server running on a VPS (single stable base URL)
- Endpoints (prefix /v1):
  - Auth: /auth/github/start, /auth/github/callback (popup login → session JWT)
  - Token lifecycle: /auth/github/refresh, /auth/github/logout (rotate user-to-server tokens)
  - Install flow: /app/install-url, /app/setup (round-trip state → return user to repo)
  - Webhooks: /webhooks/github (stub for future)
- Security: CORS allow-list, signed state tokens, encrypted session store on disk

3. Frontend Integration

- Auth popup to backend, store only VibeNote session JWT locally
- RepoView calls GitHub directly with the short-lived user token; backend only refreshes tokens
- Public read remains client-first direct to GitHub (unauthenticated)
- Editor/FileTree perform GitHub REST calls from the browser with the user token
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

- GITHUB_APP_SLUG
- GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET
- GITHUB_WEBHOOK_SECRET
- SESSION_JWT_SECRET (JWT signing key)
- SESSION_ENCRYPTION_KEY (32-byte key for encrypted refresh tokens)
- SESSION_STORE_FILE (path to JSON session file)
- ALLOWED_ORIGINS (comma-separated)
- PORT (default 8787)

Operational Notes

- Backend never mints installation tokens; it only exchanges OAuth codes and refreshes user tokens
- Client receives short-lived GitHub App user-to-server access tokens and stores them ephemerally (refresh handled via backend)
- Public repos remain readable without install; private repos require the app to be installed and the user to have access
