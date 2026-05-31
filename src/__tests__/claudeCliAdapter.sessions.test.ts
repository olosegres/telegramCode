import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listClaudeSessionsForWorkDir } from '../adapters/claudeCliAdapter';

// `listClaudeSessionsForWorkDir(projectsRoot, workDir)` reads the real
// `<projectsRoot>/<slug>/*.jsonl` Claude transcripts, keeps only those whose
// recorded cwd === workDir, and normalizes each into an `AgentSession`. We
// drive it against temp fixtures shaped like REAL Claude transcripts so the
// parser, slug resolution, cwd filter, UUID gate, summary-by-leafUuid title
// selection, and fallback precedence are all exercised end-to-end.
//
// Real schema (confirmed against ~/.claude/projects/*.jsonl):
//   user      → { type:'user', cwd, timestamp, uuid, message:{ role, content } }
//   summary   → { type:'summary', summary, leafUuid }
// A file can hold MANY summary entries; the one describing THIS conversation
// is the summary whose leafUuid points at a message uuid present in the file.

const validUuidA = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const validUuidB = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const validUuidC = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const validUuidD = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';

/** Claude's slug = absolute path with every non-alphanumeric char → '-'. */
function getSlug(workDir: string): string {
  return workDir.replace(/[^a-zA-Z0-9]/g, '-');
}

function writeTranscript(dir: string, fileStem: string, entries: object[]): void {
  const body = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, `${fileStem}.jsonl`), body);
}

/** A real-shaped user message line with a message uuid the summary can link to. */
function userLine(cwd: string, timestamp: string, uuid: string, content: string): object {
  return { type: 'user', cwd, timestamp, uuid, message: { role: 'user', content } };
}

describe('listClaudeSessionsForWorkDir', () => {
  let projectsRoot: string;
  const workDir = '/home/user/projects/myProject';
  const otherDir = '/home/user/projects/otherProject';
  let slugDir: string;

  before(() => {
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-test-'));
    slugDir = path.join(projectsRoot, getSlug(workDir));
    fs.mkdirSync(slugDir, { recursive: true });

    // A: has a matching summary (leafUuid → a real message uuid in the file) AND
    //    a stale summary whose leafUuid is NOT in the file. Title must be the
    //    matching one, proving leafUuid selection, not "last summary wins".
    writeTranscript(slugDir, validUuidA, [
      { type: 'summary', summary: 'STALE other-conversation summary', leafUuid: 'not-in-this-file' },
      userLine(workDir, '2026-05-30T10:00:00.000Z', 'msg-a-1', 'first user line A'),
      userLine(workDir, '2026-05-30T10:05:00.000Z', 'msg-a-2', 'last user line A'),
      { type: 'summary', summary: 'Refactor the parser', leafUuid: 'msg-a-2' },
    ]);

    // B: no summary, two user prompts → title falls back to the LAST prompt,
    //    proving lastPrompt (not firstUser) wins the fallback.
    writeTranscript(slugDir, validUuidB, [
      userLine(workDir, '2026-05-30T11:00:00.000Z', 'msg-b-1', 'first prompt B'),
      userLine(workDir, '2026-05-30T11:05:00.000Z', 'msg-b-2', 'second prompt B'),
    ]);

    // C: a single user message → firstUser === lastPrompt, so title is that line.
    writeTranscript(slugDir, validUuidC, [
      userLine(workDir, '2026-05-30T12:00:00.000Z', 'msg-c-1', 'just chatting C'),
    ]);

    // D: recorded cwd points at ANOTHER folder → must be filtered OUT.
    writeTranscript(slugDir, validUuidD, [
      userLine(otherDir, '2026-05-30T13:00:00.000Z', 'msg-d-1', 'wrong folder D'),
      { type: 'summary', summary: 'Should not appear', leafUuid: 'msg-d-1' },
    ]);

    // Non-UUID filename → must be skipped even though cwd matches.
    writeTranscript(slugDir, 'not-a-uuid', [
      userLine(workDir, '2026-05-30T14:00:00.000Z', 'msg-x-1', 'bad id'),
    ]);
  });

  after(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it('returns [] when the project folder does not exist', () => {
    const result = listClaudeSessionsForWorkDir(projectsRoot, '/no/such/folder/anywhere');
    assert.deepEqual(result, []);
  });

  it('keeps only transcripts whose recorded cwd matches workDir', () => {
    const result = listClaudeSessionsForWorkDir(projectsRoot, workDir);
    const ids = result.map(session => session.id).sort();
    // D (other folder) and the non-UUID file are excluded; A, B, C remain.
    assert.deepEqual(ids, [validUuidA, validUuidB, validUuidC]);
  });

  it('rejects a non-UUID filename even when its cwd matches', () => {
    const result = listClaudeSessionsForWorkDir(projectsRoot, workDir);
    assert.equal(result.some(session => session.id === 'not-a-uuid'), false);
  });

  it('picks the summary whose leafUuid matches a message in the same file', () => {
    const result = listClaudeSessionsForWorkDir(projectsRoot, workDir);
    const byId = new Map(result.map(session => [session.id, session]));
    // The stale summary (leafUuid not in file) must NOT win.
    assert.equal(byId.get(validUuidA)?.title, 'Refactor the parser');
  });

  it('falls back to lastPrompt then firstUser when no summary matches', () => {
    const result = listClaudeSessionsForWorkDir(projectsRoot, workDir);
    const byId = new Map(result.map(session => [session.id, session]));
    assert.equal(byId.get(validUuidB)?.title, 'second prompt B'); // last user prompt
    assert.equal(byId.get(validUuidC)?.title, 'just chatting C');  // single user line
  });

  it('sets createdAt from the first transcript timestamp', () => {
    const result = listClaudeSessionsForWorkDir(projectsRoot, workDir);
    const sessionA = result.find(session => session.id === validUuidA);
    assert.ok(sessionA);
    assert.equal(sessionA.createdAt.toISOString(), '2026-05-30T10:00:00.000Z');
  });

  it('orders results newest-first by file mtime', () => {
    // Stamp deterministic, increasing mtimes: C oldest → A newest.
    const baseMs = Date.parse('2026-05-30T00:00:00.000Z');
    const minute = 60_000;
    const stampMtime = (fileStem: string, minutesFromBase: number): void => {
      const when = new Date(baseMs + minutesFromBase * minute);
      fs.utimesSync(path.join(slugDir, `${fileStem}.jsonl`), when, when);
    };
    stampMtime(validUuidC, 1);
    stampMtime(validUuidB, 2);
    stampMtime(validUuidA, 3);

    const result = listClaudeSessionsForWorkDir(projectsRoot, workDir);
    assert.deepEqual(result.map(session => session.id), [validUuidA, validUuidB, validUuidC]);
  });
});
