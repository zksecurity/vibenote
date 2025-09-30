// GitHub App popup auth for VibeNote backend

type AppUser = {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  avatarDataUrl: string | null;
};

const SESSION_KEY = 'vibenote:sessionToken';
const USER_KEY = 'vibenote:app-user';
const ACCESS_TOKEN_KEY = 'vibenote:app-access-token';

type AccessTokenRecord = {
  token: string;
  expiresAt: string;
};

export type { AppUser };
export type { AccessTokenRecord };

export function getSessionToken(): string | null {
  return localStorage.getItem(SESSION_KEY);
}

export function getSessionUser(): AppUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AppUser> & { login?: string };
    if (!parsed || !parsed.id || !parsed.login) return null;
    return {
      id: String(parsed.id),
      login: String(parsed.login),
      name: parsed.name ?? null,
      avatarUrl: parsed.avatarUrl ?? null,
      avatarDataUrl: parsed.avatarDataUrl ?? null,
    };
  } catch {
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(ACCESS_TOKEN_KEY);
}

export async function signInWithGitHubApp(
  returnTo?: string
): Promise<
  { token: string; user: AppUser; accessToken: string; accessTokenExpiresAt: string } | null
> {
  const base = getApiBase();
  const url = new URL(base + '/v1/auth/github/start');
  url.searchParams.set('returnTo', returnTo || window.location.href);
  const w = window.open(url.toString(), 'vibenote-login', 'width=720,height=640');
  if (!w) return null;
  return await new Promise((resolve) => {
    const handler = async (ev: MessageEvent) => {
      if (!ev.data || typeof ev.data !== 'object') return;
      const d = ev.data as any;
      if (d.type !== 'vibenote:auth') return;
      window.removeEventListener('message', handler);
      const token = String(d.sessionToken || '');
      let tokens = d.tokens as
        | { accessToken?: string; accessTokenExpiresAt?: string }
        | undefined;
      const rawUser = d.user ? (d.user as Partial<AppUser> & { id?: string; login?: string }) : null;
      if (token && rawUser && rawUser.id && rawUser.login) {
        const normalized: AppUser = {
          id: String(rawUser.id),
          login: String(rawUser.login),
          name: rawUser.name ?? null,
          avatarUrl: rawUser.avatarUrl ?? null,
          avatarDataUrl: rawUser.avatarDataUrl ?? null,
        };
        if (!normalized.avatarDataUrl && normalized.avatarUrl) {
          const cached = await fetchAvatarDataUrl(normalized.avatarUrl);
          if (cached) normalized.avatarDataUrl = cached;
        }
        localStorage.setItem(SESSION_KEY, token);
        localStorage.setItem(USER_KEY, JSON.stringify(normalized));
        if (tokens && tokens.accessToken && tokens.accessTokenExpiresAt) {
          persistAccessToken({ token: tokens.accessToken, expiresAt: tokens.accessTokenExpiresAt });
          resolve({
            token,
            user: normalized,
            accessToken: tokens.accessToken,
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
          });
          return;
        }
        resolve({ token, user: normalized, accessToken: '', accessTokenExpiresAt: '' });
        return;
      }
      resolve(null);
    };
    window.addEventListener('message', handler);
  });
}

export function getAccessTokenRecord(): AccessTokenRecord | null {
  try {
    const raw = localStorage.getItem(ACCESS_TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AccessTokenRecord>;
    if (!parsed || typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'string') return null;
    return { token: parsed.token, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export async function ensureFreshAccessToken(): Promise<string | null> {
  let record = getAccessTokenRecord();
  const now = Date.now();
  const sessionToken = getSessionToken();
  if (!sessionToken) {
    clearAccessToken();
    return null;
  }
  const needsRefresh = (r: AccessTokenRecord | null) => {
    if (!r) return true;
    const expires = Date.parse(r.expiresAt);
    if (!Number.isFinite(expires)) return true;
    const lead = 120_000;
    return expires <= now + lead;
  };
  if (needsRefresh(record)) {
    const refreshed = await requestAccessTokenRefresh(sessionToken);
    if (!refreshed) {
      clearAccessToken();
      return null;
    }
    record = refreshed;
  }
  if (!record) return null;
  return record.token;
}

export async function signOutFromGitHubApp(): Promise<void> {
  const base = getApiBase();
  const sessionToken = getSessionToken();
  if (sessionToken) {
    try {
      await fetch(`${base}/v1/auth/github/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
    } catch (err) {
      console.warn('vibenote: failed to notify backend logout', err);
    }
  }
  clearSession();
}

function persistAccessToken(record: AccessTokenRecord) {
  try {
    localStorage.setItem(ACCESS_TOKEN_KEY, JSON.stringify(record));
  } catch (err) {
    console.warn('vibenote: failed to persist access token', err);
  }
}

function clearAccessToken() {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
}

async function requestAccessTokenRefresh(sessionToken: string): Promise<AccessTokenRecord | null> {
  const base = getApiBase();
  try {
    const res = await fetch(`${base}/v1/auth/github/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (!res.ok) {
      console.warn('vibenote: refresh failed', res.status);
      return null;
    }
    const data = (await res.json()) as { accessToken?: string; accessTokenExpiresAt?: string };
    if (!data.accessToken || !data.accessTokenExpiresAt) {
      return null;
    }
    const record: AccessTokenRecord = {
      token: String(data.accessToken),
      expiresAt: String(data.accessTokenExpiresAt),
    };
    persistAccessToken(record);
    return record;
  } catch (err) {
    console.warn('vibenote: refresh request failed', err);
    return null;
  }
}

export async function ensureAppUserAvatarCached(): Promise<AppUser | null> {
  const user = getSessionUser();
  if (!user) return null;
  if (user.avatarDataUrl || !user.avatarUrl) return user;
  const cached = await fetchAvatarDataUrl(user.avatarUrl);
  if (!cached) return user;
  const updated: AppUser = { ...user, avatarDataUrl: cached };
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(updated));
  } catch (err) {
    console.warn('vibenote: failed to persist cached avatar', err);
  }
  return updated;
}

function getApiBase(): string {
  // Try Vite-style env, fallback to global, then default
  const env = (import.meta as any).env || {};
  const fromVite: string | undefined = env.VITE_VIBENOTE_API_BASE || env.VIBENOTE_API_BASE;
  const fromGlobal: string | undefined = (globalThis as any).VIBENOTE_API_BASE;
  let base = fromVite || fromGlobal;
  if (!base) throw Error('VIBENOTE_API_BASE not set');
  return String(fromVite || fromGlobal || 'https://api.example.dev').replace(/\/$/, '');
}

async function fetchAvatarDataUrl(avatarUrl: string): Promise<string | null> {
  try {
    if (typeof fetch !== 'function' || typeof FileReader === 'undefined') return null;
    const url = new URL(avatarUrl);
    if (!url.searchParams.has('s')) {
      url.searchParams.set('s', '96');
    }
    const resp = await fetch(url.toString(), { mode: 'cors', cache: 'force-cache' });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const AVATAR_MAX_BYTES = 200_000;
    if (blob.size > AVATAR_MAX_BYTES) return null;
    return await blobToDataUrl(blob);
  } catch (err) {
    console.warn('vibenote: failed to cache avatar', err);
    return null;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

export { getApiBase };
