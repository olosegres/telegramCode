/**
 * @description The per-topic `/status` report must describe the thread it is
 * asked about — including WHICH model the live session actually runs.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`):
 * - a stopped session renders no session-only rows (model / effort / started /
 *   runtime), while the bound working directory still shows;
 * - a live session renders every observed runtime row, and unavailable runtime
 *   data degrades to the localised "unknown" marker instead of blanking or
 *   throwing;
 * - the model fallback ORDER holds: live adapter value → what the runtime
 *   reports it last ran → the persisted pick → nothing. The middle step exists
 *   only for the Claude tmux backend, whose `getCurrentModel` is permanently
 *   null because the model lives inside the TUI — dropping it blanks the model
 *   row for that whole backend;
 * - every step of that chain treats an EMPTY STRING as "source knows nothing"
 *   and falls through: with `??` an empty adapter answer won over a real
 *   runtime-reported model and `/status` rendered a blank model row;
 * - General `/status` still returns its global report BEFORE any per-thread
 *   runtime read (asserted against the `bot.ts` source: that ordering has no
 *   runtime seam to drive from a unit test).
 *
 * The formatter and the model chain are imported from `utils/threadStatusReport`
 * rather than `bot.ts`: importing the bot module runs its module-scope
 * `parseEnv()`, which exits the process when `TELEGRAM_BOT_TOKEN` is unset.
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { getThreadStatusModel, getThreadStatusReport } from '../utils/threadStatusReport';
import { runWithLocale } from '../i18n';

test('inactive thread status omits live session metadata', () => {
  const report = runWithLocale('en', () => getThreadStatusReport({
    agentLine: 'OpenCode (opencode)',
    subdir: 'project',
    isActive: false,
    workDir: '/work/project',
    model: 'openai/gpt-test',
    effort: 'xhigh',
    startedAt: '2026-08-21T10:00:00Z',
    runtime: { version: '1.0.0', model: 'openai/gpt-test', contextUsedTokens: 10, contextWindowTokens: 100 },
  }));

  assert.match(report, /Session: stopped/);
  assert.match(report, /Working directory: \/work\/project/);
  assert.doesNotMatch(report, /Model:|Effort:|Started:|Runtime version:|Context:/);
});

test('active thread status renders the observed runtime details', () => {
  const report = runWithLocale('en', () => getThreadStatusReport({
    agentLine: 'OpenCode (opencode)',
    subdir: 'project',
    isActive: true,
    workDir: '/work/project',
    model: 'openai/gpt-test',
    effort: 'xhigh',
    startedAt: '2026-08-21T10:00:00Z',
    runtime: { version: '1.0.0', model: 'openai/gpt-test', contextUsedTokens: 10, contextWindowTokens: 100 },
  }));

  assert.match(report, /Session: running/);
  assert.match(report, /Model: openai\/gpt-test/);
  assert.match(report, /Effort: xhigh/);
  assert.match(report, /Started: 2026-08-21T10:00:00Z/);
  assert.match(report, /Runtime version: 1\.0\.0/);
  assert.match(report, /Context: 10 \/ 100 tokens/);
});

test('unavailable runtime and workdir details render safely', () => {
  const report = runWithLocale('en', () => getThreadStatusReport({
    agentLine: 'Claude (claude)',
    subdir: 'project',
    isActive: true,
    workDir: '(unavailable)',
    model: null,
    effort: null,
    startedAt: null,
    runtime: null,
  }));

  assert.match(report, /Working directory: \(unavailable\)/);
  assert.match(report, /Runtime version: \(unavailable\)/);
  assert.match(report, /Context: \(unavailable\) \/ \(unavailable\) tokens/);
});

test('active sessions without runtime support render unavailable runtime details', () => {
  const report = runWithLocale('en', () => getThreadStatusReport({
    agentLine: 'Terminal (terminal)',
    subdir: 'project',
    isActive: true,
    workDir: '/work/project',
    model: null,
    effort: null,
    startedAt: null,
    runtime: null,
  }));

  assert.match(report, /Runtime version: \(unavailable\)/);
  assert.match(report, /Context: \(unavailable\) \/ \(unavailable\) tokens/);
});

test('the live adapter model wins over both fallbacks', () => {
  assert.equal(
    getThreadStatusModel({
      adapterModel: 'anthropic/live-pick',
      runtimeModel: 'anthropic/last-run',
      persistedModel: 'anthropic/persisted',
    }),
    'anthropic/live-pick',
  );
});

test('the runtime report answers when the adapter cannot name the model', () => {
  // The Claude tmux backend keeps its model inside the TUI, so `getCurrentModel`
  // is permanently null there and the runtime report is its ONLY model source —
  // this case is the whole reason the chain has a middle step.
  assert.equal(
    getThreadStatusModel({
      adapterModel: null,
      runtimeModel: 'claude-opus-4-5-20251101',
      persistedModel: 'claude-persisted',
    }),
    'claude-opus-4-5-20251101',
  );
});

test('an empty adapter answer counts as "no model", not as a winning value', () => {
  // An adapter that returns '' knows no model either. Under `??` that empty
  // string beat the runtime report and `/status` rendered a blank model row.
  assert.equal(
    getThreadStatusModel({
      adapterModel: '',
      runtimeModel: 'claude-opus-4-5-20251101',
      persistedModel: 'claude-persisted',
    }),
    'claude-opus-4-5-20251101',
  );
  assert.equal(
    getThreadStatusModel({ adapterModel: '', runtimeModel: '', persistedModel: 'anthropic/persisted' }),
    'anthropic/persisted',
  );
  assert.equal(getThreadStatusModel({ adapterModel: '', runtimeModel: '', persistedModel: '' }), null);
});

test('the persisted pick answers only when neither live source knows the model', () => {
  assert.equal(
    getThreadStatusModel({ adapterModel: null, runtimeModel: null, persistedModel: 'anthropic/persisted' }),
    'anthropic/persisted',
  );
});

test('an entirely unknown model stays null instead of inventing a label', () => {
  assert.equal(getThreadStatusModel({ adapterModel: null, runtimeModel: null, persistedModel: null }), null);
});

test('General /status returns its global report before thread runtime metadata is read', () => {
  const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');
  const statusCommandStart = botSource.indexOf("command('status'");
  const statusCommandEnd = botSource.indexOf('\nfunction getLanguageCommandArg', statusCommandStart);
  const statusCommand = botSource.slice(statusCommandStart, statusCommandEnd);
  const globalReturnIndex = statusCommand.indexOf('    return;');
  const adapterLookupIndex = statusCommand.indexOf('  const adapter = getThreadAdapter(key);');
  const runtimeLookupIndex = statusCommand.indexOf('adapter.getRuntimeInfo');

  assert.ok(globalReturnIndex >= 0, 'General /status must return after its global-only report');
  assert.ok(adapterLookupIndex > globalReturnIndex, 'thread adapter access must happen only after the General return');
  assert.ok(runtimeLookupIndex > globalReturnIndex, 'General /status must not fetch runtime metadata');
});
