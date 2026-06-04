/**
 * @description B13 — the /sessions list showed "(just now)" for EVERY
 * OpenCode session regardless of real age.
 *
 * Root cause (proven live via read-only `GET /session`): the server returns
 * `time.created` / `time.updated` as epoch MILLISECONDS (13-digit values),
 * but `getSessions` multiplied them by 1000 again — every date landed
 * millennia in the future, `Date.now() - date` went negative, and the
 * relative-age formatter's `diffMin < 1` branch rendered "just now" for all.
 *
 * The fixture uses a real 13-digit timestamp shape; the load-bearing
 * assertion is that the computed age is positive and matches the expected
 * minutes — it fails if anyone reintroduces a seconds↔ms conversion in
 * either direction.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';

const minuteMs = 60_000;

describe('OpenCode getSessions time conversion (B13)', () => {
  it('treats time.created/updated as epoch milliseconds — ages come out sane', async () => {
    const adapter = new OpenCodeAdapter();
    const now = Date.now();
    const fortyMinutesAgo = now - 40 * minuteMs;
    const twoHoursAgo = now - 120 * minuteMs;

    adapter['apiRequest'] = async () => [
      { id: 'ses_old', title: 'older', time: { created: twoHoursAgo, updated: fortyMinutesAgo } },
    ];

    const sessions = await adapter['getSessions']();
    assert.equal(sessions.length, 1);

    const updatedAgeMin = (now - sessions[0].updatedAt.getTime()) / minuteMs;
    const createdAgeMin = (now - sessions[0].createdAt.getTime()) / minuteMs;
    // Positive and in the right ballpark — a re-introduced `* 1000` would make
    // these hugely negative; a `/ 1000` would make them ~astronomically large.
    assert.ok(updatedAgeMin > 39 && updatedAgeMin < 42, `updated age ${updatedAgeMin}min`);
    assert.ok(createdAgeMin > 119 && createdAgeMin < 122, `created age ${createdAgeMin}min`);
  });

  it('falls back to "now" when the server omits time fields', async () => {
    const adapter = new OpenCodeAdapter();
    adapter['apiRequest'] = async () => [{ id: 'ses_no_time', title: 'no time' }];

    const sessions = await adapter['getSessions']();
    assert.equal(sessions.length, 1);
    assert.ok(Math.abs(Date.now() - sessions[0].updatedAt.getTime()) < 5_000);
  });
});
