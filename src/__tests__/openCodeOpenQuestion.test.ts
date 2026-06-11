/**
 * @description Unit-cover the pure recovery helper that turns a
 * `GET /question` response into the {@link OpenCodePendingQuestion} the bot
 * already understands. This is the testable core shared by BOTH the
 * reattach restore (S1) and the wedged-turn backstop (S2): a network slip
 * would otherwise hang an OpenCode topic on an unanswered question forever,
 * so the find-and-rebuild logic gets explicit fixtures.
 *
 * Load-bearing properties:
 *  - the reply id is the entry's TOP-LEVEL `id` (`que_…`), never `tool.callID`;
 *  - the owning `directory` (workDir) rides along so the reply targets the
 *    right project instance;
 *  - a response with no entry for this session / empty array / malformed
 *    element / non-array yields `null` ("nothing to recover"), never a throw.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getOpenQuestionForSession } from '../openCodeOpenQuestion';

const sessionId = 'ses_target_42';
const workDir = '/home/user/src/overview';

const targetEntry = {
  id: 'que_target',
  sessionID: sessionId,
  // The server also sends `tool: { messageID, callID }`; the helper must IGNORE
  // callID (`toolu_…`) and use the top-level `id` as the reply request id.
  tool: { messageID: 'msg_1', callID: 'toolu_should_be_ignored' },
  questions: [
    {
      question: 'Which database?',
      header: 'Pick one',
      options: [
        { label: 'Postgres', description: 'relational' },
        { label: 'SQLite', description: 'embedded' },
      ],
      multiple: false,
    },
  ],
};

describe('getOpenQuestionForSession', () => {
  it('rebuilds the pending question for the owning session (requestId = top-level id, directory = workDir)', () => {
    const result = getOpenQuestionForSession([targetEntry], sessionId, workDir);
    assert.ok(result, 'expected a rebuilt pending question');
    // Load-bearing: requestId is the `que_…` id, NOT the tool callID — replying
    // to the callID 404s and the agent stays blocked.
    assert.equal(result.requestId, 'que_target');
    assert.equal(result.directory, workDir);
    assert.equal(result.questions.length, 1);
    assert.equal(result.questions[0].question, 'Which database?');
    assert.equal(result.questions[0].options.length, 2);
  });

  it('picks the entry for THIS session when several questions are open', () => {
    const otherEntry = { ...targetEntry, id: 'que_other', sessionID: 'ses_other' };
    const result = getOpenQuestionForSession([otherEntry, targetEntry], sessionId, workDir);
    assert.ok(result);
    assert.equal(result.requestId, 'que_target');
  });

  it('returns null when no open question belongs to this session', () => {
    const otherEntry = { ...targetEntry, id: 'que_other', sessionID: 'ses_other' };
    assert.equal(getOpenQuestionForSession([otherEntry], sessionId, workDir), null);
  });

  it('returns null for an empty array (no open questions)', () => {
    assert.equal(getOpenQuestionForSession([], sessionId, workDir), null);
  });

  it('returns null for a non-array response (server returned an object/error)', () => {
    assert.equal(getOpenQuestionForSession({ error: 'nope' }, sessionId, workDir), null);
    assert.equal(getOpenQuestionForSession(null, sessionId, workDir), null);
    assert.equal(getOpenQuestionForSession(undefined, sessionId, workDir), null);
  });

  it('skips malformed entries (missing id / sessionID / questions) without throwing', () => {
    const malformed = [
      { sessionID: sessionId, questions: targetEntry.questions }, // no id
      { id: 'que_x', questions: targetEntry.questions }, // no sessionID
      { id: 'que_y', sessionID: sessionId }, // no questions
      { id: 'que_z', sessionID: sessionId, questions: [] }, // empty questions
      'not-an-object',
      null,
    ];
    assert.equal(getOpenQuestionForSession(malformed, sessionId, workDir), null);
  });

  it('still finds a valid entry alongside malformed ones', () => {
    const mixed = [null, 'garbage', { id: 'que_bad' }, targetEntry];
    const result = getOpenQuestionForSession(mixed, sessionId, workDir);
    assert.ok(result);
    assert.equal(result.requestId, 'que_target');
  });
});
