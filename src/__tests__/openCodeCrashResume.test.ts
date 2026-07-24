/**
 * @description OpenCode server-crash recovery: after the bot auto-restarts a
 * crashed `opencode serve`, every active session must be RESTORED by
 * re-resuming its persisted id (opencode keeps sessions on disk), not torn
 * down. Only when the id is genuinely gone on the restarted server do we fall
 * back to the old teardown + `closed` + "previous session lost" notice.
 *
 * These tests drive the REAL `restartServer()` → `resumeSessionInner()` path:
 *
 *  - global `fetch` is stubbed so the server health check (`/global/health`,
 *    hit by `ensureOpenCodeServer` / `checkIsOpenCodeServerRunning`) reports
 *    the server as alive — so neither spawns a real process.
 *  - `OPENCODE_BIN` is set so `checkIsInstalled('opencode')` short-circuits to
 *    true without shelling out to `which`.
 *  - the adapter's private `apiRequest` is stubbed to control the load-bearing
 *    `GET /session/:id` call (success vs 404); `connectSse` / `fetchModelInfo`
 *    are stubbed to no-ops so the resume path doesn't open a real SSE stream
 *    or query `/config`.
 *
 * Load-bearing assertions (per plan VERIFICATION): the session id and the
 * active flag, plus the emitted notice and the presence/absence of `closed` —
 * not merely "no crash".
 *
 * Harness mirrors `openCodeResumeModel.test.ts` / `openCodeOutputDedup.test.ts`:
 * a session is injected into the private `sessions` map and private methods are
 * driven via bracket access (tests are tsx-stripped, so this is runtime-only
 * and does not affect `yarn typecheck`).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type ThreadKey } from '../types';

const key: ThreadKey = { chatId: -100777, threadId: 7 };
const sessionId = 'ses_persisted_7';
const workDir = '/tmp/work-crash';
const healthPath = '/global/health';
const restoredNotice = 'OpenCode server restarted; session restored. In-flight reply was lost — resend if needed.';
const lostNotice = 'OpenCode server restarted; previous session lost. Starting a fresh one with /opencode (or /quit to release).';

let originalFetch: typeof fetch;
let originalOpencodeBin: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalOpencodeBin = process.env.OPENCODE_BIN;
  // checkIsInstalled('opencode') returns true when OPENCODE_BIN is set,
  // skipping the `which opencode` shell-out (env-dependent in CI).
  process.env.OPENCODE_BIN = '/usr/bin/true';
  // Health check → server alive, so ensureOpenCodeServer() and
  // checkIsOpenCodeServerRunning() both succeed without spawning a process.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith(healthPath)) {
      return new Response('ok', { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOpencodeBin === undefined) delete process.env.OPENCODE_BIN;
  else process.env.OPENCODE_BIN = originalOpencodeBin;
});

function createActiveSession() {
  return {
    key,
    sessionId,
    workDir,
    isActive: true,
    currentResponseText: '',
    lastEmittedLength: 0,
    outputTimer: null,
    isModelInfoShown: true,
    modelOverride: null,
    currentModelLabel: 'anthropic/claude',
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
  };
}

/**
 * Build an adapter with one active session injected and the network-touching
 * private methods stubbed. `sessionExists` controls the `GET /session/:id`
 * outcome: `true` → the restarted server still has the id (resume succeeds);
 * `false` → 404, so resume throws and the teardown fallback runs.
 */
