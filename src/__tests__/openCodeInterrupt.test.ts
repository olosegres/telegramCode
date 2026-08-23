/**
 * @description OpenCode preserves a healthy running turn for a new prompt:
 * `prompt_async` queues the message and the agent reads it promptly. The one
 * exception is provider-managed retry: the queue is unread until the retry
 * deadline, so a fresh prompt aborts that stale turn and starts with the current
 * model. The contract tests lock that asymmetry on the adapter prototypes; the
 * tracking tests cover `applyOpenCodeStatusEvent`, the SSE-driven busy state
 * behind `checkIsOpenCodeSessionBusy` (the scheduler's wait-for-idle probe).
 */

import { afterEach, beforeEach, describe, it, mock, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  OpenCodeAdapter,
  applyOpenCodeStatusEvent,
  providerRetryReplacementStartTimeoutMs,
  type OpenCodeBusyTracking,
} from '../adapters/openCodeAdapter';
import { ClaudeCliAdapter } from '../adapters/claudeCliAdapter';

const own = 'ses_own';
const child = 'ses_child';
const foreign = 'ses_foreign_sibling';
const providerRetryDelayMs = 60 * 60_000;
/**
 * The adapter's own bound, imported rather than mirrored: a hand-copied value
 * that drifted DOWN would leave every "nothing fired" assertion below vacuous.
 */
const replacementStartTimeoutMs = providerRetryReplacementStartTimeoutMs;
const freshTracking = (): OpenCodeBusyTracking => ({ isBusy: false, busyChildSessionIds: new Set() });

function createRetryingAdapter(): {
  adapter: OpenCodeAdapter;
  outputs: string[];
  requests: { method: string; path: string; body: Record<string, unknown> | undefined }[];
} {
  const key = { chatId: -100123, threadId: 42 };
  const adapter = new OpenCodeAdapter();
  adapter['sessions'].set('-100123:42', {
    key,
    sessionId: own,
    workDir: '/tmp/work',
    isActive: true,
    currentResponseText: '',
    lastEmittedLength: 0,
    outputTimer: null,
    childResponseText: '',
    childLastEmittedLength: 0,
    childOutputTimer: null,
    activeSubagentTitle: null,
    isModelInfoShown: true,
    modelOverride: { providerID: 'anthropic', modelID: 'claude-opus-5' },
    currentModelLabel: 'anthropic/claude-opus-5',
    latestParentRuntimeContext: null,
    parentAssistantObservationVersion: 0,
    partTypes: new Map(),
    statusDebounceTimer: null,
    pendingStatus: null,
    reasoningText: '',
    reasoningStartedAt: null,
    reasoningTimer: null,
    emittedToolResultPartIds: new Set(),
    pendingQuestion: null,
    effortLevel: 'xhigh',
    isBusy: true,
    awaitingTurnResponse: false,
    sawTurnActivity: false,
    providerRetrySignature: null,
    isAwaitingModelAfterProviderRetryAbort: false,
    isAwaitingProviderRetryAbortIdle: false,
    isCompacting: false,
    busyChildSessionIds: new Set(),
    isAutoNamePending: false,
    isAwaitingProviderRetryReplacementStart: false,
    providerRetryReplacementStartTimer: null,
  });

  const outputs: string[] = [];
  adapter.on('output', (_key, output: string) => outputs.push(output));
  const requests: { method: string; path: string; body: Record<string, unknown> | undefined }[] = [];
  adapter['apiRequest'] = (async (
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ) => {
    requests.push({ method, path, body });
  }) as OpenCodeAdapter['apiRequest'];

  const retryAt = Date.now() + providerRetryDelayMs;
  const retryEvent = JSON.stringify({
    directory: '/tmp/work',
    payload: {
      type: 'session.status',
      properties: {
        sessionID: own,
        status: {
          type: 'retry',
          attempt: 1,
          message: "This request would exceed your account's rate limit. Please try again later.",
          next: retryAt,
        },
      },
    },
  });
  adapter['routeSseData'](retryEvent);
  adapter['routeSseData'](retryEvent);

  const session = adapter['sessions'].get('-100123:42');
  session.modelOverride = { providerID: 'openai', modelID: 'gpt-test' };
  session.currentModelLabel = 'openai/gpt-test';
  session.isModelInfoShown = false;

  return { adapter, outputs, requests };
}

