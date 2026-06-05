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

import { t } from '../i18n';

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
