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

The secure implementation uses **two layers of defense**:

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

**Configuration:**
```bash
# Staging backend .env
ALLOWED_GITHUB_USERS=mitscherlich,other-dev-username
```

If unset (production), all users are allowed.

---

## Implementation Options

### Option A: Staging Backend with User Allowlist (Recommended) ✅

**Pros:**
- **Actually secure** - user allowlist is the real security boundary
- Can install staging GitHub App on any repo (even production repos for testing)
- Only approved developers can access those repos
- Preview deployments isolated from production
- Can test backend changes alongside frontend changes

**Cons:**
- Requires separate staging infrastructure
- Requires separate staging GitHub App
- More maintenance overhead

**Implementation:**
1. Deploy staging backend at `api-staging.vibenote.dev`
2. Create staging GitHub App with staging callback URLs
3. Configure staging backend with:
   - Team-scoped CORS pattern (defense in depth)
   - `ALLOWED_GITHUB_USERS=mitscherlich,other-dev` (actual security)
4. Configure Vercel to use staging backend for previews

### Option B: Production Backend (Not Recommended)

**Pros:**
- Preview deployments isolated from production
- Can test backend changes together with frontend changes
- Safer for experimental features

**Cons:**
- Requires separate backend infrastructure
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
- Added `VERCEL_PREVIEW_PATTERN` constant in `server/src/index.ts:33`
- Updated CORS middleware to allow team-scoped preview URLs
- Updated `returnTo` validation to accept preview URLs
- Added `ALLOWED_GITHUB_USERS` env variable (`server/src/env.ts:11`)
- Added user allowlist validation in OAuth callback (`server/src/api.ts:46`)
- Added user allowlist validation in session refresh (`server/src/api.ts:129`)

⏳ **Next Steps for Staging Backend:**
1. Deploy staging backend at `api-staging.vibenote.dev` (or subdirectory)
2. Create staging GitHub App with staging callback URL
3. Configure staging backend `.env`:
   ```bash
   ALLOWED_GITHUB_USERS=your-github-username,other-dev
   ALLOWED_ORIGINS=http://localhost:3000,https://vibenote.dev,https://*.vercel.app
   GITHUB_APP_SLUG=vibenote-app-staging
   GITHUB_APP_ID=<staging-app-id>
   GITHUB_APP_PRIVATE_KEY=<staging-pem>
   GITHUB_OAUTH_CLIENT_ID=<staging-client-id>
   GITHUB_OAUTH_CLIENT_SECRET=<staging-secret>
   # ... other secrets
   ```
4. Configure Vercel environment variable:
   - `VITE_VIBENOTE_API_BASE=https://api-staging.vibenote.dev` (Preview environment)
5. Test on a preview deployment

## Vercel Environment Variables

Configure in Vercel Dashboard → Project Settings → Environment Variables:

| Variable | Value | Environment |
|----------|-------|-------------|
| `VITE_VIBENOTE_API_BASE` | `https://api-staging.vibenote.dev` | Preview |
| `VITE_VIBENOTE_API_BASE` | `https://api.vibenote.dev` | Production |

This ensures:
- Preview deployments connect to staging backend (with user allowlist)
- Production deploys connect to production backend (all users allowed)
