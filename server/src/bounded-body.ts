// Size-bounded consumption of upstream (GitHub) response bodies.
// Repository content is controlled by whoever can push to the repository, so the server never
// materializes or forwards more than a fixed number of bytes from it.
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type express from 'express';
import { HttpError } from './common.ts';

export { readTextBounded, pipeBounded };

const TOO_LARGE = 'file too large';

// Read a response body as UTF-8 text, failing once it exceeds `maxBytes`.
async function readTextBounded(upstream: Response, maxBytes: number): Promise<string> {
  if (upstream.body === null) return '';
  await rejectDeclaredOversize(upstream, maxBytes);
  let chunks: Uint8Array[] = [];
  for await (let chunk of limitedChunks(upstream.body, maxBytes)) {
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Stream a response body to the client, aborting once it exceeds `maxBytes`.
// The caller sets status and headers on `res` before calling this. `pipeline` applies backpressure
// and stops reading from GitHub when the client disconnects.
async function pipeBounded(upstream: Response, res: express.Response, maxBytes: number): Promise<void> {
  if (upstream.body === null) {
    res.end();
    return;
  }
  await rejectDeclaredOversize(upstream, maxBytes);
  await pipeline(Readable.from(limitedChunks(upstream.body, maxBytes)), res);
}

// Fail before reading anything when the upstream already declares a body that is too large.
async function rejectDeclaredOversize(upstream: Response, maxBytes: number): Promise<void> {
  let declared = Number(upstream.headers.get('Content-Length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await upstream.body?.cancel();
    throw HttpError(413, TOO_LARGE);
  }
}

// Yield the body's chunks until more than `maxBytes` arrived; the upstream read is cancelled on any exit.
async function* limitedChunks(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): AsyncGenerator<Uint8Array> {
  let reader = body.getReader();
  let received = 0;
  try {
    while (true) {
      let result = await reader.read();
      if (result.done) return;
      received += result.value.byteLength;
      if (received > maxBytes) throw HttpError(413, TOO_LARGE);
      yield result.value;
    }
  } finally {
    await reader.cancel();
  }
}
