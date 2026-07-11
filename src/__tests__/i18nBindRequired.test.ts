/**
 * @description `thread.bind_required` — the refusal shown when an agent-facing
 * action (start / list / resume) is attempted on an unbound thread, after the
 * WORK_ROOT fallback was retired (plan 2026-06-05).
 *
 * `t` only exercises the active async locale plus the en fallback, so it can
 * never prove the key lives in every catalog. `checkKeyInAllLangs` reads every
 * catalog directly, keeping this independent of the current test locale.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { checkKeyInAllLangs } from '../i18n';

test('thread.bind_required is present in every language catalog (no bare-code fallback)', () => {
  assert.equal(
    checkKeyInAllLangs('thread.bind_required'),
    true,
    'thread.bind_required must exist in every locale — otherwise a user could see the bare code',
  );
});
