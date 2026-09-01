/**
 * @description Pure decision layer for the agent→Telegram file/image send
 * (`send_file_to_user` MCP tool). Four concerns, all side-effect-free enough to
 * unit-test without booting Telegraf:
 *   1. {@link resolveSendFileWithinDir} — path-safety: resolve a caller-supplied
 *      path against the topic's bound folder and confirm (realpath + containment)
 *      it points at a REGULAR FILE inside it. Modeled on
 *      `validation.ts:validateSubdir`, but for a file (not a directory) and
 *      returning a discriminated result instead of throwing (the caller surfaces
 *      the error to the agent as an MCP tool error).
 *   2. {@link classifyFileSendKind} — map an extension to how Telegram should
 *      render it (inline photo / autoplay animation / inline video / plain document).
 *   3. {@link planFileSend} — decide the single Telegram send method (or album
 *      shape) for 1..10 items, applying the `as_file` override, the photo size
 *      downgrade, and the album photo/video-vs-document rule. Returns the
 *      over-cap / count violations as an error variant rather than throwing.
 *   4. {@link buildTelegramFileSendRequest} — turn a non-error plan into the
 *      exact typed Bot API request shape, including caption placement.
 *
 * The only fs touch is the bigint `statSync` inside
 * {@link resolveSendFileWithinDir} (unavoidable for the regular-file and
 * identity gates). The caller supplies owned descriptor snapshots, so planning
 * and request construction never carry workspace paths into Telegraf.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveCanonicalPathContainment } from './canonicalPathContainment';

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

/** Extensions rendered with Telegram's native streaming video player. */
export const videoExtensions: readonly string[] = ['.mp4'];

