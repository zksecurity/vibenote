# VibeNote

VibeNote is a Git-native notes app for people who already live in Markdown. Connect a repository, write anywhere (desktop, mobile, or offline), and let VibeNote keep your notes and Git history perfectly in sync.

## What makes VibeNote special

- 🔁 **GitHub stays the source of truth** – your notes are plain Markdown files in your repo, never copied to VibeNote’s servers.
- ⚡ **Offline-first editing** – every keystroke is stored locally, background sync catches up the moment you’re back online, and a service worker flushes pending edits even when you close the tab.
- 🤝 **Automatic merge resolution** – Markdown conflicts are reconciled with a CRDT merge engine, so you’ll never stare at Git conflict markers again.
- 🗂️ **Real repo navigation** – browse folders, rename, move, or delete notes with keyboard shortcuts; relative image paths and attached assets just work.
- 📤 **Instant sharing** – create or revoke unlisted share links that always show the latest GitHub version in a polished reader.

## How syncing actually works

1. Sign in with the VibeNote GitHub App to grant per-repo access using your own GitHub identity.
2. VibeNote pulls the latest files directly from GitHub and keeps a local, offline-capable workspace in your browser.
3. Edit freely; autosync can run in the background after edits or you can trigger “Sync now” for an immediate push. Each sync summarizes what changed.
4. Merges happen automatically. Y.js powers deterministic three-way merges for Markdown, while binary assets and rename/delete tombstones keep the repo tidy.

Because commits go straight from your browser to GitHub, there’s no additional server storing document content—only short-lived tokens and share metadata ever touch VibeNote’s backend.

## Built for deep work

- Live Markdown preview with KaTeX math, code highlighting, and secure sanitisation so you can embed diagrams and equations confidently.
- Inline asset handling resolves relative images, previews binaries, and lets you download attachments without leaving the app.
- A repo switcher (⌘K / Ctrl+K) and recent list make jumping between projects instant.
- Read-only mode lets you browse public repositories without linking them first—ideal for quick reference checks.
- Installable Progressive Web App with precached shell, so VibeNote feels native on desktop or mobile and launches offline.

## Share what matters

- One click surfaces an unlisted link for the current note.
- Shared pages render the latest Markdown straight from GitHub, rewriting relative assets so screenshots and diagrams load reliably.
- Revoke links anytime; viewers see an immediate tombstone if access is removed.

## Privacy & trust

- Notes live in two places only: your GitHub repository and your browser.
- Access tokens stay in local storage and refresh silently; VibeNote’s backend just mints GitHub App tokens and stores encrypted session metadata.
- Share metadata is minimal: an ID, repo, path, and who created it. No note content is persisted by VibeNote.

## Try VibeNote today

Head over to [vibenote.dev](https://vibenote.dev) and:

1. Connect your GitHub account via the built-in OAuth popup.  
2. Pick an existing notes repo (or create one) and let VibeNote import it.  
3. Edit, organise, and drop images just like you would in your IDE—with autosync keeping GitHub updated.  
4. Flip on autosync for hands-free background updates or hit “Sync now” before you step away.  

Ready to see your Markdown notes live where they belong? Open [vibenote.dev](https://vibenote.dev), link a repo, and enjoy frictionless Git-backed note taking. ✨
