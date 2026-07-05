/**
 * @description Host layout + IO primitives for the json-stream Claude backend's
 * EXTERNAL process transport (plan 2026-07-05-jsonstream-restart-isolation).
 *
 * The `claude -p … stream-json` process is NOT a bot child any more: a `#!/bin/sh`
 * wrapper hosts it inside a detached tmux session, with stdio rerouted to files
 * under `DATA_DIR/jsonstream/<chatId>_<threadId>/`:
 *
 *   stdin.fifo    ← the bot's control/user-turn writes (claude holds it `0<>`,
 *                   i.e. open read-write on fd 0, so a bot restart — the writer
 *                   dying — never EOFs claude's stdin; proven by the P1 probe)
 *   stdout.jsonl  ← append-only stream-json event log the bot TAILS from a byte
 *                   offset (deltas keep landing while the bot is down)
 *   stderr.log    ← passive; read only for spawn-fail / exit diagnostics
 *   pid, exitcode ← written by the wrapper; the adapter's poll tick uses them
 *                   for exit detection (pid-alive + exitcode file)
 *   wrapper.sh    ← the generated host script itself
 *   question.json ← the pending AskUserQuestion control_request (written when
 *                   surfaced, removed when resolved) so an adopt after a bot
 *                   restart can still answer it over the FIFO
 *
 * Everything here is either pure decision logic (tail offsets, wrapper text,
 * name codecs) or a thin fs primitive (FIFO open/write, pid/exitcode readers)
 * — the orchestration lives in `adapters/claudeJsonStreamAdapter.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { setTimeout as sleep } from 'timers/promises';
import { keyToString, type ThreadKey } from '../types';
import { buildTmuxSessionName, parseTmuxSessionName } from './tmuxSessionName';
import { shellSingleQuote } from './tmuxExec';

/** Subdirectory of `DATA_DIR` that holds every thread's json-stream host dir. */
export const jsonStreamRootDirName = 'jsonstream';

/** tmux session-name prefix for this backend — distinct from the scrape
 *  backend's `claude` and the terminal's `term`, so adopt-at-boot scans never
 *  cross-talk (locked decision). */
export const jsonStreamTmuxPrefix = 'cjson';

/** Exit code the wrapper reports when `cd <workDir>` fails (folder vanished
 *  between bind and spawn) — claude must never run in the wrong directory. */
export const wrapperCdFailExitCode = 96;

/** How long a fresh spawn waits for the wrapper to write the `pid` file. */
export const pidFileWaitTimeoutMs = 5000;
export const pidFilePollIntervalMs = 100;

/** FIFO write-open guard (P1 probe): `O_WRONLY|O_NONBLOCK` raises `ENXIO`
 *  while nothing holds the read end — a BLOCKING open would hang forever.
 *  Retried because claude opens its `0<>` end asynchronously during spawn;
 *  `ENXIO` persisting past the retries means the process is dead. */
export const fifoOpenMaxTries = 10;
export const fifoOpenRetryDelayMs = 500;

/** A full FIFO buffer raises `EAGAIN` on a non-blocking write — transient,
 *  claude drains it. Bounded so a truly wedged reader can't spin forever. */
export const fifoWriteMaxRetries = 100;
export const fifoWriteRetryDelayMs = 50;

/** No rotation in v1 (locked decision): the file is per-session and deleted on
 *  stop/release. Past this size we log ONE warning, never rotate. */
export const stdoutOversizeWarnBytes = 256 * 1024 * 1024;

/** Cap for the stderr excerpt quoted into spawn-fail / unexpected-exit logs. */
export const stderrTailMaxChars = 400;

/** Absolute paths of every file in one thread's json-stream host dir. */
export interface JsonStreamSessionPaths {
  dir: string;
  stdinFifo: string;
  stdoutFile: string;
  stderrFile: string;
  pidFile: string;
  exitCodeFile: string;
  wrapperFile: string;
  questionFile: string;
}

/** Absolute path of the `jsonstream/` root under a given data dir. */
export function resolveJsonStreamRoot(dataDir: string): string {
  return path.join(dataDir, jsonStreamRootDirName);
}

/** The per-thread host dir name — `<chatId>_<threadId>` (same convention as
 *  `botFileStorage`'s intake dirs: `:` is illegal on some filesystems). */
function threadDirName(key: ThreadKey): string {
  return keyToString(key).replace(':', '_');
}

/** Absolute path of one thread's json-stream host dir. */
export function resolveJsonStreamSessionDir(dataDir: string, key: ThreadKey): string {
  return path.join(resolveJsonStreamRoot(dataDir), threadDirName(key));
}

/**
 * @description Inverse of the host-dir naming for the orphan-dir janitor.
 * Strict per-half regexes (mirrors `parseTmuxSessionName`) so a foreign dir
 * that happens to sit under `jsonstream/` is skipped, never swept by a
 * mis-parse.
 */
export function parseJsonStreamDirName(name: string): ThreadKey | null {
  const match = /^(-?\d+)_(\d+)$/.exec(name);
  if (!match) return null;
  return { chatId: Number(match[1]), threadId: Number(match[2]) };
}

