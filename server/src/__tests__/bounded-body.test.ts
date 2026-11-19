// @vitest-environment node
// Tests for size-bounded reading and streaming of upstream response bodies.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('../env.ts', () => ({
  env: {
    SESSION_JWT_SECRET: 'test-secret',
  },
}));

import express from 'express';
import type { Server } from 'node:http';
import { handleErrors } from '../common.ts';
import { readTextBounded, pipeBounded } from '../bounded-body.ts';

// The global setup file stubs fetch with vi.fn(). We need the real one.
const realFetch = globalThis.fetch.bind(globalThis);

// A body delivered in several chunks, without a Content-Length header.
function chunkedResponse(chunks: string[]): Response {
  let encoder = new TextEncoder();
  let body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body);
}

describe('readTextBounded', () => {
  it('rejects bodies that grow past the limit while streaming', async () => {
    await expect(readTextBounded(chunkedResponse(['hello ', 'world']), 10)).rejects.toMatchObject({
      status: 413,
    });
  });
});

describe('pipeBounded', () => {
  let server: Server;
  let baseUrl = '';
  let upstreamChunks: string[] = [];
  const ASSET_HEADERS = { 'Content-Type': 'image/png' };

  beforeAll(async () => {
    let app = express();
    app.get(
      '/asset',
      handleErrors(async (_req, res) => {
        await pipeBounded(chunkedResponse(upstreamChunks), res, 10, ASSET_HEADERS);
      })
    );
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

  it('cuts the connection when the body grows past the limit', async () => {
    upstreamChunks = ['hello', 'world', '!'];
    let failed = false;
    try {
      let res = await realFetch(`${baseUrl}/asset`);
      await res.text();
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    // The server keeps serving after the aborted response
    upstreamChunks = ['ok'];
    let res = await realFetch(`${baseUrl}/asset`);
    expect(await res.text()).toBe('ok');
  });
});
