// GitHub App helpers for minting installation tokens and accessing repo content.
import { SignJWT, importPKCS8 } from 'jose';
import type { Env } from './env.ts';

type InstallationToken = {
  token: string;
  expiresAt: number;
  permissions: Record<string, string> | undefined;
};

const GITHUB_API_BASE = 'https://api.github.com';

const installationTokenCache = new Map<number, InstallationToken>();
let privateKeyCache:
  | {
      key: ReturnType<typeof importPKCS8> extends Promise<infer K> ? K : never;
      source: string;
    }
  | undefined;

export async function getRepoInstallationId(env: Env, owner: string, repo: string): Promise<number> {
  const jwt = await getAppJwt(env);
  const res = await fetch(`${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (res.status === 404) {
    throw new Error('app not installed for repository');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`installation lookup failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { id?: number };
  if (!json || typeof json.id !== 'number') {
    throw new Error('installation lookup missing id');
  }
  return json.id;
}

export async function getInstallationToken(env: Env, installationId: number): Promise<string> {
  const cached = installationTokenCache.get(installationId);
  if (cached && cached.expiresAt - 60_000 > Date.now()) {
    return cached.token;
  }
  const jwt = await getAppJwt(env);
  const res = await fetch(`${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`, {
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
  return await fetch(url, { ...init, headers });
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
