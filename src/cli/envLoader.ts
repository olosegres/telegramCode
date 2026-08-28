import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as dotenv from 'dotenv';

/** Canonical per-user config dir name under `~/.config` (post-rename). */
const configDirName = 'telegramcode';
/**
 * Pre-rename config dir name — still honoured as a fallback so installs
 * that predate the `telegramcode` rename keep working without moving files.
 */
const legacyConfigDirName = 'telegram-code';

function buildGlobalEnvPath(dirName: string): string {
  return path.join(os.homedir(), '.config', dirName, '.env');
}

/**
 * @description Path to the per-user global config file.
 *
 * Prefers the canonical `~/.config/telegramcode/.env`; falls back to the
 * legacy `~/.config/telegram-code/.env` when only that one exists. When
 * neither exists the canonical path is returned, so callers report the
 * location a fresh install should use.
 *
 * Resolved lazily per call — tests may swap `HOME` between cases.
 */
export function globalEnvPath(): string {
  const canonicalPath = buildGlobalEnvPath(configDirName);
  if (fs.existsSync(canonicalPath)) return canonicalPath;
  const legacyPath = buildGlobalEnvPath(legacyConfigDirName);
  if (fs.existsSync(legacyPath)) return legacyPath;
  return canonicalPath;
}

/** @description Path to the local `.env` for a supplied directory (defaults to `$PWD`). */
export function localEnvPath(localDirectory = process.cwd()): string {
  return path.join(localDirectory, '.env');
}

/**
 * @description Load environment from the wrapper's two well-known locations.
 *
 * Order is **global first, local second** so that `dotenv.config({ override: true })`
 * on the local file gives `<localDirectory>/.env` last-write-wins semantics over
 * the global. Both files are optional; if neither exists this is a no-op. The
 * explicit directory lets a supervisor load its worker's project config without
 * changing the operator-facing process cwd.
 *
 * The first load uses `override: false` so that variables already in
 * `process.env` (set by the user's shell, systemd, etc.) win against the
 * global file — matching how `dotenv/config` behaves today. The local file
 * then forces an override only for keys it explicitly sets.
 *
 * Returns the list of paths actually read, in load order. Useful for the
 * `telegramcode` startup banner and for test assertions.
 */
export function loadEnvFiles(localDirectory = process.cwd()): { loaded: string[] } {
  const loaded: string[] = [];

  const globalPath = globalEnvPath();
  if (fs.existsSync(globalPath)) {
    dotenv.config({ path: globalPath, override: false });
    loaded.push(globalPath);
    if (globalPath === buildGlobalEnvPath(legacyConfigDirName)) {
      process.stderr.write(
        `Using legacy config ${globalPath} — preferred location: ` +
          `~/.config/${configDirName}/.env\n`,
      );
    }
  }

  const localPath = localEnvPath(localDirectory);
  if (fs.existsSync(localPath)) {
    dotenv.config({ path: localPath, override: true });
    loaded.push(localPath);
  }

  return { loaded };
}
