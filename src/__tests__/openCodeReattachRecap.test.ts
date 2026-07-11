/**
 * @description Unit coverage for `countOpenCodeAssistantMessagesSinceId` — the
 * pure OpenCode side of the reattach recap's "how many agent messages did the
 * user miss while the bot was down" count.
 *
 * A message record is `{ info:{ id, role }, parts:[ {type:'text',text} | tool |
 * step ] }` (the same shape `GET /session/:id/message` returns and
 * `mapOpenCodeMessagesToTurns` consumes). The counter walks chronological
 * records, skips up to and including the watermark id, then counts each later
 * assistant record carrying non-empty text. A missing/absent watermark id means
 * `isWatermarkKnown:false` (the recap falls back to its no-count path).
 *
 * Test case: N/A — TelegramCode has no Jira tracker. TODO: add a test-case key
 * if one is ever created.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkIsOpenCodeTurnInFlight,
  countOpenCodeAssistantMessagesSinceId,
  getLatestOpenCodeAssistantMessageId,
} from '../adapters/openCodeAdapter';

const records = [
  { info: { id: 'm1', role: 'user' }, parts: [{ type: 'text', text: 'first ask' }] },
  { info: { id: 'm2', role: 'assistant' }, parts: [{ type: 'text', text: 'seen answer' }] }, // watermark
  { info: { id: 'm3', role: 'user' }, parts: [{ type: 'text', text: 'follow-up' }] },
  { info: { id: 'm4', role: 'assistant' }, parts: [{ type: 'text', text: 'missed answer 1' }] },
  // A tool/step-only assistant message carries no renderable text → not counted.
  { info: { id: 'm5', role: 'assistant' }, parts: [{ type: 'step-start' }, { type: 'tool', tool: 'bash' }] },
  { info: { id: 'm6', role: 'assistant' }, parts: [{ type: 'text', text: 'missed answer 2' }] },
];

describe('countOpenCodeAssistantMessagesSinceId', () => {
  it('counts only assistant messages with text AFTER the watermark id', () => {
    const result = countOpenCodeAssistantMessagesSinceId(records, 'm2');
    // m4 and m6 are renderable assistant messages after m2; m5 (tool-only) and
    // the m3 user turn do not count.
    assert.deepEqual(result, { missedCount: 2, isWatermarkKnown: true });
  });

  it('returns 0 when the watermark is the latest message (nothing missed)', () => {
    const result = countOpenCodeAssistantMessagesSinceId(records, 'm6');
    assert.deepEqual(result, { missedCount: 0, isWatermarkKnown: true });
  });

  it('does not count the watermark message itself', () => {
    // Watermark = m4 (an assistant). Only m6 follows as a renderable assistant.
    const result = countOpenCodeAssistantMessagesSinceId(records, 'm4');
    assert.deepEqual(result, { missedCount: 1, isWatermarkKnown: true });
  });

  it('is watermark-unknown when the id is absent from the records (pruned / wrong session)', () => {
    const result = countOpenCodeAssistantMessagesSinceId(records, 'does-not-exist');
    assert.deepEqual(result, { missedCount: 0, isWatermarkKnown: false });
  });

  it('is watermark-unknown for a missing id or a non-array payload', () => {
    assert.deepEqual(countOpenCodeAssistantMessagesSinceId(records, undefined), {
      missedCount: 0,
      isWatermarkKnown: false,
    });
    assert.deepEqual(countOpenCodeAssistantMessagesSinceId(null, 'm2'), {
      missedCount: 0,
      isWatermarkKnown: false,
    });
    assert.deepEqual(countOpenCodeAssistantMessagesSinceId({}, 'm2'), {
      missedCount: 0,
      isWatermarkKnown: false,
    });
  });
});

describe('checkIsOpenCodeTurnInFlight (best-effort still-working signal)', () => {
  it('is true when the LAST record is an assistant message with no finish reason', () => {
    const inFlight = [
      { info: { id: 'a1', role: 'user' }, parts: [{ type: 'text', text: 'go' }] },
      { info: { id: 'a2', role: 'assistant' }, parts: [{ type: 'text', text: 'still typing…' }] },
    ];
    assert.equal(checkIsOpenCodeTurnInFlight(inFlight), true);
  });

  it('is false when the last assistant message already finished', () => {
    const done = [
      { info: { id: 'a1', role: 'user' }, parts: [{ type: 'text', text: 'go' }] },
      { info: { id: 'a2', role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'done' }] },
    ];
    assert.equal(checkIsOpenCodeTurnInFlight(done), false);
  });

  it('is false when the last record is a user message (no agent turn in flight)', () => {
    const lastIsUser = [
      { info: { id: 'a1', role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'answer' }] },
      { info: { id: 'a2', role: 'user' }, parts: [{ type: 'text', text: 'follow-up' }] },
    ];
    assert.equal(checkIsOpenCodeTurnInFlight(lastIsUser), false);
  });

  it('is false for an empty / non-array payload (any uncertainty → not active)', () => {
    assert.equal(checkIsOpenCodeTurnInFlight([]), false);
    assert.equal(checkIsOpenCodeTurnInFlight(null), false);
    assert.equal(checkIsOpenCodeTurnInFlight({}), false);
  });
});

describe('getLatestOpenCodeAssistantMessageId (idempotent head watermark)', () => {
  it('returns the id of the LAST assistant message (skipping trailing non-assistant records)', () => {
    // m6 is the last assistant; even m5 (tool-only) still counts — the head must
    // advance past EVERY assistant message seen, not only renderable ones.
    assert.equal(getLatestOpenCodeAssistantMessageId(records), 'm6');
  });

  it('ignores trailing user messages when picking the head', () => {
    const withTrailingUser = [
      { info: { id: 'a1', role: 'assistant' }, parts: [{ type: 'text', text: 'answer' }] },
      { info: { id: 'a2', role: 'user' }, parts: [{ type: 'text', text: 'follow-up' }] },
    ];
    assert.equal(getLatestOpenCodeAssistantMessageId(withTrailingUser), 'a1');
  });

  it('is undefined when no assistant message has an id, or for a non-array payload', () => {
    assert.equal(getLatestOpenCodeAssistantMessageId([{ info: { role: 'user' }, parts: [] }]), undefined);
    assert.equal(getLatestOpenCodeAssistantMessageId([{ info: { role: 'assistant' }, parts: [] }]), undefined);
    assert.equal(getLatestOpenCodeAssistantMessageId(null), undefined);
    assert.equal(getLatestOpenCodeAssistantMessageId({}), undefined);
  });
});
