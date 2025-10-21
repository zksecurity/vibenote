<!-- Worklog for expanding VibeNote to support image assets -->

# Image Support Roadmap

> Status: This roadmap was completed on 2025-10-10 and is now archived here for reference only.

## Current Objectives

- **Step 1 – Sync Foundations**
  - ~~Broaden local storage metadata (notes + assets) while keeping Markdown helpers intact.~~
  - ~~Teach Git sync to track binary asset files (png/jpg/jpeg/webp/gif/svg/avif) end-to-end once the sync module is free to change.~~
  - ~~Keep UI limited to Markdown for now by filtering asset entries.~~
  - ~~Fold Markdown-first helpers so they operate on the shared file types (first up: unify LocalStore actions like create/rename/delete to stop branching on note vs asset).~~
- **Step 2 – Surface Assets in UI**
  - Expose combined file listings from the data layer.
  - Render images in the file tree and repo view while preserving existing keyboard + context flows.
  - Ensure read-only mode and tests behave with mixed file types.
- **Step 3 – Markdown Preview Rendering**
  - ~~Resolve relative image links inside Markdown previews via cached blobs/object URLs.~~
- **Final Step - Cleanup**
  - Remove the `mime` property everywhere and push it down into the only place that needs it (`buildPreviewUrl`)

## Completed Work

- Local storage now preserves binary file payloads (base64 + MIME) while `listNotes` keeps non-Markdown assets hidden from the UI; helper APIs (`listFiles`, `loadFile`) exposed for upcoming sync/UI steps.
- Git sync now lists/pulls/pushes tracked image assets alongside Markdown while retaining merge behaviour for notes only; regression tests cover the new flows.
- Data layer surfaces combined file metadata (markdown + images) to consumers, while UI continues filtering to notes for now.
- Repo sidebar now derives entries from the combined file list (showing extensions) while binary selections open an interim asset viewer placeholder; added regression coverage for mixed file state.
- Sync now prefers lightweight blob placeholders for private assets and rehydrates content on demand (no more tokenised URLs or redundant storage); multi-device tests cover rename/merge scenarios.
- Asset Viewer fetches private images via blob placeholders and presents download-ready previews without caching large payloads locally.
- Markdown previews now resolve repo-relative image links through a shared blob/data URL cache, covering URL-encoded filenames and GitHub blob placeholders while avoiding broken SPA fetches; regression tests exercise binary, pointer, and malformed link scenarios.

## Decisions

- Image extensions: `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `avif` (confirmed 2025-10-08).
- Persist full image payloads in localStorage; quota mitigation will be handled by a later effort.

## Open Questions / Risks

- _None._

## Change Log

- 2025-10-08 – Created worklog with initial roadmap.
- 2025-10-08 – Confirmed image extension list and storage approach; noted sync-module change freeze.
- 2025-10-08 – Extended local storage to carry binary assets (including MIME + base64) without surfacing them in note listings yet.
- 2025-10-08 – Wired Git sync to treat images as binary assets end-to-end and added coverage for asset pulls/restores.
- 2025-10-08 – Plumbed file-level metadata through repo data hook, keeping UI filtered pending next step.
- 2025-10-08 – Sidebar consumes the generalized file list and new tests guard mixed markdown/image repos.
- 2025-10-09 – Unified repo file types (metadata + docs) under shared `FileMeta`/`RepoFile` while keeping storage format backward compatible.
- 2025-10-09 – Consolidated local storage rename/update flows and taught sync rename detection to treat binary assets the same as markdown notes.
- 2025-10-09 – Data layer now consumes the unified file APIs so UI actions no longer branch between note and asset helpers.
- 2025-10-10 – Removed all remaining inconsistencies between the handling of assets and markdown files.
- 2025-10-10 – Markdown previews reuse shared asset blobs, sanitise relative `<img>` tags, and ship regression coverage for encoded filenames and malformed paths.
