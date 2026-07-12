/**
 * `buildLanguagePicker` — the endonym, single-page `/language` picker.
 *
 * Load-bearing facts proven here (not just "renders a keyboard"):
 *   • All 12 locales fit in ONE message — every `lang_<code>` button is present,
 *     no pagination / nav row.
 *   • Locale buttons are ordered A→Z by the language's ENGLISH NAME (Chinese
 *     first … Uzbek last), while the button LABELS stay the endonyms.
 *   • Button labels are the ENDONYMS (each language written in itself), with a
 *     leading `✓` on the current override and none elsewhere.
 *   • The 🌐 Auto row is present, LAST, and carries the `✓` iff there is no
 *     override.
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
import {
  getLocaleEndonym,
  getLocaleEnglishName,
  localeCodes,
  localeEnglishNames,
  type Locale,
} from '../i18n';

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
/** The locale codes (not `auto`) in row-major button order, e.g. `['zh','en',…]`. */
function localeCodeOrder(keyboard: Keyboard): string[] {
  return callbacks(keyboard)
    .filter((data) => data.startsWith('lang_') && data !== languageAutoCallback)
    .map((data) => data.slice('lang_'.length));
}

/** Locked A→Z-by-English-name order — Chinese first … Uzbek last. */
const expectedCodeOrder = ['zh', 'en', 'fr', 'ka', 'de', 'hi', 'ja', 'pt', 'ru', 'es', 'uk', 'uz'];

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

describe('buildLanguagePicker — ordered A→Z by English name', () => {
  it('locale buttons follow the English-name order (Chinese first … Uzbek last)', () => {
    assert.deepEqual(localeCodeOrder(buildLanguagePicker(null)), expectedCodeOrder);
  });

  it('button labels (endonyms) follow the same order', () => {
    const keyboard = buildLanguagePicker(null);
    const endonymOrder = localeCodeOrder(keyboard).map((code) => getLocaleEndonym(code as Locale));
    assert.deepEqual(endonymOrder, [
      '中文', 'English', 'Français', 'ქართული', 'Deutsch', 'हिन्दी',
      '日本語', 'Português', 'Русский', 'Español', 'Українська', 'Oʻzbekcha',
    ]);
  });

  it('the sorted order is genuinely English-name A→Z (not localeCodes order)', () => {
    // Guards against a silent regression to raw insertion order.
    const englishNames = localeCodeOrder(buildLanguagePicker(null)).map((code) =>
      getLocaleEnglishName(code as Locale),
    );
    assert.deepEqual(englishNames, [...englishNames].sort((a, b) => a.localeCompare(b)));
    assert.notDeepEqual(localeCodeOrder(buildLanguagePicker(null)), [...localeCodes]);
  });

  it('🌐 Auto stays the LAST row after the sort', () => {
    const rows = buildLanguagePicker(null).reply_markup.inline_keyboard;
    const lastRow = rows[rows.length - 1];
    assert.equal(lastRow.length, 1);
    assert.ok('callback_data' in lastRow[0] && lastRow[0].callback_data === languageAutoCallback);
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

describe('localeEnglishNames — the English-name map behind the sort', () => {
  it('has a non-empty English name for every one of the 12 locales', () => {
    assert.deepEqual(Object.keys(localeEnglishNames).sort(), [...localeCodes].sort());
    for (const locale of localeCodes) {
      const englishName = getLocaleEnglishName(locale);
      assert.ok(englishName && englishName.trim().length > 0, `empty English name for "${locale}"`);
    }
  });

  it('maps each locale to its expected English name', () => {
    const expected: Record<Locale, string> = {
      en: 'English', de: 'German', fr: 'French', es: 'Spanish', pt: 'Portuguese',
      ru: 'Russian', zh: 'Chinese', ja: 'Japanese', hi: 'Hindi', uz: 'Uzbek',
      ka: 'Georgian', uk: 'Ukrainian',
    };
    for (const locale of localeCodes) {
      assert.equal(getLocaleEnglishName(locale), expected[locale], `wrong English name for "${locale}"`);
    }
  });
});
