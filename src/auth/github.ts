// LEGACY FILE - device token flow is not currently used in the app

/// <reference types="vite/client" />
import { logError } from '../lib/logging';
// GitHub OAuth device flow helper functions.
// Calls Vercel serverless functions (api/github/*) to avoid browser CORS issues.

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token?: string;
  error?: string;
}

export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const res = await fetch('/api/github/device-code', {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error('Failed to request device code');
  return (await res.json()) as DeviceCodeResponse;
}

export async function pollForToken(device: DeviceCodeResponse): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < device.expires_in * 1000) {
    await new Promise((r) => setTimeout(r, device.interval * 1000));
    const res = await fetch('/api/github/device-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ device_code: device.device_code }),
    });
    const data = (await res.json()) as TokenResponse;
    if (data.access_token) return data.access_token;
    if (data.error === 'authorization_pending') continue;
    if (data.error) throw new Error(data.error);
  }
  return null;
}

const TOKEN_KEY = 'vibenote:gh-token';

export async function connectToGitHub(): Promise<string | null> {
  // Legacy helper kept for compatibility. Prefer using requestDeviceCode + pollForToken
  const device = await requestDeviceCode();
  try {
    const token = await pollForToken(device);
    if (token) localStorage.setItem(TOKEN_KEY, token);
    return token;
  } catch (err) {
    logError(err);
    return null;
  }
}

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function fetchCurrentUser(): Promise<{
  login: string;
  name?: string;
  avatar_url?: string;
} | null> {
  const token = getStoredToken();
  if (!token) return null;
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return {
    login: data.login as string,
    name: data.name as string | undefined,
    avatar_url: data.avatar_url as string | undefined,
  };
}
