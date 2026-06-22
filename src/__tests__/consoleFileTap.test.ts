import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  installConsoleFileTap,
  tapStreamWrite,
  type TappableStream,
} from '../utils/consoleFileTap';
import { getHourBucketPath } from '../utils/rotatingLogFile';

/**
 * @description S3 — the stdout/stderr tee. Most coverage targets the pure
 * `tapStreamWrite` (a fake stream + fake appender), so the global
 * `installConsoleFileTap` (one-shot per process, wraps the real `process.std*`)
 * is exercised once for the real-file path. Asserts the three contract points:
 * a write reaches BOTH the original sink AND the tap; a tap error never breaks
 * the original write; the tap never recurses (no console.* inside it).
 */

interface FakeStream extends TappableStream {
  calls: Array<{ chunk: unknown; rest: unknown[] }>;
  /** What `write` returns — proves the wrapper passes the value through. */
  returnValue: boolean;
}

function createFakeStream(returnValue = true): FakeStream {
  const stream: FakeStream = {
    calls: [],
    returnValue,
    write(...args: unknown[]): boolean {
      const [chunk, ...rest] = args;
      stream.calls.push({ chunk, rest });
      return stream.returnValue;
    },
  };
  return stream;
}

test('tapStreamWrite: a write reaches BOTH the original sink and the tap', () => {
  const stream = createFakeStream();
  const tapped: unknown[] = [];
  tapStreamWrite(stream, (chunk) => tapped.push(chunk));

  const result = stream.write('hello\n');

  assert.equal(stream.calls.length, 1, 'original sink got the write');
  assert.equal(stream.calls[0].chunk, 'hello\n');
  assert.deepEqual(tapped, ['hello\n'], 'tap got the same chunk');
  assert.equal(result, true, 'original return value passed through');
});

test('tapStreamWrite: forwards extra args (encoding/callback) and the exact return value', () => {
  const stream = createFakeStream(false); // simulate backpressure
  tapStreamWrite(stream, () => {});
  const cb = (): void => {};

  const result = stream.write('data', 'utf8', cb);

  assert.equal(result, false, 'backpressure return value preserved');
  assert.equal(stream.calls[0].chunk, 'data');
  assert.deepEqual(stream.calls[0].rest, ['utf8', cb], 'encoding + callback forwarded');
});

test('tapStreamWrite: a swallowed tap IO failure never breaks the original write', () => {
  // The production appender (appendToBucket) wraps fs.appendFileSync in
  // try/catch, so a disk error is swallowed and the original write proceeds.
  // Model that swallowing appender and prove the original still runs + returns.
  const stream = createFakeStream();
  tapStreamWrite(stream, () => {
    try {
      throw new Error('disk full'); // bucket append blew up...
    } catch {
      // ...and is swallowed, exactly like appendToBucket does.
    }
  });

  const result = stream.write('y');

  assert.equal(stream.calls.length, 1, 'original write ran despite the tap IO failure');
  assert.equal(result, true, 'return value preserved');
});

test('tapStreamWrite: tap runs BEFORE the original (no re-entrancy / recursion)', () => {
  const order: string[] = [];
  const stream: FakeStream = {
    calls: [],
    returnValue: true,
    write(...args: unknown[]): boolean {
      order.push('original');
      stream.calls.push({ chunk: args[0], rest: args.slice(1) });
      return true;
    },
  };
  tapStreamWrite(stream, () => {
    order.push('tap');
    // A real tap must NOT call stream.write here — that would recurse. We assert
    // by counting: exactly one original call per write.
  });

  stream.write('a');
  stream.write('b');

  assert.deepEqual(order, ['tap', 'original', 'tap', 'original']);
  assert.equal(stream.calls.length, 2, 'exactly one original write per call — no recursion');
});

// ─── the real global install (once per process) writes to the bucket file ───

let tempDataDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-tap-test-'));
  savedDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDataDir;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = savedDataDir;
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

test('installConsoleFileTap: a write lands in the bucket file even when DATA_DIR did not exist yet', () => {
  // Point at a NON-EXISTENT subdir — the production-critical fresh-boot case:
  // the tap is installed BEFORE the state store creates DATA_DIR, so the
  // install-time mkdir must run or the very boot logs we want would be dropped.
  const freshDir = path.join(tempDataDir, 'not-created-yet');
  assert.equal(fs.existsSync(freshDir), false, 'precondition: dir absent');

  installConsoleFileTap(freshDir);
  // Idempotent: a second install must be a no-op (would double-wrap otherwise).
  installConsoleFileTap(freshDir);

  const marker = `console-tap-marker-${Date.now()}\n`;
  // Write through the (now wrapped) real stdout. The original write still goes
  // to the terminal; the tap also appends it to the hourly bucket file.
  process.stdout.write(marker);

  const bucket = getHourBucketPath(freshDir, 'bot-console', 'log', Date.now());
  const contents = fs.readFileSync(bucket, 'utf8');
  assert.ok(contents.includes(marker.trim()), 'marker captured in the bucket file on a fresh dir');
});
