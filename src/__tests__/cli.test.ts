/**
 * @description End-to-end coverage for the `telegramCode` CLI dispatcher.
 *
 * Spawns the CLI as a subprocess (via `tsx`, the same way `yarn dev` runs
 * it) and asserts on stdio + exit code. This catches integration concerns
 * the per-module unit tests miss:
 *
 *   - argv branching (`bot` vs unknown; the removed `cli` passthrough stays
 *     an unknown command)
 *   - the bot preflight (env load, WORK_ROOT default, lock acquire) runs
 *
 * The bot path is not exercised past preflight — booting the real
 * `startBot()` would try to connect to Telegram. The preflight internals
 * are covered separately by `state.test.ts` and `lock.test.ts`.
 */

import { test, beforeEach, afterEach, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;
let claudeShim: string;
// Use the built artifact rather than `--import tsx` so the test doesn't
// depend on Node's module resolution finding `tsx` from a tmpdir cwd. The
// `before()` hook guards against running the test against stale output.
const cliPath = path.resolve(__dirname, '..', '..', 'dist', 'cli.js');

before(() => {
  if (!fs.existsSync(cliPath)) {
    throw new Error(
      `dist/cli.js not found at ${cliPath}. Run \`yarn build\` before \`yarn test\`.`,
    );
  }
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-cli-e2e-'));
  // A tiny no-op shim CLAUDE_BIN points at, so no spawned subprocess can
  // ever invoke a real claude on the dev machine.
  claudeShim = path.join(tmpRoot, 'claude-shim');
  fs.writeFileSync(claudeShim, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Helper: spawn the CLI with the given subcommand args and a curated env.
 * Always points CLAUDE_BIN at the shim so we never accidentally invoke a
 * real claude on the dev machine. Always points HOME / DATA_DIR at the tmp
 * dir so the lockfile can't collide with reality.
 */
function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      CLAUDE_BIN: claudeShim,
      HOME: tmpRoot,
      DATA_DIR: tmpRoot,
      ...extraEnv,
    },
    cwd: tmpRoot,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function getRegexEscapedCanonicalPath(filePath: string): string {
  // Child cwd can canonicalize symlinked temp roots (/var -> /private/var) on macOS.
  return fs.realpathSync(filePath).replace(/\//g, '\\/');
}

test('unknown subcommand exits 2 with usage', () => {
  const { status, stderr } = runCli(['frobnicate']);
  assert.equal(status, 2);
  assert.match(stderr, /Unknown command: frobnicate/);
  assert.match(stderr, /Usage:/);
});

test('removed `cli` passthrough is an unknown command (exit 2, no claude spawn)', () => {
  const { status, stderr } = runCli(['cli', 'claude']);
  assert.equal(status, 2);
  assert.match(stderr, /Unknown command: cli/);
  assert.match(stderr, /Usage:/);
});

test('--help prints usage and exits 0', () => {
  const { status, stderr } = runCli(['--help']);
  assert.equal(status, 0);
  assert.match(stderr, /Usage:/);
  // The removed passthrough must not be advertised any more.
  assert.doesNotMatch(stderr, /cli claude/);
});

test('runBot uses $PWD as WORK_ROOT when unset and proceeds past preflight', () => {
  // Use a fake telegram token so the bot can't actually start polling — it'll
  // fail at the Telegram API call. That's fine: we only care that the
  // preflight (env load, WORK_ROOT default, lock acquire) happened.
  const projectDir = fs.mkdtempSync(path.join(tmpRoot, 'project-'));

  const r = spawnSync(process.execPath, [cliPath, 'bot'], {
    env: {
      ...process.env,
      CLAUDE_BIN: claudeShim,
      HOME: tmpRoot,
      DATA_DIR: path.join(tmpRoot, 'data'),
      // Required envs the bot reads — kept fake so it can't talk to Telegram.
      TELEGRAM_BOT_TOKEN: 'fake-token-' + Date.now(),
      ALLOWED_GROUP_ID: '-100',
      // Unset WORK_ROOT so the default kicks in.
      WORK_ROOT: undefined as unknown as string,
    },
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 10_000,
  });

  // The normal wrapper path uses the current directory as the project parent.
  assert.match(
    r.stderr,
    new RegExp(
      `Using \\$PWD as WORK_ROOT: ${getRegexEscapedCanonicalPath(projectDir)}`,
    ),
  );
});

test('runBot exits 1 when WORK_ROOT points at a non-existent directory', () => {
  const bogus = path.join(tmpRoot, 'does-not-exist');
  const r = spawnSync(process.execPath, [cliPath, 'bot'], {
    env: {
      ...process.env,
      CLAUDE_BIN: claudeShim,
      HOME: tmpRoot,
      DATA_DIR: path.join(tmpRoot, 'data'),
      TELEGRAM_BOT_TOKEN: 'fake-token-' + Date.now(),
      ALLOWED_GROUP_ID: '-100',
      WORK_ROOT: bogus,
    },
    cwd: tmpRoot,
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /WORK_ROOT does not exist or is not a directory/);
  assert.match(r.stderr, new RegExp(bogus.replace(/\//g, '\\/')));
});

test('runBot refuses to start when a foreign lockfile holds the data dir', () => {
  // Plant a lockfile naming pid 1 (init — always alive, never us).
  const dataDir = path.join(tmpRoot, 'data-conflict');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'instance.lock'),
    JSON.stringify({
      pid: 1,
      cwd: '/somewhere-else',
      startedAt: '2026-01-01T00:00:00.000Z',
      tokenHash: 'aaaaaaaaaaaa',
    }),
  );

  const r = spawnSync(process.execPath, [cliPath, 'bot'], {
    env: {
      ...process.env,
      CLAUDE_BIN: claudeShim,
      HOME: tmpRoot,
      DATA_DIR: dataDir,
      TELEGRAM_BOT_TOKEN: 'fake-token-' + Date.now(),
      ALLOWED_GROUP_ID: '-100',
      WORK_ROOT: tmpRoot,
    },
    cwd: tmpRoot,
    encoding: 'utf8',
    timeout: 5_000,
  });

  assert.equal(r.status, 1);
  assert.match(r.stderr, /telegramCode is already running/);
  assert.match(r.stderr, /pid:\s+1/);
  assert.match(r.stderr, /cwd:\s+\/somewhere-else/);

  // Foreign lock must survive — we don't delete other holders' files.
  const stillThere = fs.existsSync(path.join(dataDir, 'instance.lock'));
  assert.equal(stillThere, true);
});

test('runBot accepts an empty ALLOWED_GROUP_ID and boots into pairing mode', () => {
  // Auto-pair: leaving ALLOWED_GROUP_ID empty must NOT trip the fatal
  // "ALLOWED_GROUP_ID must be numeric / is required" guard (the pre-auto-pair
  // behavior) — instead the bot boots with no effective group and the startup
  // banner announces pairing mode. Fresh DATA_DIR ⇒ no persisted pairing ⇒
  // pairing mode is the expected state. Fake token ⇒ the bot fails fast after
  // the banner, exactly like the WORK_ROOT-default test above.
  const projectDir = fs.mkdtempSync(path.join(tmpRoot, 'project-'));
  const r = spawnSync(process.execPath, [cliPath, 'bot'], {
    env: {
      ...process.env,
      CLAUDE_BIN: claudeShim,
      HOME: tmpRoot,
      DATA_DIR: path.join(tmpRoot, 'data-pairing'),
      TELEGRAM_BOT_TOKEN: 'fake-token-' + Date.now(),
      ALLOWED_GROUP_ID: '', // empty ⇒ auto-pair mode
      WORK_ROOT: projectDir,
    },
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 10_000,
  });

  const out = r.stdout + r.stderr;
  // The old fatal guard must be gone for the empty case.
  assert.doesNotMatch(out, /ALLOWED_GROUP_ID (must be|is required)/);
  // Startup banner reached and announced pairing mode.
  assert.match(out, /pairing mode/);
});
