// Environment loader for the backend server
// Load .env from project root when running locally
import 'dotenv/config';

type Env = {
  PORT: number;
  ALLOWED_ORIGINS: string[];
  GITHUB_APP_SLUG: string;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string | undefined;
  SESSION_JWT_SECRET: string;
  SESSION_STORE_FILE: string;
  SESSION_ENCRYPTION_KEY: string;
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
  const env: Env = {
    PORT: Number.isFinite(port) ? port : 8787,
    ALLOWED_ORIGINS: allowed,
    GITHUB_APP_SLUG: must('GITHUB_APP_SLUG'),
    GITHUB_OAUTH_CLIENT_ID: must('GITHUB_OAUTH_CLIENT_ID'),
    GITHUB_OAUTH_CLIENT_SECRET: must('GITHUB_OAUTH_CLIENT_SECRET'),
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    SESSION_JWT_SECRET,
    SESSION_STORE_FILE,
    SESSION_ENCRYPTION_KEY,
  };
  return env;
}

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

export type { Env };
