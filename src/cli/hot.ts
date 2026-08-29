import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { loadEnvFiles } from './envLoader';
import {
  checkIsInstalled,
  ensureOpenCodeServer,
  getDefaultOpenCodeOwnershipFilePath,
  openCodeExternalHostEnvName,
  openCodeExternalHostEnvValue,
  openCodeOwnershipFileEnvName,
  stopOpenCodeServer,
} from '../installManager';

interface HotOpenCodeDeps {
  checkIsInstalled: (toolName: string) => boolean;
  ensureOpenCodeServer: () => Promise<void>;
  stopOpenCodeServer: () => void;
  writeWarning: (message: string) => void;
}

type HotChildName = 'tsc' | 'nodemon';

const tscWatchCompleteMarker = 'Watching for file changes.';
const tscWatchReadyMarker = `Found 0 errors. ${tscWatchCompleteMarker}`;
const tscWatchTailLength = tscWatchReadyMarker.length - 1;

/**
 * @description Wrapper-entry for `telegramcode hot` — hot-reload mode for
 * the global terminal bin.
 *
 * **What it does:** starts `tsc -w` from the project root, then starts
 * `nodemon` only after the watcher's first completed compile. Editing any
 * `src/**` file rebuilds `dist/` and nodemon restarts the internal
 * `dist/cli/botEntry.js` worker on the new artifact. The bot's own
 * graceful-shutdown sequence (state flush → lock release → exit) makes the
 * old → new handoff clean enough that mid-work agent sessions are re-attached
 * on the next boot. OpenCode is pre-started by this long-lived supervisor;
 * later generations use a one-shot external host, so none remain inside
 * nodemon's worker subtree and in-flight turns survive reloads.
 *
 * **Why it lives in the bin** (not only as `yarn hot`): the user runs
 * `telegramcode` as a globally-installed `npm link` symlink, so they don't
 * have a yarn project in front of them. Exposing hot reload as a
 * subcommand makes the same workflow reachable from any CWD — we just
 * resolve the project root from the bin's own realpath. `yarn hot` in the
 * repo is the in-project equivalent.
 *
 * **Failure modes handled:**
 *   - fresh checkout → nodemon waits until `tsc -w` produces the worker entry;
 *   - broken intermediate TS edit → `tsc -w` doesn't emit, so nodemon
 *     never sees a new artifact and the running bot keeps serving;
 *   - bot crash at runtime (e.g. a second poller appears and Telegram
 *     answers 409) → nodemon's `exitcrash` exits instead of parking on
 *     "app crashed - waiting for file changes", so this wrapper tears
 *     down and the supervisor (systemd) starts a clean generation.
 *     Without it the wrapper stays alive with no bot under it, and the
 *     service looks `active (running)` while the bot is dead;
 *   - wrapper termination → tsc receives the original signal, while nodemon
 *     receives its graceful `SIGINT`; we wait for both before exiting.
 *
 * `yarn hot` reaches this same wrapper. It spawns directly so the installed
 * bin doesn't need any devDep but `nodemon` + `typescript`
 * (always present in this project because the consumer of the bin IS this
 * project — `npm link` exposes the same `node_modules/.bin`).
 */
