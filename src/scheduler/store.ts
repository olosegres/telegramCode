import { randomBytes } from 'node:crypto';
import type { StateStore } from '../state';
import { keyToString, type ThreadKey } from '../types';
import { getNextRunAt } from './recurrence';
import type { ScheduleCreatedBy, ScheduleRecord, ScheduleSpec } from './types';

/**
 * @description Scheduler store helpers — id generation and the cap-enforcing
 * create path. The persisted collection itself lives on {@link StateStore}
 * (`schedules` field + getters/setters), following the `traceConfig` pattern;
 * this module owns the bits the store shouldn't know about: how an id is
 * minted from a name, and the per-thread cap.
 */

/** Hard cap on schedules per thread. Enforced in {@link createScheduleForThread}. */
export const maxSchedulesPerThread = 30;

/** Length of the random suffix appended to a slug to keep ids unique. */
const idSuffixLength = 6;

/** Max characters kept from the slugified name before the suffix. */
const slugMaxLength = 40;

/**
 * @description Turn a free-text name into a lowercase ascii-ish slug: lowercase,
 * non-alphanumerics collapsed to single hyphens, edge hyphens trimmed, bounded
 * length. Returns `'job'` as a stable fallback when nothing usable survives
 * (e.g. a name of only emoji/punctuation) so an id is always well-formed.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, slugMaxLength)
    .replace(/-+$/, '');
  return slug || 'job';
}

/**
 * @description Mint a schedule id: `slugify(name)` + `-` + a 6-char lowercase
 * alphanumeric random suffix. The suffix makes the id collision-resistant
 * without the create-time uniqueness check the spec calls out as bad UX.
 */
export function generateScheduleId(name: string): string {
  // base36 of random bytes yields [0-9a-z]; pad+slice to a fixed-length suffix.
  const suffix = randomBytes(8).toString('hex');
  const alnum = parseInt(suffix, 16).toString(36).padStart(idSuffixLength, '0').slice(-idSuffixLength);
  return `${slugify(name)}-${alnum}`;
}

/**
 * @description Build a fresh {@link ScheduleRecord} from its inputs, computing
 * the initial `nextRunAt` for the spec. Pure (besides id randomness): callers
 * pass `nowMs` so creation time and the first `nextRunAt` are deterministic in
 * tests. Does NOT persist — the caller (or {@link createScheduleForThread})
 * writes it to the store.
 */
export function createScheduleRecord(args: {
  threadKey: ThreadKey;
  name: string;
  spec: ScheduleSpec;
  prompt: string;
  createdBy: ScheduleCreatedBy;
  nowMs: number;
  lastAdapterName?: string;
  isPinSilent?: boolean;
}): ScheduleRecord {
  const { threadKey, name, spec, prompt, createdBy, nowMs, lastAdapterName, isPinSilent } = args;
  const nowIso = new Date(nowMs).toISOString();
  const record: ScheduleRecord = {
    id: generateScheduleId(name),
    threadKey: keyToString(threadKey),
    name,
    spec,
    prompt,
    createdBy,
    createdAt: nowIso,
    updatedAt: nowIso,
    nextRunAt: getNextRunAt(spec, nowMs),
  };
  if (lastAdapterName !== undefined) record.lastAdapterName = lastAdapterName;
  if (isPinSilent) record.isPinSilent = true;
  return record;
}

/**
 * @name CreateScheduleResult
 * @description Typed outcome of {@link createScheduleForThread} — a result
 * object rather than a thrown string, so the cap rejection is handled
 * explicitly at the call site (plan S2: "typed error/result, not a throw").
 */
export type CreateScheduleResult =
  | { ok: true; record: ScheduleRecord }
  | { ok: false; reason: 'cap-reached'; limit: number };

/**
 * @description Create and persist a schedule for a thread, enforcing the
 * per-thread cap. Returns the created record, or a `cap-reached` result when
 * the thread already holds {@link maxSchedulesPerThread}. The cap is checked
 * against the store's current per-thread count, then the record is upserted.
 */
export async function createScheduleForThread(
  store: StateStore,
  args: {
    threadKey: ThreadKey;
    name: string;
    spec: ScheduleSpec;
    prompt: string;
    createdBy: ScheduleCreatedBy;
    nowMs: number;
    lastAdapterName?: string;
  },
): Promise<CreateScheduleResult> {
  const existing = store.getThreadSchedules(args.threadKey);
  if (existing.length >= maxSchedulesPerThread) {
    return { ok: false, reason: 'cap-reached', limit: maxSchedulesPerThread };
  }
  const record = createScheduleRecord(args);
  await store.upsertSchedule(record);
  return { ok: true, record };
}
