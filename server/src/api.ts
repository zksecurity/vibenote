import crypto from 'node:crypto';
import type { Env } from './env.ts';
import { signSession, verifySession, signState, verifyState, type SessionClaims } from './jwt.ts';
import type { SessionStoreInstance, SessionRecord } from './session-store.ts';

export type { SessionClaims };

export type OAuthTokenResult = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  scope: string[];
  tokenType: string;
};

function isPreviewOrigin(env: Env, origin: string): boolean {
  return env.VERCEL_PREVIEW_URL_PATTERN.test(origin);
}

function isUserAllowed(env: Env, login: string, origin: string): boolean {
  // Only enforce user allowlist for preview deployments
  const isPreview = isPreviewOrigin(env, origin);

  if (!isPreview) {
    // Production origin - allow all users
    return true;
  }

  // Preview origin - check user allowlist
  if (!env.ALLOWED_GITHUB_USERS || env.ALLOWED_GITHUB_USERS.length === 0) {
    // No allowlist configured - deny access from previews for safety
    return false;
  }

  return env.ALLOWED_GITHUB_USERS.includes(login);
}

export async function createAuthStartRedirect(
  env: Env,
  returnTo: string,
  callbackUrl: string
): Promise<string> {
  let state = await signState({ returnTo, t: Date.now() }, env.SESSION_JWT_SECRET, 600);
  let params = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID,
    redirect_uri: callbackUrl,
    scope: 'read:user user:email',
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function handleAuthCallback(
  env: Env,
  store: SessionStoreInstance,
  code: string,
  stateToken: string,
  callbackUrl: string,
  pageOrigin: string
): Promise<{ html: string }> {
  let state = await verifyState(stateToken, env.SESSION_JWT_SECRET);
  let returnTo = getOptionalString(state, 'returnTo') ?? '/';
  let tokens = await exchangeCode(env, code, callbackUrl, stateToken);
  let user = await fetchGitHubUser(tokens.accessToken);

  // Validate user is allowed (enforced for preview deployments only)
  if (!isUserAllowed(env, user.login, pageOrigin)) {
    let rt = new URL(returnTo, returnTo.startsWith('http') ? undefined : pageOrigin);
    const isPreview = isPreviewOrigin(env, pageOrigin);
    let errorHtml = `<!doctype html><meta charset="utf-8"><title>VibeNote - Unauthorized</title>
      <style>body{font-family:system-ui;max-width:600px;margin:100px auto;padding:20px;text-align:center}</style>
      <h1>Unauthorized</h1>
      <p>Your GitHub user <strong>@${user.login}</strong> is not authorized to use ${isPreview ? 'preview deployments' : 'this environment'}.</p>
      <p>Please contact the VibeNote development team if you believe this is an error.</p>
      <p><a href="${rt.toString()}">Return to app</a></p>`;
    return { html: errorHtml };
  }

  let sessionId = crypto.randomUUID();
  let encryptedRefresh = store.encryptRefreshToken(tokens.refreshToken);
  let recordInput: Omit<SessionRecord, 'createdAt' | 'updatedAt' | 'lastAccessAt'> = {
    id: sessionId,
    userId: user.id,
    login: user.login,
    name: user.name ?? undefined,
    avatarUrl: user.avatarUrl ?? undefined,
    refreshTokenCiphertext: encryptedRefresh,
    refreshExpiresAt: tokens.refreshTokenExpiresAt,
  };
  await store.create(recordInput);
  let claims: SessionClaims = {
    sessionId,
    sub: user.id,
    login: user.login,
    avatarUrl: user.avatarUrl,
    name: user.name,
  };
  let sessionToken = await signSession(claims, env.SESSION_JWT_SECRET);
  let accessPayload = {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
  };
  let rt = new URL(returnTo, returnTo.startsWith('http') ? undefined : pageOrigin);
  let origin = rt.origin;
  let message = {
    type: 'vibenote:auth',
    sessionToken,
    sessionId,
    user: {
      id: user.id,
      login: user.login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      avatarDataUrl: null,
    },
    tokens: accessPayload,
  };
  let html = `<!doctype html><meta charset="utf-8"><title>VibeNote Login</title><script>
      (function(){
        try {
          const msg = ${JSON.stringify(message)};
          if (window.opener && '${origin}') { window.opener.postMessage(msg, '${origin}'); }
        } catch (e) {}
        setTimeout(function(){ window.close(); }, 50);
      })();
    </script>
    <p>Signed in. You can close this window. <a href="${rt.toString()}">Continue</a></p>`;
  return { html };
}

export async function refreshAccessToken(
  env: Env,
  store: SessionStoreInstance,
  sessionId: string,
  requestOrigin: string
): Promise<OAuthTokenResult> {
  let record = store.get(sessionId);
  if (!record) {
    throw new Error('session expired');
  }

  // Validate user is still allowed (enforced for preview deployments only)
  if (!isUserAllowed(env, record.login, requestOrigin)) {
    await store.delete(sessionId);
    throw new Error('user not authorized');
  }

  let refreshPlain = store.decryptRefreshToken(record.refreshTokenCiphertext);
  let refreshed = await refreshWithToken(env, refreshPlain);
  let encryptedRefresh = store.encryptRefreshToken(refreshed.refreshToken);
  await store.update(sessionId, {
    refreshTokenCiphertext: encryptedRefresh,
    refreshExpiresAt: refreshed.refreshTokenExpiresAt,
    lastAccessAt: new Date().toISOString(),
  });
  return refreshed;
}

export async function logoutSession(store: SessionStoreInstance, sessionId: string): Promise<void> {
  await store.delete(sessionId);
}

export async function buildInstallUrl(
  env: Env,
  owner: string,
  repo: string,
  returnTo: string
): Promise<string> {
  let state = await signState({ owner, repo, returnTo, t: Date.now() }, env.SESSION_JWT_SECRET, 1800);
  return `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}`;
}

export async function buildSetupRedirect(
  env: Env,
  stateToken: string,
  returnTo: string,
  setupAction: string | null,
  installationId: string | null,
  origin: string
): Promise<string> {
  let state = await verifyState(stateToken, env.SESSION_JWT_SECRET);
  let fallback = getOptionalString(state, 'returnTo') ?? '/';
  let url = new URL(returnTo || fallback, returnTo.startsWith('http') ? undefined : origin);
  if (installationId) {
    url.searchParams.set('installation_id', installationId);
  }
  if (setupAction) {
    url.searchParams.set('setup_action', setupAction);
  }
  return url.toString();
}

export async function verifyBearerSession(token: string, env: Env): Promise<SessionClaims> {
  return await verifySession(token, env.SESSION_JWT_SECRET);
}

async function fetchGitHubUser(accessToken: string): Promise<{
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}> {
  let ures = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
  });
  if (!ures.ok) {
    throw new Error(`user fetch failed: ${ures.status}`);
  }
  let raw = await ures.json();
  return parseGitHubUser(raw);
}