export async function runHot(): Promise<void> {
  // The operator's real launch directory (e.g. `~/src`). Captured BEFORE any
  // spawn so it reflects where `telegramcode hot` was invoked — the worker
  // can't derive it later, because nodemon runs it with cwd = projectRoot.
  const launchCwd = process.cwd();
  const projectRoot = resolveProjectRoot();
  if (!checkIsHotModeSupported(process.platform)) {
    process.stderr.write(
      'telegramcode hot: Windows is not supported because nodemon cannot gracefully drain its worker tree.\n',
    );
    process.exit(1);
    return;
  }
  // Match the worker's env sources without changing the launch cwd that owns
  // WORK_ROOT. This is load-bearing when the repo .env selects a custom port.
  loadEnvFiles(projectRoot);
  // Only nodemon's replaceable worker externalizes later server generations.
  // The long-lived supervisor owns the initial server directly.
  delete process.env[openCodeExternalHostEnvName];
  process.env[openCodeOwnershipFileEnvName] = getDefaultOpenCodeOwnershipFilePath(projectRoot);
  const distEntry = path.join(projectRoot, 'dist', 'cli', 'botEntry.js');
  const tscBin = localBin(projectRoot, 'tsc');
  const nodemonBin = localBin(projectRoot, 'nodemon');

  if (!fs.existsSync(tscBin) || !fs.existsSync(nodemonBin)) {
    process.stderr.write(
      `telegramcode hot: missing devDependencies in ${projectRoot}.\n` +
        `  expected: ${tscBin}\n` +
        `  expected: ${nodemonBin}\n` +
        `Run \`yarn install\` (or \`npm install\`) in the project root and retry.\n`,
    );
    process.exit(1);
    return;
  }

  // nodemon kills the worker's complete descendant tree on every rebuild.
  // Own OpenCode here, as a sibling of nodemon, so an agent turn survives the
  // relay worker being replaced. The worker's normal ensure call adopts it.
  await prepareHotOpenCodeServer();

  process.stderr.write(
    `telegramcode hot: project=${projectRoot}\n` +
      `telegramcode hot: starting \`tsc -w\`; nodemon starts after the first completed compile.\n` +
      `telegramcode hot: Ctrl-C stops both watchers.\n`,
  );

  // Forward terminating signals. We deliberately do NOT re-raise on
  // ourselves after children exit — once both watchers are down the wrapper
  // resolves normally and Node exits with the recorded code. Re-raising
  // would mask the underlying child exit code.
  const children = new Set<ChildProcess>();
  let nodemonChild: ChildProcess | null = null;
  let shuttingDown = false;
  let finalCode = 0;
  let resolveChildrenStopped: (() => void) | null = null;
  const childrenStopped = new Promise<void>((resolve) => {
    resolveChildrenStopped = resolve;
  });

  const checkShouldResolveChildren = () => {
    if (shuttingDown && children.size === 0) resolveChildrenStopped?.();
  };

  const forwardSignal = (sig: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (child.killed || child.exitCode !== null) continue;
      const childName: HotChildName = child === nodemonChild ? 'nodemon' : 'tsc';
      child.kill(getHotChildShutdownSignal(childName, sig));
    }
    checkShouldResolveChildren();
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => forwardSignal(sig));
  }

  const registerChild = (child: ChildProcess, childName: HotChildName) => {
    children.add(child);
    let isSettled = false;
    const settleChild = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (isSettled) return;
      isSettled = true;
      children.delete(child);
      if (error) {
        process.stderr.write(`telegramcode hot: child error (${childName}): ${error.message}\n`);
        if (!shuttingDown && finalCode === 0) finalCode = 1;
      } else {
        const label = childName === 'tsc' ? 'tsc -w' : 'nodemon';
        process.stderr.write(
          `telegramcode hot: ${label} exited ` +
            `(code=${code ?? 'null'}, signal=${signal ?? 'null'})\n`,
        );
        if (!shuttingDown && finalCode === 0) {
          finalCode = getUnexpectedHotChildExitCode(code);
        }
      }
      if (!shuttingDown) forwardSignal('SIGTERM');
      checkShouldResolveChildren();
    };
    child.on('exit', (code, signal) => settleChild(code, signal));
    child.on('error', (error) => settleChild(null, null, error));
  };

  const startNodemon = () => {
    if (shuttingDown || nodemonChild !== null) return;
    nodemonChild = spawn(process.execPath, [nodemonBin], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: buildHotWorkerEnv(process.env, launchCwd),
    });
    registerChild(nodemonChild, 'nodemon');
  };

  // Keep stdout piped so tsc does not clear the terminal between rebuilds and
  // so nodemon can be gated on the first completed watch compile.
  const tscChild = spawn(process.execPath, [tscBin, '-w'], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  registerChild(tscChild, 'tsc');
  let tscOutputTail = '';
  tscChild.stdout?.on('data', (chunk: Buffer) => {
    const output = chunk.toString();
    process.stdout.write(output);
    const inspectionText = tscOutputTail + output;
    const isWatchComplete = inspectionText.includes(tscWatchCompleteMarker);
    const isWatchReady = checkIsTscWatchReady(inspectionText);
    tscOutputTail = inspectionText.slice(-tscWatchTailLength);
    if (!isWatchComplete || nodemonChild !== null || shuttingDown) return;
    tscOutputTail = '';
    if (!isWatchReady) {
      process.stderr.write(
        'telegramcode hot: compile has TypeScript errors; nodemon is waiting for a clean build. ' +
          'Fix the errors and save.\n',
      );
      return;
    }
    if (fs.existsSync(distEntry)) {
      startNodemon();
      return;
    }
    process.stderr.write(
      'telegramcode hot: clean compile produced no dist worker entry. ' +
        'Check the TypeScript output path and save; nodemon will keep waiting.\n',
    );
  });

  await childrenStopped;

  process.exit(finalCode);
}

