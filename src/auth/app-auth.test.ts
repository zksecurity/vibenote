// Tests for the GitHub App popup sign-in flow.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { signInWithGitHubApp } from './app-auth';

function frameWindow(): Window {
  let frame = document.createElement('iframe');
  document.body.appendChild(frame);
  let win = frame.contentWindow;
  if (win === null) throw Error('iframe has no window');
  return win;
}

function authMessage(login: string) {
  return {
    type: 'vibenote:auth',
    sessionToken: `session-${login}`,
    user: { id: '1', login, name: null, avatarUrl: null },
    tokens: { accessToken: `access-${login}`, accessTokenExpiresAt: '2100-01-01T00:00:00.000Z' },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('signInWithGitHubApp', () => {
  it('ignores session messages that do not come from the login popup on the API origin', async () => {
    (globalThis as { VIBENOTE_API_BASE?: string }).VIBENOTE_API_BASE = 'https://api.vibenote.test';
    let popup = frameWindow();
    let attacker = frameWindow();
    let openedUrl = '';
    vi.spyOn(window, 'open').mockImplementation((url) => {
      openedUrl = String(url);
      return popup;
    });

    let result = signInWithGitHubApp('https://vibenote.test/');
    let apiOrigin = new URL(openedUrl).origin;

    // Forged from another window, and from the popup after it navigated to another origin
    let post = (data: unknown, origin: string, source: Window) =>
      window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
    post(authMessage('attacker'), apiOrigin, attacker);
    post(authMessage('attacker'), 'https://evil.test', popup);
    // Genuine message from the callback page
    post(authMessage('user'), apiOrigin, popup);

    let signedIn = await result;
    expect(signedIn?.user.login).toBe('user');
    expect(signedIn?.accessToken).toBe('access-user');
  });
});
