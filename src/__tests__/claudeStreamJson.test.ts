/**
 * @description Unit tests for the pure `claude` stream-json parser
 * (`utils/claudeStreamJson.ts`) — the event core of the `claude-json-stream`
 * adapter. Fixtures below are REAL messages captured from a live
 * `claude -p --input-format stream-json --output-format stream-json` run
 * (v2.1.201) during the S0 spike, so the classifier is verified against the
 * actual wire format, not a hand-written guess.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`): each event type maps to
 * the RIGHT action with the RIGHT payload (not just "no throw"), the line
 * reader survives a chunk truncated MID-LINE, and the reverse-engineered
 * AskUserQuestion control_request is classified with its questions intact.
 *
 * Test case: n/a (no Jira tracker for this project).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ClaudeStreamLineReader,
  parseStreamJsonLine,
  classifyClaudeStreamMessage,
  type ClaudeStreamAction,
} from '../utils/claudeStreamJson';

/** Convenience: classify a raw object literal. */
function classify(obj: unknown): ClaudeStreamAction[] {
  return classifyClaudeStreamMessage(obj as Record<string, unknown>);
}

describe('ClaudeStreamLineReader — partial-line buffering', () => {
  it('returns complete lines and retains a mid-line-truncated tail', () => {
    const reader = new ClaudeStreamLineReader();
    // First chunk cuts the SECOND line mid-object.
    const first = reader.push('{"type":"a"}\n{"type":"b","x":' );
    assert.deepEqual(first, ['{"type":"a"}']);
    assert.equal(reader.pending, '{"type":"b","x":');
    // Next chunk completes line 2 and starts line 3.
    const second = reader.push('42}\n{"type":"c"');
    assert.deepEqual(second, ['{"type":"b","x":42}']);
    assert.equal(reader.pending, '{"type":"c"');
    // Final newline flushes line 3.
    assert.deepEqual(reader.push('}\n'), ['{"type":"c"}']);
    assert.equal(reader.pending, '');
  });

  it('drops blank lines', () => {
    const reader = new ClaudeStreamLineReader();
    assert.deepEqual(reader.push('\n\n{"type":"x"}\n\n'), ['{"type":"x"}']);
  });
});

describe('parseStreamJsonLine', () => {
  it('parses a valid object line', () => {
    assert.deepEqual(parseStreamJsonLine('{"type":"result"}'), { type: 'result' });
  });
  it('returns null for blank / torn / non-object lines', () => {
    assert.equal(parseStreamJsonLine(''), null);
    assert.equal(parseStreamJsonLine('{"type":"result"'), null); // torn
    assert.equal(parseStreamJsonLine('[1,2,3]'), null); // not a record
    assert.equal(parseStreamJsonLine('"str"'), null);
  });
});

