/**
 * `buildBindKeyboard` conditional «leave current dir» row (S1 of the
 * command-surface cleanup).
 *
 * Load-bearing facts proven here (not just "renders"):
 *   • isBound=true  → the FIRST inline row is the «leave current dir» button
 *     (callback `bindLeaveCurrent`), and the «create new folder» row follows.
 *   • isBound=false → there is NO `bindLeaveCurrent` button anywhere, and the
 *     FIRST row is «create new folder» (callback `bindCreateFolder`).
 *
 * `./bindKeyboard.testSetup` is imported FIRST so `bot.ts`'s boot-time
 * `parseEnv()` (which `process.exit(1)`s on a missing token) finds a token +
 * a valid `WORK_ROOT` before the module evaluates.
 */
import './bindKeyboard.testSetup';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildBindKeyboard } from '../bot';

/** Wire identifiers the `bot.action(...)` handlers match — must stay in lockstep. */
const leaveCallback = 'bindLeaveCurrent';
const createCallback = 'bindCreateFolder';

/** Flatten the keyboard's first row into its callback_data list. */
function getRowCallbacks(
  keyboard: ReturnType<typeof buildBindKeyboard>,
  rowIndex: number,
): string[] {
  const rows = keyboard.reply_markup.inline_keyboard;
  return rows[rowIndex].map((button) =>
    'callback_data' in button ? button.callback_data : '',
  );
}

function getAllCallbacks(keyboard: ReturnType<typeof buildBindKeyboard>): string[] {
  return keyboard.reply_markup.inline_keyboard.flatMap((row) =>
    row.map((button) => ('callback_data' in button ? button.callback_data : '')),
  );
}

describe('buildBindKeyboard — «leave current dir» row', () => {
  const subdirs = ['alpha', 'beta'];

  it('bound topic: first row is the leave button, then create-folder', () => {
    const keyboard = buildBindKeyboard(subdirs, 0, 20, true);

    // First row = the leave button, alone (full-width).
    assert.deepEqual(getRowCallbacks(keyboard, 0), [leaveCallback]);
    // Second row = the create-folder button.
    assert.deepEqual(getRowCallbacks(keyboard, 1), [createCallback]);
  });

  it('unbound topic: no leave button anywhere, create-folder is first', () => {
    const keyboard = buildBindKeyboard(subdirs, 0, 20, false);

    const allCallbacks = getAllCallbacks(keyboard);
    assert.ok(
      !allCallbacks.includes(leaveCallback),
      `unbound keyboard must not carry "${leaveCallback}"`,
    );
    // First row = the create-folder button (the leave row is omitted).
    assert.deepEqual(getRowCallbacks(keyboard, 0), [createCallback]);
  });

  it('isBound defaults to false (no leave button when omitted)', () => {
    const keyboard = buildBindKeyboard(subdirs);
    assert.ok(!getAllCallbacks(keyboard).includes(leaveCallback));
    assert.deepEqual(getRowCallbacks(keyboard, 0), [createCallback]);
  });
});
