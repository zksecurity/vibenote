// GitHub App helpers for minting installation tokens and accessing repo content.
import { SignJWT, importPKCS8 } from 'jose';
import type { Env } from './env.ts';

type InstallationToken = {
  token: string;
  expiresAt: number;
  permissions: Record<string, string> | undefined;
};

const GITHUB_API_BASE = 'https://api.github.com';
// Deadline for GitHub to start responding. Response bodies are bounded in size by their readers.
const GITHUB_RESPONSE_TIMEOUT_MS = 10_000;

const installationTokenCache = new Map<number, InstallationToken>();
let privateKeyCache:
  | {
      key: ReturnType<typeof importPKCS8> extends Promise<infer K> ? K : never;
      source: string;
    }
  | undefined;

// Installation id per account login (lowercased), loaded from the app's installation list.
// Lookups are per owner, never per repository: whether an owner has installed the app is public
// anyway, while a per-repo lookup would reveal through its outcome and timing whether a guessed
// repository name exists. Which repositories an installation can read is enforced by GitHub on the
// contents request, which answers 404 for an inaccessible repository just like for a missing file.
let installationsByOwner = new Map<string, number>();
let installationsLoadedAt = 0;
let installationsLoading: Promise<void> | undefined;
// Reload the full list this often, and on a miss (to pick up new installations) at most this often.
const INSTALLATIONS_MAX_AGE_MS = 5 * 60_000;
const INSTALLATIONS_MISS_RELOAD_MS = 10_000;

export async function getOwnerInstallationId(env: Env, owner: string): Promise<number> {
  let key = owner.toLowerCase();
  let age = Date.now() - installationsLoadedAt;
  if (
    age > INSTALLATIONS_MAX_AGE_MS ||
    (!installationsByOwner.has(key) && age > INSTALLATIONS_MISS_RELOAD_MS)
  ) {
    await loadInstallations(env);
  }
  let installationId = installationsByOwner.get(key);
  if (installationId === undefined) {
    throw new Error('app not installed for owner');
  }
  return installationId;
}

export async function getInstallationToken(env: Env, installationId: number): Promise<string> {
  const cached = installationTokenCache.get(installationId);
  if (cached && cached.expiresAt - 60_000 > Date.now()) {
    return cached.token;
  }
  const jwt = await getAppJwt(env);
  const res = await githubFetch(`${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`failed to mint installation token (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { token?: string; expires_at?: string; permissions?: Record<string, string> };
  if (!json || typeof json.token !== 'string' || typeof json.expires_at !== 'string') {
    throw new Error('installation token response missing fields');
  }
  const expiresAt = Date.parse(json.expires_at);
  if (!Number.isFinite(expiresAt)) {
    throw new Error('invalid installation token expiry');
  }
  installationTokenCache.set(installationId, {
    token: json.token,
    expiresAt,
    permissions: json.permissions,
  });
  return json.token;
}

// Fetch from GitHub, aborting when no response arrives within the deadline. The deadline ends once
// headers arrive, so a large asset streamed to a slow client is not cut off.
export async function githubFetch(url: string, init?: RequestInit): Promise<Response> {
  let controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), GITHUB_RESPONSE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function installationRequest(
  env: Env,
  installationId: number,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const token = await getInstallationToken(env, installationId);
  const url = path.startsWith('http') ? path : `${GITHUB_API_BASE}${path}`;
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Accept', headers.get('Accept') ?? 'application/vnd.github.raw');
  return await githubFetch(url, { ...init, headers });
}

async function getAppJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 8 * 60 - 30;
  const key = await importPrivateKey(env);
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setIssuer(String(env.GITHUB_APP_ID))
    .sign(key);
}

async function importPrivateKey(env: Env) {
  if (privateKeyCache && privateKeyCache.source === env.GITHUB_APP_PRIVATE_KEY) {
    return privateKeyCache.key;
  }
  const pem = env.GITHUB_APP_PRIVATE_KEY;
  const key = await importPKCS8(pem, 'RS256');
  privateKeyCache = { key, source: pem };
  return key;
}

// Load all installations of the app, sharing one request among concurrent callers.
async function loadInstallations(env: Env): Promise<void> {
  if (installationsLoading === undefined) {
    installationsLoading = fetchInstallations(env).finally(() => {
      installationsLoading = undefined;
    });
  }
  await installationsLoading;
}

async function fetchInstallations(env: Env): Promise<void> {
  const jwt = await getAppJwt(env);
  let byOwner = new Map<string, number>();
  const perPage = 100;
  for (let page = 1; ; page++) {
    const res = await githubFetch(`${GITHUB_API_BASE}/app/installations?per_page=${perPage}&page=${page}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`installation list failed (${res.status}): ${text}`);
    }
    const json: unknown = await res.json();
    if (!Array.isArray(json)) {
      throw new Error('installation list is not an array');
    }
    for (let item of json) {
      let entry = parseInstallation(item);
      if (entry !== undefined) byOwner.set(entry.login.toLowerCase(), entry.id);
    }
    if (json.length < perPage) break;
  }
  installationsByOwner = byOwner;
  installationsLoadedAt = Date.now();
}

function parseInstallation(item: unknown): { id: number; login: string } | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  if (!('id' in item) || typeof item.id !== 'number') return undefined;
  if (!('account' in item) || typeof item.account !== 'object' || item.account === null) return undefined;
  if (!('login' in item.account) || typeof item.account.login !== 'string') return undefined;
  return { id: item.id, login: item.account.login };
}
