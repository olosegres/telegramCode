/**
 * @description Pure builder for the `/language` inline picker keyboard — the
 * endonym-button, paginated replacement for the old plain comma-separated code
 * list. Mirrors the `/bind` picker (`buildBindKeyboard` in `bot.ts`): reuses the
 * same tested `paginateBindList` clamp math and the same `⬅️ Prev / n/N / Next ➡️`
 * nav row, but renders one button per LOCALE labelled with its endonym.
 *
 * Kept pure (no `t()`, no bot state) so the layout — page count, `✓` placement,
 * nav visibility, endonym labels — is unit-testable without booting Telegraf.
 * The `🌐 Auto` label is a fixed glyph+word (recognisable across locales), not a
 * translated string, so no per-locale dict key is needed.
 *
 * Wire ids (matched by the `bot.action(...)` handlers — keep in lockstep):
 *   `lang_<code>` · `lang_auto` · `lang_page_<n>` · `lang_page_noop`.
 * All are ≤ 64 bytes (`lang_` + a 2-letter code), well inside Telegram's cap.
 */
import { Markup } from 'telegraf';

import { getLocaleEndonym, localeCodes, type Locale } from '../i18n';
import { paginateBindList } from '../validation';

/** 2 columns × 4 rows per page → 11 locales span exactly 2 pages. */
export const LANGUAGE_PAGE_SIZE = 8;

/** «Reset to auto» button — clears the chat's explicit locale override. */
export const languageAutoCallback = 'lang_auto';

/** Middle "n/N" pill in the nav row — pure UI, no state change. */
export const languagePageNoopCallback = 'lang_page_noop';

/** The page index (0-based) that contains a given locale's endonym button. */
export function getLocalePageIndex(locale: Locale): number {
  const index = localeCodes.indexOf(locale);
  return index < 0 ? 0 : Math.floor(index / LANGUAGE_PAGE_SIZE);
}

function buildLocaleButton(locale: Locale, current: Locale | null) {
  const endonym = getLocaleEndonym(locale);
  const label = locale === current ? `✓ ${endonym}` : endonym;
  return Markup.button.callback(label, `lang_${locale}`);
}

/**
 * @description Build the `/language` picker for one page.
 *
 * @param current the chat's explicit override locale, or `null` for auto (drives
 *   which button carries the `✓` — a locale button when set, the `🌐 Auto` row
 *   when `null`).
 * @param page requested page index; clamped to a valid page.
 */
export function buildLanguagePicker(current: Locale | null, page: number = 0) {
  const { slice, currentPage, totalPages } = paginateBindList(localeCodes, page, LANGUAGE_PAGE_SIZE);

  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = [buildLocaleButton(slice[i], current)];
    if (slice[i + 1]) row.push(buildLocaleButton(slice[i + 1], current));
    rows.push(row);
  }

  // Full-width 🌐 Auto row, on EVERY page so it's always reachable; `✓` when the
  // chat has no explicit override.
  rows.push([
    Markup.button.callback(current === null ? '✓ 🌐 Auto' : '🌐 Auto', languageAutoCallback),
  ]);

  if (totalPages > 1) {
    const nav = [];
    if (currentPage > 0) {
      nav.push(Markup.button.callback('⬅️ Prev', `lang_page_${currentPage - 1}`));
    }
    nav.push(Markup.button.callback(`${currentPage + 1}/${totalPages}`, languagePageNoopCallback));
    if (currentPage < totalPages - 1) {
      nav.push(Markup.button.callback('Next ➡️', `lang_page_${currentPage + 1}`));
    }
    rows.push(nav);
  }

  return Markup.inlineKeyboard(rows);
}
