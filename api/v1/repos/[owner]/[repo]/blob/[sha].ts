import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res
    .status(501)
    .json({ error: 'GitHub App repo access now happens client-side with user tokens. Use the Express API.' });
}
