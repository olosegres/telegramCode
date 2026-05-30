/**
 * @description Coverage for `src/bootClassifier.ts` — pure mapping from a
 * measured downtime to the boot-mode flags consumed by `startBot()`.
 *
 * Behaviour matrix (locked by the plan, "Hot reload that keeps agents
 * alive", D3 + §6):
 *
 *   downtime null  → cold start (drop backlog, allow reattach notice)
 *   downtime <  T  → hot reload (keep backlog, quiet reattach)
 *   downtime ≥  T  → cold start (drop backlog, allow reattach notice)
 *
 * Threshold default is generous (60s) so a slow tsc rebuild still
 * classifies as hot reload; tests pin both the default-threshold path
 * and an injected-threshold path so future tightening doesn't silently
 * mis-classify.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyBoot, HOT_RELOAD_THRESHOLD_MS } from '../bootClassifier';

test('null downtime → cold start (drop pending updates)', () => {
  const r = classifyBoot(null);
  assert.equal(r.isHotReload, false);
  assert.equal(r.dropPendingUpdates, true);
});

test('downtime well below threshold → hot reload (keep pending updates)', () => {
  const r = classifyBoot(500);
  assert.equal(r.isHotReload, true);
  assert.equal(r.dropPendingUpdates, false);
});

test('downtime just under threshold → hot reload', () => {
  const r = classifyBoot(HOT_RELOAD_THRESHOLD_MS - 1);
  assert.equal(r.isHotReload, true);
  assert.equal(r.dropPendingUpdates, false);
});

test('downtime equal to threshold → cold start (≥ is strict)', () => {
  const r = classifyBoot(HOT_RELOAD_THRESHOLD_MS);
  assert.equal(r.isHotReload, false);
  assert.equal(r.dropPendingUpdates, true);
});

test('downtime well above threshold → cold start', () => {
  const r = classifyBoot(60 * 60 * 1000); // 1h
  assert.equal(r.isHotReload, false);
  assert.equal(r.dropPendingUpdates, true);
});

test('injected threshold lets callers tune (tightening)', () => {
  // With a 1s threshold, even 2s is a cold start.
  const r = classifyBoot(2000, 1000);
  assert.equal(r.isHotReload, false);
  assert.equal(r.dropPendingUpdates, true);
});

test('injected threshold lets callers tune (loosening)', () => {
  // With a 10min threshold, 5min is still hot reload.
  const r = classifyBoot(5 * 60 * 1000, 10 * 60 * 1000);
  assert.equal(r.isHotReload, true);
  assert.equal(r.dropPendingUpdates, false);
});

test('dropPendingUpdates is always the inverse of isHotReload', () => {
  // Property-style: walk a range of values, assert invariant holds.
  const samples = [null, 0, 1, 100, 1_000, 30_000, 59_999, 60_000, 60_001, 1e9];
  for (const d of samples) {
    const r = classifyBoot(d);
    assert.equal(r.dropPendingUpdates, !r.isHotReload, `failed for downtime=${d}`);
  }
});
