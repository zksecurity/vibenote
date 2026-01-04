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
```
ALLOWED_ORIGINS=https://vibenote.dev,http://localhost:3000
VERCEL_PREVIEW_PATTERN=/^https:\/\/vibenote-[a-z0-9-]+-gregor-mitschabaudes-projects\.vercel\.app$/
```

This regex:
- ✅ Allows all VibeNote preview deployments from your Vercel team
- ✅ Blocks all other `*.vercel.app` deployments
- ✅ Maintains security boundary - only trusted team members can deploy
- ✅ No staging GitHub App needed - can use production backend safely

## Implementation Options

### Option A: Use Production Backend (Recommended)

**Pros:**
- No separate staging infrastructure needed
- No staging GitHub App needed
- Preview deployments test against real data
- Simpler architecture

**Cons:**
- Preview deployments share production user sessions
- Experimental frontend code accesses production backend

**Implementation:**
1. Add team-scoped URL pattern to production backend CORS
2. Configure Vercel environment variable for previews
3. Done!

### Option B: Use Staging Backend (More Isolated)

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
- Added `VERCEL_PREVIEW_PATTERN` constant in `server/src/index.ts:32`
- Updated CORS middleware to allow team-scoped preview URLs
- Updated `returnTo` validation to accept preview URLs

⏳ **Next Steps:**
1. Configure Vercel environment variables (if needed - see below)
2. Deploy backend changes to production
3. Test on a preview deployment
4. Verify OAuth flow works from preview URL

## Vercel Environment Variables

The frontend should already work with preview deployments since it builds with `VITE_VIBENOTE_API_BASE=https://api.vibenote.dev`.

**No Vercel configuration changes needed** - preview deployments will automatically use the production backend, which now allows their origin via the CORS pattern.
