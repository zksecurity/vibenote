# Preview Deployments - Security Analysis & Implementation Plan

## Security Concern

Allowing `*.vercel.app` in CORS would be **catastrophic** because:
- Anyone can deploy arbitrary code to `evil-app.vercel.app`
- Malicious app could call our backend's OAuth endpoints
- Our backend would return auth tokens to the attacker's origin
- Attacker gains full read/write access to all repos where GitHub App is installed

## Secure Solution: Team-Scoped URL Patterns

### Vercel URL Structure

According to [Vercel's documentation](https://github.com/vercel/vercel/discussions/6045), preview deployments get URLs in this format:

```
{project-name}-{deployment-id}-{team-slug}.vercel.app
{project-name}-git-{branch-name}-{team-slug}.vercel.app
```

**Example:** For project `vibenote` on team `gregor-mitschabaudes-projects`:
- `vibenote-abc123xyz-gregor-mitschabaudes-projects.vercel.app` (deployment-specific)
- `vibenote-git-main-gregor-mitschabaudes-projects.vercel.app` (git branch-based)
- `vibenote-git-fix-auth-gregor-mitschabaudes-projects.vercel.app` (PR branch)

### Why This is Secure

**Team slugs are globally unique on Vercel** ([source](https://vercel.com/docs/rest-api/reference/endpoints/teams/get-a-team)):
- Only members of the `gregor-mitschabaudes-projects` team can create deployments matching `*-gregor-mitschabaudes-projects.vercel.app`
- Attackers cannot register a duplicate team slug
- Attackers cannot deploy to URLs matching our pattern

**CORS Restriction:**
```regex
/^https:\/\/vibenote-(git-[a-z0-9-]+|[a-z0-9]+)-gregor-mitschabaudes-projects\.vercel\.app$/
```

This regex:
- ✅ Allows git branch deploys: `vibenote-git-{branch}-gregor-mitschabaudes-projects.vercel.app`
- ✅ Allows deployment deploys: `vibenote-{id}-gregor-mitschabaudes-projects.vercel.app`
- ✅ Blocks team-suffix attacks (see security note below)
- ✅ Blocks all other `*.vercel.app` deployments
- ✅ No staging GitHub App needed - can use production backend safely

**Security Note - Team Suffix Attack:**

A naive regex like `vibenote-[a-z0-9-]+-gregor-mitschabaudes-projects.vercel.app` would be vulnerable to:
- Attacker creates team `mitschabaudes-projects` (a suffix of the real team)
- Attacker creates project `vibenote-abc-gregor`
- Resulting URL: `vibenote-abc-gregor-{id}-mitschabaudes-projects.vercel.app`
- This would match the naive regex! ❌

The fix is to restrict the middle segment:
- For git deploys: literal `git-` prefix prevents ambiguity
- For deployment IDs: no hyphens allowed (`[a-z0-9]+` only)
- This ensures the team slug cannot be split across segments ✅

## Security Model: Defense in Depth

The backend **automatically detects** whether it's running in staging or production mode based on the `ALLOWED_GITHUB_USERS` environment variable:

### Staging Mode (ALLOWED_GITHUB_USERS is set)
- ✅ Allows Vercel preview deployments in CORS
- ✅ Enforces GitHub user allowlist (actual security boundary)
- ✅ Only approved developers can authenticate

### Production Mode (ALLOWED_GITHUB_USERS not set)
- ✅ Strict CORS (only `ALLOWED_ORIGINS`)
- ✅ Does NOT allow Vercel preview patterns
- ✅ All authenticated users allowed

**Two layers of defense (staging mode only):**

### Layer 1: CORS URL Pattern Validation
- Regex validates preview URLs match your team pattern
- Blocks casual attacks and unauthorized origins
- **Not cryptographically secure** (suffix attacks possible)

### Layer 2: GitHub User Allowlist ✅ (Actual Security Boundary)
- Backend validates authenticated GitHub username
- Only approved developers can access repos through VibeNote
- Works even if attacker bypasses CORS

**Why this works:**
Even if an attacker:
1. ✅ Crafts a team-suffix collision URL
2. ✅ Bypasses CORS validation
3. ✅ Completes OAuth flow
4. ❌ **Gets blocked** - they're not on the developer allowlist

**Single Instance, Dual Mode:**
You can run **one backend instance** that serves both production and staging:
- Production config: `ALLOWED_GITHUB_USERS` unset → strict mode
- Staging config: `ALLOWED_GITHUB_USERS=user1,user2` → preview mode with allowlist

---

## Implementation Options

### Option A: Single Backend Instance (Recommended) ✅

Run **one backend codebase** with different configurations for production and staging:

**Deployment Architecture:**
```
Production:  api.vibenote.dev          → backend (no ALLOWED_GITHUB_USERS)
Staging:     api-staging.vibenote.dev  → same backend code (with ALLOWED_GITHUB_USERS)
```

**Pros:**
- Single codebase to maintain
- Backend auto-detects mode based on environment variable
- Production stays secure (strict CORS, no preview URLs)
- Staging allows preview deployments (with user allowlist)
- Can run both on same VPS (different ports) or separate instances

**Cons:**
- Need to deploy backend twice (once for prod, once for staging)
- Requires separate staging GitHub App

**Implementation:**
1. Deploy backend to production: `api.vibenote.dev` (existing setup, no changes)
2. Deploy same backend code to staging: `api-staging.vibenote.dev`
3. Create staging GitHub App with callback: `https://api-staging.vibenote.dev/v1/auth/github/callback`
4. Configure staging backend `.env`:
   ```bash
   ALLOWED_GITHUB_USERS=your-github-username,other-dev
   GITHUB_APP_SLUG=vibenote-app-staging
   GITHUB_APP_ID=<staging-app-id>
   # ... staging GitHub App credentials
   ```
5. Configure Vercel environment variables (preview deployments use staging)

### Option B: Separate Backend Codebases (Not Recommended)

Maintain separate production and staging backends with different code.

**Cons:**
- Code duplication
- Harder to keep in sync
- Requires separate staging GitHub App
- More maintenance overhead

**Implementation:**
1. Deploy staging backend at `api-staging.vibenote.dev`
2. Create staging GitHub App with staging callback URLs
3. Configure staging backend with team-scoped CORS pattern
4. Configure Vercel to use staging backend for previews

## Configuration

**Vercel Details:**
- Project name: `vibenote`
- Team slug: `gregor-mitschabaudes-projects`
- Team URL: https://vercel.com/gregor-mitschabaudes-projects/vibenote

## Implementation Status

✅ **Backend Changes Complete:**
- Added mode detection (`isStagingMode`) based on `ALLOWED_GITHUB_USERS` env var
- Added `VERCEL_PREVIEW_PATTERN` constant (only used in staging mode)
- Updated CORS middleware with conditional preview URL validation
- Updated `returnTo` validation with conditional preview URL validation
- Added `ALLOWED_GITHUB_USERS` env variable (`server/src/env.ts:11`)
- Added user allowlist validation in OAuth callback (`server/src/api.ts:46`)
- Added user allowlist validation in session refresh (`server/src/api.ts:129`)
- Added startup logging showing mode and allowed users

**How it works:**
- Production: No `ALLOWED_GITHUB_USERS` → strict CORS, all users allowed
- Staging: `ALLOWED_GITHUB_USERS` set → allows preview URLs, enforces user allowlist

⏳ **Next Steps for Staging Deployment:**
1. Deploy same backend code to `api-staging.vibenote.dev` (or separate port on VPS)
2. Create staging GitHub App with callback: `https://api-staging.vibenote.dev/v1/auth/github/callback`
3. Configure staging `.env`:
   ```bash
   # This env var enables staging mode
   ALLOWED_GITHUB_USERS=your-github-username,other-dev

   # Staging GitHub App credentials
   GITHUB_APP_SLUG=vibenote-app-staging
   GITHUB_APP_ID=<staging-app-id>
   GITHUB_APP_PRIVATE_KEY=<staging-pem>
   GITHUB_OAUTH_CLIENT_ID=<staging-client-id>
   GITHUB_OAUTH_CLIENT_SECRET=<staging-secret>

   # Separate session/share stores
   SESSION_STORE_FILE=./server/data/sessions-staging.json
   SHARE_STORE_FILE=./server/data/shares-staging.json

   # Generate new secrets
   SESSION_JWT_SECRET=<generate-new>
   SESSION_ENCRYPTION_KEY=<generate-new>
   GITHUB_WEBHOOK_SECRET=<generate-new>
   ```
4. Configure Vercel environment variable:
   - `VITE_VIBENOTE_API_BASE=https://api-staging.vibenote.dev` (Preview environment)
5. Restart staging backend - you should see log: `[mode: staging (user allowlist enabled)]`
6. Test on a preview deployment

## Vercel Environment Variables

Configure in Vercel Dashboard → Project Settings → Environment Variables:

| Variable | Value | Environment |
|----------|-------|-------------|
| `VITE_VIBENOTE_API_BASE` | `https://api-staging.vibenote.dev` | Preview |
| `VITE_VIBENOTE_API_BASE` | `https://api.vibenote.dev` | Production |

This ensures:
- Preview deployments connect to staging backend (with user allowlist)
- Production deploys connect to production backend (all users allowed)
