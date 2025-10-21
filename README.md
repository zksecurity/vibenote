# VibeNote

VibeNote is a git-native notes app for hackers who already live in Markdown. Keep everything in a repo you control, edit from any device, let GitHub track the history.

## Use cases

- 📝 Personal notebook: keep notes in a repo you own; install on mobile to take quick notes anywhere.
- 🧭 Team knowledge base without Notion: keep company docs in GitHub, review changes through git history.
- 📚 Quickly publish write-ups: Get a shareable link to any note, like Hackmd but while owning the content.
- 🧪 Engineering notebooks: draft specs, paste snippets, and store diagrams beside the code.

## Why developers pick it

- GitHub stays the source of truth; notes are plain Markdown in your repo.
- Autosync pushes clean commits to `main`, so everyone stays current without branching.
- Deterministic Markdown merges keep conflicts out of your way.
- Repo-style tree and shortcuts make edits and moves quick.
- Share links show the latest Markdown from GitHub—no extra publish step.
- Browser or PWA workspace keeps recent edits handy even if you drop offline.

## How it fits your workflow

Sign in with the GitHub App, choose the repository you want to manage, and VibeNote opens it as a local workspace. Edit as usual—autosync keeps GitHub updated, or trigger a manual sync before a big change or handoff.

The editor provides live Markdown preview with code highlighting and KaTeX, works as an installable PWA, and respects relative asset paths so screenshots and diagrams stay organised in the repo.

## Privacy and control

- Note content lives only in your repo and the browser’s local storage.
- Access tokens stay on-device; the backend just issues short-lived GitHub App tokens.
- Revoke a share link anytime to cut off access immediately.

## 🚀 Try it

Visit [vibenote.dev](https://vibenote.dev), authorise the GitHub App, pick the repo you want to use, and start editing. VibeNote keeps Git in charge while giving you a focused Markdown workspace.
