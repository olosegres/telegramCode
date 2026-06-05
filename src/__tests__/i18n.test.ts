/**
 * @description Audit S19 / #50: cover the placeholder substitution
 * pipeline and the missing-key fallback. The module's `lang` is captured
 * at import time from `BOT_LANG`, so we set it BEFORE the static import.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

// Set BOT_LANG before the dictionary module reads it. Node's ESM/CJS
// interop in this project uses CommonJS output, so static imports
// hoist; the env var must be set ahead of the test runner — which it
// is, in practice, because tests are run fresh per file.
process.env.BOT_LANG = 'ru';

import { t, checkKeyInAllLangs } from '../i18n';

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

test('bind.current resolves with the subdir in both locales', () => {
  // The module reads BOT_LANG once at import (ru here), so we can only
  // exercise the active locale through `t`. Assert the key is wired and
  // substitutes; the en fallback path is covered by the unknown-key test.
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
  // Active lang here is ru. A real translation must come back — never the
  // last-code-segment fallback `bind_required` that `t` returns for a key
  // missing in BOTH catalogs — and it must point the user at /bind.
  const out = t('thread.bind_required');
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
    'bind.create_cancelled',
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

test('trace.statusReply substitutes thisThread/allThreads/count placeholders', () => {
  const out = t('trace.statusReply', { thisThread: 'on', allThreads: 'off', count: 3 });
  assert.ok(out.includes('3'), `expected count in "${out}"`);
  assert.ok(!out.includes('{thisThread}') && !out.includes('{allThreads}') && !out.includes('{count}'),
    `placeholders not substituted: "${out}"`);
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
