import express from 'express';
import { env } from './env.ts';
import { verifyBearerSession } from './api.ts';

import { HttpErrorClass } from './http-error.ts';

export { requireSession, handleErrors, queryParam };

function requireSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  let header = req.header('authorization') || req.header('Authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    return res.status(401).json({ error: 'missing auth' });
  }
  let token = header.slice(7).trim();
  verifyBearerSession(token, env)
    .then((claims) => {
      req.sessionUser = claims;
      next();
    })
    .catch(() => res.status(401).json({ error: 'invalid session' }));
}

function handleErrors<T>(route: (req: express.Request, res: express.Response) => Promise<T>) {
  return async function (req: express.Request, res: express.Response): Promise<T | void> {
    try {
      return await route(req, res);
    } catch (error) {
      // A streamed response can fail after its headers went out; all we can do is cut the connection
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpErrorClass) {
        res.status(error.status).json({ error: error.message });
      } else {
        // Unexpected errors can carry upstream responses or server paths; log them, answer generically
        console.error('[vibenote] request failed', error);
        res.status(500).json({ error: 'internal error' });
      }
    }
  };
}

// Read a query parameter as a plain string. Express's extended query parser turns inputs like
// `a[b]=c` or `a=1&a=2` into objects and arrays, which must never reach string handling.
function queryParam(req: express.Request, name: string): string {
  let value = req.query[name];
  return typeof value === 'string' ? value : '';
}
