---
name: vibenote
description: Read and share Markdown notes via VibeNote (git-native notes on GitHub repos). Use when someone shares a vibenote.dev link, or when you need to create/manage shared note links.
metadata:
  skills.sh:
    emoji: 📝
---

# VibeNote Skill

VibeNote is a git-native notes app that renders Markdown from GitHub repos. Notes can be shared via secret links.

## Working with Notes (Read/Write)

VibeNote notes are just Markdown files in a GitHub repo. For typical interactions — reading, editing, creating notes — **clone the repo and work with it directly via git**:

```bash
git clone git@github.com:owner/repo.git
# read/edit .md files
git add -A && git commit -m "update notes" && git push
```

VibeNote will pick up changes automatically on the next sync.

**Important**: VibeNote only shows the `main` branch. Always commit and push to `main` — work on other branches won't be visible in the app.

## Reading Shared Notes

There are three share URL formats. All are client-side rendered — rewrite to the API to fetch content.

### Legacy shares (old format)
```
vibenote.dev/s/<share-id>  →  api.vibenote.dev/v1/share-links/<share-id>/content
```

### Git-native Tier 1 (open shares — owner/repo/token visible in URL)
```
vibenote.dev/s/<owner>/<repo>/<shareId>  →  api.vibenote.dev/v1/git-shares/<owner>/<repo>/<shareId>/content
```

### Git-native Tier 2 (encrypted shares — opaque URL, repo identity hidden)
```
vibenote.dev/s/<repoId>/<blob>  →  api.vibenote.dev/v1/git-shares/enc/<repoId>/<blob>/content
```

All content endpoints return raw `text/markdown`.

### Example

```
# User sends: https://vibenote.dev/s/-0Fgm7cnqd8yZCfnULdY9oO5
# Fetch this instead:
web_fetch https://api.vibenote.dev/v1/share-links/-0Fgm7cnqd8yZCfnULdY9oO5/content
```

## Creating Git-Native Shares

Shares are created by committing a JSON descriptor to `.shares/` in the repo:

```json
// .shares/<shareId>.json
{ "path": "notes/my-note.md" }
```

The token becomes part of the share URL. **See the security rules below before choosing a token.**

For encrypted (Tier 2) shares, the repo must have a key registered. The share URL is then constructed by encrypting `{owner, repo, token}` with AES-256-GCM using the repo key.

### ⚠️ Security: Token Entropy is MANDATORY on Private Repos

**Tokens on private repos MUST be cryptographically random, regardless of whether Tier 2 encryption is set up.** This is not optional.

Why: The Tier 1 endpoint (`/v1/git-shares/<owner>/<repo>/<shareId>/content`) is always available. It uses the server's GitHub App credentials — not yours. If an attacker can guess `owner/repo` and `token`, they can:
1. Confirm the private repo exists (GitHub deliberately hides this)
2. Read the note content without any credentials

Tier 2 encryption hides the token inside the encrypted URL, but the token is still a plaintext filename in `.shares/` in the repo. Tier 1 is always open. Encryption does not close this gap.

**Always generate tokens like this:**
```js
crypto.randomBytes(18).toString('base64url') // 24 chars, 144 bits
```

Short human-readable tokens (e.g. `weekly-update`) are only safe on **public repos**, where the content is already public.

## Share Link API

Base URL: `https://api.vibenote.dev`

All mutating endpoints require a VibeNote session JWT in the `Authorization: Bearer <shareId>` header. Currently there is no programmatic auth — share creation must be done through the VibeNote web UI.

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/v1/share-links/:id/content` | None | Raw markdown of a shared note |
| `GET` | `/v1/share-links/:id/assets?path=<relative>` | None | Assets (images) referenced in a shared note |
| `GET` | `/v1/share-links/:id` | None | Share metadata (id, creator login) |
| `POST` | `/v1/shares` | Session | Create a share link |
| `GET` | `/v1/shares?owner=&repo=&path=` | Session | Look up existing share for a note |
| `DELETE` | `/v1/shares/:id` | Session | Revoke a share link |

### Create Share Body (POST /v1/shares)

```json
{
  "owner": "acme-org",
  "repo": "team-notes",
  "path": "notes/weekly-update.md",
  "branch": "main"
}
```

Response includes the share `url` field with the public link.
