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

export type BoundWorkDirDecision =
  | { kind: 'proceed'; subdir: string; workDir: string }
  | { kind: 'refuse' }
  | { kind: 'invalid'; error: BindError };

/**
 * @description Resolve a persisted binding back to a real working directory.
 * A binding row in state.json is not enough: the folder may have been deleted
 * or replaced after `/bind`. Agent startup/list/resume must fail before any
 * adapter side effects in that case.
 */
export function resolveBoundWorkDir(
  workRoot: string,
  binding: { subdir: string } | null,
): BoundWorkDirDecision {
  if (!binding) return { kind: 'refuse' };
  try {
    const subdir = validateSubdir(workRoot, binding.subdir);
    return { kind: 'proceed', subdir, workDir: fs.realpathSync(path.resolve(workRoot, subdir)) };
  } catch (e) {
    if (e instanceof BindError) return { kind: 'invalid', error: e };
    throw e;
  }
}

/**
 * @description Normalise a name (topic title or subdir) for fuzzy auto-bind
 * matching.
 *
 * Folds three predictable drifts between Telegram topic titles and on-disk
 * folder names:
 *   - case: `Overview` ↔ `overview`
 *   - separator: `my-api` ↔ `my_api` ↔ `my api` ↔ `my.api`
 *   - edge whitespace: `  overview  ` ↔ `overview`
 *
 * NFC normalisation runs first so macOS-flavoured NFD doesn't slip past
 * the separator collapse.
 *
 * Anything more aggressive (typo tolerance, partial matches) is
 * intentionally out of scope — auto-bind has to stay predictable; if it
 * starts guessing the user loses trust in the rule.
 *
 * Plan §11 Этап 7 polish (smart auto-bind fuzzy, §20.10).
 */
export function normaliseTopicName(s: string): string {
  return s.normalize('NFC').toLowerCase().trim().replace(/[\s._-]+/g, '-');
}

/**
 * @description Find the on-disk subdir whose normalised name matches the
 * normalised topic title. Returns `null` if no match (auto-bind falls
 * through to the picker UX).
 *
 * Caller is expected to have already filtered `subdirs` to the entries
 * surfaced in the UI — `listAvailableSubdirs` does that.
 */
export function findAutobindSubdir(
  topicName: string,
  subdirs: readonly string[],
): string | null {
  const normalisedName = normaliseTopicName(topicName);
  if (!normalisedName) return null;
  for (const subdir of subdirs) {
    if (normaliseTopicName(subdir) === normalisedName) return subdir;
  }
  return null;
}

export interface BindPage {
  /** Slice of subdirs visible on the current page. */
  slice: string[];
  /** Resolved page index (`page` clamped to `[0, totalPages-1]`). */
  currentPage: number;
  /** Total number of pages, ≥ 1 even for an empty list. */
  totalPages: number;
}

/**
 * @description Pure pagination math for the `/bind` keyboard. Extracted
 * here so the slice / clamp logic can be unit-tested without booting
 * Telegraf (which is what `buildBindKeyboard` in `bot.ts` wraps it with).
 *
 * Plan §11 Этап 7 polish — pagination kicks in once `listAvailableSubdirs`
 * surfaces more than `pageSize` folders.
 *
 * `pageSize` must be positive; the bot uses `BIND_PAGE_SIZE = 20`. Out-of-
 * range `page` values are clamped silently — a stale callback after the
 * disk state shrank just lands on the last available page.
 */
export function paginateBindList(
  subdirs: readonly string[],
  page: number,
  pageSize: number,
): BindPage {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`paginateBindList: pageSize must be a positive integer, got ${pageSize}`);
  }
  const totalPages = Math.max(1, Math.ceil(subdirs.length / pageSize));
  const clampedPage = Math.max(0, Math.min(Math.floor(page) || 0, totalPages - 1));
  const start = clampedPage * pageSize;
  return {
    slice: subdirs.slice(start, start + pageSize),
    currentPage: clampedPage,
    totalPages,
  };
}
