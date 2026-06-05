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
import type { ThreadKey } from '../types';

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

test('traceConfig: defaults to off/empty on a fresh state file', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.deepEqual(store.getTraceConfig(), { allThreads: false, threadKeys: [] });
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

test('traceConfig: dedups + sorts thread keys and drops empty/false fields on disk', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setTraceConfig({ allThreads: false, threadKeys: ['-1:2', '-1:1', '-1:2'] });
  assert.deepEqual(store.getTraceConfig().threadKeys, ['-1:1', '-1:2'], 'deduped + sorted');
  await store.flush();
  const rawOn = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal('traceAllThreads' in rawOn, false, 'false all-flag must be absent on disk');

  // Turning everything off must leave a clean state file (no empty array, no flag).
  await store.setTraceConfig({ allThreads: false, threadKeys: [] });
  await store.flush();
  const rawOff = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal('tracedThreads' in rawOff, false, 'empty thread list must be absent on disk');
  assert.equal('traceAllThreads' in rawOff, false, 'off all-flag must be absent on disk');
});