export function getJsonStreamSessionPaths(dir: string): JsonStreamSessionPaths {
  return {
    dir,
    stdinFifo: path.join(dir, 'stdin.fifo'),
    stdoutFile: path.join(dir, 'stdout.jsonl'),
    stderrFile: path.join(dir, 'stderr.log'),
    pidFile: path.join(dir, 'pid'),
    exitCodeFile: path.join(dir, 'exitcode'),
    wrapperFile: path.join(dir, 'wrapper.sh'),
    questionFile: path.join(dir, 'question.json'),
  };
}

/** tmux session name for a json-stream thread (`cjson-<chatId>-<threadId>`). */
export function buildJsonStreamTmuxSessionName(key: ThreadKey): string {
  return buildTmuxSessionName(jsonStreamTmuxPrefix, key);
}

/** Inverse of {@link buildJsonStreamTmuxSessionName}; `null` for foreign names. */
export function parseJsonStreamTmuxSessionName(name: string): ThreadKey | null {
  return parseTmuxSessionName(jsonStreamTmuxPrefix, name);
}

/**
 * @description The `#!/bin/sh` host script (exact shape proven by the P1 probe
 * `p1-probe2.mjs`): background claude with its stdio rerouted to the host files,
 * record the child pid, then `wait` and record the exit code. `0<>` opens the
 * stdin FIFO READ-WRITE on fd 0 — the load-bearing trick: claude itself holds a
 * read end open, so the bot (a plain writer) can die and reconnect freely.
 * `env -u ANTHROPIC_API_KEY` keeps subscription billing (`apiKeySource:"none"`)
 * even if the tmux server environment carries a key. All embedded strings are
 * single-quoted; `claudePath` must be ABSOLUTE (tmux server PATH differs).
 */
export function buildWrapperScript(
  claudePath: string,
  args: readonly string[],
  workDir: string,
  paths: JsonStreamSessionPaths,
): string {
  const command = [claudePath, ...args].map(shellSingleQuote).join(' ');
  return `#!/bin/sh
cd ${shellSingleQuote(workDir)} || exit ${wrapperCdFailExitCode}
env -u ANTHROPIC_API_KEY ${command} \\
  0<> ${shellSingleQuote(paths.stdinFifo)} >> ${shellSingleQuote(paths.stdoutFile)} 2>> ${shellSingleQuote(paths.stderrFile)} &
CHILD=$!
echo $CHILD > ${shellSingleQuote(paths.pidFile)}
wait $CHILD
echo $? > ${shellSingleQuote(paths.exitCodeFile)}
`;
}

/**
 * @description Open the stdin FIFO for writing WITHOUT ever blocking: a plain
 * `open(O_WRONLY)` on a FIFO with no reader hangs forever (the P1 probe's first
 * attempt did exactly that). `O_NONBLOCK` turns "no reader" into `ENXIO`,
 * retried on a short delay while claude is still coming up. Returns the fd, or
 * `null` when `ENXIO` persists — i.e. the claude process is NOT holding the
 * FIFO, so the session is dead.
 */
export async function openFifoWriterNonBlocking(
  fifoPath: string,
  maxTries: number = fifoOpenMaxTries,
): Promise<number | null> {
  for (let attempt = 0; attempt < maxTries; attempt++) {
    try {
      return fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENXIO') throw e;
      await sleep(fifoOpenRetryDelayMs);
    }
  }
  return null;
}

/**
 * @description Write `text` to a non-blocking FIFO fd, retrying transient
 * `EAGAIN` (buffer full — claude drains it) with a bounded backoff and
 * continuing partial writes (a payload larger than the FIFO buffer lands in
 * chunks). Anything else (`EPIPE` after claude died, `EBADF` after close)
 * propagates to the caller's per-session write chain, which logs it.
 */
export async function writeFifoText(fd: number, text: string): Promise<void> {
  const payload = Buffer.from(text, 'utf8');
  let written = 0;
  let retries = 0;
  while (written < payload.length) {
    try {
      written += fs.writeSync(fd, payload, written, payload.length - written);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EAGAIN' || retries >= fifoWriteMaxRetries) throw e;
      retries += 1;
      await sleep(fifoWriteRetryDelayMs);
    }
  }
}

/** Parse a `pid`/`exitcode` file: strict digits, `null` for missing/garbage. */
function readIntFile(filePath: string): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

export function readPidFile(pidFile: string): number | null {
  return readIntFile(pidFile);
}

export function readExitCodeFile(exitCodeFile: string): number | null {
  return readIntFile(exitCodeFile);
}

/** `kill(pid, 0)` liveness probe (no signal actually delivered). */
export function checkIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait (bounded) for the wrapper to write the `pid` file after tmux spawn.
 *  Returns the pid, or `null` on timeout (spawn diagnostics read stderr). */
export async function waitForPidFile(
  pidFile: string,
  timeoutMs: number = pidFileWaitTimeoutMs,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = readPidFile(pidFile);
    if (pid !== null) return pid;
    await sleep(pidFilePollIntervalMs);
  }
  return readPidFile(pidFile);
}

