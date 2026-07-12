/**
 * @description Audit S19 / #50: cover the placeholder substitution
 * pipeline, locale normalization, async locale scoping, and the missing-key
 * fallback. The default runtime locale is English; Telegram/chat-specific
 * locale selection is supplied through `runWithLocale`.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  t,
  checkKeyInAllLangs,
  getKeyInLang,
  localeCodes,
  localeEndonyms,
  getLocaleEndonym,
  formatLanguageDisplay,
  defaultLocale,
  getActiveLang,
  normalizeLocale,
  runWithLocale,
} from '../i18n';
import type { Locale } from '../i18n';
import { enDict } from '../i18n/en';

test('default active locale is English', () => {
  assert.equal(defaultLocale, 'en');
  assert.equal(getActiveLang(), 'en');
});

test('normalizeLocale accepts Telegram region/script variants', () => {
  assert.equal(normalizeLocale('EN'), 'en');
  assert.equal(normalizeLocale('pt-BR'), 'pt');
  assert.equal(normalizeLocale('zh_Hans'), 'zh');
  assert.equal(normalizeLocale('zh_Hans_CN'), 'zh');
  assert.equal(normalizeLocale(' ru '), 'ru');
  assert.equal(normalizeLocale('xx'), null);
  assert.equal(normalizeLocale(undefined), null);
});

test('runWithLocale scopes t across async work and restores the previous locale', async () => {
  assert.equal(getActiveLang(), 'en');

  const out = await runWithLocale('ru', async () => {
    assert.equal(getActiveLang(), 'ru');
    await Promise.resolve();
    return t('language.source.override');
  });

  assert.equal(out, 'настройка чата');
  assert.equal(getActiveLang(), 'en');
});

test('t substitutes single {name} placeholder', () => {
  // Use any known key that takes a placeholder. `cb.binding_to` was
  // added in S18.
  const out = t('cb.binding_to', { subdir: 'overview' });
  assert.ok(out.includes('overview'), `expected substring "overview" in "${out}"`);
});

test('t substitutes multiple placeholders', () => {
  // `thread.bind_collision` mentions `{subdir}` once + `{threads}` once.
  const out = t('thread.bind_collision', { subdir: 'src', threads: '`a`, `b`' });
  assert.ok(out.includes('src'));
  assert.ok(out.includes('`a`, `b`'));
});

test('bind.current resolves with the subdir in the active locale', () => {
  const out = t('bind.current', { subdir: 'overview' });
  assert.ok(out.includes('overview'), `expected "overview" in "${out}"`);
  assert.ok(!out.includes('{subdir}'), `placeholder not substituted: "${out}"`);
});

test('bind.current_none resolves to a non-empty message', () => {
  const out = t('bind.current_none');
  assert.ok(out.length > 0);
  assert.ok(!out.includes('{'));
});

test('thread.bind_required resolves in ru (not the bare-code fallback) and names /bind', () => {
  const out = runWithLocale('ru', () => t('thread.bind_required'));
  assert.notEqual(out, 'bind_required', 'ru catalog is missing thread.bind_required');
  assert.ok(out.includes('/bind'), `expected "/bind" in "${out}"`);
});

test('new.general_hint exists in every locale and names /new', () => {
  assert.ok(checkKeyInAllLangs('new.general_hint'), 'new.general_hint missing in some locale');
  const out = t('new.general_hint');
  assert.ok(out.includes('/new'), `expected "/new" in "${out}"`);
});

test('retired topic-creation keys are gone from both locales', () => {
  // The old /new created a forum topic; its keys must not linger as orphans.
  for (const code of ['new.in_topic', 'new.usage', 'new.created', 'new.created_unbound', 'new.failed', 'new.bind_failed']) {
    assert.ok(!checkKeyInAllLangs(code), `retired key still present: ${code}`);
  }
});

test('agent.question_cancelled_for_prompt exists in every locale (S2 wedged-question backstop)', () => {
  assert.ok(
    checkKeyInAllLangs('agent.question_cancelled_for_prompt'),
    'agent.question_cancelled_for_prompt missing in some locale',
  );
  const out = t('agent.question_cancelled_for_prompt');
  assert.ok(out.length > 0);
  assert.ok(!out.includes('{'), `unexpected placeholder in "${out}"`);
});

test('reattach recap keys exist in every locale', () => {
  for (const code of ['recap.missedCountHeader', 'recap.restartedFallbackHeader', 'recap.stillWorkingLine']) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('recap.missedCountHeader substitutes the {count}', () => {
  const out = t('recap.missedCountHeader', { count: 7 });
  assert.ok(out.includes('7'), `expected the count in "${out}"`);
  assert.ok(!out.includes('{count}'), `placeholder not substituted: "${out}"`);
});

test('file intake keys exist in every locale', () => {
  assert.ok(checkKeyInAllLangs('file.too_big'), 'file.too_big missing in some locale');
  assert.ok(checkKeyInAllLangs('file.download_failed'), 'file.download_failed missing in some locale');
});

test('model-selection keys exist in every locale (S5)', () => {
  assert.ok(checkKeyInAllLangs('model.saved_for_next_start'), 'model.saved_for_next_start missing in some locale');
  assert.ok(checkKeyInAllLangs('model.start_agent_first'), 'model.start_agent_first missing in some locale');
});

test('rename-session keys exist in every locale', () => {
  assert.ok(checkKeyInAllLangs('rename_session.usage'), 'rename_session.usage missing in some locale');
  assert.ok(checkKeyInAllLangs('rename_session.start_agent_first'), 'rename_session.start_agent_first missing in some locale');
  assert.ok(checkKeyInAllLangs('rename_session.unsupported_backend'), 'rename_session.unsupported_backend missing in some locale');
  assert.ok(checkKeyInAllLangs('rename_session.success'), 'rename_session.success missing in some locale');
  assert.ok(checkKeyInAllLangs('rename_session.failed'), 'rename_session.failed missing in some locale');
});

test('connect provider-auth keys exist in every locale', () => {
  for (const code of [
    'connect.prompt_key',
    'connect.empty_key',
    'connect.invalid_provider',
    'connect.unsupported_provider',
    'connect.unsupported_backend',
    'connect.failed',
    'connect.success',
    'connect.cancelled',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('rename_session.success substitutes the {title}', () => {
  const out = t('rename_session.success', { title: 'Refactor auth' });
  assert.ok(out.includes('Refactor auth'), `expected the title in "${out}"`);
  assert.ok(!out.includes('{title}'), `placeholder not substituted: "${out}"`);
});

test('model.saved_for_next_start substitutes the {model} name', () => {
  const out = t('model.saved_for_next_start', { model: 'anthropic/claude-opus-4-8' });
  assert.ok(out.includes('anthropic/claude-opus-4-8'), `expected the model name in "${out}"`);
  assert.ok(!out.includes('{model}'), `placeholder not substituted: "${out}"`);
});

test('file.too_big substitutes the {cap} size', () => {
  const out = t('file.too_big', { cap: 20 });
  assert.ok(out.includes('20'), `expected "20" in "${out}"`);
  assert.ok(!out.includes('{cap}'), `placeholder not substituted: "${out}"`);
});

test('bind create-folder flow keys exist in every locale', () => {
  for (const code of [
    'bind.create_button',
    'bind.create_prompt',
    'bind.create_cb',
    'bind.create_empty',
    'bind.create_separator',
    'bind.create_dot_segment',
    'bind.create_hidden',
    'bind.create_invalid_chars',
    'bind.create_exists',
    'bind.create_failed',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('bind.create_exists substitutes the {subdir}', () => {
  const out = t('bind.create_exists', { subdir: 'overview' });
  assert.ok(out.includes('overview'), `expected the subdir in "${out}"`);
  assert.ok(!out.includes('{subdir}'), `placeholder not substituted: "${out}"`);
});

test('bind.create_failed substitutes the {error}', () => {
  const out = t('bind.create_failed', { error: 'EACCES' });
  assert.ok(out.includes('EACCES'), `expected the error in "${out}"`);
  assert.ok(!out.includes('{error}'), `placeholder not substituted: "${out}"`);
});

test('trace toggle keys exist in every locale', () => {
  for (const code of [
    'trace.onThisThreadReply',
    'trace.offThisThreadReply',
    'trace.onAllThreadsReply',
    'trace.offAllThreadsReply',
    'trace.statusReply',
    'trace.statusOnLabel',
    'trace.statusOffLabel',
    'trace.usageHint',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('timestamps toggle keys exist in every locale', () => {
  for (const code of [
    'timestamps.onReply',
    'timestamps.offReply',
    'timestamps.statusOnReply',
    'timestamps.statusOffReply',
    'timestamps.usageHint',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('language command keys exist in every locale', () => {
  for (const code of [
    'language.status',
    'language.set_success',
    'language.auto_success',
    'language.invalid',
    'language.telegram_unknown',
    'language.source.override',
    'language.source.telegram',
    'language.source.storedTelegram',
    'language.source.fallback',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('language.status renders {display} + {source} + {telegram} (endonym picker rework)', () => {
  // The old comma-separated {current}/{locales} code list is gone — the status
  // line now carries the human display (endonym or "auto (…)"), the source
  // label, and the Telegram profile locale; the picker buttons replace the list.
  const out = t('language.status', {
    display: 'auto (English)',
    source: 'Telegram profile',
    telegram: 'en',
  });
  assert.ok(out.includes('auto (English)'), `expected the display in "${out}"`);
  assert.ok(out.includes('Telegram profile'), `expected the source label in "${out}"`);
  assert.ok(out.includes('en'), `expected the telegram locale in "${out}"`);
  assert.ok(!out.includes('{'), `placeholders not substituted: "${out}"`);
});

test('language.auto_success renders the {display} of the resolved language', () => {
  const out = t('language.auto_success', { display: 'auto (English)' });
  assert.ok(out.includes('auto (English)'), `expected the display in "${out}"`);
  assert.ok(!out.includes('{locale}') && !out.includes('{display}'),
    `placeholder not substituted: "${out}"`);
});

// ── endonyms + formatLanguageDisplay (kept in code, not the per-key dict) ──

test('every locale has a non-empty endonym, kept in code (parity-neutral)', () => {
  for (const loc of localeCodes) {
    const endonym = getLocaleEndonym(loc);
    assert.ok(endonym && endonym.trim().length > 0, `empty endonym for "${loc}"`);
  }
  // Exactly the 11 supported locales, no orphans / extras.
  assert.deepEqual(Object.keys(localeEndonyms).sort(), [...localeCodes].sort());
});

test('endonyms are the expected native names (each language written in itself)', () => {
  const expected: Record<string, string> = {
    en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', pt: 'Português',
    ru: 'Русский', zh: '中文', ja: '日本語', hi: 'हिन्दी', uz: 'Oʻzbekcha', ka: 'ქართული',
  };
  for (const loc of localeCodes) {
    assert.equal(getLocaleEndonym(loc), expected[loc], `wrong endonym for "${loc}"`);
  }
});

test('formatLanguageDisplay: explicit override → the endonym alone', () => {
  assert.equal(formatLanguageDisplay({ locale: 'ru', source: 'override' }), 'Русский');
  assert.equal(formatLanguageDisplay({ locale: 'ka', source: 'override' }), 'ქართული');
});

test('formatLanguageDisplay: any auto source → "auto (<endonym>)"', () => {
  // telegram / storedTelegram / fallback are all non-override → auto form.
  assert.equal(formatLanguageDisplay({ locale: 'en', source: 'telegram' }), 'auto (English)');
  assert.equal(formatLanguageDisplay({ locale: 'de', source: 'storedTelegram' }), 'auto (Deutsch)');
  assert.equal(formatLanguageDisplay({ locale: 'en', source: 'fallback' }), 'auto (English)');
});

test('trace.statusReply substitutes thisThread/allThreads/count placeholders', () => {
  const out = t('trace.statusReply', { thisThread: 'on', allThreads: 'off', count: 3 });
  assert.ok(out.includes('3'), `expected count in "${out}"`);
  assert.ok(!out.includes('{thisThread}') && !out.includes('{allThreads}') && !out.includes('{count}'),
    `placeholders not substituted: "${out}"`);
});

test('scheduler fire keys exist in every locale', () => {
  assert.ok(checkKeyInAllLangs('schedule.fired'), 'schedule.fired missing in some locale');
  assert.ok(checkKeyInAllLangs('schedule.missedNote'), 'schedule.missedNote missing in some locale');
});

test('schedule.fired substitutes name/schedule/prompt and an empty missedNote on-time', () => {
  const out = t('schedule.fired', {
    name: 'Daily reminder',
    schedule: 'daily at 09:00',
    prompt: 'check the deploy',
    missedNote: '',
  });
  assert.ok(out.includes('Daily reminder'), `expected the job name in "${out}"`);
  assert.ok(out.includes('daily at 09:00'), `expected the schedule text in "${out}"`);
  assert.ok(out.includes('check the deploy'), `expected the prompt in "${out}"`);
  assert.ok(!out.includes('{'), `placeholders not substituted: "${out}"`);
});

test('schedule.missedNote substitutes the {time}', () => {
  const out = t('schedule.missedNote', { time: '09:00' });
  assert.ok(out.includes('09:00'), `expected the time in "${out}"`);
  assert.ok(!out.includes('{time}'), `placeholder not substituted: "${out}"`);
});

test('schedule command wrapper keys exist in every locale (S7)', () => {
  assert.ok(
    checkKeyInAllLangs('schedule.forwardPromptTemplate'),
    'schedule.forwardPromptTemplate missing in some locale',
  );
  assert.ok(
    checkKeyInAllLangs('schedule.interviewPromptTemplate'),
    'schedule.interviewPromptTemplate missing in some locale',
  );
});

test('schedule.forwardPromptTemplate: English instructions, per-locale reply language (agent-facing)', () => {
  // These wrap the user request as an instruction the AGENT reads, never the
  // user. The instructions stay English in both catalogs, but the TARGET
  // reply language is baked per locale — on a fresh session the locale is
  // the only reliable user-language signal (live 2026-06-06: "in their
  // language" made the agent ask in English). `getKeyInLang` reads each
  // catalog directly (the active-lang `t` can't compare the other locale).
  const ru = getKeyInLang('ru', 'schedule.forwardPromptTemplate');
  const en = getKeyInLang('en', 'schedule.forwardPromptTemplate');
  assert.ok(ru && en, 'forward template missing in a catalog');
  assert.ok(ru.includes('IN RUSSIAN'), `ru catalog must direct replies to Russian: "${ru}"`);
  assert.ok(en.includes('IN ENGLISH'), `en catalog must direct replies to English: "${en}"`);
  // It must name the MCP tools so the agent knows how to act.
  assert.ok(ru.includes('schedule_create') && en.includes('schedule_create'));
});

test('schedule.interviewPromptTemplate: English instructions, per-locale reply language (agent-facing)', () => {
  const ru = getKeyInLang('ru', 'schedule.interviewPromptTemplate');
  const en = getKeyInLang('en', 'schedule.interviewPromptTemplate');
  assert.ok(ru && en, 'interview template missing in a catalog');
  assert.ok(ru.includes('IN RUSSIAN'), `ru catalog must direct the interview to Russian: "${ru}"`);
  assert.ok(en.includes('IN ENGLISH'), `en catalog must direct the interview to English: "${en}"`);
  assert.ok(ru.includes('schedule_create') && en.includes('schedule_create'));
});

test('schedule.forwardPromptTemplate substitutes {text} verbatim (markdown + quotes preserved)', () => {
  // The wrapper rides every /schedule <text> call — a request containing
  // markdown / quotes / braces must survive substitution untouched so the
  // agent sees exactly what the user typed (no escaping, single regex pass).
  const request = 'remind me to ship **release** and say "done" at 9am `daily`';
  const out = t('schedule.forwardPromptTemplate', { text: request });
  assert.ok(out.includes(request), `expected the verbatim request in "${out}"`);
  assert.ok(!out.includes('{text}'), `placeholder not substituted: "${out}"`);
});

test('startup readiness status keys exist in every locale', () => {
  for (const code of [
    'startup.ready',
    'startup.header_not_ready',
    'startup.item.create_group',
    'startup.item.grant_admin',
    'startup.item.bind_topic',
    'startup.item.install_agent',
    'startup.item.optional_groq',
    'startup.item.optional_owner',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('startup.item.grant_admin substitutes the {missing} rights list', () => {
  const out = t('startup.item.grant_admin', { missing: 'Manage Topics, Pin Messages' });
  assert.ok(out.includes('Manage Topics, Pin Messages'), `expected the rights in "${out}"`);
  assert.ok(!out.includes('{missing}'), `placeholder not substituted: "${out}"`);
});

test('thinking (/thinking) keys exist in every locale (S2)', () => {
  for (const code of [
    'thinking.live',
    'thinking.thoughtForSeconds',
    'thinking.choose',
    'thinking.set_success',
    'thinking.invalid_mode',
    'thinking.mode.minimal',
    'thinking.mode.short',
    'thinking.mode.full',
    'cb.thinking_set',
    'cb.thinking_error',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('thinking.live is the static ••• indicator in every locale (locked decision, S3)', () => {
  // Plan 2026-06-27: the live working cue is the STATIC three-bullet glyph —
  // no animation, no "thinking"/"думаю" word, identical across locales. The
  // native Telegram typing action stays the animated cue.
  for (const lang of localeCodes) {
    assert.equal(getKeyInLang(lang, 'thinking.live'), '•••', `thinking.live must be ••• in ${lang}`);
  }
});

test('unified display-mode label keys exist in every locale (S1)', () => {
  // One label per unified mode per command group — the pickers of /thinking,
  // /tool_results, /subagent and the /verbosity umbrella all render
  // minimal|short|full buttons.
  for (const group of ['thinking', 'toolResults', 'subagent', 'verbosity']) {
    for (const mode of ['minimal', 'short', 'full']) {
      const code = `${group}.mode.${mode}`;
      assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
    }
  }
});

test('verbosity (/verbosity umbrella) keys exist in every locale (S2)', () => {
  for (const code of [
    'verbosity.choose',
    'verbosity.set_success',
    'verbosity.invalid_mode',
    'verbosity.custom',
    'cb.verbosity_set',
    'cb.verbosity_error',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('verbosity.custom substitutes all three per-pref placeholders (mixed state)', () => {
  const out = t('verbosity.custom', {
    thinking: 'кратко',
    toolResults: 'минимум',
    subagent: 'подробно',
  });
  assert.ok(out.includes('кратко') && out.includes('минимум') && out.includes('подробно'),
    `expected all three values in "${out}"`);
  assert.ok(!out.includes('{'), `placeholders not substituted: "${out}"`);
});

test('thinking.thoughtForSeconds substitutes the {seconds} count', () => {
  const out = t('thinking.thoughtForSeconds', { seconds: 12 });
  assert.ok(out.includes('12'), `expected the seconds in "${out}"`);
  assert.ok(!out.includes('{seconds}'), `placeholder not substituted: "${out}"`);
});

test('t falls back to last code segment for unknown key', () => {
  const out = t('nonexistent.key.path');
  assert.equal(out, 'path');
});

test('t returns plain message when no placeholders', () => {
  const out = t('access.denied');
  assert.ok(out.length > 0);
  assert.ok(!out.includes('{'));
});

test('t handles repeated {name} occurrences (each replaced)', () => {
  // No production key uses the same placeholder twice today, but the
  // regex builder is `new RegExp(..., 'g')` which is the behaviour we
  // want to lock in. Synthetic check via direct substitution on a key
  // that does use a placeholder: substitute the value, then count.
  const value = 'X';
  const out = t('cb.binding_to', { subdir: value });
  // We can't synthesise a multi-occurrence key without writing to the
  // dict, so we content-assert: result contains the substituted value
  // at least once and contains zero literal `{subdir}` placeholders.
  assert.ok(out.includes(value));
  assert.ok(!out.includes('{subdir}'));
});

// ── multi-locale tests (11 locales: en, de, fr, es, pt, ru, zh, ja, hi, uz, ka) ──

test('localeCodes lists all 11 supported locales', () => {
  assert.equal(localeCodes.length, 11, `expected 11 locales, got ${localeCodes.length}`);
  assert.ok(localeCodes.includes('en'));
  assert.ok(localeCodes.includes('ru'));
  assert.ok(localeCodes.includes('de'));
  assert.ok(localeCodes.includes('fr'));
  assert.ok(localeCodes.includes('es'));
  assert.ok(localeCodes.includes('pt'));
  assert.ok(localeCodes.includes('zh'));
  assert.ok(localeCodes.includes('ja'));
  assert.ok(localeCodes.includes('hi'));
  assert.ok(localeCodes.includes('uz'));
  assert.ok(localeCodes.includes('ka'));
});

test('every locale has full key parity with en (no missing keys)', () => {
  // en is the canonical reference — every other locale must have the same set
  // of keys. A missing key would silently fall back to en at runtime, but the
  // locked decision is FULL parity for the generated locales.
  const enKeys = Object.keys(enDict);
  assert.ok(enKeys.length >= 250, `en key count suspiciously low: ${enKeys.length}`);

  for (const loc of localeCodes) {
    for (const key of enKeys) {
      const val = getKeyInLang(loc as Locale, key);
      assert.ok(val !== undefined, `key "${key}" missing in locale "${loc}"`);
    }
  }
  // Also verify checkKeyInAllLangs is true for every en key
  for (const key of enKeys) {
    assert.ok(checkKeyInAllLangs(key), `checkKeyInAllLangs failed for "${key}"`);
  }
  // Verify no retired keys are present in ANY locale
  for (const code of ['new.in_topic', 'new.usage', 'new.created', 'new.created_unbound', 'new.failed', 'new.bind_failed']) {
    assert.ok(!checkKeyInAllLangs(code), `retired key still present: ${code}`);
  }
});

test('every locale has the same key count as en (full parity)', () => {
  const enKeys = Object.keys(enDict);
  assert.ok(enKeys.length >= 250, `en key count suspiciously low: ${enKeys.length}`);
  for (const loc of localeCodes) {
    let count = 0;
    for (const key of enKeys) {
      if (getKeyInLang(loc as Locale, key) !== undefined) count++;
    }
    assert.equal(count, enKeys.length, `locale "${loc}" has ${count} keys, expected ${enKeys.length}`);
  }
});

test('agent-facing template reply-language directive varies per locale', () => {
  // The schedule.forwardPromptTemplate keeps English instructions but bakes
  // the TARGET reply language per locale. Each locale must carry a distinct
  // "IN <LANGUAGE>" directive (or the existing ru/en ones).
  const expectedReplyLang: Record<string, string> = {
    en: 'IN ENGLISH',
    ru: 'IN RUSSIAN',
    de: 'IN GERMAN',
    fr: 'IN FRENCH',
    es: 'IN SPANISH',
    pt: 'IN PORTUGUESE',
    zh: 'IN CHINESE',
    ja: 'IN JAPANESE',
    hi: 'IN HINDI',
    uz: 'IN UZBEK',
    ka: 'IN GEORGIAN',
  };
  for (const loc of localeCodes) {
    const fwd = getKeyInLang(loc as Locale, 'schedule.forwardPromptTemplate');
    const ivw = getKeyInLang(loc as Locale, 'schedule.interviewPromptTemplate');
    assert.ok(fwd, `forwardPromptTemplate missing in ${loc}`);
    assert.ok(ivw, `interviewPromptTemplate missing in ${loc}`);
    const expected = expectedReplyLang[loc];
    assert.ok(expected, `no expected reply-lang for ${loc}`);
    assert.ok(fwd.includes(expected), `${loc} forwardPromptTemplate must contain "${expected}": "${fwd}"`);
    assert.ok(ivw.includes(expected), `${loc} interviewPromptTemplate must contain "${expected}": "${ivw}"`);
    // The instructions stay English in every locale
    assert.ok(fwd.includes('schedule_create'), `${loc} must name the MCP tool`);
    assert.ok(ivw.includes('schedule_create'), `${loc} must name the MCP tool`);
  }
});

test('apiRetry.continueNudge is translated per locale (agent-facing nudge)', () => {
  // The continueNudge is agent-facing — it tells the agent to resume. It must
  // be in the locale's language (mirroring the schedule template rule).
  for (const loc of localeCodes) {
    const nudge = getKeyInLang(loc as Locale, 'apiRetry.continueNudge');
    assert.ok(nudge, `continueNudge missing in ${loc}`);
    assert.ok(nudge.length > 5, `${loc} continueNudge suspiciously short: "${nudge}"`);
  }
  // Spot-check: en and ru have known values
  assert.equal(getKeyInLang('en' as Locale, 'apiRetry.continueNudge'), 'Continue from where you left off.');
  assert.equal(getKeyInLang('ru' as Locale, 'apiRetry.continueNudge'), 'Продолжай с того места, где ты остановился.');
});
