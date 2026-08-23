/**
 * @description OpenCode preserves a healthy running turn for a new prompt:
 * `prompt_async` queues the message and the agent reads it promptly. The one
 * exception is provider-managed retry: the queue is unread until the retry
 * deadline, so a fresh prompt aborts that stale turn and starts with the current
 * model. The contract tests lock that asymmetry on the adapter prototypes; the
 * tracking tests cover `applyOpenCodeStatusEvent`, the SSE-driven busy state
 * behind `checkIsOpenCodeSessionBusy` (the scheduler's wait-for-idle probe).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  OpenCodeAdapter,
  applyOpenCodeStatusEvent,
  type OpenCodeBusyTracking,
} from '../adapters/openCodeAdapter';
import { ClaudeCliAdapter } from '../adapters/claudeCliAdapter';

const own = 'ses_own';
const child = 'ses_child';
const foreign = 'ses_foreign_sibling';
const providerRetryDelayMs = 60 * 60_000;
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
