/**
 * @description B17 — after a BOT hot-restart, a re-attached OpenCode session
 * must keep a resolved model so `/effort` still works.
 *
 * Bug (verified live 2026-06-04): a session created without a `/model` pick took
 * its model from the server default via `fetchModelInfo` at `startSession`. That
 * resolution lived only in memory (`modelOverride` / `currentModelLabel`) and was
 * never persisted. On a bot restart the session went through `resumeSession`,
 * which only called `restoreSavedModel(…, false)` — that returns false when there
 * is no saved pref, leaving `modelOverride`/`currentModelLabel` null. `/effort`
 * then reads a null model and reports "levels unavailable", even though
 * `GET /config/providers` still serves the variants.
 *
 * Fix (approach a — keep "follow the server default" semantics, no drift): the
 * resume path now re-runs `fetchModelInfo(key, false)`. The `emitOutput=false`
 * flag re-resolves the SAME model silently — the label is unchanged from the
 * previous run and already shown in the topic, so re-emitting "Model: …" on every
 * restart would be noise.
 *
 * Red→green: on the pre-fix code, resume left `modelOverride`/`currentModelLabel`
 * null when no pref existed, so `getAvailableEffortLevels` returned `[]` (test 1
 * would fail its non-empty assertion). The new `fetchModelInfo(key, false)` call
 * populates them from the server default, so the variants resolve.
 *
 * Harness mirrors `openCodeModelInfo.test.ts`: a session is injected, `apiRequest`
 * is stubbed, `output` events captured, and the private `fetchModelInfo` driven
 * via bracket access. `./openCodeResumeModel.testSetup` is imported FIRST so the
 * adapter reads its model-prefs file from a temp `DATA_DIR` (see that file's note).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { savedPrefKeyString, savedPrefLabel } from './openCodeResumeModel.testSetup';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type ThreadKey } from '../types';

// Server-default thread: no on-disk `/model` pref (key absent from the prefs
// file), so resolution falls through to the server default — the B17 case.
const serverDefaultKey: ThreadKey = { chatId: -100999444, threadId: 222 };
const serverDefaultProviderID = 'anthropic';
const serverDefaultModelID = 'claude-opus-4-8';
const serverDefaultLabel = `${serverDefaultProviderID}/${serverDefaultModelID}`;

// Thread that explicitly picked a model via `/model` — pref persisted on disk by
// the setup module. `keyToString` must produce `savedPrefKeyString`.
const savedPrefKey: ThreadKey = { chatId: -100999444, threadId: 111 };

const expectedVariants = ['low', 'medium', 'high', 'max'];

type ApiRequestStub = (method: string, urlPath: string) => Promise<unknown>;

/** Stub serving the live server endpoints the resolution + effort paths hit. */
const stubServerEndpoints: ApiRequestStub = async (_method, urlPath) => {
  if (urlPath === '/config') {
    return {
      defaultModel: { providerID: serverDefaultProviderID, modelID: serverDefaultModelID },
    };
  }
  if (urlPath === '/config/providers') {
    return {
      providers: [
        {
          id: serverDefaultProviderID,
          models: {
            [serverDefaultModelID]: {
              variants: { low: {}, medium: {}, high: {}, max: {} },
            },
          },
        },
      ],
    };
  }
  throw new Error(`unexpected apiRequest: ${urlPath}`);
};

function createAdapterWithSession(key: ThreadKey): {
  adapter: OpenCodeAdapter;
  outputs: string[];
} {
  const adapter = new OpenCodeAdapter();
  const session = {
    key,
    sessionId: `ses_${key.threadId}`,
    workDir: '/tmp/work',
    isActive: true,
    currentResponseText: '',
    lastEmittedLength: 0,
    outputTimer: null,
    isModelInfoShown: false,
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
  };
  // Private members; runtime-only bracket access (tests are tsx-stripped).
  adapter['sessions'].set(keyToString(key), session);
  adapter['apiRequest'] = stubServerEndpoints;

  const outputs: string[] = [];
  adapter.on('output', (_key: ThreadKey, text: string) => {
    outputs.push(text);
  });
  return { adapter, outputs };
}

describe('OpenCode resume model resolution (B17)', () => {
  it('resume with NO saved pref re-resolves the server default → /effort levels available, silently', async () => {
    assert.equal(keyToString(savedPrefKey), savedPrefKeyString, 'savedPrefKey must map to the on-disk pref entry');

    const { adapter, outputs } = createAdapterWithSession(serverDefaultKey);

    // What the resume path now does (was: restoreSavedModel(…, false) only).
    await adapter['fetchModelInfo'](serverDefaultKey, false);

    const session = adapter['sessions'].get(keyToString(serverDefaultKey));
    // The B17 fix: state is repopulated from the server default.
    assert.equal(session.currentModelLabel, serverDefaultLabel, 'model label must be re-resolved on resume');
    assert.deepEqual(
      session.modelOverride,
      { providerID: serverDefaultProviderID, modelID: serverDefaultModelID },
      'modelOverride must be re-resolved on resume so /effort can read it',
    );

    // End-to-end proof: /effort can now list the levels (pre-fix: [] → "levels unavailable").
    const levels = await adapter['getAvailableEffortLevels'](serverDefaultKey);
    assert.deepEqual(levels, expectedVariants, 'resumed session must expose the model variants for /effort');

    // Restart-noise: silent re-resolution emits nothing into the topic.
    assert.deepEqual(outputs, [], 'resume must not re-emit "Model: …" on every restart');
  });

  it('resume with a saved /model pref → pref wins, no server-default lookup, no emit', async () => {
    const { adapter, outputs } = createAdapterWithSession(savedPrefKey);
    // Fail loudly if resolution wrongly reaches the server instead of the pref.
    adapter['apiRequest'] = async (_method, urlPath) => {
      throw new Error(`pref should win — server must not be queried (${urlPath})`);
    };

    await adapter['fetchModelInfo'](savedPrefKey, false);

    const session = adapter['sessions'].get(keyToString(savedPrefKey));
    assert.equal(session.currentModelLabel, savedPrefLabel, 'saved /model pref must win on resume');
    assert.deepEqual(session.modelOverride, {
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-6',
    });
    assert.deepEqual(outputs, [], 'silent resume must not emit even when restoring a saved pref');
  });

  it('fresh start (emitOutput=true) DOES announce the resolved model — resume silence is opt-in', async () => {
    const { adapter, outputs } = createAdapterWithSession(serverDefaultKey);

    // startSession calls fetchModelInfo with the default emitOutput=true.
    await adapter['fetchModelInfo'](serverDefaultKey);

    assert.deepEqual(
      outputs,
      [`Model: ${serverDefaultLabel}`],
      'a fresh session announces its model exactly once',
    );
  });
});