/**
 * @description Select the signal used to stop each hot-mode watcher. Nodemon's
 * SIGTERM handler can terminate its shell before the asynchronous process-tree
 * sweep reaches the bot worker, leaving that worker alive with the instance
 * lock. SIGINT follows nodemon's graceful quit path and waits for the tree.
 */
export function getHotChildShutdownSignal(
  childName: HotChildName,
  wrapperSignal: NodeJS.Signals,
): NodeJS.Signals {
  return childName === 'nodemon' ? 'SIGINT' : wrapperSignal;
}

/** Return a failing wrapper code whenever a watcher stops on its own. */
export function getUnexpectedHotChildExitCode(code: number | null): number {
  return code !== null && code !== 0 ? code : 1;
}

export function checkIsHotModeSupported(platform: typeof process.platform): boolean {
  return platform !== 'win32';
}

export function checkIsTscWatchReady(text: string): boolean {
  return text.includes(tscWatchReadyMarker);
}

/**
 * @description Pre-start OpenCode in the long-lived hot supervisor, outside
 * nodemon's worker subtree. A missing binary or failed start stays non-fatal:
 * hot mode must still serve Claude/terminal and the worker can retry OpenCode
 * through the externally hosted startup path.
 */
export async function prepareHotOpenCodeServer(
  deps: HotOpenCodeDeps = {
    checkIsInstalled,
    ensureOpenCodeServer,
    stopOpenCodeServer,
    writeWarning: (message) => process.stderr.write(message),
  },
): Promise<boolean> {
  if (!deps.checkIsInstalled('opencode')) return false;
  try {
    await deps.ensureOpenCodeServer();
    return true;
  } catch (error) {
    // `ensureOpenCodeServer` confirms cleanup for generations it started. This
    // extra stop also covers failures outside that startup window.
    deps.stopOpenCodeServer();
    const message =
      error instanceof Error ? error.message : error?.toString() ?? 'unknown error';
    deps.writeWarning(`telegramcode hot: OpenCode pre-start failed: ${message}\n`);
    return false;
  }
}

/**
 * @description Build the env handed to the hot-mode worker (nodemon → bot).
 *
 * In hot mode the supervisor runs `nodemon` with cwd = projectRoot (it must,
 * to watch `dist/`), and the worker (`node dist/cli/botEntry.js`) inherits that
 * cwd. Left alone the worker would default `WORK_ROOT` to `process.cwd()` =
 * the project checkout, so `/bind` would list folders inside the TelegramCode
 * checkout instead of the operator's projects parent. We hand the worker the real
 * launch dir as `WORK_ROOT` so it binds against where the wrapper was started.
 *
 * An explicit `WORK_ROOT` in the inherited env always wins (advanced
 * override); empty/unset falls back to `launchCwd` — matching how `runBot`
 * itself treats `WORK_ROOT` (`!process.env.WORK_ROOT`).
 */
export function buildHotWorkerEnv(
  baseEnv: NodeJS.ProcessEnv,
  launchCwd: string,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    WORK_ROOT: baseEnv.WORK_ROOT || launchCwd,
    [openCodeExternalHostEnvName]: openCodeExternalHostEnvValue,
  };
}

/**
 * @description Resolve the project root from this module's own location.
 *
 * Layout: this file compiles to `<root>/dist/cli/hot.js`, so two `dirname`
 * hops land on `<root>`. We canonicalize via `fs.realpathSync` because the
 * global bin is an `npm link` symlink — without it, `__dirname` would point
 * at the symlinked clone in the user's `node_modules`, not the editable
 * checkout where `tsc -w` and `nodemon` must actually run.
 */
function resolveProjectRoot(): string {
  const here = fs.realpathSync(__dirname);
  return path.resolve(here, '..', '..');
}

/**
 * @description Path to a binary inside the project's local `node_modules/.bin`.
 *
 * Returned even if the file is missing — the caller checks `fs.existsSync`
 * and prints a help message naming the expected path.
 */
function localBin(projectRoot: string, name: string): string {
  return path.join(projectRoot, 'node_modules', '.bin', name);
}
