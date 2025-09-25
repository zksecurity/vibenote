import type { VercelRequest, VercelResponse } from '@vercel/node';
import { prepare, sendError } from '../../../../_lib/http.ts';
import { fetchRepoMetadata } from '../../../../../server/src/api.ts';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const prepared = prepare(req, res);
  if (!prepared) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const owner = String(req.query.owner ?? '');
  const repo = String(req.query.repo ?? '');
  try {
    const data = await fetchRepoMetadata(prepared.env, owner, repo);
    res.status(200).json(data);
  } catch (error) {
    sendError(res, 500, error);
  }
}
