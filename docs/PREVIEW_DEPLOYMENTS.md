# Preview Deployments - Security Model & Setup

## Threat Model

The main risk is a malicious `*.vercel.app` deployment that tricks users into
signing in and then receives their OAuth session/access tokens. With those tokens,
an attacker can read/write repos, create shares, and exfiltrate notes of other users.

We defend against this by only allowing a small set of GitHub users to authenticate
from preview origins. Everyone else is blocked at the OAuth callback.

## Why URL Patterns Are Not a Security Boundary

Preview URLs are not cryptographically protected. Regex-based allowlists are
useful to limit accidental exposure but can be mis-scoped or bypassed if you
choose a weak pattern. They are not sufficient on their own.

We still use a team-scoped regex to prevent obvious mistakes, but the actual
security boundary is the GitHub user allowlist.

### Vercel URL Structure

According to [Vercel's documentation](https://github.com/vercel/vercel/discussions/6045), preview deployments get URLs in this format:

```
{project-name}-{deployment-id}-{team-slug}.vercel.app
{project-name}-git-{branch-name}-{team-slug}.vercel.app
```

**Example** (project `vibenote`, team `gregor-mitschabaudes-projects`):

- `vibenote-abc123xyz-gregor-mitschabaudes-projects.vercel.app`
- `vibenote-git-main-gregor-mitschabaudes-projects.vercel.app`
- `vibenote-git-fix-auth-gregor-mitschabaudes-projects.vercel.app`

### Team Suffix Attack

A naive regex like `vibenote-[a-z0-9-]+-gregor-mitschabaudes-projects.vercel.app`
can be tricked by a suffix team name. The safe pattern avoids hyphens in the
deployment id segment and requires `git-` for branch deploys:

```regex
^https:\/\/vibenote-(git-[a-z0-9-]+|(?!git-)[a-z0-9]+)-gregor-mitschabaudes-projects\.vercel\.app$
```

## Security Model

### Core Rule

- Preview origins are **allowed to authenticate only if the GitHub login is on
  `PREVIEW_ALLOWED_GITHUB_USERS`**.
- Production origins (`ALLOWED_ORIGINS`) allow all authenticated users.

### Why This Works

Even if an attacker hosts a malicious `*.vercel.app` app:

1. They can reach the OAuth endpoints.
2. The callback will reject them unless their GitHub login is allowlisted.
3. Tokens are never posted back to the malicious origin.

### What This Does Not Protect Against

- Allowlisted users can still be phished. If you are on the allowlist, you must
  treat preview URLs with extra care.

## Callback & Refresh Flow (How It Enforces the Allowlist)

1. `/v1/auth/github/start` validates `returnTo` against `ALLOWED_ORIGINS` and
   `PREVIEW_URL_PATTERN`, then signs it into the OAuth state.
2. `/v1/auth/github/callback` requires `returnTo` to be an absolute URL and uses
   its origin to decide preview vs production.
3. If the origin is a preview origin, the GitHub login must be on the allowlist,
   otherwise the callback returns an Unauthorized page.
4. `/v1/auth/github/refresh` uses the request `Origin` header to enforce the same
   allowlist rule for preview origins.

## Single Backend Instance

Run one backend for both production and preview:

```
api.vibenote.dev → single backend instance
  ├─ Production requests (vibenote.dev) → no user allowlist
  └─ Preview requests (*.vercel.app)     → allowlist enforced
```

## Configuration

### `PREVIEW_URL_PATTERN` (Required for preview deployments)

- If not set: preview deployments are blocked (fail-safe).
- Must match your project and team slug.

Example:

```bash
PREVIEW_URL_PATTERN=^https:\/\/vibenote-(git-[a-z0-9-]+|(?!git-)[a-z0-9]+)-your-vercel-team-slug\.vercel\.app$
```

### `PREVIEW_ALLOWED_GITHUB_USERS` (Required for preview deployments)

- Comma-separated GitHub usernames allowed to authenticate from preview origins.
- If unset or empty: preview authentication is denied.

Example:

```bash
PREVIEW_ALLOWED_GITHUB_USERS=your-github-username,other-dev
```

## Vercel Environment Variables

Configure in Vercel Dashboard → Project Settings → Environment Variables:

| Variable                 | Value                      | Environment |
| ------------------------ | -------------------------- | ----------- |
| `VITE_VIBENOTE_API_BASE` | `https://api.vibenote.dev` | Preview     |
| `VITE_VIBENOTE_API_BASE` | `https://api.vibenote.dev` | Production  |

Both environments talk to the same backend; the backend decides preview vs
production based on the request origin and the signed `returnTo` on callback.
