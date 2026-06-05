/**
 * @description Pure helpers for the Telegram → agent file-intake feature.
 *
 * A file sent to a bound, agent-active topic is downloaded into a bot-owned
 * per-thread dir and announced to the agent through the normal prompt funnel.
 * This module holds the side-effect-free pieces so they can be unit-tested
 * without booting Telegraf or touching the disk:
 *
 *   - {@link getTelegramFileMeta} — normalise the six supported media types
 *     (photo, document, video, video_note, audio, animation) into a flat
 *     {@link TelegramFileMeta}. Voice is intentionally NOT handled here — it
 *     stays on the existing transcription path.
 *   - {@link buildSavedFileName} — derive a safe on-disk filename
 *     (`<unixSeconds>-<fileUniqueId>-<sanitizedName>`), sanitising the
 *     Telegram-provided original name (basename only, no separators / control
 *     chars, length-capped).
 *   - {@link buildFilePromptText} — render the agent-facing English
 *     announcement line (plus the caption, if any), matching the
 *     thread-context-preamble style.
 *   - {@link checkIsFileTooBig} — compare a known file size against the Bot
 *     API download cap before we even call `getFile`.
 *
 * All magic numbers / strings live as named constants below.
 */

import { anyOf, message } from 'telegraf/filters';
import type { Message } from 'telegraf/typings/core/types/typegram';

/**
 * @name TelegramFileKind
 * @description The six media kinds we ingest. Mirrors the Telegram message
 * field name so the kind reads naturally in the agent announcement line and
 * maps 1:1 to the `bot.on(message(<kind>))` filters that produce it.
 */
export type TelegramFileKind =
  | 'photo'
  | 'document'
  | 'video'
  | 'video_note'
  | 'audio'
  | 'animation';

/**
 * @description Update-level filter for the media handler. CRITICAL nuance
 * (user-caught live: a photo got ZERO reaction): Telegraf's
 * `message('photo', 'document', …)` is an AND filter — it matches only
 * messages carrying ALL listed fields, which no real media message does. The
 * correct composition is `anyOf(message(kind), …)` — one filter per kind,
 * OR'd. Exported from this module (telegraf/filters is pure, no side
 * effects) so the OR semantics are unit-testable against real update shapes
 * — the exact filter `bot.on` uses, not a copy.
 */
export const incomingFileMessageFilter = anyOf(
  message('photo'),
  message('document'),
  message('video'),
  message('video_note'),
  message('audio'),
  message('animation'),
);

/**
 * @description Normalised, backend-agnostic view of an inbound media message.
 * `fileName` / `fileSize` / `caption` are optional because Telegram doesn't
 * always supply them (photos and video notes carry no original name; size is
 * occasionally absent).
 */
export interface TelegramFileMeta {
  /** Telegram `file_id` — the handle passed to `getFile` / `getFileLink`. */
  fileId: string;
  /**
   * Telegram `file_unique_id` — stable across bots / time, used in the saved
   * filename so re-sends of the same file are recognisable and collisions are
   * avoided without leaking the (bot-scoped, reusable) `file_id`.
   */
  fileUniqueId: string;
  /** Which media kind produced this meta. */
  kind: TelegramFileKind;
  /** Original filename when Telegram provides one (documents/audio/video/animation). */
  fileName?: string;
  /** Size in bytes when known — lets us reject over-cap files before download. */
  fileSize?: number;
  /** Caption text accompanying the media, if any. */
  caption?: string;
}

/**
 * Bot API hard cap for downloading a file via `getFile` (20 MB). Files larger
 * than this fail with a 400 "file is too big" — we surface that to the user as
 * a friendly error instead of a stack trace.
 */
export const telegramFileDownloadCapBytes = 20 * 1024 * 1024;

/**
 * Max length of the sanitized original-name segment kept in the saved
 * filename. Caps total path length and blunts pathological 255-char names;
 * the `<ts>-<uniqueId>-` prefix already guarantees uniqueness, so the name is
 * only a human hint.
 */
const savedFileNameMaxNameChars = 64;

/** Fallback extension per kind when Telegram gives us no original filename. */
const fallbackExtensionByKind: Record<TelegramFileKind, string> = {
  photo: 'jpg',
  document: 'bin',
  video: 'mp4',
  video_note: 'mp4',
  audio: 'mp3',
  animation: 'mp4',
};

