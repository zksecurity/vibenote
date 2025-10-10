# VibeNote — “Share Links” Feature (v1 Spec)

## Overview

We’re adding a lightweight way to **share a single note** from an existing GitHub-backed collection via a **secret link**.
All notes remain stored in GitHub repos — the backend never stores content, only metadata that maps a short “share ID” to a specific file in a repo.

Anyone with the link can view the note in a public VibeNote-branded viewer (read-only).
Access is purely “security by URL” — no login or permissions required.

This is the **first version (v1)** of sharing. It covers the simplest case:

- **Unlisted** links only (no access restrictions or authentication).
- **Live** links only (always show the latest version from GitHub).

Future versions will add snapshotting, expiring links, and optional restricted shares.

---

## Goals

- Let users share an individual note (Markdown file) as a **link**.
- The shared note should update automatically when the file changes on GitHub.
- Shared notes should open in a **public viewer** that matches VibeNote’s design.
- The backend should remain lightweight — it only tracks **which note was shared**, not its content.
- Sharing and revoking links should be instant and reliable.

---

## User Experience

### From the main VibeNote app

- A **“Share”** option appears when viewing a note.
- Clicking **Share** opens a modal or dropdown:

  - Option to create an **unlisted share link**.
  - (In future: other modes like “snapshot” or “restricted” could appear here.)

- On confirmation, the app calls the backend to create a share.
- The app shows the generated URL and lets the user copy it.

### Viewing a shared note

- Visiting the link opens a **public viewer** (e.g., `vibenote.dev/s/abc123`).
- The viewer shows:

  - The note rendered in VibeNote’s Markdown style.
  - Embedded images and attachments (resolved from the same GitHub repo).
  - A small header indicating it’s a “Shared note — Unlisted (Live)”.

- The note is **read-only**. There’s no editing or navigation outside this note.
- If the link is revoked or expired, the viewer shows a **tombstone message** (“This shared note is no longer available.”).

---

## Behavior Summary

| Action                       | Behavior                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| Create share                 | Generates a new secret ID and stores metadata linking it to the note’s repo/path.                       |
| Open share URL               | Viewer fetches metadata, then fetches note and assets directly (through our backend proxy) from GitHub. |
| Edit note in GitHub          | Changes appear automatically when the share link is reloaded.                                           |
| Revoke share                 | The share ID is invalidated; the link stops working.                                                    |
| Access via direct GitHub URL | Not possible; GitHub tokens never exposed.                                                              |
| Expiry                       | Not required for v1, but should be easy to add later.                                                   |

---

## Architecture (High-Level)

### Components

1. **Share Links Service (backend extension)**

   - Stores a minimal mapping: share ID → (repo, file path, branch/ref, createdBy, status).
   - Serves three kinds of endpoints:

     - **Create a share** (called from main SPA)
     - **Resolve a share** (used by public viewer)
     - **Proxy note & asset requests** (fetch from GitHub Content API)

   - Enforces that each share grants access to **only one Markdown file** and its **referenced assets**.
   - Handles revocation and expiry (if implemented later).

2. **Public Viewer (frontend)**

  - A simple SPA under `vibenote.dev`.
   - Renders the shared note using the same components as the main app.
   - Talks only to the share endpoints (no direct GitHub calls).
   - Provides read-only display, consistent styling, and basic metadata (title, date, etc.).

3. **GitHub Integration**

   - Continues using the existing GitHub App to fetch content.
   - For “live” shares, the backend resolves the latest commit on each request.
   - No write access or token exposure to clients.

---

## Key Concepts

### “Unlisted”

- The only access model in v1.
- Anyone with the URL can view the note.
- The share link is intentionally long and random to make guessing infeasible.
- There’s no index or discovery API for public shares.

### “Live”

- The link always shows the **current** version of the file on its branch.
- Changes in GitHub appear automatically.
- Future versions will add “snapshot” links pinned to a commit SHA.

### “Revocation”

- A share can be revoked anytime.
- Revocation removes or disables the mapping; the URL becomes invalid immediately.
- No GitHub changes are needed.

---

## Viewer Behavior

When someone opens a shared link:

1. The viewer calls the backend to **resolve** metadata for the share ID.
2. It requests the note content via a backend endpoint, which:

   - Fetches the latest version of that file from GitHub.
   - Streams it back as Markdown or rendered HTML.

3. Any relative image or attachment links in the Markdown are rewritten to go through the same backend proxy, which fetches those assets from GitHub as needed.
4. The viewer displays the rendered note and its assets.
5. If the share is invalid, disabled, or expired, the viewer shows an error page.

---

## Future-Proofing (not implemented in v1)

- **Snapshot Mode:** allow a share to be frozen at a specific commit SHA.
- **Restricted Mode:** require GitHub login or organization membership.
- **Expiring Links:** automatic invalidation after a chosen date.
- **Analytics:** count views (anonymously).
- **Embeds:** allow shared notes to be embedded in iframes or other apps.

The system design should leave room for these extensions — especially snapshotting (by adding a “pinned commit” field later).

---

## Success Criteria

- A user can share any Markdown note from a GitHub-backed collection.
- The resulting URL opens a read-only viewer with correct formatting and assets.
- Updating the source file in GitHub updates the shared note automatically.
- Revoking the link disables access immediately.
- No content is stored in VibeNote’s backend — only metadata.
- The design leaves a clear path toward future features (snapshot, restricted access, expiry).

---

## Deliverables

- Backend:

  - Share link creation and resolution endpoints.
    - `POST /v1/shares { owner, repo, path, branch? }`
    - `GET /v1/shares?owner=...&repo=...&path=...`
    - `DELETE /v1/shares/:id`
  - Environment:
    - `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (used to mint installation tokens).
    - `SHARE_STORE_FILE` (JSON persistence for share records).
    - `PUBLIC_VIEWER_BASE_URL` (sets the domain used in generated links).
  - Proxy for note and asset fetching from GitHub.
    - `GET /v1/share-links/:id`
    - `GET /v1/share-links/:id/content`
    - `GET /v1/share-links/:id/assets/*`
  - Basic admin/revocation endpoint.

- Public Viewer SPA:

  - New route for shared links.
  - Fetch + render flow using existing components.
  - Tombstone state for invalid shares.
  - The standalone build (`share.html`) reads `VIBENOTE_API_BASE`/`VITE_VIBENOTE_API_BASE` to contact the API.
  - The viewer rewrites relative asset links through `/v1/share-links/:id/assets/*` and renders Markdown with the same sanitisation rules as the main app.

- Main SPA:

  - “Share” button with copyable link.
  - (Optional) minimal “Manage shares” UI.

- Basic internal documentation describing how the share links work.
