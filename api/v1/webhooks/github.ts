import type { VercelRequest, VercelResponse } from '@vercel/node';
import { prepare } from '../../_lib/http.ts';

export default function handler(req: VercelRequest, res: VercelResponse) {
  const prepared = prepare(req, res);
  if (!prepared) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  res.status(204).end();
}