/**
 * @description Extract a normalised {@link TelegramFileMeta} from an inbound
 * message, or `null` if the message carries none of the six supported media
 * kinds (e.g. plain text, voice, sticker).
 *
 * Order matters for `animation`: Telegram sets BOTH `animation` and
 * `document` on an animation message (documented backward-compat), so we test
 * `animation` first to classify it as the more specific kind.
 *
 * For photos we take the LAST `PhotoSize` — Telegram orders the array
 * smallest→largest, so the last entry is the highest resolution available.
 */
export function getTelegramFileMeta(message: Message): TelegramFileMeta | null {
  if ('animation' in message && message.animation) {
    const { animation } = message;
    return {
      fileId: animation.file_id,
      fileUniqueId: animation.file_unique_id,
      kind: 'animation',
      fileName: animation.file_name,
      fileSize: animation.file_size,
      caption: message.caption,
    };
  }
  if ('photo' in message && message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    return {
      fileId: largest.file_id,
      fileUniqueId: largest.file_unique_id,
      kind: 'photo',
      fileSize: largest.file_size,
      caption: message.caption,
    };
  }
  if ('video' in message && message.video) {
    const { video } = message;
    return {
      fileId: video.file_id,
      fileUniqueId: video.file_unique_id,
      kind: 'video',
      fileName: video.file_name,
      fileSize: video.file_size,
      caption: message.caption,
    };
  }
  if ('video_note' in message && message.video_note) {
    const note = message.video_note;
    // Video notes are not captionable in the Bot API — no `caption` field.
    return {
      fileId: note.file_id,
      fileUniqueId: note.file_unique_id,
      kind: 'video_note',
      fileSize: note.file_size,
    };
  }
  if ('audio' in message && message.audio) {
    const { audio } = message;
    return {
      fileId: audio.file_id,
      fileUniqueId: audio.file_unique_id,
      kind: 'audio',
      fileName: audio.file_name,
      fileSize: audio.file_size,
      caption: message.caption,
    };
  }
  if ('document' in message && message.document) {
    const { document } = message;
    return {
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id,
      kind: 'document',
      fileName: document.file_name,
      fileSize: document.file_size,
      caption: message.caption,
    };
  }
  return null;
}

/**
 * @description Extract the `media_group_id` from an inbound message, or
 * `undefined` when the message is not part of an album. Telegram sets this same
 * id on every message of a multi-file album (photos/documents sent together);
 * the bot uses it to batch the burst into one combined prompt. Kept here (next
 * to {@link getTelegramFileMeta}) so the message-shape narrowing stays in one
 * pure, testable place.
 */
export function getMediaGroupId(message: Message): string | undefined {
  if ('media_group_id' in message && typeof message.media_group_id === 'string') {
    return message.media_group_id;
  }
  return undefined;
}

/**
 * @description Sanitise a Telegram-provided original filename into a safe
 * single path segment: basename only (drop any directory parts), control
 * chars and path separators stripped, collapsed to a bounded ASCII-ish slug.
 *
 * Security-critical — the saved path is built from this, so a hostile name
 * like `../../etc/passwd` or `a/b\0c` must never escape the thread dir or
 * smuggle a separator. We keep dots (extensions) but never a leading dot run
 * (so the result can't become `..` or a hidden file).
 *
 * Returns `null` when nothing usable survives sanitisation, so the caller can
 * fall back to a kind-derived extension.
 */
function sanitizeOriginalName(originalName: string): string | null {
  // Basename only — strip everything up to the last separator of either kind.
  const baseName = originalName.split(/[/\\]/).pop() ?? '';
  // Replace any character outside a conservative allow-list (incl. control
  // chars and remaining separators) with `_`, collapse runs, trim edge `_`/`.`.
  const cleaned = baseName
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._]+/, '')
    .replace(/[._]+$/, '');
  if (!cleaned) return null;
  return cleaned.slice(0, savedFileNameMaxNameChars);
}

/**
 * @description Build the on-disk filename for a downloaded file:
 * `<unixSeconds>-<fileUniqueId>-<sanitizedName>`. The timestamp + unique id
 * prefix guarantees uniqueness even when two threads receive the same file or
 * the original name is missing/sanitised away; the name suffix is a human
 * hint and keeps the original extension when one survives.
 *
 * When no usable original name exists (photos, video notes, or a name that
 * sanitised to nothing) we synthesise `<fileUniqueId>.<kindExt>`.
 */
