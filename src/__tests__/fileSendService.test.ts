/**
 * @description Service-level coverage for the agent-to-Telegram file-send
 * pipeline. Real temp files prove identity-checked descriptor snapshots, all
 * five gateway routes, message-id recording, descriptor cleanup, size
 * enforcement, bounded concurrent descriptor ownership, Linux-only secure
 * traversal, and root/final/parent/FIFO path-swap defenses.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { mock, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  createSendFilesToThread,
  FileSendDeliveryUnknownError,
  fileSendSnapshotConcurrency,
  getFileDescriptorPathRoot,
  readTelegramFileSnapshot,
  type FileSendGateway,
  type PinnedFileSendRoot,
  type SendFilesToThreadResult,
  type SendFilesToThreadDeps,
} from '../utils/fileSendService';
import {
  telegramSendMaxBytes,
  type TelegramSingleFileSendMethod,
} from '../utils/fileSendPlan';
import {
  createFileSendTestRecorderGateway,
  type RecordedFileSendGatewayCall,
  type RecordedFileSendMethod,
} from './fileSendTestRecorder';

interface RecordedMessageIds {
  target: string;
  messageIds: number[];
}

interface ServiceRecorder {
  gatewayCalls: Array<RecordedFileSendGatewayCall<string>>;
  capturedFileDescriptors: number[];
  messageIdCalls: RecordedMessageIds[];
}

interface TempFileSendFixture {
  tempRoot: string;
  workDir: string;
  cleanup: () => void;
}

interface ServiceOptions {
  resolveTargetAndWorkDir?: SendFilesToThreadDeps<string>['resolveTargetAndWorkDir'];
  readFileSnapshot?: SendFilesToThreadDeps<string>['readFileSnapshot'];
  recordMessageIds?: SendFilesToThreadDeps<string>['recordMessageIds'];
  executeDelivery?: SendFilesToThreadDeps<string>['executeDelivery'];
  gateway?: FileSendGateway<string>;
  rejectedMethod?: RecordedFileSendMethod;
}

interface SingleGatewayCase {
  fileName: string;
  contents: string;
  expectedMethod: TelegramSingleFileSendMethod;
  expectedMessageId: number;
}

const singleGatewayMessageIds: Record<TelegramSingleFileSendMethod, number> = {
  sendPhoto: 101,
  sendAnimation: 102,
  sendVideo: 103,
  sendDocument: 104,
};

const albumMessageIds = [201, 202];
const fifoSnapshotChildTimeoutMs = 5_000;
const linuxTest = process.platform === 'linux' ? test : test.skip;
const nonLinuxTest = process.platform === 'linux' ? test.skip : test;

function createTempFileSendFixture(): TempFileSendFixture {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fileSendService-'));
  const workDir = path.join(tempRoot, 'bound');
  fs.mkdirSync(workDir);
  return {
    tempRoot,
    workDir,
    cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
  };
}

function createServiceRecorder(): ServiceRecorder {
  return {
    gatewayCalls: [],
    capturedFileDescriptors: [],
    messageIdCalls: [],
  };
}

function createRecordingGateway(
  recorder: ServiceRecorder,
  rejectedMethod?: RecordedFileSendMethod,
): FileSendGateway<string> {
  return createFileSendTestRecorderGateway(recorder.gatewayCalls, {
    singleMessageIds: singleGatewayMessageIds,
    albumMessageIds,
    capturedFileDescriptors: recorder.capturedFileDescriptors,
    ...(rejectedMethod !== undefined ? { rejectedMethod } : {}),
  });
}

function createService(
  workDir: string,
  recorder: ServiceRecorder,
  options: ServiceOptions = {},
) {
  const defaultResolver: SendFilesToThreadDeps<string>['resolveTargetAndWorkDir'] = () => ({
    ok: true,
    target: 'telegram-target',
    workDir,
  });
  return createSendFilesToThread({
    resolveTargetAndWorkDir: options.resolveTargetAndWorkDir ?? defaultResolver,
    gateway: options.gateway ?? createRecordingGateway(recorder, options.rejectedMethod),
    recordMessageIds: options.recordMessageIds ?? (async (target, messageIds) => {
      recorder.messageIdCalls.push({ target, messageIds: [...messageIds] });
    }),
    ...(options.executeDelivery !== undefined
      ? { executeDelivery: options.executeDelivery }
      : {}),
    ...(options.readFileSnapshot !== undefined
      ? { readFileSnapshot: options.readFileSnapshot }
      : {}),
  });
}

function assertFileDescriptorClosed(fileDescriptor: number): void {
  assert.throws(() => fs.fstatSync(fileDescriptor), { code: 'EBADF' });
}

const singleGatewayCases: SingleGatewayCase[] = [
  {
    fileName: 'chart.png',
    contents: 'photo-bytes',
    expectedMethod: 'sendPhoto',
    expectedMessageId: singleGatewayMessageIds.sendPhoto,
  },
  {
    fileName: 'loop.gif',
    contents: 'animation-bytes',
    expectedMethod: 'sendAnimation',
    expectedMessageId: singleGatewayMessageIds.sendAnimation,
  },
  {
    fileName: 'clip.mp4',
    contents: 'video-bytes',
    expectedMethod: 'sendVideo',
    expectedMessageId: singleGatewayMessageIds.sendVideo,
  },
  {
    fileName: 'report.pdf',
    contents: 'document-bytes',
    expectedMethod: 'sendDocument',
    expectedMessageId: singleGatewayMessageIds.sendDocument,
  },
];

for (const gatewayCase of singleGatewayCases) {
  linuxTest(`createSendFilesToThread routes ${gatewayCase.fileName} through ${gatewayCase.expectedMethod}, records its message id, and closes its descriptor`, async () => {
    const fixture = createTempFileSendFixture();
    const recorder = createServiceRecorder();
    try {
      fs.writeFileSync(path.join(fixture.workDir, gatewayCase.fileName), gatewayCase.contents);
      const sendFilesToThread = createService(fixture.workDir, recorder);

      const result = await sendFilesToThread('thread-key', {
        paths: [gatewayCase.fileName],
        caption: 'caption',
      });

      assert.deepEqual(result, { ok: true, summary: 'Sent 1 file(s) to the topic.' });
      assert.equal(recorder.gatewayCalls.length, 1);
      assert.deepEqual(recorder.gatewayCalls[0], {
        method: gatewayCase.expectedMethod,
        target: 'telegram-target',
        source: {
          filename: gatewayCase.fileName,
          sizeBytes: Buffer.byteLength(gatewayCase.contents),
          contents: gatewayCase.contents,
        },
        caption: 'caption',
      });
      assert.deepEqual(recorder.messageIdCalls, [
        { target: 'telegram-target', messageIds: [gatewayCase.expectedMessageId] },
      ]);
      assertFileDescriptorClosed(recorder.capturedFileDescriptors[0]);
    } finally {
      fixture.cleanup();
    }
  });
}

linuxTest('createSendFilesToThread routes a photo/video album, records every id, and closes every descriptor', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  try {
    fs.writeFileSync(path.join(fixture.workDir, 'chart.png'), 'photo-bytes');
    fs.writeFileSync(path.join(fixture.workDir, 'clip.mp4'), 'video-bytes');
    const sendFilesToThread = createService(fixture.workDir, recorder);

    const result = await sendFilesToThread('thread-key', {
      paths: ['chart.png', 'clip.mp4'],
      caption: 'album caption',
    });

    assert.deepEqual(result, { ok: true, summary: 'Sent 2 file(s) to the topic.' });
    assert.deepEqual(recorder.gatewayCalls, [
      {
        method: 'sendMediaGroup',
        target: 'telegram-target',
        mediaGroup: {
          kind: 'photoVideo',
          media: [
            {
              type: 'photo',
              media: {
                filename: 'chart.png',
                sizeBytes: Buffer.byteLength('photo-bytes'),
                contents: 'photo-bytes',
              },
              caption: 'album caption',
            },
            {
              type: 'video',
              media: {
                filename: 'clip.mp4',
                sizeBytes: Buffer.byteLength('video-bytes'),
                contents: 'video-bytes',
              },
            },
          ],
        },
      },
    ]);
    assert.deepEqual(recorder.messageIdCalls, [
      { target: 'telegram-target', messageIds: albumMessageIds },
    ]);
    for (const fileDescriptor of recorder.capturedFileDescriptors) {
      assertFileDescriptorClosed(fileDescriptor);
    }
  } finally {
    fixture.cleanup();
  }
});

test('createSendFilesToThread returns a typed resolver failure without calling the gateway', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  try {
    const sendFilesToThread = createService(fixture.workDir, recorder, {
      resolveTargetAndWorkDir: () => ({ ok: false, error: 'thread is not bound' }),
    });

    assert.deepEqual(await sendFilesToThread('thread-key', { paths: ['unused.txt'] }), {
      ok: false,
      error: 'thread is not bound',
    });
    assert.deepEqual(recorder.gatewayCalls, []);
    assert.deepEqual(recorder.messageIdCalls, []);
  } finally {
    fixture.cleanup();
  }
});

test('createSendFilesToThread converts a resolver throw into a typed failure', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  try {
    const sendFilesToThread = createService(fixture.workDir, recorder, {
      resolveTargetAndWorkDir: () => {
        throw new Error('resolver exploded');
      },
    });

    assert.deepEqual(await sendFilesToThread('thread-key', { paths: ['unused.txt'] }), {
      ok: false,
      error: 'resolver exploded',
    });
    assert.deepEqual(recorder.gatewayCalls, []);
    assert.deepEqual(recorder.messageIdCalls, []);
  } finally {
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread converts a gateway rejection into a typed failure and closes its descriptor', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  try {
    fs.writeFileSync(path.join(fixture.workDir, 'clip.mp4'), 'video-bytes');
    const sendFilesToThread = createService(fixture.workDir, recorder, {
      rejectedMethod: 'sendVideo',
    });

    assert.deepEqual(await sendFilesToThread('thread-key', { paths: ['clip.mp4'] }), {
      ok: false,
      error: 'gateway rejected sendVideo',
    });
    assert.equal(recorder.gatewayCalls.length, 1);
    assert.equal(recorder.gatewayCalls[0].method, 'sendVideo');
    assert.deepEqual(recorder.messageIdCalls, []);
    assertFileDescriptorClosed(recorder.capturedFileDescriptors[0]);
  } finally {
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread waits for message-id recording before reporting success', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  let releaseMessageIdRecording = () => {};
  let markMessageIdRecordingStarted = () => {};
  const messageIdRecordingStarted = new Promise<void>((resolve) => {
    markMessageIdRecordingStarted = resolve;
  });
  const messageIdRecordingGate = new Promise<void>((resolve) => {
    releaseMessageIdRecording = resolve;
  });
  try {
    fs.writeFileSync(path.join(fixture.workDir, 'clip.mp4'), 'video-bytes');
    const sendFilesToThread = createService(fixture.workDir, recorder, {
      recordMessageIds: async (target, messageIds) => {
        recorder.messageIdCalls.push({ target, messageIds: [...messageIds] });
        markMessageIdRecordingStarted();
        await messageIdRecordingGate;
      },
    });

    let didSettle = false;
    const sendPromise = sendFilesToThread('thread-key', { paths: ['clip.mp4'] });
    void sendPromise.then(() => {
      didSettle = true;
    });
    await messageIdRecordingStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(didSettle, false, 'the service must await message-id persistence');

    releaseMessageIdRecording();
    assert.deepEqual(await sendPromise, { ok: true, summary: 'Sent 1 file(s) to the topic.' });
    assert.deepEqual(recorder.messageIdCalls, [
      { target: 'telegram-target', messageIds: [singleGatewayMessageIds.sendVideo] },
    ]);
    assertFileDescriptorClosed(recorder.capturedFileDescriptors[0]);
  } finally {
    releaseMessageIdRecording();
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread keeps the target delivery executor occupied until message IDs are recorded', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  let releaseFirstRecording = () => {};
  let markFirstRecordingStarted = () => {};
  const firstRecordingStarted = new Promise<void>((resolve) => {
    markFirstRecordingStarted = resolve;
  });
  const firstRecordingGate = new Promise<void>((resolve) => {
    releaseFirstRecording = resolve;
  });
  let deliveryTail = Promise.resolve();
  let recordingCount = 0;
  try {
    fs.writeFileSync(path.join(fixture.workDir, 'clip.mp4'), 'video-bytes');
    const sendFilesToThread = createService(fixture.workDir, recorder, {
      executeDelivery: (_target, delivery) => {
        const result = deliveryTail.then(delivery);
        deliveryTail = result.then(() => {}, () => {});
        return result;
      },
      recordMessageIds: async (target, messageIds) => {
        recorder.messageIdCalls.push({ target, messageIds: [...messageIds] });
        recordingCount += 1;
        if (recordingCount === 1) {
          markFirstRecordingStarted();
          await firstRecordingGate;
        }
      },
    });

    const firstSend = sendFilesToThread('thread-key', { paths: ['clip.mp4'] });
    await firstRecordingStarted;
    const secondSend = sendFilesToThread('thread-key', { paths: ['clip.mp4'] });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(
      recorder.gatewayCalls.length,
      1,
      'the second delivery must stay queued while the first delivery records its IDs',
    );

    releaseFirstRecording();
    assert.deepEqual(await firstSend, { ok: true, summary: 'Sent 1 file(s) to the topic.' });
    assert.deepEqual(await secondSend, { ok: true, summary: 'Sent 1 file(s) to the topic.' });
    assert.equal(recorder.gatewayCalls.length, 2);
    assert.equal(recorder.messageIdCalls.length, 2);
  } finally {
    releaseFirstRecording();
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread reports delivery-unknown without retrying or recording message IDs', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  const recordingGateway = createRecordingGateway(recorder);
  let sendAttempts = 0;
  try {
    fs.writeFileSync(path.join(fixture.workDir, 'clip.mp4'), 'video-bytes');
    const gateway: FileSendGateway<string> = {
      ...recordingGateway,
      sendVideo: async () => {
        sendAttempts += 1;
        throw new FileSendDeliveryUnknownError(new Error('connection reset after upload'));
      },
    };
    const sendFilesToThread = createService(fixture.workDir, recorder, { gateway });

    const result = await sendFilesToThread('thread-key', { paths: ['clip.mp4'] });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'deliveryUnknown');
      assert.match(result.error, /may already have accepted/i);
      assert.match(result.error, /must not retry automatically/i);
    }
    assert.equal(sendAttempts, 1);
    assert.deepEqual(recorder.messageIdCalls, []);
  } finally {
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread keeps delivery successful when message-id recording rejects', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  const attemptedRecordings: RecordedMessageIds[] = [];
  try {
    fs.writeFileSync(path.join(fixture.workDir, 'clip.mp4'), 'delivered-video');
    const sendFilesToThread = createService(fixture.workDir, recorder, {
      recordMessageIds: async (target, messageIds) => {
        attemptedRecordings.push({ target, messageIds: [...messageIds] });
        throw new Error('state write failed');
      },
    });

    const result = await sendFilesToThread('thread-key', { paths: ['clip.mp4'] });

    assert.equal(recorder.gatewayCalls.length, 1, 'the delivered message must not be retried');
    assert.deepEqual(recorder.gatewayCalls[0], {
      method: 'sendVideo',
      target: 'telegram-target',
      source: {
        filename: 'clip.mp4',
        sizeBytes: Buffer.byteLength('delivered-video'),
        contents: 'delivered-video',
      },
    });
    assert.deepEqual(attemptedRecordings, [
      { target: 'telegram-target', messageIds: [singleGatewayMessageIds.sendVideo] },
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.match(result.summary, /^Sent 1 file\(s\) to the topic\./);
      assert.match(result.summary, /delivery succeeded.*message IDs could not be recorded.*state write failed/i);
    }
    assertFileDescriptorClosed(recorder.capturedFileDescriptors[0]);
  } finally {
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread keeps delivery successful when root-descriptor cleanup fails', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  const originalCloseSync = fs.closeSync;
  const mutableFs: typeof fs = require('fs');
  let rootDescriptor: number | null = null;
  const closeSyncMock = mock.method(mutableFs, 'closeSync', (fileDescriptor: number) => {
    if (fileDescriptor === rootDescriptor) throw new Error('forced root close failure');
    originalCloseSync(fileDescriptor);
  });
  try {
    fs.writeFileSync(path.join(fixture.workDir, 'clip.mp4'), 'delivered-video');
    const sendFilesToThread = createService(fixture.workDir, recorder, {
      readFileSnapshot: (canonicalPath, expectedIdentity, pinnedRoot) => {
        rootDescriptor = pinnedRoot.fd;
        return readTelegramFileSnapshot(canonicalPath, expectedIdentity, pinnedRoot);
      },
    });

    const result = await sendFilesToThread('thread-key', { paths: ['clip.mp4'] });

    assert.equal(recorder.gatewayCalls.length, 1, 'the delivered message must not be retried');
    assert.deepEqual(recorder.messageIdCalls, [
      { target: 'telegram-target', messageIds: [singleGatewayMessageIds.sendVideo] },
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.match(result.summary, /^Sent 1 file\(s\) to the topic\./);
      assert.match(result.summary, /delivery succeeded.*descriptor cleanup failed.*forced root close failure/i);
    }
    assertFileDescriptorClosed(recorder.capturedFileDescriptors[0]);
    assert.notEqual(rootDescriptor, null);
    if (rootDescriptor !== null) {
      assert.equal(fs.fstatSync(rootDescriptor).isDirectory(), true, 'the forced failure must leave the root descriptor open');
    }
  } finally {
    closeSyncMock.mock.restore();
    if (rootDescriptor !== null) originalCloseSync(rootDescriptor);
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread closes an earlier descriptor when a later snapshot fails', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  const openedFileDescriptors: number[] = [];
  try {
    fs.writeFileSync(path.join(fixture.workDir, 'first.txt'), 'first-bytes');
    fs.writeFileSync(path.join(fixture.workDir, 'second.txt'), 'second-bytes');
    const sendFilesToThread = createService(fixture.workDir, recorder, {
      readFileSnapshot: (canonicalPath, expectedIdentity, pinnedRoot) => {
        if (path.basename(canonicalPath) === 'second.txt') {
          return { ok: false, kind: 'read', error: 'second snapshot failed' };
        }
        const snapshot = readTelegramFileSnapshot(canonicalPath, expectedIdentity, pinnedRoot);
        if (snapshot.ok) openedFileDescriptors.push(snapshot.source.fd);
        return snapshot;
      },
    });

    assert.deepEqual(
      await sendFilesToThread('thread-key', { paths: ['first.txt', 'second.txt'] }),
      { ok: false, error: 'cannot read second.txt: second snapshot failed' },
    );
    assert.equal(openedFileDescriptors.length, 1);
    assertFileDescriptorClosed(openedFileDescriptors[0]);
    assert.deepEqual(recorder.gatewayCalls, []);
    assert.deepEqual(recorder.messageIdCalls, []);
  } finally {
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread rejects an oversize file before gateway dispatch', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  try {
    const filePath = path.join(fixture.workDir, 'huge.bin');
    fs.writeFileSync(filePath, 'x');
    fs.truncateSync(filePath, telegramSendMaxBytes + 1);
    const sendFilesToThread = createService(fixture.workDir, recorder);

    assert.deepEqual(await sendFilesToThread('thread-key', { paths: ['huge.bin'] }), {
      ok: false,
      error: `file exceeds the 50 MB send limit: ${fs.realpathSync(filePath)}`,
    });
    assert.deepEqual(recorder.gatewayCalls, []);
    assert.deepEqual(recorder.messageIdCalls, []);
  } finally {
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread bounds descriptor ownership while later sends wait', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  let snapshotCallCount = 0;
  let gatewayCallCount = 0;
  let markSnapshotLimitReached = () => {};
  let releaseGatewayCalls = () => {};
  const snapshotLimitReached = new Promise<void>((resolve) => {
    markSnapshotLimitReached = resolve;
  });
  const gatewayGate = new Promise<void>((resolve) => {
    releaseGatewayCalls = resolve;
  });
  try {
    fs.writeFileSync(path.join(fixture.workDir, 'clip.mp4'), 'video-bytes');
    const recordingGateway = createRecordingGateway(recorder);
    const blockingGateway: FileSendGateway<string> = {
      ...recordingGateway,
      sendVideo: async (target, source, caption) => {
        const result = await recordingGateway.sendVideo(target, source, caption);
        gatewayCallCount += 1;
        if (gatewayCallCount === fileSendSnapshotConcurrency) {
          markSnapshotLimitReached();
        }
        await gatewayGate;
        return result;
      },
    };
    const sendFilesToThread = createSendFilesToThread({
      resolveTargetAndWorkDir: () => ({
        ok: true,
        target: 'telegram-target',
        workDir: fixture.workDir,
      }),
      gateway: blockingGateway,
      recordMessageIds: async (target, messageIds) => {
        recorder.messageIdCalls.push({ target, messageIds: [...messageIds] });
      },
      readFileSnapshot: (canonicalPath, expectedIdentity, pinnedRoot) => {
        snapshotCallCount += 1;
        return readTelegramFileSnapshot(canonicalPath, expectedIdentity, pinnedRoot);
      },
    });

    const sendPromises = Array.from(
      { length: fileSendSnapshotConcurrency + 1 },
      () => sendFilesToThread('thread-key', { paths: ['clip.mp4'] }),
    );
    await snapshotLimitReached;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const snapshotCallCountWhileSaturated = snapshotCallCount;
    releaseGatewayCalls();
    const results = await Promise.all(sendPromises);

    assert.equal(snapshotCallCountWhileSaturated, fileSendSnapshotConcurrency);
    assert.equal(snapshotCallCount, fileSendSnapshotConcurrency + 1);
    assert.equal(results.every((result) => result.ok), true);
    for (const fileDescriptor of recorder.capturedFileDescriptors) {
      assertFileDescriptorClosed(fileDescriptor);
    }
  } finally {
    releaseGatewayCalls();
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread removes an aborted snapshot waiter without delaying the next waiter', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  const initialTargets = Array.from(
    { length: fileSendSnapshotConcurrency },
    (_, index) => `initial-${index.toString()}`,
  );
  const canceledTarget = 'queued-canceled';
  const survivorTarget = 'queued-survivor';
  const startedTargets: string[] = [];
  const initialStartedResolvers = new Map<string, () => void>();
  const initialStartedPromises = new Map<string, Promise<void>>();
  let markSurvivorStarted = () => {};
  const survivorStarted = new Promise<void>((resolve) => { markSurvivorStarted = resolve; });
  let releaseInitial = () => {};
  const initialGate = new Promise<void>((resolve) => { releaseInitial = resolve; });
  const sendPromises: Array<Promise<SendFilesToThreadResult>> = [];
  const canceledController = new AbortController();

  for (const target of initialTargets) {
    let markStarted = () => {};
    initialStartedPromises.set(target, new Promise<void>((resolve) => { markStarted = resolve; }));
    initialStartedResolvers.set(target, markStarted);
  }

  try {
    fs.writeFileSync(path.join(fixture.workDir, 'clip.mp4'), 'video-bytes');
    const recordingGateway = createRecordingGateway(recorder);
    const blockingGateway: FileSendGateway<string> = {
      ...recordingGateway,
      sendVideo: async (target, source, caption, signal) => {
        const result = await recordingGateway.sendVideo(target, source, caption, signal);
        startedTargets.push(target);
        initialStartedResolvers.get(target)?.();
        if (target === survivorTarget) markSurvivorStarted();
        if (initialTargets.includes(target)) await initialGate;
        return result;
      },
    };
    const sendFilesToThread = createSendFilesToThread({
      resolveTargetAndWorkDir: (threadKey) => ({
        ok: true,
        target: threadKey,
        workDir: fixture.workDir,
      }),
      gateway: blockingGateway,
      recordMessageIds: async () => {},
    });

    for (const target of initialTargets) {
      sendPromises.push(sendFilesToThread(target, { paths: ['clip.mp4'] }));
    }
    await Promise.all(initialTargets.map((target) => initialStartedPromises.get(target)));

    const canceledSend = sendFilesToThread(canceledTarget, {
      paths: ['clip.mp4'],
      signal: canceledController.signal,
    });
    const survivorSend = sendFilesToThread(survivorTarget, { paths: ['clip.mp4'] });
    sendPromises.push(survivorSend);
    canceledController.abort();

    await assert.rejects(canceledSend, { name: 'AbortError' });
    releaseInitial();
    await survivorStarted;
    assert.equal(startedTargets.includes(canceledTarget), false, 'the canceled waiter must never reach the gateway');
    assert.equal(startedTargets.includes(survivorTarget), true, 'the next live waiter must inherit the released slot');
    await Promise.all(sendPromises);
  } finally {
    releaseInitial();
    await Promise.allSettled(sendPromises);
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread refuses a queued directory-scoped send after the thread is rebound', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  const replacementWorkDir = path.join(fixture.tempRoot, 'replacement');
  fs.mkdirSync(replacementWorkDir);
  fs.writeFileSync(path.join(fixture.workDir, 'clip.mp4'), 'authorized-video');
  fs.writeFileSync(path.join(replacementWorkDir, 'clip.mp4'), 'replacement-video');
  const initialTargets = Array.from(
    { length: fileSendSnapshotConcurrency },
    (_, index) => `initial-${index.toString()}`,
  );
  let currentWorkDir = fixture.workDir;
  let activeInitialCount = 0;
  let markSnapshotLimitReached = () => {};
  const snapshotLimitReached = new Promise<void>((resolve) => { markSnapshotLimitReached = resolve; });
  let releaseInitial = () => {};
  const initialGate = new Promise<void>((resolve) => { releaseInitial = resolve; });
  const sendPromises: Array<Promise<SendFilesToThreadResult>> = [];

  try {
    const recordingGateway = createRecordingGateway(recorder);
    const blockingGateway: FileSendGateway<string> = {
      ...recordingGateway,
      sendVideo: async (target, source, caption, signal) => {
        const result = await recordingGateway.sendVideo(target, source, caption, signal);
        if (initialTargets.includes(target)) {
          activeInitialCount += 1;
          if (activeInitialCount === fileSendSnapshotConcurrency) markSnapshotLimitReached();
          await initialGate;
        }
        return result;
      },
    };
    const sendFilesToThread = createSendFilesToThread({
      resolveTargetAndWorkDir: (threadKey) => ({
        ok: true,
        target: threadKey,
        workDir: initialTargets.includes(threadKey) ? fixture.workDir : currentWorkDir,
      }),
      gateway: blockingGateway,
      recordMessageIds: async () => {},
    });

    for (const target of initialTargets) {
      sendPromises.push(sendFilesToThread(target, { paths: ['clip.mp4'] }));
    }
    await snapshotLimitReached;

    const scopedSend = sendFilesToThread('directory-scoped', {
      paths: ['clip.mp4'],
      authorizedWorkDir: fixture.workDir,
    });
    currentWorkDir = replacementWorkDir;
    releaseInitial();

    const result = await scopedSend;
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /no longer bound to the authorized directory/i);
    assert.equal(
      recorder.gatewayCalls.some((call) => call.target === 'directory-scoped'),
      false,
      'replacement-directory bytes must never reach the gateway',
    );
    await Promise.all(sendPromises);
  } finally {
    releaseInitial();
    await Promise.allSettled(sendPromises);
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread revalidates a directory-scoped binding inside the delivery queue', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  const replacementWorkDir = path.join(fixture.tempRoot, 'replacement');
  fs.mkdirSync(replacementWorkDir);
  fs.writeFileSync(path.join(fixture.workDir, 'clip.mp4'), 'authorized-video');
  fs.writeFileSync(path.join(replacementWorkDir, 'clip.mp4'), 'replacement-video');
  let currentWorkDir = fixture.workDir;
  let resolutionCount = 0;
  let markDeliveryQueued = () => {};
  let releaseDelivery = () => {};
  const deliveryQueued = new Promise<void>((resolve) => { markDeliveryQueued = resolve; });
  const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });

  try {
    const sendFilesToThread = createService(fixture.workDir, recorder, {
      resolveTargetAndWorkDir: () => {
        resolutionCount += 1;
        return {
          ok: true,
          target: currentWorkDir === fixture.workDir ? 'authorized-target' : 'replacement-target',
          workDir: currentWorkDir,
        };
      },
      executeDelivery: async (_target, delivery) => {
        markDeliveryQueued();
        await deliveryGate;
        return delivery();
      },
    });

    const scopedSend = sendFilesToThread('directory-scoped', {
      paths: ['clip.mp4'],
      authorizedWorkDir: fixture.workDir,
    });
    await deliveryQueued;
    currentWorkDir = replacementWorkDir;
    releaseDelivery();

    const result = await scopedSend;
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /no longer bound to the authorized directory/i);
    assert.equal(resolutionCount, 2, 'the binding must be resolved before opening and again before dispatch');
    assert.deepEqual(recorder.gatewayCalls, [], 'neither authorized nor replacement bytes may dispatch after rebind');
    assert.deepEqual(recorder.messageIdCalls, []);
  } finally {
    releaseDelivery();
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread sanitizes unsafe multipart filename characters reached through a safe symlink', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  const unsafeFileName = 'unsafe\r\n\x7f"\\name.txt';
  const unsafePath = path.join(fixture.workDir, unsafeFileName);
  try {
    fs.writeFileSync(unsafePath, 'safe-contents');
    fs.symlinkSync(unsafePath, path.join(fixture.workDir, 'safe-alias.txt'));
    const sendFilesToThread = createService(fixture.workDir, recorder);

    const result = await sendFilesToThread('thread-key', { paths: ['safe-alias.txt'] });

    assert.deepEqual(result, { ok: true, summary: 'Sent 1 file(s) to the topic.' });
    assert.equal(recorder.gatewayCalls.length, 1);
    assert.equal(recorder.gatewayCalls[0].source?.filename, 'unsafe_____name.txt');
    assert.equal(recorder.gatewayCalls[0].source?.contents, 'safe-contents');
  } finally {
    fixture.cleanup();
  }
});

test('getFileDescriptorPathRoot fails closed outside Linux descriptor traversal', () => {
  assert.equal(getFileDescriptorPathRoot('linux'), '/proc/self/fd');
  assert.equal(getFileDescriptorPathRoot('darwin'), null);
  assert.equal(getFileDescriptorPathRoot('win32'), null);
});

nonLinuxTest('createSendFilesToThread returns an unsupported-platform failure without delivery side effects', async () => {
  const recorder = createServiceRecorder();
  const sendFilesToThread = createSendFilesToThread({
    resolveTargetAndWorkDir: () => ({
      ok: true,
      target: 'telegram-target',
      workDir: process.cwd(),
    }),
    gateway: createRecordingGateway(recorder),
    recordMessageIds: async (target, messageIds) => {
      recorder.messageIdCalls.push({ target, messageIds: [...messageIds] });
    },
  });

  const result = await sendFilesToThread('thread-key', { paths: ['unused.txt'] });

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /secure file sending is unsupported/i);
  assert.deepEqual(recorder.gatewayCalls, []);
  assert.deepEqual(recorder.messageIdCalls, []);
});

linuxTest('createSendFilesToThread admits queued sends in FIFO order and releases a rejected slot', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  const initialTargets = Array.from(
    { length: fileSendSnapshotConcurrency },
    (_, index) => `initial-${index.toString()}`,
  );
  const rejectingTarget = 'queued-rejecting';
  const secondQueuedTarget = 'queued-second';
  const thirdQueuedTarget = 'queued-third';
  const allTargets = [
    ...initialTargets,
    rejectingTarget,
    secondQueuedTarget,
    thirdQueuedTarget,
  ];
  const blockingTargets = [...initialTargets, secondQueuedTarget];
  const gatewayStartOrder: string[] = [];
  const targetStartedPromises = new Map<string, Promise<void>>();
  const markTargetStarted = new Map<string, () => void>();
  const gatewayCompletionPromises = new Map<string, Promise<void>>();
  const releaseGatewayCompletion = new Map<string, () => void>();
  const sendPromises: Array<Promise<SendFilesToThreadResult>> = [];

  for (const target of allTargets) {
    let markStarted = () => {};
    targetStartedPromises.set(target, new Promise<void>((resolve) => {
      markStarted = resolve;
    }));
    markTargetStarted.set(target, markStarted);
  }
  for (const target of blockingTargets) {
    let releaseCompletion = () => {};
    gatewayCompletionPromises.set(target, new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    }));
    releaseGatewayCompletion.set(target, releaseCompletion);
  }

  try {
    fs.writeFileSync(path.join(fixture.workDir, 'clip.mp4'), 'video-bytes');
    const recordingGateway = createRecordingGateway(recorder);
    const orderedGateway: FileSendGateway<string> = {
      ...recordingGateway,
      sendVideo: async (target, source, caption) => {
        const result = await recordingGateway.sendVideo(target, source, caption);
        gatewayStartOrder.push(target);
        markTargetStarted.get(target)?.();
        if (target === rejectingTarget) throw new Error('queued gateway rejection');
        const completionPromise = gatewayCompletionPromises.get(target);
        if (completionPromise !== undefined) await completionPromise;
        return result;
      },
    };
    const sendFilesToThread = createSendFilesToThread({
      resolveTargetAndWorkDir: (threadKey) => ({
        ok: true,
        target: threadKey,
        workDir: fixture.workDir,
      }),
      gateway: orderedGateway,
      recordMessageIds: async (target, messageIds) => {
        recorder.messageIdCalls.push({ target, messageIds: [...messageIds] });
      },
    });

    for (const target of initialTargets) {
      sendPromises.push(sendFilesToThread(target, { paths: ['clip.mp4'] }));
    }
    await Promise.all(initialTargets.map((target) => targetStartedPromises.get(target)));

    const rejectingPromise = sendFilesToThread(rejectingTarget, { paths: ['clip.mp4'] });
    const secondQueuedPromise = sendFilesToThread(secondQueuedTarget, { paths: ['clip.mp4'] });
    const thirdQueuedPromise = sendFilesToThread(thirdQueuedTarget, { paths: ['clip.mp4'] });
    sendPromises.push(rejectingPromise, secondQueuedPromise, thirdQueuedPromise);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(gatewayStartOrder, initialTargets, 'queued sends must wait while all slots are occupied');

    releaseGatewayCompletion.get(initialTargets[0])?.();
    await targetStartedPromises.get(rejectingTarget);
    await targetStartedPromises.get(secondQueuedTarget);
    assert.deepEqual(
      gatewayStartOrder,
      [...initialTargets, rejectingTarget, secondQueuedTarget],
      'the first waiter must run first and its rejection must release the next FIFO slot',
    );
    assert.equal(gatewayStartOrder.includes(thirdQueuedTarget), false);
    assert.deepEqual(await rejectingPromise, { ok: false, error: 'queued gateway rejection' });

    releaseGatewayCompletion.get(secondQueuedTarget)?.();
    await targetStartedPromises.get(thirdQueuedTarget);
    assert.deepEqual(gatewayStartOrder, [
      ...initialTargets,
      rejectingTarget,
      secondQueuedTarget,
      thirdQueuedTarget,
    ]);

    for (const target of initialTargets.slice(1)) {
      releaseGatewayCompletion.get(target)?.();
    }
    const results = await Promise.all(sendPromises);
    assert.equal(results.filter((result) => result.ok).length, allTargets.length - 1);
    for (const fileDescriptor of recorder.capturedFileDescriptors) {
      assertFileDescriptorClosed(fileDescriptor);
    }
  } finally {
    for (const releaseCompletion of releaseGatewayCompletion.values()) releaseCompletion();
    await Promise.allSettled(sendPromises);
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread refuses a validated final component replaced before descriptor open', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  const insidePath = path.join(fixture.workDir, 'payload.txt');
  const validatedPath = path.join(fixture.workDir, 'validated-payload.txt');
  try {
    fs.writeFileSync(insidePath, 'inside-bytes');
    let didSwapPath = false;
    const sendFilesToThread = createService(fixture.workDir, recorder, {
      readFileSnapshot: (canonicalPath, expectedIdentity, pinnedRoot) => {
        fs.renameSync(canonicalPath, validatedPath);
        fs.writeFileSync(canonicalPath, 'replacement-bytes');
        didSwapPath = true;
        return readTelegramFileSnapshot(canonicalPath, expectedIdentity, pinnedRoot);
      },
    });

    const result = await sendFilesToThread('thread-key', { paths: ['payload.txt'] });

    assert.equal(didSwapPath, true, 'the final component was replaced only after validation');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /changed after validation/i);
    assert.deepEqual(recorder.gatewayCalls, [], 'replacement bytes must never reach a Telegram gateway');
    assert.deepEqual(recorder.messageIdCalls, []);
  } finally {
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread reuses one pinned root descriptor across every album item', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  const originalBoundDir = path.join(fixture.tempRoot, 'validated-bound');
  const openedFileDescriptors: number[] = [];
  const capturedPinnedRoots: PinnedFileSendRoot[] = [];
  const capturedRootDescriptors: number[] = [];
  fs.writeFileSync(path.join(fixture.workDir, 'first.txt'), 'inside-first');
  fs.writeFileSync(path.join(fixture.workDir, 'second.txt'), 'inside-second');
  let snapshotCallCount = 0;
  try {
    const sendFilesToThread = createService(fixture.workDir, recorder, {
      readFileSnapshot: (canonicalPath, expectedIdentity, pinnedRoot) => {
        capturedPinnedRoots.push(pinnedRoot);
        capturedRootDescriptors.push(pinnedRoot.fd);
        const snapshot = readTelegramFileSnapshot(canonicalPath, expectedIdentity, pinnedRoot);
        if (snapshot.ok) openedFileDescriptors.push(snapshot.source.fd);
        snapshotCallCount += 1;
        if (snapshotCallCount === 1) {
          fs.renameSync(fixture.workDir, originalBoundDir);
          fs.mkdirSync(fixture.workDir);
          fs.writeFileSync(path.join(fixture.workDir, 'second.txt'), 'outside-secret');
        }
        return snapshot;
      },
    });

    const result = await sendFilesToThread('thread-key', {
      paths: ['first.txt', 'second.txt'],
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /changed after validation/i);
    assert.equal(capturedRootDescriptors.length, 2, 'both snapshots must receive the pinned root');
    assert.equal(capturedPinnedRoots[1], capturedPinnedRoots[0], 'both snapshots must receive the same root object');
    assert.equal(new Set(capturedRootDescriptors).size, 1, 'every snapshot must reuse one root descriptor');
    assert.deepEqual(recorder.gatewayCalls, [], 'the replacement root must never supply an album item');
    assert.deepEqual(recorder.messageIdCalls, []);
    for (const fileDescriptor of openedFileDescriptors) {
      assertFileDescriptorClosed(fileDescriptor);
    }
    assertFileDescriptorClosed(capturedRootDescriptors[0]);
  } finally {
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread refuses a final-component symlink to the validated inode', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  const insidePath = path.join(fixture.workDir, 'payload.txt');
  const validatedPath = path.join(fixture.workDir, 'validated-payload.txt');
  try {
    fs.writeFileSync(insidePath, 'validated-bytes');
    let didSwapPath = false;
    const sendFilesToThread = createService(fixture.workDir, recorder, {
      readFileSnapshot: (canonicalPath, expectedIdentity, pinnedRoot) => {
        fs.renameSync(canonicalPath, validatedPath);
        fs.symlinkSync(validatedPath, canonicalPath, 'file');
        didSwapPath = true;
        return readTelegramFileSnapshot(canonicalPath, expectedIdentity, pinnedRoot);
      },
    });

    const result = await sendFilesToThread('thread-key', { paths: ['payload.txt'] });

    assert.equal(didSwapPath, true, 'the symlink replaced the final component after validation');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /too many symbolic links|symlink|ELOOP/i);
    assert.deepEqual(recorder.gatewayCalls, [], 'following the same-inode symlink must never reach Telegram');
    assert.deepEqual(recorder.messageIdCalls, []);
  } finally {
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread refuses a nested parent swapped to an outside directory before descriptor open', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  const nestedDir = path.join(fixture.workDir, 'nested');
  const validatedNestedDir = path.join(fixture.workDir, 'validated-nested');
  const outsideDir = path.join(fixture.tempRoot, 'outside');
  fs.mkdirSync(nestedDir);
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(nestedDir, 'payload.txt'), 'inside-bytes');
  fs.writeFileSync(path.join(outsideDir, 'payload.txt'), 'outside-secret-bytes');
  try {
    let didSwapParent = false;
    const sendFilesToThread = createService(fixture.workDir, recorder, {
      readFileSnapshot: (canonicalPath, expectedIdentity, pinnedRoot) => {
        fs.renameSync(nestedDir, validatedNestedDir);
        fs.symlinkSync(outsideDir, nestedDir, 'dir');
        didSwapParent = true;
        return readTelegramFileSnapshot(canonicalPath, expectedIdentity, pinnedRoot);
      },
    });

    const result = await sendFilesToThread('thread-key', { paths: ['nested/payload.txt'] });

    assert.equal(didSwapParent, true, 'the nested parent was swapped only after validation');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /not a directory|symlink|ELOOP|ENOTDIR/i);
    assert.deepEqual(recorder.gatewayCalls, [], 'outside bytes must never reach a Telegram gateway');
    assert.deepEqual(recorder.messageIdCalls, []);
  } finally {
    fixture.cleanup();
  }
});

linuxTest('createSendFilesToThread refuses a nested parent swapped between canonicalization and identity capture', async () => {
  const fixture = createTempFileSendFixture();
  const recorder = createServiceRecorder();
  const nestedDir = path.join(fixture.workDir, 'nested');
  const validatedNestedDir = path.join(fixture.workDir, 'validated-nested');
  const outsideDir = path.join(fixture.tempRoot, 'outside');
  const nestedPayloadPath = path.join(nestedDir, 'payload.txt');
  fs.mkdirSync(nestedDir);
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(nestedPayloadPath, 'inside-bytes');
  fs.writeFileSync(path.join(outsideDir, 'payload.txt'), 'outside-secret-bytes');
  const originalStatSync = fs.statSync;
  const mutableFs: typeof fs = require('fs');
  let didSwapParent = false;
  const statSyncMock = mock.method(
    mutableFs,
    'statSync',
    (target: fs.PathLike, options: { bigint: true }) => {
      if (!didSwapParent && target === nestedPayloadPath) {
        fs.renameSync(nestedDir, validatedNestedDir);
        fs.symlinkSync(outsideDir, nestedDir, 'dir');
        didSwapParent = true;
      }
      return originalStatSync(target, options);
    },
  );
  try {
    const sendFilesToThread = createService(fixture.workDir, recorder);

    const result = await sendFilesToThread('thread-key', { paths: ['nested/payload.txt'] });

    assert.equal(didSwapParent, true, 'the nested parent was swapped before identity capture');
    assert.equal(result.ok, false);
    assert.deepEqual(recorder.gatewayCalls, [], 'outside bytes must never reach a Telegram gateway');
    assert.deepEqual(recorder.messageIdCalls, []);
  } finally {
    statSyncMock.mock.restore();
    fixture.cleanup();
  }
});

linuxTest('readTelegramFileSnapshot rejects a raced FIFO without blocking the bot process', () => {
  const fixture = createTempFileSendFixture();
  const fifoPath = path.join(fixture.workDir, 'payload.bin');
  try {
    fs.writeFileSync(fifoPath, 'validated-bytes');
    const validatedStat = fs.statSync(fifoPath, { bigint: true });
    fs.rmSync(fifoPath);
    execFileSync('mkfifo', [fifoPath]);
    const serviceModulePath = path.join(__dirname, '..', 'utils', 'fileSendService.ts');
    const childScript = [
      "const fs = require('fs');",
      `const { readTelegramFileSnapshot } = require(${JSON.stringify(serviceModulePath)});`,
      `const rootPath = fs.realpathSync(${JSON.stringify(fixture.workDir)});`,
      'const rootFd = fs.openSync(rootPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);',
      `const result = readTelegramFileSnapshot(${JSON.stringify(fifoPath)}, { dev: BigInt('${validatedStat.dev.toString()}'), ino: BigInt('${validatedStat.ino.toString()}') }, { rootPath, fd: rootFd });`,
      'fs.closeSync(rootFd);',
      "process.stdout.write(result.ok ? 'unexpected success' : result.error);",
    ].join(' ');

    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--eval', childScript],
      {
        cwd: path.join(__dirname, '..', '..'),
        encoding: 'utf8',
        timeout: fifoSnapshotChildTimeoutMs,
      },
    );

    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /not a regular file/i);
  } finally {
    fixture.cleanup();
  }
});
