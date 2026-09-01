import * as fs from 'node:fs';
import type { FileSendGateway } from '../utils/fileSendService';
import type {
  FileDescriptorSnapshot,
  FileSendMediaGroup,
  TelegramSingleFileSendMethod,
} from '../utils/fileSendPlan';

export interface RecordedFileSource {
  filename: string;
  sizeBytes: number;
  contents: string;
}

interface RecordedPhotoVideoMedia {
  type: 'photo' | 'video';
  media: RecordedFileSource;
  caption?: string;
}

interface RecordedDocumentMedia {
  type: 'document';
  media: RecordedFileSource;
  caption?: string;
}

export type RecordedFileSendMediaGroup =
  | { kind: 'photoVideo'; media: RecordedPhotoVideoMedia[] }
  | { kind: 'document'; media: RecordedDocumentMedia[] };

export type RecordedFileSendMethod = TelegramSingleFileSendMethod | 'sendMediaGroup';

export interface RecordedFileSendGatewayCall<TTarget> {
  method: RecordedFileSendMethod;
  target: TTarget;
  source?: RecordedFileSource;
  caption?: string;
  mediaGroup?: RecordedFileSendMediaGroup;
}

export interface FileSendTestRecorderOptions {
  singleMessageIds: Readonly<Record<TelegramSingleFileSendMethod, number>>;
  albumMessageIds: readonly number[];
  rejectedMethod?: RecordedFileSendMethod;
  capturedFileDescriptors?: number[];
}

function getRecordedFileSource(
  source: FileDescriptorSnapshot,
  capturedFileDescriptors: number[] | undefined,
): RecordedFileSource {
  capturedFileDescriptors?.push(source.fd);
  const contentsBuffer = Buffer.alloc(source.sizeBytes);
  const bytesRead = fs.readSync(source.fd, contentsBuffer, 0, source.sizeBytes, 0);
  return {
    filename: source.filename,
    sizeBytes: source.sizeBytes,
    contents: contentsBuffer.subarray(0, bytesRead).toString('utf8'),
  };
}

function getRecordedFileSendMediaGroup(
  mediaGroup: FileSendMediaGroup,
  capturedFileDescriptors: number[] | undefined,
): RecordedFileSendMediaGroup {
  if (mediaGroup.kind === 'document') {
    return {
      kind: 'document',
      media: mediaGroup.media.map((entry) => ({
        type: 'document',
        media: getRecordedFileSource(entry.media, capturedFileDescriptors),
        ...(entry.caption !== undefined ? { caption: entry.caption } : {}),
      })),
    };
  }

  return {
    kind: 'photoVideo',
    media: mediaGroup.media.map((entry) => ({
      type: entry.type,
      media: getRecordedFileSource(entry.media, capturedFileDescriptors),
      ...(entry.caption !== undefined ? { caption: entry.caption } : {}),
    })),
  };
}

/** Create a typed gateway that records descriptor bytes at the real gateway boundary. */
export function createFileSendTestRecorderGateway<TTarget>(
  calls: Array<RecordedFileSendGatewayCall<TTarget>>,
  options: FileSendTestRecorderOptions,
): FileSendGateway<TTarget> {
  const recordSingleSend = async (
    method: TelegramSingleFileSendMethod,
    target: TTarget,
    source: FileDescriptorSnapshot,
    caption?: string,
    _signal?: AbortSignal,
  ) => {
    calls.push({
      method,
      target,
      source: getRecordedFileSource(source, options.capturedFileDescriptors),
      ...(caption !== undefined ? { caption } : {}),
    });
    if (method === options.rejectedMethod) throw new Error(`gateway rejected ${method}`);
    return { messageIds: [options.singleMessageIds[method]] };
  };

  return {
    sendPhoto: (target, source, caption, signal) =>
      recordSingleSend('sendPhoto', target, source, caption, signal),
    sendAnimation: (target, source, caption, signal) =>
      recordSingleSend('sendAnimation', target, source, caption, signal),
    sendVideo: (target, source, caption, signal) =>
      recordSingleSend('sendVideo', target, source, caption, signal),
    sendDocument: (target, source, caption, signal) =>
      recordSingleSend('sendDocument', target, source, caption, signal),
    sendMediaGroup: async (target, mediaGroup, _signal) => {
      calls.push({
        method: 'sendMediaGroup',
        target,
        mediaGroup: getRecordedFileSendMediaGroup(
          mediaGroup,
          options.capturedFileDescriptors,
        ),
      });
      if (options.rejectedMethod === 'sendMediaGroup') {
        throw new Error('gateway rejected sendMediaGroup');
      }
      return { messageIds: [...options.albumMessageIds] };
    },
  };
}