function createAdapter(sessionExists: boolean): {
  adapter: OpenCodeAdapter;
  outputs: string[];
  closedKeys: ThreadKey[];
  getSessionRequests: string[];
} {
  const adapter = new OpenCodeAdapter();
  adapter['sessions'].set(keyToString(key), createActiveSession());

  const getSessionRequests: string[] = [];
  adapter['apiRequest'] = (async (method: string, urlPath: string) => {
    // The session-verify call is `GET /session/:id` (the basis of the resume
    // decision). `stopSessionInner` also fires a fire-and-forget
    // `POST /session/:id/abort`; resolve that quietly so it can't be mistaken
    // for the verify call.
    if (method === 'GET' && urlPath === `/session/${sessionId}`) {
      getSessionRequests.push(urlPath);
      if (!sessionExists) {
        throw new Error('OpenCode API error: 404 Not Found');
      }
      return { id: sessionId };
    }
    if (urlPath.endsWith('/abort')) {
      return undefined;
    }
    throw new Error(`unexpected apiRequest in test: ${method} ${urlPath}`);
  }) as OpenCodeAdapter['apiRequest'];

  // Keep resume off the real network: no SSE stream, no /config model lookup.
  adapter['connectSse'] = (() => {}) as OpenCodeAdapter['connectSse'];
  adapter['fetchModelInfo'] = (async () => {}) as OpenCodeAdapter['fetchModelInfo'];

  const outputs: string[] = [];
  adapter.on('output', (_key: ThreadKey, text: string) => {
    outputs.push(text);
  });
  const closedKeys: ThreadKey[] = [];
  adapter.on('closed', (closedKey: ThreadKey) => {
    closedKeys.push(closedKey);
  });

  return { adapter, outputs, closedKeys, getSessionRequests };
}

describe('OpenCode crash-resume in restartServer', () => {
  it('reloadProviderAuth forces a controlled restart so a live server reloads its credential', async () => {
    const adapter = new OpenCodeAdapter();
    let isForcedRestart = false;
    adapter['restartServer'] = async (force = false) => {
      isForcedRestart = force;
      return true;
    };

    const result = await adapter.reloadProviderAuth();

    assert.equal(result, true);
    assert.equal(isForcedRestart, true, 'OAuth credential reload must stop a healthy server generation');
  });

  it('crash → restart OK → GET /session/:id issued, session stays active with the SAME id, restored notice, NO closed', async () => {
    const { adapter, outputs, closedKeys, getSessionRequests } = createAdapter(true);

    const result = await adapter['restartServer']();
    assert.equal(result, true, 'restartServer must report success');

    // Load-bearing: the persisted id was verified on the restarted server.
    assert.deepEqual(getSessionRequests, [`/session/${sessionId}`], 'must GET the persisted session id exactly once');

    // Load-bearing: the SAME session id survives and stays active.
    const session = adapter['sessions'].get(keyToString(key));
    assert.ok(session, 'session must still be present after restore');
    assert.equal(session.sessionId, sessionId, 'restored session must keep the SAME id');
    assert.equal(session.isActive, true, 'restored session must be active');

    // Restored notice emitted; no teardown.
    assert.ok(outputs.includes(restoredNotice), `expected restored notice, got: ${JSON.stringify(outputs)}`);
    assert.equal(outputs.includes(lostNotice), false, 'must not emit the "previous session lost" notice on success');
    assert.deepEqual(closedKeys, [], 'a restored session must NOT emit closed');
  });

  it('crash → GET /session/:id 404 → teardown + closed + lost notice', async () => {
    const { adapter, outputs, closedKeys, getSessionRequests } = createAdapter(false);

    const result = await adapter['restartServer']();
    assert.equal(result, true, 'restartServer still succeeds at the server level even when a session id is gone');

    // The resume path tried (and failed) to verify the id.
    assert.deepEqual(getSessionRequests, [`/session/${sessionId}`], 'must attempt to verify the persisted id before falling back');

    // Load-bearing: the session is torn down (gone from the map / inactive).
    const session = adapter['sessions'].get(keyToString(key));
    assert.equal(session, undefined, 'a session whose id is gone must be removed');

    // Fallback teardown: lost notice + closed, no false "restored".
    assert.ok(outputs.includes(lostNotice), `expected lost notice, got: ${JSON.stringify(outputs)}`);
    assert.equal(outputs.includes(restoredNotice), false, 'must not claim "restored" when the id is gone');
    assert.deepEqual(closedKeys, [key], 'a lost session must emit closed so the bot wipes the persisted id');
  });
});
