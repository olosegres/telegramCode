import * as fs from 'fs';
import { loadEnvFiles } from './envLoader';
import { acquireLock, installLockCleanupHandlers } from './lock';
import { resolveDataDir } from '../state';
import { installConsoleFileTap } from '../utils/consoleFileTap';

/**
 * @description Shared bot startup used by the public no-arg CLI and the
 * internal hot-worker entry.
 *
 * Responsibilities executed in order:
 *
 *   1. Load `.env` files (global, then local override). Must happen BEFORE
 *      the bot module is imported, because `src/bot.ts` reads many
 *      `process.env.*` values at top-level (TELEGRAM_BOT_TOKEN, WORK_ROOT,
 *      ALLOWED_GROUP_ID, etc.).
 *   2. Default `WORK_ROOT` to `process.cwd()` if still unset. This is the
 *      normal path: start `telegramcode` from the parent folder containing
 *      the projects/topics you want to bind.
 *   3. Validate `WORK_ROOT` resolves to an existing directory — fail fast
 *      with a clear message if not.
 *   4. Acquire the single-instance lock and wire cleanup handlers.
 *   5. Dynamically import `../bot` (which reads env at module scope) and
 *      call `startBot()`.
 *
 * The dynamic import in step 5 is deliberate: a static `import` at the top
 * of this file would resolve `process.env` at module-load time, before
 * `loadEnvFiles()` ran, and we'd see undefined tokens. `await import(...)`
 * defers binding until after env is populated.
 */
export async function runBot(): Promise<void> {
  const { loaded } = loadEnvFiles();

  // Tee stdout/stderr to an hourly bucket file under DATA_DIR as EARLY as
  // possible (right after env load, so DATA_DIR from .env is honoured) — boot
  // logs below this line are captured for post-incident reading, terminal view
  // preserved. Best-effort; never throws into a write.
  installConsoleFileTap(resolveDataDir());

  if (loaded.length === 0) {
    process.stderr.write(
      `Warning: no .env file found in $PWD or ~/.config/telegramcode/. ` +
        `Required env (TELEGRAM_BOT_TOKEN) ` +
        `must come from the shell instead. ALLOWED_GROUP_ID is optional ` +
        `(auto-pairs on first contact if unset; access = the group's admins).\n`,
    );
  }

  if (!process.env.WORK_ROOT) {
    process.env.WORK_ROOT = process.cwd();
    process.stderr.write(
      `Using $PWD as WORK_ROOT: ${process.env.WORK_ROOT}\n`,
    );
  }
  const wr = process.env.WORK_ROOT;
  if (!fs.existsSync(wr) || !fs.statSync(wr).isDirectory()) {
    process.stderr.write(
      `WORK_ROOT does not exist or is not a directory: ${wr}\n`,
    );
    process.exit(1);
  }

  await acquireLock();
  installLockCleanupHandlers();

  // Lazy import so env is fully populated before the bot module's top-level
  // `process.env.*` reads run. See file-level docstring for rationale.
  const { startBot } = await import('../bot');
  await startBot();
}
