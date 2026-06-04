/**
 * @description B14 — pure decision behind redelivering a rate-limited
 * interactive reply after the 429 cooldown.
 *
 * The `null`-binding ambiguity is the crux: a fresh `/bind` folder-picker
 * thread (no binding yet) must be redelivered, but a thread the user just
 * unbound (binding wiped) must not. The decision disambiguates by comparing
 * the binding at send time with the binding now.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  checkShouldRedeliverInteractive,
  scheduleRedelivery,
} from '../redeliverDecision';
import type { BindingData } from '../state';
import type { SendPriority } from '../rateLimiter';

const binding = (closed = false): BindingData => ({
  subdir: 'proj',
  createdAt: '2026-06-04T00:00:00.000Z',
  ...(closed ? { closed } : {}),
});

test('checkShouldRedeliverInteractive: only interactive priority is recoverable', () => {
  for (const priority of ['output', 'status'] as const) {
    assert.equal(
      checkShouldRedeliverInteractive(priority, { hadBindingAtSend: true, bindingNow: binding() }),
      false,
      `${priority} must not be redelivered`,
    );
  }
  assert.equal(
    checkShouldRedeliverInteractive('interactive', { hadBindingAtSend: true, bindingNow: binding() }),
    true,
    'interactive on a live bound thread must be redelivered',
  );
});

test('checkShouldRedeliverInteractive: fresh folder-picker (no binding at send, still none) → redeliver', () => {
  assert.equal(
    checkShouldRedeliverInteractive('interactive', { hadBindingAtSend: false, bindingNow: null }),
    true,
  );
});

test('checkShouldRedeliverInteractive: unbound between send and cooldown (had binding, gone now) → skip', () => {
  assert.equal(
    checkShouldRedeliverInteractive('interactive', { hadBindingAtSend: true, bindingNow: null }),
    false,
  );
});

test('checkShouldRedeliverInteractive: closed topic → skip', () => {
  assert.equal(
    checkShouldRedeliverInteractive('interactive', { hadBindingAtSend: true, bindingNow: binding(true) }),
    false,
  );
  // Closed wins even if the thread had no binding at send time.
  assert.equal(
    checkShouldRedeliverInteractive('interactive', { hadBindingAtSend: false, bindingNow: binding(true) }),
    false,
  );
});

test('scheduleRedelivery: waits cooldown + slack, then redelivers exactly once', () => {
  const cooldownMs = 1000;
  const slackMs = 250;
  let scheduledMs: number | null = null;
  let scheduledFn: (() => void) | null = null;
  let delivered = 0;

  scheduleRedelivery('interactive', true, slackMs, {
    getRemainingCooldownMs: () => cooldownMs,
    scheduleAfter: (fn, ms) => { scheduledFn = fn; scheduledMs = ms; },
    getBindingNow: () => binding(),
    redeliver: () => { delivered += 1; },
  });

  assert.equal(scheduledMs, cooldownMs + slackMs, 'must defer past the cooldown boundary');
  assert.equal(delivered, 0, 'nothing before the tick');

  scheduledFn!();
  assert.equal(delivered, 1, 'redelivered once on the scheduled tick');
});

test('scheduleRedelivery: re-checks target at fire time and skips a now-invalid thread', () => {
  let scheduledFn: (() => void) | null = null;
  let delivered = 0;
  let skipReason: string | null = null;

  // Had a binding at send time; by fire time it is gone (unbound).
  scheduleRedelivery('interactive', true, 250, {
    getRemainingCooldownMs: () => 0,
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
  scheduleRedelivery(priority, true, 250, {
    getRemainingCooldownMs: () => 0,
    scheduleAfter: (fn) => { scheduledFn = fn; },
    getBindingNow: () => binding(),
    redeliver: () => { delivered += 1; },
  });
  scheduledFn!();
  assert.equal(delivered, 0);
});
