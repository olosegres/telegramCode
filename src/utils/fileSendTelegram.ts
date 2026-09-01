import {
  createReadStream,
  read,
  type NoParamCallback,
} from 'node:fs';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import AbortController, {
  type AbortSignal as TelegrafAbortSignal,
} from 'abort-controller';
import type {
  InputMediaDocument,
  InputMediaPhoto,
  InputMediaVideo,
} from 'telegraf/typings/core/types/typegram';
import type {
  FileDescriptorSnapshot,
  FileSendDocumentMediaGroup,
  FileSendMediaGroup,
} from './fileSendPlan';
import {
  FileSendDeliveryUnknownError,
  type FileSendGateway,
  type FileSendGatewayResult,
} from './fileSendService';
import { getAbortError } from '../utils';
import { checkIsApiError } from '../sendErrorClassifier';

/** Telegraf input backed by one fresh source bounded to an owned descriptor snapshot. */
export interface TelegramDescriptorInputFile {
  source: Readable;
  filename: string;
}

/** Minimal sent-message shape shared by single sends and media-group results. */
export interface TelegramMessageId {
  message_id: number;
}

export type TelegramDescriptorInputMediaPhoto = Omit<InputMediaPhoto, 'media'> & {
  media: TelegramDescriptorInputFile;
};

export type TelegramDescriptorInputMediaVideo = Omit<InputMediaVideo, 'media'> & {
  media: TelegramDescriptorInputFile;
};

export type TelegramDescriptorInputMediaDocument = Omit<InputMediaDocument, 'media'> & {
  media: TelegramDescriptorInputFile;
};

/** Telegraf-compatible media group whose inputs all expose owned attempt streams. */
export type TelegramDescriptorMediaGroup =
  | readonly (TelegramDescriptorInputMediaPhoto | TelegramDescriptorInputMediaVideo)[]
  | readonly TelegramDescriptorInputMediaDocument[];

/** A stream may terminate without closing the descriptor retained by the service. */
const descriptorStreamFs = {
  read,
  close: (_fileDescriptor: number, callback: NoParamCallback) => callback(null),
};

type TelegramSingleSend<TTarget> = (
  target: TTarget,
  input: TelegramDescriptorInputFile,
  caption?: string,
  signal?: TelegrafAbortSignal,
) => Promise<TelegramMessageId>;

export type StartPostUploadResponseDeadline = (
  callback: () => void,
  delayMs: number,
) => () => void;

/** Maximum wait for Telegram's response after every request-body stream ends. */
export const telegramPostUploadResponseDeadlineMs = 30_000;

function startPostUploadResponseDeadline(
  callback: () => void,
  delayMs: number,
): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** Telegraf operations used for one delivery attempt. */
export interface TelegramFileSendGatewayDeps<TTarget> {
  sendPhoto: TelegramSingleSend<TTarget>;
  sendAnimation: TelegramSingleSend<TTarget>;
  sendVideo: TelegramSingleSend<TTarget>;
  sendDocument: TelegramSingleSend<TTarget>;
  sendMediaGroup: (
    target: TTarget,
    mediaGroup: TelegramDescriptorMediaGroup,
    signal?: TelegrafAbortSignal,
  ) => Promise<TelegramMessageId[]>;
  startPostUploadResponseDeadline?: StartPostUploadResponseDeadline;
}

interface TelegrafAbortBridge {
  signal: TelegrafAbortSignal;
  abort: () => void;
}

/** Create the Telegraf-side controller; stream state decides whether to abort it. */
function createTelegrafAbortBridge(): TelegrafAbortBridge {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
  };
}

/**
 * Keep one attempt's streams alive only for its send callback. Terminal listeners
 * are registered before the callback starts. Cancellation destroys unread streams
 * and aborts the sender only while any request body remains unconsumed. Once every
 * stream has ended, the callback owns the delivery outcome and must settle before
 * cleanup completes or a retry can begin. A bounded response deadline starts only
 * after every stream ends normally; expiry aborts the sender and awaits settlement.
 */
