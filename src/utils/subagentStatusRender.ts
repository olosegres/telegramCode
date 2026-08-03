/**
 * @description Pure decision + formatting helpers behind the dedicated OpenCode
 * sub-agent status message (the `subagentStatus` adapter event, for the
 * `minimal`/`short` `/subagent` modes). The adapter emits a mode-AGNOSTIC
 * {@link SubagentStatusEvent}; the bot's `handleSubagentStatus` owns the
 * message lifecycle and a ticking elapsed timer, and consults
 * {@link getSubagentStatusAction} (open / refresh / close / noop) +
 * {@link buildSubagentElapsedText} here. Extracted from `bot.ts` so the
 * elapsed formatting and the lifecycle decision are unit-testable without the
 * Telegraf machinery (same pattern as `toolResultRender.ts` /
 * `subagentRender.ts`).
 *
 * Why a DEDICATED message instead of the shared transient status: the old
 * status-only sub-agent line rode `statusMessageId`, whose single-message
 * identity was lost between sparse child-text bursts, so every burst posted a
 * NEW message (flood). This module backs the fix — one explicitly-managed
 * message edited in place with a live elapsed counter.
 */
import { t } from '../i18n';

/** Seconds in one minute — for the `m:ss` split in {@link formatElapsed}. */
const secondsPerMinute = 60;

/** Milliseconds in one second — for flooring elapsed ms to whole seconds. */
const millisPerSecond = 1000;

/** Zero-pad target width for the seconds field in `m:ss` (always two digits). */
const secondsPadWidth = 2;

/**
 * @description Format an elapsed duration (ms) as `m:ss` — minutes unpadded,
 * seconds zero-padded to two digits. Floored to whole seconds (the timer ticks
 * coarsely, sub-second precision is noise). Examples: `0 → "0:00"`,
 * `7000 → "0:07"`, `60000 → "1:00"`, `843000 → "14:03"`.
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / millisPerSecond);
  const minutes = Math.floor(totalSeconds / secondsPerMinute);
  const seconds = totalSeconds % secondsPerMinute;
  return `${minutes}:${seconds.toString().padStart(secondsPadWidth, '0')}`;
}

/**
 * @description Build the dedicated sub-agent status line
 * ("🤖 sub-agent: <title> · m:ss") from the sticky title and the elapsed ms.
 * `null` title falls back to the same localized generic label the other
 * sub-agent status builders use.
 */
export function buildSubagentElapsedText(title: string | null, elapsedMs: number): string {
  return t('subagent.status_elapsed', {
    title: title ?? t('subagent.fallback_title'),
    elapsed: formatElapsed(elapsedMs),
  });
}

/**
 * @name SubagentStatusAction
 * @description The bot's next move for the dedicated sub-agent status message,
 * decided purely from whether a message currently exists and whether the
 * incoming event says a delegation is active.
 *
 * - `open`    — a delegation started and no message exists yet → create one + arm the timer.
 * - `refresh` — a delegation is in flight and a message exists → re-edit it (title/elapsed).
 * - `close`   — the delegation ended and a message exists → delete it + stop the timer.
 * - `noop`    — the delegation ended and no message exists → nothing to do (idempotent close).
 */
export type SubagentStatusAction = 'open' | 'refresh' | 'close' | 'noop';

/**
 * @description Map "(does a message exist?) × (is the event active?)" to the
 * bot's next move. Keeping it a named pure helper makes the lifecycle a truth
 * table the bot handler reads declaratively (same shape as
 * `getToolResultRenderAction`), and lets a defensive `active:false` close
 * no-op safely when nothing is open.
 */
export function getSubagentStatusAction(input: {
  hasMessage: boolean;
  eventActive: boolean;
}): SubagentStatusAction {
  if (input.eventActive) return input.hasMessage ? 'refresh' : 'open';
  return input.hasMessage ? 'close' : 'noop';
}

/**
 * @description S1 dedup gate for the dedicated sub-agent status edit: should the
 * freshly rendered line actually be re-sent, given the last text that reached
 * Telegram? `false` when the text is unchanged — re-editing identical text only
 * earns a `400 "message is not modified"`, and a stuck/frozen elapsed counter
 * would otherwise churn that 400 on every refresh until the per-group 429 flood
 * limit starves the whole topic (live incident 2026-08-03). A `null` last text
 * (fresh open / post-clear) always sends.
 */
export function checkShouldSendSubagentStatus(nextText: string, lastText: string | null): boolean {
  return nextText !== lastText;
}

/**
 * @description S2 hard safety net for the dedicated sub-agent status tick:
 * should the frame be CLOSED (instead of re-arming the elapsed-tick timer)?
 * `true` when the owning session is no longer active, OR the frame has outlived
 * any realistic delegation (`maxAgeMs`). A session that dies server-side emits
 * no clean idle/finish, so the adapter's defensive close never fires and the
 * self-re-arming timer would otherwise live forever churning the topic (live
 * 2026-08-03). A `null` `startedAtMs` (should never happen while a message is
 * open) is treated as "just started", so a transient race can never force-close
 * an otherwise healthy frame on the age branch.
 */
export function checkShouldExpireSubagentStatus(input: {
  startedAtMs: number | null;
  nowMs: number;
  maxAgeMs: number;
  isOwningSessionActive: boolean;
}): boolean {
  if (!input.isOwningSessionActive) return true;
  const startedAt = input.startedAtMs ?? input.nowMs;
  return input.nowMs - startedAt > input.maxAgeMs;
}
