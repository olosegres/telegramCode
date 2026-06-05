/**
 * @description S7 — pure decision for the Claude fresh-spawn `/effort` replay.
 *
 * `getEffortStartupKeystroke(storedLevel)` is the testable seam between the
 * on-disk per-thread effort pref and the keystroke typed into a fresh TUI:
 *   - a stored level → `"/effort <level>"`
 *   - no level (null / empty / whitespace) → `null` (type nothing)
 *   - a level claude can't honour → still returned as-is (claude clamps per
 *     model; the adapter does NOT validate here, same as a manual /effort)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEffortStartupKeystroke } from '../utils/effortStartupKeystroke';

describe('getEffortStartupKeystroke (S7)', () => {
  it('builds the slash command for a stored level', () => {
    assert.equal(getEffortStartupKeystroke('high'), '/effort high');
    assert.equal(getEffortStartupKeystroke('ultracode'), '/effort ultracode');
  });

  it('returns null when there is no stored pref', () => {
    assert.equal(getEffortStartupKeystroke(null), null);
  });

  it('returns null for empty / whitespace-only prefs (treated as "none")', () => {
    assert.equal(getEffortStartupKeystroke(''), null);
    assert.equal(getEffortStartupKeystroke('   '), null);
  });

  it('trims surrounding whitespace but keeps the level verbatim', () => {
    assert.equal(getEffortStartupKeystroke('  max  '), '/effort max');
  });

  it('does NOT validate — an unknown level is typed as-is (claude clamps)', () => {
    // A level claude does not support for the current model must still be
    // typed; claude clamps it down. Validating here would silently drop it.
    assert.equal(getEffortStartupKeystroke('superwarp'), '/effort superwarp');
  });
});
