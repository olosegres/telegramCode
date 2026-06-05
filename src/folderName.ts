/**
 * @description Pure validation for a user-supplied NEW folder name typed
 * into the `/bind` create-folder flow.
 *
 * This is deliberately distinct from `validateSubdir` in `validation.ts`:
 * that helper resolves an EXISTING path via `realpathSync` and throws
 * `BIND_NOT_FOUND` for anything not yet on disk. Here the folder does not
 * exist yet — we only check the name is safe to `mkdir` directly under
 * `WORK_ROOT` (no traversal, no nesting, no control chars). After the
 * directory is created the caller routes through `applyBinding`, which
 * re-validates the now-existing folder with the full path-traversal /
 * symlink-out defence — so this check is the FIRST gate, not the only one.
 *
 * Rejected up front:
 *  - empty / whitespace-only
 *  - any path separator (`/` or `\`) — a new folder is a single immediate
 *    child of WORK_ROOT, not a nested path
 *  - `.` / `..` — current/parent dir references
 *  - leading `.` — hidden folders are filtered out of the picker anyway and
 *    are almost never an intended project root
 *  - control chars / NUL — explode in tmux send-keys / opencode URLs
 */

/** Outcome of validating a typed new-folder name before `mkdir`. */
export type NewFolderNameResult =
  | { ok: true; name: string }
  | { ok: false; reason: NewFolderNameError };

/**
 * @name NewFolderNameError
 * @description Why a typed new-folder name was rejected, so the bot can map
 * each case to a localised reply without pattern-matching strings.
 */
export type NewFolderNameError =
  | 'empty'
  | 'separator'
  | 'dot_segment'
  | 'hidden'
  | 'invalid_chars';

/**
 * @description Validate a name typed for a brand-new folder to create under
 * WORK_ROOT. Returns the NFC-normalised, trimmed name on success.
 */
export function validateNewFolderName(rawName: string): NewFolderNameResult {
  // Control chars and NUL bytes can be stored on disk but break shell-quoted
  // paths downstream (tmux send-keys, opencode HTTP URLs).
  if (/[\x00-\x1f]/.test(rawName)) {
    return { ok: false, reason: 'invalid_chars' };
  }

  const name = rawName.normalize('NFC').trim();
  if (!name) {
    return { ok: false, reason: 'empty' };
  }
  if (name.includes('/') || name.includes('\\')) {
    return { ok: false, reason: 'separator' };
  }
  if (name === '.' || name === '..') {
    return { ok: false, reason: 'dot_segment' };
  }
  if (name.startsWith('.')) {
    return { ok: false, reason: 'hidden' };
  }
  return { ok: true, name };
}