describe('classifyClaudeStreamMessage — real captured events', () => {
  it('system/init → init with session id + apiKeySource (subscription proof)', () => {
    const init = {
      type: 'system', subtype: 'init',
      session_id: '6761fcd2-bb5d-4dae-a1a0-deeba28a6bc6',
      model: 'claude-haiku-4-5-20251001', apiKeySource: 'none',
      tools: ['Task', 'AskUserQuestion', 'Bash'],
    };
    assert.deepEqual(classify(init), [{
      kind: 'init', sessionId: '6761fcd2-bb5d-4dae-a1a0-deeba28a6bc6',
      model: 'claude-haiku-4-5-20251001', apiKeySource: 'none',
    }]);
  });

  it('content_block_delta text_delta → textDelta (answer stream)', () => {
    const msg = {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Got it—' } },
      parent_tool_use_id: null,
    };
    assert.deepEqual(classify(msg), [{ kind: 'textDelta', text: 'Got it—', isSubagent: false }]);
  });

  it('content_block_delta thinking_delta → thinkingDelta', () => {
    const msg = {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The user is asking', estimated_tokens: null } },
      parent_tool_use_id: null,
    };
    assert.deepEqual(classify(msg), [{ kind: 'thinkingDelta', text: 'The user is asking', isSubagent: false }]);
  });

  it('flags sub-agent content via non-null parent_tool_use_id', () => {
    const msg = {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'child text' } },
      parent_tool_use_id: 'toolu_parent',
    };
    assert.deepEqual(classify(msg), [{ kind: 'textDelta', text: 'child text', isSubagent: true }]);
  });

  it('input_json_delta (tool args) and empty deltas → no action', () => {
    assert.deepEqual(classify({ type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"a"' } }, parent_tool_use_id: null }), []);
    assert.deepEqual(classify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }, parent_tool_use_id: null }), []);
    assert.deepEqual(classify({ type: 'stream_event', event: { type: 'message_start', message: {} } }), []);
  });

  it('assistant message → toolUse for each tool_use block (text/thinking ignored — already streamed)', () => {
    const msg = {
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text: 'let me run it' },
        { type: 'tool_use', name: 'Bash', id: 'toolu_bash1', input: { command: 'echo hi' } },
      ] },
      parent_tool_use_id: null,
    };
    assert.deepEqual(classify(msg), [{ kind: 'toolUse', tool: 'Bash', toolUseId: 'toolu_bash1', isSubagent: false }]);
  });

  it('user message with tool_result → toolResult (matched by tool_use_id)', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash1', content: 'hi' }] },
      parent_tool_use_id: null,
    };
    assert.deepEqual(classify(msg), [{ kind: 'toolResult', toolUseId: 'toolu_bash1', output: 'hi' }]);
  });

  it('user message with array-block tool_result → concatenated text output', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'line1\n' }, { type: 'text', text: 'line2' }] }] },
    };
    assert.deepEqual(classify(msg), [{ kind: 'toolResult', toolUseId: 't1', output: 'line1\nline2' }]);
  });

  it('user message with no tool_result → userEcho (replay-user-messages ack)', () => {
    const msg = { type: 'user', message: { role: 'user', content: 'Reply with ready' } };
    assert.deepEqual(classify(msg), [{ kind: 'userEcho' }]);
  });

  it('result success → turnEnd with final text, no error', () => {
    const msg = { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'Got it—you prefer tabs.' };
    assert.deepEqual(classify(msg), [{ kind: 'turnEnd', isError: false, errorText: null, resultText: 'Got it—you prefer tabs.' }]);
  });

  it('result error → turnEnd flagged error with error text', () => {
    const msg = { type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 'Overloaded', result: 'boom' };
    const out = classify(msg);
    assert.equal(out[0].kind, 'turnEnd');
    assert.equal((out[0] as Extract<ClaudeStreamAction, { kind: 'turnEnd' }>).isError, true);
    assert.equal((out[0] as Extract<ClaudeStreamAction, { kind: 'turnEnd' }>).errorText, 'Overloaded');
  });

  it('system/api_retry → apiRetry carrying the error text', () => {
    const msg = { type: 'system', subtype: 'api_retry', error: 'overloaded_error: retrying in 2s' };
    assert.deepEqual(classify(msg), [{ kind: 'apiRetry', text: 'overloaded_error: retrying in 2s' }]);
  });

  it('rate_limit_event → rateLimit with type + utilization (subscription window)', () => {
    const msg = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.79, isUsingOverage: false } };
    assert.deepEqual(classify(msg), [{ kind: 'rateLimit', rateLimitType: 'seven_day', utilization: 0.79 }]);
  });
});

describe('classifyClaudeStreamMessage — AskUserQuestion control_request (reverse-engineered)', () => {
  it('can_use_tool AskUserQuestion → controlRequest with questions + tool_use_id intact', () => {
    const msg = {
      type: 'control_request',
      request_id: 'ad87cfc5-bdcb-464d-b59a-889c5fe36ec1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        display_name: 'AskUserQuestion',
        input: { questions: [{ question: 'Do you prefer tabs or spaces for indentation?', header: 'Indentation', options: [{ label: 'Tabs', description: 'Use tab characters' }, { label: 'Spaces', description: 'Use space characters' }], multiSelect: false }] },
        tool_use_id: 'toolu_01KdoAcMDPKS9v6dRvBkHP7S',
        requires_user_interaction: true,
      },
    };
    const out = classify(msg);
    assert.equal(out.length, 1);
    const cr = out[0] as Extract<ClaudeStreamAction, { kind: 'controlRequest' }>;
    assert.equal(cr.kind, 'controlRequest');
    assert.equal(cr.subtype, 'can_use_tool');
    assert.equal(cr.toolName, 'AskUserQuestion');
    assert.equal(cr.toolUseId, 'toolu_01KdoAcMDPKS9v6dRvBkHP7S');
    assert.equal(cr.requestId, 'ad87cfc5-bdcb-464d-b59a-889c5fe36ec1');
    const questions = (cr.input?.questions as Array<{ question: string }>);
    assert.equal(questions[0].question, 'Do you prefer tabs or spaces for indentation?');
  });

  it('can_use_tool for an ordinary tool → controlRequest (auto-allow path)', () => {
    const msg = { type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm x' }, tool_use_id: 'toolu_b' } };
    const cr = classify(msg)[0] as Extract<ClaudeStreamAction, { kind: 'controlRequest' }>;
    assert.equal(cr.toolName, 'Bash');
    assert.equal(cr.subtype, 'can_use_tool');
  });

  it('malformed control_request (no request_id / subtype) → no action', () => {
    assert.deepEqual(classify({ type: 'control_request', request: { subtype: 'can_use_tool' } }), []);
    assert.deepEqual(classify({ type: 'control_request', request_id: 'r' }), []);
  });
});
