/**
 * @description S1 — pure decisions behind the BOUNDED post-cooldown redelivery
 * of a rate-limited send (B14, now extended to the agent's final answer).
 *
 * Two crux behaviours:
 *  - Eligibility: interactive replies are recoverable; the final answer is too
 *    (via the explicit `isImportant` marker even though it rides `output`
 *    priority); intermediate output / status stay disposable.
 *  - Boundedness: the schedule walks at most `maxRedeliveryAttempts` passes and
 *    then `exhausted` (the caller notifies), so a sustained 429 can never loop.
 *
 * The `null`-binding ambiguity is still load-bearing: a fresh `/bind`
 * folder-picker thread (no binding yet) must be redelivered, but a thread the
 * user just unbound (binding wiped) must not. The decision disambiguates by
 * comparing the binding at send time with the binding now.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  checkShouldRedeliver,
  decideRedelivery,
  scheduleRedelivery,
  maxRedeliveryAttempts,
} from '../redeliverDecision';
import type { BindingData } from '../state';
import type { SendPriority } from '../rateLimiter';

const binding = (closed = false): BindingData => ({
  subdir: 'proj',
  createdAt: '2026-06-04T00:00:00.000Z',
  ...(closed ? { closed } : {}),
});

test('checkShouldRedeliver: interactive priority is recoverable, disposable output/status is not', () => {
  for (const priority of ['output', 'status'] as const) {
    assert.equal(
      checkShouldRedeliver(priority, /* isImportant */ false, { hadBindingAtSend: true, bindingNow: binding() }),
      false,
      `non-final ${priority} must not be redelivered`,
    );
  }
  assert.equal(
    checkShouldRedeliver('interactive', false, { hadBindingAtSend: true, bindingNow: binding() }),
    true,
    'interactive on a live bound thread must be redelivered',
  );
});

test('checkShouldRedeliver: the FINAL answer (output + isImportant) is eligible', () => {
  assert.equal(
    checkShouldRedeliver('output', /* isImportant */ true, { hadBindingAtSend: true, bindingNow: binding() }),
    true,
    'final-answer output is recoverable via the important marker',
  );
  // status is never important-marked in practice, but the class gate still holds.
  assert.equal(
    checkShouldRedeliver('status', /* isImportant */ false, { hadBindingAtSend: true, bindingNow: binding() }),
    false,
  );
});

test('checkShouldRedeliver: fresh folder-picker (no binding at send, still none) → redeliver', () => {
  assert.equal(
    checkShouldRedeliver('interactive', false, { hadBindingAtSend: false, bindingNow: null }),
    true,
  );
});

test('checkShouldRedeliver: unbound between send and cooldown (had binding, gone now) → skip', () => {
  assert.equal(
    checkShouldRedeliver('interactive', false, { hadBindingAtSend: true, bindingNow: null }),
    false,
  );
});

test('checkShouldRedeliver: closed topic → skip (even for the important final answer)', () => {
  assert.equal(
    checkShouldRedeliver('interactive', false, { hadBindingAtSend: true, bindingNow: binding(true) }),
    false,
  );
  assert.equal(
    checkShouldRedeliver('output', /* isImportant */ true, { hadBindingAtSend: true, bindingNow: binding(true) }),
    false,
    'closed wins over the important final answer too',
  );
});

test('decideRedelivery: disposable class is ineligible (no schedule, no notice)', () => {
  for (const priority of ['output', 'status'] as const) {
    assert.deepEqual(
      decideRedelivery({ priority, isImportant: false, attempt: 0, remainingCooldownMs: 1000, slackMs: 250 }),
      { action: 'ineligible' },
      `${priority} (non-final) → ineligible`,
    );
  }
});

test('decideRedelivery: schedules each pass at remaining cooldown + slack, then exhausts after N', () => {
  const slackMs = 250;
  const remainingCooldownMs = 1000;
  // attempts 0..N-1 schedule; attempt N is exhausted.
  for (let attempt = 0; attempt < maxRedeliveryAttempts; attempt++) {
    const decision = decideRedelivery({ priority: 'interactive', isImportant: false, attempt, remainingCooldownMs, slackMs });
    assert.deepEqual(
      decision,
      { action: 'schedule', delayMs: remainingCooldownMs + slackMs },
      `attempt ${attempt} must still schedule`,
    );
  }
  assert.deepEqual(
    decideRedelivery({ priority: 'interactive', isImportant: false, attempt: maxRedeliveryAttempts, remainingCooldownMs, slackMs }),
    { action: 'exhausted' },
    'attempt at the cap must exhaust → caller notifies',
  );
});

test('decideRedelivery: the final answer (important output) follows the same bounded schedule', () => {
  const ok = decideRedelivery({ priority: 'output', isImportant: true, attempt: 0, remainingCooldownMs: 500, slackMs: 100 });
  assert.deepEqual(ok, { action: 'schedule', delayMs: 600 });
  const spent = decideRedelivery({ priority: 'output', isImportant: true, attempt: maxRedeliveryAttempts, remainingCooldownMs: 500, slackMs: 100 });
  assert.deepEqual(spent, { action: 'exhausted' });
});

test('decideRedelivery: backoff is clamped to the max so a pathological retry_after cannot park for minutes', () => {
  const decision = decideRedelivery({
    priority: 'interactive',
    isImportant: false,
    attempt: 0,
    remainingCooldownMs: 10 * 60_000,
    slackMs: 250,
    maxBackoffMs: 60_000,
  });
  assert.deepEqual(decision, { action: 'schedule', delayMs: 60_000 });
});

test('scheduleRedelivery: waits the precomputed delay, then redelivers exactly once', () => {
  const delayMs = 1250;
  let scheduledMs: number | null = null;
  let scheduledFn: (() => void) | null = null;
  let delivered = 0;

  scheduleRedelivery('interactive', /* isImportant */ false, /* hadBindingAtSend */ true, {
    delayMs,
    scheduleAfter: (fn, ms) => { scheduledFn = fn; scheduledMs = ms; },
    getBindingNow: () => binding(),
    redeliver: () => { delivered += 1; },
  });

  assert.equal(scheduledMs, delayMs, 'must defer for the precomputed delay');
  assert.equal(delivered, 0, 'nothing before the tick');

  scheduledFn!();
  assert.equal(delivered, 1, 'redelivered once on the scheduled tick');
});

test('scheduleRedelivery: re-checks target at fire time and skips a now-invalid thread', () => {
  let scheduledFn: (() => void) | null = null;
  let delivered = 0;
  let skipReason: string | null = null;

  // Had a binding at send time; by fire time it is gone (unbound).
  scheduleRedelivery('interactive', false, /* hadBindingAtSend */ true, {
    delayMs: 250,
    scheduleAfter: (fn) => { scheduledFn = fn; },
    getBindingNow: () => null,
    redeliver: () => { delivered += 1; },
    onSkip: (reason: string) => { skipReason = reason; },
  });

  scheduledFn!();
  assert.equal(delivered, 0, 'must skip a torn-down thread at fire time');
  assert.ok(skipReason, 'skip reason reported');
});

test('scheduleRedelivery: a disposable class never even arms the redeliver call', () => {
  let scheduledFn: (() => void) | null = null;
  let delivered = 0;
  const priority: SendPriority = 'output';
  scheduleRedelivery(priority, /* isImportant */ false, true, {
    delayMs: 250,
    scheduleAfter: (fn) => { scheduledFn = fn; },
    getBindingNow: () => binding(),
    redeliver: () => { delivered += 1; },
  });
  scheduledFn!();
  assert.equal(delivered, 0);
});
