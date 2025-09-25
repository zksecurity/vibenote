import type { VercelRequest, VercelResponse } from '@vercel/node';
import { prepare, getRequestOrigin } from '../../../_lib/http.ts';
import { createAuthStartRedirect } from '../../../../server/src/api.ts';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const prepared = prepare(req, res);
  if (!prepared) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '';
  const base = getRequestOrigin(req);
  const redirect = await createAuthStartRedirect(prepared.env, returnTo, `${base}/api/v1/auth/github/callback`);
  res.status(302).setHeader('Location', redirect).end();
}
