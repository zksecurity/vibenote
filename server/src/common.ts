import express from 'express';
import { env } from './env.ts';
import { verifyBearerSession } from './api.ts';

export { requireSession, handleErrors, HttpError };

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
      if (error instanceof HttpErrorClass) {
        res.status(error.status).json({ error: error.message });
      } else {
        res.status(400).json({ error: getErrorMessage(error) });
      }
    }
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function HttpError(status: number, message: string): HttpErrorClass {
  return new HttpErrorClass(status, message);
}

class HttpErrorClass extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
