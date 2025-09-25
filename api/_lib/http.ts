import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getEnv } from '../../server/src/env.ts';

export type PreparedRequest = {
  env: ReturnType<typeof getEnv>;
};

export function prepare(req: VercelRequest, res: VercelResponse): PreparedRequest | null {
  const env = getEnv();
  applyCors(req, res, env.ALLOWED_ORIGINS);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.status(204).end();
    return null;
  }
  return { env };
}

export function applyCors(
  req: VercelRequest,
  res: VercelResponse,
  allowedOrigins: string[],
): void {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
}

export function sendError(res: VercelResponse, status: number, error: unknown): void {
  const message = error instanceof Error && error.message ? error.message : String(error);
  res.status(status).json({ error: message });
}

export function getRequestOrigin(req: VercelRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}
