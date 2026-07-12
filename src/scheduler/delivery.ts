import { t } from '../i18n';
import { describeSchedule } from './recurrence';
import type { DeliveryOutcome, FireContext, ScheduleRecord } from './types';

/**
 * @description Scheduler delivery (plan S4): the real `deliver(job, fireContext)`
 * callback the engine (S3) invokes at fire time. The flow is locked by the plan:
 *
 *   1. announce — post a visible message into the topic (job name + human
 *      schedule text + the prompt; a "missed at HH:MM" note for a catch-up run).
 *   2. pin      — pin that announcement (silent ONLY when the job opted in;
 *      default notifies all members). A pin failure degrades to a `console.warn`
 *      and the flow continues — the announcement is already visible.
 *   3. ensure session — if the thread's agent is active but BUSY, poll its busy
 *      probe every {@link busyPollIntervalMs} up to {@link waitIdleTimeoutMs}
 *      (do NOT interrupt live work), then forward (forwarding interrupts only as
 *      the timeout fallback — existing `forwardPromptToAgent` semantics). If no
 *      session, start one (with the job's `lastAdapterName` snapshot as the
 *      adapter fallback — a topic that never picked an agent and carries no
 *      snapshot fails with `no agent selected`). An unbound topic → outcome
 *      `failed` with a distinct error string the engine records (S8 turns that
 *      into a pause).
 *   4. forward — hand the prefixed prompt to the agent.
 *
 * It owns NO bot.ts import: every side effect is injected via
 * {@link ScheduleDeliveryDeps} (announce / pin / busy probe / ensure-session /
 * forward / clock / sleep), so bot.ts wires its existing functions in with thin
 * lambdas (S8) and the wait-loop is unit-testable on a fake clock.
 */

/** Poll cadence for the wait-for-idle loop: re-check the busy probe every 5s. */
export const busyPollIntervalMs = 5000;

/**
 * Upper bound on waiting for a busy session to go idle before forwarding anyway
 * (10 min, per plan IDEAL "after waitIdleTimeoutMs deliver anyway"). The forward
 * then takes the normal interrupt path (`forwardPromptToAgent` interrupts a
 * still-running turn), so a wedged turn never blocks a scheduled run forever.
 */
export const waitIdleTimeoutMs = 10 * 60 * 1000;

/** Distinct error string the engine records when a fire hits an unbound topic. */
export const unboundDeliveryError = 'thread is unbound';

/**
 * @name EnsureSessionResult
 * @description What {@link ScheduleDeliveryDeps.ensureSession} reports back. It
 * mirrors bot.ts's `ensureAgentSession` outcome without importing it: `ok` means
 * a session is ready (active, mid-startup, or just started — a prompt forwarded
 * now is delivered or buffered-then-replayed); `unbound`/`no-adapter`/
 * `start-failed` are the three failure reasons (`no-adapter` = bound topic that
 * never picked an agent and the job carried no `lastAdapterName`).
 */
export type EnsureSessionResult =
  | { ok: true }
  | { ok: false; reason: 'unbound' | 'no-adapter' | 'start-failed' };

/**
 * @name ScheduleDeliveryDeps
 * @description Everything the delivery callback needs from bot.ts, injected so
 * the module stays free of bot.ts imports and the poll loop is testable.
 * `threadKey` is the serialized `"<chatId>:<threadId>"` string carried on the
 * record; the bot's lambdas parse it back into a `ThreadKey` where needed.
 */
export interface ScheduleDeliveryDeps {
  /**
   * Post the announcement into the topic (the bot bakes in priority
   * `'interactive'`). Resolves with the sent message id, or `null` when the
   * send failed — pinning is skipped on `null`.
   */
  announce: (threadKey: string, text: string) => Promise<number | null>;
  /** Pin the announcement. `isSilent` ⇒ `disable_notification`. Rejects on failure. */
  pin: (threadKey: string, messageId: number, isSilent: boolean) => Promise<void>;
  /** Whether the thread's agent is mid-turn right now (sync, in-memory probe). */
  checkBusy: (threadKey: string) => boolean;
  /** Ensure a session is ready, starting one with `fallbackAdapterName` if needed. */
  ensureSession: (threadKey: string, fallbackAdapterName?: string) => Promise<EnsureSessionResult>;
  /** Forward the (already-prefixed) prompt to the thread's agent. */
  forwardPrompt: (threadKey: string, text: string) => Promise<void>;
  /** Current epoch ms — injected so the wait loop runs on a fake clock in tests. */
  now: () => number;
  /** Sleep `ms` — injected so the wait loop's pauses are driven by a fake timer in tests. */
  sleep: (ms: number) => Promise<void>;
}

