/**
 * @description Load-bearing tests for the agent→Telegram `send_file_to_user` decision
 * layer (`utils/fileSendPlan.ts`). Three pure concerns: path-safety
 * (`resolveSendFileWithinDir`), extension classification (`classifyFileSendKind`),
 * and the single/album send plan (`planFileSend`). The path-safety part is
 * security-critical (it is the only thing stopping the agent from exfiltrating
 * files outside its bound folder), so it is exercised against a REAL temp dir
 * with a real symlink-out, not a mock.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveSendFileWithinDir,
  classifyFileSendKind,
  planFileSend,
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
    if (result.ok) assert.equal(result.absPath, fs.realpathSync(filePath));
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

test('classifyFileSendKind: everything else → document', () => {
  for (const p of ['a.pdf', 'a.txt', 'a.md', 'noext', 'a.mp4', 'a.zip']) {
    assert.equal(classifyFileSendKind(p), 'document', p);
  }
});

// ─── planFileSend ─────────────────────────────────────────────────────

function item(absPath: string, kind: FileSendItem['kind'], sizeBytes = 1000): FileSendItem {
  return { absPath, kind, sizeBytes };
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

test('planFileSend: all-photo album → albumPhoto', () => {
  const plan = planFileSend([item('/w/a.png', 'photo'), item('/w/b.jpg', 'photo')], false);
  assert.equal(plan.kind, 'album');
  if (plan.kind === 'album') assert.equal(plan.mode, 'albumPhoto');
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

test('planFileSend: a photo album where one is over the photo cap → albumDocument', () => {
  const plan = planFileSend(
    [item('/w/a.png', 'photo'), item('/w/b.png', 'photo', telegramPhotoMaxBytes + 1)],
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
