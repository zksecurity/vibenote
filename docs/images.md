<!-- Worklog for expanding VibeNote to support image assets -->

# Image Support Roadmap

## Current Objectives
- **Step 1 – Sync Foundations**  
  - Broaden local storage metadata (notes + assets) while keeping Markdown helpers intact.  
  - Teach Git sync to track binary asset files (png/jpg/jpeg/webp/gif/svg/avif) end-to-end once the sync module is free to change.  
  - Keep UI limited to Markdown for now by filtering asset entries.
- **Step 2 – Surface Assets in UI**  
  - Expose combined file listings from the data layer.  
  - Render images in the file tree and repo view while preserving existing keyboard + context flows.  
  - Ensure read-only mode and tests behave with mixed file types.
- **Step 3 – Markdown Preview Rendering**  
  - Resolve relative image links inside Markdown previews via cached blobs/object URLs.  
  - Allow safe image sources through DOMPurify and add regression coverage.

## Completed Work
- Local storage now preserves binary file payloads (base64 + MIME) while `listNotes` keeps non-Markdown assets hidden from the UI; helper APIs (`listFiles`, `loadFile`) exposed for upcoming sync/UI steps.

## Decisions
- Image extensions: `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `avif` (confirmed 2025-10-08).  
- Persist full image payloads in localStorage; quota mitigation will be handled by a later effort.

## Open Questions / Risks
- _None._

## Change Log
- 2025-10-08 – Created worklog with initial roadmap.
- 2025-10-08 – Confirmed image extension list and storage approach; noted sync-module change freeze.
- 2025-10-08 – Extended local storage to carry binary assets (including MIME + base64) without surfacing them in note listings yet.
