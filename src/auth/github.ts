/// <reference types="vite/client" />
// GitHub OAuth device flow helper functions.
// Uses GitHub's device authorization to obtain an access token without a server.

// Vite exposes env vars via import.meta.env
const CLIENT_ID = import.meta.env.VITE_GITHUB_CLIENT_ID as string;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: 'repo',
    }),
  });
  if (!res.ok) throw new Error('Failed to request device code');
  return (await res.json()) as DeviceCodeResponse;
}

async function pollForToken(device: DeviceCodeResponse): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < device.expires_in * 1000) {
    await new Promise((r) => setTimeout(r, device.interval * 1000));
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const data = (await res.json()) as TokenResponse;
    if (data.access_token) return data.access_token;
    if (data.error === 'authorization_pending') continue;
    if (data.error) throw new Error(data.error);
  }
  return null;
}

export async function connectToGitHub(): Promise<string | null> {
  if (!CLIENT_ID) {
    alert('GitHub client id not configured');
    return null;
  }
  const device = await requestDeviceCode();
  // Open verification URL and instruct the user to enter the code
  window.open(device.verification_uri, '_blank');
  alert(`Authorize GitNote in the opened window. When prompted, enter code: ${device.user_code}`);
  try {
    const token = await pollForToken(device);
    if (token) {
      localStorage.setItem('gitnote:gh-token', token);
    }
    return token;
  } catch (err) {
    console.error(err);
    alert('GitHub authorization failed');
    return null;
  }
}

export function getStoredToken(): string | null {
  return localStorage.getItem('gitnote:gh-token');
}
