/**
 * @description The voice-download path must survive a flaky link: a transient
 * stall (timeout / 5xx / reset) should recover automatically on a retry so the
 * user never has to re-send the voice note, while a permanent failure (4xx)
 * must fail fast. These tests drive the real `downloadFile` against a local
 * HTTP server whose behaviour we script per-attempt.
 */

import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  downloadFile,
  DownloadError,
  checkIsRetryableDownloadError,
} from '../utils/download';

// A scriptable server: each connection consumes the next handler from a queue.
let server: http.Server;
let baseUrl = '';
let handlers: Array<(req: http.IncomingMessage, res: http.ServerResponse) => void> = [];

before(async () => {
  server = http.createServer((req, res) => {
    const handler = handlers.shift();
    if (!handler) {
      res.statusCode = 500;
      res.end('no handler queued');
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function tmpPath(): string {
  return path.join(os.tmpdir(), `dl_test_${process.pid}_${Math.random().toString(36).slice(2)}.bin`);
}

const ok = (body: string) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.statusCode = 200;
  res.end(body);
};

test('classifier: timeouts and 5xx/429 are retryable, 4xx and unknown are not', () => {
  assert.equal(checkIsRetryableDownloadError(new DownloadError('boom', { retryable: true })), true);
  assert.equal(checkIsRetryableDownloadError(new DownloadError('nope', { retryable: false })), false);
  assert.equal(checkIsRetryableDownloadError(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true);
  assert.equal(checkIsRetryableDownloadError(new Error('socket hang up')), true);
  assert.equal(checkIsRetryableDownloadError(new Error('totally unknown')), false);
});

test('succeeds on the first attempt and writes the body', async () => {
  handlers = [ok('hello-voice')];
  const dest = tmpPath();
  await downloadFile(`${baseUrl}/f`, dest, { retries: 2 });
  assert.equal(await fsp.readFile(dest, 'utf-8'), 'hello-voice');
  await fsp.unlink(dest).catch(() => {});
});

test('recovers on the SECOND attempt after a transient 503', async () => {
  let attempts = 0;
  handlers = [
    (_req, res) => { attempts++; res.statusCode = 503; res.end('try later'); },
    (_req, res) => { attempts++; res.statusCode = 200; res.end('recovered'); },
  ];
  const dest = tmpPath();
  await downloadFile(`${baseUrl}/f`, dest, { retries: 2 });
  assert.equal(attempts, 2);
  assert.equal(await fsp.readFile(dest, 'utf-8'), 'recovered');
  await fsp.unlink(dest).catch(() => {});
});

test('recovers after a per-attempt TIMEOUT (the original symptom)', async () => {
  let attempts = 0;
  handlers = [
    // First attempt: never respond → forces the socket timeout to fire.
    (_req, _res) => { attempts++; /* hang */ },
    (_req, res) => { attempts++; res.statusCode = 200; res.end('after-timeout'); },
  ];
  const dest = tmpPath();
  await downloadFile(`${baseUrl}/f`, dest, { retries: 2, timeoutMs: 300 });
  assert.equal(attempts, 2);
  assert.equal(await fsp.readFile(dest, 'utf-8'), 'after-timeout');
  await fsp.unlink(dest).catch(() => {});
});

test('fails FAST on a 4xx without retrying', async () => {
  let attempts = 0;
  handlers = [
    (_req, res) => { attempts++; res.statusCode = 404; res.end('nope'); },
    ok('should-not-be-reached'),
  ];
  const dest = tmpPath();
  await assert.rejects(
    () => downloadFile(`${baseUrl}/f`, dest, { retries: 2 }),
    (err: unknown) => err instanceof DownloadError && err.statusCode === 404 && err.retryable === false,
  );
  assert.equal(attempts, 1); // no retry burned on a permanent error
});

test('gives up after exhausting retries and reports the last error', async () => {
  let attempts = 0;
  const fail = (_req: http.IncomingMessage, res: http.ServerResponse) => { attempts++; res.statusCode = 500; res.end('down'); };
  handlers = [fail, fail, fail];
  const dest = tmpPath();
  await assert.rejects(
    () => downloadFile(`${baseUrl}/f`, dest, { retries: 2 }),
    (err: unknown) => err instanceof DownloadError && err.statusCode === 500,
  );
  assert.equal(attempts, 3); // initial + 2 retries
});

test('fires onRetry once per retry with increasing backoff', async () => {
  handlers = [
    (_req, res) => { res.statusCode = 500; res.end('x'); },
    ok('done'),
  ];
  const seen: number[] = [];
  const dest = tmpPath();
  await downloadFile(`${baseUrl}/f`, dest, {
    retries: 2,
    onRetry: (attempt, _err, delayMs) => seen.push(delayMs),
  });
  assert.equal(seen.length, 1);
  assert.ok(seen[0] >= 500, `expected backoff >= 500ms, got ${seen[0]}`);
  await fsp.unlink(dest).catch(() => {});
});
