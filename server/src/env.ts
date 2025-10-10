// Environment loader for the backend server
// Load .env from project root when running locally
import 'dotenv/config';

type Env = {
  PORT: number;
  ALLOWED_ORIGINS: string[];
  GITHUB_APP_SLUG: string;
  GITHUB_APP_ID: number;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string | undefined;
  SESSION_JWT_SECRET: string;
  SESSION_STORE_FILE: string;
  SESSION_ENCRYPTION_KEY: string;
  SHARE_STORE_FILE: string;
  PUBLIC_VIEWER_BASE_URL: string;
};

export function getEnv(): Env {
  const port = Number(process.env.PORT ?? 8787);
  const allowed = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET ?? 'dev-session-secret-change-me';
  const SESSION_STORE_FILE = process.env.SESSION_STORE_FILE ?? './server/data/sessions.json';
  const SESSION_ENCRYPTION_KEY = must('SESSION_ENCRYPTION_KEY');
  const SHARE_STORE_FILE = process.env.SHARE_STORE_FILE ?? './server/data/shares.json';
  const PUBLIC_VIEWER_BASE_URL = process.env.PUBLIC_VIEWER_BASE_URL ?? 'https://vibenote.dev';
  const GITHUB_APP_ID = Number(must('GITHUB_APP_ID'));
  if (!Number.isFinite(GITHUB_APP_ID)) {
    throw new Error('GITHUB_APP_ID must be a number');
  }
  const GITHUB_APP_PRIVATE_KEY = normalizePrivateKey(must('GITHUB_APP_PRIVATE_KEY'));
  const env: Env = {
    PORT: Number.isFinite(port) ? port : 8787,
    ALLOWED_ORIGINS: allowed,
    GITHUB_APP_SLUG: must('GITHUB_APP_SLUG'),
    GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY,
    GITHUB_OAUTH_CLIENT_ID: must('GITHUB_OAUTH_CLIENT_ID'),
    GITHUB_OAUTH_CLIENT_SECRET: must('GITHUB_OAUTH_CLIENT_SECRET'),
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    SESSION_JWT_SECRET,
    SESSION_STORE_FILE,
    SESSION_ENCRYPTION_KEY,
    SHARE_STORE_FILE,
    PUBLIC_VIEWER_BASE_URL,
  };
  return env;
}

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

function normalizePrivateKey(raw: string): string {
  let trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('GITHUB_APP_PRIVATE_KEY must not be empty');
  }
  if (trimmed.includes('-----BEGIN') && trimmed.includes('PRIVATE KEY-----')) {
    return trimmed;
  }
  try {
    let decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
    if (decoded.includes('-----BEGIN') && decoded.includes('PRIVATE KEY-----')) {
      return decoded;
    }
  } catch {
    // fall through to error below
  }
  throw new Error('GITHUB_APP_PRIVATE_KEY must be a PEM string or base64-encoded PEM');
}

export type { Env };
