# VibeNote — “Share as Secret Gist” (v1) Implementation Prompt

You’re implementing **per-note sharing** for VibeNote using **secret GitHub gists** for storage and a **proxy/indirection** model for access. The agent already knows the current VibeNote codebase (SPA + lightweight backend + GitHub App OAuth). Focus only on **new parts** introduced by the sharing feature.

---

## Product Goals (v1)

- Users can **share a single note** as an **unlisted link** (security-by-URL).
- VibeNote **does not store content**; content lives in a **secret gist**.
- The public viewer **preserves VibeNote look & feel** (same Markdown renderer).
- **Revocation without touching GitHub** by deleting the internal share mapping (the gist may remain).
- Scope is **unlisted/public** only — **no per-viewer auth** in v1.

---

## High-Level Architecture

```
[Main SPA] --(POST /api/share/gist)--> [Backend]
     |                                     |
  (GET share URL)                          |--(create secret gist via GH API)--> [GitHub Gists]
     |                                     '-- store mapping: shareId -> { gistId, file }
     '---- opens --> https://public.vibenote.dev/s/<shareId> --> [Viewer SPA]
                                                              |--> (GET /api/shares/:id/resolve)
                                                              |--> (GET /api/gist-raw?gist=...&file=...)
```

- **Backend** keeps only a **small mapping**: `shareId → { gistId, primaryFilename, assetFilenames[], title, createdBy, createdAt, expiresAt? }`.
- **Viewer SPA** never sees the gist ID directly in the URL; all fetches go through our proxy endpoints.

---

## Data Model (DB / KV)

Create a new table/collection `shared_notes`:

```ts
type ShareMode = 'unlisted'; // v1 only

interface SharedNote {
  id: string; // 128-bit random, url-safe (base58/base62). The public shareId.
  mode: ShareMode; // "unlisted" (may expand later)
  gistId: string; // secret gist id
  primaryFile: string; // e.g., "note.md"
  assets: string[]; // additional gist files referenced by the note
  title?: string; // extracted from H1 or front-matter
  createdBy: {
    userId: string; // internal user id
    githubLogin: string; // creator’s GH handle for auditing
  };
  createdAt: string; // ISO timestamp
  expiresAt?: string; // optional TTL
  isDisabled: boolean; // soft revoke without deleting DB record
  metadata: {
    snapshotSha?: string; // optional: gist history sha if we choose to freeze (not required in v1)
    noteBytes: number; // for quota/rate-limiting
    assetBytes: number; // sum of assets
  };
}
```

Indexes:

- `PRIMARY KEY (id)`
- `gistId` (unique optional) if we want 1:1 mapping (v1 not strictly required).
- `createdBy.userId`
- `expiresAt` (for cleanup job)

---

## Backend — New Endpoints

### 1) Create a Share (and gist)

`POST /api/share/gist`

**Input:**

```json
{
  "repo": "org/repo", // source repo from which user shares
  "path": "docs/note.md", // path of the selected note in the source repo
  "mode": "unlisted", // v1 only
  "includeAssets": true, // v1: true by default
  "expiresAt": null // optional ISO string; null/absent = no expiry
}
```

**Behavior:**

1. **Fetch note content** from GitHub via existing auth (user token / app) at current HEAD (same as current viewer does).
2. **Discover assets**:

   - Parse Markdown for images/links (`![...](./img.png)`, `<img src="...">`, attachment links).
   - Resolve relative paths against `path` (normalize, disallow `..`).
   - Fetch each asset as bytes (small images/docs). **Size guard** (e.g., max 5 MB per asset, 10 MB total v1).

3. **Create secret gist** via GitHub **Gists API**:

   - `public: false`
   - `files`: `{ "note.md": content, "img_001.png": <base64 or raw text>? }`
   - **Important**: for binary assets, write them as additional gist files. (Gist supports binary; treat as bytes. If API requires text, base64 and add a small loader; but prefer direct bytes if supported by our client lib.)
   - Gist description example: `"VibeNote shared note – <H1 or filename>"`

4. **Persist `SharedNote`** in DB with generated `shareId`.
5. **Return**:

```json
{
  "id": "<shareId>",
  "url": "https://public.vibenote.dev/s/<shareId>",
  "title": "Extracted Title",
  "createdAt": "2025-10-09T10:00:00Z"
}
```

**Errors (HTTP):**

