import type { VercelRequest, VercelResponse } from '@vercel/node';
import { prepare, sendError } from '../../../../_lib/http.ts';
import { commitToRepo, parseCommitRequestBody, verifyBearerSession } from '../../../../../server/src/api.ts';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const prepared = prepare(req, res);
  if (!prepared) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const auth = req.headers.authorization || req.headers.Authorization;
  if (!auth || typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) {
    res.status(401).json({ error: 'missing auth' });
    return;
  }
  try {
    const sessionUser = await verifyBearerSession(auth.slice(7).trim(), prepared.env);
    const payload = parseCommitRequestBody(req.body);
    const result = await commitToRepo(
      prepared.env,
      String(req.query.owner ?? ''),
      String(req.query.repo ?? ''),
      payload,
      sessionUser,
    );
    res.status(200).json(result);
  } catch (error) {
    if (isInstallationMissingError(error)) {
      sendError(res, 403, 'app not installed for this repo');
      return;
    }
    if (error instanceof Error && error.message && (error.message.startsWith('invalid') || error.message.includes('required'))) {
      sendError(res, 400, error);
      return;
    }
    sendError(res, 500, error);
  }
}

function isInstallationMissingError(error: unknown): boolean {
  return error instanceof Error && error.message === 'app not installed for this repo';
}