/**
 * @description Prefix a scheduled job's prompt with a single English line that
 * tells the agent THIS turn is a scheduled run — `[Scheduled run "<name>"]`.
 * Pure, English-stable (same convention as the `[Telegram thread context]`
 * preamble): the agent may have no memory of the schedule being created (a
 * different session, or created by the human, not the agent), so the visible
 * topic announcement alone is not enough — the forwarded prompt itself must
 * carry the marker so the agent acts on it as a scheduled task, not a stray
 * message. Kept to one line so it never overwhelms a short prompt.
 */
export function prependScheduledRunMarker(jobName: string, prompt: string): string {
  return `[Scheduled run "${jobName}"]\n${prompt}`;
}

/**
 * @description Build the visible fire-announcement text via i18n. `{missedNote}`
 * is the catch-up annotation (host-local HH:MM of the missed instant) for a
 * `catch-up` fire, or empty for an `on-time` run.
 */
export function buildFireAnnouncement(job: ScheduleRecord, fireContext: FireContext): string {
  const missedNote =
    fireContext.kind === 'catch-up' && fireContext.missedAtMs !== undefined
      ? t('schedule.missedNote', { time: formatLocalTime(fireContext.missedAtMs) })
      : '';
  return t('schedule.fired', {
    name: job.name,
    schedule: describeSchedule(job.spec),
    prompt: job.prompt,
    missedNote,
  });
}

/** Host-local `HH:MM` of an epoch-ms instant, for the catch-up "missed at" note. */
function formatLocalTime(epochMs: number): string {
  const at = new Date(epochMs);
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * @description Wait for a busy session to go idle, polling the busy probe every
 * {@link busyPollIntervalMs} until it reports idle or {@link waitIdleTimeoutMs}
 * elapses (whichever comes first). Returns when it is time to forward — the
 * caller forwards regardless (a timeout falls through to the normal interrupt
 * path). Driven by the injected `now`/`sleep` so a test can advance a fake clock
 * and assert the exact number of polls.
 */
async function waitForIdle(deps: ScheduleDeliveryDeps, threadKey: string): Promise<void> {
  const deadline = deps.now() + waitIdleTimeoutMs;
  while (deps.checkBusy(threadKey)) {
    if (deps.now() >= deadline) return;
    await deps.sleep(busyPollIntervalMs);
  }
}

/**
 * @description Build the engine's `deliver(job, fireContext)` callback bound to
 * the injected deps. See the module header for the locked flow.
 */
export function createScheduleDelivery(
  deps: ScheduleDeliveryDeps,
): (job: ScheduleRecord, fireContext: FireContext) => Promise<DeliveryOutcome> {
  return async (job, fireContext) => {
    const { threadKey } = job;

    // 1. announce
    const announcement = buildFireAnnouncement(job, fireContext);
    const messageId = await deps.announce(threadKey, announcement);

    // 2. pin (degrade to log-only on failure — the announcement is already up)
    if (messageId !== null) {
      try {
        await deps.pin(threadKey, messageId, job.isPinSilent === true);
      } catch (error) {
        console.warn(
          `[scheduler] pin announcement for job ${job.id} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    // 3. ensure a session and (if busy) wait for idle
    const session = await deps.ensureSession(threadKey, job.lastAdapterName);
    if (!session.ok) {
      // Unbound → distinct error the engine records; S8 pauses the job on it.
      // no-adapter → the topic never picked an agent; start-failed → a start
      // that threw. Both surface their own readable ledger reason.
      const error =
        session.reason === 'unbound'
          ? unboundDeliveryError
          : session.reason === 'no-adapter'
            ? 'no agent selected for this topic'
            : 'failed to start agent session';
      return { status: 'failed', error };
    }

    if (deps.checkBusy(threadKey)) {
      await waitForIdle(deps, threadKey);
    }

    // 4. forward the prefixed prompt (forward interrupts only as the fallback)
    try {
      await deps.forwardPrompt(threadKey, prependScheduledRunMarker(job.name, job.prompt));
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }

    return { status: 'delivered' };
  };
}