function feedAssistantModel(adapter: OpenCodeAdapter, providerID: string | undefined, modelID: string, finish?: string): void {
  adapter['routeSseData'](JSON.stringify({
    directory: '/tmp/work',
    payload: {
      type: 'message.updated',
      properties: {
        info: {
          sessionID: own,
          role: 'assistant',
          modelID,
          ...(providerID ? { providerID } : {}),
          ...(finish ? { finish } : {}),
        },
      },
    },
  }));
}

// ── interrupt-before-prompt contract ──

test('opencode adapter does NOT implement interruptAndWaitIdle — a new prompt queues, never aborts', () => {
  assert.equal(
    'interruptAndWaitIdle' in OpenCodeAdapter.prototype,
    false,
    'forwardPromptToAgent must forward directly for OpenCode',
  );
});

test('claude adapter DOES implement interruptAndWaitIdle — its TUI ignores input mid-turn without Escape', () => {
  assert.equal(typeof ClaudeCliAdapter.prototype.interruptAndWaitIdle, 'function');
});

// ── SSE busy tracking ──

test('own-session status drives isBusy (busy then idle)', () => {
  const t = freshTracking();
  applyOpenCodeStatusEvent(t, own, own, true, false);
  assert.equal(t.isBusy, true);
  assert.equal(t.busyChildSessionIds.size, 0);
  applyOpenCodeStatusEvent(t, own, own, false, false);
  assert.equal(t.isBusy, false);
});

test('a null sessionID (own session.idle fallback) clears own isBusy', () => {
  const t: OpenCodeBusyTracking = { isBusy: true, busyChildSessionIds: new Set() };
  applyOpenCodeStatusEvent(t, own, null, false, false);
  assert.equal(t.isBusy, false);
});

test('verified-descendant (sub-agent) status maintains busyChildSessionIds, never own isBusy', () => {
  const t = freshTracking();
  applyOpenCodeStatusEvent(t, own, child, true, true); // sub-agent starts
  assert.equal(t.isBusy, false, 'a busy child must not mark the parent busy');
  assert.deepEqual([...t.busyChildSessionIds], [child]);
  applyOpenCodeStatusEvent(t, own, child, false, true); // sub-agent ends
  assert.equal(t.busyChildSessionIds.size, 0);
});

test('a child going idle must NOT clear the parent isBusy', () => {
  const t: OpenCodeBusyTracking = { isBusy: true, busyChildSessionIds: new Set([child]) };
  applyOpenCodeStatusEvent(t, own, child, false, true);
  assert.equal(t.isBusy, true, 'parent stays busy when only the child idled');
  assert.equal(t.busyChildSessionIds.size, 0);
});

test('foreign non-descendant busy=true is IGNORED — never recorded as a busy child', () => {
  const t = freshTracking();
  const wasIgnored = applyOpenCodeStatusEvent(t, own, foreign, true, false);
  // Load-bearing: recording the wedged sibling would pin the thread busy
  // forever, since a wedged session never goes idle (live incident 2026-06-10).
  assert.equal(t.isBusy, false, 'a foreign session must not mark the thread busy');
  assert.equal(t.busyChildSessionIds.size, 0, 'a foreign session must not be recorded as a child');
  assert.equal(wasIgnored, true, 'caller must learn the busy=true was ignored (throttled diag-log)');
});

test('foreign non-descendant busy=false still deletes a stale id (self-healing)', () => {
  const t: OpenCodeBusyTracking = { isBusy: false, busyChildSessionIds: new Set([foreign]) };
  const wasIgnored = applyOpenCodeStatusEvent(t, own, foreign, false, false);
  assert.equal(t.busyChildSessionIds.size, 0, 'a pre-fix slipped-in id must heal on idle');
  assert.equal(t.isBusy, false);
  assert.equal(wasIgnored, false, 'a processed busy=false is not an ignored event');
});

test('applied transitions (own / verified descendant) report not-ignored', () => {
  const t = freshTracking();
  assert.equal(applyOpenCodeStatusEvent(t, own, own, true, false), false);
  assert.equal(applyOpenCodeStatusEvent(t, own, child, true, true), false);
});