async function exchangeCode(env: Env, code: string, callbackUrl: string, stateToken: string): Promise<OAuthTokenResult> {
  let body = {
    client_id: env.GITHUB_OAUTH_CLIENT_ID,
    client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
    code,
    redirect_uri: callbackUrl,
    state: stateToken,
  };
  let response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`token exchange failed: ${response.status}`);
  }
  let json = await response.json();
  return parseOAuthTokenResponse(json);
}

async function refreshWithToken(env: Env, refreshToken: string): Promise<OAuthTokenResult> {
  let body = {
    client_id: env.GITHUB_OAUTH_CLIENT_ID,
    client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  };
  let response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`refresh failed: ${response.status}`);
  }
  let json = await response.json();
  return parseOAuthTokenResponse(json);
}

function parseOAuthTokenResponse(input: unknown): OAuthTokenResult {
  if (!input || typeof input !== 'object') {
    throw new Error('invalid token response');
  }
  let data = input as Record<string, unknown>;
  let access = asString(data.access_token, 'access_token');
  let tokenType = asString(data.token_type, 'token_type');
  let scopeRaw = data.scope;
  let expiresIn = asNumber(data.expires_in, 'expires_in');
  let refresh = asString(data.refresh_token, 'refresh_token');
  let refreshExpiresIn = asNumber(data.refresh_token_expires_in, 'refresh_token_expires_in');
  let scopes = Array.isArray(scopeRaw)
    ? scopeRaw.filter((value): value is string => typeof value === 'string')
    : typeof scopeRaw === 'string'
    ? scopeRaw.split(/[ ,]+/).filter((value) => value.length > 0)
    : [];
  let now = Date.now();
  let accessExpiresAt = new Date(now + expiresIn * 1000 - 5000).toISOString();
  let refreshExpiresAt = new Date(now + refreshExpiresIn * 1000).toISOString();
  return {
    accessToken: access,
    accessTokenExpiresAt: accessExpiresAt,
    refreshToken: refresh,
    refreshTokenExpiresAt: refreshExpiresAt,
    scope: scopes,
    tokenType,
  };
}

function parseGitHubUser(json: unknown): {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
} {
  if (!json || typeof json !== 'object') {
    throw new Error('invalid user response');
  }
  let obj = json as Record<string, unknown>;
  let idValue = obj.id;
  let loginValue = obj.login;
  if ((typeof idValue !== 'number' && typeof idValue !== 'string') || typeof loginValue !== 'string') {
    throw new Error('invalid user payload');
  }
  let nameValue = obj.name;
  let avatarValue = obj.avatar_url;
  return {
    id: String(idValue),
    login: loginValue,
    name: typeof nameValue === 'string' && nameValue.length > 0 ? nameValue : null,
    avatarUrl: typeof avatarValue === 'string' && avatarValue.length > 0 ? avatarValue : null,
  };
}

function getOptionalString(record: Record<string, unknown>, key: string): string | null {
  let value = record[key];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return null;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`missing ${field}`);
  }
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    let parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`missing ${field}`);
}
