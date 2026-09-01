/**
 * @description Load-bearing tests for the agent→Telegram `send_file_to_user` decision
 * layer (`utils/fileSendPlan.ts`). Four pure concerns: path-safety
 * (`resolveSendFileWithinDir`), extension classification (`classifyFileSendKind`),
 * the single/album send plan (`planFileSend`), and the exact Telegram request
 * shape (`buildTelegramFileSendRequest`). The path-safety part is security-critical
 * (it is the only thing stopping the agent from exfiltrating files outside its
 * bound folder), so it is exercised against a REAL temp dir with a real
 * symlink-out, not a mock.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveSendFileWithinDir,
  classifyFileSendKind,
  planFileSend,
  buildTelegramFileSendRequest,
  trimCaption,
  telegramPhotoMaxBytes,
  telegramSendMaxBytes,
  captionMaxLength,
  type FileSendItem,
} from '../utils/fileSendPlan';

// ─── resolveSendFileWithinDir (against a real temp dir) ──────────────

function makeTempWorkDir(): { root: string; cleanup: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fileSendPlan-')));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('resolveSendFileWithinDir: a regular file inside the folder resolves ok', () => {
  const { root, cleanup } = makeTempWorkDir();
  try {
    const filePath = path.join(root, 'chart.png');
    fs.writeFileSync(filePath, 'x');
    const result = resolveSendFileWithinDir(root, 'chart.png');
    assert.equal(result.ok, true);
    if (result.ok) {
      const fileStat = fs.statSync(filePath, { bigint: true });
      assert.equal(result.absPath, fs.realpathSync(filePath));
      assert.deepEqual(result.identity, { dev: fileStat.dev, ino: fileStat.ino });
    }
  } finally {
    cleanup();
  }
});

test('resolveSendFileWithinDir: nested file inside a subfolder resolves ok', () => {
  const { root, cleanup } = makeTempWorkDir();
  try {
    fs.mkdirSync(path.join(root, 'out'));
    fs.writeFileSync(path.join(root, 'out', 'report.pdf'), 'x');
    const result = resolveSendFileWithinDir(root, 'out/report.pdf');
    assert.equal(result.ok, true);
  } finally {
    cleanup();
  }
});

test('resolveSendFileWithinDir: ../escape is rejected as OUTSIDE_FOLDER', () => {
  const { root, cleanup } = makeTempWorkDir();
  try {
    // Create a real file in the parent so realpath succeeds and only the
    // containment check rejects it (proves it is the guard, not ENOENT).
    const parentFile = path.join(path.dirname(root), `escape-${process.pid}.txt`);
    fs.writeFileSync(parentFile, 'secret');
    try {
      const result = resolveSendFileWithinDir(root, `../${path.basename(parentFile)}`);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'OUTSIDE_FOLDER');
    } finally {
      fs.rmSync(parentFile, { force: true });
    }
  } finally {
    cleanup();
  }
});

test('resolveSendFileWithinDir: a symlink pointing outside is rejected', () => {
  const { root, cleanup } = makeTempWorkDir();
  const outsideFile = path.join(os.tmpdir(), `fileSendPlan-outside-${process.pid}.txt`);
  try {
    fs.writeFileSync(outsideFile, 'secret');
    const linkPath = path.join(root, 'link.txt');
    fs.symlinkSync(outsideFile, linkPath);
    const result = resolveSendFileWithinDir(root, 'link.txt');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'OUTSIDE_FOLDER');
  } finally {
    fs.rmSync(outsideFile, { force: true });
    cleanup();
  }
});

test('resolveSendFileWithinDir: a missing path is NOT_FOUND', () => {
  const { root, cleanup } = makeTempWorkDir();
  try {
    const result = resolveSendFileWithinDir(root, 'nope.png');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'NOT_FOUND');
  } finally {
    cleanup();
  }
});

test('resolveSendFileWithinDir: a directory is NOT_A_FILE', () => {
  const { root, cleanup } = makeTempWorkDir();
  try {
    fs.mkdirSync(path.join(root, 'sub'));
    const result = resolveSendFileWithinDir(root, 'sub');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'NOT_A_FILE');
  } finally {
    cleanup();
  }
});

test('resolveSendFileWithinDir: a control char is INVALID_CHARS', () => {
  const { root, cleanup } = makeTempWorkDir();
  try {
    const result = resolveSendFileWithinDir(root, 'a\x01b.png');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'INVALID_CHARS');
  } finally {
    cleanup();
  }
});

// ─── classifyFileSendKind ────────────────────────────────────────────

test('classifyFileSendKind: image extensions → photo (case-insensitive)', () => {
  for (const p of ['a.png', 'a.jpg', 'a.jpeg', 'a.webp', 'A.PNG', 'b.JpG', 'c.WEBP']) {
    assert.equal(classifyFileSendKind(p), 'photo', p);
  }
});

test('classifyFileSendKind: .gif → animation (case-insensitive)', () => {
  assert.equal(classifyFileSendKind('loop.gif'), 'animation');
  assert.equal(classifyFileSendKind('LOOP.GIF'), 'animation');
});

test('classifyFileSendKind: .mp4 → video (case-insensitive)', () => {
  assert.equal(classifyFileSendKind('recording.mp4'), 'video');
  assert.equal(classifyFileSendKind('RECORDING.MP4'), 'video');
});

test('classifyFileSendKind: everything else → document', () => {
  for (const p of ['a.pdf', 'a.txt', 'a.md', 'noext', 'a.zip']) {
    assert.equal(classifyFileSendKind(p), 'document', p);
  }
});

// ─── planFileSend ─────────────────────────────────────────────────────

function item(absPath: string, kind: FileSendItem['kind'], sizeBytes = 1000): FileSendItem {
  return {
    absPath,
    source: {
      fd: 100,
      filename: path.basename(absPath),
      sizeBytes,
    },
    kind,
  };
}

test('planFileSend: single photo → send photo', () => {
  const plan = planFileSend([item('/w/a.png', 'photo')], false);
  assert.equal(plan.kind, 'send');
  if (plan.kind === 'send') assert.equal(plan.mode, 'photo');
});

test('planFileSend: single document → send document', () => {
  const plan = planFileSend([item('/w/a.pdf', 'document')], false);
  assert.equal(plan.kind, 'send');
  if (plan.kind === 'send') assert.equal(plan.mode, 'document');
});

test('planFileSend: single gif → send animation', () => {
  const plan = planFileSend([item('/w/a.gif', 'animation')], false);
  assert.equal(plan.kind, 'send');
  if (plan.kind === 'send') assert.equal(plan.mode, 'animation');
});

test('planFileSend: single mp4 → send video', () => {
  const plan = planFileSend([item('/w/a.mp4', 'video')], false);
  assert.equal(plan.kind, 'send');
  if (plan.kind === 'send') assert.equal(plan.mode, 'video');
});

test('planFileSend: as_file forces an image to document', () => {
  const plan = planFileSend([item('/w/a.png', 'photo')], true);
  assert.equal(plan.kind, 'send');
  if (plan.kind === 'send') assert.equal(plan.mode, 'document');
});

test('planFileSend: as_file forces a gif to document', () => {
  const plan = planFileSend([item('/w/a.gif', 'animation')], true);
  assert.equal(plan.kind, 'send');
  if (plan.kind === 'send') assert.equal(plan.mode, 'document');
});

test('planFileSend: as_file forces a video to document', () => {
  const plan = planFileSend([item('/w/a.mp4', 'video')], true);
  assert.equal(plan.kind, 'send');
  if (plan.kind === 'send') assert.equal(plan.mode, 'document');
});

test('planFileSend: a photo over the photo cap downgrades to document', () => {
  const plan = planFileSend([item('/w/big.png', 'photo', telegramPhotoMaxBytes + 1)], false);
  assert.equal(plan.kind, 'send');
  if (plan.kind === 'send') assert.equal(plan.mode, 'document');
});

test('planFileSend: any file over the 50MB send cap → error', () => {
  const plan = planFileSend([item('/w/huge.bin', 'document', telegramSendMaxBytes + 1)], false);
  assert.equal(plan.kind, 'error');
  if (plan.kind === 'error') assert.match(plan.error, /huge\.bin/);
});

test('planFileSend: all-photo album → albumPhotoVideo', () => {
  const plan = planFileSend([item('/w/a.png', 'photo'), item('/w/b.jpg', 'photo')], false);
  assert.equal(plan.kind, 'album');
  if (plan.kind === 'album') assert.equal(plan.mode, 'albumPhotoVideo');
});

test('planFileSend: all-video album → albumPhotoVideo', () => {
  const plan = planFileSend([item('/w/a.mp4', 'video'), item('/w/b.mp4', 'video')], false);
  assert.equal(plan.kind, 'album');
  if (plan.kind === 'album') assert.equal(plan.mode, 'albumPhotoVideo');
});

test('planFileSend: mixed photo/video album → albumPhotoVideo', () => {
  const plan = planFileSend([item('/w/a.png', 'photo'), item('/w/b.mp4', 'video')], false);
  assert.equal(plan.kind, 'album');
  if (plan.kind === 'album') assert.equal(plan.mode, 'albumPhotoVideo');
});

test('planFileSend: mixed album → albumDocument', () => {
  const plan = planFileSend([item('/w/a.png', 'photo'), item('/w/b.pdf', 'document')], false);
  assert.equal(plan.kind, 'album');
  if (plan.kind === 'album') assert.equal(plan.mode, 'albumDocument');
});

test('planFileSend: album containing a gif → albumDocument', () => {
  const plan = planFileSend([item('/w/a.png', 'photo'), item('/w/b.gif', 'animation')], false);
  assert.equal(plan.kind, 'album');
  if (plan.kind === 'album') assert.equal(plan.mode, 'albumDocument');
});

test('planFileSend: all-photo album with as_file → albumDocument', () => {
  const plan = planFileSend([item('/w/a.png', 'photo'), item('/w/b.png', 'photo')], true);
  assert.equal(plan.kind, 'album');
  if (plan.kind === 'album') assert.equal(plan.mode, 'albumDocument');
});

test('planFileSend: all-video album with as_file → albumDocument', () => {
  const plan = planFileSend([item('/w/a.mp4', 'video'), item('/w/b.mp4', 'video')], true);
  assert.equal(plan.kind, 'album');
  if (plan.kind === 'album') assert.equal(plan.mode, 'albumDocument');
});

test('planFileSend: a photo album where one is over the photo cap → albumDocument', () => {
  const plan = planFileSend(
    [item('/w/a.png', 'photo'), item('/w/b.png', 'photo', telegramPhotoMaxBytes + 1)],
    false,
  );
  assert.equal(plan.kind, 'album');
  if (plan.kind === 'album') assert.equal(plan.mode, 'albumDocument');
});

test('planFileSend: an over-cap photo mixed with video → albumDocument', () => {
  const plan = planFileSend(
    [item('/w/big.png', 'photo', telegramPhotoMaxBytes + 1), item('/w/a.mp4', 'video')],
    false,
  );
  assert.equal(plan.kind, 'album');
  if (plan.kind === 'album') assert.equal(plan.mode, 'albumDocument');
});

test('planFileSend: 0 items → error', () => {
  const plan = planFileSend([], false);
  assert.equal(plan.kind, 'error');
});

test('planFileSend: 11 items → error', () => {
  const items = Array.from({ length: 11 }, (_, i) => item(`/w/${i}.png`, 'photo'));
  const plan = planFileSend(items, false);
  assert.equal(plan.kind, 'error');
  if (plan.kind === 'error') assert.match(plan.error, /too many/);
});

// ─── buildTelegramFileSendRequest ─────────────────────────────────────

function buildRequest(fileItems: FileSendItem[], asFile: boolean, caption?: string) {
  const plan = planFileSend(fileItems, asFile);
  if (plan.kind === 'error') assert.fail(plan.error);
  return buildTelegramFileSendRequest(plan, caption);
}

test('buildTelegramFileSendRequest: single MP4 uses sendVideo with ready source and caption', () => {
  const videoItem = item('/w/a.mp4', 'video');
  const request = buildRequest([videoItem], false, 'clip');
  assert.deepEqual(request, {
    method: 'sendVideo',
    source: { fd: 100, filename: 'a.mp4', sizeBytes: 1000 },
    caption: 'clip',
  });
  if (request.method === 'sendMediaGroup') assert.fail('expected a single send request');
  assert.strictEqual(request.source, videoItem.source, 'the request reuses the replayable snapshot');
});

test('buildTelegramFileSendRequest: single photo uses sendPhoto', () => {
  const request = buildRequest([item('/w/a.png', 'photo')], false);
  assert.deepEqual(request, {
    method: 'sendPhoto',
    source: { fd: 100, filename: 'a.png', sizeBytes: 1000 },
  });
});

test('buildTelegramFileSendRequest: single GIF uses sendAnimation', () => {
  const request = buildRequest([item('/w/a.gif', 'animation')], false);
  assert.deepEqual(request, {
    method: 'sendAnimation',
    source: { fd: 100, filename: 'a.gif', sizeBytes: 1000 },
  });
});

test('buildTelegramFileSendRequest: as_file MP4 uses sendDocument', () => {
  const request = buildRequest([item('/w/a.mp4', 'video')], true);
  assert.deepEqual(request, {
    method: 'sendDocument',
    source: { fd: 100, filename: 'a.mp4', sizeBytes: 1000 },
  });
});

test('buildTelegramFileSendRequest: all-video album uses video entries and captions only the first', () => {
  const request = buildRequest(
    [item('/w/a.mp4', 'video'), item('/w/b.mp4', 'video')],
    false,
    'clips',
  );
  assert.deepEqual(request, {
    method: 'sendMediaGroup',
    mediaGroup: {
      kind: 'photoVideo',
      media: [
        {
          type: 'video',
          media: { fd: 100, filename: 'a.mp4', sizeBytes: 1000 },
          caption: 'clips',
        },
        {
          type: 'video',
          media: { fd: 100, filename: 'b.mp4', sizeBytes: 1000 },
        },
      ],
    },
  });
});

test('buildTelegramFileSendRequest: mixed photo/video album preserves photo then video', () => {
  const request = buildRequest(
    [item('/w/a.png', 'photo'), item('/w/b.mp4', 'video')],
    false,
  );
  assert.deepEqual(request, {
    method: 'sendMediaGroup',
    mediaGroup: {
      kind: 'photoVideo',
      media: [
        {
          type: 'photo',
          media: { fd: 100, filename: 'a.png', sizeBytes: 1000 },
        },
        {
          type: 'video',
          media: { fd: 100, filename: 'b.mp4', sizeBytes: 1000 },
        },
      ],
    },
  });
});

test('buildTelegramFileSendRequest: document fallback converts every album entry to document', () => {
  const request = buildRequest(
    [item('/w/a.png', 'photo'), item('/w/b.pdf', 'document')],
    false,
  );
  assert.deepEqual(request, {
    method: 'sendMediaGroup',
    mediaGroup: {
      kind: 'document',
      media: [
        {
          type: 'document',
          media: { fd: 100, filename: 'a.png', sizeBytes: 1000 },
        },
        {
          type: 'document',
          media: { fd: 100, filename: 'b.pdf', sizeBytes: 1000 },
        },
      ],
    },
  });
});

test('buildTelegramFileSendRequest: rejects an impossible photo/video album item kind', () => {
  assert.throws(
    () =>
      buildTelegramFileSendRequest(
        {
          kind: 'album',
          mode: 'albumPhotoVideo',
          items: [item('/w/a.pdf', 'document'), item('/w/b.mp4', 'video')],
        },
        undefined,
      ),
    /albumPhotoVideo cannot contain document: \/w\/a\.pdf/,
  );
});

// ─── trimCaption ──────────────────────────────────────────────────────

test('trimCaption: a caption over the cap is trimmed', () => {
  const long = 'x'.repeat(captionMaxLength + 50);
  const trimmed = trimCaption(long);
  assert.equal(trimmed?.length, captionMaxLength);
});

test('trimCaption: a short caption is unchanged; blank/undefined → undefined', () => {
  assert.equal(trimCaption('hello'), 'hello');
  assert.equal(trimCaption(''), undefined);
  assert.equal(trimCaption(undefined), undefined);
});
