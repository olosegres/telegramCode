/**
 * @description Unit tests for {@link ../installManager.checkIsOpenCodeServerStale}
 * — the load-bearing guard that decides whether an already-running OpenCode
 * server should be RESTARTED onto the current binary (vs adopted as-is).
 *
 * The whole point of the guard is to restart ONLY on a confirmed version
 * mismatch: an unknown running OR installed version (a transient health/probe
 * failure) must NOT churn a working server. These tests pin that contract so a
 * future refactor can't silently turn "unknown" into "restart".
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkIsOpenCodeServerStale, extractOpenCodeVersion } from '../installManager';

test('stale: both versions known and DIFFERENT → restart', () => {
  assert.equal(checkIsOpenCodeServerStale('1.17.4', '1.17.11'), true);
});

test('not stale: both versions known and EQUAL → adopt', () => {
  assert.equal(checkIsOpenCodeServerStale('1.17.11', '1.17.11'), false);
});

test('not stale: running version unknown (probe failed) → adopt, never churn', () => {
  assert.equal(checkIsOpenCodeServerStale(null, '1.17.11'), false);
});

test('not stale: installed version unknown (`opencode --version` failed) → adopt', () => {
  assert.equal(checkIsOpenCodeServerStale('1.17.4', null), false);
});

test('not stale: both unknown → adopt', () => {
  assert.equal(checkIsOpenCodeServerStale(null, null), false);
});

test('stale: pre-release / build-suffixed versions compared verbatim', () => {
  assert.equal(checkIsOpenCodeServerStale('1.17.11-beta.1', '1.17.11'), true);
  assert.equal(checkIsOpenCodeServerStale('1.17.11-beta.1', '1.17.11-beta.1'), false);
});

test('extract: bare semver passes through', () => {
  assert.equal(extractOpenCodeVersion('1.17.11'), '1.17.11');
});

test('extract: leading `v` dropped (health may report v-prefixed), suffix kept', () => {
  assert.equal(extractOpenCodeVersion('v1.17.11'), '1.17.11');
  assert.equal(extractOpenCodeVersion('1.17.11-beta.1'), '1.17.11-beta.1');
});

test('extract: no semver / empty / null → null', () => {
  assert.equal(extractOpenCodeVersion(null), null);
  assert.equal(extractOpenCodeVersion(undefined), null);
  assert.equal(extractOpenCodeVersion(''), null);
  assert.equal(extractOpenCodeVersion('no version here'), null);
});

test('parity: both sources normalized through extract → `v1.17.11` vs `1.17.11` is NOT stale', () => {
  // The W3 guard: a future v-prefixed /global/health version must not churn the server.
  assert.equal(
    checkIsOpenCodeServerStale(extractOpenCodeVersion('v1.17.11'), extractOpenCodeVersion('1.17.11')),
    false,
  );
});
