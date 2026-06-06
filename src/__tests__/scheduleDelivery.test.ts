/**
 * @description Coverage for `scheduler/delivery.ts` (S4) — the `deliver`
 * callback the engine fires: announce → pin → ensure-session → (wait-for-idle)
 * → forward, and the `DeliveryOutcome` it reports.
 *
 * Every side effect is injected, so these run with no Telegram, no adapter, and
 * a FAKE clock: `sleep(ms)` advances a mutable `now` cursor and resolves on a
 * microtask, so the wait-for-idle loop's pauses are deterministic and a test can
 * assert the EXACT elapsed time / poll count. A single `callLog` records the
 * order of announce/pin/forward so step ordering is load-bearing (a delivery
 * that skipped a step or reordered them could not pass).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createScheduleDelivery,
  buildFireAnnouncement,
  prependScheduledRunMarker,
  busyPollIntervalMs,
  waitIdleTimeoutMs,
  unboundDeliveryError,
  type ScheduleDeliveryDeps,
  type EnsureSessionResult,
} from '../scheduler/delivery';
import type { FireContext, ScheduleRecord } from '../scheduler/types';

const threadKey = '-1001234567890:11';

function makeJob(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 'remind-abc123',
    threadKey,
    name: 'Daily reminder',
    spec: { kind: 'cron', cronExpr: '0 9 * * *' },
    prompt: 'Check the deploy status',
    createdBy: 'agent',
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    nextRunAt: Date.parse('2026-06-07T09:00:00.000Z'),
    ...overrides,
  };
}

const onTime: FireContext = { kind: 'on-time' };

interface CallLogEntry {
  step: 'announce' | 'pin' | 'ensureSession' | 'forward';
  detail?: unknown;
}

/**
 * Build delivery deps with a shared call log + a fake clock. `busyFlips` is the
 * sequence of `checkBusy` return values consumed left-to-right (the last value
 * sticks once exhausted); `sleep` advances `now` so the wait loop is deterministic.
 */
function createHarness(options: {
  busyValues?: boolean[];
  ensureResult?: EnsureSessionResult;
  announceId?: number | null;
  pinThrows?: boolean;
  forwardThrows?: boolean;
} = {}) {
  const callLog: CallLogEntry[] = [];
  let nowMs = 1_000_000;
  const busyValues = options.busyValues ?? [false];
  let busyIndex = 0;

  const deps: ScheduleDeliveryDeps = {
    announce: async (key, text) => {
      callLog.push({ step: 'announce', detail: { key, text } });
      return options.announceId === undefined ? 42 : options.announceId;
    },
    pin: async (key, messageId, isSilent) => {
      callLog.push({ step: 'pin', detail: { key, messageId, isSilent } });
      if (options.pinThrows) throw new Error('not enough rights to pin');
    },
    checkBusy: () => {
      const value = busyValues[Math.min(busyIndex, busyValues.length - 1)];
      busyIndex += 1;
      return value;
    },
    ensureSession: async (key, fallbackAdapterName) => {
      callLog.push({ step: 'ensureSession', detail: { key, fallbackAdapterName } });
      return options.ensureResult ?? { ok: true };
    },
    forwardPrompt: async (key, text) => {
      callLog.push({ step: 'forward', detail: { key, text } });
      if (options.forwardThrows) throw new Error('forward boom');
    },
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
  };

  return { deps, callLog, getNow: () => nowMs };
}

test('happy path: announce → pin → ensureSession → forward, in order; delivered', async () => {
  const { deps, callLog } = createHarness();
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeJob(), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.deepEqual(
    callLog.map((entry) => entry.step),
    ['announce', 'pin', 'ensureSession', 'forward'],
  );
});

test('pin: silent flag honored — default notifies (isSilent=false)', async () => {
  const { deps, callLog } = createHarness();
  const deliver = createScheduleDelivery(deps);
  await deliver(makeJob(), onTime);
  const pin = callLog.find((e) => e.step === 'pin');
  assert.equal((pin?.detail as { isSilent: boolean }).isSilent, false);
});

test('pin: silent flag honored — job.isPinSilent makes the pin silent', async () => {
  const { deps, callLog } = createHarness();
  const deliver = createScheduleDelivery(deps);
  await deliver(makeJob({ isPinSilent: true }), onTime);
  const pin = callLog.find((e) => e.step === 'pin');
  assert.equal((pin?.detail as { isSilent: boolean }).isSilent, true);
});

test('announce send failed (null id) → pin skipped, delivery still proceeds to forward', async () => {
  const { deps, callLog } = createHarness({ announceId: null });
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeJob(), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.deepEqual(
    callLog.map((e) => e.step),
    ['announce', 'ensureSession', 'forward'],
    'a failed announce skips pin but never blocks delivery',
  );
});

