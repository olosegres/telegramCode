/**
 * @description S1 (plan 2026-06-05) — OpenCode session create + list are
 * folder-scoped to the bound folder's project instance via `?directory=`.
 *
 * The bound folder IS the agent's cwd, so:
 *   - `startSession` POSTs `/session?directory=<workDir>` (the agent runs in
 *     that folder, not the server's serve-cwd default instance);
 *   - `getSessions` GETs `/session?directory=<workDir>` (the list shows only
 *     that folder's sessions, no cross-instance scatter).
 *
 * Load-bearing assertions check the EXACT scoped path (encoded workDir in the
 * query), so a regression that drops `?directory=` — silently re-routing the
 * agent to the wrong folder — fails here.
 *
 * Harness mirrors openCodeStartReady.test.ts: real adapter, `apiRequest`
 * recorded, `connectSse` a no-op. Private members reached via runtime bracket
 * access (tests are excluded from tsconfig, run via tsx type-stripping).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter, buildDirectoryScopedPath } from '../adapters/openCodeAdapter';
import type { ThreadKey } from '../types';

interface ApiCall {
  method: string;
  urlPath: string;
}

const newSessionId = 'ses_folder_scoped';
const workDir = '/home/user/src/telegramCode';
const expectedQuery = `directory=${encodeURIComponent(workDir)}`;

/** Adapter with `apiRequest` recorded; POST /session resolves the id, GET
 * /config resolves a model so startSession completes, connectSse a no-op. */
function createRecordingAdapter(): { adapter: OpenCodeAdapter; calls: ApiCall[] } {
  const adapter = new OpenCodeAdapter();
  const calls: ApiCall[] = [];

  adapter['apiRequest'] = async (method: string, urlPath: string) => {
    calls.push({ method, urlPath });
    if (method === 'POST' && urlPath.startsWith('/session?')) {
      return { id: newSessionId };
    }
    if (method === 'GET' && urlPath === '/config') {
      return { defaultModel: { providerID: 'anthropic', modelID: 'claude-opus-4-8' } };
    }
    if (method === 'GET' && urlPath.startsWith('/session')) {
      return [{ id: newSessionId, title: 'scoped', time: { created: Date.now(), updated: Date.now() } }];
    }
    return undefined;
  };
  adapter['connectSse'] = () => {};

  return { adapter, calls };
}

describe('OpenCode folder-scoped create + list (S1)', () => {
  it('startSession POSTs /session with the bound folder as ?directory=', async () => {
    const { adapter, calls } = createRecordingAdapter();
    const key: ThreadKey = { chatId: -100, threadId: 1 };

    await adapter.startSession(key, workDir);

    const create = calls.find((c) => c.method === 'POST' && c.urlPath.startsWith('/session?'));
    assert.ok(create, 'startSession must POST a directory-scoped /session');
    assert.equal(create.urlPath, `/session?${expectedQuery}`, 'create path carries the encoded workDir');
  });

  it('getSessions GETs /session scoped to the bound folder', async () => {
    const { adapter, calls } = createRecordingAdapter();
    const key: ThreadKey = { chatId: -100, threadId: 2 };

    const sessions = await adapter.getSessions(key, workDir);

    assert.equal(sessions.length, 1, 'the scoped list is returned');
    const list = calls.find((c) => c.method === 'GET' && c.urlPath.startsWith('/session'));
    assert.ok(list, 'getSessions must issue a GET /session');
    assert.equal(list.urlPath, `/session?${expectedQuery}`, 'list path carries the encoded workDir');
  });

  it('buildDirectoryScopedPath leaves the path bare when no directory is known', () => {
    // The shared helper underpins both calls; an empty/undefined directory must
    // yield the unscoped path so non-folder calls (e.g. by-id) stay untouched.
    assert.equal(buildDirectoryScopedPath('/session', undefined), '/session');
    assert.equal(buildDirectoryScopedPath('/session', workDir), `/session?${expectedQuery}`);
  });
});