- `400` invalid input
- `403` user not authorized to read source note
- `413` content/assets too large
- `502` failed to create gist (GitHub error)
- `500` unexpected

### 2) Resolve Share Metadata

`GET /api/shares/:id/resolve`

**Output:**

```json
{
  "id": "<shareId>",
  "mode": "unlisted",
  "title": "Extracted Title",
  "createdAt": "...",
  "expiresAt": null,
  "disabled": false,
  "files": {
    "primary": "note.md",
    "assets": ["img_001.png", "diagram.svg"]
  }
}
```

- **No gistId returned** (keep it server-side).
- `404` if not found or disabled or expired.

### 3) Stream Gist File (proxy)

`GET /api/gist-raw?share=<id>&file=<name>`

- Validates:

  - Share exists, not disabled/expired.
  - `file` ∈ `{ primaryFile ∪ assets }`.

- Streams raw bytes from GitHub gist file to client.
- **Headers**:

  - `Cache-Control: public, max-age=300`
  - `ETag` passthrough if we can, or compute from gist file SHA.
  - `Content-Type` inferred by filename (fallback `application/octet-stream`).

- **Security**:

  - Never return redirect to raw GitHub URL.
  - `Referrer-Policy: no-referrer`
  - CORS: allow only `public.vibenote.dev` (and main app origin for management).

- Errors:

  - `404` invalid file or share
  - `410` gone (if disabled)
  - `502` upstream fetch failure

### 4) Revoke / Disable Share

`DELETE /api/shares/:id`

- Sets `isDisabled = true`. (Do **not** delete the gist in v1.)
- Return `204`.

### 5) (Optional) Update Share TTL

`PATCH /api/shares/:id`

```json
{ "expiresAt": "2026-01-01T00:00:00Z" }
```

- Return updated metadata.

---

## Viewer SPA (public.vibenote.dev)

New route: `/s/:shareId`

**Boot flow:**

1. Call `GET /api/shares/:id/resolve`. If `404/410`, show “This shared note is unavailable.”
2. Fetch primary markdown: `GET /api/gist-raw?share=<id>&file=<primaryFile>`.
3. Render with existing Markdown pipeline (same theme/components).

**Asset Rewriting:**

- Before rendering, rewrite Markdown image/asset URLs to:

  - `/api/gist-raw?share=<id>&file=<assetName>`

- Because gist filenames are flat, map original relative paths to deterministic filenames when creating the gist (e.g., `assets/img-<N>.<ext>`). Store that mapping while constructing `files`.

**SEO / Link Preview:**

- Inject OG tags (server-side or via `<meta>` update):

  - `og:title` = `title || filename`
  - `og:description` = first paragraph/plaintext excerpt (optional: compute during creation and store in `SharedNote`)

- Display a small “Shared via VibeNote” footer.

**UI States:**

- Header shows `title`, “unlisted” pill, created date.
- Copy link button.
- If disabled/expired, display a clear tombstone page.

---

## Main SPA — Share Creation UX

- “Share” button on any note:

  - Modal:

    - Mode: **Unlisted** (fixed for v1)
    - Include images & attachments: ✅ (default)
    - Optional expiry (date picker, optional)

  - On confirm → call `POST /api/share/gist`.
  - On success → show share URL + Copy button + “Open in new tab”.

- In note context menu, show **“Manage Shares”** (list shares for the current path):

  - `GET /api/shares?repo=...&path=...` (implement lightweight index or compute server-side if we kept source info as metadata during creation).
  - For v1, acceptable to skip listing and just show the last created link in toast.

---

## GitHub Integration Notes

- Obtain `gist` scope from the user during the GitHub App OAuth flow (add it to the `scope` parameter).
- Store the resulting access/refresh tokens in the existing encrypted session store.
- All gist create/update/delete calls must use that user access token so the share stays under their account and can be refreshed.
- If the token lacks `gist`, reject share requests with a friendly message prompting the user to reconnect and grant the scope.

- Gist composition:

  - `description`: `"VibeNote shared note – <title>"`
  - `files`:

    - primary markdown: normalized to `note.md` (or slugged name).
    - assets: flat filenames, e.g. `asset_0001.png`, `asset_0002.svg`.

  - Size guards: reject shares exceeding thresholds; surface a friendly error.

---

## Security & Privacy

