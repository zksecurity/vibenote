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

## Security Model: Per-Request Mode Detection

The backend **automatically detects the mode per-request** based on the request origin:

### Production Request (origin matches `ALLOWED_ORIGINS`)
- ✅ All authenticated users allowed
- ✅ Normal OAuth flow

### Preview Request (origin matches Vercel preview pattern)
- ✅ Enforces GitHub user allowlist
- ✅ Only approved developers can authenticate
- ❌ Unauthorized users get clear error message

**Two layers of defense (for preview requests only):**

### Layer 1: CORS URL Pattern Validation
- Allows both production origins and preview URLs
- Regex validates preview URLs match your team pattern
- Blocks unauthorized origins
- **Not cryptographically secure** (suffix attacks theoretically possible)

### Layer 2: GitHub User Allowlist ✅ (Actual Security Boundary)
- Backend validates authenticated GitHub username on preview requests
- Production requests skip this check
- Only approved developers can access repos from preview deployments
- Works even if attacker bypasses CORS

**Why this works:**
Even if an attacker:
1. ✅ Crafts a team-suffix collision URL
2. ✅ Bypasses CORS validation
3. ✅ Completes OAuth flow
4. ❌ **Gets blocked** - they're not on the developer allowlist (preview origin)

**Single Backend Instance:**
Run **one backend instance** that serves both production and preview traffic:
- Determines mode based on request origin (not environment variables)
- Production requests: Skip user allowlist check
- Preview requests: Enforce user allowlist
- Configure `ALLOWED_GITHUB_USERS` once, applies to all preview requests

---

## Implementation

### Single Backend Instance ✅

Run **one production backend** that serves both production and preview traffic:

**Architecture:**
```
api.vibenote.dev → single backend instance
  ├─ Production requests (vibenote.dev) → no user allowlist
  └─ Preview requests (*.vercel.app)     → enforces user allowlist
```

**How it works:**
- Backend detects preview requests by checking if origin matches Vercel pattern
- Same GitHub App, same database, same secrets
- User allowlist only enforced for preview origins
- Production traffic unaffected

**Pros:**
- ✅ Single backend instance (no staging infrastructure)
- ✅ Single codebase, single deployment
- ✅ Production stays secure (user allowlist not checked)
- ✅ Preview deployments locked down to approved developers
- ✅ No separate GitHub App needed

**Implementation:**
1. Add `ALLOWED_GITHUB_USERS` to production backend `.env`:
   ```bash
   ALLOWED_GITHUB_USERS=your-github-username,other-dev
   ```
2. Restart backend - user allowlist now enforced for preview origins only
3. Configure Vercel environment variables (preview deployments use same backend)

## Configuration

**Vercel Details:**
- Project name: `vibenote`
- Team slug: `gregor-mitschabaudes-projects`
- Team URL: https://vercel.com/gregor-mitschabaudes-projects/vibenote

## Implementation Status

✅ **Backend Changes Complete:**
- Added per-request origin detection (`isPreviewOrigin()` in `server/src/api.ts:20`)
- Added `VERCEL_PREVIEW_PATTERN` constant (used for both CORS and user allowlist)
- Updated CORS middleware to allow both production and preview URLs
- Updated `returnTo` validation to allow both production and preview URLs
- Added `ALLOWED_GITHUB_USERS` env variable (`server/src/env.ts:11`)
- Updated user allowlist validation to be origin-conditional (`server/src/api.ts:24-40`)
- OAuth callback enforces user allowlist only for preview origins (`server/src/api.ts:71`)
- Session refresh enforces user allowlist only for preview origins (`server/src/api.ts:147`)
- Added startup logging showing preview deployment allowlist if configured

**How it works:**
- Single backend instance serves all traffic
- Detects preview requests by checking origin matches Vercel pattern
- Production requests: User allowlist check skipped, all users allowed
- Preview requests: User allowlist enforced, only approved developers

⏳ **Next Steps:**
1. Add `ALLOWED_GITHUB_USERS` to production backend `.env`:
   ```bash
   # Existing production config stays the same
   ALLOWED_ORIGINS=http://localhost:3000,https://vibenote.dev

   # Add this line with your GitHub usernames
   ALLOWED_GITHUB_USERS=your-github-username,other-dev
   ```

2. Restart production backend:
   ```bash
   pm2 restart vibenote-api
   ```

   You should see: `[vibenote] preview deployment allowlist: your-username, other-dev`

3. Configure Vercel environment variable:
   - `VITE_VIBENOTE_API_BASE=https://api.vibenote.dev` (Preview environment)

4. Test on a preview deployment:
   - Create PR → Vercel deploys preview
   - Visit preview URL → Sign in with GitHub
   - If you're in allowlist → ✅ Success
   - If not → Shows unauthorized page

## Vercel Environment Variables

Configure in Vercel Dashboard → Project Settings → Environment Variables:

| Variable | Value | Environment |
|----------|-------|-------------|
| `VITE_VIBENOTE_API_BASE` | `https://api.vibenote.dev` | Preview |
| `VITE_VIBENOTE_API_BASE` | `https://api.vibenote.dev` | Production |

Both use the **same backend** - the backend determines the mode per-request:
- Preview deployments: Backend detects preview origin, enforces user allowlist
- Production: Backend detects production origin, skips user allowlist
