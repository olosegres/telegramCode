/**
 * @description `persistAdapterSessionIds` is the single persistence step shared
 * by a fresh agent start AND a `/sessions` resume pick. The resume path
 * (`resumeSessionByIndex` in bot.ts) is not unit-reachable, so the contract is
 * locked here on the extracted helper: the adapter's CURRENT backend session id
 * must be the one written — that is exactly what the resume path relies on to
 * survive a bot restart (live incident 2026-06-10: a picked session was lost
 * because only the fresh-start path persisted).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  persistAdapterSessionIds,
  type SessionIdPersistenceStore,
} from '../utils/persistAdapterSessionIds';
import type { ThreadKey } from '../types';

const key: ThreadKey = { chatId: -100123, threadId: 42 };

interface RecordedWrites {
  claudeSessionId: string | null;
  opencodeSessionId: string | null;
  agentName: string | null;
}

function createRecordingStore(): { store: SessionIdPersistenceStore; writes: RecordedWrites } {
  const writes: RecordedWrites = { claudeSessionId: null, opencodeSessionId: null, agentName: null };
  const store: SessionIdPersistenceStore = {
    async setClaudeSessionId(_key, uuid) {
      writes.claudeSessionId = uuid;
    },
    async setOpenCodeSessionId(_key, id) {
      writes.opencodeSessionId = id;
    },
    async setAgent(_key, data) {
      writes.agentName = data.name;
    },
  };
  return { store, writes };
}

test('claude adapter: persists the CURRENT tmux/CLI UUID and the agent name', async () => {
  const { store, writes } = createRecordingStore();
  await persistAdapterSessionIds(
    key,
    { name: 'claude', getClaudeSessionId: () => 'uuid-picked-via-resume' },
    store,
  );
  // Load-bearing: the PICKED (current) id is written — a restart re-attaches
  // to it instead of the id an earlier fresh start left behind.
  assert.equal(writes.claudeSessionId, 'uuid-picked-via-resume');
  assert.equal(writes.agentName, 'claude');
  assert.equal(writes.opencodeSessionId, null, 'must not touch the other backend');
});

test('opencode adapter: persists the CURRENT server session id and the agent name', async () => {
  const { store, writes } = createRecordingStore();
  await persistAdapterSessionIds(
    key,
    { name: 'opencode', getOpenCodeSessionId: () => 'ses_picked_via_resume' },
    store,
  );
  assert.equal(writes.opencodeSessionId, 'ses_picked_via_resume');
  assert.equal(writes.agentName, 'opencode');
  assert.equal(writes.claudeSessionId, null, 'must not touch the other backend');
});

test('a null live id keeps the persisted id untouched but still records the agent name', async () => {
  const { store, writes } = createRecordingStore();
  await persistAdapterSessionIds(key, { name: 'claude', getClaudeSessionId: () => null }, store);
  assert.equal(writes.claudeSessionId, null, 'no id write when the adapter reports none');
  assert.equal(writes.agentName, 'claude', 'agent name is recorded unconditionally');
});

test('an adapter without backend id getters only records the agent name', async () => {
  const { store, writes } = createRecordingStore();
  await persistAdapterSessionIds(key, { name: 'opencode' }, store);
  assert.equal(writes.claudeSessionId, null);
  assert.equal(writes.opencodeSessionId, null);
  assert.equal(writes.agentName, 'opencode');
});
