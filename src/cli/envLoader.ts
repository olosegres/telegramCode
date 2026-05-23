import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as dotenv from 'dotenv';

/**
 * @description Path to the per-user global config file
 * (`~/.config/telegram-code/.env`).
 *
 * Lifted as a constant so tests can spy on it via the home-dir override.
 * Resolved lazily per call — tests may swap `HOME` between cases.
 */
export function globalEnvPath(): string {
  return path.join(os.homedir(), '.config', 'telegram-code', '.env');
}

/** @description Path to the local `$PWD/.env`. */
export function localEnvPath(): string {
  return path.join(process.cwd(), '.env');
}

/**
 * @description Load environment from the wrapper's two well-known locations.
 *
 * Order is **global first, local second** so that `dotenv.config({ override: true })`
 * on the local file gives `$PWD/.env` last-write-wins semantics over the global.
 * Both files are optional; if neither exists this is a no-op.
 *
 * The first load uses `override: false` so that variables already in
 * `process.env` (set by the user's shell, systemd, etc.) win against the
 * global file — matching how `dotenv/config` behaves today. The local file
 * then forces an override only for keys it explicitly sets.
 *
 * Returns the list of paths actually read, in load order. Useful for the
 * `telegramCode` startup banner and for test assertions.
 */
export function loadEnvFiles(): { loaded: string[] } {
  const loaded: string[] = [];

  const globalPath = globalEnvPath();
  if (fs.existsSync(globalPath)) {
    dotenv.config({ path: globalPath, override: false });
    loaded.push(globalPath);
  }

  const localPath = localEnvPath();
  if (fs.existsSync(localPath)) {
    dotenv.config({ path: localPath, override: true });
    loaded.push(localPath);
  }

  return { loaded };
}
