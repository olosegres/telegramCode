/**
 * @description Path-traversal-safe validation of user-supplied `subdir`
 * arguments to `/bind` and friends. Extracted from `src/bot.ts` so that
 * the security-critical logic can be unit-tested without spinning up the
 * whole Telegraf surface (plan §11 Этап 7, R3).
 *
 * The exported `validateSubdir(workRoot, rawSubdir)` returns the *relative*
 * form of the resolved path (so on-disk records survive a `WORK_ROOT`
 * rename) and throws a `BindError` whose `.code` lets callers map to a
 * localised reply string.
 *
 * Defence-in-depth covers four classes of attack:
 *  - **Path traversal** — strict equality OR prefix-with-separator check
 *    after `realpathSync`. Without the trailing `path.sep`, an attacker
 *    pointing `WORK_ROOT=/work_root` could bind `../work_root_evil` and
 *    `startsWith` would happily accept it.
 *  - **Symlink-out** — `realpathSync` on both the root and the candidate
 *    resolves every symlink before the prefix check, so a symlink inside
 *    `WORK_ROOT` pointing at `/etc` is rejected.
 *  - **Control chars / NUL** — many filesystems happily store these; tmux
 *    and shell-quoting downstream do not. Reject up front.
 *  - **Unicode NFC drift** — macOS Terminal sends NFD by default while
 *    the on-disk entry is usually NFC. Normalise the input to NFC before
 *    `path.resolve` so the realpath lookup actually finds it.
 *
 * Plan §13.7 / D35 / R3.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * @description Error class with a stable `code` field so the bot can map
 * each failure mode to a localised reply (`i18n.ts → bind.*`) without
 * pattern-matching error messages.
 */
export class BindError extends Error {
  constructor(public readonly code: BindErrorCode, message: string) {
    super(message);
    this.name = 'BindError';
  }
}

export type BindErrorCode =
  | 'BIND_INVALID_CHARS'
  | 'BIND_NOT_FOUND'
  | 'BIND_OUTSIDE_ROOT'
  | 'BIND_NOT_DIRECTORY';

/**
 * @description Resolve `rawSubdir` against `workRoot` and confirm it
 * actually lives inside it. Returns the *relative* form (e.g. `"overview"`)
 * so persisted bindings survive a `WORK_ROOT` path change such as a host
 * mount rename. Throws `BindError` on every failure mode the caller needs
 * to distinguish.
 */
export function validateSubdir(workRoot: string, rawSubdir: string): string {
  // Control chars and NUL bytes can be stored on disk but explode in
  // shell-quoted paths downstream (tmux send-keys, opencode HTTP URLs).
  // Reject up front so the failure mode is a localised reply, not a
  // confusing tmux error.
  if (/[\x00-\x1f]/.test(rawSubdir)) {
    throw new BindError('BIND_INVALID_CHARS', 'subdir contains control characters');
  }

  // Normalise to NFC — input from macOS Terminal often arrives NFD, but
  // the on-disk entry was created NFC, so naive string compare misses it
  // and realpathSync would throw ENOENT.
  const normalised = rawSubdir.normalize('NFC').trim();
  if (!normalised) {
    throw new BindError('BIND_INVALID_CHARS', 'subdir is empty');
  }

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(workRoot);
  } catch (e) {
    // The boot-time check already verified workRoot exists; treat this
    // as a transient (e.g. user removed it after start) and translate
    // to a not-found error so the caller reports a localised message
    // rather than a stack trace.
    throw new BindError('BIND_NOT_FOUND', `WORK_ROOT vanished: ${(e as Error).message}`);
  }

  const candidate = path.resolve(realRoot, normalised);
  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync(candidate);
  } catch {
    throw new BindError('BIND_NOT_FOUND', `subdir not found: ${normalised}`);
  }

  // Strict containment: exact equality OR proper prefix with the platform
  // separator appended. Without the separator, `/work_root_evil` would
  // satisfy `startsWith('/work_root')` — classic traversal trap.
  if (
    realCandidate !== realRoot &&
    !realCandidate.startsWith(realRoot + path.sep)
  ) {
    throw new BindError('BIND_OUTSIDE_ROOT', `subdir resolves outside WORK_ROOT: ${realCandidate}`);
  }

  // Reject /bind . — binding to WORK_ROOT itself is exactly the unbound
  // state we just spent the whole stage stopping users from sliding into.
  // It also has no meaningful project context (no CLAUDE.md / .git scope).
  if (realCandidate === realRoot) {
    throw new BindError('BIND_OUTSIDE_ROOT', 'cannot bind to WORK_ROOT itself; pick a subfolder');
  }

  const stat = fs.statSync(realCandidate);
  if (!stat.isDirectory()) {
    throw new BindError('BIND_NOT_DIRECTORY', `${normalised} is not a directory`);
  }

  // Store the *relative* form so the on-disk record survives `WORK_ROOT`
  // path changes (e.g. mount point rename). `getWorkDir` re-joins this
  // with the current `ENV.workRoot` at runtime.
  return path.relative(realRoot, realCandidate);
}
