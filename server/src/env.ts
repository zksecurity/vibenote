// Environment loader for the backend server
// Load .env from project root when running locally
import 'dotenv/config';
import crypto from 'node:crypto';

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

  let candidate = trimmed;
  if (!candidate.includes('-----BEGIN')) {
    candidate = decodeBase64Pem(candidate);
  }

  if (!candidate.includes('-----BEGIN')) {
    throw new Error('GITHUB_APP_PRIVATE_KEY must be a PEM string or base64-encoded PEM');
  }

  candidate = ensurePkcs8(candidate);
  return candidate.endsWith('\n') ? candidate : `${candidate}\n`;
}

function decodeBase64Pem(value: string): string {
  try {
    const buf = Buffer.from(value, 'base64');
    if (buf.length === 0) return value;
    return buf.toString('utf8').trim();
  } catch {
    return value;
  }
}

function ensurePkcs8(pem: string): string {
  const header = detectPemHeader(pem);
  if (header === 'PRIVATE KEY') {
    return pem.trim();
  }
  if (header === 'RSA PRIVATE KEY') {
    try {
      const keyObject = crypto.createPrivateKey({ key: pem, format: 'pem' });
      const exported = keyObject.export({ format: 'pem', type: 'pkcs8' });
      return typeof exported === 'string' ? exported.trim() : exported.toString('utf8').trim();
    } catch (error) {
      throw new Error(`Failed to convert RSA private key to PKCS#8: ${(error as Error).message}`);
    }
  }
  throw new Error('GITHUB_APP_PRIVATE_KEY must be PKCS#8 (-----BEGIN PRIVATE KEY-----) or an RSA key convertible to PKCS#8');
}

function detectPemHeader(pem: string): string | null {
  const match = pem.match(/-----BEGIN ([A-Z ]+)-----/);
  return match ? match[1] ?? null : null;
}

export type { Env };
