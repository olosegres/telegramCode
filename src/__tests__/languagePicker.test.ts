/**
 * `buildLanguagePicker` — the endonym, single-page `/language` picker.
 *
 * Load-bearing facts proven here (not just "renders a keyboard"):
 *   • All 12 locales fit in ONE message — every `lang_<code>` button is present,
 *     no pagination / nav row.
 *   • Button labels are the ENDONYMS (each language written in itself), with a
 *     leading `✓` on the current override and none elsewhere.
 *   • The 🌐 Auto row is present and carries the `✓` iff there is no override.
 *   • All callback_data stay within Telegram's 64-byte cap.
 *
 * Pure — no bot / env boot needed (unlike bindKeyboard.test.ts, which imports
 * bot.ts): the picker builder only touches i18n.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLanguagePicker,
  languageAutoCallback,
} from '../utils/languagePicker';
import { getLocaleEndonym, localeCodes, type Locale } from '../i18n';

type Keyboard = ReturnType<typeof buildLanguagePicker>;

function flatButtons(keyboard: Keyboard) {
  return keyboard.reply_markup.inline_keyboard.flat();
}
function callbacks(keyboard: Keyboard): string[] {
  return flatButtons(keyboard).map((button) => ('callback_data' in button ? button.callback_data : ''));
}
function labels(keyboard: Keyboard): string[] {
  return flatButtons(keyboard).map((button) => ('text' in button ? button.text : ''));
}
/** The label of the button whose callback_data is `data`, or undefined. */
function labelFor(keyboard: Keyboard, data: string): string | undefined {
  const button = flatButtons(keyboard).find((b) => 'callback_data' in b && b.callback_data === data);
  return button && 'text' in button ? button.text : undefined;
}

describe('buildLanguagePicker — single page (no pagination)', () => {
  it('holds every locale button in ONE message', () => {
    const cbs = callbacks(buildLanguagePicker(null));
    for (const locale of localeCodes) {
      assert.ok(cbs.includes(`lang_${locale}`), `must hold lang_${locale}`);
    }
  });

  it('has no nav row — no page callbacks', () => {
    const cbs = callbacks(buildLanguagePicker(null));
    for (const data of cbs) {
      assert.ok(!data.startsWith('lang_page'), `unexpected nav callback: "${data}"`);
    }
  });

  it('rows carry at most 2 locale buttons each, plus a full-width Auto row', () => {
    const rows = buildLanguagePicker(null).reply_markup.inline_keyboard;
    const localeRows = rows.slice(0, -1);
    for (const row of localeRows) {
      assert.ok(row.length >= 1 && row.length <= 2, `locale row wrong width: ${row.length}`);
    }
    const autoRow = rows[rows.length - 1];
    assert.equal(autoRow.length, 1, 'the 🌐 Auto row is full-width (1 button)');
    assert.ok('callback_data' in autoRow[0] && autoRow[0].callback_data === languageAutoCallback);
  });
});

describe('buildLanguagePicker — labels + ✓ marker', () => {
  it('locale buttons are labelled with endonyms', () => {
    const keyboard = buildLanguagePicker(null);
    for (const locale of localeCodes) {
      assert.equal(labelFor(keyboard, `lang_${locale}`), getLocaleEndonym(locale));
    }
  });

  it('current override → ✓ on that locale, plain 🌐 Auto', () => {
    const current: Locale = 'ru';
    const keyboard = buildLanguagePicker(current);
    assert.equal(labelFor(keyboard, `lang_${current}`), `✓ ${getLocaleEndonym(current)}`);
    // No OTHER locale button carries a ✓.
    for (const locale of localeCodes) {
      if (locale === current) continue;
      const label = labelFor(keyboard, `lang_${locale}`);
      if (label !== undefined) assert.ok(!label.includes('✓'), `unexpected ✓ on ${locale}: "${label}"`);
    }
    assert.equal(labelFor(keyboard, languageAutoCallback), '🌐 Auto');
  });

  it('no override → ✓ on 🌐 Auto, no locale button marked', () => {
    const keyboard = buildLanguagePicker(null);
    assert.equal(labelFor(keyboard, languageAutoCallback), '✓ 🌐 Auto');
    for (const label of labels(keyboard)) {
      if (label === '✓ 🌐 Auto') continue;
      assert.ok(!label.includes('✓'), `unexpected ✓ on "${label}"`);
    }
  });

  it('all callback_data are ≤ 64 bytes (Telegram cap)', () => {
    for (const data of callbacks(buildLanguagePicker(null))) {
      assert.ok(Buffer.byteLength(data, 'utf8') <= 64, `callback_data too long: "${data}"`);
    }
  });
});