test('provider retry stays busy and is surfaced once instead of looking silently idle', () => {
  const { adapter, outputs } = createRetryingAdapter();
  const key = { chatId: -100123, threadId: 42 };

  assert.equal(adapter.checkIsBusy(key), true, 'a provider-managed retry is still an in-flight turn');
  assert.equal(outputs.length, 1, 'duplicate retry status frames must not repeat the user notice');
  assert.match(outputs[0], /API rate-limited.*auto-retrying in 60 min.*attempt 1/);
});

test('a prompt during provider retry aborts the old turn before using the current model', async () => {
  const { adapter, requests } = createRetryingAdapter();
  const key = { chatId: -100123, threadId: 42 };

  adapter.sendInput(key, 'continue on the selected model');
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(
    requests.map(request => [request.method, request.path]),
    [
      ['POST', `/session/${own}/abort`],
      ['POST', `/session/${own}/prompt_async`],
    ],
    'a new prompt must not queue behind a provider retry',
  );
  assert.deepEqual(requests[1].body, {
    parts: [{ type: 'text', text: 'continue on the selected model' }],
    model: { providerID: 'openai', modelID: 'gpt-test' },
    variant: 'xhigh',
  });
});

test('concurrent prompts share one provider-retry abort before both are posted', async () => {
  const { adapter, requests } = createRetryingAdapter();
  const key = { chatId: -100123, threadId: 42 };

  adapter.sendInput(key, 'first');
  adapter.sendInput(key, 'second');
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(
    requests.map(request => [request.method, request.path]),
    [
      ['POST', `/session/${own}/abort`],
      ['POST', `/session/${own}/prompt_async`],
      ['POST', `/session/${own}/prompt_async`],
    ],
    'a second abort after the first prompt would cancel newly-started work',
  );
  assert.deepEqual(
    requests.slice(1).map(request => request.body?.parts),
    [
      [{ type: 'text', text: 'first' }],
      [{ type: 'text', text: 'second' }],
    ],
  );
});

test('a failed provider-retry abort posts no prompt and keeps the session busy for another attempt', async () => {
  const { adapter, requests } = createRetryingAdapter();
  const key = { chatId: -100123, threadId: 42 };
  const errors: Error[] = [];
  adapter.on('error', (_key, error: Error) => errors.push(error));
  adapter['apiRequest'] = (async (method: string, path: string, body?: Record<string, unknown>) => {
    requests.push({ method, path, body });
    throw new Error('abort failed');
  }) as OpenCodeAdapter['apiRequest'];

  adapter.sendInput(key, 'continue');
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(requests.map(request => request.path), [`/session/${own}/abort`]);
  assert.equal(adapter.checkIsBusy(key), true, 'the provider retry still owns the turn after a failed abort');
  assert.deepEqual(errors.map(error => error.message), ['abort failed']);
});

test('the aborted retry cannot overwrite the selected model after the abort request has resolved', async () => {
  const { adapter, outputs, requests } = createRetryingAdapter();
  const key = { chatId: -100123, threadId: 42 };
  let resolveAbort: (() => void) | null = null;
  const abortResult = new Promise<void>(resolve => {
    resolveAbort = resolve;
  });
  adapter['apiRequest'] = (async (method: string, path: string, body?: Record<string, unknown>) => {
    requests.push({ method, path, body });
    if (path.endsWith('/abort')) await abortResult;
  }) as OpenCodeAdapter['apiRequest'];

  adapter.sendInput(key, 'continue');
  resolveAbort?.();
  await new Promise(resolve => setImmediate(resolve));
  feedAssistantModel(adapter, 'anthropic', 'claude-opus-5');

  assert.deepEqual(
    outputs.filter(output => output.startsWith('Model:')),
    [],
    'the assistant update finalising the aborted retry is not the model for the new prompt',
  );

  feedAssistantModel(adapter, 'openai', 'gpt-test');

  assert.deepEqual(outputs.filter(output => output.startsWith('Model:')), ['Model: openai/gpt-test']);
});

test('an aborted retry completion cannot mask a newly submitted prompt as active', async () => {
  const { adapter } = createRetryingAdapter();
  const key = { chatId: -100123, threadId: 42 };

  adapter.sendInput(key, 'continue');
  await new Promise(resolve => setImmediate(resolve));
  const session = adapter['sessions'].get('-100123:42');
  session.sawTurnActivity = false;
  session.lastMessageId = 'new-turn-message';

  feedAssistantModel(adapter, 'anthropic', 'claude-opus-5', 'stop');

  assert.equal(session.sawTurnActivity, false, 'the stale completion must not count as activity for the replacement prompt');
  assert.equal(session.lastMessageId, 'new-turn-message', 'the stale completion must not advance the persisted parent watermark');
});

