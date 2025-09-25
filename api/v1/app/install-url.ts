import type { VercelRequest, VercelResponse } from '@vercel/node';
import { prepare } from '../../_lib/http.ts';
import { buildInstallUrl } from '../../../server/src/api.ts';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const prepared = prepare(req, res);
  if (!prepared) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const owner = typeof req.query.owner === 'string' ? req.query.owner : '';
  const repo = typeof req.query.repo === 'string' ? req.query.repo : '';
  const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '';
  const url = await buildInstallUrl(prepared.env, owner, repo, returnTo);
  res.status(200).json({ url });
}
