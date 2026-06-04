/**
 * @description Unit coverage for the thread-context preamble (the
 * "[Telegram thread context]" block the bot glues ahead of a forwarded prompt
 * so the agent knows WHICH forum topic / group / thread / folder it works in).
 *
 * Cases (plan §VERIFICATION):
 *   - full preamble with all four fields rendered;
 *   - topic name omitted when unknown (and the whole identity line dropped
 *     when neither topic nor group is known);
 *   - a rename changes the built text → marker mismatch → re-inject decision;
 *   - slash-command text → no injection (preamble would corrupt it).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildThreadContextPreamble,
  prependThreadContextPreamble,
  checkShouldInjectPreamble,
  checkShouldSkipPreambleForText,
  threadContextPreambleHeader,
} from '../threadContextPreamble';
import type { ThreadKey } from '../types';

const key: ThreadKey = { chatId: -1001111111111, threadId: 9085 };

test('buildThreadContextPreamble: renders all four fields when known', () => {
  const preamble = buildThreadContextPreamble({
    topicName: 'Fix login bug',
    groupTitle: 'ExampleGroup',
    key,
    subdir: 'someProject',
  });

  assert.equal(
    preamble,
    [
      threadContextPreambleHeader,
      'topic: "Fix login bug" | group: "ExampleGroup"',
      'thread: -1001111111111:9085 | folder: someProject',
    ].join('\n'),
  );
});

test('buildThreadContextPreamble: omits the topic name when unknown but keeps the group', () => {
  const preamble = buildThreadContextPreamble({
    groupTitle: 'ExampleGroup',
    key,
    subdir: 'someProject',
  });

  assert.ok(!preamble.includes('topic:'), 'no topic line when name is unknown');
  assert.ok(preamble.includes('group: "ExampleGroup"'), 'group still shown');
  assert.ok(preamble.includes('thread: -1001111111111:9085 | folder: someProject'));
});

test('buildThreadContextPreamble: drops the whole identity line when neither topic nor group is known', () => {
  const preamble = buildThreadContextPreamble({ key, subdir: 'someProject' });

  assert.equal(
    preamble,
    [threadContextPreambleHeader, 'thread: -1001111111111:9085 | folder: someProject'].join('\n'),
    'only header + thread/folder line for a legacy topic in a not-yet-cached group',
  );
});

test('checkShouldInjectPreamble: injects on a missing marker (fresh session / post-/clear reset)', () => {
  const preamble = buildThreadContextPreamble({ topicName: 'A', key, subdir: 'p' });
  assert.equal(checkShouldInjectPreamble(preamble, undefined), true);
});

test('checkShouldInjectPreamble: skips when the marker equals the freshly-built preamble', () => {
  const preamble = buildThreadContextPreamble({ topicName: 'A', key, subdir: 'p' });
  assert.equal(checkShouldInjectPreamble(preamble, preamble), false);
});

test('rename changes the built text → marker mismatch → re-inject', () => {
  const before = buildThreadContextPreamble({ topicName: 'Old name', key, subdir: 'p' });
  const after = buildThreadContextPreamble({ topicName: 'New name', key, subdir: 'p' });

  assert.notEqual(before, after, 'rename must change the built preamble');
  // The marker still holds the pre-rename text; the new build differs, so the
  // next prompt re-carries the preamble.
  assert.equal(checkShouldInjectPreamble(after, before), true);
});

test('checkShouldSkipPreambleForText: slash command → skip (no injection)', () => {
  assert.equal(checkShouldSkipPreambleForText('/clear'), true);
  assert.equal(checkShouldSkipPreambleForText('/compact'), true);
  assert.equal(checkShouldSkipPreambleForText('normal prompt'), false);
  assert.equal(checkShouldSkipPreambleForText('what topic am I in?'), false);
});

test('prependThreadContextPreamble: glues the preamble ahead of the prompt with a blank-line gap', () => {
  const preamble = buildThreadContextPreamble({ topicName: 'A', key, subdir: 'p' });
  const combined = prependThreadContextPreamble(preamble, 'do the thing');

  assert.ok(combined.startsWith(threadContextPreambleHeader), 'preamble comes first');
  assert.ok(combined.endsWith('do the thing'), 'prompt comes last');
  assert.ok(combined.includes('\n\ndo the thing'), 'blank-line separator between block and prompt');
});
