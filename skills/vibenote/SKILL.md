---
name: vibenote
description: Read and share Markdown notes via VibeNote (git-native notes on GitHub repos). Use when someone shares a vibenote.dev link, or when you need to create/manage shared note links.
metadata:
  skills.sh:
    emoji: 📝
---

# VibeNote Skill

VibeNote is a git-native notes app that renders Markdown from GitHub repos. Notes can be shared via secret links stored directly in the repo.

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

There are two share URL formats. All are client-side rendered — rewrite to the API to fetch content directly.

### Tier 1 — open shares (owner/repo visible in URL)
```
vibenote.dev/s/<owner>/<repo>/<shareId>  →  api.vibenote.dev/v1/git-shares/<owner>/<repo>/<shareId>/content
```

### Tier 2 — opaque shares (repo identity hidden)
```
vibenote.dev/s/<segment>  →  api.vibenote.dev/v1/git-shares/<segment>/content
```
Where `<segment>` is a single 32-char base64url string encoding both repoId (8 bytes) and shareId (16 bytes).

All content endpoints return raw `text/markdown`.

### Example

```
# User sends: https://vibenote.dev/s/BR6IvcSC4zqhpdi7QE4gw5L-1n3N3m-k
# Fetch the content directly:
web_fetch https://api.vibenote.dev/v1/git-shares/BR6IvcSC4zqhpdi7QE4gw5L-1n3N3m-k/content
```

## Creating Git-Native Shares

Shares are plain-text files committed to the `.shares/` folder of the repo. No server interaction required — just a git commit.

```bash
# Content is just the note path (plain text, no JSON)
echo "notes/my-note.md" > .shares/<shareId>
git add .shares/<shareId> && git commit -m "share: notes/my-note.md" && git push
```

The shareId becomes part of the share URL:
- **Tier 1 URL**: `https://vibenote.dev/s/<owner>/<repo>/<shareId>`
- **Tier 2 URL**: requires the repo to have a repoId registered (see below)

### ⚠️ Security: ShareId Entropy is MANDATORY on Private Repos

**ShareIds on private repos MUST be cryptographically random.** This is not optional.

Why: The Tier 1 endpoint (`/v1/git-shares/<owner>/<repo>/<shareId>/content`) is always publicly accessible via the server's GitHub App credentials. If an attacker can guess `owner/repo/shareId`, they can read private note content without credentials.

**Always generate shareIds like this:**
```js
crypto.randomBytes(16).toString('base64url') // 22 chars, 128 bits of entropy
```

Short human-readable shareIds (e.g. `weekly-update`) are only safe on **public repos**.

## Revoking Shares

Delete the `.shares/<shareId>` file and push:

```bash
git rm .shares/<shareId>
git commit -m "revoke share" && git push
```

## Tier 2 Opaque URLs

To use Tier 2 (opaque) share URLs, the repo needs a repoId registered with the server. The repoId is stored as a plain-text file in the repo itself:

```bash
# .shares/.repo-id contains an 11-char base64url string, e.g. "BR6IvcSC4zo"
cat .shares/.repo-id
```

Register it with the server (no auth required — file presence in the repo is proof of write access):

```bash
curl -X POST https://api.vibenote.dev/v1/repo-id \
  -H "Content-Type: application/json" \
  -d '{"repoId":"BR6IvcSC4zo","owner":"zksecurity","repo":"vibenote"}'
```

The opaque URL segment is then `base64url(repoId_bytes[8] || shareId_bytes[16])`, constructable locally without further server calls.

## Share Content API

Base URL: `https://api.vibenote.dev` — all endpoints are unauthenticated.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/git-shares/<owner>/<repo>/<shareId>` | Share metadata (owner field) |
| `GET` | `/v1/git-shares/<owner>/<repo>/<shareId>/content` | Raw markdown of the shared note |
| `GET` | `/v1/git-shares/<owner>/<repo>/<shareId>/assets?path=<rel>` | Assets (images) referenced in the note |
| `GET` | `/v1/git-shares/<segment>` | Tier 2: share metadata |
| `GET` | `/v1/git-shares/<segment>/content` | Tier 2: raw markdown |
| `GET` | `/v1/git-shares/<segment>/assets?path=<rel>` | Tier 2: assets |
| `POST` | `/v1/repo-id` | Register a repoId for Tier 2 opaque URLs |
