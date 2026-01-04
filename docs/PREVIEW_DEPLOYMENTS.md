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

**Example:** For project `vibenote` on team `zksecurity`:
- `vibenote-abc123xyz-zksecurity.vercel.app` (deployment-specific)
- `vibenote-git-main-zksecurity.vercel.app` (git branch-based)
- `vibenote-git-fix-auth-zksecurity.vercel.app` (PR branch)

### Why This is Secure

**Team slugs are globally unique on Vercel** ([source](https://vercel.com/docs/rest-api/reference/endpoints/teams/get-a-team)):
- Only members of the `zksecurity` team can create deployments matching `*-zksecurity.vercel.app`
- Attackers cannot register a duplicate team slug
- Attackers cannot deploy to URLs matching our pattern

**CORS Restriction:**
```
ALLOWED_ORIGINS=https://vibenote.dev,http://localhost:3000
ALLOWED_ORIGIN_PATTERN=^https://vibenote-[a-z0-9-]+-zksecurity\.vercel\.app$
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

## Required Information

To implement either option, we need to confirm:
1. **Vercel project name**: Likely `vibenote` based on repo name
2. **Vercel team slug**: Need to confirm (possibly `zksecurity` based on GitHub org)

You can find these by:
- Visit Vercel Dashboard → Project Settings → General
- Team slug appears in the URL: `vercel.com/{team-slug}/{project-name}`

## Next Steps

Once we confirm the Vercel team slug and project name, we can:
1. Implement regex-based CORS validation in backend
2. Configure Vercel environment variables
3. Test on a preview deployment
4. Document the pattern for team reference
