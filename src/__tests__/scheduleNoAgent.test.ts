/**
 * @description `schedule.noAgent` — the schedule-specific refusal shown when
 * `/schedule` runs on a bound topic that never started an agent. Before this,
 * the `/schedule` handler surfaced `ensureAgentSession`'s generic
 * `agent.no_session` ("No agent running…") on a `no-adapter` failure, which
 * did not explain WHY a schedule needs an agent. The handler now maps the
 * `no-adapter` reason to this key; any other failure (`unbound`, …) keeps the
 * shared `result.message`.
 *
 * `t` only exercises the active async locale plus the en fallback, so it can
 * never prove the key lives in every catalog. `checkKeyInAllLangs` reads every
 * catalog directly, keeping this independent of the current test locale.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { checkKeyInAllLangs, t } from '../i18n';
import { enDict } from '../i18n/en';

test('schedule.noAgent is present in every language catalog (no bare-code fallback)', () => {
  assert.equal(
    checkKeyInAllLangs('schedule.noAgent'),
    true,
    'schedule.noAgent must exist in every locale — otherwise a user could see the bare code',
  );
});

test('schedule.noAgent is a schedule-specific warning, distinct from the generic no_session', () => {
  const scheduleMessage = enDict['schedule.noAgent'];
  // Schedule-specific framing: it must warn and explain the run has nothing to
  // launch — not the generic "No agent running" line.
  assert.match(scheduleMessage, /⚠️/);
  assert.match(scheduleMessage, /schedul/i);
  // Keep the actionable start hint on both backends.
  assert.match(scheduleMessage, /\/claude/);
  assert.match(scheduleMessage, /\/opencode/);
  // The whole point of the fix: the no-adapter `/schedule` message is NOT the
  // generic `ensureAgentSession` message, so the branch produces a real change.
  assert.notEqual(scheduleMessage, enDict['agent.no_session']);
});

test('schedule.noAgent resolves through t() to the localized string, not the raw key', () => {
  assert.equal(t('schedule.noAgent'), enDict['schedule.noAgent']);
  assert.notEqual(t('schedule.noAgent'), 'schedule.noAgent');
});
