import { appendFileSync, mkdirSync } from 'node:fs';
import { getHourBucketPath } from './rotatingLogFile';

/**
 * @description Tee `process.stdout`/`process.stderr` to an hourly bucket file so
 * the bot's console logs ([transcribe], [Bot], errors, …) are readable AFTER the
 * fact, not only on the operator's live terminal. The original `write` still
 * runs (terminal preserved) — this is a TEE, never a redirect-away.
 *
 * Critical constraints:
 *  - Best-effort: a tap append failure is swallowed; it must NEVER throw into
 *    the hot `write()` path or change the original write's return value.
 *  - NO recursion: the tap appends with `fs.appendFileSync` directly and uses
 *    NO `console.*` / no `process.std*.write` — logging from inside the tap
 *    would re-enter the wrapped write and loop forever.
 *  - Idempotent: a second install is a no-op (a hot rebuild re-imports cleanly).
 */

/** Bucket file base + extension — `bot-console-YYYYMMDDHH.log` per hour. The
 * janitor (bot.ts) imports these to prune the same family it doesn't write. */
export const consoleFileBase = 'bot-console';
export const consoleFileExt = 'log';

let isInstalled = false;

/** Chunk shapes the wrapped `write` may receive (matches Node's overloads). */
type WriteChunk = string | Uint8Array;

/** Minimal view of a writable stream the tap wraps — just its `write`. */
export interface TappableStream {
  write(...args: unknown[]): boolean;
}

/** How the tap appends a chunk — injectable so tests assert without real IO. */
export type AppendChunkFn = (chunk: WriteChunk) => void;

function appendToBucket(dir: string, chunk: WriteChunk): void {
  try {
    appendFileSync(getHourBucketPath(dir, consoleFileBase, consoleFileExt, Date.now()), chunk);
  } catch {
    // Best-effort: a tap write failure must never break the original write.
  }
}

/**
 * @description Wrap ONE stream's `write` so every call ALSO feeds the chunk to
 * `appendChunk` (the tap) before forwarding to the original. The original's
 * arguments are forwarded verbatim and its exact return value is returned, so
 * backpressure semantics are untouched; `appendChunk` is a pure side effect that
 * is called FIRST and must itself never throw (the bucket appender swallows IO
 * errors). Pure of `process`/fs — the unit of test for S3.
 */
export function tapStreamWrite(stream: TappableStream, appendChunk: AppendChunkFn): void {
  const originalWrite = stream.write.bind(stream);
  stream.write = ((chunk: WriteChunk, ...rest: unknown[]): boolean => {
    appendChunk(chunk);
    return originalWrite(chunk, ...rest);
  }) as typeof stream.write;
}

/**
 * @description Tee `process.stdout`/`process.stderr` to the hourly bucket file
 * `DATA_DIR/bot-console-YYYYMMDDHH.log`. Install as EARLY as possible at the bot
 * entry so boot logs are captured. Idempotent (a second call is a no-op) so a
 * hot rebuild re-import can't double-wrap.
 */
export function installConsoleFileTap(dir: string): void {
  if (isInstalled) return;
  isInstalled = true;
  // Ensure DATA_DIR exists ONCE up front. On a fresh install the dir is created
  // later by the state store's load() — but the tap is installed before that, so
  // without this the very boot logs we want to capture would `ENOENT` and be
  // swallowed (the run that matters most). Mirrors outputTrace.ts / diagLog.ts.
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort: if the dir can't be created the per-append swallow still holds.
  }
  for (const stream of [process.stdout, process.stderr]) {
    tapStreamWrite(stream, (chunk) => appendToBucket(dir, chunk));
  }
}
