import type { VercelRequest, VercelResponse } from '@vercel/node';
import { prepare, getRequestOrigin } from '../../../_lib/http.ts';
import { handleAuthCallback } from '../../../../server/src/api.ts';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const prepared = prepare(req, res);
  if (!prepared) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const stateToken = typeof req.query.state === 'string' ? req.query.state : '';
    const origin = getRequestOrigin(req);
    const { html } = await handleAuthCallback(
      prepared.env,
      code,
      stateToken,
      `${origin}/api/v1/auth/github/callback`,
      origin,
    );
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
