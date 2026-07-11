/**
 * @description Host layout + IO primitives for the json-stream external-process
 * transport (plan 2026-07-05-jsonstream-restart-isolation, S1).
 *
 * Load-bearing intent (per `.claude/rules/tests.md`):
 * - the wrapper script is asserted as a GOLDEN STRING — its `0<>` fd-0
 *   read-write FIFO hold, `env -u ANTHROPIC_API_KEY`, pid/exitcode capture and
 *   quoting are exactly the shape the P1 probe proved live; any drift here
 *   silently breaks restart isolation or billing;
 * - the FIFO write-open guard is exercised against a REAL fifo: `ENXIO → null`
 *   with no reader (a blocking open would hang the whole bot forever — the P1
 *   probe's first attempt did), and a usable fd once a `sh` child holds the
 *   fifo `0<>` exactly like the wrapper does;
 * - the tail state proves byte-exact restart offsets: resume from a persisted
 *   offset, truncation reseed, a multi-byte utf8 char split across reads, and
 *   a line-boundary offset that excludes the pending partial line (so a
 *   restarted tail re-reads the unprocessed remainder, nothing twice).
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildJsonStreamTmuxSessionName,
  buildWrapperScript,
  createStdoutTailState,
  decodeStdoutTailChunk,
  getJsonStreamSessionPaths,
  getStdoutLineBoundaryOffset,
  getStdoutTailDecision,
  openFifoWriterNonBlocking,
  parseJsonStreamDirName,
  parseJsonStreamTmuxSessionName,
  readExitCodeFile,
  readPidFile,
  resolveJsonStreamSessionDir,
  wrapperCdFailExitCode,
  writeFifoText,
} from '../utils/jsonStreamHost';
import type { ThreadKey } from '../types';

const key: ThreadKey = { chatId: -1001111111111, threadId: 9085 };

describe('json-stream host layout codecs', () => {
  it('session dir is DATA_DIR/jsonstream/<chatId>_<threadId> and parses back', () => {
    const dir = resolveJsonStreamSessionDir('/data/dir', key);
    assert.equal(dir, '/data/dir/jsonstream/-1001111111111_9085');
    assert.deepEqual(parseJsonStreamDirName('-1001111111111_9085'), key);
  });

  it('rejects foreign dir names (janitor must never sweep by a mis-parse)', () => {
    assert.equal(parseJsonStreamDirName('not-a-thread'), null);
    assert.equal(parseJsonStreamDirName('1e5_42'), null);
    assert.equal(parseJsonStreamDirName('123_'), null);
    assert.equal(parseJsonStreamDirName('123_-5'), null);
  });

  it('tmux name binds the cjson prefix and round-trips negative chat ids', () => {
    const name = buildJsonStreamTmuxSessionName(key);
    assert.equal(name, 'cjson--1001111111111-9085');
    assert.deepEqual(parseJsonStreamTmuxSessionName(name), key);
    // The scrape backend's names must never parse as ours (no adopt cross-talk).
    assert.equal(parseJsonStreamTmuxSessionName('claude--1001111111111-9085'), null);
  });
});

describe('buildWrapperScript', () => {
  it('produces the exact probe-proven wrapper shape (golden string)', () => {
    const paths = getJsonStreamSessionPaths('/data/dir/jsonstream/-100_1');
    const script = buildWrapperScript('/opt/bin/claude', ['-p', '--session-id', 'u-u-i-d'], "/work/my dir", paths);
    assert.equal(
      script,
      `#!/bin/sh
cd '/work/my dir' || exit ${wrapperCdFailExitCode}
env -u ANTHROPIC_API_KEY '/opt/bin/claude' '-p' '--session-id' 'u-u-i-d' \\
  0<> '/data/dir/jsonstream/-100_1/stdin.fifo' >> '/data/dir/jsonstream/-100_1/stdout.jsonl' 2>> '/data/dir/jsonstream/-100_1/stderr.log' &
CHILD=$!
echo $CHILD > '/data/dir/jsonstream/-100_1/pid'
wait $CHILD
echo $? > '/data/dir/jsonstream/-100_1/exitcode'
`,
    );
  });
});

describe('pid / exitcode file readers', () => {
  it('parse strict digits and return null for missing or garbage files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-pid-'));
    try {
      const pidFile = path.join(dir, 'pid');
      assert.equal(readPidFile(pidFile), null, 'missing file');
      fs.writeFileSync(pidFile, '12345\n');
      assert.equal(readPidFile(pidFile), 12345);
      fs.writeFileSync(pidFile, 'oops');
      assert.equal(readPidFile(pidFile), null, 'garbage content');
      const exitFile = path.join(dir, 'exitcode');
      fs.writeFileSync(exitFile, '0\n');
      assert.equal(readExitCodeFile(exitFile), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('openFifoWriterNonBlocking (real fifo)', () => {
  let holder: ChildProcess | null = null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-fifo-'));
  const fifoPath = path.join(dir, 'stdin.fifo');

  after(() => {
    if (holder && holder.exitCode === null) holder.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null (never blocks) while nothing holds the read end', async () => {
    execFileSync('mkfifo', [fifoPath]);
    const fd = await openFifoWriterNonBlocking(fifoPath, 2);
    assert.equal(fd, null, 'ENXIO must persist into null, not a hang');
  });

  it('returns a writable fd once a sh child holds the fifo 0<> like the wrapper', async () => {
    // The wrapper's exact hold: a long-lived child with the fifo open RDWR on fd 0.
    holder = spawn('sh', ['-c', `exec sleep 30 0<> ${fifoPath}`], { stdio: 'ignore' });
    const fd = await openFifoWriterNonBlocking(fifoPath);
    assert.notEqual(fd, null, 'a held fifo must open non-blocking');
    if (fd === null) return;
    await writeFifoText(fd, '{"type":"user"}\n');
    fs.closeSync(fd);
    // Writer death must not kill the holder (the isolation property itself).
    assert.equal(holder.exitCode, null, 'holder survives the writer closing');
  });
});

describe('stdout tail state', () => {
  it('resumes from a persisted offset: reads exactly [offset..size)', () => {
    const state = createStdoutTailState(50);
    assert.deepEqual(getStdoutTailDecision(state, 50), { kind: 'none' });
    assert.deepEqual(getStdoutTailDecision(state, 90), { kind: 'read', startOffset: 50, endOffset: 90 });
    // The decision does not advance offsets — decoding by ACTUAL bytes does.
    assert.deepEqual(getStdoutTailDecision(state, 90), { kind: 'read', startOffset: 50, endOffset: 90 });
  });

  it('reseeds to the new EOF when the file shrank below the consumed offset', () => {
    const state = createStdoutTailState(100);
    assert.deepEqual(getStdoutTailDecision(state, 40), { kind: 'reseed' });
    assert.equal(state.consumedBytes, 40);
    assert.deepEqual(getStdoutTailDecision(state, 40), { kind: 'none' });
  });

  it('re-pairs a multi-byte utf8 char split across two reads', () => {
    const full = Buffer.from('{"t":"привет"}\n', 'utf8');
    // Split INSIDE a Cyrillic character (each is 2 bytes; ASCII prefix is 6).
    const splitAt = 7;
    const state = createStdoutTailState(0);
    const first = decodeStdoutTailChunk(state, full.subarray(0, splitAt));
    const second = decodeStdoutTailChunk(state, full.subarray(splitAt));
    assert.equal(first + second, full.toString('utf8'), 'no replacement chars at the seam');
    assert.equal(state.consumedBytes, full.length);
    assert.equal(state.decoderRetainedBytes, 0, 'nothing retained once the char completed');
  });

  it('line-boundary offset excludes the pending partial line AND retained utf8 bytes', () => {
    const line = '{"a":1}\n';
    const partial = '{"b":"д'; // ends mid-value; the 'д' is 2 bytes
    const chunk = Buffer.from(line + partial, 'utf8');
    // Cut one byte into the trailing 'д' so the decoder retains it.
    const state = createStdoutTailState(0);
    const text = decodeStdoutTailChunk(state, chunk.subarray(0, chunk.length - 1));
    assert.equal(state.decoderRetainedBytes, 1, 'the split char byte is retained');
    // The caller's line reader would hold everything after the last newline.
    const pending = text.slice(text.indexOf('\n') + 1);
    assert.equal(
      getStdoutLineBoundaryOffset(state, pending),
      Buffer.byteLength(line, 'utf8'),
      'persisted offset lands exactly on the line boundary',
    );
  });
});
