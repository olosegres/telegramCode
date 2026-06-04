import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkIsEventForSession,
  getEventOwnerKey,
  updateSessionLineage,
  type BoundSessionRef,
} from '../openCodeSessionRouting';

// `checkIsEventForSession(eventSessionId, ownedSessionId, childToParent)` is
// the pure predicate behind OpenCode SSE routing: an event belongs to a topic
// if it targets the bound session directly OR a subagent (child) session whose
// lineage walks up to it. Each branch below proves a distinct rule so a
// regression fails loudly.

const ownedParent = 'ses_parent';

test('an event for the bound session itself matches', () => {
  assert.equal(checkIsEventForSession(ownedParent, ownedParent, new Map()), true);
});

test('a direct child (subagent) session matches its parent', () => {
  const lineage = new Map([['ses_child', ownedParent]]);
  assert.equal(checkIsEventForSession('ses_child', ownedParent, lineage), true);
});

test('a grandchild matches up the chain', () => {
  const lineage = new Map([
    ['ses_grandchild', 'ses_child'],
    ['ses_child', ownedParent],
  ]);
  assert.equal(checkIsEventForSession('ses_grandchild', ownedParent, lineage), true);
});

test('an unrelated session with no lineage does not match', () => {
  assert.equal(checkIsEventForSession('ses_other', ownedParent, new Map()), false);
});

test('a child of a different parent does not match', () => {
  const lineage = new Map([['ses_child', 'ses_otherParent']]);
  assert.equal(checkIsEventForSession('ses_child', ownedParent, lineage), false);
});

test('cyclic lineage terminates and does not match when no owner is reachable', () => {
  const lineage = new Map([
    ['ses_a', 'ses_b'],
    ['ses_b', 'ses_a'],
  ]);
  assert.equal(checkIsEventForSession('ses_a', ownedParent, lineage), false);
});

test('cyclic lineage still matches when the owner is reachable first', () => {
  const lineage = new Map([
    ['ses_child', ownedParent],
    [ownedParent, 'ses_child'],
  ]);
  assert.equal(checkIsEventForSession('ses_child', ownedParent, lineage), true);
});

// `updateSessionLineage` records child→parent links learned from
// `session.updated`, keeping the map bounded and rejecting ids that aren't
// real sessions. Each case locks in one rule.

const maxLineageEntries = 3;

test('records a new child→parent link and reports it as changed', () => {
  const lineage = new Map<string, string>();
  assert.equal(updateSessionLineage(lineage, 'ses_child', 'ses_parent', maxLineageEntries), true);
  assert.equal(lineage.get('ses_child'), 'ses_parent');
});

test('ignores a root session with no parent', () => {
  const lineage = new Map<string, string>();
  assert.equal(updateSessionLineage(lineage, 'ses_child', undefined, maxLineageEntries), false);
  assert.equal(lineage.size, 0);
});

test('ignores ids without the ses_ prefix (e.g. a msg_ id)', () => {
  const lineage = new Map<string, string>();
  assert.equal(updateSessionLineage(lineage, 'msg_child', 'ses_parent', maxLineageEntries), false);
  assert.equal(updateSessionLineage(lineage, 'ses_child', 'msg_parent', maxLineageEntries), false);
  assert.equal(lineage.size, 0);
});

test('reports an unchanged duplicate link as not changed', () => {
  const lineage = new Map([['ses_child', 'ses_parent']]);
  assert.equal(updateSessionLineage(lineage, 'ses_child', 'ses_parent', maxLineageEntries), false);
  assert.equal(lineage.size, 1);
});

test('evicts the oldest entry once the cap is exceeded', () => {
  const lineage = new Map<string, string>();
  updateSessionLineage(lineage, 'ses_1', 'ses_p', maxLineageEntries);
  updateSessionLineage(lineage, 'ses_2', 'ses_p', maxLineageEntries);
  updateSessionLineage(lineage, 'ses_3', 'ses_p', maxLineageEntries);
  updateSessionLineage(lineage, 'ses_4', 'ses_p', maxLineageEntries);
  assert.equal(lineage.size, maxLineageEntries);
  assert.equal(lineage.has('ses_1'), false);
  assert.equal(lineage.has('ses_4'), true);
});

test('rejects a self-link (child === parent) — would corrupt lineage walks', () => {
  const lineage = new Map<string, string>();
  assert.equal(updateSessionLineage(lineage, 'ses_self', 'ses_self', maxLineageEntries), false);
  assert.equal(lineage.size, 0);
});

