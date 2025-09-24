// Environment loader for the backend server
// Load .env from project root when running locally
import 'dotenv/config';

type Env = {
  PORT: number;
  ALLOWED_ORIGINS: string[];
  GITHUB_APP_ID: string;
  GITHUB_APP_SLUG: string;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string | undefined;
  SESSION_JWT_SECRET: string;
  PRIVATE_KEY_PEM: string;
};

function readPrivateKey(): string {
  const b64 = process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
  if (b64) {
    return Buffer.from(b64, 'base64').toString('utf8');
  }
  const path = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (path) {
    const fs = require('fs') as typeof import('fs');
    return fs.readFileSync(path, 'utf8');
  }
  const inline = process.env.GITHUB_APP_PRIVATE_KEY;
  if (inline) {
    return inline.replace(/\\n/g, '\n');
  }
  throw new Error('Missing GitHub App private key (set *_BASE64, *_PATH, or inline var)');
}

export function getEnv(): Env {
  const port = Number(process.env.PORT ?? 8787);
  const allowed = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET ?? 'dev-session-secret-change-me';
  const env: Env = {
    PORT: Number.isFinite(port) ? port : 8787,
    ALLOWED_ORIGINS: allowed,
    GITHUB_APP_ID: must('GITHUB_APP_ID'),
    GITHUB_APP_SLUG: must('GITHUB_APP_SLUG'),
    GITHUB_OAUTH_CLIENT_ID: must('GITHUB_OAUTH_CLIENT_ID'),
    GITHUB_OAUTH_CLIENT_SECRET: must('GITHUB_OAUTH_CLIENT_SECRET'),
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    SESSION_JWT_SECRET,
    PRIVATE_KEY_PEM: readPrivateKey(),
  };
  return env;
}

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

export type { Env };