async function executeWithTerminalStreams<TResult>(
  streams: readonly Readable[],
  signal: AbortSignal | undefined,
  abortSender: () => void,
  startResponseDeadline: StartPostUploadResponseDeadline,
  send: () => Promise<TResult>,
): Promise<TResult> {
  const terminalPromises = streams.map(async (stream): Promise<boolean> => {
    try {
      await finished(stream, { cleanup: true });
    } catch {
      // destroy() rejects finished(); settlement, not that expected error, owns this boundary.
    }
    return stream.readableEnded;
  });

  const destroyLiveStreams = () => {
    for (const stream of streams) {
      if (!stream.destroyed && !stream.readableEnded) stream.destroy();
    }
  };
  let handleAbort: (() => void) | null = null;
  if (signal) {
    handleAbort = () => {
      if (streams.every((stream) => stream.readableEnded)) return;
      destroyLiveStreams();
      abortSender();
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    if (signal.aborted) handleAbort();
  }

  let isSendSettled = false;
  let responseDeadlineError: Error | null = null;
  let cancelResponseDeadline = () => {};
  const responseDeadlineReady = Promise.all(terminalPromises).then((streamEndStates) => {
    if (isSendSettled || !streamEndStates.every(Boolean)) return;
    cancelResponseDeadline = startResponseDeadline(() => {
      responseDeadlineError = new Error(
        `Telegram did not respond within ${telegramPostUploadResponseDeadlineMs} ms after upload completed`,
      );
      abortSender();
    }, telegramPostUploadResponseDeadlineMs);
  });

  try {
    return await send();
  } catch (error) {
    if (responseDeadlineError) {
      throw new FileSendDeliveryUnknownError(responseDeadlineError);
    }
    throw error;
  } finally {
    isSendSettled = true;
    cancelResponseDeadline();
    if (signal && handleAbort) signal.removeEventListener('abort', handleAbort);
    destroyLiveStreams();
    await Promise.all(terminalPromises);
    await responseDeadlineReady;
  }
}

/**
 * Build a fresh retry input without transferring descriptor ownership. Non-empty
 * snapshots use a positional stream capped at the validated end byte; an empty
 * snapshot uses an in-memory empty Readable so later file growth stays invisible.
 */
export function createTelegramFileInput(
  snapshot: FileDescriptorSnapshot,
): TelegramDescriptorInputFile {
  return {
    source: snapshot.sizeBytes === 0
      ? Readable.from(Buffer.alloc(0), { objectMode: false })
      : createReadStream('', {
        fd: snapshot.fd,
        autoClose: false,
        fs: descriptorStreamFs,
        start: 0,
        end: snapshot.sizeBytes - 1,
      }),
    filename: snapshot.filename,
  };
}

/** Narrow the project media union before constructing Telegraf's homogeneous arrays. */
export function checkIsDocumentFileSendMediaGroup(
  mediaGroup: FileSendMediaGroup,
): mediaGroup is FileSendDocumentMediaGroup {
  return mediaGroup.kind === 'document';
}

/** Convert a project-owned descriptor group into fresh Telegraf inputs for one attempt. */
export function createTelegramMediaGroup(
  mediaGroup: FileSendMediaGroup,
): TelegramDescriptorMediaGroup {
  if (checkIsDocumentFileSendMediaGroup(mediaGroup)) {
    const media: TelegramDescriptorInputMediaDocument[] = mediaGroup.media.map((entry) => ({
      type: 'document',
      media: createTelegramFileInput(entry.media),
      ...(entry.caption !== undefined ? { caption: entry.caption } : {}),
    }));
    return media;
  }

  const media = mediaGroup.media.map(
    (entry): TelegramDescriptorInputMediaPhoto | TelegramDescriptorInputMediaVideo => {
      const telegramInput = createTelegramFileInput(entry.media);
      if (entry.type === 'photo') {
        return {
          type: 'photo',
          media: telegramInput,
          ...(entry.caption !== undefined ? { caption: entry.caption } : {}),
        };
      }
      return {
        type: 'video',
        media: telegramInput,
        ...(entry.caption !== undefined ? { caption: entry.caption } : {}),
      };
    },
  );
  return media;
}

/** Extract sent message ids in Telegram response order for `/clear` tracking. */
export function getTelegramMessageIds(
  sent: TelegramMessageId | TelegramMessageId[],
): number[] {
  return Array.isArray(sent)
    ? sent.map((message) => message.message_id)
    : [sent.message_id];
}

/** Preserve retryable API errors/cancellation and mark only ambiguous initiated sends. */
function throwTelegramDeliveryError<TError>(
  error: TError,
  isDeliveryInitiated: boolean,
  isAbortForwarded: boolean,
  signal?: AbortSignal,
): never {
  if (error instanceof FileSendDeliveryUnknownError) throw error;
  if (isAbortForwarded && signal) throw getAbortError(signal);
  if (error instanceof Error && error.name === 'AbortError') throw error;
  if (checkIsApiError(error) || !isDeliveryInitiated) throw error;
  const cause = error instanceof Error
    ? error
    : new Error('Telegram delivery failed without an error response');
  throw new FileSendDeliveryUnknownError(cause);
}

/**
 * Build the production gateway so every invocation constructs fresh bounded
 * inputs and no attempt settles until all of its streams are terminal.
 */
export function createTelegramFileSendGateway<TTarget>(
  deps: TelegramFileSendGatewayDeps<TTarget>,
): FileSendGateway<TTarget> {
  const startResponseDeadline = deps.startPostUploadResponseDeadline
    ?? startPostUploadResponseDeadline;

  async function executeSingleSend(
    target: TTarget,
    source: FileDescriptorSnapshot,
    caption: string | undefined,
    send: TelegramSingleSend<TTarget>,
    signal?: AbortSignal,
  ): Promise<FileSendGatewayResult> {
    const input = createTelegramFileInput(source);
    const telegrafAbort = createTelegrafAbortBridge();
    let isDeliveryInitiated = false;
    try {
      const sent = await executeWithTerminalStreams(
        [input.source],
        signal,
        telegrafAbort.abort,
        startResponseDeadline,
        async () => {
          isDeliveryInitiated = true;
          return send(target, input, caption, telegrafAbort.signal);
        },
      );
      return { messageIds: getTelegramMessageIds(sent) };
    } catch (error) {
      throwTelegramDeliveryError(
        error,
        isDeliveryInitiated,
        telegrafAbort.signal.aborted,
        signal,
      );
    }
  }

  return {
    sendPhoto: (target, source, caption, signal) =>
      executeSingleSend(target, source, caption, deps.sendPhoto, signal),
    sendAnimation: (target, source, caption, signal) =>
      executeSingleSend(target, source, caption, deps.sendAnimation, signal),
    sendVideo: (target, source, caption, signal) =>
      executeSingleSend(target, source, caption, deps.sendVideo, signal),
    sendDocument: (target, source, caption, signal) =>
      executeSingleSend(target, source, caption, deps.sendDocument, signal),
    sendMediaGroup: async (target, mediaGroup, signal) => {
      const telegramMediaGroup = createTelegramMediaGroup(mediaGroup);
      const streams = telegramMediaGroup.map((entry) => entry.media.source);
      const telegrafAbort = createTelegrafAbortBridge();
      let isDeliveryInitiated = false;
      try {
        const sent = await executeWithTerminalStreams(
          streams,
          signal,
          telegrafAbort.abort,
          startResponseDeadline,
          async () => {
            isDeliveryInitiated = true;
            return deps.sendMediaGroup(
              target,
              telegramMediaGroup,
              telegrafAbort.signal,
            );
          },
        );
        return { messageIds: getTelegramMessageIds(sent) };
      } catch (error) {
        throwTelegramDeliveryError(
          error,
          isDeliveryInitiated,
          telegrafAbort.signal.aborted,
          signal,
        );
      }
    },
  };
}