test('pin failure → console.warn, delivery continues; outcome still delivered', async () => {
  const { deps, callLog } = createHarness({ pinThrows: true });
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeJob(), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  // forward still ran after the failed pin
  assert.ok(callLog.some((e) => e.step === 'forward'), 'forward must run despite pin failure');
});

test('busy session: polls until checkBusy flips false, then forwards', async () => {
  // active+busy on first probe (after ensureSession), busy for 2 more polls,
  // then idle. The post-ensureSession busy gate consumes one read; the loop
  // consumes the rest.
  const { deps, callLog } = createHarness({ busyValues: [true, true, false] });
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeJob(), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.ok(callLog.some((e) => e.step === 'forward'), 'forwards once idle');
});

test('busy past timeout: forwards anyway after exactly waitIdleTimeoutMs of polling', async () => {
  // checkBusy is ALWAYS true → the loop runs until the deadline, then forwards.
  const { deps, callLog, getNow } = createHarness({ busyValues: [true] });
  const startNow = getNow();
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeJob(), onTime);

  assert.deepEqual(outcome, { status: 'delivered' });
  assert.ok(callLog.some((e) => e.step === 'forward'), 'forwards anyway after the timeout');
  // The loop sleeps in busyPollIntervalMs hops and stops once now() >= deadline.
  // deadline = start + waitIdleTimeoutMs; it sleeps ceil(timeout/interval) times.
  const elapsed = getNow() - startNow;
  const expectedPolls = Math.ceil(waitIdleTimeoutMs / busyPollIntervalMs);
  assert.equal(elapsed, expectedPolls * busyPollIntervalMs, 'polled exactly up to the timeout');
  assert.ok(elapsed >= waitIdleTimeoutMs, 'waited at least the full timeout before giving up');
});

test('no session: ensureSession called with the job lastAdapterName', async () => {
  const { deps, callLog } = createHarness({ ensureResult: { ok: true } });
  const deliver = createScheduleDelivery(deps);
  await deliver(makeJob({ lastAdapterName: 'opencode' }), onTime);

  const ensure = callLog.find((e) => e.step === 'ensureSession');
  assert.equal((ensure?.detail as { fallbackAdapterName?: string }).fallbackAdapterName, 'opencode');
});

test('ensureSession unbound → outcome failed with the distinct unbound error; no forward', async () => {
  const { deps, callLog } = createHarness({ ensureResult: { ok: false, reason: 'unbound' } });
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeJob(), onTime);

  assert.deepEqual(outcome, { status: 'failed', error: unboundDeliveryError });
  assert.ok(!callLog.some((e) => e.step === 'forward'), 'an unbound topic never forwards');
});

test('ensureSession start-failed → outcome failed with a readable reason; no forward', async () => {
  const { deps, callLog } = createHarness({ ensureResult: { ok: false, reason: 'start-failed' } });
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeJob(), onTime);

  assert.equal(outcome.status, 'failed');
  assert.notEqual(outcome.error, unboundDeliveryError, 'start-failure is distinct from unbound');
  assert.ok(!callLog.some((e) => e.step === 'forward'));
});

test('forward throws → outcome failed carrying the thrown message', async () => {
  const { deps } = createHarness({ forwardThrows: true });
  const deliver = createScheduleDelivery(deps);
  const outcome = await deliver(makeJob(), onTime);

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'forward boom');
});

test('catch-up fireContext: announcement carries the missed note with HH:MM', async () => {
  const missedAtMs = Date.parse('2026-06-07T09:00:00.000Z');
  const at = new Date(missedAtMs);
  const expectedTime = `${at.getHours().toString().padStart(2, '0')}:${at.getMinutes().toString().padStart(2, '0')}`;

  const text = buildFireAnnouncement(makeJob(), { kind: 'catch-up', missedAtMs });
  assert.ok(text.includes(expectedTime), `expected missed-at time ${expectedTime} in "${text}"`);
  assert.ok(text.includes('Daily reminder'), 'announcement names the job');
  assert.ok(text.includes('Check the deploy status'), 'announcement carries the prompt');
});

test('on-time fireContext: announcement has NO missed note', async () => {
  const text = buildFireAnnouncement(makeJob(), onTime);
  // The ru/en missedNote both contain "missed"/"пропущено"; neither should appear.
  assert.ok(!/missed|пропущено/i.test(text), `on-time run must not annotate a miss: "${text}"`);
});

test('forwarded prompt is prefixed with the scheduled-run marker carrying the job name', async () => {
  const { deps, callLog } = createHarness();
  const deliver = createScheduleDelivery(deps);
  await deliver(makeJob({ name: 'Nightly build', prompt: 'run the build' }), onTime);

  const forward = callLog.find((e) => e.step === 'forward');
  const text = (forward?.detail as { text: string }).text;
  assert.equal(text, prependScheduledRunMarker('Nightly build', 'run the build'));
  assert.ok(text.startsWith('[Scheduled run "Nightly build"]'), 'marker leads the prompt');
  assert.ok(text.includes('run the build'), 'original prompt is preserved after the marker');
});
