/**
 * @description S1/S2 — `OpenCodeAdapter.setModel` / `getCurrentModel` must
 * work with NO live session, so a model picked BEFORE `/opencode` is persisted
 * and applied at next start instead of failing "No active session".
 *
 * Bug (live-caught 2026-06-05, thread "My health"): user bound a folder, chose
 * OpenCode (no session yet), ran `/model` → replied "19" → bot answered
 * "Error: No active session". Root cause: the old `setModel` hard-failed
 * `if (!session?.isActive) return 'No active session'` before persisting.
 *
 * Harness mirrors `openCodeResumeModel.test.ts`: the testSetup module is
 * imported FIRST so the adapter reads/writes its prefs files from a temp
 * `DATA_DIR`; `getAvailableModels` + `apiRequest` are stubbed via bracket
 * access. No session is injected into the private map — that is the whole point.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  modelPrefsFile,
  effortPrefsFile,
  effortThreadKeyString,
  seededEffortLevel,
} from './openCodeSetModelNoSession.testSetup';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type ThreadKey } from '../types';

const availableModels = [
  'anthropic/claude-opus-4-8',
  'anthropic/claude-sonnet-4-6',
  'openai/gpt-5',
];

/** Providers config: opus declares low..max; sonnet declares NO variants. */
const providersConfig = {
  providers: [
    {
      id: 'anthropic',
      models: {
        'claude-opus-4-8': { variants: { low: {}, medium: {}, high: {}, max: {} } },
        'claude-sonnet-4-6': {},
      },
    },
  ],
};

function createAdapterNoSession(): OpenCodeAdapter {
  const adapter = new OpenCodeAdapter();
  // No session injected — exercise the pre-session path. Stub the two server
  // seams `setModel` reaches: the model list and the providers/variants config.
  adapter['getAvailableModels'] = async () => availableModels;
  adapter['apiRequest'] = (async (_method: string, urlPath: string) => {
    if (urlPath === '/config/providers') return providersConfig;
    throw new Error(`unexpected apiRequest: ${urlPath}`);
  }) as OpenCodeAdapter['apiRequest'];
  return adapter;
}

function readModelPref(keyStr: string): string | undefined {
  if (!fs.existsSync(modelPrefsFile)) return undefined;
  return JSON.parse(fs.readFileSync(modelPrefsFile, 'utf-8'))[keyStr];
}

function readEffortPref(keyStr: string): string | undefined {
  if (!fs.existsSync(effortPrefsFile)) return undefined;
  return JSON.parse(fs.readFileSync(effortPrefsFile, 'utf-8'))[keyStr];
}

describe('OpenCode setModel with NO active session (S1/S2)', () => {
  it('resolves, persists the pref, returns null (was: "No active session")', async () => {
    const key: ThreadKey = { chatId: -100888777, threadId: 1 };
    const adapter = createAdapterNoSession();

    const result = await adapter.setModel(key, 'anthropic/claude-opus-4-8');
    // Load-bearing: pre-fix this returned 'No active session'.
    assert.equal(result, null, 'a valid model with no session must succeed');
    assert.equal(
      readModelPref(keyToString(key)),
      'anthropic/claude-opus-4-8',
      'the pick must be persisted so the next session start replays it',
    );
  });

  it('unknown model → "not found" error, pref NOT saved', async () => {
    const key: ThreadKey = { chatId: -100888777, threadId: 2 };
    const adapter = createAdapterNoSession();

    // No slash → `resolveModelId` searches `findModelByQuery`; a name matching
    // nothing in the available list resolves to null → "not found". (A
    // slash-bearing id is intentionally accepted as a literal provider/model
    // even if absent — that's existing OpenCode behavior, not under test here.)
    const result = await adapter.setModel(key, 'definitely-not-a-real-model');
    assert.ok(result && result.includes('not found'), `expected a not-found error, got: ${result}`);
    assert.equal(readModelPref(keyToString(key)), undefined, 'a failed resolve must not persist a pref');
  });

  it('saved effort INVALID for the new model → cleared + cleared_on_model_switch emitted', async () => {
    const key: ThreadKey = { chatId: -100888777, threadId: 42 };
    assert.equal(keyToString(key), effortThreadKeyString, 'key must match the on-disk seeded effort');
    assert.equal(readEffortPref(effortThreadKeyString), seededEffortLevel, 'precondition: effort seeded');

    const adapter = createAdapterNoSession();
    const outputs: string[] = [];
    adapter.on('output', (_k: ThreadKey, text: string) => outputs.push(text));

    // sonnet declares NO variants, so the seeded `high` becomes invalid.
    const result = await adapter.setModel(key, 'anthropic/claude-sonnet-4-6');
    assert.equal(result, null);
    assert.equal(readEffortPref(effortThreadKeyString), undefined, 'stale effort must be cleared');
    assert.equal(outputs.length, 1, 'exactly one notice');
    assert.ok(outputs[0].includes(seededEffortLevel), `notice must name the dropped level: ${outputs[0]}`);
  });

  it('saved effort VALID for the new model → kept, no notice', async () => {
    // Seed a fresh thread whose effort IS a variant of the target model.
    const key: ThreadKey = { chatId: -100888777, threadId: 43 };
    fs.writeFileSync(effortPrefsFile, JSON.stringify({ [keyToString(key)]: 'high' }));

    const adapter = createAdapterNoSession();
    const outputs: string[] = [];
    adapter.on('output', (_k: ThreadKey, text: string) => outputs.push(text));

    // opus declares low..max, so `high` stays valid.
    const result = await adapter.setModel(key, 'anthropic/claude-opus-4-8');
    assert.equal(result, null);
    assert.equal(readEffortPref(keyToString(key)), 'high', 'a valid effort must be kept');
    assert.deepEqual(outputs, [], 'no clear notice when the effort still applies');
  });
});

describe('OpenCode getCurrentModel falls back to the saved pref (S2)', () => {
  it('no session → returns the saved pref label', async () => {
    const key: ThreadKey = { chatId: -100888777, threadId: 7 };
    const adapter = createAdapterNoSession();
    await adapter.setModel(key, 'openai/gpt-5');

    // No session in the map — pre-fix getCurrentModel returned null here.
    assert.equal(adapter.getCurrentModel(key), 'openai/gpt-5');
  });

  it('live session label wins over the saved pref', async () => {
    const key: ThreadKey = { chatId: -100888777, threadId: 8 };
    const adapter = createAdapterNoSession();
    await adapter.setModel(key, 'openai/gpt-5'); // saved pref on disk

    adapter['sessions'].set(keyToString(key), {
      key,
      sessionId: 'ses_8',
      workDir: '/tmp/work',
      isActive: true,
      currentResponseText: '',
      lastEmittedLength: 0,
      outputTimer: null,
      isModelInfoShown: true,
      modelOverride: { providerID: 'anthropic', modelID: 'claude-opus-4-8' },
      currentModelLabel: 'anthropic/claude-opus-4-8',
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
      isAutoNamePending: false,
    });

    assert.equal(adapter.getCurrentModel(key), 'anthropic/claude-opus-4-8', 'live label must win');
  });
});
