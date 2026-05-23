/**
 * @description Coverage for `src/cli/lock.ts` — single-instance lockfile.
 *
 * Tests the pure `tryAcquireLock` core (returns a structured result instead
 * of calling `process.exit`) so we can assert against the failure shape
 * without spawning a child. The `acquireLock` user-facing wrapper layers
 * stderr + exit on top of this and is exercised indirectly via the
 * integration tests for `runBot`.
 *
 * Each test runs against an isolated `DATA_DIR` under a tmp dir to avoid
 * touching the developer's real `~/.telegramCode/instance.lock`.
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  tryAcquireLock,
  releaseLock,
  lockPath,
} from '../cli/lock';

let tmpRoot: string;
let savedDataDir: string | undefined;
let savedToken: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-lock-'));
  savedDataDir = process.env.DATA_DIR;
  savedToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.DATA_DIR = tmpRoot;
  process.env.TELEGRAM_BOT_TOKEN = 'unit-test-token-do-not-use';
});

afterEach(() => {
  releaseLock(); // best-effort, no-op if not held
  if (savedDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = savedDataDir;
  if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedToken;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('happy path: tryAcquireLock writes file with our pid and metadata', () => {
  const r = tryAcquireLock();
  assert.equal(r.ok, true);

  const lp = lockPath();
  assert.equal(fs.existsSync(lp), true);
  const data = JSON.parse(fs.readFileSync(lp, 'utf8'));
  assert.equal(data.pid, process.pid);
  assert.equal(data.cwd, process.cwd());
  assert.match(data.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  // Token hash is the first 12 hex chars of SHA-256 — assert shape, not
  // contents (we don't want test brittleness if the algorithm changes).
  assert.match(data.tokenHash, /^[0-9a-f]{12}$/);
});

test('releaseLock removes the file we own', () => {
  const r = tryAcquireLock();
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(lockPath()), true);

  releaseLock();
  assert.equal(fs.existsSync(lockPath()), false);
});

test('releaseLock is a no-op when no lock file exists', () => {
  // Should not throw.
  releaseLock();
  assert.equal(fs.existsSync(lockPath()), false);
});

test('releaseLock refuses to delete a lockfile owned by a different pid', () => {
  // Plant a foreign lockfile (some other live process owns it — we use pid 1
  // because init is always alive and unsignalable from non-root, which is
  // exactly the EPERM-means-alive case we want to exercise).
  const lp = lockPath();
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  fs.writeFileSync(
    lp,
    JSON.stringify({
      pid: 1,
      cwd: '/somewhere-else',
      startedAt: new Date().toISOString(),
      tokenHash: 'aaaaaaaaaaaa',
    }),
  );

  releaseLock();

  // Defensive: we shouldn't have nuked someone else's lock.
  assert.equal(fs.existsSync(lp), true);
});

test('second tryAcquireLock returns live-holder when first instance is still alive', () => {
  const r1 = tryAcquireLock();
  assert.equal(r1.ok, true);

  // Manually rewrite the lockfile to claim pid 1 (init) is the holder so the
  // second acquisition sees an alive-but-foreign owner. pid 1 is the standard
  // "always alive, never ours" sentinel; non-root processes cannot signal
  // it, which surfaces as EPERM in `process.kill(1, 0)` — our `isAlive`
  // helper treats EPERM as alive.
  fs.writeFileSync(
    lockPath(),
    JSON.stringify({
      pid: 1,
      cwd: '/elsewhere',
      startedAt: '2026-01-01T00:00:00.000Z',
      tokenHash: 'bbbbbbbbbbbb',
    }),
  );

  const r2 = tryAcquireLock();
  assert.equal(r2.ok, false);
  if (r2.ok) return; // type narrow
  assert.equal(r2.reason, 'live-holder');
  if (r2.reason !== 'live-holder') return; // type narrow
  assert.equal(r2.holder.pid, 1);
  assert.equal(r2.holder.cwd, '/elsewhere');
});

test('stale lock (dead pid) is cleared and reclaimed on next tryAcquireLock', () => {
  // Plant a stale lockfile pointing at a guaranteed-dead pid. We use a
  // pid in the very-high range where reuse is extremely unlikely on a fresh
  // tmp filesystem within the duration of a single test.
  const deadPid = 2 ** 22 - 1; // 4194303, above default pid_max on most kernels
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(
    lockPath(),
    JSON.stringify({
      pid: deadPid,
      cwd: '/long-gone',
      startedAt: '2020-01-01T00:00:00.000Z',
      tokenHash: 'cccccccccccc',
    }),
  );

  const r = tryAcquireLock();
  assert.equal(r.ok, true);

  // Lockfile should now name us, not the stale pid.
  const data = JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
  assert.equal(data.pid, process.pid);
});

test('corrupted lockfile is treated as stale and reclaimed', () => {
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(lockPath(), '{not valid json');

  const r = tryAcquireLock();
  assert.equal(r.ok, true);

  const data = JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
  assert.equal(data.pid, process.pid);
});

test('lockfile without a numeric pid is treated as stale', () => {
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(lockPath(), JSON.stringify({ pid: 'not-a-number' }));

  const r = tryAcquireLock();
  assert.equal(r.ok, true);
});

test('tokenHash is "no-token" when TELEGRAM_BOT_TOKEN is unset', () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  const r = tryAcquireLock();
  assert.equal(r.ok, true);

  const data = JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
  assert.equal(data.tokenHash, 'no-token');
});