test('a partial current model reference is not mistaken for an aborted retry', async () => {
  const { adapter, outputs } = createRetryingAdapter();
  const key = { chatId: -100123, threadId: 42 };

  adapter.sendInput(key, 'continue');
  await new Promise(resolve => setImmediate(resolve));
  feedAssistantModel(adapter, undefined, 'gpt-test');

  assert.deepEqual(outputs.filter(output => output.startsWith('Model:')), ['Model: gpt-test']);
});

test('the idle from an aborted provider retry cannot recover the replacement prompt', async () => {
  const { adapter } = createRetryingAdapter();
  const key = { chatId: -100123, threadId: 42 };
  let noResponseCount = 0;
  adapter.on('noResponse', () => {
    noResponseCount += 1;
  });

  adapter.sendInput(key, 'continue');
  await new Promise(resolve => setImmediate(resolve));
  const session = adapter['sessions'].get('-100123:42');
  assert.equal(session.isAwaitingProviderRetryAbortIdle, true);

  adapter['handleSessionIdle'](key, { sessionID: own });

  assert.equal(noResponseCount, 0, 'the abort idle must not trigger recovery for the replacement prompt');
  assert.equal(session.awaitingTurnResponse, false, 'the replacement turn is not armed until its own busy status');
  assert.equal(session.isAwaitingProviderRetryAbortIdle, false, 'only the old idle is consumed');

  adapter['handleSessionStatus'](key, own, { status: { type: 'busy' } });
  assert.equal(session.awaitingTurnResponse, true, 'the replacement busy transition arms its wedge detector');
});

test('an early abort idle is consumed before the abort response and never re-armed', async () => {
  const { adapter, requests } = createRetryingAdapter();
  const key = { chatId: -100123, threadId: 42 };
  let resolveAbort: (() => void) | null = null;
  const abortResult = new Promise<void>(resolve => {
    resolveAbort = resolve;
  });
  adapter['apiRequest'] = (async (method: string, path: string, body?: Record<string, unknown>) => {
    requests.push({ method, path, body });
    if (path.endsWith('/abort')) await abortResult;
  }) as OpenCodeAdapter['apiRequest'];

  adapter.sendInput(key, 'continue');
  await new Promise(resolve => setImmediate(resolve));
  const session = adapter['sessions'].get('-100123:42');
  assert.equal(session.isAwaitingProviderRetryAbortIdle, true);

  adapter['handleSessionIdle'](key, { sessionID: own });
  assert.equal(session.isAwaitingProviderRetryAbortIdle, false, 'the early idle is consumed while abort is pending');
  assert.equal(session.awaitingTurnResponse, false, 'the replacement turn has not started before abort resolves');

  resolveAbort?.();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(session.isAwaitingProviderRetryAbortIdle, false, 'abort completion must not re-arm an already-consumed idle');
  assert.equal(session.isAwaitingProviderRetryReplacementStart, true, 'the posted replacement awaits its own busy boundary');
});

test('replacement busy arms its wedge detector before prompt_async resolves', async () => {
  const { adapter, requests } = createRetryingAdapter();
  const key = { chatId: -100123, threadId: 42 };
  let resolvePrompt: (() => void) | null = null;
  const promptResult = new Promise<void>((resolve) => {
    resolvePrompt = resolve;
  });
  adapter['apiRequest'] = (async (method: string, path: string, body?: Record<string, unknown>) => {
    requests.push({ method, path, body });
    if (path.endsWith('/prompt_async')) await promptResult;
  }) as OpenCodeAdapter['apiRequest'];

  adapter.sendInput(key, 'continue');
  await new Promise(resolve => setImmediate(resolve));
  const session = adapter['sessions'].get('-100123:42');
  assert.equal(session.isAwaitingProviderRetryReplacementStart, true, 'the boundary is armed before the prompt request settles');

  adapter['handleSessionStatus'](key, own, { status: { type: 'busy' } });

  assert.equal(session.isAwaitingProviderRetryReplacementStart, false, 'the early busy transition belongs to the replacement');
  assert.equal(session.awaitingTurnResponse, true, 'the early busy transition arms wedge detection');
  resolvePrompt?.();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.awaitingTurnResponse, true, 'the delayed HTTP response cannot reset the armed detector');
});

