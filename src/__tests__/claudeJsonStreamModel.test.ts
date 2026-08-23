/**
 * @description The json-stream backend must be able to NAME the model it runs.
 * `/status` and the pinned banner read `getCurrentModel`, which used to return
 * only the explicit `--model` spawn pick — and that pick is `null` on every
 * default start, every resume, and every boot-time adopt, so a topic on the
 * default backend showed no model at all (user report 2026-08-23).
 *
 * Load-bearing intent (per `.claude/rules/tests.md`):
 * - claude's own `system/init` carries the RESOLVED model id and is the only
 *   report of the live model; driving a real init line through the adapter's
 *   stdout path must make `getCurrentModel` name it;
 * - the reported id must NOT leak into the re-spawn pick (`session.model`),
 *   which is replayed verbatim as `--model` on an effort/model re-spawn —
 *   overwriting it would silently pin a session that asked for no model to one
 *   frozen snapshot;
 * - the pick still answers during the window between a `/model` re-spawn and
 *   its first `init`, so the label never blanks out mid-switch.
 *
 * Private members are reached via runtime bracket access (tests are
 * type-stripped by tsx), same pattern as claudeJsonStreamWatermarkAdvance.
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeJsonStreamAdapter } from '../adapters/claudeJsonStreamAdapter';
import { ClaudeStreamLineReader } from '../utils/claudeStreamJson';
import { keyToString, type ThreadKey } from '../types';

const key: ThreadKey = { chatId: -100999222, threadId: 77 };
const resolvedModel = 'claude-opus-4-5-20251101';

/** A real `system/init` line as claude emits it at session start (and on resume). */
const initLine =
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: '6761fcd2-bb5d-4dae-a1a0-deeba28a6bc6',
    model: resolvedModel,
    apiKeySource: 'none',
    tools: ['Task', 'AskUserQuestion', 'Bash'],
  }) + '\n';

function createAdapterWithSession(pickedModel: string | null): ClaudeJsonStreamAdapter {
  const adapter = new ClaudeJsonStreamAdapter();
  adapter['sessions'].set(keyToString(key), {
    key,
    workDir: '/tmp/jsonstream-model-work',
    sessionId: 'sess-json-model',
    isActive: true,
    reader: new ClaudeStreamLineReader(),
    model: pickedModel,
    reportedModel: null,
    effort: null,
  });
  return adapter;
}

describe('claude-json-stream current model', () => {
  it('names the model claude reports when no explicit pick was made', () => {
    const adapter = createAdapterWithSession(null);
    // Pre-fix this stayed null for the whole session — the reported bug.
    assert.equal(adapter.getCurrentModel(key), null, 'nothing is known before init arrives');

    adapter['onStdout'](adapter['sessions'].get(keyToString(key)), initLine);

    assert.equal(adapter.getCurrentModel(key), resolvedModel);
  });

  it('keeps the re-spawn pick empty so a default session is never pinned to a snapshot', () => {
    const adapter = createAdapterWithSession(null);

    adapter['onStdout'](adapter['sessions'].get(keyToString(key)), initLine);

    assert.equal(
      adapter['sessions'].get(keyToString(key)).model,
      null,
      'the reported id must not become the --model flag of the next effort re-spawn',
    );
  });

  it('answers with the pick until init lands, then with the resolved id', () => {
    const adapter = createAdapterWithSession('opus');
    assert.equal(adapter.getCurrentModel(key), 'opus', 'the label holds through a /model re-spawn');

    adapter['onStdout'](adapter['sessions'].get(keyToString(key)), initLine);

    assert.equal(adapter.getCurrentModel(key), resolvedModel, 'the live report wins once known');
  });

  it('reports nothing for a thread with no session', () => {
    const adapter = new ClaudeJsonStreamAdapter();
    assert.equal(adapter.getCurrentModel(key), null);
  });
});
