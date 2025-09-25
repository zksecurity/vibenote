import type { VercelRequest, VercelResponse } from '@vercel/node';
import { prepare, getRequestOrigin } from '../../_lib/http.ts';
import { buildSetupRedirect } from '../../../server/src/api.ts';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const prepared = prepare(req, res);
  if (!prepared) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const installationId = typeof req.query.installation_id === 'string' ? req.query.installation_id : null;
    const setupAction = typeof req.query.setup_action === 'string' ? req.query.setup_action : null;
    const stateToken = typeof req.query.state === 'string' ? req.query.state : '';
    const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '';
    const origin = getRequestOrigin(req);
    const target = await buildSetupRedirect(
      prepared.env,
      stateToken,
      returnTo,
      setupAction,
      installationId,
      origin,
    );
    res.status(302).setHeader('Location', target).end();
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
