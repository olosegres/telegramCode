/**
 * @description Pure builder for the `/language` inline picker keyboard — the
 * endonym-button replacement for the old plain comma-separated code list. One
 * button per LOCALE labelled with its endonym, two per row, plus a full-width
 * `🌐 Auto` reset row. All 12 locales fit in ONE message (Telegram allows ~100
 * buttons per inline keyboard), so there is no pagination / nav row.
 *
 * Kept pure (no `t()`, no bot state) so the layout — `✓` placement, endonym
 * labels, Auto row — is unit-testable without booting Telegraf. The `🌐 Auto`
 * label is a fixed glyph+word (recognisable across locales), not a translated
 * string, so no per-locale dict key is needed.
 *
 * Wire ids (matched by the `bot.action(...)` handlers — keep in lockstep):
 *   `lang_<code>` · `lang_auto`.
 * All are ≤ 64 bytes (`lang_` + a 2-letter code), well inside Telegram's cap.
 */
import { Markup } from 'telegraf';

import { getLocaleEndonym, localeCodes, type Locale } from '../i18n';

/** «Reset to auto» button — clears the chat's explicit locale override. */
export const languageAutoCallback = 'lang_auto';

function buildLocaleButton(locale: Locale, current: Locale | null) {
  const endonym = getLocaleEndonym(locale);
  const label = locale === current ? `✓ ${endonym}` : endonym;
  return Markup.button.callback(label, `lang_${locale}`);
}

/**
 * @description Build the single-page `/language` picker (all 12 locales).
 *
 * @param current the chat's explicit override locale, or `null` for auto (drives
 *   which button carries the `✓` — a locale button when set, the `🌐 Auto` row
 *   when `null`).
 */
export function buildLanguagePicker(current: Locale | null) {
  const rows = [];
  for (let i = 0; i < localeCodes.length; i += 2) {
    const row = [buildLocaleButton(localeCodes[i], current)];
    if (localeCodes[i + 1]) row.push(buildLocaleButton(localeCodes[i + 1], current));
    rows.push(row);
  }

  // Full-width 🌐 Auto row; `✓` when the chat has no explicit override.
  rows.push([
    Markup.button.callback(current === null ? '✓ 🌐 Auto' : '🌐 Auto', languageAutoCallback),
  ]);

  return Markup.inlineKeyboard(rows);
}
