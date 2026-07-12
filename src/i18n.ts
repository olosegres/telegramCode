/**
 * @description Lightweight i18n for the multi-thread bot.
 *
 * A single source of truth: a dictionary keyed by short stable codes. The
 * active locale is supplied by the Telegram update context (or a persisted
 * chat override); when no locale is known, English is the fallback.
 *
 * Design choices:
 *
 * 1. **Codes, not English-as-key.** `'thread.bound'` instead of
 *    `'📁 Bound to {subdir}'` so renames don't ripple through `t()` calls
 *    and so translators see semantic intent.
 * 2. **No external library.** A handful of strings and one fallback rule
 *    don't justify pulling in i18next. Easy to swap later.
 * 3. **`{placeholder}` substitution.** Single regex pass, escapes are
 *    handled by callers (we don't try to be markdown-aware).
 * 4. **English is the fallback** so missing translations degrade gracefully
 *    rather than echoing the code back to the user.
 * 5. **Per-locale modules.** Each locale lives in `src/i18n/<locale>.ts`.
 *    `en.ts` is the canonical reference — add a key there first, then mirror
 *    it in every other locale. Generated locales carry a header comment
 *    noting they are machine-translated (native review welcome).
 *
 * Error templates (plan §20.7) are co-located here under the `error.*`
 * namespace and consumed via {@link errorMessage}, which is sugar over
 * `t()` plus button hints.
 */

import { enDict } from './i18n/en';
import { ruDict } from './i18n/ru';
import { deDict } from './i18n/de';
import { frDict } from './i18n/fr';
import { esDict } from './i18n/es';
import { ptDict } from './i18n/pt';
import { zhDict } from './i18n/zh';
import { jaDict } from './i18n/ja';
import { hiDict } from './i18n/hi';
import { uzDict } from './i18n/uz';
import { kaDict } from './i18n/ka';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * @description Supported locale codes. `en` is the canonical fallback. `ru` is
 * hand-maintained; the rest are machine-translated from `en`.
 */
export type Locale = 'en' | 'de' | 'fr' | 'es' | 'pt' | 'ru' | 'zh' | 'ja' | 'hi' | 'uz' | 'ka';

/** Ordered list of every supported locale — used for parity checks. */
export const localeCodes: Locale[] = ['en', 'de', 'fr', 'es', 'pt', 'ru', 'zh', 'ja', 'hi', 'uz', 'ka'];

/**
 * @description Endonyms — each language's name written in itself. Kept in CODE
 * (not the per-key `dict`) on purpose: an endonym is the SAME regardless of the
 * active UI locale (Русский is «Русский» on an English UI too), so it needs no
 * per-locale translation and must not inflate the key-parity surface.
 */
export const localeEndonyms: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pt: 'Português',
  ru: 'Русский',
  zh: '中文',
  ja: '日本語',
  hi: 'हिन्दी',
  uz: 'Oʻzbekcha',
  ka: 'ქართული',
};

/** The endonym (native name) of a locale — e.g. `ru → Русский`. */
export function getLocaleEndonym(locale: Locale): string {
  return localeEndonyms[locale];
}

/**
 * @description Human-readable display of a chat's resolved language.
 *
 * - explicit chat override → the endonym alone (e.g. `Русский`).
 * - any auto source (Telegram profile / last-seen / fallback) → `auto (<endonym>)`,
 *   so the user sees BOTH that it's auto AND which language auto landed on.
 *
 * Pure and structural: it needs only the resolved locale + whether the source is
 * an explicit override, so it stays decoupled from the `ResolvedChatLocale` shape
 * that lives in `bot.ts` (`'override'` is that type's discriminant tag).
 */
export function formatLanguageDisplay(resolved: { locale: Locale; source: string }): string {
  const endonym = getLocaleEndonym(resolved.locale);
  return resolved.source === 'override' ? endonym : `auto (${endonym})`;
}

/**
 * @description Dictionary of user-facing strings.
 *
 * Top key = locale, nested key = message code. We keep the type permissive
 * (`Record<string, string>`) so new codes can land without touching a giant
 * type — drift is caught by a runtime fallback to English and by the
 * key-parity tests, not by TypeScript.
 */
