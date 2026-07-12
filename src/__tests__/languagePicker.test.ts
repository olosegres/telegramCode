/**
 * `buildLanguagePicker` — the endonym, paginated `/language` picker.
 *
 * Load-bearing facts proven here (not just "renders a keyboard"):
 *   • 11 locales at PAGE_SIZE 8 → exactly 2 pages; page 0 holds the first 8
 *     locales, page 1 the last 3.
 *   • Button labels are the ENDONYMS (each language written in itself), with a
 *     leading `✓` on the current override and none elsewhere.
 *   • The 🌐 Auto row rides EVERY page and carries the `✓` iff there is no
 *     override.
 *   • Nav omits `⬅️ Prev` on the first page and `Next ➡️` on the last (edge
 *     pages), and an out-of-range page clamps to a valid one.
 *
 * Pure — no bot / env boot needed (unlike bindKeyboard.test.ts, which imports
 * bot.ts): the picker builder only touches i18n + the pagination helper.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLanguagePicker,
  getLocalePageIndex,
  LANGUAGE_PAGE_SIZE,
  languageAutoCallback,
  languagePageNoopCallback,
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

describe('buildLanguagePicker — pagination', () => {
  it('11 locales at PAGE_SIZE 8 → 2 pages; page 0 = first 8 locales', () => {
    assert.equal(LANGUAGE_PAGE_SIZE, 8);
    const keyboard = buildLanguagePicker(null, 0);
    const cbs = callbacks(keyboard);
    for (const locale of localeCodes.slice(0, LANGUAGE_PAGE_SIZE)) {
      assert.ok(cbs.includes(`lang_${locale}`), `page 0 must hold lang_${locale}`);
    }
    for (const locale of localeCodes.slice(LANGUAGE_PAGE_SIZE)) {
      assert.ok(!cbs.includes(`lang_${locale}`), `page 0 must NOT hold lang_${locale}`);
    }
  });

  it('page 1 holds exactly the remaining 3 locales', () => {
    const keyboard = buildLanguagePicker(null, 1);
    const cbs = callbacks(keyboard);
    for (const locale of localeCodes.slice(LANGUAGE_PAGE_SIZE)) {
      assert.ok(cbs.includes(`lang_${locale}`), `page 1 must hold lang_${locale}`);
    }
    for (const locale of localeCodes.slice(0, LANGUAGE_PAGE_SIZE)) {
      assert.ok(!cbs.includes(`lang_${locale}`), `page 1 must NOT hold lang_${locale}`);
    }
  });

  it('first page omits Prev, has Next + the n/N pill', () => {
    const cbs = callbacks(buildLanguagePicker(null, 0));
    assert.ok(!cbs.includes('lang_page_0'), 'first page must not carry a Prev-to-self');
    assert.ok(cbs.includes('lang_page_1'), 'first page must offer Next → page 1');
    assert.ok(cbs.includes(languagePageNoopCallback), 'the n/N pill must be present');
    assert.equal(labelFor(buildLanguagePicker(null, 0), languagePageNoopCallback), '1/2');
  });

  it('last page omits Next, has Prev', () => {
    const cbs = callbacks(buildLanguagePicker(null, 1));
    assert.ok(cbs.includes('lang_page_0'), 'last page must offer Prev → page 0');
    assert.ok(!cbs.includes('lang_page_2'), 'last page must not offer a Next past the end');
    assert.equal(labelFor(buildLanguagePicker(null, 1), languagePageNoopCallback), '2/2');
  });

  it('out-of-range page clamps to a valid page', () => {
    assert.equal(labelFor(buildLanguagePicker(null, 99), languagePageNoopCallback), '2/2');
    assert.equal(labelFor(buildLanguagePicker(null, -5), languagePageNoopCallback), '1/2');
  });
});

describe('buildLanguagePicker — labels + ✓ marker', () => {
  it('locale buttons are labelled with endonyms', () => {
    const keyboard = buildLanguagePicker(null, 0);
    for (const locale of localeCodes.slice(0, LANGUAGE_PAGE_SIZE)) {
      assert.equal(labelFor(keyboard, `lang_${locale}`), getLocaleEndonym(locale));
    }
  });

  it('current override → ✓ on that locale, plain 🌐 Auto', () => {
    const current: Locale = 'ru';
    const keyboard = buildLanguagePicker(current, getLocalePageIndex(current));
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
    const keyboard = buildLanguagePicker(null, 0);
    assert.equal(labelFor(keyboard, languageAutoCallback), '✓ 🌐 Auto');
    for (const label of labels(keyboard)) {
      if (label === '✓ 🌐 Auto') continue;
      assert.ok(!label.includes('✓'), `unexpected ✓ on "${label}"`);
    }
  });

  it('🌐 Auto rides every page', () => {
    assert.ok(callbacks(buildLanguagePicker(null, 0)).includes(languageAutoCallback));
    assert.ok(callbacks(buildLanguagePicker(null, 1)).includes(languageAutoCallback));
  });

  it('all callback_data are ≤ 64 bytes (Telegram cap)', () => {
    for (const page of [0, 1]) {
      for (const data of callbacks(buildLanguagePicker(null, page))) {
        assert.ok(Buffer.byteLength(data, 'utf8') <= 64, `callback_data too long: "${data}"`);
      }
    }
  });
});

describe('getLocalePageIndex', () => {
  it('maps each locale to the page that holds it', () => {
    for (const locale of localeCodes) {
      const expected = Math.floor(localeCodes.indexOf(locale) / LANGUAGE_PAGE_SIZE);
      assert.equal(getLocalePageIndex(locale), expected, `wrong page for ${locale}`);
    }
    // Spot-check the boundary: index 7 (last of page 0) vs index 8 (first of page 1).
    assert.equal(getLocalePageIndex(localeCodes[LANGUAGE_PAGE_SIZE - 1]), 0);
    assert.equal(getLocalePageIndex(localeCodes[LANGUAGE_PAGE_SIZE]), 1);
  });
});
