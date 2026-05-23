import * as fs from 'fs';
import { loadEnvFiles } from './envLoader';
import { acquireLock, installLockCleanupHandlers } from './lock';

/**
 * @description Wrapper-entry for the `telegramCode` / `telegramCode bot` form.
 *
 * Responsibilities executed in order:
 *
 *   1. Load `.env` files (global, then local override). Must happen BEFORE
 *      the bot module is imported, because `src/bot.ts` reads many
 *      `process.env.*` values at top-level (TELEGRAM_BOT_TOKEN, WORK_ROOT,
 *      ALLOWED_*, etc.).
 *   2. Default `WORK_ROOT` to `process.cwd()` if still unset, with a stderr
 *      warning so the user knows what happened. This replaces the historical
 *      fatal error at `src/bot.ts:101-103`.
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
  if (loaded.length === 0) {
    process.stderr.write(
      `Warning: no .env file found in $PWD or ~/.config/telegram-code/. ` +
        `Required env (TELEGRAM_BOT_TOKEN, ALLOWED_USERS, ALLOWED_GROUP_ID) ` +
        `must come from the shell instead.\n`,
    );
  }

  if (!process.env.WORK_ROOT) {
    process.env.WORK_ROOT = process.cwd();
    process.stderr.write(
      `WORK_ROOT not set, defaulting to $PWD = ${process.env.WORK_ROOT}\n`,
    );
  }
  const wr = process.env.WORK_ROOT;
  if (!fs.existsSync(wr) || !fs.statSync(wr).isDirectory()) {
    process.stderr.write(
      `WORK_ROOT does not exist or is not a directory: ${wr}\n`,
    );
    process.exit(1);
  }

  acquireLock();
  installLockCleanupHandlers();

  // Lazy import so env is fully populated before the bot module's top-level
  // `process.env.*` reads run. See file-level docstring for rationale.
  const { startBot } = await import('../bot');
  await startBot();
}
