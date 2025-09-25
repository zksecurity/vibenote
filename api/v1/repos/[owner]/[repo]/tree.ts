import type { VercelRequest, VercelResponse } from '@vercel/node';
import { prepare, sendError } from '../../../../_lib/http.ts';
import { fetchRepoTree } from '../../../../../server/src/api.ts';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const prepared = prepare(req, res);
  if (!prepared) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const data = await fetchRepoTree(
      prepared.env,
      String(req.query.owner ?? ''),
      String(req.query.repo ?? ''),
      req.query.ref ? String(req.query.ref) : null,
    );
    res.status(200).json(data);
  } catch (error) {
    if (isInstallationMissingError(error)) {
      sendError(res, 403, 'app not installed for this repo');
      return;
    }
    if (error instanceof Error && error.message === 'ref missing') {
      sendError(res, 400, error);
      return;
    }
    sendError(res, 500, error);
  }
}

function isInstallationMissingError(error: unknown): boolean {
  return error instanceof Error && error.message === 'app not installed for this repo';
}
