/**
 * @description `thread.bind_required` — the refusal shown when an agent-facing
 * action (start / list / resume) is attempted on an unbound thread, after the
 * WORK_ROOT fallback was retired (plan 2026-06-05).
 *
 * `i18n` captures `lang` from `BOT_LANG` at import time and `node --test` runs
 * the whole suite in ONE process, so `t` alone can only exercise the active
 * locale plus the en fallback — it can never prove the key lives in BOTH
 * catalogs. `checkKeyInAllLangs` reads every catalog directly, so this test is
 * independent of which locale won the import-time race.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { checkKeyInAllLangs } from '../i18n';

test('thread.bind_required is present in every language catalog (no bare-code fallback)', () => {
  assert.equal(
    checkKeyInAllLangs('thread.bind_required'),
    true,
    'thread.bind_required must exist in both ru and en — otherwise a user could see the bare code',
  );
});
