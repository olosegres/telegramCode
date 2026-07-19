/**
 * @description Pure decision layer for the agent→Telegram file/image send
 * (`send_file_to_user` MCP tool). Three concerns, all side-effect-free enough to
 * unit-test without Telegraf:
 *   1. {@link resolveSendFileWithinDir} — path-safety: resolve a caller-supplied
 *      path against the topic's bound folder and confirm (realpath + containment)
 *      it points at a REGULAR FILE inside it. Modeled on
 *      `validation.ts:validateSubdir`, but for a file (not a directory) and
 *      returning a discriminated result instead of throwing (the caller surfaces
 *      the error to the agent as an MCP tool error).
 *   2. {@link classifyFileSendKind} — map an extension to how Telegram should
 *      render it (inline photo / autoplay animation / plain document).
 *   3. {@link planFileSend} — decide the single Telegram send method (or album
 *      shape) for 1..10 items, applying the `as_file` override, the photo size
 *      downgrade, and the album photo-vs-document rule. Returns the over-cap /
 *      count violations as an error variant rather than throwing.
 *
 * The only fs touch is the `statSync` inside {@link resolveSendFileWithinDir}
 * (unavoidable for "is this a regular file"); the size byte-counts come from the
 * caller's own `statSync` and are passed into {@link planFileSend} as plain
 * numbers, so the planning math stays pure.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Telegram's inline-photo size cap; a photo-eligible file over this downgrades to a document. */
export const telegramPhotoMaxBytes = 10 * 1024 * 1024;

/** Bot API hard send cap per file; anything over this is rejected, never sent. */
export const telegramSendMaxBytes = 50 * 1024 * 1024;

/** Minimum item count that forms a media-group album (below ⇒ single send). */
export const mediaGroupMin = 2;

/** Maximum item count Telegram accepts in one media-group album. */
export const mediaGroupMax = 10;

/** Telegram caption length cap (characters); longer captions are trimmed. */
export const captionMaxLength = 1024;

/** Extensions rendered as inline photos (lowercased, leading dot). */
export const photoExtensions: readonly string[] = ['.png', '.jpg', '.jpeg', '.webp'];

/** Extensions rendered as looping animations (lowercased, leading dot). */
export const animationExtensions: readonly string[] = ['.gif'];

/**
 * @name FileSendKind
 * @description How Telegram should render a file: inline `photo`, autoplay
 * `animation` (gif), or plain `document`.
 */
export type FileSendKind = 'photo' | 'animation' | 'document';

/**
 * @name ResolveSendFileCode
 * @description Stable failure code for {@link resolveSendFileWithinDir}, so the
 * caller can build a readable, path-naming tool error per case.
 */
export type ResolveSendFileCode =
  | 'INVALID_CHARS'
  | 'OUTSIDE_FOLDER'
  | 'NOT_FOUND'
  | 'NOT_A_FILE';

/**
 * @name ResolveSendFileResult
 * @description Discriminated outcome of resolving a single send path. `ok` carries
 * the safe absolute path; the failure carries a readable message + a stable code.
 */
export type ResolveSendFileResult =
  | { ok: true; absPath: string }
  | { ok: false; error: string; code: ResolveSendFileCode };

/**
 * @description Resolve `rawPath` against the topic's bound `workDir` and confirm
 * it points at a regular file living inside it. Defence-in-depth mirrors
 * `validateSubdir`: reject control chars, NFC-normalise, resolve against the
 * realpath of the root, realpath the candidate, then require strict containment
 * (exact root OR prefix + `path.sep`). The final gate differs: this is for a
 * FILE, so `statSync` must report a regular file (a directory or socket is
 * rejected, not accepted).
 */
export function resolveSendFileWithinDir(workDir: string, rawPath: string): ResolveSendFileResult {
  if (/[\x00-\x1f]/.test(rawPath)) {
    return { ok: false, code: 'INVALID_CHARS', error: `path contains control characters: ${JSON.stringify(rawPath)}` };
  }

  const normalised = rawPath.normalize('NFC').trim();
  if (!normalised) {
    return { ok: false, code: 'INVALID_CHARS', error: 'path is empty' };
  }

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(workDir);
  } catch (e) {
    return { ok: false, code: 'NOT_FOUND', error: `bound folder vanished: ${(e as Error).message}` };
  }

  const candidate = path.resolve(realRoot, normalised);
  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync(candidate);
  } catch {
    return { ok: false, code: 'NOT_FOUND', error: `file not found: ${normalised}` };
  }

  // Strict containment: exact root OR proper prefix with the separator, so a
  // sibling like `<root>_evil` cannot satisfy a bare `startsWith`.
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + path.sep)) {
    return { ok: false, code: 'OUTSIDE_FOLDER', error: `path resolves outside the bound folder: ${normalised}` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realCandidate);
  } catch {
    return { ok: false, code: 'NOT_FOUND', error: `file not found: ${normalised}` };
  }
  if (!stat.isFile()) {
    return { ok: false, code: 'NOT_A_FILE', error: `not a regular file: ${normalised}` };
  }

  return { ok: true, absPath: realCandidate };
}

