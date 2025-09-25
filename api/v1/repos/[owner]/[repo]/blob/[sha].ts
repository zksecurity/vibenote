import type { VercelRequest, VercelResponse } from '@vercel/node';
import { prepare, sendError } from '../../../../../_lib/http.ts';
import { fetchRepoBlob } from '../../../../../../server/src/api.ts';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const prepared = prepare(req, res);
  if (!prepared) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const data = await fetchRepoBlob(
      prepared.env,
      String(req.query.owner ?? ''),
      String(req.query.repo ?? ''),
      String(req.query.sha ?? ''),
    );
    res.status(200).json(data);
  } catch (error) {
    if (error instanceof Error && error.message === 'app not installed for this repo') {
      sendError(res, 403, error);
      return;
    }
    sendError(res, 500, error);
  }
}
