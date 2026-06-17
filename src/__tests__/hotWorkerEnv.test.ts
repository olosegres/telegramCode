/**
 * @description Unit coverage for `buildHotWorkerEnv` — the env the hot-mode
 * supervisor hands down to the worker it spawns via nodemon.
 *
 * The load-bearing concern: in hot mode the worker inherits cwd = projectRoot
 * (nodemon's cwd), so without this injection it would default WORK_ROOT to the
 * telegram-code checkout and `/bind` would list the wrong folders. These tests
 * pin that the operator's launch dir is propagated, while an explicit
 * WORK_ROOT override still wins and unrelated env is untouched.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildHotWorkerEnv } from '../cli/hot';

const launchCwd = '/home/op/src';

test('injects launchCwd as WORK_ROOT when unset', () => {
  const env = buildHotWorkerEnv({ PATH: '/usr/bin' }, launchCwd);
  assert.equal(env.WORK_ROOT, launchCwd);
});

test('injects launchCwd as WORK_ROOT when set to empty string', () => {
  const env = buildHotWorkerEnv({ WORK_ROOT: '' }, launchCwd);
  assert.equal(env.WORK_ROOT, launchCwd);
});

test('explicit WORK_ROOT override wins over launchCwd', () => {
  const env = buildHotWorkerEnv(
    { WORK_ROOT: '/explicit/override' },
    launchCwd,
  );
  assert.equal(env.WORK_ROOT, '/explicit/override');
});

test('passes through unrelated env vars unchanged', () => {
  const base = { PATH: '/usr/bin', TELEGRAM_BOT_TOKEN: 'secret', HOME: '/home/op' };
  const env = buildHotWorkerEnv(base, launchCwd);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.TELEGRAM_BOT_TOKEN, 'secret');
  assert.equal(env.HOME, '/home/op');
});

test('does not mutate the input env object', () => {
  const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
  buildHotWorkerEnv(base, launchCwd);
  assert.equal(base.WORK_ROOT, undefined);
});