/**
 * @description Classify a path by its lowercased extension into the Telegram
 * render kind. `.png/.jpg/.jpeg/.webp` → photo; `.gif` → animation; anything
 * else → document.
 */
export function classifyFileSendKind(filePath: string): FileSendKind {
  const ext = path.extname(filePath).toLowerCase();
  if (photoExtensions.includes(ext)) return 'photo';
  if (animationExtensions.includes(ext)) return 'animation';
  return 'document';
}

/**
 * @description Trim a caption to Telegram's {@link captionMaxLength} cap. Returns
 * `undefined` for an absent/blank caption so callers can omit the field entirely.
 */
export function trimCaption(caption: string | undefined): string | undefined {
  if (caption === undefined) return undefined;
  const trimmed = caption.length > captionMaxLength ? caption.slice(0, captionMaxLength) : caption;
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * @name FileSendItem
 * @description One resolved file the planner reasons about: its safe absolute
 * path, on-disk size, and render kind.
 */
export interface FileSendItem {
  absPath: string;
  sizeBytes: number;
  kind: FileSendKind;
}

/**
 * @name FileSendPlan
 * @description Discriminated send plan:
 *  - `kind: 'send'` — one file via a single Telegram method (`mode`).
 *  - `kind: 'album'` — 2..10 files via `sendMediaGroup`, either all photos or
 *    all documents (`mode`).
 *  - `kind: 'error'` — a count/size violation; `error` names the offending file.
 */
export type FileSendPlan =
  | { kind: 'send'; mode: FileSendKind; item: FileSendItem }
  | { kind: 'album'; mode: 'albumPhoto' | 'albumDocument'; items: FileSendItem[] }
  | { kind: 'error'; error: string };

/** First item over the hard send cap, or `null` if all are within it. */
function findOversizeItem(items: FileSendItem[]): FileSendItem | null {
  for (const item of items) {
    if (item.sizeBytes > telegramSendMaxBytes) return item;
  }
  return null;
}

/**
 * @description Decide how to deliver 1..10 resolved files.
 *
 * Single file: the method is the item's kind, with two overrides —
 *  - `asFile` forces `document` (for photo AND animation), and
 *  - a photo over {@link telegramPhotoMaxBytes} downgrades to `document` so it
 *    still goes through (just not inline).
 *
 * Album (2..10): `albumPhoto` only when EVERY item is a photo, `!asFile`, and
 * each within the photo cap; otherwise `albumDocument` (gifs included — a media
 * group cannot carry animation items, so a gif rides as a document in an album
 * and only autoplays when sent alone).
 *
 * Returns an `error` plan for 0 items, >{@link mediaGroupMax}, or any item over
 * {@link telegramSendMaxBytes}.
 */
export function planFileSend(items: FileSendItem[], asFile: boolean): FileSendPlan {
  if (items.length === 0) {
    return { kind: 'error', error: 'no files to send' };
  }
  if (items.length > mediaGroupMax) {
    return { kind: 'error', error: `too many files: ${items.length} (max ${mediaGroupMax})` };
  }

  const oversize = findOversizeItem(items);
  if (oversize) {
    const mb = (telegramSendMaxBytes / (1024 * 1024)).toString();
    return { kind: 'error', error: `file exceeds the ${mb} MB send limit: ${oversize.absPath}` };
  }

  if (items.length < mediaGroupMin) {
    const item = items[0];
    let mode: FileSendKind = item.kind;
    if (asFile) {
      mode = 'document';
    } else if (item.kind === 'photo' && item.sizeBytes > telegramPhotoMaxBytes) {
      // Too big for an inline photo → still deliver, as a document.
      mode = 'document';
    }
    return { kind: 'send', mode, item };
  }

  const allPhotoEligible =
    !asFile && items.every((item) => item.kind === 'photo' && item.sizeBytes <= telegramPhotoMaxBytes);
  return {
    kind: 'album',
    mode: allPhotoEligible ? 'albumPhoto' : 'albumDocument',
    items,
  };
}
