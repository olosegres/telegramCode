/**
 * @description Adapter coverage for converting project-owned descriptor send
 * requests into fresh Telegraf stream inputs on every retry attempt, preserving
 * media-group homogeneity, and extracting sent message ids for tracking.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'node:stream';
import { buffer as consumeBuffer } from 'node:stream/consumers';
import type { AbortSignal as TelegrafAbortSignal } from 'abort-controller';
import {
  checkIsDocumentFileSendMediaGroup,
  createTelegramFileInput,
  createTelegramFileSendGateway,
  createTelegramMediaGroup,
  getTelegramMessageIds,
  telegramPostUploadResponseDeadlineMs,
  type TelegramDescriptorInputFile,
  type TelegramDescriptorMediaGroup,
  type TelegramMessageId,
} from '../utils/fileSendTelegram';
import {
  createSendFilesToThread,
  FileSendDeliveryUnknownError,
  type SendFilesToThreadDeps,
} from '../utils/fileSendService';
import {
  enqueueSend,
  GlobalSendPacer,
  __setGlobalPacerForTest,
} from '../rateLimiter';
import { keyToString, type ThreadKey } from '../types';
import type {
  FileDescriptorSnapshot,
  FileSendMediaGroup,
} from '../utils/fileSendPlan';

const linuxTest = process.platform === 'linux' ? test : test.skip;

interface FakeDeadlineEntry {
  callback: () => void;
  delayMs: number;
  isActive: boolean;
}

interface FakePostUploadResponseDeadline {
  start: (callback: () => void, delayMs: number) => () => void;
  fire: () => void;
  getActiveCount: () => number;
  getDelays: () => number[];
}

function createFakePostUploadResponseDeadline(): FakePostUploadResponseDeadline {
  const entries: FakeDeadlineEntry[] = [];
  return {
    start: (callback, delayMs) => {
      const entry = { callback, delayMs, isActive: true };
      entries.push(entry);
      return () => { entry.isActive = false; };
    },
    fire: () => {
      const entry = entries.find((candidate) => candidate.isActive);
      assert.ok(entry, 'an active post-upload response deadline must exist');
      entry.isActive = false;
      entry.callback();
    },
    getActiveCount: () => entries.filter((entry) => entry.isActive).length,
    getDelays: () => entries.map((entry) => entry.delayMs),
  };
}

function createOpenDescriptor(contents: string, filename: string) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fileSendTelegram-'));
  const filePath = path.join(tempRoot, filename);
  fs.writeFileSync(filePath, contents);
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY);
  const source: FileDescriptorSnapshot = {
    fd,
    filename,
    sizeBytes: Buffer.byteLength(contents),
  };
  return {
    filePath,
    source,
    cleanup: () => {
      fs.closeSync(fd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function checkIsTelegramDescriptorInputFile(
  input: TelegramDescriptorMediaGroup[number]['media'],
): input is TelegramDescriptorInputFile {
  return typeof input === 'object' && input !== null && 'source' in input && input.source instanceof Readable;
}

function assertStreamsTerminal(streams: readonly Readable[]): void {
  for (const stream of streams) {
    assert.equal(
      stream.destroyed || stream.readableEnded,
      true,
      'an attempt stream must settle before executeSend regains control',
    );
  }
}

test('createTelegramFileInput gives two retry attempts distinct streams that both replay from byte zero', async () => {
  const fixture = createOpenDescriptor('retryable-bytes', 'clip.mp4');
  try {
    const firstAttempt = createTelegramFileInput(fixture.source);
    const secondAttempt = createTelegramFileInput(fixture.source);

    assert.notStrictEqual(firstAttempt.source, secondAttempt.source);
    assert.equal((await consumeBuffer(firstAttempt.source)).toString('utf8'), 'retryable-bytes');
    assert.equal((await consumeBuffer(secondAttempt.source)).toString('utf8'), 'retryable-bytes');
    assert.equal(firstAttempt.filename, 'clip.mp4');
    assert.equal(secondAttempt.filename, 'clip.mp4');
    assert.equal(fs.fstatSync(fixture.source.fd).isFile(), true, 'stream attempts must not auto-close the owned fd');
  } finally {
    fixture.cleanup();
  }
});

test('createTelegramFileInput never reads bytes appended after the validated snapshot', async () => {
  const fixture = createOpenDescriptor('validated-bytes', 'clip.mp4');
  try {
    fs.appendFileSync(fixture.filePath, '-appended-after-validation');

    const attempt = createTelegramFileInput(fixture.source);

    assert.equal((await consumeBuffer(attempt.source)).toString('utf8'), 'validated-bytes');
  } finally {
    fixture.cleanup();
  }
});

test('createTelegramFileInput keeps an empty validated snapshot empty if the file later grows', async () => {
  const fixture = createOpenDescriptor('', 'empty.bin');
  try {
    fs.appendFileSync(fixture.filePath, 'appended-after-validation');

    const attempt = createTelegramFileInput(fixture.source);

    assert.equal((await consumeBuffer(attempt.source)).byteLength, 0);
  } finally {
    fixture.cleanup();
  }
});

test('createTelegramMediaGroup keeps document and photo/video groups homogeneous', async () => {
  const fixture = createOpenDescriptor('media-bytes', 'media.bin');
  try {
    const documentGroup: FileSendMediaGroup = {
      kind: 'document',
      media: [{ type: 'document', media: fixture.source, caption: 'document caption' }],
    };
    const photoVideoGroup: FileSendMediaGroup = {
      kind: 'photoVideo',
      media: [
        { type: 'photo', media: fixture.source },
        { type: 'video', media: fixture.source },
      ],
    };

    assert.equal(checkIsDocumentFileSendMediaGroup(documentGroup), true);
    assert.equal(checkIsDocumentFileSendMediaGroup(photoVideoGroup), false);
    const firstDocumentAttempt = createTelegramMediaGroup(documentGroup);
    const secondDocumentAttempt = createTelegramMediaGroup(documentGroup);
    const firstPhotoVideoAttempt = createTelegramMediaGroup(photoVideoGroup);
    const secondPhotoVideoAttempt = createTelegramMediaGroup(photoVideoGroup);
    assert.deepEqual(firstDocumentAttempt.map((media) => media.type), ['document']);
    assert.deepEqual(firstPhotoVideoAttempt.map((media) => media.type), ['photo', 'video']);
    assert.notStrictEqual(firstDocumentAttempt, secondDocumentAttempt);
    assert.notStrictEqual(firstPhotoVideoAttempt, secondPhotoVideoAttempt);
    await Promise.all([
      ...firstDocumentAttempt,
      ...secondDocumentAttempt,
      ...firstPhotoVideoAttempt,
      ...secondPhotoVideoAttempt,
    ].map((entry) => consumeBuffer(entry.media.source)));
  } finally {
    fixture.cleanup();
  }
});

test('createTelegramFileSendGateway builds one fresh byte-zero stream per invocation', async () => {
  const fixture = createOpenDescriptor('retryable-bytes', 'clip.mp4');
  const attemptedMethods: string[] = [];
  const attemptedInputs: TelegramDescriptorInputFile[] = [];
  const attemptedContents: Buffer[] = [];
  let nextMessageId = 100;
  function createSingleSender(method: string) {
    return async (_target: string, input: TelegramDescriptorInputFile) => {
      attemptedMethods.push(method);
      attemptedInputs.push(input);
      attemptedContents.push(await consumeBuffer(input.source));
      nextMessageId += 1;
      return { message_id: nextMessageId };
    };
  }
  try {
    const gateway = createTelegramFileSendGateway({
      sendPhoto: createSingleSender('sendPhoto'),
      sendAnimation: createSingleSender('sendAnimation'),
      sendVideo: createSingleSender('sendVideo'),
      sendDocument: createSingleSender('sendDocument'),
      sendMediaGroup: async () => [{ message_id: 999 }],
    });

    await gateway.sendPhoto('target', fixture.source);
    await gateway.sendAnimation('target', fixture.source);
    await gateway.sendVideo('target', fixture.source);
    await gateway.sendDocument('target', fixture.source);

    assert.deepEqual(attemptedMethods, [
      'sendPhoto',
      'sendAnimation',
      'sendVideo',
      'sendDocument',
    ]);
    assert.equal(new Set(attemptedInputs.map((input) => input.source)).size, attemptedInputs.length);
    for (const contents of attemptedContents) {
      assert.equal(contents.toString('utf8'), 'retryable-bytes');
    }
    assertStreamsTerminal(attemptedInputs.map((input) => input.source));
  } finally {
    fixture.cleanup();
  }
});

test('createTelegramFileSendGateway builds fresh media-group streams per invocation', async () => {
  const photoFixture = createOpenDescriptor('photo-bytes', 'chart.png');
  const videoFixture = createOpenDescriptor('video-bytes', 'clip.mp4');
  const attemptedMediaGroups: TelegramDescriptorMediaGroup[] = [];
  const attemptedContents: Buffer[][] = [];
  try {
    const gateway = createTelegramFileSendGateway({
      sendPhoto: async () => ({ message_id: 1 }),
      sendAnimation: async () => ({ message_id: 1 }),
      sendVideo: async () => ({ message_id: 1 }),
      sendDocument: async () => ({ message_id: 1 }),
      sendMediaGroup: async (_target, mediaGroup) => {
        attemptedMediaGroups.push(mediaGroup);
        attemptedContents.push(await Promise.all(
          mediaGroup.map((entry) => consumeBuffer(entry.media.source)),
        ));
        return [{ message_id: attemptedMediaGroups.length }];
      },
    });
    const mediaGroup: FileSendMediaGroup = {
      kind: 'photoVideo',
      media: [
        { type: 'photo', media: photoFixture.source },
        { type: 'video', media: videoFixture.source },
      ],
    };

    const result = await gateway.sendMediaGroup('target', mediaGroup);

    assert.equal(attemptedMediaGroups.length, 1);
    const attemptedInputs = attemptedMediaGroups.map((attemptMediaGroup) =>
      attemptMediaGroup.map((entry) => {
        assert.equal(checkIsTelegramDescriptorInputFile(entry.media), true);
        if (!checkIsTelegramDescriptorInputFile(entry.media)) {
          assert.fail('media-group input must be a descriptor-backed readable');
        }
        return entry.media;
      }));
    assert.equal(
      new Set(attemptedInputs.flat().map((input) => input.source)).size,
      attemptedInputs.flat().length,
      'every item in every retry must receive its own stream',
    );
    for (const attemptContents of attemptedContents) {
      assert.deepEqual(
        attemptContents,
        [Buffer.from('photo-bytes'), Buffer.from('video-bytes')],
      );
    }
    assertStreamsTerminal(attemptedInputs.flat().map((input) => input.source));
    assert.deepEqual(result, { messageIds: [1] });
  } finally {
    photoFixture.cleanup();
    videoFixture.cleanup();
  }
});

test('createTelegramFileSendGateway aborts a hung in-flight sender and settles its descriptor stream', async () => {
  const fixture = createOpenDescriptor('cancel-me', 'clip.mp4');
  const controller = new AbortController();
  let attemptedStream: Readable | null = null;
  let senderSignal: TelegrafAbortSignal | undefined;
  let markSenderStarted = () => {};
  const senderStarted = new Promise<void>((resolve) => { markSenderStarted = resolve; });
  let gatewaySettled = false;

  try {
    const gateway = createTelegramFileSendGateway({
      sendPhoto: async () => ({ message_id: 1 }),
      sendAnimation: async () => ({ message_id: 1 }),
      sendVideo: async (_target, input, _caption, signal) => {
        attemptedStream = input.source;
        senderSignal = signal;
        markSenderStarted();
        return new Promise((_resolve, reject) => {
          const abortError = new Error('sender aborted');
          abortError.name = 'AbortError';
          const handleAbort = () => reject(abortError);
          signal?.addEventListener('abort', handleAbort, { once: true });
          if (signal?.aborted) handleAbort();
        });
      },
      sendDocument: async () => ({ message_id: 1 }),
      sendMediaGroup: async () => [{ message_id: 1 }],
    });

    const send = gateway.sendVideo('target', fixture.source, undefined, controller.signal);
    void send.then(
      () => { gatewaySettled = true; },
      () => { gatewaySettled = true; },
    );
    await senderStarted;
    controller.abort();

    assert.equal(senderSignal?.aborted, true, 'the native abort must reach Telegraf\'s signal bridge');
    assert.notEqual(attemptedStream, null);
    if (attemptedStream !== null) assertStreamsTerminal([attemptedStream]);
    assert.equal(gatewaySettled, false, 'stream cleanup must precede gateway settlement');
    await assert.rejects(send, { name: 'AbortError' });
  } finally {
    fixture.cleanup();
  }
});

test('createTelegramFileSendGateway forwards a pre-aborted signal and settles its descriptor stream', async () => {
  const fixture = createOpenDescriptor('cancel-before-send', 'clip.mp4');
  const controller = new AbortController();
  controller.abort();
  let attemptedStream: Readable | null = null;
  let senderSignal: TelegrafAbortSignal | undefined;

  try {
    const gateway = createTelegramFileSendGateway({
      sendPhoto: async () => ({ message_id: 1 }),
      sendAnimation: async () => ({ message_id: 1 }),
      sendVideo: async (_target, input, _caption, signal) => {
        attemptedStream = input.source;
        senderSignal = signal;
        const abortError = new Error('sender aborted before upload');
        abortError.name = 'AbortError';
        throw abortError;
      },
      sendDocument: async () => ({ message_id: 1 }),
      sendMediaGroup: async () => [{ message_id: 1 }],
    });

    await assert.rejects(
      gateway.sendVideo('target', fixture.source, undefined, controller.signal),
      { name: 'AbortError' },
    );
    assert.equal(senderSignal?.aborted, true, 'a pre-aborted request must reach Telegraf before sending');
    assert.notEqual(attemptedStream, null);
    if (attemptedStream !== null) assertStreamsTerminal([attemptedStream]);
  } finally {
    fixture.cleanup();
  }
});

test('createTelegramFileSendGateway aborts an active media-group sender and settles every stream', async () => {
  const photoFixture = createOpenDescriptor('cancel-photo', 'chart.png');
  const videoFixture = createOpenDescriptor('cancel-video', 'clip.mp4');
  const controller = new AbortController();
  const attemptedStreams: Readable[] = [];
  let senderSignal: TelegrafAbortSignal | undefined;
  let markSenderStarted = () => {};
  const senderStarted = new Promise<void>((resolve) => { markSenderStarted = resolve; });
  let gatewaySettled = false;

  try {
    const gateway = createTelegramFileSendGateway({
      sendPhoto: async () => ({ message_id: 1 }),
      sendAnimation: async () => ({ message_id: 1 }),
      sendVideo: async () => ({ message_id: 1 }),
      sendDocument: async () => ({ message_id: 1 }),
      sendMediaGroup: async (_target, mediaGroup, signal) => {
        attemptedStreams.push(...mediaGroup.map((entry) => entry.media.source));
        senderSignal = signal;
        markSenderStarted();
        return new Promise((_resolve, reject) => {
          const abortError = new Error('media-group sender aborted');
          abortError.name = 'AbortError';
          const handleAbort = () => reject(abortError);
          signal?.addEventListener('abort', handleAbort, { once: true });
          if (signal?.aborted) handleAbort();
        });
      },
    });
    const mediaGroup: FileSendMediaGroup = {
      kind: 'photoVideo',
      media: [
        { type: 'photo', media: photoFixture.source },
        { type: 'video', media: videoFixture.source },
      ],
    };

    const send = gateway.sendMediaGroup('target', mediaGroup, controller.signal);
    void send.then(
      () => { gatewaySettled = true; },
      () => { gatewaySettled = true; },
    );
    await senderStarted;
    controller.abort();

    assert.equal(senderSignal?.aborted, true, 'active media-group cancellation must reach Telegraf');
    assertStreamsTerminal(attemptedStreams);
    assert.equal(gatewaySettled, false, 'every album stream must terminate before gateway settlement');
    await assert.rejects(send, { name: 'AbortError' });
  } finally {
    photoFixture.cleanup();
    videoFixture.cleanup();
  }
});

linuxTest('real service records a Telegram acceptance that resolves after request cancellation', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fileSendTelegram-late-accept-'));
  const workDir = path.join(tempRoot, 'bound');
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'clip.mp4'), 'accepted-video-bytes');
  const acceptedMessageId = 73308;
  const recordedMessageIds: number[] = [];
  const controller = new AbortController();
  let attemptedStream: fs.ReadStream | null = null;
  let attemptDescriptor: number | null = null;
  let senderSignal: TelegrafAbortSignal | undefined;
  let markSenderStarted = () => {};
  const senderStarted = new Promise<void>((resolve) => { markSenderStarted = resolve; });
  let resolveSender = (_response: { message_id: number }) => {};
  const senderResult = new Promise<{ message_id: number }>((resolve) => { resolveSender = resolve; });
  let operationSettled = false;

  try {
    const gateway = createTelegramFileSendGateway({
      sendPhoto: async () => ({ message_id: 1 }),
      sendAnimation: async () => ({ message_id: 1 }),
      sendVideo: async (_target, input, _caption, signal) => {
        assert.equal(input.source instanceof fs.ReadStream, true);
        if (!(input.source instanceof fs.ReadStream)) {
          assert.fail('non-empty descriptor input must use fs.ReadStream');
        }
        attemptedStream = input.source;
        attemptDescriptor = input.source.fd;
        senderSignal = signal;
        assert.equal(
          (await consumeBuffer(input.source)).toString('utf8'),
          'accepted-video-bytes',
        );
        markSenderStarted();
        return senderResult;
      },
      sendDocument: async () => ({ message_id: 1 }),
      sendMediaGroup: async () => [{ message_id: 1 }],
    });
    const sendFilesToThread = createSendFilesToThread({
      resolveTargetAndWorkDir: () => ({ ok: true, target: 'target', workDir }),
      gateway,
      recordMessageIds: async (_target, messageIds) => {
        recordedMessageIds.push(...messageIds);
      },
    });

    const send = sendFilesToThread(
      'thread-key',
      { paths: ['clip.mp4'], signal: controller.signal },
    );
    void send.then(
      () => { operationSettled = true; },
      () => { operationSettled = true; },
    );
    await senderStarted;
    controller.abort();
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    assert.equal(
      senderSignal?.aborted,
      false,
      'cancellation after request-body consumption must not abort Telegraf',
    );
    assert.notEqual(attemptedStream, null);
    if (attemptedStream !== null) assertStreamsTerminal([attemptedStream]);
    assert.equal(operationSettled, false, 'the service must await Telegram\'s sender result');
    assert.notEqual(attemptDescriptor, null);
    if (attemptDescriptor !== null) {
      assert.doesNotThrow(
        () => fs.fstatSync(attemptDescriptor),
        'the service-owned descriptor must remain open until the sender settles',
      );
    }

    resolveSender({ message_id: acceptedMessageId });
    const result = await send;

    assert.deepEqual(result, { ok: true, summary: 'Sent 1 file(s) to the topic.' });
    assert.deepEqual(recordedMessageIds, [acceptedMessageId]);
    if (attemptDescriptor !== null) {
      assert.throws(
        () => fs.fstatSync(attemptDescriptor),
        { code: 'EBADF' },
        'the descriptor must close after the accepted delivery is recorded',
      );
    }
  } finally {
    resolveSender({ message_id: acceptedMessageId });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

linuxTest('real service records a Telegram media-group acceptance that resolves after request cancellation', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fileSendTelegram-album-late-accept-'));
  const workDir = path.join(tempRoot, 'bound');
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'chart.png'), 'accepted-photo-bytes');
  fs.writeFileSync(path.join(workDir, 'clip.mp4'), 'accepted-video-bytes');
  const acceptedMessageIds = [73309, 73310];
  const recordedMessageIds: number[] = [];
  const controller = new AbortController();
  const attemptedStreams: fs.ReadStream[] = [];
  const attemptDescriptors: number[] = [];
  let senderSignal: TelegrafAbortSignal | undefined;
  let markSenderStarted = () => {};
  const senderStarted = new Promise<void>((resolve) => { markSenderStarted = resolve; });
  let resolveSender = (_response: Array<{ message_id: number }>) => {};
  const senderResult = new Promise<Array<{ message_id: number }>>((resolve) => { resolveSender = resolve; });
  let operationSettled = false;

  try {
    const gateway = createTelegramFileSendGateway({
      sendPhoto: async () => ({ message_id: 1 }),
      sendAnimation: async () => ({ message_id: 1 }),
      sendVideo: async () => ({ message_id: 1 }),
      sendDocument: async () => ({ message_id: 1 }),
      sendMediaGroup: async (_target, mediaGroup, signal) => {
        for (const media of mediaGroup) {
          assert.equal(media.media.source instanceof fs.ReadStream, true);
          if (!(media.media.source instanceof fs.ReadStream)) {
            assert.fail('non-empty descriptor input must use fs.ReadStream');
          }
          assert.notEqual(media.media.source.fd, null);
          if (media.media.source.fd === null) {
            assert.fail('descriptor stream must expose its open file descriptor');
          }
          attemptedStreams.push(media.media.source);
          attemptDescriptors.push(media.media.source.fd);
        }
        senderSignal = signal;
        assert.deepEqual(
          await Promise.all(attemptedStreams.map((stream) => consumeBuffer(stream))),
          [Buffer.from('accepted-photo-bytes'), Buffer.from('accepted-video-bytes')],
        );
        markSenderStarted();
        return senderResult;
      },
    });
    const sendFilesToThread = createSendFilesToThread({
      resolveTargetAndWorkDir: () => ({ ok: true, target: 'target', workDir }),
      gateway,
      recordMessageIds: async (_target, messageIds) => {
        recordedMessageIds.push(...messageIds);
      },
    });

    const send = sendFilesToThread('thread-key', {
      paths: ['chart.png', 'clip.mp4'],
      signal: controller.signal,
    });
    void send.then(
      () => { operationSettled = true; },
      () => { operationSettled = true; },
    );
    await senderStarted;
    controller.abort();
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    assert.equal(
      senderSignal?.aborted,
      false,
      'cancellation after every media-group body is consumed must not abort Telegraf',
    );
    assertStreamsTerminal(attemptedStreams);
    assert.equal(operationSettled, false, 'the service must await Telegram\'s media-group sender result');
    for (const fileDescriptor of attemptDescriptors) {
      assert.doesNotThrow(
        () => fs.fstatSync(fileDescriptor),
        'every service-owned descriptor must remain open until the sender settles',
      );
    }

    resolveSender(acceptedMessageIds.map((messageId) => ({ message_id: messageId })));
    const result = await send;

    assert.deepEqual(result, { ok: true, summary: 'Sent 2 file(s) to the topic.' });
    assert.deepEqual(recordedMessageIds, acceptedMessageIds);
    for (const fileDescriptor of attemptDescriptors) {
      assert.throws(
        () => fs.fstatSync(fileDescriptor),
        { code: 'EBADF' },
        'every descriptor must close after the accepted media group is recorded',
      );
    }
  } finally {
    resolveSender(acceptedMessageIds.map((messageId) => ({ message_id: messageId })));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('createTelegramFileSendGateway propagates Telegram API errors for the outer retry executor', async () => {
  const fixture = createOpenDescriptor('retry-me', 'clip.mp4');
  const apiError = {
    response: {
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: 1 },
    },
  };
  try {
    const gateway = createTelegramFileSendGateway({
      sendPhoto: async () => ({ message_id: 1 }),
      sendAnimation: async () => ({ message_id: 1 }),
      sendVideo: async () => { throw apiError; },
      sendDocument: async () => ({ message_id: 1 }),
      sendMediaGroup: async () => [{ message_id: 1 }],
    });

    await assert.rejects(
      gateway.sendVideo('target', fixture.source),
      (error) => error === apiError,
    );
  } finally {
    fixture.cleanup();
  }
});

test('createTelegramFileSendGateway marks a non-API post-initiation failure as delivery unknown', async () => {
  const fixture = createOpenDescriptor('ambiguous-send', 'clip.mp4');
  try {
    const gateway = createTelegramFileSendGateway({
      sendPhoto: async () => ({ message_id: 1 }),
      sendAnimation: async () => ({ message_id: 1 }),
      sendVideo: async () => { throw new Error('connection reset after upload'); },
      sendDocument: async () => ({ message_id: 1 }),
      sendMediaGroup: async () => [{ message_id: 1 }],
    });

    await assert.rejects(
      gateway.sendVideo('target', fixture.source),
      FileSendDeliveryUnknownError,
    );
  } finally {
    fixture.cleanup();
  }
});

test('createTelegramFileSendGateway keeps a post-consumption failure delivery-unknown after late cancellation', async () => {
  const fixture = createOpenDescriptor('ambiguous-late-send', 'clip.mp4');
  const controller = new AbortController();
  let senderSignal: TelegrafAbortSignal | undefined;
  let attemptedStream: Readable | null = null;
  let markUploadConsumed = () => {};
  const uploadConsumed = new Promise<void>((resolve) => { markUploadConsumed = resolve; });
  let rejectSender = (_error: Error) => {};
  const senderResult = new Promise<TelegramMessageId>((_resolve, reject) => { rejectSender = reject; });
  try {
    const gateway = createTelegramFileSendGateway({
      sendPhoto: async () => ({ message_id: 1 }),
      sendAnimation: async () => ({ message_id: 1 }),
      sendVideo: async (_target, input, _caption, signal) => {
        senderSignal = signal;
        attemptedStream = input.source;
        await consumeBuffer(input.source);
        markUploadConsumed();
        return senderResult;
      },
      sendDocument: async () => ({ message_id: 1 }),
      sendMediaGroup: async () => [{ message_id: 1 }],
    });

    const send = gateway.sendVideo('target', fixture.source, undefined, controller.signal);
    await uploadConsumed;
    controller.abort();
    rejectSender(new Error('connection reset while awaiting Telegram response'));

    assert.equal(senderSignal?.aborted, false, 'late cancellation must not replace the sender outcome');
    await assert.rejects(send, FileSendDeliveryUnknownError);
    assert.notEqual(attemptedStream, null);
    if (attemptedStream !== null) assertStreamsTerminal([attemptedStream]);
  } finally {
    rejectSender(new Error('test cleanup'));
    fixture.cleanup();
  }
});

test('createTelegramFileSendGateway starts the response deadline only after upload and awaits timed-out sender cleanup', async () => {
  const fixture = createOpenDescriptor('deadline-video', 'clip.mp4');
  const deadline = createFakePostUploadResponseDeadline();
  let attemptedStream: Readable | null = null;
  let senderSignal: TelegrafAbortSignal | undefined;
  let markSenderStarted = () => {};
  let allowUpload = () => {};
  let markUploadConsumed = () => {};
  const senderStarted = new Promise<void>((resolve) => { markSenderStarted = resolve; });
  const uploadGate = new Promise<void>((resolve) => { allowUpload = resolve; });
  const uploadConsumed = new Promise<void>((resolve) => { markUploadConsumed = resolve; });
  let isSenderCleanupFinished = false;
  try {
    const gateway = createTelegramFileSendGateway({
      sendPhoto: async () => ({ message_id: 1 }),
      sendAnimation: async () => ({ message_id: 1 }),
      sendVideo: async (_target, input, _caption, signal) => {
        attemptedStream = input.source;
        senderSignal = signal;
        markSenderStarted();
        await uploadGate;
        await consumeBuffer(input.source);
        markUploadConsumed();
        return new Promise((_resolve, reject) => {
          const handleAbort = () => {
            setImmediate(() => {
              isSenderCleanupFinished = true;
              const abortError = new Error('Telegraf request aborted after response deadline');
              abortError.name = 'AbortError';
              reject(abortError);
            });
          };
          signal?.addEventListener('abort', handleAbort, { once: true });
          if (signal?.aborted) handleAbort();
        });
      },
      sendDocument: async () => ({ message_id: 1 }),
      sendMediaGroup: async () => [{ message_id: 1 }],
      startPostUploadResponseDeadline: deadline.start,
    });

    const send = gateway.sendVideo('target', fixture.source);
    await senderStarted;
    assert.deepEqual(deadline.getDelays(), [], 'the deadline must not start while upload bytes remain');

    allowUpload();
    await uploadConsumed;
    await Promise.resolve();
    assert.equal(telegramPostUploadResponseDeadlineMs, 30_000);
    assert.deepEqual(deadline.getDelays(), [telegramPostUploadResponseDeadlineMs]);
    assert.equal(senderSignal?.aborted, false);

    deadline.fire();
    await assert.rejects(
      send,
      (error) => {
        assert.equal(error instanceof FileSendDeliveryUnknownError, true);
        assert.equal(isSenderCleanupFinished, true, 'the gateway must await sender cleanup before rejecting');
        return true;
      },
    );
    assert.equal(senderSignal?.aborted, true, 'deadline expiry must abort Telegraf');
    assert.equal(deadline.getActiveCount(), 0, 'the fired deadline must not remain active');
    assert.notEqual(attemptedStream, null);
    if (attemptedStream !== null) assertStreamsTerminal([attemptedStream]);
  } finally {
    allowUpload();
    fixture.cleanup();
  }
});

test('createTelegramFileSendGateway cancels an unfired response deadline after a normal response', async () => {
  const fixture = createOpenDescriptor('normal-response-video', 'clip.mp4');
  const deadline = createFakePostUploadResponseDeadline();
  let markUploadConsumed = () => {};
  const uploadConsumed = new Promise<void>((resolve) => { markUploadConsumed = resolve; });
  let resolveSender = (_response: { message_id: number }) => {};
  const senderResult = new Promise<{ message_id: number }>((resolve) => { resolveSender = resolve; });
  try {
    const gateway = createTelegramFileSendGateway({
      sendPhoto: async () => ({ message_id: 1 }),
      sendAnimation: async () => ({ message_id: 1 }),
      sendVideo: async (_target, input, _caption, signal) => {
        await consumeBuffer(input.source);
        markUploadConsumed();
        assert.equal(signal?.aborted, false);
        return senderResult;
      },
      sendDocument: async () => ({ message_id: 1 }),
      sendMediaGroup: async () => [{ message_id: 1 }],
      startPostUploadResponseDeadline: deadline.start,
    });

    const send = gateway.sendVideo('target', fixture.source);
    await uploadConsumed;
    await Promise.resolve();
    assert.equal(deadline.getActiveCount(), 1);
    resolveSender({ message_id: 73311 });

    assert.deepEqual(await send, { messageIds: [73311] });
    assert.equal(deadline.getActiveCount(), 0, 'a successful response must cancel its pending deadline');
  } finally {
    resolveSender({ message_id: 73311 });
    fixture.cleanup();
  }
});

linuxTest('message IDs returned at the response deadline boundary are durably recorded', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fileSendTelegram-boundary-record-'));
  const workDir = path.join(tempRoot, 'bound');
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'clip.mp4'), 'boundary-video');
  const deadline = createFakePostUploadResponseDeadline();
  let markUploadConsumed = () => {};
  const uploadConsumed = new Promise<void>((resolve) => { markUploadConsumed = resolve; });
  const recordedMessageIds: number[] = [];
  try {
    const gateway = createTelegramFileSendGateway({
      sendPhoto: async () => ({ message_id: 1 }),
      sendAnimation: async () => ({ message_id: 1 }),
      sendVideo: async (_target, input, _caption, signal) => {
        await consumeBuffer(input.source);
        markUploadConsumed();
        return new Promise((resolve) => {
          const handleAbort = () => resolve({ message_id: 73313 });
          signal?.addEventListener('abort', handleAbort, { once: true });
          if (signal?.aborted) handleAbort();
        });
      },
      sendDocument: async () => ({ message_id: 1 }),
      sendMediaGroup: async () => [{ message_id: 1 }],
      startPostUploadResponseDeadline: deadline.start,
    });
    const sendFilesToThread = createSendFilesToThread({
      resolveTargetAndWorkDir: () => ({ ok: true, target: 'target', workDir }),
      gateway,
      recordMessageIds: async (_target, messageIds) => {
        recordedMessageIds.push(...messageIds);
      },
    });

    const send = sendFilesToThread('thread-key', { paths: ['clip.mp4'] });
    await uploadConsumed;
    await Promise.resolve();
    deadline.fire();

    assert.deepEqual(await send, { ok: true, summary: 'Sent 1 file(s) to the topic.' });
    assert.deepEqual(recordedMessageIds, [73313]);
    assert.equal(deadline.getActiveCount(), 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

linuxTest('post-upload response timeout becomes delivery-unknown and releases a queued same-thread successor', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fileSendTelegram-timeout-fifo-'));
  const workDir = path.join(tempRoot, 'bound');
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'clip.mp4'), 'timed-out-video');
  const deadline = createFakePostUploadResponseDeadline();
  const key: ThreadKey = { chatId: 73312, threadId: 1 };
  const pacer = new GlobalSendPacer(1);
  pacer.enterShutdownDrain();
  __setGlobalPacerForTest(pacer);
  let markUploadConsumed = () => {};
  const uploadConsumed = new Promise<void>((resolve) => { markUploadConsumed = resolve; });
  const recordedMessageIds: number[] = [];
  let isSuccessorStarted = false;
  try {
    const gateway = createTelegramFileSendGateway({
      sendPhoto: async () => ({ message_id: 1 }),
      sendAnimation: async () => ({ message_id: 1 }),
      sendVideo: async (_target, input, _caption, signal) => {
        await consumeBuffer(input.source);
        markUploadConsumed();
        return new Promise((_resolve, reject) => {
          const handleAbort = () => {
            const abortError = new Error('Telegraf request aborted after response deadline');
            abortError.name = 'AbortError';
            reject(abortError);
          };
          signal?.addEventListener('abort', handleAbort, { once: true });
          if (signal?.aborted) handleAbort();
        });
      },
      sendDocument: async () => ({ message_id: 1 }),
      sendMediaGroup: async () => [{ message_id: 1 }],
      startPostUploadResponseDeadline: deadline.start,
    });
    const sendFilesToThread = createSendFilesToThread<ThreadKey>({
      resolveTargetAndWorkDir: () => ({ ok: true, target: key, workDir }),
      gateway,
      executeDelivery: (target, delivery, signal) => enqueueSend(target, delivery, signal),
      recordMessageIds: async (_target, messageIds) => {
        recordedMessageIds.push(...messageIds);
      },
    });

    const timedOutSend = sendFilesToThread(keyToString(key), { paths: ['clip.mp4'] });
    await uploadConsumed;
    await Promise.resolve();
    const successor = enqueueSend(key, async () => {
      isSuccessorStarted = true;
      return 'successor delivered';
    });
    await Promise.resolve();
    assert.equal(isSuccessorStarted, false, 'the successor must queue behind the active file send');

    deadline.fire();
    const timedOutResult = await timedOutSend;
    assert.equal(timedOutResult.ok, false);
    if (!timedOutResult.ok) {
      assert.equal(timedOutResult.kind, 'deliveryUnknown');
      assert.match(timedOutResult.error, /must not retry automatically/i);
    }
    assert.equal(await successor, 'successor delivered');
    assert.equal(isSuccessorStarted, true);
    assert.deepEqual(recordedMessageIds, []);
  } finally {
    __setGlobalPacerForTest(new GlobalSendPacer(1));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

linuxTest('real service preserves delivery-unknown after request-body consumption and late cancellation', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fileSendTelegram-service-late-unknown-'));
  const workDir = path.join(tempRoot, 'bound');
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'clip.mp4'), 'ambiguous-video-bytes');
  const controller = new AbortController();
  const recordedMessageIds: number[] = [];
  let attemptedStream: fs.ReadStream | null = null;
  let attemptDescriptor: number | null = null;
  let senderSignal: TelegrafAbortSignal | undefined;
  let markUploadConsumed = () => {};
  const uploadConsumed = new Promise<void>((resolve) => { markUploadConsumed = resolve; });
  let rejectSender = (_error: Error) => {};
  const senderResult = new Promise<TelegramMessageId>((_resolve, reject) => { rejectSender = reject; });

  try {
    const gateway = createTelegramFileSendGateway({
      sendPhoto: async () => ({ message_id: 1 }),
      sendAnimation: async () => ({ message_id: 1 }),
      sendVideo: async (_target, input, _caption, signal) => {
        assert.equal(input.source instanceof fs.ReadStream, true);
        if (!(input.source instanceof fs.ReadStream)) {
          assert.fail('non-empty descriptor input must use fs.ReadStream');
        }
        attemptedStream = input.source;
        attemptDescriptor = input.source.fd;
        senderSignal = signal;
        await consumeBuffer(input.source);
        markUploadConsumed();
        return senderResult;
      },
      sendDocument: async () => ({ message_id: 1 }),
      sendMediaGroup: async () => [{ message_id: 1 }],
    });
    const sendFilesToThread = createSendFilesToThread({
      resolveTargetAndWorkDir: () => ({ ok: true, target: 'target', workDir }),
      gateway,
      recordMessageIds: async (_target, messageIds) => {
        recordedMessageIds.push(...messageIds);
      },
    });

    const send = sendFilesToThread('thread-key', {
      paths: ['clip.mp4'],
      signal: controller.signal,
    });
    await uploadConsumed;
    controller.abort();
    rejectSender(new Error('connection reset while awaiting Telegram response'));

    const result = await send;

    assert.equal(senderSignal?.aborted, false, 'late cancellation must not abort Telegraf');
    assert.notEqual(attemptedStream, null);
    if (attemptedStream !== null) assertStreamsTerminal([attemptedStream]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'deliveryUnknown');
      assert.match(result.error, /may already have accepted/i);
      assert.match(result.error, /must not retry automatically/i);
    }
    assert.deepEqual(recordedMessageIds, []);
    assert.notEqual(attemptDescriptor, null);
    if (attemptDescriptor !== null) {
      assert.throws(() => fs.fstatSync(attemptDescriptor), { code: 'EBADF' });
    }
  } finally {
    rejectSender(new Error('test cleanup'));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

linuxTest('real service and Telegram gateway settle an unread rejected single attempt before retrying from byte zero', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fileSendTelegram-service-'));
  const workDir = path.join(tempRoot, 'bound');
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'clip.mp4'), 'complete-video-bytes');
  const attemptStreams: Readable[] = [];
  const recordedMessageIds: number[] = [];
  let sendAttempt = 0;
  const rateLimitError = {
    response: {
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: 1 },
    },
  };
  try {
    const gateway = createTelegramFileSendGateway({
      sendPhoto: async () => ({ message_id: 1 }),
      sendAnimation: async () => ({ message_id: 1 }),
      sendVideo: async (_target, input) => {
        sendAttempt += 1;
        attemptStreams.push(input.source);
        if (sendAttempt === 1) throw rateLimitError;
        assert.equal(
          (await consumeBuffer(input.source)).toString('utf8'),
          'complete-video-bytes',
          'the retry must start at byte zero and consume the complete snapshot',
        );
        return { message_id: 501 };
      },
      sendDocument: async () => ({ message_id: 1 }),
      sendMediaGroup: async () => [{ message_id: 1 }],
    });
    const executeDelivery: SendFilesToThreadDeps<string>['executeDelivery'] = async (_target, delivery) => {
        try {
          return await delivery();
        } catch (error) {
          assert.equal(error, rateLimitError);
          assert.equal(attemptStreams.length, 1);
          assertStreamsTerminal(attemptStreams);
          return delivery();
        }
    };
    const sendFilesToThread = createSendFilesToThread({
      resolveTargetAndWorkDir: () => ({ ok: true, target: 'target', workDir }),
      gateway,
      recordMessageIds: async (_target, messageIds) => {
        recordedMessageIds.push(...messageIds);
      },
      executeDelivery,
    });

    const result = await sendFilesToThread('thread-key', { paths: ['clip.mp4'] });

    assert.deepEqual(result, { ok: true, summary: 'Sent 1 file(s) to the topic.' });
    assert.equal(sendAttempt, 2);
    assert.equal(new Set(attemptStreams).size, 2, 'the retry must receive a fresh stream');
    assertStreamsTerminal(attemptStreams);
    assert.deepEqual(recordedMessageIds, [501]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

linuxTest('real service and Telegram gateway settle every unread album stream before retrying all items from byte zero', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fileSendTelegram-album-'));
  const workDir = path.join(tempRoot, 'bound');
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'chart.png'), 'complete-photo-bytes');
  fs.writeFileSync(path.join(workDir, 'clip.mp4'), 'complete-video-bytes');
  const attemptStreams: Readable[][] = [];
  const recordedMessageIds: number[] = [];
  let sendAttempt = 0;
  const rateLimitError = {
    response: {
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: 1 },
    },
  };
  try {
    const gateway = createTelegramFileSendGateway({
      sendPhoto: async () => ({ message_id: 1 }),
      sendAnimation: async () => ({ message_id: 1 }),
      sendVideo: async () => ({ message_id: 1 }),
      sendDocument: async () => ({ message_id: 1 }),
      sendMediaGroup: async (_target, mediaGroup) => {
        sendAttempt += 1;
        const streams = mediaGroup.map((entry) => entry.media.source);
        attemptStreams.push(streams);
        if (sendAttempt === 1) throw rateLimitError;
        assert.deepEqual(
          await Promise.all(streams.map((stream) => consumeBuffer(stream))),
          [Buffer.from('complete-photo-bytes'), Buffer.from('complete-video-bytes')],
          'every retry item must start at byte zero and consume its complete snapshot',
        );
        return [{ message_id: 601 }, { message_id: 602 }];
      },
    });
    const executeDelivery: SendFilesToThreadDeps<string>['executeDelivery'] = async (_target, delivery) => {
        try {
          return await delivery();
        } catch (error) {
          assert.equal(error, rateLimitError);
          assert.equal(attemptStreams.length, 1);
          assertStreamsTerminal(attemptStreams[0]);
          return delivery();
        }
    };
    const sendFilesToThread = createSendFilesToThread({
      resolveTargetAndWorkDir: () => ({ ok: true, target: 'target', workDir }),
      gateway,
      recordMessageIds: async (_target, messageIds) => {
        recordedMessageIds.push(...messageIds);
      },
      executeDelivery,
    });

    const result = await sendFilesToThread('thread-key', {
      paths: ['chart.png', 'clip.mp4'],
    });

    assert.deepEqual(result, { ok: true, summary: 'Sent 2 file(s) to the topic.' });
    assert.equal(sendAttempt, 2);
    assert.equal(
      new Set(attemptStreams.flat()).size,
      4,
      'each item in each attempt must receive a distinct stream',
    );
    assertStreamsTerminal(attemptStreams.flat());
    assert.deepEqual(recordedMessageIds, [601, 602]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('getTelegramMessageIds extracts one id or every media-group id in order', () => {
  assert.deepEqual(getTelegramMessageIds({ message_id: 41 }), [41]);
  assert.deepEqual(
    getTelegramMessageIds([{ message_id: 51 }, { message_id: 52 }]),
    [51, 52],
  );
});

test('bot file-send composition uses the runtime-tested gateway factory and records returned ids', () => {
  const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');
  const compositionStart = botSource.indexOf('const sendFilesToThread = createSendFilesToThread');
  const compositionEnd = botSource.indexOf('\n/**', compositionStart);
  const compositionSource = botSource.slice(compositionStart, compositionEnd);

  assert.ok(compositionStart >= 0, 'file-send production composition must exist');
  assert.match(compositionSource, /gateway: createTelegramFileSendGateway/);
  assert.match(
    compositionSource,
    /executeDelivery:\s*\(key,\s*delivery,\s*signal\)\s*=>\s*enqueueSend\(key,\s*delivery,\s*signal\)/,
  );
  assert.equal(
    compositionSource.match(/\{ signal \}/g)?.length,
    5,
    'every Bot API file method must receive the request abort signal',
  );
  assert.match(compositionSource, /recordMessageIds[^]*state\.pushMessageIds/);
  assert.doesNotMatch(compositionSource, /executeSend:/);
  assert.match(botSource, /state\.takeMessageIds\(key,\s*messageIds\)/);
});
