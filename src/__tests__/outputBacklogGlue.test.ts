/**
 * @description S2b backlog-glue: a topic's ≥3-message backlog collapses into the
 * fewest `\n\n`-joined messages; 1–2 stay separate; an overflowing glue splits
 * into the fewest messages that fit, on frame boundaries, never mid-line.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { glueBacklogFrames, backlogGlueThreshold } from '../utils/outputBacklogGlue';
import { MAX_MESSAGE_LEN } from '../messageSplit';

test('1–2 frames are returned unchanged (snappy, no glue)', () => {
  assert.deepEqual(glueBacklogFrames([]), []);
  assert.deepEqual(glueBacklogFrames(['only one']), ['only one']);
  assert.deepEqual(glueBacklogFrames(['first', 'second']), ['first', 'second']);
});

test('the threshold is 3', () => {
  assert.equal(backlogGlueThreshold, 3);
  // Exactly at the threshold glues; one below does not.
  assert.deepEqual(glueBacklogFrames(['a', 'b']), ['a', 'b']);
  assert.deepEqual(glueBacklogFrames(['a', 'b', 'c']), ['a\n\nb\n\nc']);
});

test('≥3 small frames collapse into ONE message joined by a blank line', () => {
  const frames = ['alpha', 'beta', 'gamma', 'delta'];
  const out = glueBacklogFrames(frames);
  assert.equal(out.length, 1, 'a small backlog drains in a single send');
  assert.equal(out[0], frames.join('\n\n'));
});

test('an overflowing glue splits into the fewest messages that fit, on frame boundaries', () => {
  // Four 40-char frames (no internal newlines) joined by \n\n = 166 chars; a
  // 100-char cap can't hold all four, so it splits — each message ≤ cap, broken
  // at the blank-line frame boundaries (never mid-line, since frames have no \n).
  const maxLen = 100;
  const frames = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)];
  const out = glueBacklogFrames(frames, maxLen);
  assert.ok(out.length > 1, 'an overflowing backlog splits into more than one message');
  assert.ok(out.length < frames.length, 'but into FEWER messages than raw frames');
  for (const msg of out) {
    assert.ok(msg.length <= maxLen, `chunk length ${msg.length} exceeds ${maxLen}`);
    // No message cut a frame mid-run: each 40-char run is intact where present.
    for (const letter of ['a', 'b', 'c', 'd']) {
      const runs = msg.match(new RegExp(`${letter}+`, 'g')) ?? [];
      for (const run of runs) assert.equal(run.length, 40, `frame ${letter} was split mid-line`);
    }
  }
});

test('overflow preserves every frame whole and in order', () => {
  const maxLen = 100;
  const frames = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)];
  const out = glueBacklogFrames(frames, maxLen);
  // Splitting on \n\n boundaries reconstructs the original ordered frames (a
  // split point can leave one separator newline on a boundary chunk — trim it).
  const rejoined = out
    .flatMap((msg) => msg.split('\n\n'))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  assert.deepEqual(rejoined, frames, 'every original frame survives whole, in order');
});

test('a single oversized frame in the backlog is split; the others survive whole', () => {
  const maxLen = 5;
  const frames = ['xx', 'y'.repeat(11), 'zz'];
  const out = glueBacklogFrames(frames, maxLen);
  for (const msg of out) assert.ok(msg.length <= maxLen, `chunk "${msg}" exceeds ${maxLen}`);
  const joined = out.join('');
  assert.ok(joined.includes('xx'));
  assert.ok(joined.includes('zz'));
  assert.equal((joined.match(/y/g) ?? []).length, 11, 'the oversized frame content is preserved');
});

test('the rendered-length measure is honoured (glued block stays within the rendered cap)', () => {
  // A measure that inflates length forces a split even though the SOURCE fits.
  const frames = ['one', 'two', 'three'];
  const inflate = (s: string) => s.length * 1000;
  const out = glueBacklogFrames(frames, MAX_MESSAGE_LEN, inflate);
  assert.ok(out.length >= 1);
  for (const msg of out) assert.ok(inflate(msg) <= 4096, 'each message respects the rendered cap');
});
