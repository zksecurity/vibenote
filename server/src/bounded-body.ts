// Size-bounded consumption of upstream (GitHub) response bodies.
// Repository content is controlled by whoever can push to the repository, so the server never
// materializes or forwards more than a fixed number of bytes from it.
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type express from 'express';
import { HttpError } from './http-error.ts';

export { readTextBounded, pipeBounded };

const TOO_LARGE = 'file too large';

// Read a response body as UTF-8 text, failing once it exceeds `maxBytes`.
async function readTextBounded(upstream: Response, maxBytes: number): Promise<string> {
  if (upstream.body === null) return '';
  await rejectDeclaredOversize(upstream, maxBytes);
  let chunks: Uint8Array[] = [];
  for await (let chunk of limitedChunks(upstream.body.getReader(), maxBytes)) {
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Stream a response body to the client with status 200 and `headers`, aborting once it exceeds
// `maxBytes`. Status and headers are set only once the first chunk passed the size check, so an
// early failure still gets a plain error response. `pipeline` applies backpressure.
async function pipeBounded(
  upstream: Response,
  res: express.Response,
  maxBytes: number,
  headers: Record<string, string>
): Promise<void> {
  if (upstream.body === null) {
    res.status(200).set(headers).end();
    return;
  }
  await rejectDeclaredOversize(upstream, maxBytes);
  let reader = upstream.body.getReader();
  // Stop reading from GitHub when the client goes away, even while a read is pending
  let cancel = () => {
    reader.cancel().catch(() => undefined);
  };
  if (res.destroyed) {
    cancel();
    return;
  }
  res.once('close', cancel);
  let chunks = limitedChunks(reader, maxBytes);
  let first = await chunks.next();
  res.status(200).set(headers);
  if (first.done === true) {
    res.end();
    return;
  }
  await pipeline(Readable.from(prepend(first.value, chunks)), res);
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
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number
): AsyncGenerator<Uint8Array> {
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

async function* prepend(first: Uint8Array, rest: AsyncGenerator<Uint8Array>): AsyncGenerator<Uint8Array> {
  yield first;
  yield* rest;
}
