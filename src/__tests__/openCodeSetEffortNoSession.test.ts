/**
 * @description `OpenCodeAdapter.setEffort` / `getAvailableEffortLevels` must
 * work with NO live session — symmetric with `setModel` (persist-first). An
 * effort picked BEFORE `/opencode` is persisted against the PROSPECTIVE model
 * (saved `/model` pref → server default) and replayed at next session start,
 * instead of hard-failing the old raw `'No active session'`.
 *
 * Harness mirrors `openCodeSetModelNoSession.test.ts`: the testSetup module is
 * imported FIRST so the adapter reads/writes its prefs files from a temp
 * `DATA_DIR`; `apiRequest` is stubbed via bracket access to serve both
 * `/config/providers` (variants) and `/config` (server-default model). No
 * session is injected into the private map — that is the whole point.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  effortPrefsFile,
  savedModelThreadKeyString,
  seededModelLabel,
} from './openCodeSetEffortNoSession.testSetup';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type ThreadKey } from '../types';

/** opus declares low..max; sonnet declares NO variants. */
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

/** Server default model used when a thread has NO saved `/model` pref. */
const serverDefaultConfig = { defaultModel: { providerID: 'anthropic', modelID: 'claude-opus-4-8' } };

function createAdapterNoSession(): OpenCodeAdapter {
  const adapter = new OpenCodeAdapter();
  // No session injected — exercise the pre-session path. Stub the two server
  // seams the effort/prospective-model code reaches: the providers/variants
  // config and the server's default model (`GET /config`).
  adapter['apiRequest'] = (async (_method: string, urlPath: string) => {
    if (urlPath === '/config/providers') return providersConfig;
    if (urlPath === '/config') return serverDefaultConfig;
    throw new Error(`unexpected apiRequest: ${urlPath}`);
  }) as OpenCodeAdapter['apiRequest'];
  return adapter;
}

function readEffortPref(keyStr: string): string | undefined {
  if (!fs.existsSync(effortPrefsFile)) return undefined;
  return JSON.parse(fs.readFileSync(effortPrefsFile, 'utf-8'))[keyStr];
}

describe('OpenCode getAvailableEffortLevels with NO active session', () => {
  it('saved /model pref → returns that prospective model variants', async () => {
    const key: ThreadKey = { chatId: -100555444, threadId: 11 };
    assert.equal(keyToString(key), savedModelThreadKeyString, 'key must match the seeded model pref');
    const adapter = createAdapterNoSession();

    // opus (the saved pref) declares low..max.
    const levels = await adapter.getAvailableEffortLevels(key);
    assert.deepEqual(levels.sort(), ['high', 'low', 'max', 'medium']);
  });

  it('no saved pref → falls back to the server default model variants', async () => {
    const key: ThreadKey = { chatId: -100555444, threadId: 99 };
    const adapter = createAdapterNoSession();

    // No /model pref for this thread → `getProspectiveModelRef` hits `/config`
    // whose defaultModel is opus → low..max.
    const levels = await adapter.getAvailableEffortLevels(key);
    assert.deepEqual(levels.sort(), ['high', 'low', 'max', 'medium']);
  });
});

describe('OpenCode setEffort with NO active session (symmetry with setModel)', () => {
  it('valid variant → persists the pref and returns null (was: "No active session")', async () => {
    const key: ThreadKey = { chatId: -100555444, threadId: 12 };
    // Seed a saved /model pref so the prospective model is opus (low..max).
    const modelPrefsFile = effortPrefsFile.replace('.opencode-effort-prefs.json', '.opencode-model-prefs.json');
    const existing = JSON.parse(fs.readFileSync(modelPrefsFile, 'utf-8'));
    existing[keyToString(key)] = seededModelLabel;
    fs.writeFileSync(modelPrefsFile, JSON.stringify(existing));

    const adapter = createAdapterNoSession();
    const result = await adapter.setEffort(key, 'high');
    // Load-bearing: pre-fix this returned the raw 'No active session'.
    assert.equal(result, null, 'a valid effort with no session must succeed');
    assert.equal(
      readEffortPref(keyToString(key)),
      'high',
      'the pick must be persisted so the next session start seeds it',
    );
    // The thread's saved effort is then readable pre-session.
    assert.equal(adapter.getEffort(key), 'high');
  });

  it('invalid variant → invalid-level notice, pref NOT persisted', async () => {
    const key: ThreadKey = { chatId: -100555444, threadId: 13 };
    // Saved /model pref = opus (low..max), so `nonsense` is not a variant.
    const modelPrefsFile = effortPrefsFile.replace('.opencode-effort-prefs.json', '.opencode-model-prefs.json');
    const existing = JSON.parse(fs.readFileSync(modelPrefsFile, 'utf-8'));
    existing[keyToString(key)] = seededModelLabel;
    fs.writeFileSync(modelPrefsFile, JSON.stringify(existing));

    const adapter = createAdapterNoSession();
    const result = await adapter.setEffort(key, 'nonsense');
    assert.ok(result && result.includes('nonsense'), `expected an invalid-level notice, got: ${result}`);
    assert.equal(
      readEffortPref(keyToString(key)),
      undefined,
      'an invalid effort must not persist a pref',
    );
  });

  it('prospective model has NO variants → not-supported notice naming that model', async () => {
    const key: ThreadKey = { chatId: -100555444, threadId: 14 };
    // Saved /model pref = sonnet, which declares NO variants.
    const sonnetLabel = 'anthropic/claude-sonnet-4-6';
    const modelPrefsFile = effortPrefsFile.replace('.opencode-effort-prefs.json', '.opencode-model-prefs.json');
    const existing = JSON.parse(fs.readFileSync(modelPrefsFile, 'utf-8'));
    existing[keyToString(key)] = sonnetLabel;
    fs.writeFileSync(modelPrefsFile, JSON.stringify(existing));

    const adapter = createAdapterNoSession();
    const result = await adapter.setEffort(key, 'high');
    // Must name the PROSPECTIVE model (live currentModelLabel is null pre-session).
    assert.ok(
      result && result.includes(sonnetLabel),
      `not-supported notice must name the prospective model, got: ${result}`,
    );
    assert.equal(readEffortPref(keyToString(key)), undefined, 'nothing persisted when the model has no variants');
  });
});