test('a replacement retry after busy remains interruptible', async () => {
  const { adapter, outputs, requests } = createRetryingAdapter();
  const key = { chatId: -100123, threadId: 42 };

  adapter.sendInput(key, 'continue');
  await new Promise(resolve => setImmediate(resolve));
  const session = adapter['sessions'].get('-100123:42');
  adapter['handleSessionStatus'](key, own, { status: { type: 'busy' } });
  adapter['handleSessionStatus'](key, own, {
    status: { type: 'retry', attempt: 2, message: 'replacement retry', next: Date.now() + providerRetryDelayMs },
  });

  assert.notEqual(session.providerRetrySignature, null, 'the replacement retry is tracked rather than dismissed as stale');
  assert.equal(outputs.length, 2, 'the replacement retry gets its own notice after the original retry');

  adapter.sendInput(key, 'retry replacement');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(
    requests.filter((request) => request.path.endsWith('/abort')).length,
    2,
    'the next prompt aborts the replacement retry instead of joining its unread queue',
  );
});

test('an abort error followed by its idle cannot settle the replacement before busy', async () => {
  const { adapter } = createRetryingAdapter();
  const key = { chatId: -100123, threadId: 42 };
  let noResponseCount = 0;
  adapter.on('noResponse', () => {
    noResponseCount += 1;
  });

  adapter.sendInput(key, 'continue');
  await new Promise(resolve => setImmediate(resolve));
  const session = adapter['sessions'].get('-100123:42');
  adapter['handleSessionError'](key, own, { error: 'Aborted' });
  adapter['handleSessionIdle'](key, { sessionID: own });

  assert.equal(noResponseCount, 0, 'the old idle remains shielded after the abort error');
  assert.equal(session.isBusy, true, 'the old idle cannot make the pending replacement appear idle');
  assert.equal(session.isAwaitingProviderRetryReplacementStart, true, 'the replacement still awaits its own busy boundary');
  adapter['handleSessionStatus'](key, own, { status: { type: 'busy' } });
  adapter['handleSessionIdle'](key, { sessionID: own });
  assert.equal(noResponseCount, 1, 'the later replacement idle still reaches wedge recovery');
});

test('a late retry status from the aborted turn cannot restore provider-retry state', async () => {
  const { adapter, outputs } = createRetryingAdapter();
  const key = { chatId: -100123, threadId: 42 };
  adapter.sendInput(key, 'continue');
  await new Promise(resolve => setImmediate(resolve));
  const session = adapter['sessions'].get('-100123:42');

  adapter['handleSessionStatus'](key, own, {
    status: { type: 'retry', attempt: 2, message: 'stale retry', next: Date.now() + providerRetryDelayMs },
  });

  assert.equal(session.providerRetrySignature, null, 'the replacement turn must not inherit the cancelled retry');
  assert.equal(outputs.length, 1, 'the stale retry must not post another retry notice');
});

test('a stale retry after the old idle cannot suppress wedge recovery for the replacement turn', async () => {
  const { adapter, outputs } = createRetryingAdapter();
  const key = { chatId: -100123, threadId: 42 };
  let noResponseCount = 0;
  adapter.on('noResponse', () => {
    noResponseCount += 1;
  });

  adapter.sendInput(key, 'continue');
  await new Promise(resolve => setImmediate(resolve));
  const session = adapter['sessions'].get('-100123:42');

  adapter['handleSessionIdle'](key, { sessionID: own });
  adapter['handleSessionStatus'](key, own, {
    status: { type: 'retry', attempt: 2, message: 'stale retry', next: Date.now() + providerRetryDelayMs },
  });
  adapter['handleSessionStatus'](key, own, { status: { type: 'busy' } });
  adapter['handleSessionIdle'](key, { sessionID: own });

  assert.equal(session.providerRetrySignature, null, 'the old retry must remain cleared after its idle');
  assert.equal(noResponseCount, 1, 'a wedged replacement still triggers recovery');
  assert.equal(outputs.length, 1, 'the stale retry must not post another retry notice');
});

