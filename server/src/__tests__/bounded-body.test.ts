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
  it('reads bodies within the limit', async () => {
    expect(await readTextBounded(chunkedResponse(['hello ', 'world']), 11)).toBe('hello world');
  });

  it('rejects bodies that grow past the limit while streaming', async () => {
    await expect(readTextBounded(chunkedResponse(['hello ', 'world']), 10)).rejects.toMatchObject({
      status: 413,
    });
  });

  it('rejects bodies whose declared length exceeds the limit', async () => {
    let res = new Response('hello world', { headers: { 'Content-Length': '11' } });
    await expect(readTextBounded(res, 10)).rejects.toMatchObject({ status: 413 });
  });
});

describe('pipeBounded', () => {
  let server: Server;
  let baseUrl = '';
  let upstreamChunks: string[] = [];
  let stalledUpstreamCancelled = false;
  const ASSET_HEADERS = { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' };

  function stalledResponse(): Response {
    let body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello'));
      },
      cancel() {
        stalledUpstreamCancelled = true;
      },
    });
    return new Response(body);
  }

  async function waitForCancel(): Promise<boolean> {
    for (let i = 0; i < 50 && !stalledUpstreamCancelled; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return stalledUpstreamCancelled;
  }

  beforeAll(async () => {
    let app = express();
    app.get(
      '/asset',
      handleErrors(async (_req, res) => {
        await pipeBounded(chunkedResponse(upstreamChunks), res, 10, ASSET_HEADERS);
      })
    );
    // An upstream that sends one chunk and then stalls
    app.get(
      '/stalled',
      handleErrors(async (_req, res) => {
        await pipeBounded(stalledResponse(), res, 10, ASSET_HEADERS);
      })
    );
    // The same, but streaming only starts after the client may already have left
    app.get(
      '/late',
      handleErrors(async (_req, res) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await pipeBounded(stalledResponse(), res, 10, ASSET_HEADERS);
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

  it('answers with an error status when the first chunk already exceeds the limit', async () => {
    upstreamChunks = ['hello world!'];
    let res = await realFetch(`${baseUrl}/asset`);
    expect(res.status).toBe(413);
    // The error must not carry the asset's type or public cache policy
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Cache-Control')).toBeNull();
    expect(await res.json()).toEqual({ error: 'file too large' });
  });

  it('cancels a stalled upstream read when the client disconnects', async () => {
    let controller = new AbortController();
    let res = await realFetch(`${baseUrl}/stalled`, { signal: controller.signal });
    let reader = res.body?.getReader();
    await reader?.read();
    controller.abort();
    expect(await waitForCancel()).toBe(true);
  });

  it('cancels the upstream read when the client left before streaming started', async () => {
    stalledUpstreamCancelled = false;
    let controller = new AbortController();
    let pending = realFetch(`${baseUrl}/late`, { signal: controller.signal }).catch(() => undefined);
    setTimeout(() => controller.abort(), 50);
    await pending;
    expect(await waitForCancel()).toBe(true);
  });

  it('streams bodies within the limit', async () => {
    upstreamChunks = ['hello', 'world'];
    let res = await realFetch(`${baseUrl}/asset`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('helloworld');
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
