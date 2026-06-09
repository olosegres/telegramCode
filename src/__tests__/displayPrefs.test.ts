/**
 * @description Plan `2026-06-09-opencode-output-verbosity.md` S1 — per-thread
 * display-preference infrastructure (thinking / tool-results / sub-agent).
 *
 * Covers the getter/setter/default contract and the persistence round-trip:
 *   - an absent pref resolves to the locked DEFAULT (thinking=brief,
 *     toolResults=short, subagent=compact);
 *   - a set override is stored and resolved back;
 *   - setting a field back to its default CLEARS the override and leaves a
 *     clean `state.json` (no record, no map);
 *   - a saved record round-trips across a reload from disk (restart survival).
 *
 * Mirrors `state.test.ts`'s isolated-`dataDir` + fake-`HOME` harness so the
 * legacy-migration probe never touches the developer's real home.
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
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-prefs-'));
  dataDir = path.join(fakeHome, '.telegramCode');
  fs.mkdirSync(dataDir, { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

const key1: ThreadKey = { chatId: -1001234567890, threadId: 42 };
const key2: ThreadKey = { chatId: -1001234567890, threadId: 99 };

function readRawState(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
}

test('displayPrefs: absent record resolves to the locked defaults', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  assert.deepEqual(store.getDisplayPrefs(key1), {
    thinking: 'brief',
    toolResults: 'short',
    subagent: 'compact',
  });
});

test('displayPrefs: a set override is stored and resolved back', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setDisplayPref(key1, 'thinking', 'detailed');
  await store.setDisplayPref(key1, 'toolResults', 'full');
  await store.setDisplayPref(key1, 'subagent', 'full');
  assert.deepEqual(store.getDisplayPrefs(key1), {
    thinking: 'detailed',
    toolResults: 'full',
    subagent: 'full',
  });
});

test('displayPrefs: only the set field changes — the rest keep their defaults', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setDisplayPref(key1, 'toolResults', 'hide');
  // Load-bearing: prove ONLY toolResults moved off its default; thinking and
  // subagent must still resolve to their own (unset) defaults, not be wiped.
  assert.deepEqual(store.getDisplayPrefs(key1), {
    thinking: 'brief',
    toolResults: 'hide',
    subagent: 'compact',
  });
});

test('displayPrefs: prefs are isolated per thread', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setDisplayPref(key1, 'thinking', 'detailed');
  assert.equal(store.getDisplayPrefs(key1).thinking, 'detailed');
  assert.equal(store.getDisplayPrefs(key2).thinking, 'brief', 'a sibling thread keeps the default');
});

test('displayPrefs: a non-default override survives a reload from disk', async () => {
  // THE restart-survival case: a persisted override must re-resolve to the same
  // value after a fresh store loads state.json (the whole reason prefs live in
  // state.json and not just memory).
  const first = new StateStore(dataDir, { saveDebounceMs: 5 });
  await first.init();
  await first.setDisplayPref(key1, 'thinking', 'hide');
  await first.setDisplayPref(key1, 'toolResults', 'full');
  await first.flush();

  const second = new StateStore(dataDir, { saveDebounceMs: 5 });
  await second.init();
  assert.deepEqual(second.getDisplayPrefs(key1), {
    thinking: 'hide',
    toolResults: 'full',
    subagent: 'compact',
  });
});

test('displayPrefs: setting a field back to its default clears the override on disk', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setDisplayPref(key1, 'thinking', 'detailed');
  await store.setDisplayPref(key1, 'toolResults', 'full');
  await store.flush();

  // Pre-condition: the override is really on disk (so the clear below proves a
  // real change, not a vacuous pass on an empty record).
  let raw = readRawState();
  assert.equal(
    (raw.displayPrefs as Record<string, { thinking?: string }>)[`${key1.chatId}:${key1.threadId}`]
      ?.thinking,
    'detailed',
  );

  // Reset thinking to its default — the field must vanish, but toolResults stays.
  await store.setDisplayPref(key1, 'thinking', 'brief');
  await store.flush();
  raw = readRawState();
  const record = (raw.displayPrefs as Record<string, Record<string, unknown>>)[
    `${key1.chatId}:${key1.threadId}`
  ];
  assert.ok(record, 'record must survive while toolResults is still non-default');
  assert.equal('thinking' in record, false, 'defaulted field must be absent on disk');
  assert.equal(record.toolResults, 'full', 'the other override must remain');
  assert.equal(store.getDisplayPrefs(key1).thinking, 'brief', 'resolves back to default');
});

test('displayPrefs: resetting the last override drops the record and the map', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setDisplayPref(key1, 'subagent', 'full');
  await store.setDisplayPref(key1, 'subagent', 'compact'); // back to default
  await store.flush();
  const raw = readRawState();
  assert.equal('displayPrefs' in raw, false, 'an all-defaults state file must be clean');
  assert.deepEqual(store.getDisplayPrefs(key1), {
    thinking: 'brief',
    toolResults: 'short',
    subagent: 'compact',
  });
});

test('displayPrefs: setting the default on an absent record is a clean no-op', async () => {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  await store.setDisplayPref(key1, 'thinking', 'brief'); // default, nothing stored yet
  await store.flush();
  const raw = readRawState();
  assert.equal('displayPrefs' in raw, false, 'must not create a record just to store a default');
});