/** Characters that cannot safely appear in a quoted multipart filename parameter. */
const telegramUploadFilenameUnsafeCharacters = /[\x00-\x1f\x7f"\\]/g;

/**
 * @name FileSendKind
 * @description How Telegram should render a file: inline `photo`, autoplay
 * `animation` (gif), native `video`, or plain `document`.
 */
export type FileSendKind = 'photo' | 'animation' | 'video' | 'document';

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

/** Device/inode identity captured during canonical-path validation. */
export interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

/**
 * @name ResolveSendFileResult
 * @description Discriminated outcome of resolving a single send path. `ok` carries
 * the safe absolute path, its canonical root, and file identity; the failure
 * carries a readable message + a stable code.
 */
export type ResolveSendFileResult =
  | { ok: true; absPath: string; rootPath: string; identity: FileIdentity }
  | { ok: false; error: string; code: ResolveSendFileCode };

/**
 * @description Resolve `rawPath` against the topic's bound `workDir` and confirm
 * it points at a regular file living inside it. A multi-file caller supplies
 * `pinnedRootPath` after the first item so a replaced binding cannot become a
 * new trusted root between album items. Defence-in-depth mirrors
 * `validateSubdir`: reject control chars, NFC-normalise, canonicalize the root,
 * then use the shared canonical candidate containment gate. The final gate differs: this is for a
 * FILE, so `statSync` must report a regular file (a directory or socket is
 * rejected, not accepted).
 */
export function resolveSendFileWithinDir(
  workDir: string,
  rawPath: string,
  pinnedRootPath?: string,
): ResolveSendFileResult {
  if (/[\x00-\x1f]/.test(rawPath)) {
    return { ok: false, code: 'INVALID_CHARS', error: `path contains control characters: ${JSON.stringify(rawPath)}` };
  }

  const normalised = rawPath.normalize('NFC').trim();
  if (!normalised) {
    return { ok: false, code: 'INVALID_CHARS', error: 'path is empty' };
  }

  let realRoot = pinnedRootPath;
  if (realRoot === undefined) {
    try {
      realRoot = fs.realpathSync(workDir);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'unknown error';
      return { ok: false, code: 'NOT_FOUND', error: `bound folder vanished: ${errorMessage}` };
    }
  }

  let canonicalCandidate: string;
  let isWithinRoot: boolean;
  try {
    ({ canonicalPath: canonicalCandidate, isWithinRoot } =
      resolveCanonicalPathContainment(realRoot, normalised));
  } catch {
    return { ok: false, code: 'NOT_FOUND', error: `file not found: ${normalised}` };
  }

  if (!isWithinRoot) {
    return { ok: false, code: 'OUTSIDE_FOLDER', error: `path resolves outside the bound folder: ${normalised}` };
  }

  let stat: fs.BigIntStats;
  try {
    stat = fs.statSync(canonicalCandidate, { bigint: true });
  } catch {
    return { ok: false, code: 'NOT_FOUND', error: `file not found: ${normalised}` };
  }
  if (!stat.isFile()) {
    return { ok: false, code: 'NOT_A_FILE', error: `not a regular file: ${normalised}` };
  }

  return {
    ok: true,
    absPath: canonicalCandidate,
    rootPath: realRoot,
    identity: { dev: stat.dev, ino: stat.ino },
  };
}

/**
 * @description Classify a path by its lowercased extension into the Telegram
 * render kind. `.png/.jpg/.jpeg/.webp` → photo; `.gif` → animation; `.mp4` →
 * video; anything else → document.
 */
export function classifyFileSendKind(filePath: string): FileSendKind {
  const ext = path.extname(filePath).toLowerCase();
  if (photoExtensions.includes(ext)) return 'photo';
  if (animationExtensions.includes(ext)) return 'animation';
  if (videoExtensions.includes(ext)) return 'video';
  return 'document';
}

/** Derive a multipart-safe filename from a canonical file path. */
export function getTelegramUploadFilename(filePath: string): string {
  return path.basename(filePath).replace(telegramUploadFilenameUnsafeCharacters, '_');
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
 * path, pinned descriptor snapshot, and render kind.
 */
export interface FileSendItem {
  absPath: string;
  source: FileDescriptorSnapshot;
  kind: FileSendKind;
}

/**
 * @name FileSendPlan
 * @description Discriminated send plan:
 *  - `kind: 'send'` — one file via a single Telegram method (`mode`).
 *  - `kind: 'album'` — 2..10 files via `sendMediaGroup`, either native photos /
 *    videos or all documents (`mode`).
 *  - `kind: 'error'` — a count/size violation; `error` names the offending file.
 */
export type FileSendPlan =
  | { kind: 'send'; mode: FileSendKind; item: FileSendItem }
  | { kind: 'album'; mode: 'albumPhotoVideo' | 'albumDocument'; items: FileSendItem[] }
  | { kind: 'error'; error: string };

/** A validated plan that can be converted into a Telegram request. */
export type NonErrorFileSendPlan = Exclude<FileSendPlan, { kind: 'error'; error: string }>;

/** Exact Bot API methods used for one-file sends. */
export type TelegramSingleFileSendMethod =
  | 'sendPhoto'
  | 'sendAnimation'
  | 'sendVideo'
  | 'sendDocument';

/** Owned descriptor snapshot transferred from the reader to the send service. */
export interface FileDescriptorSnapshot {
  fd: number;
  filename: string;
  sizeBytes: number;
}

export interface FileSendPhotoMedia {
  type: 'photo';
  media: FileDescriptorSnapshot;
  caption?: string;
}

export interface FileSendVideoMedia {
  type: 'video';
  media: FileDescriptorSnapshot;
  caption?: string;
}

export interface FileSendDocumentMedia {
  type: 'document';
  media: FileDescriptorSnapshot;
  caption?: string;
}

/** Native photo/video group accepted by the file-send gateway. */
export interface FileSendPhotoVideoMediaGroup {
  kind: 'photoVideo';
  media: Array<FileSendPhotoMedia | FileSendVideoMedia>;
}

/** Homogeneous document group accepted by the file-send gateway. */
export interface FileSendDocumentMediaGroup {
  kind: 'document';
  media: FileSendDocumentMedia[];
}

/** Project-owned media group; the discriminant preserves Bot API homogeneity. */
export type FileSendMediaGroup = FileSendPhotoVideoMediaGroup | FileSendDocumentMediaGroup;

/** One-file request ready for `bot.telegram[method]`, apart from thread routing. */
export interface TelegramSingleFileSendRequest {
  method: TelegramSingleFileSendMethod;
  source: FileDescriptorSnapshot;
  caption?: string;
}

/** Photo/video media-group request preserving each eligible item's native type. */
export interface TelegramPhotoVideoAlbumRequest {
  method: 'sendMediaGroup';
  mediaGroup: FileSendPhotoVideoMediaGroup;
}

/** Document media-group request used for every whole-album fallback. */
export interface TelegramDocumentAlbumRequest {
  method: 'sendMediaGroup';
  mediaGroup: FileSendDocumentMediaGroup;
}

/** Exact Telegram request built from a non-error file-send plan. */
export type TelegramFileSendRequest =
  | TelegramSingleFileSendRequest
  | TelegramPhotoVideoAlbumRequest
  | TelegramDocumentAlbumRequest;

const telegramSingleFileSendMethods: Record<FileSendKind, TelegramSingleFileSendMethod> = {
  photo: 'sendPhoto',
  animation: 'sendAnimation',
  video: 'sendVideo',
  document: 'sendDocument',
};

interface TelegramAlbumMediaInput {
  media: FileDescriptorSnapshot;
  caption?: string;
}

/** Build one media-group entry's shared source/caption fields. */
function buildTelegramAlbumMediaInput(
  item: FileSendItem,
  index: number,
  caption: string | undefined,
): TelegramAlbumMediaInput {
  return {
    media: item.source,
    ...(index === 0 && caption !== undefined ? { caption } : {}),
  };
}

/**
 * @description Convert a non-error plan into the exact Telegram request the bot
 * executes. Captions are trimmed here and included on a single request or only
 * the first media-group entry. `albumPhotoVideo` accepts only photo/video items;
 * an impossible hand-built plan throws a path-naming error instead of silently
 * sending another kind as a photo.
 */
export function buildTelegramFileSendRequest(
  plan: NonErrorFileSendPlan,
  caption?: string,
): TelegramFileSendRequest {
  const trimmedCaption = trimCaption(caption);

  if (plan.kind === 'send') {
    return {
      method: telegramSingleFileSendMethods[plan.mode],
      source: plan.item.source,
      ...(trimmedCaption !== undefined ? { caption: trimmedCaption } : {}),
    };
  }

  if (plan.mode === 'albumDocument') {
    const media: FileSendDocumentMedia[] = plan.items.map((item, index) => ({
      type: 'document',
      ...buildTelegramAlbumMediaInput(item, index, trimmedCaption),
    }));
    return { method: 'sendMediaGroup', mediaGroup: { kind: 'document', media } };
  }

  const media = plan.items.map((item, index): FileSendPhotoMedia | FileSendVideoMedia => {
    const mediaInput = buildTelegramAlbumMediaInput(item, index, trimmedCaption);
    if (item.kind === 'photo') return { type: 'photo', ...mediaInput };
    if (item.kind === 'video') return { type: 'video', ...mediaInput };
    throw new Error(`albumPhotoVideo cannot contain ${item.kind}: ${item.absPath}`);
  });
  return { method: 'sendMediaGroup', mediaGroup: { kind: 'photoVideo', media } };
}

/** First item over the hard send cap, or `null` if all are within it. */
function findOversizeItem(items: FileSendItem[]): FileSendItem | null {
  for (const item of items) {
    if (item.source.sizeBytes > telegramSendMaxBytes) return item;
  }
  return null;
}

/** Existing user-facing hard-cap error shared by planning and snapshot reads. */
export function getTelegramFileOversizeError(absPath: string): string {
  const mb = (telegramSendMaxBytes / (1024 * 1024)).toString();
  return `file exceeds the ${mb} MB send limit: ${absPath}`;
}

/** Existing user-facing item-count validation shared by planning and the reader. */
export function getFileSendCountError(itemCount: number): string | null {
  if (itemCount === 0) return 'no files to send';
  if (itemCount > mediaGroupMax) {
    return `too many files: ${itemCount} (max ${mediaGroupMax})`;
  }
  return null;
}

/**
 * @description Decide how to deliver 1..10 resolved files.
 *
 * Single file: the method is the item's kind, with two overrides —
 *  - `asFile` forces `document` for every kind, and
 *  - a photo over {@link telegramPhotoMaxBytes} downgrades to `document` so it
 *    still goes through (just not inline).
 *
 * Album (2..10): `albumPhotoVideo` when `!asFile` and EVERY item is either a
 * video or a photo within the photo cap, preserving each item's native media
 * type in all-photo, all-video, and mixed photo/video groups. Otherwise use
 * `albumDocument` (animations/documents and over-cap photos included — a media
 * group cannot carry animation items, so a gif rides as a document in an album
 * and only autoplays when sent alone).
 *
 * Returns an `error` plan for 0 items, >{@link mediaGroupMax}, or any item over
 * {@link telegramSendMaxBytes}.
 */
export function planFileSend(items: FileSendItem[], asFile: boolean): FileSendPlan {
  const countError = getFileSendCountError(items.length);
  if (countError !== null) return { kind: 'error', error: countError };

  const oversize = findOversizeItem(items);
  if (oversize) {
    return { kind: 'error', error: getTelegramFileOversizeError(oversize.absPath) };
  }

  if (items.length < mediaGroupMin) {
    const item = items[0];
    let mode: FileSendKind = item.kind;
    if (asFile) {
      mode = 'document';
    } else if (item.kind === 'photo' && item.source.sizeBytes > telegramPhotoMaxBytes) {
      // Too big for an inline photo → still deliver, as a document.
      mode = 'document';
    }
    return { kind: 'send', mode, item };
  }

  const allPhotoVideoEligible =
    !asFile &&
    items.every(
      (item) =>
        item.kind === 'video' ||
        (item.kind === 'photo' && item.source.sizeBytes <= telegramPhotoMaxBytes),
    );
  return {
    kind: 'album',
    mode: allPhotoVideoEligible ? 'albumPhotoVideo' : 'albumDocument',
    items,
  };
}
