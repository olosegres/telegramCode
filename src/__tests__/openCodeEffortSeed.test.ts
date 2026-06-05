/**
 * @description S7 lock — a NEW OpenCode session must seed its `effortLevel`
 * from the persistent per-thread pref (`loadSavedEffort(key)` at session
 * creation, openCodeAdapter.ts), so the thread's chosen reasoning effort
 * survives the session lifecycle (start / `/new`).
 *
 * This is the OpenCode counterpart of the Claude S7 fix: OpenCode is ALREADY
 * correct (it seeds at creation and applies the level per-prompt as
 * `body.variant`), so there is no code change — this test LOCKS that behavior
 * against regression.
 *
 * Harness mirrors `openCodeStartReady.test.ts`: real adapter, `apiRequest`
 * stubbed (POST /session → id; GET /config → a default model so fetchModelInfo
 * doesn't throw), `connectSse` stubbed to a no-op. The testSetup module is
 * imported FIRST so the adapter reads the seeded pref from a temp `DATA_DIR`.
 * Private members reached via runtime bracket access (tests are excluded from
 * tsconfig and run via tsx type-stripping → no typecheck impact).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  seededThreadKeyString,
  seededEffortLevel,
} from './openCodeEffortSeed.testSetup';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, keyFromString, type ThreadKey } from '../types';

const newSessionId = 'ses_effort_seed';

/**
 * @description Adapter whose lifecycle deps are stubbed: POST /session resolves
 * to a fixed id; GET /config returns a default model (so fetchModelInfo runs
 * cleanly); connectSse is a no-op (no real socket).
 */
function createStubbedAdapter(): OpenCodeAdapter {
  const adapter = new OpenCodeAdapter();
  adapter['apiRequest'] = async (method: string, urlPath: string) => {
    if (method === 'POST' && (urlPath === '/session' || urlPath.startsWith('/session?'))) {
      return { id: newSessionId };
    }
    if (method === 'GET' && (urlPath === '/config' || urlPath.startsWith('/config?'))) {
      return { defaultModel: { providerID: 'anthropic', modelID: 'claude-opus-4-8' } };
    }
    return undefined;
  };
  adapter['connectSse'] = () => {};
  return adapter;
}

/** Bounded wait for the started session to appear in the private map. */
async function waitForSession(adapter: OpenCodeAdapter, keyStr: string): Promise<unknown> {
  for (let turn = 0; turn < 200; turn++) {
    const session = adapter['sessions'].get(keyStr);
    if (session) return session;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}

describe('OpenCode new session seeds effort from the saved pref (S7 lock)', () => {
  it('a fresh startSession carries effortLevel from the on-disk per-thread pref', async () => {
    const key: ThreadKey = keyFromString(seededThreadKeyString);
    const adapter = createStubbedAdapter();

    void adapter.startSession(key, '/tmp/work');
    const session = await waitForSession(adapter, keyToString(key));

    assert.ok(session, 'session must be created');
    // Load-bearing: proves `effortLevel: loadSavedEffort(key)` at creation —
    // not just that a session exists. A regression (seeding null) fails here.
    assert.equal(
      (session as { effortLevel: string | null }).effortLevel,
      seededEffortLevel,
      'a new session must inherit the thread\'s stored effort so it survives /new',
    );
  });
});
