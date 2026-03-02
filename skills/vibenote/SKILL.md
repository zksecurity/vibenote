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

Shared note links look like: `https://vibenote.dev/s/<share-id>`

These pages are client-side rendered (React) and return empty HTML to `web_fetch`. To read the content, rewrite the URL to the API endpoint:

```
vibenote.dev/s/<share-id>  →  api.vibenote.dev/v1/share-links/<share-id>/content
```

The API returns raw `text/markdown`.

### Example

```
# User sends: https://vibenote.dev/s/-0Fgm7cnqd8yZCfnULdY9oO5
# Fetch this instead:
web_fetch https://api.vibenote.dev/v1/share-links/-0Fgm7cnqd8yZCfnULdY9oO5/content
```

## Share Link API

Base URL: `https://api.vibenote.dev`

All mutating endpoints require a VibeNote session JWT in the `Authorization: Bearer <token>` header. Currently there is no programmatic auth — share creation must be done through the VibeNote web UI.

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
  "owner": "mitschabaude-bot",
  "repo": "audit-scoping",
  "path": "SCOPE-stwo-cairo-hedwig.md",
  "branch": "main"
}
```

Response includes the share `url` field with the public link.