const dict: Record<Locale, Record<string, string>> = {
  en: enDict,
  de: deDict,
  fr: frDict,
  es: esDict,
  pt: ptDict,
  ru: ruDict,
  zh: zhDict,
  ja: jaDict,
  hi: hiDict,
  uz: uzDict,
  ka: kaDict,
};

/** Default locale used when Telegram gives no usable language and no override exists. */
export const defaultLocale: Locale = 'en';

/** Set of recognised locale codes for O(1) validation. */
const knownLocales = new Set<string>(localeCodes);

const localeStorage = new AsyncLocalStorage<Locale>();

/**
 * @description Normalise a Telegram/client locale into one of the supported
 * catalogs. Telegram may send region/script tags (`pt-BR`, `zh-Hans`); the bot
 * ships base-language catalogs, so exact match wins, then the base tag.
 */
export function normalizeLocale(value: string | null | undefined): Locale | null {
  const raw = value?.trim().toLowerCase().replace(/_/g, '-');
  if (!raw) return null;
  if (knownLocales.has(raw)) return raw as Locale;
  const base = raw.split('-')[0];
  return knownLocales.has(base) ? base as Locale : null;
}

/** Run code with a locale visible to all nested async work created inside it. */
export function runWithLocale<T>(locale: Locale, fn: () => T): T {
  return localeStorage.run(locale, fn);
}

function getCurrentLocale(): Locale {
  return localeStorage.getStore() ?? defaultLocale;
}

/**
 * @description Format a localised message.
 *
 * `opts` values are substituted into `{name}` placeholders. Unknown codes
 * fall back to English; if the code is missing in English too, the last
 * segment of the code is returned with a warning (loud failure mode —
 * easier to spot in tests / logs than a silently empty string).
 *
 * Audit S18 / #46: previously returned the raw code, which surfaces in
 * chat as e.g. `agent.foo.bar` — confusing for users. Last-segment
 * fallback at least reads naturally while the warning still hits logs.
 */
export function t(code: string, opts?: Record<string, string | number>): string {
  const locale = getCurrentLocale();
  const primary = dict[locale][code];
  const fallback = dict.en[code];
  let template: string;
  if (primary !== undefined) {
    template = primary;
  } else if (fallback !== undefined) {
    template = fallback;
  } else {
    console.warn(`[i18n] missing key "${code}" in ${locale} and en`);
    template = code.split('.').pop() ?? code;
  }
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      template = template.replace(new RegExp(`\\{${k}\\}`, 'g'), v.toString());
    }
  }
  return template;
}

/**
 * @description Sugar for {@link t} that prefixes the code with `error.`
 * — purely cosmetic, makes call sites easier to read and grep for.
 */
export function errorMessage(code: string, opts?: Record<string, string | number>): string {
  return t(`error.${code}`, opts);
}

/** Exposed for tests + debug output (returns the current async context locale). */
export function getActiveLang(): Locale {
  return getCurrentLocale();
}

/**
 * @description Integrity check (tests): is `code` present in EVERY language
 * catalog? Independent of the import-time `lang`, so a single test process can
 * prove a key resolves in every locale without the bare-code fallback —
 * which `t` alone can't show, since it only ever reaches the active locale plus
 * the en fallback.
 */
export function checkKeyInAllLangs(code: string): boolean {
  return (Object.keys(dict) as Locale[]).every((l) => dict[l][code] !== undefined);
}

/**
 * @description Read one catalog's raw value for `code` (tests). Lets a single
 * test process compare the SAME key across locales — needed for agent-facing
 * keys (e.g. the `/schedule` wrapper prompts) whose English instructions must
 * carry a PER-LOCALE reply-language directive (ru → "IN RUSSIAN", en → "IN
 * ENGLISH", de → "IN GERMAN", …), a property `checkKeyInAllLangs` (presence
 * only) and the active-locale `t` cannot prove.
 */
export function getKeyInLang(locale: Locale, code: string): string | undefined {
  return dict[locale][code];
}
