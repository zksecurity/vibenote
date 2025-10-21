# RFC: Paste Images into Markdown Notes

## Summary
- Capture image files from clipboard paste events in the note editor.
- Persist pasted images as binary assets in a shared `assets/` folder within the connected repository.
- Automatically insert Markdown image references that point to the newly created asset file using a relative path.

## Goals
- Allow users to paste screenshots or images directly into an open Markdown note without leaving VibeNote.
- Ensure pasted assets are stored consistently inside a single repo-level folder so they are easy to find and share.
- Make the experience work offline-first: assets land in local storage immediately and sync on the next GitHub push.
- Keep the feature type-safe and test-covered across editor, storage, and sync layers.

## Non-Goals
- Drag-and-drop uploads (separate follow-up).
- Image editing, cropping, or compression beyond the clipboard payload.
- Deduplicating identical pasted images across notes.
- Letting users pick a custom asset folder per note (the UX requirement calls for one shared folder).

## Background
Markdown notes already render relative image links by resolving repo assets through `useRepoAssetLoader` and the asset preview cache. Binary assets are synced end-to-end, and `docs/images.md` tracks the broader image support roadmap. Today, authors must create image files manually and write Markdown links by hand. Removing that friction will make screenshots and diagram sharing far smoother.

## User Flow
1. User copies an image (e.g., OS screenshot) and focuses a Markdown note in the editor.
2. On paste, VibeNote detects image blobs on the clipboard.
3. The app saves each image into `assets/` using an auto-generated filename and path.
4. VibeNote inserts Markdown like `![Pasted image 2025-10-21](../assets/pasted-image-20251021-1.png)` at the caret.
5. The preview immediately renders via the existing asset loader. The asset syncs with GitHub during the next sync cycle.

## Technical Proposal

### Clipboard Capture in `Editor`
- Attach an `onPaste` listener to the `<textarea>` editor.
- Walk `event.clipboardData.items`, collect entries where `kind === 'file'` and MIME matches the tracked image extensions.
- Prevent default behavior only when we have at least one supported image; otherwise fall back to normal paste.
- Convert each `File` to a base64 payload via `File.arrayBuffer()` → `Uint8Array` → base64 helper (new shared utility).
- Hand off the payload(s) to a new repo action that persists assets and returns their repo paths. Insert Markdown snippets at the caret position in order of processing.

### Asset Creation Pipeline
- Extend `useRepoData` actions with `importPastedAssets(params)` that:
  - Normalizes the common folder path, defaulting to `assets/`.
  - Generates filenames using `pasted-image-<yyyyMMdd-HHmmss>-<short-id>.<ext>`.
  - Calls `RepoStore.createFile(path, base64, { kind: 'binary' })`.
  - Records the resulting `FileMeta` so the UI updates instantly.
  - Returns `{ assetPath, markdownPath }` per image so the editor can form relative links.
- Add a helper to compute the relative Markdown path from the note’s directory to `assets/<file>`, reusing `normalizePath` and `extractDir`.
- Defer sync; the next manual or auto sync will upload the binary.

### Shared Asset Folder
- Use a constant `COMMON_ASSET_DIR = 'assets'`.
- Ensure the directory exists in local folder metadata by reusing `ensureFolderForSlug`.
- Future enhancements (opt-in subfolders) can extend this constant or pull from settings; not part of this RFC.

### Markdown Insertion
- Editor receives the caret index and current text. For each inserted asset, it constructs `![Pasted image <timestamp>](<relativePath>)`.
- Use double newlines before and after when pasting into non-empty content so the Markdown stays readable.
- After insertion, move the caret after the final closing parenthesis to let the user continue typing.

### Offline and Sync Considerations
- Asset creation touches only local storage, so it works offline. Sync tombstones already cover binaries; no new schema needed.
- `syncBidirectional` already treats `binary` files correctly, so no protocol changes.
- When auto-sync is enabled, new assets will be pushed alongside note edits, preserving relative paths.

### Accessibility & UX
- Default alt text: `Pasted image <ISO date>`; users can edit immediately.
- If multiple images are pasted, enumerate with suffixes (`…-1`, `…-2`).
- Surface toast/status message via existing `statusMessage` to confirm assets were created (optional but recommended).

## Implementation Plan
- `src/ui/Editor.tsx`: add `onPaste` handler, caret-aware Markdown insertion, and loading state guard.
- `src/ui/Editor.test.tsx`: cover image paste flows, relative path computation, and ensure plain-text paste still works.
- `src/data.ts`: expose `importPastedAssets` action, wire it into Repo actions, and keep type safety.
- `src/storage/local.ts`: add a helper for writing binary assets (likely just reuse `createFile` with `kind: 'binary'`) and ensure folder metadata includes `assets/`.
- `src/lib/pathing.ts` (new) or existing util: add `relativePath(from, to)` helper for Markdown references.
- `src/lib/files.ts` (new) or similar: add `fileToBase64` utility shared between editor and tests.
- `src/data/data.test.ts`: add coverage for `importPastedAssets` ensuring index updates and metadata correctness.
- `src/sync/git-sync.test.ts`: add regression covering newly created assets syncing after paste.
- `docs/images.md`: update roadmap to mark “paste support” in progress.
- `docs/paste-images.md`: keep this RFC updated (progress section below).

## Testing Strategy
- **Unit**: Editor paste handler (simulate DataTransfer with image blobs); path helper; filename generator uniqueness.
- **Data layer**: Verify `importPastedAssets` writes binary files, updates folders, and returns expected paths.
- **Integration**: Git sync regression ensuring pasted assets publish on next sync and Markdown references remain intact.
- **Manual smoke**: Paste screenshot on desktop + mobile Safari/Chrome; confirm preview renders and sync commit includes asset + note.

## Risks & Open Questions
- Clipboard API inconsistencies on iOS Safari—needs manual validation; fall back to letting the OS paste an `<img>` tag if detection fails.
- Large images could inflate localStorage quickly; follow-up work may need quotas or warnings.
- Handling name collisions: plan uses timestamp + random suffix; probability of conflict is negligible but we should log and retry if needed.

## Progress Tracker
- [ ] Align on filename and folder conventions.
- [ ] Ship core clipboard handler in the editor.
- [ ] Implement repo action + storage plumbing.
- [ ] Add automated tests across UI/data/sync layers.
- [ ] Validate on desktop + mobile browsers.
- [ ] Update documentation and mark feature complete.
