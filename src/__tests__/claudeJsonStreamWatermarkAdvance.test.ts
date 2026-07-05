/**
 * @description S7 — the claude-json-stream adapter advances the persisted
 * seen-watermark as each PARENT assistant message settles (in `onStdout`), not
 * only at turn end. The claude process is EXTERNAL (tmux-hosted) and normally
 * survives bot restarts, but when the process itself dies mid-turn the
 * dead-process `--resume` fallback recaps from this watermark: without the
 * per-message advance the aborted turn's already-relayed assistant messages
 * would re-count as a false "⚠️ missed N" on reattach (it shares the tmux
 * backend's recap reader, so the identical 2026-07-04 bug). A CHILD (sub-agent)
 * message (`parent_tool_use_id` set) must NEVER advance the watermark.
 *
 * The advance reads the REAL on-disk transcript size (`fs.statSync`), so the test
 * points Claude's projects root at a temp `$HOME` and drives the adapter's
 * private `onStdout` with real stream-json lines. Private members are reached via
 * runtime bracket access (tests are type-stripped by tsx).
 *
 * Test case: N/A — telegramCode has no Jira tracker. TODO: add a test-case key
 * if one is ever created.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ClaudeJsonStreamAdapter } from '../adapters/claudeJsonStreamAdapter';
import {
  getClaudeProjectSlug,
  readClaudeReattachTranscript,
} from '../adapters/claudeCliAdapter';
import { ClaudeStreamLineReader } from '../utils/claudeStreamJson';
import { keyToString, type SeenWatermark, type ThreadKey } from '../types';

const workDir = '/tmp/jsonstream-work';
const sessionId = 'sess-json-wm';
const key: ThreadKey = { chatId: -100999333, threadId: 42 };

function serialize(entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** A settled assistant message stream-json line (parent turn). */
const parentAssistantLine =
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } }) + '\n';
/** A settled CHILD (sub-agent) assistant line — `parent_tool_use_id` set. */
const childAssistantLine =
  JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { role: 'assistant', content: [{ type: 'text', text: 'child' }] } }) + '\n';

describe('claude-json-stream seen-watermark advance on relay (S7)', () => {
  let home: string;
  let transcriptPath: string;
  let originalHome: string | undefined;

  before(() => {
    originalHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'json-stream-wm-'));
    process.env.HOME = home;
    const slugDir = path.join(home, '.claude', 'projects', getClaudeProjectSlug(workDir));
    fs.mkdirSync(slugDir, { recursive: true });
    transcriptPath = path.join(slugDir, `${sessionId}.jsonl`);
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function createAdapterWithSession(): { adapter: ClaudeJsonStreamAdapter; writes: SeenWatermark[] } {
    const adapter = new ClaudeJsonStreamAdapter();
    const session = {
      key,
      workDir,
      sessionId,
      reader: new ClaudeStreamLineReader(),
      lastWatermarkOffset: -1,
    };
    adapter['sessions'].set(keyToString(key), session);
    const writes: SeenWatermark[] = [];
    adapter.setSeenWatermarkWriter((_key, watermark) => writes.push(watermark));
    return { adapter, writes };
  }

  it('advances to the transcript EOF on a settled PARENT assistant message', () => {
    const { adapter, writes } = createAdapterWithSession();
    const contents =
      serialize([{ type: 'user', message: { role: 'user', content: 'ask' } }]) +
      serialize([{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } }]);
    fs.writeFileSync(transcriptPath, contents);
    const eof = Buffer.byteLength(contents, 'utf-8');

    adapter['onStdout'](adapter['sessions'].get(keyToString(key)), parentAssistantLine);

    assert.deepEqual(writes, [{ sessionId, claudeTranscriptOffset: eof }]);

    // The advanced offset is what makes a mid-turn restart with everything
    // relayed report `missedCount` 0 (the whole point of S7).
    const { missedCount } = readClaudeReattachTranscript(transcriptPath, eof, 3);
    assert.equal(missedCount, 0, 'watermark at EOF → nothing missed on reattach');
  });

  it('does NOT advance on a CHILD (sub-agent) message', () => {
    const { adapter, writes } = createAdapterWithSession();
    fs.writeFileSync(transcriptPath, serialize([{ type: 'user', message: { role: 'user', content: 'ask' } }]));

    adapter['onStdout'](adapter['sessions'].get(keyToString(key)), childAssistantLine);

    assert.deepEqual(writes, [], 'a child message must never advance the watermark');
    assert.equal(adapter['sessions'].get(keyToString(key)).lastWatermarkOffset, -1);
  });

  it('is monotonic — a second settled message without file growth does not re-write', () => {
    const { adapter, writes } = createAdapterWithSession();
    const contents = serialize([{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } }]);
    fs.writeFileSync(transcriptPath, contents);
    const session = adapter['sessions'].get(keyToString(key));

    adapter['onStdout'](session, parentAssistantLine); // advances to EOF
    adapter['onStdout'](session, parentAssistantLine); // no growth → no write

    assert.equal(writes.length, 1, 'only real growth writes');

    // Grow the file, drive again → a new advance.
    fs.appendFileSync(transcriptPath, serialize([{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] } }]));
    adapter['onStdout'](session, parentAssistantLine);
    assert.equal(writes.length, 2);
    assert.equal(writes[1].claudeTranscriptOffset, Buffer.byteLength(fs.readFileSync(transcriptPath)));
  });
});
