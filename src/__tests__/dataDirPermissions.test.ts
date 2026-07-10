/**
 * @description Security hardening: `DATA_DIR` holds `state.json`, output-trace
 * buckets and console-log tees that quote prompts, session ids and agent
 * output — none of it may be world-readable on a shared host. The dir must be
 * owner-only (`0700`, healed on existing deploys at state-store init) and the
 * log files owner-only (`0600`, applied at creation). Mode-bit assertions are
 * POSIX-only, so the whole file is skipped on win32.
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateStore } from '../state';
import { appendConsoleBucketChunk, consoleFileBase } from '../utils/consoleFileTap';
import { RunLedger } from '../scheduler/runLedger';

const isWindows = process.platform === 'win32';

let fakeHome: string;
let dataDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-perm-'));
  dataDir = path.join(fakeHome, '.telegramCode');
  originalHome = process.env.HOME;
  // Keep the legacy-migration probe (os.homedir()) inside the tmp sandbox.
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

function getModeBits(targetPath: string): number {
  return fs.statSync(targetPath).mode & 0o777;
}

test('state-store init creates a fresh DATA_DIR owner-only (0700)', { skip: isWindows }, async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.equal(getModeBits(dataDir), 0o700);
});

test('state-store init chmod-heals an existing loose DATA_DIR to 0700', { skip: isWindows }, async () => {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o755 });
  assert.equal(getModeBits(dataDir), 0o755, 'precondition: dir starts world-readable');
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.equal(getModeBits(dataDir), 0o700);
});

test('console-tap bucket file is created owner-only (0600)', { skip: isWindows }, () => {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  appendConsoleBucketChunk(dataDir, 'boot line\n');
  const bucketName = fs.readdirSync(dataDir).find((name) => name.startsWith(`${consoleFileBase}-`));
  assert.ok(bucketName, 'bucket file was created');
  assert.equal(getModeBits(path.join(dataDir, bucketName)), 0o600);
});

test('scheduler run-ledger file is created owner-only (0600)', { skip: isWindows }, () => {
  const ledgerPath = path.join(dataDir, 'scheduler-runs.jsonl');
  const ledger = new RunLedger(ledgerPath);
  ledger.append({
    runId: 'run-1',
    jobId: 'job-1',
    threadKey: '-1001234567890:42',
    firedAt: Date.now(),
    kind: 'on-time',
  });
  assert.equal(getModeBits(ledgerPath), 0o600);
});
