/**
 * @description Shared scheduler types. Lives in its own file because the spec
 * union and the persisted record are consumed by `recurrence.ts` (S1),
 * `store.ts` (S2) and the engine/delivery layers (later scopes).
 */

/**
 * @name ScheduleSpec
 * @description When a scheduled job fires.
 *
 * - `cron`: a 5-field host-local cron expression. May carry `remainingRuns`
 *   to make it an N-times job — the engine decrements it after each fire and
 *   deletes the record when it reaches zero.
 * - `once`: a single absolute instant (ISO 8601 string). Fires once, then the
 *   record is deleted.
 *
 * `remainingRuns` deliberately rides ONLY the `cron` kind: a `once` job is by
 * definition a single run, so an N-times one-shot is meaningless.
 */
export type ScheduleSpec =
  | { kind: 'cron'; cronExpr: string; remainingRuns?: number }
  | { kind: 'once'; onceAtIso: string };

/** Who created a schedule — a human via `/schedule`, or the agent via an MCP tool. */
export type ScheduleCreatedBy = 'user' | 'agent';

/**
 * Outcome of the most recent fire, persisted for `/schedule list` display.
 *  - `delivered`      — prompt reached the agent.
 *  - `skipped-overlap`— the previous fire was still in its delivery pipeline.
 *  - `failed`         — delivery threw and could not be completed.
 */
export type ScheduleLastRunStatus = 'delivered' | 'skipped-overlap' | 'failed';

/** Why a job is paused. Only reason in v1 is an unbound topic (see plan S8). */
export type SchedulePauseReason = 'unbound';

/**
 * @name ScheduleRecord
 * @description One persisted scheduled job. Shape locked in plan S2.
 *
 * `nextRunAt` is the crash-critical field: the engine arms a timer to it and
 * `state.flush()`es after every fire so a restart never re-fires or loses a run.
 * `lastAdapterName` snapshots the adapter to start after a rebind when the
 * thread has no live session.
 */
export interface ScheduleRecord {
  /** `slugify(name)` + '-' + short random suffix. Unique within the store. */
  id: string;
  /** Owning thread, serialised `"<chatId>:<threadId>"`. */
  threadKey: string;
  /** Human-facing job name (free text supplied by user/agent). */
  name: string;
  spec: ScheduleSpec;
  /** The prompt forwarded to the agent at fire time. */
  prompt: string;
  createdBy: ScheduleCreatedBy;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp of the last mutation. */
  updatedAt: string;
  /** Epoch ms of the next scheduled occurrence, or `null` when exhausted. */
  nextRunAt: number | null;
  /** Epoch ms of the last fire, absent until the first one. */
  lastRunAt?: number;
  lastRunStatus?: ScheduleLastRunStatus;
  /** True while paused (e.g. topic unbound); the engine disarms paused jobs. */
  isPaused?: boolean;
  pauseReason?: SchedulePauseReason;
  /**
   * Pin the fire announcement WITHOUT notifying group members. Default
   * (absent/false) notifies everyone — user decision 2026-06-06; the agent
   * sets this from the user's phrasing via `schedule_create.isPinSilent`.
   */
  isPinSilent?: boolean;
  /** Adapter name to start when delivering with no live session after a rebind. */
  lastAdapterName?: string;
}

/**
 * @name FireContext
 * @description Passed by the engine to the `deliver` callback so the
 * announcement can annotate a missed run.
 *
 *  - `on-time` — fired at (or within tolerance of) its scheduled instant.
 *  - `catch-up` — replayed once at boot for a run missed while the bot was
 *    down; `missedAtMs` carries the original due instant so the announcement
 *    can render the "missed at HH:MM" note.
 */
export interface FireContext {
  kind: 'on-time' | 'catch-up';
  /** Original due instant (epoch ms) for a catch-up fire. */
  missedAtMs?: number;
}

/**
 * @name DeliveryOutcome
 * @description Result of one delivery attempt, returned by the `deliver`
 * callback (the real implementation lands in `delivery.ts`, S4). The engine
 * maps `status` onto the record's `lastRunStatus` and the ledger end record.
 * `error` carries a readable failure message when `status === 'failed'`.
 */
export interface DeliveryOutcome {
  status: 'delivered' | 'failed';
  error?: string;
}
