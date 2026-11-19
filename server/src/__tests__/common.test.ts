// @vitest-environment node
// Tests for shared request helpers.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('../env.ts', () => ({
  env: {
    SESSION_JWT_SECRET: 'test-secret',
  },
}));

import express from 'express';
import type { Server } from 'node:http';
import { queryParam } from '../common.ts';

// The global setup file stubs fetch with vi.fn(). We need the real one.
const realFetch = globalThis.fetch.bind(globalThis);

describe('queryParam', () => {
  let server: Server;
  let baseUrl = '';

  beforeAll(async () => {
    let app = express();
    app.get('/echo', (req, res) => {
      res.json({ value: queryParam(req, 'returnTo') });
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    let address = server.address();
    if (address === null || typeof address === 'string') throw Error('unexpected server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  async function echo(query: string): Promise<string> {
    let res = await realFetch(`${baseUrl}/echo?${query}`);
    let body: unknown = await res.json();
    if (typeof body !== 'object' || body === null || !('value' in body) || typeof body.value !== 'string') {
      throw Error('unexpected response');
    }
    return body.value;
  }

  it('returns plain string values', async () => {
    expect(await echo('returnTo=https%3A%2F%2Fexample.com')).toBe('https://example.com');
  });

  it('returns an empty string for missing values', async () => {
    expect(await echo('other=1')).toBe('');
  });

  it('returns an empty string for nested objects that cannot be stringified', async () => {
    expect(await echo('returnTo[toString]=x')).toBe('');
  });

  it('returns an empty string for repeated parameters', async () => {
    expect(await echo('returnTo=a&returnTo=b')).toBe('');
  });
});
