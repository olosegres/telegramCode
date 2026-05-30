/**
 * @description Coverage for the heartbeat/downtime API on `StateStore`
 * (`src/state.ts`).
 *
 * The bot stamps `lastHeartbeatAt = Date.now()` every ~10s while running.
 * On the next boot, `getDowntimeMs()` reads the gap and `bootClassifier`
 * decides hot-reload vs cold-start. These tests pin the lower layer:
 *
 *   - missing stamp → `null` (treated as cold start by the classifier)
 *   - present stamp → positive ms delta
 *   - stamp persists across `flush()` so the *next* `StateStore` instance
 *     sees the same value (the whole point of the feature — survives a
 *     process restart, not just a same-instance round-trip)
 *   - older `state.json` files (no `lastHeartbeatAt` field) still parse —
 *     the shape check is non-strict, so a pre-feature file is just a
 *     `null` downtime, never a load failure
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateStore } from '../state';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-heartbeat-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('fresh store → getDowntimeMs returns null', async () => {
  const store = new StateStore(tmpRoot);
  await store.init();
  assert.equal(store.getDowntimeMs(), null);
});

test('touchHeartbeat → getDowntimeMs returns small positive ms', async () => {
  const store = new StateStore(tmpRoot);
  await store.init();

  store.touchHeartbeat(1_000_000);
  // Read from a known clock so we don't depend on real time.
  const downtime = store.getDowntimeMs(1_000_500);
  assert.equal(downtime, 500);
});

test('downtime is never negative even if clocks skew', async () => {
  const store = new StateStore(tmpRoot);
  await store.init();

  // Stamp in the FUTURE relative to the read clock — simulates wall-clock
  // moving backwards (NTP adjustment, suspend/resume). Must not be
  // negative; classifyBoot would then misclassify wildly.
  store.touchHeartbeat(2_000_000);
  const downtime = store.getDowntimeMs(1_000_000);
  assert.equal(downtime, 0);
});

test('heartbeat survives flush + fresh store init (the cross-process case)', async () => {
  const storeA = new StateStore(tmpRoot);
  await storeA.init();
  storeA.touchHeartbeat(1_700_000_000_000);
  await storeA.flush();

  // Brand-new store on the same dir — simulates the nodemon respawn.
  const storeB = new StateStore(tmpRoot);
  await storeB.init();

  const downtime = storeB.getDowntimeMs(1_700_000_000_500);
  assert.equal(downtime, 500, 'heartbeat must persist across StateStore lifetimes');
});

test('older state.json without lastHeartbeatAt loads and returns null downtime', async () => {
  // Pre-feature state file: valid shape, no heartbeat field. Must not
  // fail loadStateFile's shape check; must read as "unknown" downtime.
  const statePath = path.join(tmpRoot, 'state.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      bindings: {},
      agents: {},
      messages: {},
    }, null, 2),
  );

  const store = new StateStore(tmpRoot);
  await store.init();
  assert.equal(store.getDowntimeMs(), null);
});

test('touchHeartbeat is cheap: many calls coalesce via debounced save', async () => {
  // Smoke: 100 calls should not throw or leak. We don't assert disk write
  // count (that's an internal detail of scheduleSave's debounce) — just
  // that the API stays consistent under repeated use.
  const store = new StateStore(tmpRoot);
  await store.init();

  for (let i = 0; i < 100; i += 1) {
    store.touchHeartbeat(1_000_000 + i);
  }
  const downtime = store.getDowntimeMs(1_000_200);
  assert.equal(downtime, 101); // 200 - (1_000_000+99) = 101
});

test('lastHeartbeatAt is the LAST value passed, not the first or some merged value', async () => {
  const store = new StateStore(tmpRoot);
  await store.init();

  store.touchHeartbeat(1_000);
  store.touchHeartbeat(2_000);
  store.touchHeartbeat(1_500); // out-of-order — last-wins semantics
  assert.equal(store.getDowntimeMs(3_000), 1_500);
});
