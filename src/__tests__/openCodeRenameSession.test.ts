/**
 * @description Manual session rename for the OpenCode backend
 * (`OpenCodeAdapter.renameSession`).
 *
 * Asserts the locked contract:
 *   - a live session → exactly ONE `PATCH /session/:id` carrying `{ title }`,
 *     scoped to the session's owning instance (`?directory=<workDir>`), and
 *     resolves to `null` (success);
 *   - NO live session → no PATCH, resolves to the `rename_session.*` notice;
 *   - a manual rename retires the auto-name fallback (`isAutoNamePending`
 *     flipped to `false`) so opencode's auto-title can never overwrite the
 *     user's title afterwards;
 *   - a PATCH failure resolves to the failure notice (not a throw) and STILL
 *     suppresses the fallback (the user clearly wanted a manual name).
 *
 * Harness mirrors openCodeSessionAutoname.test.ts: real adapter, `apiRequest`
 * stubbed, sessions injected via runtime bracket access (tests are excluded
 * from tsconfig and run via tsx, so bracket access does not affect typecheck).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type ThreadKey } from '../types';

interface ApiCall {
  method: string;
  urlPath: string;
  body?: unknown;
}

const sessionId = 'ses_rename_test';
const workDir = '/tmp/work/telegramCode';

/**
 * @description Build an adapter with `apiRequest` recorded. `shouldPatchFail`
 * makes the PATCH throw so the failure-path test can assert the notice + the
 * fallback-suppression invariant.
 */
function createRenameAdapter(shouldPatchFail = false): {
  adapter: OpenCodeAdapter;
  calls: ApiCall[];
} {
  const adapter = new OpenCodeAdapter();
  const calls: ApiCall[] = [];

  adapter['apiRequest'] = async (method: string, urlPath: string, body?: unknown) => {
    calls.push({ method, urlPath, body });
    if (method === 'PATCH' && shouldPatchFail) {
      throw new Error('OpenCode API PATCH /session failed: 500 boom');
    }
    return undefined;
  };
  adapter['connectSse'] = () => {};

  return { adapter, calls };
}

function injectSession(adapter: OpenCodeAdapter, key: ThreadKey, isAutoNamePending: boolean): void {
  adapter['sessions'].set(keyToString(key), {
    key,
    sessionId,
    workDir,
    isActive: true,
    currentResponseText: '',
    lastEmittedLength: 0,
    outputTimer: null,
    isModelInfoShown: true,
    modelOverride: null,
    currentModelLabel: null,
    partTypes: new Map(),
    statusDebounceTimer: null,
    pendingStatus: null,
    pendingQuestion: null,
    effortLevel: null,
    isBusy: false,
    isCompacting: false,
    busyChildSessionIds: new Set(),
    sseController: null,
    reconnectTimer: null,
    sseStallTimer: null,
    isAutoNamePending,
  });
}

const getPatches = (calls: ApiCall[]): ApiCall[] =>
  calls.filter((c) => c.method === 'PATCH' && c.urlPath.startsWith(`/session/${sessionId}`));

describe('OpenCode manual session rename', () => {
  it('PATCHes the new title scoped to the session instance and resolves null', async () => {
    const { adapter, calls } = createRenameAdapter();
    const key: ThreadKey = { chatId: -100, threadId: 1 };
    injectSession(adapter, key, true);

    const result = await adapter.renameSession(key, 'Refactor the auth layer');

    assert.equal(result, null, 'success resolves to null');
    const patches = getPatches(calls);
    assert.equal(patches.length, 1, 'renames exactly once');
    assert.deepEqual(patches[0].body, { title: 'Refactor the auth layer' });
    assert.ok(
      patches[0].urlPath.includes(`?directory=${encodeURIComponent(workDir)}`),
      `PATCH must be instance-scoped: "${patches[0].urlPath}"`,
    );
  });

  it('a manual rename retires the auto-name fallback (isAutoNamePending → false)', async () => {
    const { adapter } = createRenameAdapter();
    const key: ThreadKey = { chatId: -100, threadId: 2 };
    injectSession(adapter, key, true);

    await adapter.renameSession(key, 'Investigate the flaky CI run');

    assert.equal(
      adapter['sessions'].get(keyToString(key))['isAutoNamePending'],
      false,
      'auto-title fallback must never overwrite a manual rename',
    );
  });

  it('with NO active session resolves to a notice and issues no PATCH', async () => {
    const { adapter, calls } = createRenameAdapter();
    const key: ThreadKey = { chatId: -100, threadId: 3 }; // no session injected

    const result = await adapter.renameSession(key, 'Anything');

    assert.ok(typeof result === 'string' && result.length > 0, 'returns a user-facing notice');
    assert.ok(!result.includes('{'), `notice must be fully substituted: "${result}"`);
    assert.equal(getPatches(calls).length, 0, 'no PATCH without a live session');
  });

  it('a PATCH failure resolves to a notice (no throw) and still suppresses the fallback', async () => {
    const { adapter, calls } = createRenameAdapter(true);
    const key: ThreadKey = { chatId: -100, threadId: 4 };
    injectSession(adapter, key, true);

    const result = await adapter.renameSession(key, 'Title that fails to save');

    assert.ok(typeof result === 'string' && result.length > 0, 'a failed PATCH returns a notice, not a throw');
    assert.equal(getPatches(calls).length, 1, 'the PATCH was attempted');
    assert.equal(
      adapter['sessions'].get(keyToString(key))['isAutoNamePending'],
      false,
      'a deliberate manual rename retires the fallback even when the PATCH fails',
    );
  });
});