// `getEventOwnerKey` enforces SINGLE-OWNER delivery (B20): the OpenCode server
// multiplexes every session's events onto each thread's stream, so the same
// event is offered to every bound thread. Exactly one (or zero) must own it —
// the regression was the SAME answer landing in two topics at once.

const sessionA = 'ses_topicA';
const sessionB = 'ses_topicB';

test('B20: a false lineage link making one bound session a child of another routes to ONE owner, not both', () => {
  // Two threads bound to DIFFERENT real (parentless) sessions. A bogus lineage
  // link chains topicA's session under topicB's. The old per-thread predicate
  // would then match topicA's own events for BOTH topicA (direct) and topicB
  // (via the false link) — the dup. Single-owner must pick topicA only.
  const boundSessions: BoundSessionRef[] = [
    { keyStr: 'chat:A', sessionId: sessionA },
    { keyStr: 'chat:B', sessionId: sessionB },
  ];
  const falseLineage = new Map([[sessionA, sessionB]]);

  // checkIsEventForSession (the pre-B20 predicate) matches BOTH — the bug.
  assert.equal(checkIsEventForSession(sessionA, sessionA, falseLineage), true);
  assert.equal(checkIsEventForSession(sessionA, sessionB, falseLineage), true);

  // getEventOwnerKey resolves a SINGLE owner: the direct id match wins.
  assert.equal(getEventOwnerKey(sessionA, boundSessions, falseLineage), 'chat:A');
});

test('B20: a duplicated session id (two threads bound to the same session) still resolves to one owner', () => {
  // The corruption case: topicB accidentally adopted topicA's session id. Both
  // claim it. Single-owner picks exactly one (first in order), never both.
  const boundSessions: BoundSessionRef[] = [
    { keyStr: 'chat:A', sessionId: sessionA },
    { keyStr: 'chat:B', sessionId: sessionA },
  ];
  const owner = getEventOwnerKey(sessionA, boundSessions, new Map());
  assert.equal(owner, 'chat:A');
  assert.notEqual(owner, null);
});

test('legit subagent child event routes to its parent thread (and only it)', () => {
  const boundSessions: BoundSessionRef[] = [
    { keyStr: 'chat:A', sessionId: sessionA },
    { keyStr: 'chat:B', sessionId: sessionB },
  ];
  const lineage = new Map([['ses_child', sessionB]]);
  assert.equal(getEventOwnerKey('ses_child', boundSessions, lineage), 'chat:B');
});

test('a child routes to its NEAREST bound ancestor, not a higher one', () => {
  // grandchild -> child(bound to A) -> parent(bound to B). Nearest wins: A.
  const boundSessions: BoundSessionRef[] = [
    { keyStr: 'chat:A', sessionId: 'ses_mid' },
    { keyStr: 'chat:B', sessionId: 'ses_top' },
  ];
  const lineage = new Map([
    ['ses_grandchild', 'ses_mid'],
    ['ses_mid', 'ses_top'],
  ]);
  assert.equal(getEventOwnerKey('ses_grandchild', boundSessions, lineage), 'chat:A');
});

test('an event no bound thread owns resolves to null (genuine drop)', () => {
  const boundSessions: BoundSessionRef[] = [{ keyStr: 'chat:A', sessionId: sessionA }];
  assert.equal(getEventOwnerKey('ses_orphan', boundSessions, new Map()), null);
});

test('a direct id match beats lineage descent even if a bound ancestor exists', () => {
  // sessionA is bound to chat:A AND chained (falsely) under sessionB(chat:B).
  // The direct owner (chat:A) must win — a bound session is never a mere
  // descendant of another bound session.
  const boundSessions: BoundSessionRef[] = [
    { keyStr: 'chat:A', sessionId: sessionA },
    { keyStr: 'chat:B', sessionId: sessionB },
  ];
  const lineage = new Map([[sessionA, sessionB]]);
  assert.equal(getEventOwnerKey(sessionA, boundSessions, lineage), 'chat:A');
});

test('cyclic lineage with no bound owner terminates and returns null', () => {
  const boundSessions: BoundSessionRef[] = [{ keyStr: 'chat:A', sessionId: sessionA }];
  const cyclic = new Map([
    ['ses_x', 'ses_y'],
    ['ses_y', 'ses_x'],
  ]);
  assert.equal(getEventOwnerKey('ses_x', boundSessions, cyclic), null);
});
