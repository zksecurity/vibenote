// GitHub App popup auth for VibeNote backend

type AppUser = { id: string; login: string; avatarUrl: string | null };

const SESSION_KEY = 'vibenote:sessionToken';
const USER_KEY = 'vibenote:app-user';

export type { AppUser };

export function getSessionToken(): string | null {
  return localStorage.getItem(SESSION_KEY);
}

export function getSessionUser(): AppUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AppUser) : null;
  } catch {
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(USER_KEY);
}

export async function signInWithGitHubApp(returnTo?: string): Promise<{ token: string; user: AppUser } | null> {
  const base = getApiBase();
  const url = new URL(base + '/v1/auth/github/start');
  url.searchParams.set('returnTo', returnTo || window.location.href);
  const w = window.open(url.toString(), 'vibenote-login', 'width=720,height=640');
  if (!w) return null;
  return await new Promise((resolve) => {
    const handler = (ev: MessageEvent) => {
      if (!ev.data || typeof ev.data !== 'object') return;
      const d = ev.data as any;
      if (d.type !== 'vibenote:auth') return;
      window.removeEventListener('message', handler);
      const token = String(d.sessionToken || '');
      const user = d.user ? (d.user as AppUser) : null;
      if (token && user) {
        localStorage.setItem(SESSION_KEY, token);
        localStorage.setItem(USER_KEY, JSON.stringify(user));
        resolve({ token, user });
        return;
      }
      resolve(null);
    };
    window.addEventListener('message', handler);
  });
}

function getApiBase(): string {
  // Try Vite-style env, fallback to global, then default
  const env = (import.meta as any).env || {};
  const fromVite = env.VIBENOTE_API_BASE || env.VITE_VIBENOTE_API_BASE;
  const fromGlobal = (globalThis as any).VIBENOTE_API_BASE;
  return String(fromVite || fromGlobal || 'https://api.vibenote.dev').replace(/\/$/, '');
}

export { getApiBase };

