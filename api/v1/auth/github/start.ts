import type { VercelRequest, VercelResponse } from '@vercel/node';
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res
    .status(501)
    .json({ error: 'GitHub App auth requires the stateful Express backend. Deploy /server instead.' });
}