/**
 * @description The replacement boundary must be BOUNDED — a post-abort
 * replacement prompt that never starts a turn has to hand the thread to wedge
 * recovery instead of hanging it forever.
 *
 * Bug: the boundary (`isAwaitingProviderRetryReplacementStart`) is armed just
 * before the replacement prompt is posted and released only by an observed
 * `busy`. A wedged session accepts the prompt (HTTP 204) and its agent loop
 * exits at step 0, so that `busy` never arrives: the boundary latched forever,
 * `handleSessionIdle` swallowed every later own idle through it, the optimistic
 * `isBusy` never cleared (so the topic — and the scheduler's wait-for-idle probe
 * — saw a permanently busy session), and the wedged-turn detector stayed
 * disarmed because this path defers arming it to that same `busy`. Nothing
 * recovered the topic.
 *
 * Load-bearing in these tests:
 * - the bound must fire ONCE and release the busy state (the reported hang);
 * - it must be cancelled by a genuine `busy`, leaving the normal idle-time wedge
 *   detection as the only reporter (a bound firing on a live turn would restart
 *   a healthy conversation, and a double report would run the bot's escalation
 *   twice for one prompt);
 * - teardown must drop it, so nothing fires against a dead session.
 *
 * Time is advanced with `node:test` mock timers, the same way the SSE stall
 * watchdog and the output-debounce tests drive their timers.
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */
describe('the post-provider-retry replacement start is bounded', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('a replacement turn that never reports busy stops pinning the topic busy and recovers exactly once', async () => {
    const { adapter } = createRetryingAdapter();
    const key = { chatId: -100123, threadId: 42 };
    let noResponseCount = 0;
    adapter.on('noResponse', () => {
      noResponseCount += 1;
    });

    adapter.sendInput(key, 'continue');
    await new Promise(resolve => setImmediate(resolve));
    const session = adapter['sessions'].get('-100123:42');
    assert.equal(session.isAwaitingProviderRetryReplacementStart, true, 'the replacement awaits its busy boundary');
    assert.equal(adapter.checkIsBusy(key), true, 'the turn may still start while the bound runs');

    mock.timers.tick(replacementStartTimeoutMs + 1);

    assert.equal(noResponseCount, 1, 'the never-started replacement must reach wedge recovery');
    assert.equal(adapter.checkIsBusy(key), false, 'the optimistic busy state must not outlive the bound');
    assert.equal(session.isAwaitingProviderRetryReplacementStart, false, 'the latched boundary is released');
    // The aborted retry's OWN idle is exactly the event that arrives late here,
    // so its one-shot guard stays armed: it must be consumed once more rather
    // than counting as the idle of the recovery prompt that follows.
    assert.equal(session.isAwaitingProviderRetryAbortIdle, true, 'the late abort idle is still owed one consumption');

    adapter['handleSessionIdle'](key, { sessionID: own });
    assert.equal(noResponseCount, 1, 'the late abort idle must not report the same prompt twice');
    assert.equal(session.isAwaitingProviderRetryAbortIdle, false, 'consuming that idle ends the abort episode');
  });

  it('the recovery prompt that follows the bound keeps its own idle', async () => {
    const { adapter } = createRetryingAdapter();
    const key = { chatId: -100123, threadId: 42 };
    let noResponseCount = 0;
    adapter.on('noResponse', () => {
      noResponseCount += 1;
    });

    adapter.sendInput(key, 'continue');
    await new Promise(resolve => setImmediate(resolve));
    const session = adapter['sessions'].get('-100123:42');
    mock.timers.tick(replacementStartTimeoutMs + 1);
    assert.equal(noResponseCount, 1, 'the never-started replacement reaches recovery');
    // The aborted retry's idle never arrived, so its one-shot guard is still
    // armed. The bot now replays the prompt (wedge recovery tier 0) into the
    // SAME session: that prompt must not have ITS idle eaten by the leftover
    // guard, or the topic hangs again one prompt later and the escalation
    // stalls instead of advancing to a fork.
    assert.equal(session.isAwaitingProviderRetryAbortIdle, true, 'the stale guard outlives the bound');

    adapter.sendInput(key, 'continue');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.awaitingTurnResponse, true, 'the recovery prompt arms its own wedge detection');

    adapter['handleSessionIdle'](key, { sessionID: own });

    assert.equal(noResponseCount, 2, 'a silent recovery prompt must still escalate');
  });

  it('a replacement turn that does report busy cancels the bound and keeps its own wedge detection', async () => {
    const { adapter } = createRetryingAdapter();
    const key = { chatId: -100123, threadId: 42 };
    let noResponseCount = 0;
    adapter.on('noResponse', () => {
      noResponseCount += 1;
    });

    adapter.sendInput(key, 'continue');
    await new Promise(resolve => setImmediate(resolve));
    const session = adapter['sessions'].get('-100123:42');
    assert.notEqual(session.providerRetryReplacementStartTimer, null, 'the boundary is armed together with its bound');

    adapter['handleSessionStatus'](key, own, { status: { type: 'busy' } });

    assert.equal(session.providerRetryReplacementStartTimer, null, 'the observed busy drops the bound');
    assert.equal(session.awaitingTurnResponse, true, 'the started turn keeps the idle-time wedge detector armed');

    mock.timers.tick(replacementStartTimeoutMs + 1);

    assert.equal(noResponseCount, 0, 'a cancelled bound must never fire against a running turn');
    assert.equal(adapter.checkIsBusy(key), true, 'the running replacement turn is still busy');

    adapter['handleSessionIdle'](key, { sessionID: own });
    assert.equal(noResponseCount, 1, 'a started-but-silent turn is still caught by the idle wedge check, exactly once');
  });

  it('releases the boundary even when the bound decides the turn did start', async () => {
    const { adapter } = createRetryingAdapter();
    const key = { chatId: -100123, threadId: 42 };
    let noResponseCount = 0;
    adapter.on('noResponse', () => {
      noResponseCount += 1;
    });

    adapter.sendInput(key, 'continue');
    await new Promise(resolve => setImmediate(resolve));
    const session = adapter['sessions'].get('-100123:42');
    // Activity from a CHILD (sub-agent) session marks the turn as alive, but only
    // a PARENT message releases the boundary on the normal path — so the bound
    // can expire while the turn is genuinely running.
    session.sawTurnActivity = true;

    mock.timers.tick(replacementStartTimeoutMs + 1);

    assert.equal(noResponseCount, 0, 'a turn with observed activity must not be handed to recovery');
    // The load-bearing half: an early return here would leave the flag armed with
    // no bound behind it, and the idle guard would swallow every own idle for the
    // rest of the session — the exact hang the bound exists to prevent.
    assert.equal(session.isAwaitingProviderRetryReplacementStart, false, 'the boundary is released regardless of the verdict');
    assert.equal(session.providerRetryReplacementStartTimer, null, 'no bound is left pending behind the released boundary');
  });

  it('tearing the session down before the bound elapses fires nothing', async () => {
    const { adapter } = createRetryingAdapter();
    const key = { chatId: -100123, threadId: 42 };
    let noResponseCount = 0;
    adapter.on('noResponse', () => {
      noResponseCount += 1;
    });

    adapter.sendInput(key, 'continue');
    await new Promise(resolve => setImmediate(resolve));
    const session = adapter['sessions'].get('-100123:42');
    assert.equal(session.isAwaitingProviderRetryReplacementStart, true);
    assert.notEqual(session.providerRetryReplacementStartTimer, null, 'the boundary is armed together with its bound');

    adapter['stopSessionInner'](key);
    assert.equal(session.providerRetryReplacementStartTimer, null, 'teardown drops the pending bound');

    mock.timers.tick(replacementStartTimeoutMs + 1);

    assert.equal(noResponseCount, 0, 'a stopped thread must never be handed to wedge recovery');
  });
});

test('a replacement idle still recovers when the aborted retry never emits idle', async () => {
  const { adapter } = createRetryingAdapter();
  const key = { chatId: -100123, threadId: 42 };
  let noResponseCount = 0;
  adapter.on('noResponse', () => {
    noResponseCount += 1;
  });

  adapter.sendInput(key, 'continue');
  await new Promise(resolve => setImmediate(resolve));
  adapter['handleSessionError'](key, own, { error: 'Aborted' });
  adapter['handleSessionStatus'](key, own, { status: { type: 'busy' } });
  adapter['handleSessionIdle'](key, { sessionID: own });

  assert.equal(noResponseCount, 1, 'the replacement idle must not be consumed as the absent old idle');
});
