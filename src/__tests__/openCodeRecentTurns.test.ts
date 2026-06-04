/**
 * @description Unit coverage for OpenCode's resume context source:
 *   - `mapOpenCodeMessagesToTurns` (pure mapper of GET /session/:id/message)
 *   - `OpenCodeAdapter.getRecentTurns` (the same mapper behind a mocked
 *     `apiRequest`, plus the failure → [] guard).
 *
 * A message record is `{ info:{ role }, parts:[ {type:'text',text} | tool | step ] }`,
 * the same `parts` shape the SSE `message.part.updated` path handles. The
 * mapper joins text parts, skips tool/step/empty parts and non-user/assistant
 * roles, and keeps the last `limit` turns chronologically.
 *
 * Harness mirrors openCodeModelInfo.test.ts: `apiRequest` is stubbed via
 * runtime bracket access (tests are type-stripped by tsx, so this does not
 * affect `yarn typecheck`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter, mapOpenCodeMessagesToTurns } from '../adapters/openCodeAdapter';
import type { ThreadKey } from '../types';

const limit = 3;
const key: ThreadKey = { chatId: -100222333, threadId: 444 };
const sessionId = 'ses_recent_turns';

describe('mapOpenCodeMessagesToTurns', () => {
  it('returns [] for a non-array payload', () => {
    assert.deepEqual(mapOpenCodeMessagesToTurns(null, limit), []);
    assert.deepEqual(mapOpenCodeMessagesToTurns({}, limit), []);
  });

  it('maps text parts, skips tool/step/empty, joins multi-text, keeps last 3', () => {
    const records = [
      // Older than the window — dropped by the last-3 cap.
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'oldest user' }] },
      // tool + step parts are skipped; the two text parts are concatenated.
      {
        info: { role: 'assistant' },
        parts: [
          { type: 'step-start' },
          { type: 'text', text: 'answer A' },
          { type: 'tool', tool: 'bash', state: { status: 'completed' } },
          { type: 'text', text: 'answer B' },
        ],
      },
      // An assistant record with ONLY a tool part → no text → not a turn.
      { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'read' }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'second user' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'final answer' }] },
    ];

    const turns = mapOpenCodeMessagesToTurns(records, limit);

    // Last 3 renderable turns, chronological. The tool-only assistant and the
    // oldest user (over the cap) are excluded.
    assert.deepEqual(turns, [
      { role: 'assistant', text: 'answer A\n\nanswer B' },
      { role: 'user', text: 'second user' },
      { role: 'assistant', text: 'final answer' },
    ]);
  });

  it('skips records whose role is neither user nor assistant', () => {
    const records = [
      { info: { role: 'system' }, parts: [{ type: 'text', text: 'system note' }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'real user' }] },
    ];
    assert.deepEqual(mapOpenCodeMessagesToTurns(records, limit), [{ role: 'user', text: 'real user' }]);
  });
});

describe('OpenCodeAdapter.getRecentTurns', () => {
  it('GET /session/:id/message → mapped turns (last 3, tool/step skipped)', async () => {
    const adapter = new OpenCodeAdapter();
    let requestedPath = '';
    // Private member; runtime-only bracket access (see file header).
    adapter['apiRequest'] = async (_method: string, urlPath: string) => {
      requestedPath = urlPath;
      return [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'q1' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'step-start' }, { type: 'text', text: 'a1' }] },
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'q2' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'a2' }] },
      ];
    };

    const turns = await adapter.getRecentTurns(key, '/tmp/work', sessionId, limit);

    assert.equal(requestedPath, `/session/${sessionId}/message`);
    assert.deepEqual(turns, [
      { role: 'assistant', text: 'a1' },
      { role: 'user', text: 'q2' },
      { role: 'assistant', text: 'a2' },
    ]);
  });

  it('a failing apiRequest yields [] (no context block, never throws)', async () => {
    const adapter = new OpenCodeAdapter();
    adapter['apiRequest'] = async () => {
      throw new Error('server unavailable');
    };
    const turns = await adapter.getRecentTurns(key, '/tmp/work', sessionId, limit);
    assert.deepEqual(turns, []);
  });
});