export function buildSavedFileName(
  unixSeconds: number,
  fileUniqueId: string,
  kind: TelegramFileKind,
  originalName?: string,
): string {
  const safeName = originalName ? sanitizeOriginalName(originalName) : null;
  const nameSegment = safeName ?? `${fileUniqueId}.${fallbackExtensionByKind[kind]}`;
  return `${unixSeconds}-${fileUniqueId}-${nameSegment}`;
}

/** Marker line the agent recognises as a bot-injected single-file announcement. */
export const filePromptHeader = '[Telegram file]';

/**
 * Marker line for a bot-injected media-album announcement — sibling of
 * {@link filePromptHeader}. A Telegram album (multiple files in one visual
 * message) is batched into ONE combined prompt under this header instead of N
 * separate single-file prompts (see {@link buildAlbumPromptText}).
 */
export const albumPromptHeader = '[Telegram album]';

/** Threshold below which a byte size renders in KB rather than MB. */
const bytesPerMegabyte = 1024 * 1024;
const bytesPerKilobyte = 1024;

/**
 * @description Human-readable size string for the announcement line (e.g.
 * `1.2 MB`, `840 KB`). Returns an empty string when the size is unknown so the
 * caller can omit the parenthetical.
 */
function formatFileSize(fileSize?: number): string {
  if (fileSize === undefined || fileSize <= 0) return '';
  if (fileSize >= bytesPerMegabyte) {
    return `${(fileSize / bytesPerMegabyte).toFixed(1)} MB`;
  }
  return `${Math.round(fileSize / bytesPerKilobyte)} KB`;
}

/**
 * @description Render the agent-facing prompt text announcing a saved file.
 * Plain English (agent-facing, NOT i18n), same register as the thread-context
 * preamble. The caption, when present, follows on its own line so the agent
 * sees the user's instruction verbatim.
 *
 * Example:
 *   [Telegram file] photo saved to: /…/files/<thread>/<ts>-<id>.jpg (1.2 MB)
 *   what is in this file?
 */
export function buildFilePromptText(
  kind: TelegramFileKind,
  savedPath: string,
  fileSize?: number,
  caption?: string,
): string {
  const sizeText = formatFileSize(fileSize);
  const sizeSuffix = sizeText ? ` (${sizeText})` : '';
  const announcement = `${filePromptHeader} ${kind} saved to: ${savedPath}${sizeSuffix}`;
  const trimmedCaption = caption?.trim();
  return trimmedCaption ? `${announcement}\n${trimmedCaption}` : announcement;
}

/**
 * @description One successfully-saved member of a media album, as fed to
 * {@link buildAlbumPromptText}. Mirrors the single-file announcement inputs
 * (kind / saved path / size); the caption is handled once for the whole album,
 * not per file, so it is not part of this shape.
 */
export interface AlbumFile {
  kind: TelegramFileKind;
  savedPath: string;
  fileSize?: number;
}

/**
 * @description Render the agent-facing prompt for a settled media album: one
 * header line with the file count, then one bullet per saved file (kind + path
 * + size), then the album caption (whichever album item carried it) on its own
 * line. Reuses {@link formatFileSize} — the KB/MB formatting is NOT duplicated.
 *
 * Example:
 *   [Telegram album] 3 files saved:
 *   - photo: /…/a.jpg (1.2 MB)
 *   - photo: /…/b.jpg (900 KB)
 *   - document: /…/c.pdf (40 KB)
 *   <caption>
 */
export function buildAlbumPromptText(files: AlbumFile[], caption?: string): string {
  const headerLine = `${albumPromptHeader} ${files.length} ${files.length === 1 ? 'file' : 'files'} saved:`;
  const bulletLines = files.map((file) => {
    const sizeText = formatFileSize(file.fileSize);
    const sizeSuffix = sizeText ? ` (${sizeText})` : '';
    return `- ${file.kind}: ${file.savedPath}${sizeSuffix}`;
  });
  const lines = [headerLine, ...bulletLines];
  const trimmedCaption = caption?.trim();
  if (trimmedCaption) lines.push(trimmedCaption);
  return lines.join('\n');
}

/**
 * @description Whether a KNOWN file size exceeds the Bot API download cap.
 * An unknown size returns `false` — we can't pre-reject it, so we let the
 * `getFile` call itself surface the "file is too big" error.
 */
export function checkIsFileTooBig(fileSize?: number): boolean {
  if (fileSize === undefined) return false;
  return fileSize > telegramFileDownloadCapBytes;
}
