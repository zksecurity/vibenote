# VibeNote Authentication Architecture

VibeNote authenticates with GitHub via a GitHub App using the user-to-server OAuth flow. This document explains how we mint tokens, how the frontend and backend interact, and what data we store.

## Overview

1. The SPA opens `/v1/auth/github/start` in a popup.
2. The backend redirects to GitHub’s OAuth consent page for the GitHub App.
3. GitHub redirects back to `/v1/auth/github/callback` with an authorization `code` and the signed `state` token.
4. The backend exchanges the authorization code for:
   - a short-lived **access token** (≈1 hour)
   - a long-lived **refresh token** (≈6 months)
5. The backend encrypts the refresh token and stores it in `sessions.json` alongside basic user metadata.
6. The backend signs a session JWT containing the GitHub user id/login and the session id, then posts a message back to the popup opener containing:
   - `sessionToken` (JWT)
   - `accessToken`
   - `accessTokenExpiresAt`
   - `user` metadata (id, login, name, avatar URL)
7. The SPA caches the session token and access-token metadata in localStorage and closes the popup.
8. All GitHub REST calls (tree/file/blob/commit) are issued directly from the browser with `Authorization: Bearer <accessToken>`.
9. Before the access token expires—or whenever GitHub returns 401—the SPA calls `/v1/auth/github/refresh`. The backend:
   - decrypts the stored refresh token
   - exchanges it for a new access/refresh token pair
   - re-encrypts + stores the new refresh token
   - returns the new access token + expiry
10. Signing out calls `/v1/auth/github/logout`, which deletes the session entry and clears the SPA’s local storage.

All repository permissions are enforced by GitHub: the access token only grants rights to repositories the GitHub App installation covers **and** that the user can access.

## Backend responsibilities

- `/v1/auth/github/start` – builds the GitHub OAuth URL with a signed state token.
- `/v1/auth/github/callback` – verifies state, exchanges the code, persists the encrypted refresh token, emits the session JWT + access token via `postMessage`.
- `/v1/auth/github/refresh` – rotates the access/refresh token pair using the stored refresh token.
- `/v1/auth/github/logout` – removes the session entry.
- `/v1/app/install-url` and `/v1/app/setup` – helpers for the GitHub App installation flow.
- `/v1/healthz` – basic health check.

We store sessions in `SESSION_STORE_FILE` (default `server/data/sessions.json`) with AES-256-GCM encryption keyed by `SESSION_ENCRYPTION_KEY`.

## Frontend responsibilities

- Trigger the popup flow and handle the `postMessage` payload.
- Persist `sessionToken` (JWT) and access-token metadata locally.
- Inject `Authorization: Bearer <accessToken>` headers on GitHub REST calls.
- Call `/v1/auth/github/refresh` when the access token is near expiry or revoked.
- Call `/v1/auth/github/logout` on sign-out and clear local data.

## Permissions & installation checks

The backend computes `RepoMetadata` by combining:

1. `GET /repos/{owner}/{repo}` – ensures the user has push access.
2. `GET /user/installations` + `GET /user/installations/{id}/repositories` – ensures the GitHub App installation includes the target repo.

A repo is editable only if both the installation and user permissions allow it. Otherwise, the frontend keeps the repo in read-only mode.

## Security considerations

- **Encrypted refresh tokens:** Stored refresh tokens are AES-256-GCM encrypted with `SESSION_ENCRYPTION_KEY`. Rotating this key invalidates all sessions.
- **JWTs:** Session tokens are signed with `SESSION_JWT_SECRET` and contain the GitHub user id/login plus the session id.
- **No private key:** The backend never stores the GitHub App private key or mints installation tokens.
- **CORS control:** `ALLOWED_ORIGINS` must list the exact origins allowed to call the backend; the Express server enforces this via the `cors` middleware.
- **Logging:** Never log tokens or decrypted refresh values. Session IDs and user logins are safe to log for auditing.
