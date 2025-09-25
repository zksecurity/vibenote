import type { VercelRequest, VercelResponse } from '@vercel/node';
import { prepare, sendError } from '../../../../_lib/http.ts';
import { fetchRepoFile } from '../../../../../server/src/api.ts';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const prepared = prepare(req, res);
  if (!prepared) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const pathParam = typeof req.query.path === 'string' ? req.query.path : '';
  if (!pathParam) {
    sendError(res, 400, 'path required');
    return;
  }
  try {
    const data = await fetchRepoFile(
      prepared.env,
      String(req.query.owner ?? ''),
      String(req.query.repo ?? ''),
      pathParam,
      req.query.ref ? String(req.query.ref) : undefined,
    );
    res.status(200).json(data);
  } catch (error) {
    if (isInstallationMissingError(error)) {
      sendError(res, 403, 'app not installed for this repo');
      return;
    }
    if (error instanceof Error && error.message) {
      if (error.message === 'path refers to a directory' || error.message === 'unsupported content type') {
        sendError(res, 400, error);
        return;
      }
    }
    sendError(res, 500, error);
  }
}

function isInstallationMissingError(error: unknown): boolean {
  return error instanceof Error && error.message === 'app not installed for this repo';
}
