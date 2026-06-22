import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getHourBucketPath,
  pruneExpiredBuckets,
  retentionHours,
  retentionMs,
} from '../utils/rotatingLogFile';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotating-log-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('retention constants: 6h window, derived ms', () => {
  assert.equal(retentionHours, 6);
  assert.equal(retentionMs, 6 * 60 * 60 * 1000);
});

test('getHourBucketPath: builds <base>-YYYYMMDDHH.<ext> from the host-local hour', () => {
  // Build a deterministic local timestamp so the assertion matches whatever
  // the host timezone is (the function uses local getters).
  const local = new Date(2026, 5 /* June */, 7, 9, 30, 0); // 2026-06-07 09:xx local
  const expectedStamp = '2026060709';
  assert.equal(
    getHourBucketPath('/data', 'output-trace', 'jsonl', local.getTime()),
    path.join('/data', `output-trace-${expectedStamp}.jsonl`),
  );
});

test('getHourBucketPath: zero-pads month/day/hour', () => {
  const local = new Date(2026, 0 /* Jan */, 3, 4, 0, 0); // 2026-01-03 04:xx local
  assert.equal(
    getHourBucketPath('/d', 'bot-console', 'log', local.getTime()),
    path.join('/d', 'bot-console-2026010304.log'),
  );
});

test('pruneExpiredBuckets: removes only buckets older than retention, keeps the current one', async () => {
  const nowMs = Date.now();
  const currentBucket = getHourBucketPath(dir, 'output-trace', 'jsonl', nowMs);
  // An 8h-old bucket name (the name itself doesn't drive the decision — mtime
  // does — but use a distinct, valid bucket name for realism).
  const oldBucket = getHourBucketPath(dir, 'output-trace', 'jsonl', nowMs - 8 * 60 * 60 * 1000);
  const oldRollover = `${oldBucket}.1`;

  fs.writeFileSync(currentBucket, 'fresh\n');
  fs.writeFileSync(oldBucket, 'stale\n');
  fs.writeFileSync(oldRollover, 'stale rollover\n');

  // Backdate the old files' mtime past the retention window.
  const backdatedSec = (nowMs - 8 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(oldBucket, backdatedSec, backdatedSec);
  fs.utimesSync(oldRollover, backdatedSec, backdatedSec);

  await pruneExpiredBuckets(dir, 'output-trace', 'jsonl', retentionMs, nowMs);

  assert.equal(fs.existsSync(currentBucket), true, 'current bucket kept');
  assert.equal(fs.existsSync(oldBucket), false, 'expired bucket removed');
  assert.equal(fs.existsSync(oldRollover), false, 'expired .1 rollover removed');
});

test('pruneExpiredBuckets: ignores unrelated files and other bases', async () => {
  const nowMs = Date.now();
  const foreign = path.join(dir, 'something-else.log');
  const otherBase = getHourBucketPath(dir, 'bot-console', 'log', nowMs - 8 * 60 * 60 * 1000);
  fs.writeFileSync(foreign, 'x');
  fs.writeFileSync(otherBase, 'y');
  const backdatedSec = (nowMs - 8 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(foreign, backdatedSec, backdatedSec);
  fs.utimesSync(otherBase, backdatedSec, backdatedSec);

  // Prune only the 'output-trace'/'jsonl' family — neither of the above matches.
  await pruneExpiredBuckets(dir, 'output-trace', 'jsonl', retentionMs, nowMs);

  assert.equal(fs.existsSync(foreign), true, 'unrelated file untouched');
  assert.equal(fs.existsSync(otherBase), true, 'a different base is untouched');
});

test('pruneExpiredBuckets: never throws on a missing directory', async () => {
  await assert.doesNotReject(
    pruneExpiredBuckets(path.join(dir, 'does-not-exist'), 'output-trace', 'jsonl', retentionMs, Date.now()),
  );
});