/** Last `maxChars` of the passive stderr log — spawn-fail / exit diagnostics
 *  only (locked decision: no live stderr consumer). Empty when absent. */
export function readStderrTail(stderrFile: string, maxChars: number = stderrTailMaxChars): string {
  try {
    const raw = fs.readFileSync(stderrFile, 'utf8').trim();
    return raw.length > maxChars ? raw.slice(-maxChars) : raw;
  } catch {
    return '';
  }
}

/** File size in bytes, or `null` when the file doesn't exist (yet). */
export function getFileSize(filePath: string): number | null {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

/** Read the byte range `[startOffset..endOffset)` of a file. May return fewer
 *  bytes than asked on a race — the tail accounts by ACTUAL bytes consumed. */
export function readFileByteRange(filePath: string, startOffset: number, endOffset: number): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const wanted = endOffset - startOffset;
    const buffer = Buffer.alloc(wanted);
    const bytesRead = fs.readSync(fd, buffer, 0, wanted, startOffset);
    return bytesRead === wanted ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  stdout tail state — offset bookkeeping for the append-only stream-json log
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @description Tail bookkeeping for ONE session's `stdout.jsonl` (the pattern of
 * `claudeSubagentTail`, adapted to a single file feeding the stream-json line
 * reader). Byte-exact so the offset persisted across bot restarts always lands
 * on a LINE BOUNDARY — the restarted tail resumes on clean JSON, never a torn
 * line:
 *
 *   consumedBytes        — file bytes read + fed to the utf8 decoder
 *   decoderRetainedBytes — bytes the decoder holds back (a multi-byte char split
 *                          at a read boundary; stdout is block-buffered, so
 *                          splits mid-char DO happen with non-ASCII deltas)
 *
 * The line-boundary offset additionally subtracts the line reader's pending
 * partial line ({@link getStdoutLineBoundaryOffset}) — those bytes were consumed
 * but not yet processed, so a restart re-reads exactly them and nothing twice.
 */
export interface StdoutTailState {
  consumedBytes: number;
  decoderRetainedBytes: number;
  decoder: StringDecoder;
}

export function createStdoutTailState(startOffsetBytes: number): StdoutTailState {
  return { consumedBytes: startOffsetBytes, decoderRetainedBytes: 0, decoder: new StringDecoder('utf8') };
}

/** What one tail poll should do given the file's current size. */
export type StdoutTailDecision =
  /** Nothing new. */
  | { kind: 'none' }
  /** Read `[startOffset..endOffset)` and feed it through the decoder/reader. */
  | { kind: 'read'; startOffset: number; endOffset: number }
  /** The file SHRANK below the consumed offset (external truncation — should
   *  not happen for the append-only log). State was reset to the new EOF; the
   *  caller must reset its line reader too (a stale partial would corrupt the
   *  next line). */
  | { kind: 'reseed' };

/**
 * @description Decide the next tail action. Does NOT advance offsets on a
 * `read` — {@link decodeStdoutTailChunk} advances by the bytes ACTUALLY read,
 * so a short read (race with a concurrent append) self-heals next poll.
 */
export function getStdoutTailDecision(state: StdoutTailState, sizeBytes: number): StdoutTailDecision {
  if (sizeBytes < state.consumedBytes) {
    state.consumedBytes = sizeBytes;
    state.decoderRetainedBytes = 0;
    state.decoder = new StringDecoder('utf8');
    return { kind: 'reseed' };
  }
  if (sizeBytes === state.consumedBytes) return { kind: 'none' };
  return { kind: 'read', startOffset: state.consumedBytes, endOffset: sizeBytes };
}

/**
 * @description Feed one appended byte chunk through the stateful utf8 decoder.
 * Returns the decoded text (possibly empty while a multi-byte char is split);
 * advances `consumedBytes` by the chunk length and re-derives the decoder's
 * retained-byte count (`retainedNew = retainedPrior + chunkLen - decodedLen`,
 * clamped defensively — invalid utf8 replacement chars could otherwise skew it
 * negative).
 */
export function decodeStdoutTailChunk(state: StdoutTailState, chunk: Buffer): string {
  const text = state.decoder.write(chunk);
  const retained = state.decoderRetainedBytes + chunk.length - Buffer.byteLength(text, 'utf8');
  state.decoderRetainedBytes = Math.max(0, retained);
  state.consumedBytes += chunk.length;
  return text;
}

/**
 * @description The byte offset up to which every COMPLETE line has been
 * processed — the value persisted across bot restarts. `pendingLineText` is the
 * line reader's buffered partial line (`ClaudeStreamLineReader.pending`): those
 * bytes were consumed but not yet processed, so the persisted offset excludes
 * them and a restarted tail re-reads exactly the unprocessed remainder.
 */
export function getStdoutLineBoundaryOffset(state: StdoutTailState, pendingLineText: string): number {
  return state.consumedBytes - state.decoderRetainedBytes - Buffer.byteLength(pendingLineText, 'utf8');
}
