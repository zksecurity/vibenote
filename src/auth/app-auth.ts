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

export type { AppUser };

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
}

export async function signInWithGitHubApp(
  returnTo?: string
): Promise<{ token: string; user: AppUser } | null> {
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
        resolve({ token, user: normalized });
        return;
      }
      resolve(null);
    };
    window.addEventListener('message', handler);
  });
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
