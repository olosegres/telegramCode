import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';

/**
 * @description Wrapper-entry for `telegramCode hot` — hot-reload mode for
 * the global terminal bin.
 *
 * **What it does:** runs `tsc -w` and `nodemon` side-by-side from the
 * project root, so editing any `src/**` file rebuilds `dist/` and nodemon
 * restarts `node dist/cli.js bot` on the new artifact. The bot's own
 * graceful-shutdown sequence (state flush → lock release → exit) makes the
 * old → new handoff clean enough that mid-work tmux/SSE agent sessions
 * outlive the reload and are re-attached on the next boot.
 *
 * **Why it lives in the bin** (not only as `yarn hot`): the user runs
 * `telegramCode` as a globally-installed `npm link` symlink, so they don't
 * have a yarn project in front of them. Exposing hot reload as a
 * subcommand makes the same workflow reachable from any CWD — we just
 * resolve the project root from the bin's own realpath. `yarn hot` in the
 * repo is the in-project equivalent.
 *
 * **Failure modes handled:**
 *   - missing `dist/cli.js` (fresh checkout) → run a one-shot `tsc` first
 *     so nodemon has something to launch;
 *   - broken intermediate TS edit → `tsc -w` doesn't emit, so nodemon
 *     never sees a new artifact and the running bot keeps serving;
 *   - SIGINT/SIGTERM in the wrapper → propagated to both children, then
 *     we wait for them to exit before our own `process.exit`.
 *
 * **Independent of the runner from `yarn hot`** — that script uses
 * `concurrently` for terseness; this entry point spawns directly so the
 * installed bin doesn't need any devDep but `nodemon` + `typescript`
 * (always present in this project because the consumer of the bin IS this
 * project — `npm link` exposes the same `node_modules/.bin`).
 */
export async function runHot(): Promise<void> {
  // The operator's real launch directory (e.g. `~/src`). Captured BEFORE any
  // spawn so it reflects where `telegramCode hot` was invoked — the worker
  // can't derive it later, because nodemon runs it with cwd = projectRoot.
  const launchCwd = process.cwd();
  const projectRoot = resolveProjectRoot();
  const distEntry = path.join(projectRoot, 'dist', 'cli.js');
  const tscBin = localBin(projectRoot, 'tsc');
  const nodemonBin = localBin(projectRoot, 'nodemon');

  if (!fs.existsSync(tscBin) || !fs.existsSync(nodemonBin)) {
    process.stderr.write(
      `telegramCode hot: missing devDependencies in ${projectRoot}.\n` +
        `  expected: ${tscBin}\n` +
        `  expected: ${nodemonBin}\n` +
        `Run \`yarn install\` (or \`npm install\`) in the project root and retry.\n`,
    );
    process.exit(1);
    return;
  }

  // First-time bootstrap: nodemon can't launch what doesn't exist. Run a
  // blocking one-shot `tsc` to populate `dist/`. Incremental builds against
  // an existing `dist/` are fast (sub-second on this project), so the cost
  // when the user already has a build is negligible.
  if (!fs.existsSync(distEntry)) {
    process.stderr.write(`telegramCode hot: dist/ missing, running initial tsc...\n`);
    const initial = spawnSync(tscBin, [], {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    if (initial.status !== 0) {
      process.stderr.write(
        `telegramCode hot: initial tsc failed (exit ${initial.status}). ` +
          `Fix the TypeScript errors above and retry.\n`,
      );
      process.exit(initial.status ?? 1);
      return;
    }
  }

  process.stderr.write(
    `telegramCode hot: project=${projectRoot}\n` +
      `telegramCode hot: spawning \`tsc -w\` and \`nodemon\` — Ctrl-C to stop both.\n`,
  );

  // Spawn the two watchers as children of this wrapper. Both inherit
  // stdio so the user sees tsc errors and nodemon output interleaved in
  // their terminal. Using `node <bin>` instead of executing the bin
  // directly avoids any shebang-resolution differences across platforms
  // (the `.bin` scripts are Node CLI tools, not native binaries).
  const tscChild = spawn(process.execPath, [tscBin, '-w'], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  const nodemonChild = spawn(process.execPath, [nodemonBin], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: buildHotWorkerEnv(process.env, launchCwd),
  });

  const children: ChildProcess[] = [tscChild, nodemonChild];

  // Forward terminating signals. We deliberately do NOT re-raise on
  // ourselves after children exit — once both watchers are down the wrapper
  // resolves normally and Node exits with the recorded code. Re-raising
  // would mask the underlying child exit code.
  let shuttingDown = false;
  const forwardSignal = (sig: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const c of children) {
      if (!c.killed && c.exitCode === null) c.kill(sig);
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => forwardSignal(sig));
  }

  // If EITHER child dies unexpectedly (e.g. tsc -w crashes on an internal
  // error, or nodemon is killed by the OOM killer), tear the other one
  // down too — running half a hot-reload setup is worse than no setup.
  let finalCode = 0;
  await Promise.all(
    children.map(
      (c, idx) =>
        new Promise<void>((resolve) => {
          c.on('exit', (code, signal) => {
            const label = idx === 0 ? 'tsc -w' : 'nodemon';
            process.stderr.write(
              `telegramCode hot: ${label} exited ` +
                `(code=${code ?? 'null'}, signal=${signal ?? 'null'})\n`,
            );
            // Propagate the first non-zero code we see; if we're already
            // shutting down because of a signal, keep code 0.
            if (!shuttingDown && code !== null && code !== 0 && finalCode === 0) {
              finalCode = code;
            }
            // Trigger sibling tear-down (idempotent — forwardSignal guards
            // re-entry; sibling that already exited is a no-op).
            forwardSignal('SIGTERM');
            resolve();
          });
          c.on('error', (err) => {
            process.stderr.write(
              `telegramCode hot: child error (${idx === 0 ? 'tsc' : 'nodemon'}): ${err.message}\n`,
            );
            if (finalCode === 0) finalCode = 1;
            forwardSignal('SIGTERM');
            resolve();
          });
        }),
    ),
  );

  process.exit(finalCode);
}

/**
 * @description Build the env handed to the hot-mode worker (nodemon → bot).
 *
 * In hot mode the supervisor runs `nodemon` with cwd = projectRoot (it must,
 * to watch `dist/`), and the worker (`node dist/cli.js bot`) inherits that
 * cwd. Left alone the worker would default `WORK_ROOT` to `process.cwd()` =
 * the project checkout, so `/bind` would list folders inside telegram-code
 * instead of the operator's projects parent. We hand the worker the real
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
