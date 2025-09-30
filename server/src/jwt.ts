import { SignJWT, jwtVerify } from 'jose';

type SessionClaims = {
  sessionId: string;
  sub: string; // user id
  login: string;
  avatarUrl: string | null;
  name: string | null;
};

export type { SessionClaims };

export async function signSession(
  claims: SessionClaims,
  secret: string,
  ttlSeconds = 60 * 60 * 24 * 90
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    login: claims.login,
    avatarUrl: claims.avatarUrl,
    name: claims.name,
    sessionId: claims.sessionId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key);
}

export async function verifySession(token: string, secret: string): Promise<SessionClaims> {
  const key = new TextEncoder().encode(secret);
  const { payload, protectedHeader } = await jwtVerify(token, key, { algorithms: ['HS256'] });
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('invalid session token (sub)');
  }
  if (!payload.sessionId || typeof payload.sessionId !== 'string') {
    throw new Error('invalid session token (sessionId)');
  }
  return {
    sessionId: payload.sessionId,
    sub: payload.sub,
    login: String(payload.login ?? ''),
    avatarUrl: (payload.avatarUrl as string | null) ?? null,
    name: (payload.name as string | null) ?? null,
  };
}

export async function signState(
  obj: Record<string, unknown>,
  secret: string,
  ttlSeconds = 60 * 10
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT(obj)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key);
}

export async function verifyState(token: string, secret: string): Promise<Record<string, unknown>> {
  const key = new TextEncoder().encode(secret);
  const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
  return payload as Record<string, unknown>;
}