- **No content** stored server-side (only the mapping + small derived metadata).
- **No gistId in client**; only `shareId`.
- Gists are owned by the sharing user; we never mint gists with shared service credentials.
- CORS locked to `public.vibenote.dev` (and app origin for management APIs).
- `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Content-Security-Policy` minimal (no inline scripts if possible).
- Rate limit:

  - `POST /api/share/gist`: e.g. 10/min/user
  - `GET /api/gist-raw`: e.g. token bucket by IP + shareId

- Logging:

  - Avoid logging gist IDs and file names in INFO logs. Use DEBUG only (redact in prod).

- Expiry sweeper:

  - Cron job disables expired shares daily.

---

## Telemetry

- Counter events:

  - share_created, share_viewed, share_revoked, share_asset_miss, gist_upstream_error

- Include: shareId (hashed), createdBy.userId, noteBytes, assetBytes, status codes, timings.

---

## Testing Checklist

- **Unit**:

  - Markdown asset discovery (relative path normalization, `..` rejection).
  - Filename mapping determinism and collision handling.
  - DB schema + serialization.

- **Integration**:

  - Happy path: create → open `/s/:id` → renders with images.
  - Revocation: DELETE then verify `/resolve` and `/gist-raw` return 410/404.
  - Large assets rejection (413).
  - Expired share returns 410.

- **Security**:

  - Attempt to fetch undeclared `file` name → 404.
  - Path traversal in `file` → 400/404.
  - CORS preflight passes only for allowed origins.

---

## Optional Nice-to-Haves (v1.1+)

- **Encrypt-at-rest** variant:

  - Client encrypts note; gist stores ciphertext; server serves key only if share active.

- **“Snapshot” mode** using gist revision SHA:

  - Store `snapshotSha` and pin raw fetch to that revision (immutability).

- **Share Listing per Note**:

  - Maintain source repo/path in metadata to support a management panel.

- **Embeds**:

  - Public embed card (`<iframe>`) with title/first lines.

---

## Deliverables

- Backend:

  - New routes (create, resolve, raw proxy, revoke), TypeScript types, migrations/seeds.
  - GitHub gist client module (create, add files).
  - Markdown asset discovery utility.

- Viewer SPA:

  - `/s/:shareId` page + data fetch hooks.
  - Renderer integration + asset URL rewriter.
  - Tombstone page for disabled/expired.

- Main SPA:

  - Share modal + API call, toast with link.

- Docs:

  - Short `docs/sharing-v1.md` describing flow, limits, and operational notes.

---

## Acceptance

- I can share `docs/foo.md` and immediately open a pretty VibeNote-branded URL that renders the note + images.
- Deleting the share mapping makes the link stop working instantly, **without** deleting the gist.
- No gist IDs or raw gist URLs appear in page source or network logs (besides our proxy).
- Size guardrails and errors are user-friendly.

That’s it — ship v1.

## Additional Notes From Implementation

- Secret gists are created and updated with the sharing user’s GitHub OAuth access token (requires `gist` scope); no shared service credential is used.
- Asset discovery keeps every raw reference so query-string variations all rewrite to the canonical gist filenames; binary assets are stored as base64 in the gist and decoded on proxy.
- Share metadata is stored in a JSON-backed file store (`SHARE_STORE_FILE`) that mirrors the existing session-store pattern and supports soft-disable without deleting rows.
- Viewer bundles live under `src/viewer` with a standalone `viewer.html`; Vercel routes `/s/*` directly to the viewer bundle so the main SPA keeps its own routing.
- Share responses apply strict security headers (`Referrer-Policy`, `X-Frame-Options`, and CSP) and CORS now allows both the main app origins and the public viewer origins.

## Current Progress

- Backend endpoints (`POST /api/share/gist`, `GET /api/shares/:id/resolve`, `GET /api/gist-raw`, `DELETE /api/shares/:id`) implemented with gist creation, asset packaging, rate/size guards, and security headers.
- JSON share store, markdown asset utilities, and GitHub gist helper modules added with accompanying unit tests.
- Main SPA now exposes a Share modal and calls the new API; UI wiring includes copy-link UX and styling updates.
- Public viewer bundle renders shared notes, rewrites asset URLs through the proxy, and provides tombstone states for missing/disabled links.
- Documentation updated (`docs/sharing-v1.md`) and Vercel routing adjusted to serve the viewer from `/s/:id`.
