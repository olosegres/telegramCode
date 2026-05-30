/**
 * @description Coverage for `tryAcquireLockWithRetry` — the same-token
 * handoff path that tolerates a brief old-PID / new-PID overlap during
 * `nodemon` hot reloads.
 *
 * Contract (plan §3):
 *
 *   - Same token + live holder → retry with bounded backoff.
 *     The previous bot PID is in the middle of its graceful shutdown
 *     (`bot.stop → state.flush → releaseLock → exit`). Waiting it out
 *     lets the new PID claim the lock without a spurious "another
 *     instance is running" abort.
 *   - Different token + live holder → fail immediately.
 *     Means the operator has two distinct bots pointing at the same
 *     `DATA_DIR` (misconfiguration). Silent retry would mask the
 *     conflict; surface it.
 *   - Bounded by `maxWaitMs`. A wedged old process can't pin the new
 *     one forever — eventually we surface the live-holder failure.
 *
 * The sleep function is injected so the test runs in zero wall time but
 * still drives the retry loop deterministically.
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  tryAcquireLock,
  tryAcquireLockWithRetry,
  releaseLock,
  lockPath,
} from '../cli/lock';

let tmpRoot: string;
let savedDataDir: string | undefined;
let savedToken: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-handoff-'));
  savedDataDir = process.env.DATA_DIR;
  savedToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.DATA_DIR = tmpRoot;
  process.env.TELEGRAM_BOT_TOKEN = 'handoff-test-token-xyz';
});

afterEach(() => {
  releaseLock();
  if (savedDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = savedDataDir;
  if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedToken;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * @description Compute the 12-char SHA-256 prefix the lockfile records for
 * a given raw token. Mirrors `hashToken` in `cli/lock.ts` — duplicated here
 * because that helper isn't exported (it's an internal implementation
 * detail and we don't want to widen the surface just for tests).
 */
function tokenHashFor(token: string): string {
  return require('crypto')
    .createHash('sha256')
    .update(token)
    .digest('hex')
    .slice(0, 12);
}

test('happy path: no holder → first try succeeds, sleep never called', async () => {
  let sleepCalls = 0;
  const r = await tryAcquireLockWithRetry({
    maxWaitMs: 1000,
    intervalMs: 10,
    sleep: async () => { sleepCalls += 1; },
  });
  assert.equal(r.ok, true);
  assert.equal(sleepCalls, 0, 'no retry needed when lock is free');
});

test('same-token live holder that releases mid-retry → eventually acquires', async () => {
  // Plant a foreign-PID lockfile with OUR token hash (pid 1 = init, alive).
  const ourHash = tokenHashFor(process.env.TELEGRAM_BOT_TOKEN!);
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(
    lockPath(),
    JSON.stringify({
      pid: 1,
      cwd: '/predecessor',
      startedAt: '2026-05-30T00:00:00.000Z',
      tokenHash: ourHash,
    }),
  );

  // Fake sleep that on the 3rd call unlinks the planted lockfile, simulating
  // the predecessor finishing its graceful shutdown and releasing.
  let calls = 0;
  const sleep = async (_ms: number): Promise<void> => {
    calls += 1;
    if (calls === 3) {
      fs.unlinkSync(lockPath());
    }
  };

  const r = await tryAcquireLockWithRetry({
    maxWaitMs: 10_000, // generous — deadline shouldn't be the gate here
    intervalMs: 50,
    sleep,
  });

  assert.equal(r.ok, true, `expected eventual acquire; got ${JSON.stringify(r)}`);
  assert.ok(calls >= 3, `expected at least 3 retries before predecessor released; got ${calls}`);

  // Lockfile should now name us, not the planted pid.
  const data = JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
  assert.equal(data.pid, process.pid);
});

test('different-token live holder → fails immediately (no retry)', async () => {
  // Plant pid 1 (alive) with a DIFFERENT token hash — represents an
  // operator who started a second bot pointing at the same DATA_DIR
  // by mistake.
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(
    lockPath(),
    JSON.stringify({
      pid: 1,
      cwd: '/other-bot',
      startedAt: '2026-05-30T00:00:00.000Z',
      tokenHash: 'ffffffffffff', // not ours
    }),
  );

  let sleepCalls = 0;
  const r = await tryAcquireLockWithRetry({
    maxWaitMs: 5000,
    intervalMs: 100,
    sleep: async () => { sleepCalls += 1; },
  });

  assert.equal(r.ok, false);
  if (r.ok) return; // type narrow
  assert.equal(r.reason, 'live-holder');
  assert.equal(sleepCalls, 0, 'foreign token must NOT trigger retry — surface the conflict fast');
});

test('same-token live holder that never releases → surfaces live-holder after deadline', async () => {
  const ourHash = tokenHashFor(process.env.TELEGRAM_BOT_TOKEN!);
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(
    lockPath(),
    JSON.stringify({
      pid: 1,
      cwd: '/wedged-predecessor',
      startedAt: '2026-05-30T00:00:00.000Z',
      tokenHash: ourHash,
    }),
  );

  let sleepCalls = 0;
  const r = await tryAcquireLockWithRetry({
    maxWaitMs: 300,
    intervalMs: 100,
    sleep: async () => { sleepCalls += 1; },
  });

  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'live-holder');
  // We should have retried at least twice within 300ms / 100ms interval
  // before giving up. (Loose lower bound — exact count depends on scheduling.)
  assert.ok(sleepCalls >= 2, `expected at least 2 retries; got ${sleepCalls}`);
});

test('stale (dead) same-token holder → first retry reclaims it (no live holder, just stale lock)', async () => {
  // A dead pid + our token. tryAcquireLock's own stale-recovery clears it
  // on the first call, so we never enter the retry loop.
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(
    lockPath(),
    JSON.stringify({
      pid: 2 ** 22 - 1, // guaranteed-dead
      cwd: '/long-gone',
      startedAt: '2020-01-01T00:00:00.000Z',
      tokenHash: tokenHashFor(process.env.TELEGRAM_BOT_TOKEN!),
    }),
  );

  let sleepCalls = 0;
  const r = await tryAcquireLockWithRetry({
    maxWaitMs: 1000,
    intervalMs: 50,
    sleep: async () => { sleepCalls += 1; },
  });

  assert.equal(r.ok, true);
  assert.equal(sleepCalls, 0, 'dead holder must be reclaimed without sleeping');
});

test('tryAcquireLock direct call unchanged: same-token live-holder still reports failure (no retry built in)', async () => {
  // Sanity check that the retry-free path stays strict; only the *Retry*
  // wrapper softens behaviour. Important so anywhere we still use the
  // pure call (tests, future callers) keeps deterministic semantics.
  const ourHash = tokenHashFor(process.env.TELEGRAM_BOT_TOKEN!);
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(
    lockPath(),
    JSON.stringify({
      pid: 1,
      cwd: '/predecessor',
      startedAt: '2026-05-30T00:00:00.000Z',
      tokenHash: ourHash,
    }),
  );

  const r = tryAcquireLock();
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'live-holder');
});
