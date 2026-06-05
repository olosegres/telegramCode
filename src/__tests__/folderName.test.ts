/**
 * @description Unit tests for `validateNewFolderName` — the FIRST gate of the
 * `/bind` create-folder flow. It validates a name typed for a brand-new
 * folder BEFORE `mkdir` (unlike `validateSubdir`, which resolves an existing
 * path). Each rejection must surface a distinct `reason` so the bot can map
 * it to a localised reply.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { validateNewFolderName } from '../folderName';

test('accepts a plain folder name and returns it', () => {
  const result = validateNewFolderName('overview');
  assert.deepEqual(result, { ok: true, name: 'overview' });
});

test('trims surrounding whitespace before accepting', () => {
  const result = validateNewFolderName('  my-project  ');
  assert.deepEqual(result, { ok: true, name: 'my-project' });
});

test('accepts a numeric-looking name (so digit names are not lost)', () => {
  // The text handler checks folder mode BEFORE numeric model/session picks,
  // and this proves the validator itself does not reject digit names.
  const result = validateNewFolderName('2025');
  assert.deepEqual(result, { ok: true, name: '2025' });
});

test('accepts names with spaces and dots in the middle', () => {
  assert.deepEqual(validateNewFolderName('my api v2'), { ok: true, name: 'my api v2' });
  assert.deepEqual(validateNewFolderName('app.config'), { ok: true, name: 'app.config' });
});

test('rejects empty / whitespace-only as "empty"', () => {
  assert.deepEqual(validateNewFolderName(''), { ok: false, reason: 'empty' });
  assert.deepEqual(validateNewFolderName('   '), { ok: false, reason: 'empty' });
});

test('rejects forward slash as "separator" (no nested paths)', () => {
  assert.deepEqual(validateNewFolderName('a/b'), { ok: false, reason: 'separator' });
  assert.deepEqual(validateNewFolderName('nested/'), { ok: false, reason: 'separator' });
});

test('rejects backslash as "separator"', () => {
  assert.deepEqual(validateNewFolderName('a\\b'), { ok: false, reason: 'separator' });
});

test('rejects path traversal: a slash-bearing "../escape" is a separator reject', () => {
  // Traversal needs a separator; the separator check fires first.
  assert.deepEqual(validateNewFolderName('../escape'), { ok: false, reason: 'separator' });
});

test('rejects bare "." and ".." as "dot_segment"', () => {
  assert.deepEqual(validateNewFolderName('.'), { ok: false, reason: 'dot_segment' });
  assert.deepEqual(validateNewFolderName('..'), { ok: false, reason: 'dot_segment' });
});

test('rejects a leading-dot (hidden) name as "hidden"', () => {
  assert.deepEqual(validateNewFolderName('.secret'), { ok: false, reason: 'hidden' });
});

test('rejects control characters (tab / newline / NUL) as "invalid_chars"', () => {
  assert.deepEqual(validateNewFolderName('tab\tname'), { ok: false, reason: 'invalid_chars' });
  assert.deepEqual(validateNewFolderName('line\nname'), { ok: false, reason: 'invalid_chars' });
  assert.deepEqual(validateNewFolderName('nul\x00name'), { ok: false, reason: 'invalid_chars' });
});
