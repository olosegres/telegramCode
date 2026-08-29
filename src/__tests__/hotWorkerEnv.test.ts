/**
 * @description Unit coverage for hot-mode worker environment, OpenCode process
 * ownership, and child shutdown signals.
 *
 * The load-bearing concern: in hot mode the worker inherits cwd = projectRoot
 * (nodemon's cwd), so without this injection it would default WORK_ROOT to the
 * TelegramCode checkout and `/bind` would list the wrong folders. These tests
 * pin that the operator's launch dir is propagated, while an explicit
 * WORK_ROOT override still wins and unrelated env is untouched.
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildHotWorkerEnv,
  checkIsHotModeSupported,
  checkIsTscWatchReady,
  getUnexpectedHotChildExitCode,
  getHotChildShutdownSignal,
  prepareHotOpenCodeServer,
} from '../cli/hot';
import {
  getDefaultOpenCodeOwnershipFilePath,
  getOpenCodeChildEnv,
  openCodeExternalHostEnvName,
  openCodeOwnershipFileEnvName,
} from '../installManager';

const launchCwd = '/home/op/src';

test('injects launchCwd as WORK_ROOT when unset', () => {
  const env = buildHotWorkerEnv({ PATH: '/usr/bin' }, launchCwd);
  assert.equal(env.WORK_ROOT, launchCwd);
});

test('marks the nodemon worker so every OpenCode generation is externally hosted', () => {
  const env = buildHotWorkerEnv({ PATH: '/usr/bin' }, launchCwd);
  assert.equal(env.TELEGRAMCODE_HOT_RELOAD, '1');
});

test('passes the persisted OpenCode ownership file to every worker generation', () => {
  const ownershipFilePath = '/tmp/telegramcode-opencode-process';
  const env = buildHotWorkerEnv(
    { [openCodeOwnershipFileEnvName]: ownershipFilePath },
    launchCwd,
  );
  assert.equal(env[openCodeOwnershipFileEnvName], ownershipFilePath);
});

test('resolves a relative DATA_DIR against the hot worker project root', () => {
  const savedDataDirectory = process.env.DATA_DIR;
  process.env.DATA_DIR = 'relative-data';
  try {
    assert.equal(
      getDefaultOpenCodeOwnershipFilePath('/opt/telegramcode'),
      '/opt/telegramcode/relative-data/.opencode-server-process',
    );
  } finally {
    if (savedDataDirectory === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedDataDirectory;
  }
});

test('strips hot ownership controls from every OpenCode child environment', () => {
  const env = getOpenCodeChildEnv({
    PATH: '/usr/bin',
    [openCodeExternalHostEnvName]: '1',
    [openCodeOwnershipFileEnvName]: '/tmp/owned-process',
  });
  assert.deepEqual(env, { PATH: '/usr/bin' });
});

test('OpenCode OAuth uses the stripped child environment at its spawn boundary', () => {
  const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');
  const functionStart = botSource.indexOf('async function startOpenCodeOAuthLogin');
  const functionEnd = botSource.indexOf('\nasync function ', functionStart + 1);
  const functionSource = botSource.slice(functionStart, functionEnd);
  assert.ok(functionStart >= 0);
  assert.match(functionSource, /const env:[^=]+ = getOpenCodeChildEnv\(\)/);
  assert.doesNotMatch(functionSource, /const env:[^=]+ = \{ \.\.\.process\.env \}/);
  assert.match(functionSource, /spawnPty\([\s\S]*?\{[\s\S]*?\benv,\s*\n\s*\}\)/);
  assert.doesNotMatch(functionSource, /spawnPty\([\s\S]*?env:\s*process\.env/);
});

test('OpenCode models uses the stripped child environment at its exec boundary', () => {
  const adapterSource = fs.readFileSync(
    path.join(__dirname, '..', 'adapters', 'openCodeAdapter.ts'),
    'utf8',
  );
  const functionStart = adapterSource.indexOf('async function fetchAvailableModels');
  const functionEnd = adapterSource.indexOf('\nfunction ', functionStart + 1);
  const functionSource = adapterSource.slice(functionStart, functionEnd);
  assert.ok(functionStart >= 0);
  assert.match(
    functionSource,
    /execAsync\([\s\S]*?\{[\s\S]*?env:\s*getOpenCodeChildEnv\(\)[\s\S]*?\}\)/,
  );
  assert.doesNotMatch(functionSource, /execAsync\([\s\S]*?env:\s*process\.env/);
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

test('hot supervisor starts OpenCode outside the nodemon worker subtree', async () => {
  const events: string[] = [];

  const isReady = await prepareHotOpenCodeServer({
    checkIsInstalled: (toolName) => {
      events.push(`check:${toolName}`);
      return true;
    },
    ensureOpenCodeServer: async () => {
      events.push('ensure');
    },
    stopOpenCodeServer: () => events.push('stop'),
    writeWarning: (message) => events.push(`warning:${message}`),
  });

  assert.equal(isReady, true);
  assert.deepEqual(events, ['check:opencode', 'ensure']);
});

test('hot supervisor leaves OpenCode unavailable when the binary is not installed', async () => {
  let ensureCalls = 0;

  const isReady = await prepareHotOpenCodeServer({
    checkIsInstalled: () => false,
    ensureOpenCodeServer: async () => {
      ensureCalls += 1;
    },
    stopOpenCodeServer: () => {},
    writeWarning: () => {},
  });

  assert.equal(isReady, false);
  assert.equal(ensureCalls, 0);
});

test('hot supervisor keeps the watchers bootable when OpenCode startup fails', async () => {
  const events: string[] = [];

  const isReady = await prepareHotOpenCodeServer({
    checkIsInstalled: () => true,
    ensureOpenCodeServer: async () => {
      throw new Error('port unavailable');
    },
    stopOpenCodeServer: () => events.push('stop'),
    writeWarning: (message) => events.push(`warning:${message}`),
  });

  assert.equal(isReady, false);
  assert.deepEqual(events, [
    'stop',
    'warning:telegramcode hot: OpenCode pre-start failed: port unavailable\n',
  ]);
});

test('hot supervisor asks nodemon to quit gracefully instead of orphaning its worker', () => {
  assert.equal(getHotChildShutdownSignal('nodemon', 'SIGTERM'), 'SIGINT');
  assert.equal(getHotChildShutdownSignal('nodemon', 'SIGHUP'), 'SIGINT');
});

test('hot supervisor preserves the incoming signal for the TypeScript watcher', () => {
  assert.equal(getHotChildShutdownSignal('tsc', 'SIGTERM'), 'SIGTERM');
  assert.equal(getHotChildShutdownSignal('tsc', 'SIGHUP'), 'SIGHUP');
});

test('hot supervisor reports every unexpected child termination as failure', () => {
  assert.equal(getUnexpectedHotChildExitCode(0), 1);
  assert.equal(getUnexpectedHotChildExitCode(null), 1);
  assert.equal(getUnexpectedHotChildExitCode(9), 9);
});

test('hot mode refuses Windows instead of risking an orphaned worker tree', () => {
  assert.equal(checkIsHotModeSupported('win32'), false);
  assert.equal(checkIsHotModeSupported('linux'), true);
  assert.equal(checkIsHotModeSupported('darwin'), true);
});

test('recognizes the TypeScript watch-ready marker before starting nodemon', () => {
  assert.equal(
    checkIsTscWatchReady('Found 0 errors. Watching for file changes.'),
    true,
  );
});

test('does not treat compiler errors or ordinary output as watch readiness', () => {
  assert.equal(checkIsTscWatchReady('Starting compilation in watch mode...'), false);
  assert.equal(checkIsTscWatchReady('Found 1 error.'), false);
  assert.equal(
    checkIsTscWatchReady('Found 1 error. Watching for file changes.'),
    false,
  );
});

test('hot builds never emit broken artifacts that nodemon could restart', () => {
  const tsconfigSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'tsconfig.json'),
    'utf8',
  );
  assert.match(tsconfigSource, /"noEmitOnError"\s*:\s*true/);
});
