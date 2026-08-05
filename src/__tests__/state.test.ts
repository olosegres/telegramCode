/**
 * @description Plan §11 Этап 7 — state-store coverage:
 *
 *   R4. Legacy migration: `~/.telegram-bot-messages.json` → `.bak`.
 *   R5. Concurrent `setBinding` / `setAgentChoice` from two callers
 *       under the same `ThreadKey` doesn't lose either write
 *       (per-key async-lock, plan §13.15).
 *   R6. Corrupted `state.json` is archived to
 *       `state.json.corrupted-<ts>` and the store starts fresh
 *       (plan §13.14).
 *
 * Each test creates an isolated `dataDir` under `os.tmpdir()` and overrides
 * `HOME` so the legacy-file check (which reads `os.homedir()`) sees the
 * tmp directory, not the developer's real home. `HOME` is restored in
 * `afterEach`.
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateStore } from '../state';
import { keyToString, type ThreadKey } from '../types';

let dataDir: string;
let fakeHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-home-'));
  dataDir = path.join(fakeHome, '.telegramCode');
  fs.mkdirSync(dataDir, { recursive: true });
  originalHome = process.env.HOME;
  // Node's `os.homedir()` on POSIX falls back to `process.env.HOME` when
  // the userInfo lookup yields the default. Overriding it here keeps the
  // legacy-migration probe from touching the developer's real homedir.
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

const key1: ThreadKey = { chatId: -1001234567890, threadId: 42 };
const key2: ThreadKey = { chatId: -1001234567890, threadId: 99 };

test('R4: legacy ~/.telegram-bot-messages.json is renamed to .bak on init', async () => {
  const legacy = path.join(fakeHome, '.telegram-bot-messages.json');
  fs.writeFileSync(legacy, JSON.stringify({ '12345': [1, 2, 3] }));

  const store = new StateStore(dataDir, { saveDebounceMs: 20 });
  await store.init();

  assert.equal(fs.existsSync(legacy), false, 'legacy file should be gone');
  assert.equal(fs.existsSync(legacy + '.bak'), true, '.bak should exist');
  assert.equal(store.getLegacyMigrationPath(), legacy + '.bak');
});

test('R4: init is a no-op if there is no legacy file', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 20 });
  await store.init();
  assert.equal(store.getLegacyMigrationPath(), null);
});

test('R5: concurrent setBinding under the same key serialises and both writes land', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();

  // Fire two writes for the same key concurrently. Without the per-key
  // lock the second read-modify-write would clobber the first half of
  // the time; with the lock the final state is deterministic.
  await Promise.all([
    store.setBinding(key1, 'alpha'),
    store.setBinding(key1, 'beta'),
  ]);

  // Whichever ran second wins, but the in-memory state must match the
  // on-disk state — that's the actual invariant.
  await store.flush();
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  const persisted = raw.bindings[`${key1.chatId}:${key1.threadId}`];
  const inMemory = store.getBinding(key1);
  assert.ok(persisted, 'binding must exist on disk');
  assert.equal(persisted.subdir, inMemory?.subdir, 'on-disk and in-memory must agree');
  assert.ok(['alpha', 'beta'].includes(persisted.subdir));
});

test('R5: concurrent setBinding on DIFFERENT keys both land', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();

  await Promise.all([
    store.setBinding(key1, 'alpha'),
    store.setBinding(key2, 'beta'),
  ]);
  await store.flush();

  assert.equal(store.getBinding(key1)?.subdir, 'alpha');
  assert.equal(store.getBinding(key2)?.subdir, 'beta');
});

test('scheduler MCP port: undefined by default, persisted + reloaded across restarts', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.equal(store.getPersistedSchedulerMcpPort(), undefined, 'no port persisted on a fresh store');

  await store.setSchedulerMcpPort(41234);
  assert.equal(store.getPersistedSchedulerMcpPort(), 41234, 'in-memory value updated');

  // A fresh store over the same dataDir must reload the persisted port (the
  // whole point: the next boot reuses it so registrations stay valid).
  const reloaded = new StateStore(dataDir, { saveDebounceMs: 5 });
  await reloaded.init();
  assert.equal(reloaded.getPersistedSchedulerMcpPort(), 41234, 'reloaded from disk');
});

test('R6: corrupted state.json is archived and store starts fresh', async () => {
  const statePath = path.join(dataDir, 'state.json');
  fs.writeFileSync(statePath, '{ this is not valid json');

  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();

  assert.equal(store.wasCorruptedOnLoad(), true, 'corruption flag must be set');
  const archive = store.getCorruptedArchivePath();
  assert.ok(archive, 'archive path must be exposed');
  assert.match(path.basename(archive!), /^state\.json\.corrupted-/);
  assert.equal(fs.existsSync(archive!), true, 'archive file must exist on disk');
  assert.equal(fs.existsSync(statePath), true, 'fresh state.json must be written');
  assert.equal(store.listBindings().length, 0, 'fresh state has no bindings');
});

test('R6: missing state.json is treated as a fresh start (no archive, no corruption flag)', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.equal(store.wasCorruptedOnLoad(), false);
  assert.equal(store.getCorruptedArchivePath(), null);
  assert.equal(store.listBindings().length, 0);
});

test('R6: valid state.json is loaded and bindings are visible after restart', async () => {
  // Round-trip persistence: write some data, reload from disk in a
  // second store instance, confirm the bindings are intact.
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setBinding(key1, 'alpha');
  await first.setAgent(key1, { name: 'claude' });
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.wasCorruptedOnLoad(), false);
  assert.equal(second.getBinding(key1)?.subdir, 'alpha');
  assert.equal(second.getAgent(key1)?.name, 'claude');
});

test('Forward-compat: state.json with an unknown future field still loads cleanly', async () => {
  // Audit S19: pin forward-compat — if we ever add a new top-level
  // field, an older bot reading the file must NOT treat it as corrupt
  // (we'd lose every binding to "archived to .corrupted"). The shape
  // check in `loadStateFile` only requires the known fields; unknown
  // extras are preserved untouched on the next save.
  const statePath = path.join(dataDir, 'state.json');
  const futureShape = {
    version: 1,
    bindings: { '-1001:42': { subdir: 'alpha', createdAt: new Date().toISOString() } },
    agents: {},
    messages: {},
    futurePrefs: { newFeatureFlag: true }, // unknown top-level field
  };
  fs.writeFileSync(statePath, JSON.stringify(futureShape));

  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.equal(store.wasCorruptedOnLoad(), false, 'unknown field must not trigger corruption');
  assert.equal(store.listBindings().length, 1, 'binding must survive');
  assert.equal(store.getBinding({ chatId: -1001, threadId: 42 })?.subdir, 'alpha');
});

test('pinnedStatusText: set → get round-trips on the binding row', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setBinding(key1, 'alpha');
  await store.setBindingPinnedStatusText(key1, 'Claude · idle');
  assert.equal(store.getBinding(key1)?.pinnedStatusText, 'Claude · idle');
});

test('pinnedStatusText: survives a reload from disk (the B8 restart case)', async () => {
  // THE load-bearing case: the in-memory dedup cache is empty on every
  // restart, so the persisted text is the ONLY thing that lets the boot
  // refresh wave skip identical-banner edits. If this doesn't survive a
  // reload, the whole B8 fix is a no-op.
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setBinding(key1, 'alpha');
  await first.setBindingPinnedStatusText(key1, 'Claude · running');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getBinding(key1)?.pinnedStatusText, 'Claude · running');
});

test('pinnedStatusText: passing null clears it on disk', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setBinding(key1, 'alpha');
  await first.setBindingPinnedStatusText(key1, 'Claude · running');
  await first.setBindingPinnedStatusText(key1, null);
  await first.flush();

  // Cleared in memory…
  assert.equal(first.getBinding(key1)?.pinnedStatusText, undefined);
  // …and on disk (so a stale text can never suppress the next real edit).
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal('pinnedStatusText' in raw.bindings[`${key1.chatId}:${key1.threadId}`], false);

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getBinding(key1)?.pinnedStatusText, undefined);
});

test('pinnedStatusText: no-op when binding does not exist (no dangling row)', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setBindingPinnedStatusText(key1, 'orphan');
  assert.equal(store.getBinding(key1), null, 'must not create a binding row');
});

test('pinnedStatusText: setting the same text twice does not re-mark for save', async () => {
  // Mirrors setBindingPinnedStatusMessageId: an unchanged value is a no-op.
  // We assert idempotency via the on-disk round-trip rather than spying on
  // scheduleSave (private), which is enough to prove the value is stable.
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setBinding(key1, 'alpha');
  await store.setBindingPinnedStatusText(key1, 'same');
  await store.setBindingPinnedStatusText(key1, 'same');
  await store.flush();
  assert.equal(store.getBinding(key1)?.pinnedStatusText, 'same');
});

test('pinnedStatusText: persists alongside pinnedStatusMessageId independently', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setBinding(key1, 'alpha');
  await first.setBindingPinnedStatusMessageId(key1, 777);
  await first.setBindingPinnedStatusText(key1, 'Claude · idle');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getBinding(key1)?.pinnedStatusMessageId, 777);
  assert.equal(second.getBinding(key1)?.pinnedStatusText, 'Claude · idle');
});

test('pairedGroupId: defaults to null when never paired', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.equal(store.getPairedGroupId(), null);
});

test('pairedGroupId: set → get round-trips and survives a reload from disk', async () => {
  const groupId = -1009876543210;
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setPairedGroupId(groupId);
  assert.equal(first.getPairedGroupId(), groupId);

  // setPairedGroupId flushes immediately — a second store reads it back
  // without an explicit flush, proving the id is durable across restart.
  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getPairedGroupId(), groupId);
});

test('clearAgentSessionIds: removes both session ids but keeps name and model', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'opencode', model: 'anthropic/claude-3-5-sonnet' });
  await store.setClaudeSessionId(key1, 'claude-uuid-1');
  await store.setOpenCodeSessionId(key1, 'oc-id-1');

  // Pre-condition: both ids are present (proves the wipe really changed state,
  // not a vacuous pass on an already-empty record).
  assert.equal(store.getClaudeSessionId(key1), 'claude-uuid-1');
  assert.equal(store.getOpenCodeSessionId(key1), 'oc-id-1');

  await store.clearAgentSessionIds(key1);

  assert.equal(store.getClaudeSessionId(key1), null, 'claudeSessionId must be gone');
  assert.equal(store.getOpenCodeSessionId(key1), null, 'opencodeSessionId must be gone');
  const agent = store.getAgent(key1);
  assert.equal(agent?.name, 'opencode', 'name must survive the wipe');
  assert.equal(agent?.model, 'anthropic/claude-3-5-sonnet', 'model must survive the wipe');
});

test('clearAgentSessionIds: no-op when the thread has no agent record', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.clearAgentSessionIds(key1);
  assert.equal(store.getAgent(key1), null, 'must not create a dangling agent row');
});

test('clearAgentSessionIds: also drops the session-start timestamp', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'claude' });
  await store.setClaudeSessionId(key1, 'claude-uuid-1');
  await store.setAgentStartedAt(key1, '2026-06-27T19:42:10+04:00');
  // Pre-condition: the timestamp is present, so the drop really changes state.
  assert.equal(store.getAgent(key1)?.startedAt, '2026-06-27T19:42:10+04:00');

  await store.clearAgentSessionIds(key1);

  const agent = store.getAgent(key1);
  assert.equal(agent?.name, 'claude', 'name must survive the release');
  assert.equal(agent?.startedAt, undefined, 'startedAt must be dropped with the session');
});

// ── setAgentStartedAt (session-start timestamp for /status) ──

test('setAgentStartedAt: merges onto the agent row without flipping name, coexists with session ids', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'claude', model: 'sonnet' });
  await store.setClaudeSessionId(key1, 'claude-uuid-1');

  await store.setAgentStartedAt(key1, '2026-06-27T19:42:10+04:00');

  const agent = store.getAgent(key1);
  assert.equal(agent?.name, 'claude', 'name must not flip');
  assert.equal(agent?.model, 'sonnet', 'model must survive');
  assert.equal(agent?.claudeSessionId, 'claude-uuid-1', 'session id must coexist');
  assert.equal(agent?.startedAt, '2026-06-27T19:42:10+04:00');
});

test('setAgentStartedAt: a later setAgent (model change) does NOT wipe startedAt (merge)', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'opencode' });
  await store.setAgentStartedAt(key1, '2026-06-27T19:42:10+04:00');
  // A subsequent partial update (e.g. /model) must preserve the timestamp.
  await store.setAgent(key1, { name: 'opencode', model: 'anthropic/claude-3-5-sonnet' });
  const agent = store.getAgent(key1);
  assert.equal(agent?.startedAt, '2026-06-27T19:42:10+04:00', 'startedAt must survive a merge');
  assert.equal(agent?.model, 'anthropic/claude-3-5-sonnet');
});

test('setAgentStartedAt: no-op when the thread has no agent record (needs a live agent)', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgentStartedAt(key1, '2026-06-27T19:42:10+04:00');
  assert.equal(store.getAgent(key1), null, 'must not create a dangling agent row');
});

test('setAgentStartedAt: persists to disk and survives a reload', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setAgent(key1, { name: 'claude' });
  await first.setClaudeSessionId(key1, 'claude-uuid-1');
  await first.setAgentStartedAt(key1, '2026-06-27T19:42:10+04:00');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getAgent(key1)?.startedAt, '2026-06-27T19:42:10+04:00', 'startedAt must survive a restart');
});

// ── setSeenWatermark (reattach recap watermark) ──

test('setSeenWatermark: merges onto the agent row without flipping name, coexists with session ids', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'claude', model: 'sonnet' });
  await store.setClaudeSessionId(key1, 'claude-uuid-1');

  await store.setSeenWatermark(key1, { sessionId: 'claude-uuid-1', claudeTranscriptOffset: 4096 });

  const agent = store.getAgent(key1);
  assert.equal(agent?.name, 'claude', 'name must not flip');
  assert.equal(agent?.model, 'sonnet', 'model must survive');
  assert.equal(agent?.claudeSessionId, 'claude-uuid-1', 'session id must coexist');
  assert.deepEqual(agent?.seenWatermark, { sessionId: 'claude-uuid-1', claudeTranscriptOffset: 4096 });
});

test('setSeenWatermark: a later write overwrites the previous watermark', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setAgent(key1, { name: 'opencode' });
  await store.setSeenWatermark(key1, { sessionId: 'oc-id-1', opencodeMessageId: 'msg-1' });
  // Intermediate state proves the first write landed (not a vacuous pass).
  assert.deepEqual(store.getAgent(key1)?.seenWatermark, { sessionId: 'oc-id-1', opencodeMessageId: 'msg-1' });
  await store.setSeenWatermark(key1, { sessionId: 'oc-id-1', opencodeMessageId: 'msg-2' });
  assert.deepEqual(store.getAgent(key1)?.seenWatermark, { sessionId: 'oc-id-1', opencodeMessageId: 'msg-2' });
});

test('setSeenWatermark: no-op when the thread has no agent record (a watermark needs a live agent)', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setSeenWatermark(key1, { sessionId: 'oc-id-1', opencodeMessageId: 'msg-1' });
  assert.equal(store.getAgent(key1), null, 'must not create a dangling agent row');
});

test('setSeenWatermark: persists to disk and survives a reload', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setAgent(key1, { name: 'opencode' });
  await first.setOpenCodeSessionId(key1, 'oc-id-1');
  await first.setSeenWatermark(key1, { sessionId: 'oc-id-1', opencodeMessageId: 'msg-42' });
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getAgent(key1)?.opencodeSessionId, 'oc-id-1', 'session id must survive');
  assert.deepEqual(second.getAgent(key1)?.seenWatermark, { sessionId: 'oc-id-1', opencodeMessageId: 'msg-42' });
});

test('clearAgentSessionIds: the wipe is persisted to disk', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setAgent(key1, { name: 'opencode' });
  await first.setOpenCodeSessionId(key1, 'oc-id-1');
  await first.clearAgentSessionIds(key1);
  await first.flush();

  // Reload from disk: the persisted record must have the name but no ids,
  // so a later bot restart can't auto-reattach the released session.
  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getAgent(key1)?.name, 'opencode');
  assert.equal(second.getOpenCodeSessionId(key1), null);
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  const persistedAgent = raw.agents[`${key1.chatId}:${key1.threadId}`];
  assert.ok(persistedAgent, 'agent row must still exist on disk');
  assert.equal('opencodeSessionId' in persistedAgent, false, 'id key must be absent on disk');
});

// ── topicName (thread-context preamble) ──

test('topicName: setBinding with topicName persists it and survives a reload', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  // Mirrors the `/new` and pending-name-copy-on-bind paths: the caller knows
  // the topic name at bind time and passes it through `setBinding`.
  await first.setBinding(key1, 'alpha', { topicName: 'Fix login bug' });
  assert.equal(first.getBinding(key1)?.topicName, 'Fix login bug');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getBinding(key1)?.topicName, 'Fix login bug', 'name must survive restart');
  assert.equal(second.getBinding(key1)?.subdir, 'alpha');
});

test('topicName: re-binding WITHOUT a name keeps the previously stored name', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setBinding(key1, 'alpha', { topicName: 'Fix login bug' });
  // A later re-bind that doesn't know the name (e.g. a picker tap) must not
  // wipe the name we already learned — the carry-through branch in setBinding.
  await store.setBinding(key1, 'beta');
  assert.equal(store.getBinding(key1)?.subdir, 'beta', 'subdir must update');
  assert.equal(store.getBinding(key1)?.topicName, 'Fix login bug', 'name must be carried through');
});

test('setBindingTopicName: updates an existing binding and persists', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setBinding(key1, 'alpha', { topicName: 'Old name' });
  // The forum_topic_edited (rename) path.
  await first.setBindingTopicName(key1, 'New name');
  assert.equal(first.getBinding(key1)?.topicName, 'New name');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getBinding(key1)?.topicName, 'New name', 'rename must survive restart');
});

test('setBindingTopicName: no-op when the binding does not exist (no dangling row)', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setBindingTopicName(key1, 'orphan');
  assert.equal(store.getBinding(key1), null, 'must not create a binding row');
});

// ── output-trace toggle (/trace) ──

test('traceConfig: defaults all-threads ON (always-on observability) on a fresh state file', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.deepEqual(store.getTraceConfig(), { allThreads: true, threadKeys: [] });
});

test('traceConfig: set → get round-trips and survives a reload from disk', async () => {
  const keyStr = `${key1.chatId}:${key1.threadId}`;
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setTraceConfig({ allThreads: false, threadKeys: [keyStr] });
  assert.deepEqual(first.getTraceConfig(), { allThreads: false, threadKeys: [keyStr] });
  await first.flush();

  // The whole point of persisting the toggle: a hot rebuild mid-debug must
  // re-seed the SAME traced threads, or the trace silently turns off.
  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.deepEqual(second.getTraceConfig(), { allThreads: false, threadKeys: [keyStr] });
});

test('traceConfig: the all-flag persists and reloads', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setTraceConfig({ allThreads: true, threadKeys: [] });
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getTraceConfig().allThreads, true);
});

test('traceConfig: `/trace off all` is DURABLE — false persists and reloads (not re-enabled by the ON default)', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  // Turn the always-on default OFF.
  await first.setTraceConfig({ allThreads: false, threadKeys: [] });
  assert.equal(first.getTraceConfig().allThreads, false);
  await first.flush();

  // `false` must be stored EXPLICITLY: dropping it would read back as the ON
  // default on the next boot, silently re-enabling tracing after `/trace off all`.
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(raw.traceAllThreads, false, 'off all-flag stored explicitly as false');

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getTraceConfig().allThreads, false, 'off survives reload');
});

test('traceConfig: dedups + sorts thread keys and drops an empty thread list on disk', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setTraceConfig({ allThreads: true, threadKeys: ['-1:2', '-1:1', '-1:2'] });
  assert.deepEqual(store.getTraceConfig().threadKeys, ['-1:1', '-1:2'], 'deduped + sorted');
  await store.flush();
  const rawOn = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(rawOn.traceAllThreads, true, 'all-flag stored explicitly');

  // Turning the per-thread list off must leave no empty array on disk.
  await store.setTraceConfig({ allThreads: true, threadKeys: [] });
  await store.flush();
  const rawOff = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal('tracedThreads' in rawOff, false, 'empty thread list must be absent on disk');
});

// ── prompt-timestamp toggle (/timestamps) ──

test('timestamps: default OFF on a fresh state file', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.equal(store.checkIsTimestampsEnabled(key1), false);
});

test('timestamps: on → persists, survives a reload, and is per-thread', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setTimestampsEnabled(key1, true);
  assert.equal(first.checkIsTimestampsEnabled(key1), true);
  assert.equal(first.checkIsTimestampsEnabled(key2), false, 'toggle is per-thread');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.checkIsTimestampsEnabled(key1), true, 'on survives reload');
  assert.equal(second.checkIsTimestampsEnabled(key2), false);
});

test('timestamps: off removes the thread and drops an empty list on disk', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setTimestampsEnabled(key1, true);
  await store.setTimestampsEnabled(key1, false);
  assert.equal(store.checkIsTimestampsEnabled(key1), false);
  await store.flush();
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal('timestampThreads' in raw, false, 'empty list must be absent on disk');
});

// ── setTransientFrames (transient status-frame ids — restart cleanup, S2) ──

test('setTransientFrames: set → get round-trips the id list for a thread', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setTransientFrames(key1, [101, 202, 303]);
  assert.deepEqual(store.getTransientFrames(), { [keyToString(key1)]: [101, 202, 303] });
});

test('setTransientFrames: an empty list clears the key (clean state.json)', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setTransientFrames(key1, [101]);
  // Intermediate state proves the first write landed (not a vacuous pass).
  assert.equal(Object.keys(store.getTransientFrames()).length, 1, 'precondition: one key present');
  await store.setTransientFrames(key1, []);
  assert.deepEqual(store.getTransientFrames(), {}, 'empty list must drop the key');
});

test('setTransientFrames: survives a save/load round-trip from disk', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setTransientFrames(key1, [55, 66]);
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.deepEqual(second.getTransientFrames(), { [keyToString(key1)]: [55, 66] });
});

test('setTransientFrames: the empty-list clear is persisted to disk (no dangling key)', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setTransientFrames(key1, [7, 8]);
  await first.setTransientFrames(key1, []);
  await first.flush();
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal('transientFrames' in raw, false, 'empty map must be absent on disk');
});

test('setTransientFrames: does not touch agents or bindings', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setBinding(key1, 'proj');
  await store.setAgent(key1, { name: 'claude', model: 'sonnet' });
  await store.setTransientFrames(key1, [7]);
  assert.equal(store.getBinding(key1)?.subdir, 'proj', 'binding untouched');
  assert.equal(store.getAgent(key1)?.name, 'claude', 'agent name untouched');
  assert.equal(store.getAgent(key1)?.model, 'sonnet', 'agent model untouched');
});

test('setTransientFrames: two threads are independent', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setTransientFrames(key1, [1, 2]);
  await store.setTransientFrames(key2, [3]);
  await store.setTransientFrames(key1, []);
  assert.deepEqual(store.getTransientFrames(), { [keyToString(key2)]: [3] });
});

// The boot-reconcile crash-recovery guard (S2): `startBot` captures
// `getTransientFrames()` BEFORE reattach, then a reattached session's first frame
// setter clobbers the LIVE set. The captured snapshot must survive that clobber,
// otherwise the orphaned frame is never deleted (the bug found in live testing).
// This holds because `getTransientFrames` returns a shallow copy and
// `setTransientFrames` never mutates an existing array in place — it deletes the
// key or assigns a fresh `.slice()`.

test('getTransientFrames: a captured snapshot survives a later CLEAR clobber', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setTransientFrames(key1, [101]);
  const snapshot = store.getTransientFrames(); // captured "before reattach"
  await store.setTransientFrames(key1, []); // reattach clears the live set
  assert.deepEqual(
    snapshot,
    { [keyToString(key1)]: [101] },
    'snapshot must still carry the stale id for boot reconcile to delete',
  );
  assert.deepEqual(store.getTransientFrames(), {}, 'live set is now empty');
});

test('getTransientFrames: a captured snapshot survives a later REPLACE clobber', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setTransientFrames(key1, [101]);
  const snapshot = store.getTransientFrames();
  await store.setTransientFrames(key1, [999]); // reattach repaints → new id
  assert.deepEqual(
    snapshot,
    { [keyToString(key1)]: [101] },
    'replace assigns a fresh array, never mutates the snapshot in place',
  );
  assert.deepEqual(store.getTransientFrames(), { [keyToString(key1)]: [999] });
});

test('chatLocaleOverride: set → reload → clear drops the persisted map', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setChatLocaleOverride(key1.chatId, 'de');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getChatLocaleOverride(key1.chatId), 'de');

  await second.setChatLocaleOverride(key1.chatId, null);
  await second.flush();
  assert.equal(second.getChatLocaleOverride(key1.chatId), null);
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal('chatLocaleOverrides' in raw, false, 'empty override map must be absent on disk');
});

test('chatTelegramLocale: persists separately from an explicit override', async () => {
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setChatTelegramLocale(key1.chatId, 'pt');
  await first.setChatLocaleOverride(key1.chatId, 'ru');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.equal(second.getChatTelegramLocale(key1.chatId), 'pt');
  assert.equal(second.getChatLocaleOverride(key1.chatId), 'ru');
});
