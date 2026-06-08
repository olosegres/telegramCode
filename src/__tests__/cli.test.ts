/**
 * @description End-to-end coverage for the `telegramCode` CLI dispatcher.
 *
 * Spawns the CLI as a subprocess (via `tsx`, the same way `yarn dev` runs
 * it) and asserts on stdio + exit code. This catches integration concerns
 * the per-module unit tests miss:
 *
 *   - argv branching (`bot` vs `cli claude` vs unknown)
 *   - `--dangerously-skip-permissions` is auto-injected by `cli claude`
 *   - the user's extra args are appended after the auto-injected flag
 *   - exit code is forwarded from the child claude process
 *   - `CLAUDE_BIN` from env is honoured (we point it at a tiny shim)
 *
 * The bot path is not exercised here — booting the real `startBot()` would
 * try to connect to Telegram. The bot's preflight (WORK_ROOT defaulting,
 * lockfile) is covered separately by `state.test.ts` and `lock.test.ts`.
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
  // A tiny shim that records argv + cwd to a file, then exits with the code
  // we passed in via TEST_CLAUDE_EXIT_CODE (defaults to 0). The recording
  // lets the test verify the wrapper passed the right args.
  claudeShim = path.join(tmpRoot, 'claude-shim');
  fs.writeFileSync(
    claudeShim,
    [
      '#!/bin/sh',
      `echo "argv=$@" > "${tmpRoot}/recorded.txt"`,
      `echo "cwd=$PWD" >> "${tmpRoot}/recorded.txt"`,
      'exit ${TEST_CLAUDE_EXIT_CODE:-0}',
    ].join('\n'),
    { mode: 0o755 },
  );
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

test('cli claude injects --dangerously-skip-permissions and forwards extra args', () => {
  const { status } = runCli(['cli', 'claude', '--print', 'hello world']);
  assert.equal(status, 0);

  const recorded = fs.readFileSync(path.join(tmpRoot, 'recorded.txt'), 'utf8');
  // The shim writes `argv=$@` — should contain our flag first, then the
  // user-supplied args verbatim.
  assert.match(
    recorded,
    /argv=--dangerously-skip-permissions --print hello world/,
  );
  assert.match(recorded, new RegExp(`cwd=${tmpRoot}`));
});

test('cli claude forwards non-zero exit code from the child', () => {
  const { status } = runCli(['cli', 'claude'], {
    TEST_CLAUDE_EXIT_CODE: '7',
  });
  assert.equal(status, 7);
});

test('cli claude with no args still injects --dangerously-skip-permissions', () => {
  const { status } = runCli(['cli', 'claude']);
  assert.equal(status, 0);
  const recorded = fs.readFileSync(path.join(tmpRoot, 'recorded.txt'), 'utf8');
  assert.match(recorded, /argv=--dangerously-skip-permissions\s*$/m);
});

test('cli claude prints helpful error when CLAUDE_BIN is missing', () => {
  const { status, stderr } = runCli(['cli', 'claude'], {
    CLAUDE_BIN: path.join(tmpRoot, 'does-not-exist'),
    // Empty PATH so the strict resolver can't find a system claude either.
    PATH: '',
  });
  assert.equal(status, 1);
  assert.match(stderr, /claude binary not found/);
  assert.match(stderr, /npm install -g @anthropic-ai\/claude-code/);
});

test('unknown subcommand exits 2 with usage', () => {
  const { status, stderr } = runCli(['frobnicate']);
  assert.equal(status, 2);
  assert.match(stderr, /Unknown command: frobnicate/);
  assert.match(stderr, /Usage:/);
});

test('cli with unknown tool exits 2 with usage', () => {
  const { status, stderr } = runCli(['cli', 'banana']);
  assert.equal(status, 2);
  assert.match(stderr, /Unknown cli tool: banana/);
  assert.match(stderr, /Usage:/);
});

test('--help prints usage and exits 0', () => {
  const { status, stderr } = runCli(['--help']);
  assert.equal(status, 0);
  assert.match(stderr, /Usage:/);
  assert.match(stderr, /telegramCode cli claude/);
});

test('cli claude forwards SIGINT and dies by signal (preserves canonical exit status)', async () => {
  // The shim must die BY signal — not trap and `exit 130`. A normal-exit-
  // with-code-130 wouldn't exercise the bug fix at cliClaude.ts:60-66
  // (which only kicks in when `child.on('exit', ..., signal)` reports a
  // non-null `signal`). `exec sleep 5` replaces the /bin/sh process with
  // sleep, so the kernel delivers SIGINT to sleep with no shell trap in
  // between → sleep dies by signal, the wrapper sees signal=SIGINT, and
  // (with the fix) removes its handlers and re-raises on itself.
  fs.writeFileSync(
    claudeShim,
    ['#!/bin/sh', 'exec sleep 5'].join('\n'),
    { mode: 0o755 },
  );

  // Use async spawn instead of spawnSync so we can send a signal while the
  // child is alive. (`spawnSync` blocks the whole event loop, leaving no
  // window to call .kill().)
  const { spawn } = await import('child_process');
  const proc = spawn(process.execPath, [cliPath, 'cli', 'claude'], {
    env: {
      ...process.env,
      CLAUDE_BIN: claudeShim,
      HOME: tmpRoot,
      DATA_DIR: tmpRoot,
    },
    cwd: tmpRoot,
    stdio: 'pipe',
  });

  // Give the shim time to exec sleep (~100ms is plenty).
  await new Promise((r) => setTimeout(r, 150));
  proc.kill('SIGINT');

  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    proc.on('exit', (code, signal) => resolve({ code, signal }));
  });

  // The wrapper itself died by SIGINT (not exit 0 / not exit 1), so the
  // parent shell gets the canonical signal-exit status — the contract
  // documented at cliClaude.ts:60-66. If our signal-listener cleanup
  // regresses, this assertion catches it: re-raising SIGINT while the
  // wrapper's own SIGINT handler is still installed turns into a no-op
  // (handler runs, child already dead, event loop drains → exit 0).
  assert.equal(
    result.signal,
    'SIGINT',
    `expected wrapper to exit by SIGINT, got signal=${result.signal} code=${result.code}`,
  );
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
      `Using \\$PWD as WORK_ROOT: ${projectDir.replace(/\//g, '\\/')}`,
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
