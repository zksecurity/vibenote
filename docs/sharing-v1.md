# Sharing v1 – Operational Notes

## Environment Variables

- `PUBLIC_VIEWER_BASE_URL` – Base URL for the public viewer (e.g. `https://public.vibenote.dev`). Used when building share links.
- `PUBLIC_VIEWER_ORIGINS` – Comma separated list of origins allowed to call the viewer endpoints (defaults to `http://localhost:5173`).
- `SHARE_STORE_FILE` – Path to the JSON file that stores share metadata. Defaults to `./server/data/shares.json`.
- Gists are created with the sharing user’s own `gist`-scoped access token (no global service token required).

## Size Limits

- Note markdown: 2&nbsp;MiB max.
- Assets: up to 24 unique files, capped at 8&nbsp;MiB combined. Binary assets are stored base64-encoded in the gist and decoded on proxy.

## Updates

- Shares belong to the creator’s GitHub account. When the note text changes, the frontend debounces and pushes the new markdown to the gist so viewers always see the latest version without re-sharing.

## Expiry & Revocation

- Shares can optionally include an expiry date. A background task marks expired shares as disabled hourly.
- Deleting a share via `DELETE /api/shares/:id` disables the link immediately but does not delete the underlying gist.

## Viewer

- Served from `viewer.html` with its own bundle under `src/viewer/*`.
- Resolves share metadata via `GET /api/shares/:id/resolve` and loads markdown through the `/api/gist-raw` proxy.
- All markdown rendering goes through the shared `renderMarkdown` pipeline (DOMPurify + marked + KaTeX) to match the main app.

## Security

- Viewer and API responses set `Referrer-Policy: no-referrer` via client-side meta update (backend also enforces headers).
- CORS whitelists public viewer origins for share-related endpoints while retaining existing app origins.
- `/api/gist-raw` only serves files declared in the share metadata and rewrites markdown asset URLs to stay under our proxy.

## Telemetry Hooks

- TODO: For v1 we log at INFO when links are created or revoked. Counter metrics (`share_created`, `share_viewed`, `share_revoked`) should be wired into the future telemetry service once available.
