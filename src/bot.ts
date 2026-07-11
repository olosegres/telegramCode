import { Telegraf, Markup, type Context, type NarrowedContext } from 'telegraf';
import { message } from 'telegraf/filters';
import type {
  Update,
  Message,
  InputMediaPhoto,
  InputMediaDocument,
} from 'telegraf/typings/core/types/typegram';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

import {
  getAdapter,
  getThreadAdapter,
  getThreadAdapterName,
  getThreadAdapterNameRaw,
  setThreadAdapter,
  getAvailableAdapters,
  getDefaultAdapterName,
  registerAdapterEventHandlers,
  registerDisplayPrefsReader,
  registerSeenWatermarkWriter,
  registerJsonStreamTailWriter,
  stopAllAdaptersFor as sweepAdapters,
  getKnownAdapterNames,
  checkIsClaudeBackend,
  resolveClaudeBackendName,
  parseClaudeBackendArg,
  getClaudeModeAction,
} from './adapters/createAdapter';
import { ClaudeJsonStreamAdapter, claudeJsonStreamAdapterName } from './adapters/claudeJsonStreamAdapter';
import { checkShouldPostReattachRecap, formatReattachRecap } from './resumeContext';
import type { ThreadKey, AgentAdapter, AgentSession, DisplayVerbosityMode, OutputEventMeta, OutputTransport, PendingQuestionState, AgentApiErrorClass, ResolvedThreadDisplayPrefs, SeenWatermark, SubagentStatusEvent, ThinkingEvent, ToolResultEvent } from './types';
import { createOutputTransport } from './output/createOutputTransport';
import { keyToString, keyFromString } from './types';
// Pure parser lives in `./agentTrigger` so it can be unit-tested without
// booting Telegraf (audit S19 / #25).
import { parseAgentTrigger as checkIsStartAgentPhrase } from './agentTrigger';
import { checkSessionPickAction } from './sessionPick';
import { ClaudeCliAdapter, getClaudeReplyRoute } from './adapters/claudeCliAdapter';
import { OpenCodeAdapter, checkIsValidProviderId, type OpenCodePendingQuestion } from './adapters/openCodeAdapter';
import { TerminalAdapter } from './adapters/terminalAdapter';
import {
  buildQuestionBodyLines,
  buildQuestionBodyLinesPlain,
  recordAnswerAndAdvance,
  migratePendingQuestionState,
  getQuestionReplyRoute,
} from './openCodeQuestionFlow';
import { checkShouldRepostPendingQuestion } from './pendingQuestionRepost';
import {
  enqueueSend,
  sendUnpaced,
  checkIsRateLimited,
  getRateLimitRemainingMs,
  getActiveChatRateSummaries,
  formatRateSummaryLine,
  enterShutdownDrain,
  drainPendingSends,
  shutdownDrainMaxMs,
  type ShutdownDrainVerdict,
} from './rateLimiter';
import {
  stopOpenCodeServer,
  ensureOpenCodeServer,
} from './installManager';
import { getStateStore, KeyLock, type StateStore } from './state';
import { releaseLock } from './cli/lock';
import { gracefulShutdown } from './shutdown';
import {
  createUpdateDispatcher,
  installUpdateDispatcher,
  getUpdateQueueKey,
} from './updateDispatcher';
import { classifyBoot } from './bootClassifier';
import { t } from './i18n';
import { validateSubdir, resolveBoundWorkDir, BindError, findAutobindSubdir, paginateBindList } from './validation';
import { validateNewFolderName, NewFolderNameError } from './folderName';
import {
  resolveThreadKeyForMode,
  checkIsDmThreadKey,
  resolvePairingCandidate,
  checkIsChatMode,
  GENERAL_THREAD_ID,
  DM_GENERAL_THREAD_ID,
  type ChatMode,
} from './threadRouting';
import { AdminCache, checkShouldInvalidateAdminCache, extractAdminIds, ADMIN_CACHE_TTL_MS } from './accessControl';
import type { UpdateType } from 'telegraf/typings/telegram-types';
import { downloadFile } from './utils/download';
import { stripCommandBotMention } from './utils';
import { checkIsConnectCommandText, getRecvTracePreview } from './utils/recvPreviewRedaction';
import {
  classifySendError,
  checkIsApiError,
  getErrorCode,
  getErrorDescription,
} from './sendErrorClassifier';
import { formatPinnedStatus } from './pinnedStatus';
import { checkIsProgressChunk, collapseProgressChunk } from './progressLine';
import { StartupPromptBuffer } from './startupPromptBuffer';
import { renderAgentHtml } from './renderAgentHtml';
import { splitMessage, MAX_MESSAGE_LEN } from './messageSplit';
import { getOutputFlushPlan, appendPendingOutput, getUnsentRemainder } from './utils/outputFlushPlan';
import { glueBacklogFrames } from './utils/outputBacklogGlue';
import { checkShouldKeepTyping as checkShouldKeepTypingDecision } from './utils/typingActive';
import { getOutputFlushTiming } from './utils/outputFlushTiming';
import { getOutputDebounceMs as resolveOutputDebounceMs } from './utils/outputDebounce';
import { checkIsStaleAnswerCallbackQueryError } from './utils/telegramError';
import {
  flushTraceBufferSyncOnExit,
  installCallApiTrace,
  pruneTraceBuckets,
  setTraceConfig,
  traceAgentEmit,
  traceRecvUpdate,
} from './outputTrace';
import { pruneExpiredBuckets, retentionMs as logBucketRetentionMs } from './utils/rotatingLogFile';
import { consoleFileBase, consoleFileExt } from './utils/consoleFileTap';
import { clearThreadOutputQueues } from './utils/clearThreadOutputQueues';
import { getGroupFinalizePlan } from './utils/groupFinalizePlan';
import { persistAdapterSessionIds } from './utils/persistAdapterSessionIds';
import {
  resolveSendFileWithinDir,
  classifyFileSendKind,
  planFileSend,
  trimCaption,
  type FileSendItem,
} from './utils/fileSendPlan';
import { getStatusFlushAction } from './utils/statusFlushDecision';
import { createIdenticalOutputGuard } from './utils/identicalOutputGuard';
import { getTransientFrameIds } from './utils/transientFrames';
import {
  getThinkingEventAction,
  getThinkingAnswerStartAction,
  formatThinkingDurationSeconds,
} from './utils/thinkingRender';
import {
  getToolResultRenderAction,
  getTruncatedToolResult,
  buildFencedToolResultBody,
} from './utils/toolResultRender';
import { buildSubagentOutputPrefix } from './utils/subagentRender';
import {
  buildSubagentElapsedText,
  getSubagentStatusAction,
} from './utils/subagentStatusRender';
import {
  displayVerbosityModeOptions,
  normalizeDisplayVerbosityMode,
} from './utils/displayVerbosity';
import { getUniformVerbosityLevel } from './utils/verbosityRender';
import { createSerialQueue, type SerialQueue } from './utils/serialQueue';
import { getVoiceTranscriptionQueue } from './voiceQueue';
import {
  buildClaudeLivenessFrameText,
  checkShouldForceIdleRemoval,
  checkShouldSendLivenessFrame,
  getClaudeLivenessAction,
  getClaudeLivenessShouldStop,
  getStatusFrameStoreDecision,
} from './utils/claudeLivenessAction';
import { getModelSetReplyDecision } from './utils/modelSetReplyDecision';
import { formatIsoLocalOffset } from './utils/isoTimestamp';
import {
  buildThreadContextPreamble,
  prependThreadContextPreamble,
  checkShouldInjectPreamble,
  checkShouldSkipPreambleForText,
} from './threadContextPreamble';
import { getPinnedBannerSkipDecision } from './utils/pinnedBannerSkipDecision';
import {
  getTelegramFileMeta,
  getMediaGroupId,
  buildSavedFileName,
  buildFilePromptText,
  buildAlbumPromptText,
  checkIsFileTooBig,
  telegramFileDownloadCapBytes,
  incomingFileMessageFilter,
} from './telegramFileIntake';
import type { TelegramFileMeta, AlbumFile } from './telegramFileIntake';
import { createMediaGroupCollector } from './utils/mediaGroupCollector';
import { sessionTitleSnippetMaxLength } from './openCodeSessionTitle';
import {
  ensureThreadFilesDir,
  purgeThreadFiles,
  resolveFilesRoot,
  sweepExpiredThreadFiles,
  fileRetentionMs,
  fileSweepIntervalMs,
} from './botFileStorage';
import { resolveJsonStreamRoot, sweepOrphanJsonStreamDirs } from './utils/jsonStreamHost';
import { RunLedger } from './scheduler/runLedger';
import { createScheduleDelivery, unboundDeliveryError } from './scheduler/delivery';
import { createSchedulerEngine, maxTimeoutMs, type SchedulerEngine } from './scheduler/engine';
import { createSchedulerMcpServer, type SchedulerMcpHandle } from './scheduler/mcpSurface';
import { configureSchedulerMcpInjection } from './scheduler/injection';
import { getThreadKeysForDirectory } from './scheduler/directoryThreads';
import { getRebindResumeAction } from './scheduler/rebindResume';
import type { DeliveryOutcome, FireContext, ScheduleRecord } from './scheduler/types';
import { decideRetryAction, classifyAgentApiError } from './apiErrorRetry';

// ═══════════════════════════════════════════════════════════════════════════════
//  ENV parsing & fatal validation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Parse + validate boot environment. Throws (and ends the
 * process via `index.ts`) on any required mis-configuration so the bot
 * never silently runs in a half-broken state.
 *
 * `TELEGRAM_BOT_TOKEN` is the only normal required env var. `WORK_ROOT` is
 * usually supplied by the CLI wrapper as `$PWD`; the fallback here keeps a
 * direct import from silently becoming stricter than the public entrypoint.
 */
function parseEnv() {
  const errors: string[] = [];

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) errors.push('TELEGRAM_BOT_TOKEN is required');

  // CHAT_MODE selects which surface(s) the instance serves: `group` (forum
  // supergroup only), `dm` (the owner's private chat only), or `both` (one
  // instance serves the owner DM AND the group at once, decided per chat).
  // Unset → `both`, so a bare `telegramCode` lights up both surfaces. An unknown
  // value fails fast (same intent as the ALLOWED_GROUP_ID numeric gate).
  const chatModeRaw = (process.env.CHAT_MODE ?? '').trim();
  let chatMode: ChatMode = 'both';
  if (chatModeRaw) {
    if (checkIsChatMode(chatModeRaw)) {
      chatMode = chatModeRaw;
    } else {
      errors.push(`CHAT_MODE must be "group", "dm" or "both" (got "${chatModeRaw}")`);
    }
  }

  // OWNER_USER_ID is the numeric Telegram user id allowed to use the bot in DM
  // (the owner's private-chat id equals their user id). REQUIRED for `dm`
  // (without it the DM surface would have no access authority — any user can DM a
  // bot). For `both` it is OPTIONAL: set → the DM surface is active; unset → the
  // DM surface is INERT (group-only) and boot logs a notice, so default `both`
  // stays backward-compatible with a bare group-only deploy. Ignored in `group`.
  const ownerUserIdRaw = (process.env.OWNER_USER_ID ?? '').trim();
  let ownerUserId = NaN;
  if (ownerUserIdRaw) {
    ownerUserId = Number(ownerUserIdRaw);
    if (!Number.isFinite(ownerUserId)) {
      errors.push('OWNER_USER_ID must be a numeric Telegram user id');
    }
  } else if (chatMode === 'dm') {
    errors.push('OWNER_USER_ID is required when CHAT_MODE=dm (numeric Telegram user id)');
  }
  // The DM surface is inert when no owner is configured. Impossible for `dm`
  // (owner required above) and `group` (no DM surface); only `both` without an
  // OWNER_USER_ID reaches it → that instance serves the group only.
  const isDmSurfaceInert = !Number.isFinite(ownerUserId);

  // Access authority is fully runtime: the creator + administrators of the
  // served forum group (read live via getChatAdministrators, cached). There is
  // no static user allow-list env any more — the old ALLOWED_USERS is removed.

  // ALLOWED_GROUP_ID is optional: leave it empty to auto-pair with the
  // first forum supergroup an allowed user contacts the bot from (the id
  // is then persisted to state.json). A non-numeric value is still an
  // error — Telegram addresses chats by numeric id, not by group name.
  const allowedGroupIdRaw = (process.env.ALLOWED_GROUP_ID ?? '').trim();
  let allowedGroupId = NaN;
  if (allowedGroupIdRaw) {
    allowedGroupId = Number(allowedGroupIdRaw);
    if (!Number.isFinite(allowedGroupId)) {
      errors.push(
        'ALLOWED_GROUP_ID must be a numeric chat id (e.g. -1001234567890), ' +
          'or leave it empty to auto-pair with your forum supergroup on first contact',
      );
    }
  }

  const workRoot = process.env.WORK_ROOT || process.cwd();
  try {
    if (!fs.statSync(workRoot).isDirectory()) {
      errors.push(`WORK_ROOT="${workRoot}" is not a directory`);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'unknown';
    errors.push(`WORK_ROOT="${workRoot}" is not accessible (${code})`);
  }

  if (errors.length > 0) {
    for (const err of errors) console.error(`[startup] ${err}`);
    process.exit(1);
  }

  return {
    botToken: botToken!,
    chatMode,
    ownerUserId,
    isDmSurfaceInert,
    allowedGroupId,
    workRoot,
    openaiApiKey: process.env.OPENAI_API_KEY,
    groqApiKey: process.env.GROQ_API_KEY,
  };
}

const ENV = parseEnv();

// ═══════════════════════════════════════════════════════════════════════════════
//  Effective group id — single source of truth for the forum supergroup
//
//  A numeric `ALLOWED_GROUP_ID` env locks the id and disables auto-pairing.
//  Otherwise the id starts `null` (pairing mode) and is adopted from
//  `state.json` at boot (see startBot) or set live by the pairing middleware
//  / `/pair`. Every runtime consumer reads `getAllowedGroupId()` so a
//  pairing event takes effect without a restart.
// ═══════════════════════════════════════════════════════════════════════════════

const isGroupLockedByEnv = Number.isFinite(ENV.allowedGroupId);
let effectiveGroupId: number | null = isGroupLockedByEnv ? ENV.allowedGroupId : null;

/** The forum supergroup id currently in effect, or `null` while unpaired. */
function getAllowedGroupId(): number | null {
  return effectiveGroupId;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Served-surface mode — group (supergroup) / dm (owner private chat) / both
//
//  Selected at boot by CHAT_MODE; `both` (the default) serves the group AND the
//  owner DM at once, decided PER CHAT. The surface a given update belongs to is
//  read off its resolved ThreadKey: a DM key carries the owner's chat id
//  (`resolveDmThreadKey` enforces `chat.id === ownerUserId`), so
//  `checkIsDmKey(key)` is the per-chat discriminator that replaces the old
//  global `checkIsDmMode()`. Access authority stays per surface: the owner id
//  for a DM chat, the served group's admin cache for the group chat.
// ═══════════════════════════════════════════════════════════════════════════════

/** The served surface(s) in effect for this process (fixed at boot). */
function getChatMode(): ChatMode {
  return ENV.chatMode;
}

/** The owner's Telegram user id (DM access authority), or `NaN` when no DM owner. */
function getOwnerUserId(): number {
  return ENV.ownerUserId;
}

/**
 * @description Is the DM surface live in this process? True for `dm`, and for
 * `both` only when an OWNER_USER_ID is configured (otherwise the DM surface is
 * inert and the instance serves the group only). Always false for `group`. The
 * single gate `getThreadKey` consults before trying the owner-DM resolver.
 */
function checkIsDmSurfaceActive(): boolean {
  if (getChatMode() === 'group') return false;
  return !ENV.isDmSurfaceInert;
}

/**
 * @description Per-chat discriminator: does this resolved key belong to the DM
 * surface? Thin runtime wrapper over the pure {@link checkIsDmThreadKey}: a DM
 * key's `chatId` is the owner's user id, so the equality both identifies the
 * surface and re-asserts the owner. False when the DM surface is inert — so a
 * group-only `both` is always group.
 */
function checkIsDmKey(key: ThreadKey): boolean {
  return checkIsDmThreadKey(key, getOwnerUserId(), checkIsDmSurfaceActive());
}

/**
 * @description Per-context discriminator for the gated sites that decide BEFORE a
 * key is resolved (access control). A DM chat is the owner's private chat: the
 * private-chat id equals the owner's user id, so the same equality both gates the
 * chat type and identifies the owner. False when the DM surface is inert.
 */
function checkIsDmChat(ctx: Context): boolean {
  if (!checkIsDmSurfaceActive()) return false;
  const chat = ctx.chat;
  if (!chat || chat.type !== 'private') return false;
  return chat.id === getOwnerUserId();
}

/**
 * The per-surface output transport, selected once at boot from CHAT_MODE
 * (`registerOutputTransport`, mirroring `registerDisplayPrefsReader`). The
 * output / status / teardown sites route through it instead of branching on the
 * surface themselves; in `both` it is a dispatcher that routes each call by
 * `checkIsDmKey(key)` to the DM or group impl. Null until boot wires it.
 */
let outputTransport: OutputTransport | null = null;

/** Wire the boot-selected output transport. Called once near the adapter wiring. */
function registerOutputTransport(transport: OutputTransport): void {
  outputTransport = transport;
}

/** The boot-selected output transport. Throws if read before boot wiring. */
function getOutputTransport(): OutputTransport {
  if (!outputTransport) {
    throw new Error('outputTransport accessed before registerOutputTransport at boot');
  }
  return outputTransport;
}

const telegramAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  family: 4,
});
const bot = new Telegraf(ENV.botToken, { telegram: { agent: telegramAgent } });

// Decouple the long-polling intake/ACK from per-handler latency: wrap
// `bot.handleUpdate` so each update is enqueued into its thread's serial queue
// and the loop's `Promise.all` resolves at once (next `getUpdates` = ACK + new
// batch fires now). The real middleware chain — the two `bot.use` middlewares,
// every command/`on`/action, `bot.catch` — runs unchanged inside the captured
// original, just off-loop and per-thread-serial. MUST be installed before
// `bot.launch`. The graceful-shutdown path drains it (see `updateDrainTimeoutMs`).
const updateDispatcher = createUpdateDispatcher({
  getKey: getUpdateQueueKey,
  onError: (error, update) =>
    console.error(`[dispatch] unhandled error for update ${update.update_id}:`, error),
});
installUpdateDispatcher(bot, updateDispatcher);
/** Bound (well under the 10s shutdown watchdog) for draining queued updates on shutdown. */
const updateDrainTimeoutMs = 2000;

// Output-trace mode (toggled at runtime via `/trace`): record every outgoing
// Bot API call with its outcome at the single `callApi` chokepoint. Installed
// unconditionally — when tracing is off each call costs one boolean check.
// The buffered writer is flushed synchronously on process exit so the final
// window is not lost on shutdown.
installCallApiTrace(bot.telegram);
process.on('exit', flushTraceBufferSyncOnExit);

// ═══════════════════════════════════════════════════════════════════════════════
//  Access control — who may talk to the agent
//
//  Authority is fully runtime: the creator + administrators of the served forum
//  group. The set is read live via `getChatAdministrators` and cached for an
//  hour (lazy refresh on the first access after expiry); an admin-status change
//  in the group (`chat_member` update) invalidates the cache immediately, so a
//  demoted/left admin drops out on their next message — the TTL is only the
//  fallback. There is no static allow-list env and no /grant command.
// ═══════════════════════════════════════════════════════════════════════════════

const adminCache = new AdminCache({
  fetchAdmins: () => {
    const groupId = getAllowedGroupId();
    return groupId === null ? Promise.resolve([]) : bot.telegram.getChatAdministrators(groupId);
  },
  ttlMs: ADMIN_CACHE_TTL_MS,
});

/**
 * @description True iff the sender of `ctx` may use the bot — decided PER CHAT,
 * which is the single source of truth for access on each surface:
 *   - a DM chat (the owner's private chat) → the configured OWNER_USER_ID is the
 *     sole authority;
 *   - the group chat → a creator/admin of the served forum group (admin cache).
 * The owner-id / admin-cache split must stay per surface: gating a DM with the
 * group admins would let any group admin act in the owner's DM, and gating the
 * group with the owner id would lock out the group's real admins.
 */
async function checkIsAllowedUser(ctx: Context): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (checkIsDmChat(ctx)) {
    return userId === getOwnerUserId();
  }
  const adminIds = await adminCache.getAdminIds();
  return adminIds.has(userId);
}

/**
 * @description Direct (uncached) check that `userId` is a creator/administrator
 * of `chatId`. Used only at pairing time, where the served group isn't fixed yet
 * so the cache (keyed to the served group) doesn't apply. Returns `false` on any
 * API failure — pairing should fail closed.
 */
async function checkIsForumAdmin(chatId: number, userId: number): Promise<boolean> {
  try {
    const members = await bot.telegram.getChatAdministrators(chatId);
    return extractAdminIds(members).includes(userId);
  } catch (e) {
    console.warn(`[pair] getChatAdministrators(${chatId}) failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}

// Output-trace `recv` hook — must be the FIRST middleware so every update is
// recorded before any gating (access control, group routing) can drop it.
// Security: while the thread awaits a `/connect` key paste (same
// `pendingProviderConnects` state the text handler consumes later in this
// update), the message text is a provider API key — the preview is redacted
// at record time so the secret never lands in the on-disk trace.
bot.use(async (ctx, next) => {
  const message = ctx.message;
  const messageText = message && 'text' in message ? message.text : undefined;
  const callbackData =
    ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
  const threadKey = messageText === undefined ? null : getThreadKey(ctx);
  const isThreadPendingProviderConnect =
    threadKey !== null && pendingProviderConnects.has(keyToString(threadKey));
  traceRecvUpdate({
    updateType: ctx.updateType,
    updateId: ctx.update.update_id,
    fromId: ctx.from?.id,
    chatId: ctx.chat?.id,
    threadId: message?.message_thread_id,
    preview:
      messageText === undefined
        ? callbackData
        : getRecvTracePreview(messageText, isThreadPendingProviderConnect),
    tgDateSec: message?.date,
  });
  return next();
});

// Auto-pairing must run before any command / `on` handler so a freshly
// discovered group id is already in effect by the time the routing gates
// fire on the same update. Registered here (right after bot creation) to
// guarantee it precedes the module-scope handler registrations below.
bot.use(async (ctx, next) => {
  await tryAutoPair(ctx);
  return next();
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description `GENERAL_THREAD_ID` is imported from `./threadRouting`
 * (the pure routing module owns it so unit tests can reach it without
 * booting Telegraf). Plan §4.3 point 3 / R2.
 */

/**
 * @description Update types the bot subscribes to (`allowed_updates` at
 * launch). `chat_member` is NOT in Telegram's default set and must be
 * requested explicitly — it drives the immediate admin-cache invalidation on
 * promotion/demotion in the served group. The rest reproduces exactly the
 * default-set types the registered handlers use (`message` covers text, voice,
 * media and the forum service messages; `callback_query` the inline buttons).
 * Telegram REMEMBERS `allowed_updates` between polls, so the full list must
 * ride every launch — a partial list would silently unsubscribe the rest.
 */
const botAllowedUpdates: UpdateType[] = [
  'message',
  'edited_message',
  'callback_query',
  'my_chat_member',
  'chat_member',
];

/**
 * @description The output debounce window in effect for this process. The
 * persist/`queueOutput` path is group-only in DM v2 (DM streams via the native
 * draft cursor and finalizes at boundaries), so there is one value left — the
 * group cadence. The constant lives in the pure `utils/outputDebounce` module so
 * it is unit-testable without booting Telegraf; the pure timing helper
 * `getOutputFlushTiming` just receives this value as its `normalDebounceMs`.
 */
function getOutputDebounceMs(): number {
  return resolveOutputDebounceMs();
}

/**
 * Tick cadence of the Claude liveness loop (bug #11). Re-checks `checkIsBusy`
 * and refreshes the activity frame this often. ~1s reads as alive during the
 * 300ms→1.5s scrape backoff and quiet thinking stretches, while staying at/below
 * Telegram's ~1 edit/sec/chat budget so the rolling frame never triggers a 429
 * storm. The coalescer + `lastSentText` dedup drop identical re-edits, so a
 * frozen spinner glyph costs zero Bot API calls.
 */
const CLAUDE_LIVENESS_TICK_MS = 1000;

/**
 * S1/S3: the BASE floor for how often the liveness loop RE-RENDERS+SENDS the
 * working-status frame (its live `m:ss` elapsed). Decoupled from
 * {@link CLAUDE_LIVENESS_TICK_MS} (the 1s idle-CHECK cadence) so the elapsed
 * advances visibly — proving "working" vs "hung" — without a per-second
 * `editMessageText` flood near Telegram's ~1 edit/sec/chat budget. A `create`
 * (no frame yet) bypasses this and shows immediately.
 *
 * S3: under a live 429 cooldown the actual throttle scales UP to the remaining
 * cooldown (`max(this, getRateLimitRemainingMs)` in {@link checkShouldSendLivenessFrame}),
 * mirroring the relay output debounce, so the status frame stops adding
 * `editMessageText` traffic to an already-throttling chat. The 3s→5s floor bump
 * further cuts the frame's baseline edit rate (the status frame was ~half the
 * 429-storm traffic, live 2026-06-29).
 */
const claudeWorkingStatusRefreshMs = 5000;

/**
 * S2: how long the scraped TUI pane may stay byte-identical before the liveness
 * loop treats the agent as idle and FORCE-removes the working-status frame
 * (the hard anti-hang net). A genuinely working agent repaints the pane every
 * second (animated spinner + the TUI's own elapsed timer), so 30s of a static
 * pane means the turn is over even if Claude's footer busy signal is stuck —
 * never trips mid-think. See {@link checkShouldForceIdleRemoval}.
 */
const claudeIdlePaneMs = 30_000;

/**
 * S2: how long the liveness loop keeps ticking after a busy-ONSET arm (a prompt
 * was just forwarded) while Claude's footer busy signal has not flipped yet.
 * Without this grace the first idle tick would self-stop the loop (idle, no
 * frame, nothing pending) before Claude starts thinking, so a long quiet think
 * would show NO working frame (the muted-topic "looks hung" bug). ~8s comfortably
 * spans the gap between submit and Claude going busy; once busy is observed the
 * grace is cleared and normal busy ticking owns the frame.
 */
const claudeBusyOnsetGraceMs = 8_000;

/**
 * Cadence of the dedicated OpenCode sub-agent status message's elapsed-counter
 * tick. One `editMessageText` per active delegation every 10 s — far under
 * Telegram's ~1 edit/sec/chat budget, so the live "m:ss" counter never costs a
 * 429. A failed edit just retries on the next tick.
 */
const subagentTickMs = 10_000;

/**
 * Re-fire cadence of the native typing-indicator loader. Telegram's `typing`
 * chat action self-expires after ~5 s, so the sustained loader re-sends it on
 * this interval (comfortably under the expiry) to keep the dots visible for as
 * long as the agent is working. One `sendChatAction` per tick is negligible
 * against the rate budget.
 */
const typingLoaderRefreshMs = 4_000;

/**
 * Rotating spinner glyphs for the liveness frame's neutral fallback (used only
 * when no scraped activity line is available). Cycling them on each tick makes
 * the frame visibly alive even while the scrape is quiet. Mirrors the TUI's own
 * whimsical spinner set so the relayed indicator looks native.
 */
const CLAUDE_LIVENESS_GLYPHS = ['✻', '✽', '✶', '✢'] as const;

/**
 * Small slack added on top of the remaining 429 cooldown before a deferred
 * send is retried, so the retry fires *after* the cooldown has actually
 * lifted rather than racing its boundary. Shared by the status coalescer's
 * deferred-frame retry and the B14 interactive-reply redelivery.
 */
const COOLDOWN_RETRY_SLACK_MS = 250;

// ═══════════════════════════════════════════════════════════════════════════════
//  State store — singleton populated in startBot(), referenced by handlers
// ═══════════════════════════════════════════════════════════════════════════════

let state!: StateStore;

/**
 * @description The scheduler timer engine (S3), constructed in {@link startBot}.
 * Module-level so the `/unbind` pause path, the `/bind` resume path, and the
 * shutdown handler can reach `armJob` / `disarmJob` / `shutdown` without
 * threading the instance through every caller. `null` until boot wires it.
 */
let schedulerEngine: SchedulerEngine | null = null;

/**
 * @description Resolve the live `DATA_DIR` from the state store. The store
 * owns `state.json` in that directory, so its parent is the single source of
 * truth for where bot-owned data (including intake files) lands.
 */
function getDataDir(): string {
  return path.dirname(state.stateFilePath);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Per-thread in-memory state
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description UI state per `ThreadKey` — tracks the editable message id,
 * status indicator, and loader message used for the typing UX. Lives in
 * memory only (re-derived on bot restart from the next outgoing message).
 *
 * Persistent state — bindings, agent choice, message-id history — lives
 * in `state.json` via {@link StateStore}, not here.
 */
interface ThreadMessageState {
  /** Most recent assistant-message id we can edit in place. */
  lastMessageId: number | null;
  /** Source (pre-render) text currently shown in `lastMessageId` — the append base for streaming continuations. */
  lastMessageText: string | null;
  /** True when next output should send a new message instead of editing. */
  needsNewMessage: boolean;
  /**
   * The sole "agent is working" loader: a timer that re-fires the native typing
   * indicator (`sendChatAction('typing')`) while the bot waits for output (a
   * self-greeting boot, every prompt forward). `null` = no loader running.
   * Re-fired because Telegram's typing action self-expires after a few seconds.
   * Cleared ONLY by a real event (first output / status / question / teardown /
   * start-fail) — never by a timeout, so a long-thinking agent keeps the loader.
   */
  typingLoaderTimer: NodeJS.Timeout | null;
  /** Transient status/spinner message id — replaced by permanent text. */
  statusMessageId: number | null;
  /**
   * Thinking (chain-of-thought) message id — owned independently of
   * {@link statusMessageId} so the live "☁️ thinking …" indicator can persist
   * across tool-status churn. Lifecycle per the thinking
   * {@link DisplayVerbosityMode}: edited live while reasoning, then (per mode)
   * collapsed to "💭 thought for {N}s", left as-is, or deleted when the answer
   * starts. `null` = no thinking message. The accumulated reasoning text
   * mirrors what the adapter sent, so a `full`-mode live frame can re-render
   * the full body on each edit.
   */
  thinkingMessageId: number | null;
  /**
   * Monotonic generation for the thinking-message lifecycle, bumped on every
   * {@link clearThinkingMessage} (session end / question takeover). A create in
   * flight captures it before its `await` and re-checks after: a clear that
   * lands mid-create bumps the generation, so the just-created message is
   * DELETED instead of resurrecting `thinkingMessageId` as an orphan under the
   * "session ended" / question UI. (Mirror of {@link statusFrameGeneration} —
   * the persist path `finishThinkingMessage` does NOT bump it, so a normal
   * collapse/keep leaves the message in the chat.)
   */
  thinkingFrameGeneration: number;
  /**
   * Monotonic generation for the status-frame lifecycle, bumped on every
   * `deleteStatusMessage`. `sendStatusFrame` captures it before creating a new
   * message and re-checks after the `await` (see `getStatusFrameStoreDecision`):
   * a delete that lands mid-create bumps the generation, so the just-created
   * message is discarded instead of resurrecting `statusMessageId` as an orphan.
   * The anti-thrash guard that keeps the spinner a SINGLE, reliably-removed frame.
   */
  statusFrameGeneration: number;
  /**
   * Claude liveness loop (bug #11): a self-disarming per-thread timer that keeps
   * an activity frame on screen for the WHOLE busy period, driven by
   * `checkIsBusy` rather than opportunistic scrape emits. `null` = no loop armed.
   */
  livenessTimer: NodeJS.Timeout | null;
  /**
   * Latest activity text the Claude scrape produced (the `✻ Verb… (Ns · tokens)`
   * line), fed in from `handleAdapterStatus`. The liveness frame prefers this
   * over the neutral `agent.workingIndicator` fallback. `null` = none seen yet.
   */
  lastActivityText: string | null;
  /** Rotating index into {@link CLAUDE_LIVENESS_GLYPHS} for the fallback frame. */
  livenessGlyphIndex: number;
  /** Last `checkIsBusy` reading, so the loop can detect a busy→idle edge. */
  wasBusy: boolean;
  /**
   * Epoch ms the current busy turn started — the base for the working-status
   * frame's live `m:ss` elapsed (S1 un-freeze). Set when the liveness loop arms
   * a FRESH turn (idle→busy edge) and reset when a new prompt is forwarded;
   * cleared (`null`) when the loop stops, so the next turn restarts at 0:00.
   * Held STABLE across a turn's output-delete→recreate churn so the counter
   * stays monotonic within the turn.
   */
  workingSince: number | null;
  /**
   * Epoch ms the liveness loop last RE-RENDERED+SENT the working frame, gating
   * the {@link claudeWorkingStatusRefreshMs} send throttle so the 1s idle-CHECK
   * tick does not push a per-second `editMessageText`. `0` = never sent this
   * process; a fresh turn's first tick always passes (its base is far in the past).
   */
  lastLivenessSentAt: number;
  /**
   * Idle-removal latch (S2): set true when the loop force-removed the frame
   * because the scraped pane went static for ≥ {@link claudeIdlePaneMs}. While
   * latched the loop must NOT recreate a working frame (the hard guarantee: a
   * finished/idle agent never leaves a status hanging). Cleared when a new
   * prompt is forwarded / the loop next arms a fresh turn — so the status is
   * not recreated until genuine new activity re-arms it.
   */
  statusIdleSuppressed: boolean;
  /**
   * Busy-onset arming grace deadline (epoch ms), S2: set when the liveness loop
   * is armed by a freshly-forwarded prompt (not a scrape emit). Until Claude's
   * footer busy signal flips — or this deadline passes — the loop keeps ticking
   * instead of self-stopping on the first idle reading, so a long quiet think
   * still shows a working frame. `0` = not in a busy-onset grace. Cleared the
   * moment busy is observed and on teardown.
   */
  busyOnsetArmedUntil: number;
  /**
   * Dedicated OpenCode sub-agent (delegation) status message id, owned
   * INDEPENDENTLY of {@link statusMessageId} (the fix for the flood bug — the
   * shared status re-`sendMessage`d a new message on every child-text burst).
   * The `minimal`/`short` `/subagent` "working" indicator: ONE message, edited
   * in place with a ticking elapsed counter. `null` = none open. Created on
   * delegation start, deleted on its end / session teardown / question takeover.
   */
  subagentStatusMessageId: number | null;
  /**
   * Epoch ms when the current sub-agent status message opened — the base for
   * the elapsed `m:ss` counter. `null` when no message is open.
   */
  subagentStartedAt: number | null;
  /**
   * Sticky last non-null delegation title for the open sub-agent status
   * message, re-rendered on every elapsed tick. `null` = the delegation never
   * carried a title (falls back to the generic label at render time).
   */
  subagentTitle: string | null;
  /**
   * Self-re-arming unref'd timer that re-edits the sub-agent status message
   * with the updated elapsed time every {@link subagentTickMs}. `null` = not
   * armed (no message open). Mirrors {@link livenessTimer}'s lifecycle.
   */
  subagentTimer: ReturnType<typeof setTimeout> | null;
}

interface OutputQueueState {
  pendingOutput: string | null;
  /** Whether the FIRST batch in `pendingOutput` continues the last sent message. */
  pendingIsContinuation: boolean;
  isProcessing: boolean;
  debounceTimer: NodeJS.Timeout | null;
}

/**
 * @description Per-thread coalescer for `status` (thinking / spinner) events.
 *
 * Claude's tmux poller can emit a status update every ~300 ms while the
 * agent is thinking, and each one used to translate into its own
 * `editMessageText` call going through the rate-limiter FIFO. A burst of
 * 10 thinking-text changes would put 10 edit operations into the queue —
 * and any real `output` arriving in the middle of that burst had to wait
 * behind them all (this was the "thinking blocks output even within one
 * thread" symptom).
 *
 * The coalescer enforces "at most one status send in flight per thread"
 * and "latest text always wins":
 *
 * - When a status arrives, `pendingText` is overwritten unconditionally.
 *   Stale intermediate frames are dropped before they ever reach Telegram.
 * - If no flush is currently running, one is started; otherwise the
 *   in-flight flush will pick up the new text after it finishes the
 *   current send.
 * - When real `output` arrives (`handleAgentOutput`), `pendingText` is
 *   cleared — there's no point sending a "Thinking…" frame that the
 *   output is about to replace anyway.
 */
interface StatusCoalesceState {
  /** Latest status text not yet sent. `null` = nothing pending. */
  pendingText: string | null;
  /** A `flushStatusCoalescer` loop is currently running. */
  inFlight: boolean;
  /**
   * Last status frame that actually reached Telegram for this thread.
   * Lets the flush loop skip a re-send of identical text (which only earns
   * a `400 "message is not modified"` and wastes a send-budget token).
   */
  lastSentText: string | null;
  /**
   * Armed timer that resumes a flush deferred during a 429 cooldown. While
   * set, new status events only refresh `pendingText` (the newest frame
   * wins) instead of arming a second timer. `null` = none armed.
   */
  deferRetryTimer: NodeJS.Timeout | null;
}

/**
 * @description Per-thread coalescer for the live "☁️ thinking …" indicator.
 *
 * The OpenCode reasoning stream is chatty: even after the adapter's 400 ms
 * debounce, a long chain-of-thought emits many `live` frames. Routing each one
 * into its own `editMessageText` would burn the chat-wide send budget that
 * real output and interactive replies need. The coalescer enforces "at most one
 * thinking edit in flight per thread" and "latest frame wins" (same shape as
 * {@link StatusCoalesceState} but for the dedicated thinking message id).
 */
interface ThinkingCoalesceState {
  /** Latest rendered thinking-frame HTML not yet sent. `null` = nothing pending. */
  pendingHtml: string | null;
  /** A `flushThinkingCoalescer` loop is currently running. */
  inFlight: boolean;
  /** Last frame that actually reached Telegram — skip an identical re-send. */
  lastSentHtml: string | null;
  /**
   * When `true`, the pending frame is the response's FINAL one (the short-mode
   * "thought for {N}s" collapse). The flush loop edits it onto the SAME message,
   * THEN detaches the tracked id (`finishThinkingMessage`) — doing the detach
   * before the edit would make the collapse create a new message instead of
   * replacing the live indicator in place.
   */
  detachAfterDrain: boolean;
}

const threadMessageStates = new Map<string, ThreadMessageState>();
const outputQueues = new Map<string, OutputQueueState>();
const pendingQuestions = new Map<string, PendingQuestionState>();
/**
 * @description Per-thread id of the question message currently PINNED in the
 * topic (in-memory only). A pinned message pierces a MUTED topic, so pinning the
 * pending question is how the operator — who keeps every topic muted — gets a
 * Telegram notification about it. Source of truth for {@link unpinThreadQuestion};
 * re-established after a restart by the OpenCode persisted-`messageId` fallback
 * and Claude's live re-scrape, so it needs no persistence of its own.
 */
const questionPinnedMessageId = new Map<string, number>();
/**
 * @description Placeholder stored in {@link authNoticePinnedMessageId} between
 * reserving the one-notice slot and the pin landing, so a burst of auth errors
 * can't race two notices out. A real Telegram message id is always positive, so
 * `-1` can never collide with one.
 */
const authNoticePendingSentinel = -1;
/**
 * @description Per-thread id of the PINNED "logged-out" notice (in-memory). Its
 * presence is ALSO the one-notice-per-logout-episode guard: while set, a repeat
 * `apiError('auth')` is a no-op. Deliberately SEPARATE from
 * {@link questionPinnedMessageId} — an auth notice must never clobber a real
 * pending question's pin. Cleared (and the message unpinned) on recovery (the
 * first real output after re-login) and at the session-END / teardown sites
 * (session closed/stopped, `/new` release, `/quit`, leaving the folder) — but
 * NOT at the user-takeover {@link cancelApiRetry} sites, which must not
 * re-notify (see the NOTE in {@link cancelApiRetry}).
 */
const authNoticePinnedMessageId = new Map<string, number>();
const threadModelLists = new Map<string, string[]>();
const awaitingModelSelection = new Set<string>();
const statusCoalescers = new Map<string, StatusCoalesceState>();
const thinkingCoalescers = new Map<string, ThinkingCoalesceState>();

/**
 * @description Per-thread backstop against a runaway flood of byte-identical
 * PERMANENT output (flood 2026-06-16: a Claude topic re-emitted one table ~500
 * times). Defense-in-depth behind the table-emit root-cause fix (S1) — caps ANY
 * emit path that re-sends the same large block. Reset on every session
 * stop/closed/unbind via `clearThreadQueues`. See `utils/identicalOutputGuard`.
 */
const identicalOutputGuard = createIdenticalOutputGuard();

/**
 * @description Register/replace a thread's pending interactive question in BOTH
 * the in-memory `pendingQuestions` map and the persisted store, so a restart
 * can restore it (the in-memory map is otherwise lost — see `state.ts`). Single
 * choke point for every `pendingQuestions.set(...)` / `messageId` patch so the
 * two copies never drift. The store write is debounced + fire-and-forget; the
 * in-memory set is what the live button handlers read, so it must be synchronous.
 */
function setPendingQuestion(key: ThreadKey, value: PendingQuestionState): void {
  pendingQuestions.set(keyToString(key), value);
  state.setPendingQuestion(key, value).catch(e =>
    console.error('[pendingQuestion] persist failed:', e),
  );
}

/**
 * @description Drop a thread's pending interactive question from BOTH the
 * in-memory map and the persisted store. Single choke point for every
 * `pendingQuestions.delete(...)` so memory and disk stay in lockstep.
 */
function clearPendingQuestion(key: ThreadKey): void {
  const kStr = keyToString(key);
  // Post-restart OpenCode: the in-memory pin map was lost on restart but the
  // question message is still pinned on Telegram (its id lives on the persisted
  // `pendingQuestions` entry). Seed the map from it so the unpin below finds the
  // id — deterministic, with no reliance on sync execution order against the
  // `delete` that follows. The live case is a no-op (the map already holds the
  // id; `has` is true).
  const pending = pendingQuestions.get(kStr);
  if (pending?.messageId != null && !questionPinnedMessageId.has(kStr)) {
    questionPinnedMessageId.set(kStr, pending.messageId);
  }
  void unpinThreadQuestion(key);
  pendingQuestions.delete(kStr);
  state.clearPendingQuestion(key).catch(e =>
    console.error('[pendingQuestion] clear failed:', e),
  );
  clearQuestionRepostState(key);
}

// ── keep a pending question at the bottom of its topic (plan S3) ──

/**
 * @description Per-thread bookkeeping for the "keep the question at the bottom"
 * re-post (S3). `wasLastSendTheQuestion` is the loop guard: true right after the
 * question is (re-)posted, flipped false by {@link onThreadActivityWhileQuestionPending}
 * as soon as anything else is sent below it. `repostTimer` debounces a burst of
 * output into ONE re-post.
 */
interface QuestionRepostState {
  wasLastSendTheQuestion: boolean;
  repostTimer: NodeJS.Timeout | null;
  /**
   * True while {@link postPendingQuestionAt} is between starting its send and
   * storing the new `messageId`. The re-post path must not run in that window:
   * it would read the PREVIOUS question's `messageId` and delete the wrong
   * message (live race 2026-06-10 — answered-Q1 "✅" deleted, Q2 duplicated).
   */
  isPostInFlight: boolean;
}

const questionRepostStates = new Map<string, QuestionRepostState>();

/**
 * Per-thread serial queues for QUESTION-LIFECYCLE transitions (initial post,
 * re-post-to-bottom, answer→advance→post-next). Each transition spans several
 * awaited sends through the rate-limited send queue, so two transitions
 * running concurrently interleave across SECONDS — live race 2026-06-10: a
 * re-post armed by output below the question executed its delete AFTER the
 * user had already answered, removing the message the answer path was about
 * to ✅-edit ("message to edit not found") and orphaning/duplicating posts.
 * Serializing the transitions makes each one see the other's COMPLETED state.
 * Entries are tiny (an idle queue holds one resolved promise) and bounded by
 * the number of topics, so they are never evicted.
 */
const questionLifecycleQueues = new Map<string, SerialQueue>();

function runQuestionLifecycleOp<T>(key: ThreadKey, op: () => Promise<T>): Promise<T> {
  const kStr = keyToString(key);
  let queue = questionLifecycleQueues.get(kStr);
  if (!queue) {
    queue = createSerialQueue();
    questionLifecycleQueues.set(kStr, queue);
  }
  return queue.run(op);
}

/**
 * Debounce window for the S3 re-post: a busy sub-agent streams many chunks back
 * to back; collapse the whole burst into a single delete+re-post of the
 * question instead of thrashing it per chunk.
 */
const questionRepostDebounceMs = 1_200;

function getQuestionRepostState(key: ThreadKey): QuestionRepostState {
  const kStr = keyToString(key);
  let s = questionRepostStates.get(kStr);
  if (!s) {
    s = { wasLastSendTheQuestion: false, repostTimer: null, isPostInFlight: false };
    questionRepostStates.set(kStr, s);
  }
  return s;
}

function clearQuestionRepostState(key: ThreadKey): void {
  const s = questionRepostStates.get(keyToString(key));
  if (s?.repostTimer) clearTimeout(s.repostTimer);
  questionRepostStates.delete(keyToString(key));
}

/**
 * @description Record that the question message itself was just (re-)posted —
 * so the next {@link onThreadActivityWhileQuestionPending} knows the question is
 * currently at the bottom and must NOT re-post in reaction to its own send (the
 * loop guard). Called by {@link postPendingQuestionAt} after a successful send.
 */
function markQuestionMessageSent(key: ThreadKey, _messageId: number): void {
  const s = getQuestionRepostState(key);
  s.wasLastSendTheQuestion = true;
}

/**
 * @description Hook called right after ANY non-question output is sent into a
 * topic (agent output, status frame, sub-agent/tool emit, api-retry notice).
 * If a question is pending and it is no longer the last message, schedule a
 * debounced re-post so the question returns to the bottom (S3). Cheap no-op when
 * no question is pending — safe to call from every emit handler.
 */
function onThreadActivityWhileQuestionPending(key: ThreadKey): void {
  if (!pendingQuestions.has(keyToString(key))) return;
  const s = getQuestionRepostState(key);
  // Something other than the question just landed below it.
  s.wasLastSendTheQuestion = false;
  if (!checkShouldRepostPendingQuestion({
    isQuestionPending: true,
    wasLastSendTheQuestion: s.wasLastSendTheQuestion,
    isQuestionPostInFlight: s.isPostInFlight,
  })) {
    return;
  }
  // Debounce: a burst of output re-posts the question ONCE, not per chunk.
  if (s.repostTimer) clearTimeout(s.repostTimer);
  s.repostTimer = setTimeout(() => {
    s.repostTimer = null;
    void repostPendingQuestionToBottom(key);
  }, questionRepostDebounceMs);
}

/**
 * @description Re-post the current pending question as the newest thread message
 * (S3): delete the old question message, then send the current question again
 * via {@link postPendingQuestionAt} (which re-renders with S1 descriptions /
 * S2 current index and re-owns `messageId`). No-op if the question was answered
 * meanwhile, or if it is already the last message (the loop guard re-checked at
 * fire time, since the debounce window may have closed the gap).
 */
async function repostPendingQuestionToBottom(key: ThreadKey): Promise<void> {
  // Serialized with the other lifecycle transitions; all guards re-read state
  // INSIDE the critical section, since the world may have moved on between
  // the debounce arming and this op's turn in the queue.
  await runQuestionLifecycleOp(key, async () => {
    const kStr = keyToString(key);
    const pending = pendingQuestions.get(kStr);
    if (!pending) return;
    const s = getQuestionRepostState(key);
    if (s.wasLastSendTheQuestion) return; // already at the bottom — nothing to do
    // A post that started during the debounce window owns `messageId` —
    // deleting based on the stale value would remove the previous (answered)
    // question's message (the live 2026-06-10 race).
    if (s.isPostInFlight) return;
    const oldMessageId = pending.messageId;
    if (oldMessageId !== null) {
      await deleteThreadMessage(key, oldMessageId);
    }
    await postPendingQuestionAt(key);
  });
}

// ── auto-retry after a provider-side API error (plan S4/S5/S6) ──

/** One minute in ms — used only to render the "in N min" notices. */
const apiRetryMsPerMinute = 60_000;

/**
 * Catch-up delay for a retry whose `fireAt` is already in the past at boot.
 * Small (not zero) so the kick is armed via `setTimeout` instead of firing
 * synchronously in the adopt tick — a freshly-adopted Claude pane may still be
 * repainting, and the Enter-verification in `sendInput` covers the residual race.
 */
const apiRetryCatchUpDelayMs = 5_000;

/**
 * @description One thread's live armed-retry timer + bookkeeping. The persisted
 * twin lives in `state.json` (`ApiRetryState`); this in-memory entry additionally
 * holds the actual `NodeJS.Timeout` (not serialisable) and `firedAt` (set when
 * the timer fires) so {@link decideRetryAction} can tell a same-episode
 * recurrence (escalate) from a fresh one (reset to attempt 1).
 */
interface ApiRetryTimerEntry {
  /** The armed timer, or `null` once it has fired (record kept until outcome known). */
  timer: NodeJS.Timeout | null;
  /** 1-based attempt the current/last timer was armed for. */
  attempt: number;
  /** Error class that armed it. */
  kind: AgentApiErrorClass['kind'];
  /** Epoch ms when the timer fired, or `null` while still pending. */
  firedAt: number | null;
}

const apiRetryTimers = new Map<string, ApiRetryTimerEntry>();

/**
 * @description `apiError` from the adapter — arm (or escalate) an auto-retry, or
 * give up. The pure decision lives in {@link decideRetryAction}; this handler is
 * the I/O shell: it posts the class-specific notice, persists the armed record,
 * and arms one unref'd timer whose fire callback is {@link fireApiRetry}.
 *
 * Dedup is delegated to `decideRetryAction` (a `pending` retry → `ignore`), so a
 * repeated Claude scrape frame or a duplicate `session.error` never double-arms.
 */
function handleApiError(key: ThreadKey, cls: AgentApiErrorClass): void {
  const k = keyToString(key);
  const entry = apiRetryTimers.get(k);
  const prev = entry
    ? { attempt: entry.attempt, firedAt: entry.firedAt, pending: entry.timer !== null }
    : null;

  const action = decideRetryAction({
    kind: cls.kind,
    resetAt: cls.resetAt,
    now: Date.now(),
    prev,
  });

  // auth / logged out → surface a pinned notice (never a timer). Deduped to one
  // notice per episode inside `surfaceLoggedOutNotice`.
  if (action.action === 'surface') {
    void surfaceLoggedOutNotice(key);
    return;
  }

  if (action.action === 'ignore') return;

  if (action.action === 'giveUp') {
    void replyToThread(key, t('apiRetry.giveUp', { attempts: action.attempts }));
    void state.clearApiRetry(key).catch(e => console.error('[apiRetry] clear failed:', e));
    apiRetryTimers.delete(k);
    return;
  }

  // action === 'arm'
  if (cls.resetAt !== undefined) {
    void replyToThread(key, t('apiRetry.usageLimitResetNotice', {
      time: formatLocalClock(cls.resetAt),
    }));
  } else if (cls.kind === 'usageLimit') {
    void replyToThread(key, t('apiRetry.usageLimitDelayNotice', {
      minutes: Math.round(action.delayMs / apiRetryMsPerMinute),
      attempt: action.attempt,
    }));
  } else {
    void replyToThread(key, t('apiRetry.transientNotice', {
      minutes: Math.round(action.delayMs / apiRetryMsPerMinute),
      attempt: action.attempt,
    }));
  }

  // S3: the notice landed below any pending question — bring it back to the
  // bottom (debounced; no-op when no question is pending).
  onThreadActivityWhileQuestionPending(key);

  void state
    .setApiRetry(key, { kind: cls.kind, attempt: action.attempt, fireAt: action.fireAt })
    .catch(e => console.error('[apiRetry] persist failed:', e));

  const delayMs = Math.min(action.delayMs, maxTimeoutMs);
  const timer = setTimeout(() => {
    void fireApiRetry(key);
  }, delayMs);
  timer.unref?.();
  apiRetryTimers.set(k, { timer, attempt: action.attempt, kind: cls.kind, firedAt: null });
}

/**
 * @description The retry kick (timer callback): tell the user we're resuming,
 * make sure a session is up (after an OpenCode `session.error` it still is, so
 * `ensureAgentSession` is a no-op and the nudge lands in the SAME live session —
 * context intact; only a genuinely-dead session is restarted via the thread's
 * last adapter), then forward a neutral "continue" nudge.
 *
 * CRITICAL: the kick goes through {@link forwardPromptToAgent} directly, NEVER a
 * scheduler wait-for-idle path — OpenCode's optimistic `isBusy` is not cleared on
 * `session.error`, so a wait-for-idle kick would stall the full 10-min cap.
 *
 * The armed record is intentionally KEPT after firing (timer nulled, `firedAt`
 * stamped): a recurrence within the grace window re-arms at attempt+1 via
 * {@link handleApiError}; a recovery leaves a harmless stale record that the
 * next, later error resets to attempt 1.
 */
async function fireApiRetry(key: ThreadKey): Promise<void> {
  const k = keyToString(key);
  const entry = apiRetryTimers.get(k);
  if (!entry) return;
  entry.timer = null;
  entry.firedAt = Date.now();

  void replyToThread(key, t('apiRetry.resuming'));
  try {
    await ensureAgentSession(key);
    await forwardPromptToAgent(key, getThreadAdapter(key), t('apiRetry.continueNudge'));
  } catch (e) {
    console.error('[apiRetry] kick failed:', e instanceof Error ? e.message : e);
  }
}

/**
 * @description Cancel a thread's armed retry SILENTLY — the user took over, so
 * there is nothing to resume and no give-up notice to post (cancel and give-up
 * must never share a code path). Clears the timer, the in-memory entry, and the
 * persisted record. Wired at the session-end sites (`handleAgentClosed` /
 * `handleAgentStopped`); the remaining user-takeover call-sites are S6.
 */
function cancelApiRetry(key: ThreadKey): void {
  const k = keyToString(key);
  const entry = apiRetryTimers.get(k);
  if (entry?.timer) clearTimeout(entry.timer);
  apiRetryTimers.delete(k);
  void state.clearApiRetry(key).catch(e => console.error('[apiRetry] clear failed:', e));
  // NOTE: intentionally does NOT touch the logged-out notice. `cancelApiRetry`
  // fires on EVERY inbound message (user takeover); clearing the auth notice here
  // would drop the one-notice guard so the user's next prompt (into the STILL
  // logged-out session) re-pins and re-notifies — the exact "notifies per
  // message" bug. The notice is retired only on genuine teardown (the explicit
  // `clearAuthNotice` calls at session-end sites) and on recovery (first real
  // output, in `handleAgentOutput`).
}

/**
 * @description Surface a logged-out / bad-credentials error as ONE PINNED notice
 * (a pin pierces the muted topic → a Telegram notification), backend-aware
 * (Claude → re-`/login`; OpenCode → restart the server). No timer, no persisted
 * retry record — a wait never recovers auth. Deduped to exactly one notice per
 * logout episode via {@link authNoticePinnedMessageId}; the slot is reserved with
 * {@link authNoticePendingSentinel} BEFORE the awaits so a burst of `apiError`
 * frames can't race two notices out. The pin is removed on recovery — the first
 * real output after re-login ({@link clearAuthNotice}, wired in
 * {@link handleAgentOutput}) — and at the session-end / teardown sites (NOT the
 * user-takeover {@link cancelApiRetry} sites; see its NOTE).
 */
async function surfaceLoggedOutNotice(key: ThreadKey): Promise<void> {
  const k = keyToString(key);
  if (authNoticePinnedMessageId.has(k)) return; // already surfaced this episode
  authNoticePinnedMessageId.set(k, authNoticePendingSentinel);

  const messageKey =
    getThreadAdapterName(key) === 'opencode' ? 'apiRetry.loggedOutOpenCode' : 'apiRetry.loggedOutClaude';
  const id = await replyToThread(key, t(messageKey));
  if (id === null) {
    // Send failed — release the reservation so a later error can retry surfacing.
    if (authNoticePinnedMessageId.get(k) === authNoticePendingSentinel) authNoticePinnedMessageId.delete(k);
    return;
  }
  // A concurrent teardown (clearAuthNotice) may have dropped the reservation
  // mid-send; don't resurrect it — leave the message unpinned in that case.
  if (!authNoticePinnedMessageId.has(k)) return;
  authNoticePinnedMessageId.set(k, id);
  // First pin of the episode notifies (disableNotification: false).
  await pinMessageQuiet(key, id, { disableNotification: false });
}

/**
 * @description Retire a thread's pinned logged-out notice: unpin it (if a real
 * message was pinned — the sentinel means the pin hadn't landed yet) and drop the
 * one-notice guard so a LATER logout notifies again. Called on recovery (first
 * real output) and at the session-end / teardown sites (NOT folded into
 * {@link cancelApiRetry} — see its NOTE). No-op when none is active.
 */
function clearAuthNotice(key: ThreadKey): void {
  const k = keyToString(key);
  const pinnedId = authNoticePinnedMessageId.get(k);
  if (pinnedId === undefined) return;
  authNoticePinnedMessageId.delete(k);
  if (pinnedId !== authNoticePendingSentinel) void unpinMessageQuiet(key, pinnedId);
}

/** Host-local `HH:MM` of an epoch-ms instant, for the usage-limit reset notice. */
function formatLocalClock(epochMs: number): string {
  const at = new Date(epochMs);
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * @description Buffers prompts typed while an agent session is still booting so
 * they are replayed once it's ready, instead of being dropped into the
 * "no agent running" guidance. Adapter-agnostic — covers both Claude (tmux
 * boot) and OpenCode (server boot). See {@link StartupPromptBuffer}.
 */
const startupPromptBuffer = new StartupPromptBuffer();

/**
 * @description Per-thread snapshot of the last `/sessions` listing. Audit
 * S4 / #7: Telegram caps `callback_data` at 64 bytes, so encoding a full
 * OpenCode session id (UUID-like, often > 60 chars) used to require
 * `.slice(0, 60)` which then resolved to a non-existent id on click. We
 * keep the full ids on the bot side and use `resume_<index>` as the
 * callback payload instead.
 */
const threadSessionLists = new Map<string, string[]>();

interface PendingProviderConnect {
  providerId: string;
}

/**
 * @description Per-thread `/connect` state. The next plain text message is
 * treated as the provider API key and deleted from Telegram before the adapter
 * stores it in OpenCode auth.
 */
const pendingProviderConnects = new Map<string, PendingProviderConnect>();

/**
 * @description Per-thread "session-pick" arming flag. A thread is added here
 * by `/sessions` (or its `/resume` synonym) and removed when the user picks
 * a number, cancels, or sends non-numeric text. Only while a key is in this
 * set is a bare digit reply interpreted as a session pick — so a normal "2"
 * prompt is never hijacked. Mirrors the existing `awaitingModelSelection`
 * pattern (see the `/model` numeric-selection flow).
 */
const awaitingSessionSelection = new Set<string>();

/**
 * @description Per-thread "create-new-folder" arming flag. Added when the
 * user taps the «create new folder» option in the `/bind` picker; removed
 * when the user sends the name, cancels, or runs any other command. While a
 * key is in this set the next text message is treated as the folder name to
 * create + bind. Mirrors the `awaitingSessionSelection` pattern. Stays armed
 * on an invalid name so the user can retry.
 */
const awaitingFolderName = new Set<string>();

/** Max sessions shown in a `/sessions` list (Telegram-friendly, plan S3). */
const sessionsDisplayLimit = 10;

/**
 * @description Forum-topic names that arrived via `forum_topic_created`
 * but couldn't be processed because the creator wasn't an authorised user
 * (a group admin/creator) (audit S2 / #5). We can't read a thread's title
 * later via Telegram Bot API in any portable way, so keeping the name here
 * lets the first message from an authorised user trigger fuzzy auto-bind.
 *
 * In-memory by design: this is a UX nicety, not a security boundary —
 * losing the cache on restart just means the user has to bind manually
 * once. The TTL guards against unbounded growth in a busy group where
 * non-authorised members keep creating topics.
 */
interface PendingTopicNameEntry { name: string; ts: number; }
const pendingTopicNames = new Map<string, PendingTopicNameEntry>();
const PENDING_TOPIC_NAME_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * @description In-memory `chatId → chat.title` cache for the served group.
 * Every authorised group update carries `chat.title`, so we refresh it for
 * free on each accepted message; read at thread-context-preamble build time
 * so the agent learns the group name. Not persisted — the next authorised
 * update repopulates it after a restart, and the preamble simply omits an
 * unknown group title until then.
 */
const groupTitleCache = new Map<number, string>();

/**
 * @description Per-thread marker holding the last thread-context preamble the
 * bot injected ahead of a prompt (keyed by `keyToString`). The preamble rides
 * the next prompt only when the freshly-built text differs from this marker
 * (see `checkShouldInjectPreamble`): a fresh session (marker cleared on
 * start/stop/closed), a rename (built text changes), or `/clear` (marker
 * reset) all trigger a re-inject. In-memory by design — a duplicate preamble
 * after a bot restart / session resume is acceptable (the marker isn't
 * persisted).
 */
const threadContextMarkers = new Map<string, string>();

/**
 * @description Forget the last-injected preamble for a thread so the next
 * prompt re-carries it. Called on every session lifecycle boundary (start,
 * stop, closed) and on forwarding a bare `/clear`.
 */
function clearThreadContextMarker(key: ThreadKey): void {
  threadContextMarkers.delete(keyToString(key));
}

function getThreadMessageState(key: ThreadKey): ThreadMessageState {
  const k = keyToString(key);
  let s = threadMessageStates.get(k);
  if (!s) {
    s = { lastMessageId: null, lastMessageText: null, needsNewMessage: true, typingLoaderTimer: null, statusMessageId: null, thinkingMessageId: null, thinkingFrameGeneration: 0, statusFrameGeneration: 0, livenessTimer: null, lastActivityText: null, livenessGlyphIndex: 0, wasBusy: false, workingSince: null, lastLivenessSentAt: 0, statusIdleSuppressed: false, busyOnsetArmedUntil: 0, subagentStatusMessageId: null, subagentStartedAt: null, subagentTitle: null, subagentTimer: null };
    threadMessageStates.set(k, s);
  }
  return s;
}

/**
 * @description Persist the thread's CURRENT transient status-frame ids (the
 * non-null `statusMessageId` / `thinkingMessageId` / `subagentStatusMessageId`)
 * so an UNGRACEFUL restart (crash / SIGKILL — no graceful sweep ran) can delete
 * whatever frame was on screen on the next boot (S2). The in-memory
 * `ThreadMessageState` is the live source of truth; this just keeps disk in step.
 * Debounced + fire-and-forget. Single collection point shared by the three
 * frame-id setters below so memory and disk never drift.
 */
function persistTransientFrames(key: ThreadKey): void {
  const ids = getTransientFrameIds(getThreadMessageState(key));
  state.setTransientFrames(key, ids).catch(e =>
    console.error('[transientFrames] persist failed:', e),
  );
}

/**
 * @description The three choke points for mutating a transient frame id: assign
 * the in-memory `ThreadMessageState` field AND mirror the resulting id set to the
 * persisted store (S2). Callers keep their generation-guard checks (only null
 * when the id still equals the one they created); the setter just routes the
 * same write through one place.
 */
function setStatusFrameId(key: ThreadKey, id: number | null): void {
  getThreadMessageState(key).statusMessageId = id;
  persistTransientFrames(key);
}
function setThinkingFrameId(key: ThreadKey, id: number | null): void {
  getThreadMessageState(key).thinkingMessageId = id;
  persistTransientFrames(key);
}
function setSubagentFrameId(key: ThreadKey, id: number | null): void {
  getThreadMessageState(key).subagentStatusMessageId = id;
  persistTransientFrames(key);
}

function getOutputQueueState(key: ThreadKey): OutputQueueState {
  const k = keyToString(key);
  let s = outputQueues.get(k);
  if (!s) {
    s = { pendingOutput: null, pendingIsContinuation: false, isProcessing: false, debounceTimer: null };
    outputQueues.set(k, s);
  }
  return s;
}

/**
 * @description Is real agent output currently mid-flight for this thread —
 * queued, debouncing, or actively sending? The Claude liveness loop checks this
 * to stay out of the output's way: while output owns the rolling message, the
 * activity frame must not be created/ticked/deleted (anti-thrash). Reads with
 * `.get()` so a thread that never streamed output is trivially "not streaming".
 */
function checkIsOutputStreaming(key: ThreadKey): boolean {
  // The DM draft transport streams via drafts, not the output queue, so ask it
  // too — otherwise the Claude liveness loop, blind to an active draft, inserts a
  // heartbeat status frame between prose deltas and chops the draft mid-answer.
  if (getOutputTransport().checkIsStreaming(key)) return true;
  const q = outputQueues.get(keyToString(key));
  if (!q) return false;
  return q.pendingOutput !== null || q.isProcessing || q.debounceTimer !== null;
}

function getStatusCoalesceState(key: ThreadKey): StatusCoalesceState {
  const k = keyToString(key);
  let s = statusCoalescers.get(k);
  if (!s) {
    s = { pendingText: null, inFlight: false, lastSentText: null, deferRetryTimer: null };
    statusCoalescers.set(k, s);
  }
  return s;
}

function getThinkingCoalesceState(key: ThreadKey): ThinkingCoalesceState {
  const k = keyToString(key);
  let s = thinkingCoalescers.get(k);
  if (!s) {
    s = { pendingHtml: null, inFlight: false, lastSentHtml: null, detachAfterDrain: false };
    thinkingCoalescers.set(k, s);
  }
  return s;
}

/**
 * @description Tear down a thread's thinking message + coalescer. Called on
 * every session-end / takeover path (close, stop, question) so a live
 * "☁️ thinking …" frame never lingers after the reasoning it described is gone
 * (mirrors `deleteStatusMessage` for the dedicated thinking id). Best-effort:
 * the delete is fire-and-forget; the in-memory id/coalescer are cleared
 * synchronously so a racing emit can't resurrect a stale frame.
 */
function clearThinkingMessage(key: ThreadKey): void {
  const s = getThreadMessageState(key);
  const coalescer = thinkingCoalescers.get(keyToString(key));
  if (coalescer) {
    coalescer.pendingHtml = null;
    coalescer.lastSentHtml = null;
    coalescer.detachAfterDrain = false;
  }
  // Bump UNCONDITIONALLY (even with no id tracked): a `sendThinkingFrame` create
  // may be mid-`await` with its id not yet stored. The bump tells that in-flight
  // create to DISCARD its message instead of resurrecting an orphan.
  s.thinkingFrameGeneration += 1;
  if (s.thinkingMessageId === null) return;
  const id = s.thinkingMessageId;
  setThinkingFrameId(key, null);
  deleteThreadMessage(key, id).catch(() => {});
}

/**
 * @description Drop a thread's bot-side queued-but-unsent agent output on
 * stop, so nothing coalesced *before* the stop posts *after* the "stopped"
 * confirmation (live repro: a 429 backlog let trailing outputs land seconds
 * later). Looks the existing state up with `.get()` — no lazy creation, since
 * clearing a thread that never queued anything is a no-op. The pure clear
 * logic lives in `utils/clearThreadOutputQueues` for unit testing.
 */
function clearThreadQueues(key: ThreadKey): void {
  const k = keyToString(key);
  // A teardown that clears queued output must FIRST finalize any in-flight
  // content so the agent's final answer lands instead of being discarded (DM:
  // the live draft → a permanent message; group: the coalesced-but-unsent
  // output buffer → a permanent message, S2). This is the convergence point for
  // `/quit` release, session `closed`/`stopped`, `/unbind`, and topic-delete —
  // all route through here. CRITICAL ORDER: finalize BEFORE
  // `clearThreadOutputQueues`, because the group finalize drains
  // `q.pendingOutput` and the clear would otherwise null it first (S2). Both
  // transports capture + reset their in-flight state SYNCHRONOUSLY before any
  // await, so the clear below can't race the drain. Fire-and-forget.
  void getOutputTransport().finalizeInFlight(key);
  clearThreadOutputQueues(outputQueues.get(k), statusCoalescers.get(k));
  // A new session starts with empty context — forget the last-sent outputs so
  // the identical-output backstop can't suppress a legitimate repeat across a
  // session boundary (the same convergence point that clears the other
  // per-thread relay state: /quit release, session closed/stopped, /unbind).
  identicalOutputGuard.reset(k);
}

function markNeedsNewMessage(key: ThreadKey): void {
  getThreadMessageState(key).needsNewMessage = true;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Threading helpers — gating, key extraction
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Thin Telegraf adapter over `resolveThreadKeyForMode` (the pure
 * bi-surface composition lives in `./threadRouting`, where it can be
 * unit-tested). The bot only translates `ctx` shapes into the routing module's
 * plain inputs and supplies the runtime surface config.
 */
function getThreadKey(ctx: Context): ThreadKey | null {
  const msg = ctx.message as Message | undefined;
  const cbMsg = ctx.callbackQuery?.message as Message | undefined;
  const routeInput = {
    chat: getRouteChat(ctx),
    message: msg
      ? {
          message_thread_id: 'message_thread_id' in msg ? msg.message_thread_id : undefined,
          is_topic_message: 'is_topic_message' in msg ? msg.is_topic_message : undefined,
        }
      : undefined,
    callbackQueryMessage: cbMsg
      ? {
          message_thread_id: 'message_thread_id' in cbMsg ? cbMsg.message_thread_id : undefined,
          is_topic_message: 'is_topic_message' in cbMsg ? cbMsg.is_topic_message : undefined,
        }
      : undefined,
  };
  return resolveThreadKeyForMode(routeInput, {
    mode: getChatMode(),
    ownerUserId: getOwnerUserId(),
    allowedGroupId: getAllowedGroupId() ?? NaN,
    isDmSurfaceActive: checkIsDmSurfaceActive(),
  });
}

/**
 * @description Is this thread the General topic? The General marker differs per
 * surface — `1` in the supergroup, `0` (no `message_thread_id`) in the DM — so
 * the check is per-chat (the key's surface), not a global mode.
 */
function checkIsGeneral(key: ThreadKey): boolean {
  const generalThreadId = checkIsDmKey(key) ? DM_GENERAL_THREAD_ID : GENERAL_THREAD_ID;
  return key.threadId === generalThreadId;
}

/**
 * @description Build the minimal `RouteChat` shape from a Telegraf context
 * (the `is_forum` flag isn't on every chat variant in the union).
 */
function getRouteChat(ctx: Context): { id: number; type: string; is_forum?: boolean } | undefined {
  const chat = ctx.chat;
  if (!chat) return undefined;
  return { id: chat.id, type: chat.type, is_forum: 'is_forum' in chat ? chat.is_forum : undefined };
}

/**
 * @description Auto-pairing entrypoint, invoked as the first middleware on
 * every update. No-op unless the bot is in pairing mode (no effective group
 * id and not locked by env). On the first qualifying update from an allowed
 * user in a forum supergroup it adopts that chat as the bot's group, persists
 * the id, and confirms in-chat — so the operator never looks up the `-100…`
 * id by hand. Re-pointing later is done explicitly via `/pair`.
 */
async function tryAutoPair(ctx: Context): Promise<void> {
  // Pairing adopts a forum supergroup, so it is inert only when there is NO
  // group surface — pure `dm` mode. In `both` it must still run (the group
  // surface is live); a DM update is harmless here (`resolvePairingCandidate`
  // rejects private chats), and the served chat is fixed only in `dm`.
  if (getChatMode() === 'dm') return;

  const chat = getRouteChat(ctx);

  // While unpaired, log every incoming update so the operator can see
  // exactly what reaches the bot. Without this, the three ways pairing
  // can silently fail — privacy mode (no update at all), a non-forum chat,
  // or a sender who isn't a group admin — are indistinguishable from "bot
  // is broken". Gated to pairing mode so normal operation stays quiet.
  if (!isGroupLockedByEnv && getAllowedGroupId() === null) {
    console.log(
      `[pair] incoming ${ctx.updateType} update: chat=${chat?.id} type=${chat?.type} ` +
        `is_forum=${chat?.is_forum} from=${ctx.from?.id}`,
    );
  }

  const candidate = resolvePairingCandidate({
    chat,
    currentGroupId: getAllowedGroupId(),
    isEnvLocked: isGroupLockedByEnv,
  });
  if (candidate === null) return;

  // Authority probe: only a creator/administrator of the candidate group may
  // pair the bot, so a random group the bot is added to can't hijack it.
  const userId = ctx.from?.id;
  if (!userId || !(await checkIsForumAdmin(candidate, userId))) {
    console.warn(`[pair] ignored pairing from chat ${candidate} user ${userId ?? '?'} (not a group admin)`);
    return;
  }

  effectiveGroupId = candidate;
  await state.setPairedGroupId(candidate);
  adminCache.invalidate();
  console.log(`[pair] auto-paired forum supergroup ${candidate} (persisted to state.json)`);

  const key = getThreadKey(ctx) ?? { chatId: candidate, threadId: GENERAL_THREAD_ID };
  await replyToThread(key, t('pair.success', { groupId: candidate })).catch(() => {});
}

/**
 * @description Combined access check. Returns the `ThreadKey` if the
 * context is from an authorised user (a creator/admin of the served forum
 * group) in the configured forum supergroup, else `null`. Logs (but does not
 * reply to) chats / users we don't accept so foreign chats / spam stay silent
 * (plan §13.13, D21).
 */
async function authoriseContext(ctx: Context): Promise<ThreadKey | null> {
  const userId = ctx.from?.id;
  if (!userId || !(await checkIsAllowedUser(ctx))) {
    if (ctx.chat) {
      console.warn(
        `[security] ignored update from chat ${ctx.chat.id} user ${userId ?? '?'} (not a group admin)`,
      );
    }
    return null;
  }
  const key = getThreadKey(ctx);
  if (!key) {
    if (ctx.chat) {
      const surface = checkIsDmChat(ctx) ? "the owner's DM" : 'the forum supergroup we listen to';
      console.warn(`[security] ignored update from chat ${ctx.chat.id} (not ${surface})`);
    }
    return null;
  }
  // Refresh the group-title cache from this authorised update — supergroups
  // always carry `chat.title`. Feeds the thread-context preamble (S2). Cheap,
  // idempotent, and the only place every accepted update funnels through. A
  // private chat (DM key) has no `title`, so there is nothing to cache (the
  // preamble falls back to the bot name) — skip it explicitly.
  if (!checkIsDmKey(key) && ctx.chat && 'title' in ctx.chat && ctx.chat.title) {
    groupTitleCache.set(ctx.chat.id, ctx.chat.title);
  }
  return key;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Send helpers — replyToThread + auto-track + error routing
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Central handler for failed sends.
 *
 * Delegates the classification rules to `./sendErrorClassifier` (so the
 * Telegram-400-text matching is unit-testable, plan §11 Этап 7 / R8),
 * then performs the imperative side-effects that depend on bot state.
 *
 * Categories (plan §13.10, E5):
 *   - **thread-deleted** → wipe binding + in-memory state.
 *   - **topic-closed** → preserve binding (closures are reversible),
 *     mark `closed: true`, notify in General.
 *   - **other** → log; no state mutation.
 */
async function handleSendError(key: ThreadKey, err: unknown): Promise<void> {
  const kind = classifySendError(err);

  if (kind === 'thread-deleted') {
    console.log(`[gc] thread ${keyToString(key)} not found — removing binding`);
    await state.removeBinding(key);
    clearInMemoryThreadState(key);
    return;
  }
  if (kind === 'topic-closed') {
    console.log(`[skip] thread ${keyToString(key)} is closed — binding preserved`);
    await state.setBindingClosed(key, true);
    // Notify in General so user is not silent. Use low-level send (no
    // recursion through replyToThread, which would re-enter this handler).
    // Notify General. We use the low-level send (no `replyToThread`) to
    // avoid re-entering this handler if the notification itself fails;
    // omit `message_thread_id` so the message lands in General — see the
    // `buildSendExtra` rationale for why `1` on outbound is now a 400.
    enqueueSend(key, () =>
      bot.telegram.sendMessage(
        key.chatId,
        t('error.tg.thread.closed', { key: keyToString(key) }),
      ),
    ).catch(e2 => console.error('[send] failed to notify General about TOPIC_CLOSED:', e2));
    return;
  }

  // Fallthrough: keep enough context in the log to recognise repeat
  // offenders without hauling state.json into the log line.
  if (checkIsApiError(err)) {
    console.error(
      `[send] ${keyToString(key)} ${getErrorCode(err) ?? '?'} ${getErrorDescription(err) || '(no description)'}`,
    );
  } else {
    console.error(`[send] ${keyToString(key)} unknown error:`, err);
  }
}

/**
 * @description Drop all in-memory traces of a thread.
 *
 * Used after a `forum_topic_deleted` event or a 400-thread-not-found
 * cleanup. Does NOT touch state.json bindings/agents/messages — the caller
 * already removed those. The ONE persisted thing cleared here is the pending
 * question (`clearPendingQuestion`): leaving it on disk after the binding is
 * gone would orphan an unreachable entry that boot-restore would just drop
 * anyway, so we release it eagerly to keep `state.json` clean.
 */
function clearInMemoryThreadState(key: ThreadKey): void {
  const k = keyToString(key);
  // Drop queued output AND status frame (incl. cancelling the output
  // debounce timer) BEFORE deleting the map entries — otherwise an armed
  // `debounceTimer` would survive the `outputQueues.delete` as an orphan and
  // still fire into a freshly-bound session.
  clearThreadQueues(key);
  // Clear the liveness timer BEFORE dropping the message-state entry, otherwise
  // it survives the `threadMessageStates.delete` as an orphan that fires into a
  // freshly-bound session (same reasoning as the output debounce timer above).
  stopClaudeLiveness(key);
  // Same orphan-prevention for the typing-loader timer (it lives in the
  // message-state entry too) — covers /unbind and a deleted topic.
  stopTypingLoader(key);
  threadMessageStates.delete(k);
  outputQueues.delete(k);
  clearPendingQuestion(key);
  // The thread is going away (/unbind, topic deleted) → cancel any pending
  // API-error retry silently; there's nothing left to resume into.
  cancelApiRetry(key);
  clearAuthNotice(key); // teardown → retire any pinned logged-out notice
  threadModelLists.delete(k);
  awaitingModelSelection.delete(k);
  threadSessionLists.delete(k);
  awaitingSessionSelection.delete(k);
  pendingProviderConnects.delete(k);
  awaitingFolderName.delete(k);
  pinnedStatusTextCache.delete(k);
  statusCoalescers.delete(k);
  // `clearThreadQueues` → `finalizeInFlight` above already finalized any accumulated
  // draft text (synchronously capturing it + clearing the timers); drop the now-
  // reset per-transport state so it doesn't leak across a rebind (DM: the draft map
  // entry; group: noop).
  getOutputTransport().disposeThread(key);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Pinned per-thread status banner (plan §11 Этап 7 / §20.5)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Threads currently inside a `/unbind` critical section.
 *
 * `/unbind` deletes the pinned banner and stops the agent in one logical
 * step; the adapter's synchronous `stopped` event would otherwise race the
 * teardown and re-pin a stale "idle" banner inside the dying thread. Guard
 * is keyed by serialised `ThreadKey` and held only while the handler runs.
 */
const unbindingKeys = new Set<string>();

/**
 * @description In-memory dedup for the pinned-banner edit pipeline.
 *
 * Telegram answers `400 message is not modified` when we try to edit a
 * pinned message with identical text; the call is harmless but burns a
 * token-bucket slot. Remembering the last sent text per thread skips the
 * round-trip entirely when nothing actually changed (rapid succession of
 * `started → status → output` events on a busy agent).
 *
 * In-memory, but seeded at boot from `binding.pinnedStatusText` (persisted
 * in state.json) via `getPinnedBannerSkipDecision` — so a restart's banner
 * refresh wave skips unchanged banners without burning API calls (B8).
 */
const pinnedStatusTextCache = new Map<string, string>();

/**
 * @description Per-thread lock for the pinned-banner send/edit pipeline.
 * Audit S6 / #8: `updatePinnedStatus` reads `binding.pinnedStatusMessageId`,
 * awaits several `enqueueSend` round-trips, then writes the id back.
 * Two concurrent adapter events (`started` + `status`) could both observe
 * a missing id, both send + pin, and overwrite each other → duplicate
 * stacked pins. We deliberately don't reuse `state.withLock` here: the
 * banner pipeline does multi-second network work, and holding the state
 * lock that long would stall every other persistence op on the key.
 */
const pinnedStatusLock = new KeyLock();

/**
 * @description Per-thread lock for the question pin/unpin read-modify-write
 * (`questionPinnedMessageId`). Same rationale as {@link pinnedStatusLock}: both
 * `pinThreadQuestion` and `unpinThreadQuestion` read the map, `await` an
 * `enqueueSend` round-trip, then set/delete the map — interleaving two of them
 * (e.g. an S3 repost racing the answer's unpin) could double-notify or leave a
 * phantom id that makes the NEXT question pin silently (zero notification — the
 * worst outcome for a muted topic). Holding ONE lock across both helpers
 * serialises every pin/unpin for a key.
 */
const questionPinLock = new KeyLock();

/**
 * @description Single source of truth for turning a failed Telegram send into a
 * log string: prefer the API error description, fall back to the JS message.
 * Used by every pin/unpin/banner swallow-and-log site so the extraction never
 * drifts between them.
 */
function describeSendError(e: unknown): string {
  return checkIsApiError(e) ? getErrorDescription(e) : (e instanceof Error ? e.message : String(e));
}

/**
 * @description Pin `messageId` for `key` through the rate-limit queue, swallowing
 * + logging failures (missing `can_pin_messages`, closed topic, network). Returns
 * `true` on success so the caller can keep its bookkeeping in sync with what is
 * actually pinned. Bot-owned plumbing primitive for the question pin helpers.
 */
async function pinMessageQuiet(key: ThreadKey, messageId: number, options: { disableNotification: boolean }): Promise<boolean> {
  try {
    await enqueueSend(key, () =>
      bot.telegram.pinChatMessage(key.chatId, messageId, { disable_notification: options.disableNotification }),
    );
    return true;
  } catch (e) {
    console.warn(`[question-pin] pin ${keyToString(key)} msg ${messageId} failed: ${describeSendError(e)}`);
    return false;
  }
}

/**
 * @description Unpin `messageId` for `key` through the rate-limit queue,
 * swallowing + logging failures (already-unpinned / deleted / lost permission).
 * Fire-and-forget sibling of {@link pinMessageQuiet}.
 */
async function unpinMessageQuiet(key: ThreadKey, messageId: number): Promise<void> {
  try {
    await enqueueSend(key, () =>
      bot.telegram.unpinChatMessage(key.chatId, messageId),
    );
  } catch (e) {
    console.warn(`[question-pin] unpin ${keyToString(key)} msg ${messageId} failed: ${describeSendError(e)}`);
  }
}

/**
 * @description Whether this thread's binding is eligible for a pinned
 * banner. General has no per-thread state to mirror; closed topics get
 * the banner left as-is (Telegram refuses edits in closed topics).
 */
function shouldHavePinnedStatus(key: ThreadKey): boolean {
  if (checkIsGeneral(key)) return false;
  return state.getBinding(key) !== null;
}

/**
 * @description Compute the current pinned status text for `key` from live
 * adapter + state. Returns `null` if the thread shouldn't have a banner
 * (no binding, or in the General topic).
 */
function computePinnedStatusText(key: ThreadKey): string | null {
  const binding = state.getBinding(key);
  if (!binding) return null;

  let agentLabel: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  let isActive = false;

  const agent = state.getAgent(key);
  if (agent?.name) {
    try {
      const adapter = getAdapter(agent.name);
      agentLabel = adapter.label;
      isActive = adapter.checkIsActive(key);
      model = adapter.getCurrentModel?.(key) ?? agent.model ?? null;
      effort = adapter.getEffort?.(key) ?? null;
    } catch {
      // Unknown adapter name from a stale binding — fall back to raw name
      // so the banner is still informative.
      agentLabel = agent.name;
      model = agent.model ?? null;
    }
  }

  return formatPinnedStatus({ binding, agentLabel, model, effort, isActive });
}

/**
 * @description Send-or-edit the pinned status banner for a thread.
 *
 * Idempotent — safe to call from every adapter lifecycle event. Failures
 * (missing `can_pin_messages`, closed topic, network) are logged but do
 * not surface to the user: the banner is convenience UI, not blocking UX.
 *
 * NB: pinned messages must NOT be auto-tracked into `state.messages[key]`,
 * otherwise `/clear` would delete the banner. We call `bot.telegram.*`
 * directly through `enqueueSend` to skip `replyToThread`'s tracking step.
 */
async function updatePinnedStatus(key: ThreadKey): Promise<void> {
  const k = keyToString(key);
  if (unbindingKeys.has(k)) return;
  if (!shouldHavePinnedStatus(key)) return;

  // Audit S6 / #8: serialise all banner work for a key — without this,
  // two near-simultaneous adapter events could both observe a missing
  // `pinnedStatusMessageId` and stack duplicate pins. Errors from one
  // invocation must not poison followers, so `KeyLock` swallows them
  // internally (the body's own try/catch already handles user-facing
  // outcomes).
  await pinnedStatusLock.withLock(k, async () => {
    if (unbindingKeys.has(k)) return;
    if (!shouldHavePinnedStatus(key)) return;

    const text = computePinnedStatusText(key);
    if (text === null) return;

    const binding = state.getBinding(key);
    if (!binding) return;

    // Skip the edit when nothing changed since the last send/edit. The
    // in-memory cache is empty on every restart, so fall back to the text
    // persisted in state.json — this lets the boot-time refresh wave skip
    // re-editing banners that are already current (B8) instead of spending a
    // wasted "message is not modified" 400 per binding on the chat-wide budget.
    const skipDecision = getPinnedBannerSkipDecision({
      computedText: text,
      cachedText: pinnedStatusTextCache.get(k),
      persistedText: binding.pinnedStatusText,
    });
    if (skipDecision === 'skip') return;
    if (skipDecision === 'seedAndSkip') {
      pinnedStatusTextCache.set(k, text);
      return;
    }

    const existingId = binding.pinnedStatusMessageId;

    if (existingId !== undefined) {
      try {
        await enqueueSend(key, () =>
          bot.telegram.editMessageText(key.chatId, existingId, undefined, text),
        );
        pinnedStatusTextCache.set(k, text);
        persistPinnedStatusText(key, text);
        return;
      } catch (e) {
        const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
        if (/message is not modified/i.test(desc)) {
          pinnedStatusTextCache.set(k, text);
          persistPinnedStatusText(key, text);
          return;
        }
        if (!/message to edit not found|MESSAGE_ID_INVALID|message can't be edited/i.test(desc)) {
          // Other errors — log and bail without churning state. The next
          // call will retry; we don't want to spam new banners on every
          // transient API hiccup.
          console.warn(`[pinned] edit ${k} failed: ${desc || (e instanceof Error ? e.message : e)}`);
          return;
        }
        // Pinned message was deleted out from under us — fall through to
        // send a fresh one. Clear BOTH the id and the persisted text: the
        // stale text must never suppress the edit for the NEW banner message
        // (B8). The in-memory cache is cleared too so the fresh send isn't
        // short-circuited by a leftover match.
        pinnedStatusTextCache.delete(k);
        await state.setBindingPinnedStatusMessageId(key, null).catch(() => {});
        await state.setBindingPinnedStatusText(key, null).catch(() => {});
      }
    }

    let messageId: number;
    try {
      const sent = await enqueueSend(key, () =>
        bot.telegram.sendMessage(key.chatId, text, {
          message_thread_id: key.threadId,
          disable_notification: true,
        }),
      );
      messageId = (sent as { message_id: number }).message_id;
    } catch (e) {
      await handleSendError(key, e);
      return;
    }

    try {
      await enqueueSend(key, () =>
        bot.telegram.pinChatMessage(key.chatId, messageId, {
          disable_notification: true,
        }),
      );
    } catch (e) {
      // Most common reason: bot is not admin or lacks `can_pin_messages`.
      // We still keep the message id so subsequent edits keep refreshing it
      // (so the user at least sees a fresh status line in the topic body
      // even without a pin).
      console.warn(`[pinned] pin ${k} failed: ${describeSendError(e)}`);
    }

    await state.setBindingPinnedStatusMessageId(key, messageId).catch(err =>
      console.warn(`[pinned] persist id for ${k} failed:`, err),
    );
    pinnedStatusTextCache.set(k, text);
    persistPinnedStatusText(key, text);
  });
}

/**
 * @description Fire-and-forget persist of the banner text for a thread so a
 * later restart can seed `pinnedStatusTextCache` and skip identical-banner
 * edits (B8). Mirrors the `state.setBindingPinnedStatusMessageId(...).catch`
 * pattern used for the id — the banner is convenience UI, so a failed persist
 * is logged, not surfaced.
 */
function persistPinnedStatusText(key: ThreadKey, text: string): void {
  state.setBindingPinnedStatusText(key, text).catch(err =>
    console.warn(`[pinned] persist text for ${keyToString(key)} failed:`, err),
  );
}

/**
 * @description Unpin and delete the banner for a thread; clear the cached
 * id. Called from `/unbind` before `state.removeBinding` wipes the row.
 *
 * Both Telegram calls swallow errors — if the banner is already gone or
 * the bot lost pin permissions mid-flight, the user-facing /unbind ack
 * shouldn't fail because of it.
 */
async function clearPinnedStatus(key: ThreadKey): Promise<void> {
  const k = keyToString(key);
  // Same lock as `updatePinnedStatus` so an `/unbind` mid-flight doesn't
  // race a concurrent banner refresh and leak a freshly-pinned message.
  await pinnedStatusLock.withLock(k, async () => {
    pinnedStatusTextCache.delete(k);

    const binding = state.getBinding(key);
    const existingId = binding?.pinnedStatusMessageId;
    if (existingId === undefined) return;

    try {
      await enqueueSend(key, () =>
        bot.telegram.unpinChatMessage(key.chatId, existingId),
      );
    } catch (e) {
      console.warn(`[pinned] unpin ${k} failed: ${describeSendError(e)}`);
    }
    try {
      await enqueueSend(key, () =>
        bot.telegram.deleteMessage(key.chatId, existingId),
      );
    } catch {
      // Older than 48h or already deleted — silently ignored.
    }
    await state.setBindingPinnedStatusMessageId(key, null).catch(() => {});
    // Clear the persisted text alongside the id so a future /bind in the same
    // thread can't have its first banner edit suppressed by a stale match (B8).
    await state.setBindingPinnedStatusText(key, null).catch(() => {});
  });
}

/**
 * @description Pin the pending question's message so the topic — which the
 * operator keeps muted — fires a Telegram notification (a pin pierces a muted
 * topic). Mirrors the {@link updatePinnedStatus} pin pattern: routed through
 * `enqueueSend`, errors swallowed + logged (missing `can_pin_messages`, closed
 * topic, network) — the pin is convenience UI and must never fail the question
 * flow. A DIFFERENT question already pinned for this thread is unpinned first, so
 * the topic never keeps a stale pinned question (Q1→Q2 advance, or an S3
 * re-post-to-bottom that replaced the message id).
 *
 * Notifies ONLY on the FIRST pin of a thread's pending question; every RE-pin is
 * SILENT (`disable_notification: true`) so one question = one notification. The
 * first-vs-repin signal is the in-memory map: `existingId === undefined` ⇒ nothing
 * pinned yet ⇒ first pin ⇒ notify; an `existingId` ⇒ a repin from the S3 repost /
 * Q1→Q2 advance ⇒ silent (the entry only clears on resolve via
 * {@link unpinThreadQuestion}, so it survives reposts). Unpinning is per-message-id,
 * so the banner's own (silent) pin is never disturbed.
 */
async function pinThreadQuestion(key: ThreadKey, messageId: number): Promise<void> {
  const kStr = keyToString(key);
  // Hold the lock across the whole read-modify-write (F2): re-read the map INSIDE
  // the critical section so a concurrent pin/unpin for this key can't make us
  // act on a stale `existingId` (double-notify, or a phantom id that silences
  // the next first-pin).
  await questionPinLock.withLock(kStr, async () => {
    const existingId = questionPinnedMessageId.get(kStr);
    // A pinned entry already present ⇒ this is a repin (S3 repost / Q1→Q2), which
    // must NOT re-notify — only the FIRST pin pierces the muted topic, once.
    const isRepin = existingId !== undefined;
    // Same message already pinned (and already notified) — nothing to do.
    if (existingId === messageId) return;
    // Retire a DIFFERENT previous question pin so the topic never keeps a stale one.
    if (existingId !== undefined) await unpinMessageQuiet(key, existingId);
    const pinned = await pinMessageQuiet(key, messageId, { disableNotification: isRepin });
    // Keep the map in lockstep with what is actually pinned: store on success;
    // on failure (e.g. lost `can_pin_messages` — we just unpinned any previous)
    // clear it so a later unpin doesn't chase a message we never pinned AND the
    // next pin counts as a first pin (notifies).
    if (pinned) questionPinnedMessageId.set(kStr, messageId);
    else questionPinnedMessageId.delete(kStr);
  });
}

/**
 * @description Remove the thread's pinned question once it resolves (answered /
 * cancelled / session torn down / binding left). Fire-and-forget, errors
 * swallowed. Purely map-driven under {@link questionPinLock}; the post-restart
 * OpenCode case (in-memory map lost but the message still pinned on Telegram) is
 * handled by {@link clearPendingQuestion} seeding the map from the persisted
 * `pendingQuestions` entry BEFORE calling this, so there is no cross-map timing
 * dependency.
 */
async function unpinThreadQuestion(key: ThreadKey): Promise<void> {
  const kStr = keyToString(key);
  await questionPinLock.withLock(kStr, async () => {
    const pinnedId = questionPinnedMessageId.get(kStr);
    questionPinnedMessageId.delete(kStr);
    if (pinnedId === undefined) return;
    await unpinMessageQuiet(key, pinnedId);
  });
}

/**
 * @description Send a message into a specific thread, going through the
 * per-chat rate-limit queue and auto-tracking the message id in state.json.
 *
 * This is the **only** function bot code should use to send new messages.
 * Direct `bot.telegram.sendMessage(...)` calls bypass tracking and the
 * `/clear` command will then leave orphan messages behind (plan §13.11, D19).
 *
 * Returns the message id on success, `null` on failure (the error has
 * already been logged / handled — caller doesn't need to wrap in try/catch).
 */
/**
 * `extra` is intentionally typed as a loose object so Telegraf `Markup<>`
 * values (which expose `reply_markup` but don't satisfy a string index
 * signature) and plain `{ parse_mode: 'Markdown' }` records both work.
 */
type SendExtra = Record<string, unknown> | object;

/**
 * @description Build the `extra` object for outbound `send*` calls so the
 * General topic gets NO `message_thread_id` while topical threads get one.
 *
 * Telegram historically reserved `message_thread_id == 1` for the General
 * topic on inbound updates, but on **outbound** sends `1` now returns
 * `400 Bad Request: message thread not found` in current Bot API versions
 * (confirmed against this group, 2026-05). The fix is to omit the field
 * entirely for General — the message lands in General by default.
 *
 * Our internal routing still keeps `GENERAL_THREAD_ID = 1` as the marker
 * for "this update came from / belongs to General" because incoming
 * updates may still carry `message_thread_id: 1`. Translation happens
 * only at the API boundary.
 */
function buildSendExtra(key: ThreadKey, extra: SendExtra): Record<string, unknown> {
  const base = extra as Record<string, unknown>;
  if (checkIsGeneral(key)) return { ...base };
  // Audit S20 / #36: spread `base` BEFORE `message_thread_id` so a
  // caller passing `message_thread_id: undefined` in `extra` can't
  // accidentally suppress our routing. With this order, our explicit
  // value wins regardless of what the caller passed.
  return { ...base, message_thread_id: key.threadId };
}

/**
 * @description Options for {@link replyToThread}.
 */
interface ReplyToThreadOptions {
  /**
   * Route the send OUTSIDE the global message pacer (via {@link sendUnpaced})
   * instead of the paced {@link enqueueSend}. Default `false`. Reserved for
   * user-input acknowledgements — e.g. the voice-transcript echo — that must
   * surface immediately and not queue behind the thread's streaming agent
   * output. Still 429-safe and traced; do NOT use it for ordinary agent output.
   */
  unpaced?: boolean;
}

async function replyToThread(
  key: ThreadKey,
  text: string,
  extra: SendExtra = {},
  options: ReplyToThreadOptions = {},
): Promise<number | null> {
  const sendOnce = (sendExtra: Record<string, unknown>) => {
    const send = () =>
      bot.telegram.sendMessage(
        key.chatId,
        text,
        sendExtra as Parameters<typeof bot.telegram.sendMessage>[2],
      );
    return options.unpaced ? sendUnpaced(key, send) : enqueueSend(key, send);
  };

  try {
    const sent = await sendOnce(buildSendExtra(key, extra));
    const messageId = (sent as { message_id: number }).message_id;
    await state.pushMessageId(key, messageId);
    return messageId;
  } catch (e) {
    // Markdown parse failure fallback. Several `t(...)` templates interpolate
    // user-controlled content (subdir names, branch names, error strings)
    // into Markdown body — a backtick or stray `*` inside the content
    // breaks Telegram's parser and the whole message gets dropped with a
    // 400. The right reflex is to retry WITHOUT `parse_mode` so the user
    // sees raw text instead of silence (review of the live "wrote 3 times,
    // bot silent" repro). Logged for follow-up so we still find and escape
    // the culprit at source.
    const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
    const hasParseMode =
      typeof (extra as Record<string, unknown>).parse_mode === 'string';
    if (hasParseMode && /can't parse entities/i.test(desc)) {
      console.warn(
        `[send] ${keyToString(key)} markdown parse failed (${desc}); retrying as plain text`,
      );
      const plainExtra = { ...(extra as Record<string, unknown>) };
      delete plainExtra.parse_mode;
      try {
        const sent = await sendOnce(buildSendExtra(key, plainExtra));
        const messageId = (sent as { message_id: number }).message_id;
        await state.pushMessageId(key, messageId);
        return messageId;
      } catch (e2) {
        await handleSendError(key, e2);
        return null;
      }
    }

    // A double-429 (rate-limited even after withRateLimitRetry's single
    // retry-after wait) surfaces as a RateLimitedError. The global 1/2s send
    // pacer (S1) makes a sustained 429 essentially impossible, so we no longer
    // re-arm a bounded redelivery (its late re-send was the OUT-OF-ORDER cause
    // the user reported) — the rare 429 is just logged via handleSendError.
    await handleSendError(key, e);
    return null;
  }
}

/**
 * @description Edit an existing assistant message in the thread.
 *
 * Returns `true` on success, `false` if the edit failed for any reason —
 * caller decides whether to fall back to a new `replyToThread`. We don't
 * track edits as new ids (the original was already tracked).
 */
async function editThreadMessage(
  key: ThreadKey,
  messageId: number,
  text: string,
  extra: SendExtra = {},
): Promise<boolean> {
  const editOnce = (editExtra: Record<string, unknown>) =>
    enqueueSend(key, () =>
      bot.telegram.editMessageText(
        key.chatId, messageId, undefined, text,
        editExtra as Parameters<typeof bot.telegram.editMessageText>[4],
      ),
    );

  try {
    await editOnce(extra as Record<string, unknown>);
    return true;
  } catch (e) {
    const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
    if (/message is not modified/i.test(desc)) return true; // benign
    if (
      /thread not found|TOPIC_CLOSED|topic is closed/i.test(desc)
    ) {
      await handleSendError(key, e);
      return false;
    }
    // Symmetric markdown-parse-fail fallback to `replyToThread`. See the
    // long comment there — same rationale: prefer a plain-text edit over
    // a silent drop.
    const hasParseMode =
      typeof (extra as Record<string, unknown>).parse_mode === 'string';
    if (hasParseMode && /can't parse entities/i.test(desc)) {
      console.warn(
        `[edit] ${keyToString(key)}#${messageId} markdown parse failed (${desc}); retrying as plain text`,
      );
      const plainExtra = { ...(extra as Record<string, unknown>) };
      delete plainExtra.parse_mode;
      try {
        await editOnce(plainExtra);
        return true;
      } catch (e2) {
        const desc2 = checkIsApiError(e2) ? getErrorDescription(e2) : '';
        if (/message is not modified/i.test(desc2)) return true;
        console.error(`[edit] ${keyToString(key)}#${messageId} retry failed:`, desc2 || e2);
        return false;
      }
    }
    console.error(`[edit] ${keyToString(key)}#${messageId}:`, desc || e);
    return false;
  }
}

async function deleteThreadMessage(
  key: ThreadKey,
  messageId: number,
): Promise<void> {
  try {
    await enqueueSend(key, () => bot.telegram.deleteMessage(key.chatId, messageId));
  } catch {
    /* messages older than 48h or already deleted — silently ignore */
  }
}

/**
 * @description `sendChatAction('typing')` in a thread. Best-effort; we
 * don't fail the caller if the API rejects it (e.g. action briefly not
 * supported for forum threads on older clients).
 *
 * Sent via {@link sendUnpaced}, NOT the paced {@link enqueueSend}: the typing
 * action is not a Telegram message and is not subject to the flood limit, yet
 * at one tick / thread / few seconds it used to eat ~60% of the global send
 * budget and push real message sends (voice echoes, acks) minutes behind. It
 * stays 429-safe and traced (both live at the `callApi` chokepoint), it just no
 * longer takes a pacer permit or queues behind the thread's other sends.
 */
async function sendThreadTypingIndicator(key: ThreadKey): Promise<void> {
  try {
    await sendUnpaced(key, () =>
      bot.telegram.sendChatAction(
        key.chatId,
        'typing',
        // Omit thread_id for General; see buildSendExtra docs.
        checkIsGeneral(key) ? undefined : { message_thread_id: key.threadId },
      ),
    );
  } catch (e) {
    console.log(`[typing] ${keyToString(key)} failed:`, e instanceof Error ? e.message : e);
  }
}

/** Whether the thread's adapter is still working (its optional `checkIsBusy`). */
function checkIsAdapterBusy(key: ThreadKey): boolean {
  return getThreadAdapter(key).checkIsBusy?.(key) === true;
}

/**
 * @description S3 — should the native typing state keep showing for `key`? True
 * while output is mid-flight OR the agent is still working. The pure rule lives
 * in `utils/typingActive`; this wraps it with the two live readings.
 */
function checkShouldKeepTyping(key: ThreadKey): boolean {
  return checkShouldKeepTypingDecision({
    isOutputStreaming: checkIsOutputStreaming(key),
    isAdapterBusy: checkIsAdapterBusy(key),
  });
}

/**
 * @description Start the sustained "agent is working" loader for `key`: fire the
 * native typing indicator NOW, then keep re-firing it every
 * {@link typingLoaderRefreshMs} (Telegram's `typing` action self-expires). This
 * is the ONLY loader — it replaced the old `⏳` placeholder message. Idempotent:
 * an already-running loader is cleared first so a second start can't leave two
 * timers.
 *
 * S3: the loader is a PERSISTENT state — each tick keeps firing `typing` while
 * {@link checkShouldKeepTyping} holds (output streaming OR agent busy) and
 * self-stops once the topic is truly drained + idle. It is NOT cleared on the
 * first output any more; hard teardown paths (session end / question UI / unbind)
 * still call {@link stopTypingLoader} directly.
 */
function startTypingLoader(key: ThreadKey): void {
  const s = getThreadMessageState(key);
  if (s.typingLoaderTimer) clearInterval(s.typingLoaderTimer);
  sendThreadTypingIndicator(key).catch(() => {});
  s.typingLoaderTimer = setInterval(() => {
    if (!checkShouldKeepTyping(key)) {
      stopTypingLoader(key);
      return;
    }
    sendThreadTypingIndicator(key).catch(() => {});
  }, typingLoaderRefreshMs);
  // Don't keep the event loop alive just for a loader (mirrors the liveness timer).
  s.typingLoaderTimer.unref?.();
}

/**
 * @description Stop the typing loader for `key` (clear the re-fire timer). The
 * typing indicator itself self-expires within a few seconds, so there is nothing
 * to delete — just stop refreshing it. Idempotent (no-op when no loader runs).
 */
function stopTypingLoader(key: ThreadKey): void {
  const s = getThreadMessageState(key);
  if (s.typingLoaderTimer) {
    clearInterval(s.typingLoaderTimer);
    s.typingLoaderTimer = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Output rendering — split, escape, queued edits
// ═══════════════════════════════════════════════════════════════════════════════


function escapeMarkdownChars(text: string): string {
  return text
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/`/g, '\\`');
}

// Audit S13 / #29: hoisted to module scope so `escapeMarkdown` doesn't
// recompile the regex on every output chunk. `g`-flag regexes are stateful
// (`lastIndex`), so we explicitly reset before each use.
const ESCAPE_BOLD_REGEX = /\*([^*\n]+)\*/g;

/**
 * @description Best-effort escape that preserves existing `*bold*` runs
 * while escaping incidental Markdown chars elsewhere. Same heuristic as
 * the legacy bot — Telegram's classic Markdown is loose enough that this
 * holds for the agent output we render.
 */
function escapeMarkdown(text: string): string {
  ESCAPE_BOLD_REGEX.lastIndex = 0;
  const boldMatches: Array<{ start: number; end: number; content: string }> = [];

  let match;
  while ((match = ESCAPE_BOLD_REGEX.exec(text)) !== null) {
    boldMatches.push({
      start: match.index,
      end: match.index + match[0].length,
      content: match[1],
    });
  }

  let result = '';
  let lastIndex = 0;
  for (const m of boldMatches) {
    const before = text.slice(lastIndex, m.start);
    result += escapeMarkdownChars(before);
    const escapedContent = m.content.replace(/_/g, '\\_').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    result += `*${escapedContent}*`;
    lastIndex = m.end;
  }
  result += escapeMarkdownChars(text.slice(lastIndex));
  return result;
}

/**
 * @description Queue an output text for a thread with debounce.
 *
 * Multiple `output` events from the adapter are coalesced into one pending
 * buffer (see {@link appendPendingOutput}), not overwritten — every emitted
 * chunk reaches Telegram. A continuation tail concatenates as-is (it may be
 * cut mid-word); a standalone output joins the buffer with `\n`. The first
 * batch's `isContinuation` is recorded so the flush knows whether the buffer
 * extends the last sent message or starts a new one. During a 429 cooldown
 * the delay stretches so we don't keep hammering the API.
 */
/**
 * Audit S13 / #30: extracted from two near-identical ternaries; lengthens
 * the debounce window during a 429 cooldown so we don't keep hammering
 * Telegram while it's already throttling us. Now a thin wrapper over the pure
 * {@link getOutputFlushTiming} — used by the re-trigger timer (always non-final,
 * so it never returns `'now'`).
 */
function getOutputDelay(chatId: number): number {
  const normalDebounceMs = getOutputDebounceMs();
  const timing = getOutputFlushTiming({
    isFinal: false,
    isRateLimited: checkIsRateLimited(chatId),
    normalDebounceMs,
    // S3: while throttled, scale the debounce to the live remaining cooldown so
    // a long 429 batches into one larger edit instead of a backlog of tiny ones.
    remainingCooldownMs: getRateLimitRemainingMs(chatId),
  });
  // Non-final input can only yield a numeric delay, never `'now'`.
  return timing === 'now' ? normalDebounceMs : timing;
}

/**
 * @param isFinal True when this is the turn's last frame (the OpenCode session
 *   went idle). The frame is appended exactly like any other (continuation
 *   semantics unchanged), but instead of waiting out the possibly-429-stretched
 *   debounce it is flushed immediately so the turn never looks hung behind a
 *   cooldown.
 */
function queueOutput(
  key: ThreadKey,
  output: string,
  isContinuation = false,
  isFinal = false,
  isComplete = false,
  startsNewParagraph = false,
): void {
  const q = getOutputQueueState(key);
  // The continuation flag of the FIRST batch in a fresh buffer decides whether
  // the whole flush extends the last sent message; later batches only append.
  if (q.pendingOutput === null) q.pendingIsContinuation = isContinuation;
  q.pendingOutput = appendPendingOutput(q.pendingOutput, output, isContinuation, startsNewParagraph);
  // `isFinal` / `isComplete` still drive the immediate-flush timing below (a
  // finished turn must not wait out the debounce) — they no longer mark the
  // buffer for redelivery (retired with the global send pacer, S4).
  if (q.debounceTimer) clearTimeout(q.debounceTimer);

  const timing = getOutputFlushTiming({
    // A complete one-shot flushes immediately like a final frame — ready content
    // must not wait out the (dm-stretched) debounce.
    isFinal: isFinal || isComplete,
    isRateLimited: checkIsRateLimited(key.chatId),
    normalDebounceMs: getOutputDebounceMs(),
    // S3: scale the in-cooldown debounce to the live remaining cooldown.
    remainingCooldownMs: getRateLimitRemainingMs(key.chatId),
  });
  if (timing === 'now') {
    // Final frame: flush immediately. `processOutputQueue` already guards
    // `isProcessing`, so this is idempotent if a flush is mid-flight (the
    // pending frame will be picked up by the re-trigger timer it arms).
    void processOutputQueue(key);
    return;
  }
  q.debounceTimer = setTimeout(() => {
    q.debounceTimer = null;
    processOutputQueue(key);
  }, timing);
}

async function processOutputQueue(key: ThreadKey): Promise<void> {
  const q = getOutputQueueState(key);
  if (q.isProcessing || !q.pendingOutput) return;
  q.isProcessing = true;
  try {
    const out = q.pendingOutput;
    const isContinuation = q.pendingIsContinuation;
    q.pendingOutput = null;
    const { unsentRemainder } = await sendOutputImmediate(key, out, isContinuation);
    // No silent drop: a chunk dropped on a 429 after the retry-after wait comes
    // back as `unsentRemainder`. Put it BACK at the FRONT of the buffer (it is
    // older than anything that arrived during the await) so the re-trigger flush
    // below retries it — never lost. Landed chunks are excluded by
    // `getUnsentRemainder`, so this never re-sends what already reached Telegram.
    // The remainder restarts a fresh message (its predecessors landed / edited in
    // place already), so it is NOT a continuation.
    if (unsentRemainder) {
      q.pendingOutput =
        q.pendingOutput === null
          ? unsentRemainder
          : appendPendingOutput(unsentRemainder, q.pendingOutput, false);
      q.pendingIsContinuation = false;
    }
  } finally {
    q.isProcessing = false;
    if (q.pendingOutput) {
      // Audit S13 / #30: the re-trigger `setTimeout` used to be a bare
      // call whose handle was never stored. A `queueOutput` call between
      // here and the timer firing would `clearTimeout(null)` and
      // schedule a duplicate timer, leaving one orphan callback alive.
      // Routing through `queueOutput`-equivalent code keeps `q.debounceTimer`
      // authoritative.
      if (q.debounceTimer) clearTimeout(q.debounceTimer);
      q.debounceTimer = setTimeout(() => {
        q.debounceTimer = null;
        processOutputQueue(key);
      }, getOutputDelay(key.chatId));
    }
  }
}

/**
 * @description Group-path `finalizeInFlight`: reconcile the thread's
 * coalesced-but-unsent output against what actually landed, and force-send the
 * remainder so the agent's FINAL answer is never discarded on teardown (S2).
 *
 * Today the group output queue coalesces into `q.pendingOutput` and the
 * (possibly 429-stretched) debounce flushes it later; a teardown
 * (`idle`/`isFinal` → `handleAgentStopped`, `/new`, `/quit`, `/unbind`,
 * topic-delete) runs `clearThreadOutputQueues` which DISCARDS that buffer — so
 * under a sustained 429 the settled final answer could vanish with only a
 * `console.error`. This drains the buffer FIRST.
 *
 * Captures + nulls the buffer SYNCHRONOUSLY before its await, so the
 * immediately-following `clearThreadOutputQueues` finds nothing to discard and
 * the drain is never double-sent (mirrors `processOutputQueue`'s snapshot
 * discipline + the DM `finalizeDraft` reset-before-await). Idempotent + runs
 * exactly once per turn: an empty buffer (a fully-delivered turn) is a no-op,
 * so no duplicate post. The drain just sends the remainder once; the global 1/2s
 * send pacer (S1) makes a 429 at this point essentially impossible.
 */
async function finalizeGroupOutput(key: ThreadKey): Promise<void> {
  const q = outputQueues.get(keyToString(key));
  if (!q) return;
  const plan = getGroupFinalizePlan(q);
  if (plan.action === 'noop') return; // fully delivered → no-op, no dupe.
  // Snapshot is captured by the plan; null the buffer SYNCHRONOUSLY before the
  // await so the immediately-following clear / a concurrent flush can't re-send it.
  q.pendingOutput = null;
  if (q.debounceTimer) {
    clearTimeout(q.debounceTimer);
    q.debounceTimer = null;
  }
  const { unsentRemainder } = await sendOutputImmediate(key, plan.text, plan.isContinuation);
  // A remainder that still 429'd at teardown is dropped (the buffer is being
  // torn down anyway — unchanged from the pre-S2 discard). Do NOT re-queue: the
  // queue is about to be cleared, and re-queuing would race that clear. At 1/2s
  // global pacing a 429 here is essentially impossible.
  if (unsentRemainder) {
    console.warn(`[send] ${keyToString(key)} finalize remainder 429'd and was dropped at teardown`);
  }
}

/**
 * @description Render `output` as the agent's permanent message in a thread.
 *
 * Append semantics for continuations: when `isContinuation` is true and the
 * last message is still editable, the flush re-renders `lastMessageText +
 * output` and edits that message in place — the one message GROWS as the
 * streamed reply arrives, spilling into fresh messages once it outgrows the
 * Telegram cap. The pre-render append base lives in `msgState.lastMessageText`.
 *
 * Fresh outputs ALWAYS send a new message — never edit. The old edit-in-place
 * for fresh outputs was the data-loss bug: each interim tail replaced the whole
 * previous text on the same message id, so the user could read only the last
 * tail. Editing is now reserved for explicit continuations of the SAME reply.
 *
 * On Markdown rejection by Telegram we fall back to plain text (`parse_mode`
 * unset) — the message lands either way. If the in-place edit fails (message
 * deleted / API hiccup) we send every chunk fresh so the full combined text
 * still reaches the user.
 */
async function sendOutputImmediate(
  key: ThreadKey,
  output: string,
  isContinuation = false,
): Promise<{ unsentRemainder: string | null }> {
  // The typing loader is stopped upstream in `handleAgentOutput` (the shared
  // onOutput entry for BOTH transports), so it's not repeated here.
  await deleteStatusMessage(key);

  const msgState = getThreadMessageState(key);
  const { chunks: planChunks, shouldEditFirstChunk } = getOutputFlushPlan({
    output,
    isContinuation,
    needsNewMessage: msgState.needsNewMessage,
    lastMessageId: msgState.lastMessageId,
    lastMessageText: msgState.lastMessageText,
  });
  // S2b: when this flush starts FRESH (no in-place edit) and its backlog is ≥3
  // messages, glue them into the fewest \n\n-joined messages so a burst drains in
  // one send, not a per-2s trickle behind the global pacer. The edit-in-place
  // (continuation) path is left untouched — chunks[0] must still match the
  // message being edited. Glue uses the same rendered-length measure the plan
  // split with, so a glued block never exceeds Telegram's cap.
  const chunks = shouldEditFirstChunk
    ? planChunks
    : glueBacklogFrames(planChunks, MAX_MESSAGE_LEN, (chunk) => renderAgentHtml(chunk).length);

  let startIndex = 0;
  if (shouldEditFirstChunk) {
    const editedOk =
      chunks[0] === msgState.lastMessageText ||
      (await editThreadMessage(key, msgState.lastMessageId!, renderAgentHtml(chunks[0]), { parse_mode: 'HTML' }));
    if (editedOk) {
      msgState.lastMessageText = chunks[0];
      startIndex = 1;
    }
    // Edit failed (message deleted / API hiccup): fall through and send every
    // chunk fresh — the full combined text still reaches the user.
  }

  // No silent drop: track how many chunks actually landed, counting from the
  // FRONT. `startIndex` already covers a successful in-place edit of chunks[0];
  // when that edit failed it is 0 and every chunk re-sends fresh below. A
  // `replyChunkWithFallback` that returns null means the chunk was dropped on a
  // 429 after the retry-after wait — STOP the run (the cooldown would drop the
  // rest of this synchronous flush too) and report the un-sent remainder so the
  // caller re-enqueues it for the next flush.
  let sentCount = startIndex;
  for (let i = startIndex; i < chunks.length; i++) {
    const id = await replyChunkWithFallback(key, renderAgentHtml(chunks[i]), chunks[i]);
    if (!id) break;
    msgState.lastMessageId = id;
    msgState.lastMessageText = chunks[i];
    msgState.needsNewMessage = false;
    sentCount = i + 1;
  }

  // S3: output just landed below any pending question — bring the question back
  // to the bottom (debounced; no-op when no question is pending).
  onThreadActivityWhileQuestionPending(key);

  return { unsentRemainder: getUnsentRemainder(chunks, sentCount) };
}

/**
 * @description Send a chunk as HTML first; if Telegram rejects the entities,
 * fall back to plain text so the message reaches the user either way.
 */
async function replyChunkWithFallback(
  key: ThreadKey,
  renderedHtml: string,
  plainFallback: string,
): Promise<number | null> {
  const id = await replyToThread(key, renderedHtml, { parse_mode: 'HTML' });
  if (id) return id;
  return replyToThread(key, plainFallback, {});
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Shared output send primitives + the DM draft channel's `sendMessageDraft` call
//
//  The DM live-draft MANAGER moved to `output/dmOutputTransport.ts` (the
//  OutputTransport seam). `callSendMessageDraft` and `sendAgentChunks` stay here
//  because they are SHARED: `sendAgentChunks` lands permanent messages for the
//  group path / the `isComplete` one-shot too, and the draft channel's untyped
//  `callApi` view is injected into the DM transport. Both are passed in via the
//  factory deps at boot.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `sendMessageDraft` is a real Bot API method but is absent from this telegraf /
 * typegram version's `Telegram` type, so `callApi('sendMessageDraft', …)` won't
 * typecheck against the `M extends keyof Telegram` signature. We narrow a
 * локализованный untyped view of `callApi` here (the `deleteMessages` precedent
 * at the top of this file is typed; this one genuinely isn't in the vendored
 * types). Payload is the locked shape from the P0/P0.5 live probes.
 */
type SendMessageDraftCall = (
  method: 'sendMessageDraft',
  payload: Record<string, unknown>,
) => Promise<unknown>;

const callSendMessageDraft = bot.telegram.callApi.bind(
  bot.telegram,
) as unknown as SendMessageDraftCall;

/**
 * @description Send each already-split chunk as a permanent message, tracking the
 * last one as the thread's `lastMessageId`/`lastMessageText` so a later
 * continuation can append onto it. The shared send loop behind the DM finalize /
 * overflow-spill / one-shot paths.
 */
async function sendAgentChunks(key: ThreadKey, chunks: string[]): Promise<void> {
  const msgState = getThreadMessageState(key);
  // S2b: collapse a ≥3-message backlog into the fewest \n\n-joined messages so a
  // burst (DM finalize / overflow-spill) lands in one send, not a trickle.
  const toSend = glueBacklogFrames(chunks, MAX_MESSAGE_LEN, (chunk) => renderAgentHtml(chunk).length);
  for (const chunk of toSend) {
    const id = await replyChunkWithFallback(key, renderAgentHtml(chunk), chunk);
    if (id) {
      msgState.lastMessageId = id;
      msgState.lastMessageText = chunk;
      msgState.needsNewMessage = false;
    }
  }
}

async function deleteStatusMessage(key: ThreadKey): Promise<void> {
  const s = getThreadMessageState(key);
  // The next status frame will create a *new* message, so the dedup baseline
  // is stale — clear it, otherwise an identical-text frame after a delete
  // would be wrongly skipped and the fresh status message never appear.
  getStatusCoalesceState(key).lastSentText = null;
  // Bump UNCONDITIONALLY (even when no id is tracked): a `sendStatusFrame`
  // create may be mid-`await` with its id not yet stored. The bump signals that
  // in-flight create to DISCARD its message instead of storing it as an orphan
  // (`getStatusFrameStoreDecision`). Without this, a delete that races a still
  // null `statusMessageId` removes nothing and the create resurrects a frame
  // that idle/output already meant to clear → the leftover spinner of bug #11.
  s.statusFrameGeneration += 1;
  if (s.statusMessageId === null) return;
  const id = s.statusMessageId;
  setStatusFrameId(key, null);
  await deleteThreadMessage(key, id);
}

/**
 * Internal bound (ms) on the graceful-shutdown transient-frame sweep. Well under
 * the 10s shutdown watchdog so a slow Telegram API can't eat into the budget
 * `state.flush()` needs to land the last state to disk.
 */
const shutdownFrameSweepMs = 1500;

/**
 * @description Best-effort delete of every TRANSIENT status frame still on
 * screen at graceful shutdown — the "✽ working…" liveness frame, the live
 * thinking indicator, and the dedicated sub-agent status. Their ids live ONLY in
 * volatile in-memory {@link ThreadMessageState}, so a restart that doesn't clean
 * them up orphans the messages forever in the topic (the reported incident:
 * ~25 hot reloads left "✽ работаю…" frames stuck). Iterates every tracked
 * thread, collects its non-null frame ids ({@link getTransientFrameIds}), fires
 * the deletes in parallel, and nulls the in-memory ids so a racing per-thread
 * tick can't re-edit a just-deleted message.
 *
 * Wired into {@link gracefulShutdown} as `clearTransientFrames`: runs AFTER
 * `cleanupTimers()` (no interval re-creates a frame mid-sweep) and BEFORE
 * `bot.stop()` (the Telegram client must still send the deletes). Self-bounded by
 * {@link shutdownFrameSweepMs} — a slow API must not starve `state.flush()`.
 */
async function sweepTransientFramesOnShutdown(): Promise<void> {
  const deletes: Promise<unknown>[] = [];
  for (const [keyStr, msgState] of threadMessageStates) {
    const ids = getTransientFrameIds(msgState);
    if (ids.length === 0) continue;
    let key: ThreadKey;
    try {
      key = keyFromString(keyStr);
    } catch {
      continue;
    }
    for (const id of ids) {
      deletes.push(bot.telegram.deleteMessage(key.chatId, id).catch(() => {}));
    }
    // Null the in-memory ids so a racing unref'd liveness/sub-agent tick can't
    // re-edit (or re-track) a message we're deleting.
    msgState.statusMessageId = null;
    msgState.thinkingMessageId = null;
    msgState.subagentStatusMessageId = null;
    // Clear the S2 persisted set too, so the next boot's reconciliation finds
    // nothing to redo after a graceful exit.
    state.setTransientFrames(key, []).catch(() => {});
  }
  if (deletes.length === 0) return;
  await Promise.race([
    Promise.allSettled(deletes),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, shutdownFrameSweepMs);
      timer.unref?.();
    }),
  ]);
}

/**
 * Hard bound (ms) on the whole shutdown output flush (finalize + FIFO drain):
 * the drain budget plus headroom for the finalize sends themselves. Under the
 * 10s shutdown watchdog so the later steps (frame sweep, update drain,
 * `state.flush()`) keep their budgets.
 */
const shutdownOutputFlushMaxMs = shutdownDrainMaxMs + 1000;

/**
 * @description Flush every thread's not-yet-delivered agent output at graceful
 * shutdown, so a hot-reload restart can't swallow it (live 2026-07-05, topic
 * 434: already-emitted answer chunks died in the send pipeline with the
 * process and were never re-sent). Two buffers drain, in order:
 *
 *  [A] per-thread COALESCE state — the group/baseline `q.pendingOutput`
 *      buffers (enumerated here from {@link outputQueues}) and the DM
 *      transport's active drafts (enumerated via `getInFlightThreadKeys`) —
 *      each finalized to a permanent message via the transport's
 *      `finalizeInFlight`;
 *  [B] the per-thread send FIFOs already parked on the global pacer — drained
 *      by `drainPendingSends` after `enterShutdownDrain()` flips the pacer to
 *      immediate release (at 1 send/2s a 5-message backlog alone outlives any
 *      sane shutdown window; every drained send keeps `withRateLimitRetry`).
 *
 * `enterShutdownDrain()` is flipped BEFORE the finalizes: their awaits resolve
 * only when their sends land, and with the pacer still spacing each queued
 * send would wait out its 2s slot and bust the bound. Still strictly inside
 * the shutdown sequence — live operation never runs unpaced.
 *
 * Wired into {@link gracefulShutdown} as `finalizePendingOutput`: runs AFTER
 * `cleanupTimers()` and BEFORE `clearTransientFrames` / `bot.stop()` (content
 * lands first, then transient frames are deleted, all while the Telegram
 * client is alive). Self-bounded by {@link shutdownOutputFlushMaxMs} — the
 * outer watchdog stays the backstop.
 */
async function finalizePendingOutputOnShutdown(): Promise<void> {
  const drainDeadlineMs = Date.now() + shutdownDrainMaxMs;
  let flushedCount = 0;
  const flushWork = (async (): Promise<ShutdownDrainVerdict> => {
    enterShutdownDrain();
    const transport = getOutputTransport();
    // [A] union of threads with pending coalesced output: the bot-owned output
    // queues + the transport-owned DM drafts (deduped by serialised key).
    const pendingKeys = new Map<string, ThreadKey>();
    for (const [keyStr, q] of outputQueues) {
      if (q.pendingOutput === null) continue;
      try {
        pendingKeys.set(keyStr, keyFromString(keyStr));
      } catch {
        /* malformed key — nothing to flush for it */
      }
    }
    for (const key of transport.getInFlightThreadKeys()) {
      pendingKeys.set(keyToString(key), key);
    }
    flushedCount = pendingKeys.size;
    await Promise.allSettled(
      [...pendingKeys.values()].map((key) => transport.finalizeInFlight(key)),
    );
    // A DM-surface thread on a non-draft adapter (e.g. terminal) coalesces via
    // the group `queueOutput` path, but its transport finalize handled only the
    // draft — drain any such leftover buffer directly. Group keys were already
    // drained above (their finalize nulls `pendingOutput` synchronously), so
    // this is a no-op for them.
    const leftoverDrains: Promise<void>[] = [];
    for (const [keyStr, q] of outputQueues) {
      if (q.pendingOutput === null) continue;
      try {
        leftoverDrains.push(finalizeGroupOutput(keyFromString(keyStr)));
      } catch {
        /* malformed key */
      }
    }
    await Promise.allSettled(leftoverDrains);
    // [B] wait for the released FIFOs to empty, bounded by what is left of the
    // shared drain budget.
    return drainPendingSends(Math.max(drainDeadlineMs - Date.now(), 0));
  })();
  const verdict = await Promise.race([
    flushWork,
    new Promise<ShutdownDrainVerdict>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), shutdownOutputFlushMaxMs);
      timer.unref?.();
    }),
  ]);
  console.log(`[shutdown] flushed ${flushedCount} threads, ${verdict}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Voice download + transcribe
// ═══════════════════════════════════════════════════════════════════════════════

// Voice download timeout is shared with the transcription request below so a
// single constant governs the whole voice path. `downloadFile` itself (retries,
// redirects, warm-agent reuse) lives in `./utils/download` so it stays
// side-effect-free and unit-testable.
const DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * Bot API download cap in MB, surfaced in the `file.too_big` reply. Derived
 * from `telegramFileDownloadCapBytes` so the user-facing number and the
 * pre-download size check can never drift apart.
 */
const FILE_DOWNLOAD_CAP_MB = Math.floor(telegramFileDownloadCapBytes / (1024 * 1024));

/**
 * Quiet period after the LAST album item before the batched album prompt is
 * forwarded. Telegram delivers an album's messages in a sub-second burst, so a
 * couple of seconds comfortably catches every item (album max is 10) without a
 * user-perceptible lag before the agent starts.
 */
const ALBUM_DEBOUNCE_MS = 2_000;

type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

async function transcribeAudio(filePath: string, retryCount = 0): Promise<TranscribeResult> {
  const apiKey = ENV.groqApiKey || ENV.openaiApiKey;
  const isGroq = !!ENV.groqApiKey;
  if (!apiKey) return { ok: false, error: 'no api key configured' };

  // Detect a 0-byte download up-front: previously this would still be sent
  // to Whisper, which replies 400 with a generic "file is empty" body that
  // the old error path swallowed silently. Failing here gives the operator
  // a concrete cause (download produced no bytes) without the round-trip.
  let fileSize = 0;
  try {
    fileSize = (await fsp.stat(filePath)).size;
  } catch (e) {
    return { ok: false, error: `stat failed: ${e instanceof Error ? e.message : e}` };
  }
  if (fileSize === 0) return { ok: false, error: 'downloaded audio is empty' };

  const FormData = (await import('form-data')).default;
  const form = new FormData();
  // Explicit filename + content-type: form-data's auto-detection from the
  // ReadStream's path usually works, but some intermediaries strip
  // path-based hints. Setting both makes the multipart upload deterministic.
  form.append('file', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: 'audio/ogg',
  });
  form.append('model', isGroq ? 'whisper-large-v3' : 'whisper-1');

  const hostname = isGroq ? 'api.groq.com' : 'api.openai.com';
  const apiPath = isGroq ? '/openai/v1/audio/transcriptions' : '/v1/audio/transcriptions';

  return new Promise((resolve) => {
    // Audit S14 / #33: install the error handler before piping the form
    // so a socket error during the initial handshake can't escape. Also
    // add a hard timeout so a hung Groq/OpenAI response can't block the
    // voice-message path indefinitely.
    const req = https.request({
      hostname, path: apiPath, method: 'POST',
      headers: { ...form.getHeaders(), 'Authorization': `Bearer ${apiKey}` },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', async () => {
        const status = res.statusCode ?? 0;
        if (status === 429) {
          const retryAfter = parseInt(res.headers['retry-after'] as string) || 5;
          if (retryCount < 2) {
            await new Promise(r => setTimeout(r, retryAfter * 1000));
            resolve(await transcribeAudio(filePath, retryCount + 1));
            return;
          }
          console.warn(`[transcribe] rate-limited after ${retryCount + 1} attempts`);
          resolve({ ok: false, error: 'rate limited (429), gave up after retries' });
          return;
        }
        if (status < 200 || status >= 300) {
          const bodyPreview = data.slice(0, 500);
          console.warn(
            `[transcribe] ${isGroq ? 'groq' : 'openai'} returned HTTP ${status}; body: ${bodyPreview}`,
          );
          let apiMessage = bodyPreview;
          try {
            const errJson = JSON.parse(data);
            apiMessage = errJson?.error?.message ?? errJson?.error ?? bodyPreview;
          } catch { /* keep raw preview */ }
          resolve({ ok: false, error: `HTTP ${status}: ${apiMessage}` });
          return;
        }
        try {
          const json = JSON.parse(data);
          if (typeof json.text === 'string' && json.text.length > 0) {
            resolve({ ok: true, text: json.text });
            return;
          }
          console.warn(`[transcribe] 200 OK but no .text in body: ${data.slice(0, 500)}`);
          resolve({ ok: false, error: 'transcription returned empty text' });
        } catch (e) {
          console.warn(`[transcribe] failed to parse response: ${e instanceof Error ? e.message : e}; body: ${data.slice(0, 500)}`);
          resolve({ ok: false, error: 'malformed response from Whisper API' });
        }
      });
    });
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error('transcription timed out'));
    });
    req.on('error', (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[transcribe] request failed:', msg);
      resolve({ ok: false, error: msg });
    });
    form.pipe(req);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Adapter lifecycle helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Resolve the working directory for an adapter session in
 * this thread, or `null` when the thread has no binding.
 *
 * The bind IS the agent's working folder — an agent must never run outside it,
 * so there is deliberately NO fallback to `WORK_ROOT` itself. The old Этап-3
 * "smoke-test against WORK_ROOT before any /bind" behavior is retired: every
 * agent-facing entry point (start / list / resume) refuses with
 * `thread.bind_required` when this returns `null`.
 */
function formatBindErrorMessage(error: BindError, rawSubdir: string): string {
  switch (error.code) {
    case 'BIND_INVALID_CHARS': return t('bind.invalid_chars');
    case 'BIND_NOT_FOUND':     return t('bind.not_found', { subdir: rawSubdir, workRoot: ENV.workRoot });
    case 'BIND_OUTSIDE_ROOT':  return t('bind.outside_root');
    case 'BIND_NOT_DIRECTORY': return t('bind.not_directory', { subdir: rawSubdir });
    default:                   return `❌ ${error.message}`;
  }
}

function getWorkDirStartDecision(key: ThreadKey): { ok: true; workDir: string } | { ok: false; message: string } {
  const binding = state.getBinding(key);
  const decision = resolveBoundWorkDir(ENV.workRoot, binding);
  if (decision.kind === 'proceed') return { ok: true, workDir: decision.workDir };
  if (decision.kind === 'refuse') return { ok: false, message: t('thread.bind_required') };
  return { ok: false, message: formatBindErrorMessage(decision.error, binding?.subdir ?? '') };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Subdir validation + discovery (plan §13.7 / T1)
// ═══════════════════════════════════════════════════════════════════════════════

// `validateSubdir` + `BindError` live in `src/validation.ts` so the
// security-critical bits can be unit-tested without booting Telegraf
// (plan §11 Этап 7, R3). The import at the top of this file pulls them in.

/** Inline-keyboard page size for `/bind`. 20 fits one phone screen comfortably. */
const BIND_PAGE_SIZE = 20;

/**
 * @description List immediate subdirectories of `WORK_ROOT` for the `/bind`
 * inline-button picker and the `forum_topic_created` welcome message.
 *
 * Filters out hidden (`.*`) and synthetic (`__*`, `node_modules`, etc.) names
 * — those are almost never project roots and would push real options off
 * Telegram's inline-keyboard limit.
 *
 * Filters out names whose `bind_<name>` `callback_data` would exceed Telegram's
 * 64-byte UTF-8 hard limit (Cyrillic / CJK / emoji names trip this fast at
 * 2-4 bytes per char). Those folders are still bindable via the `/bind <name>`
 * slash command — only the inline-button shortcut is hidden.
 *
 * `fs.readdirSync` is intentional: this is a low-cadence path (per /bind, per
 * topic_created event), and the synchronous block is dwarfed by the Telegram
 * round-trip that follows it.
 */
/**
 * Audit S13 / #28: `fs.readdirSync` on every no-binding text reply / every
 * `/bind` keyboard rebuild is a synchronous blocker on the event loop for
 * any WORK_ROOT with thousands of entries. Cache the result for 30 s —
 * the only realistic way the list changes is the operator creating a
 * folder, which `/bind` after that interval picks up naturally.
 */
const SUBDIR_CACHE_TTL_MS = 30_000;
const subdirCache = new Map<string, { value: string[]; ts: number }>();

function listAvailableSubdirs(workRoot: string, limit = 200): string[] {
  const cacheKey = `${workRoot}|${limit}`;
  const cached = subdirCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SUBDIR_CACHE_TTL_MS) {
    return cached.value;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workRoot, { withFileTypes: true });
  } catch {
    subdirCache.set(cacheKey, { value: [], ts: Date.now() });
    return [];
  }
  const skip = new Set(['node_modules', '.git', '.cache', '.idea', '.vscode']);
  const callbackPrefix = 'bind_';
  const result = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('__') && !skip.has(e.name))
    .map(e => e.name)
    .filter(name => Buffer.byteLength(callbackPrefix + name, 'utf8') <= 64)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit);
  subdirCache.set(cacheKey, { value: result, ts: Date.now() });
  return result;
}

/**
 * @description Build a `subdir`-suggestion keyboard for `/bind` and friends.
 *
 * Lists are paginated at {@link BIND_PAGE_SIZE} entries: a `WORK_ROOT` with
 * many subfolders (mono-repo workspace, packages dir, etc.) would otherwise
 * push the inline keyboard past Telegram's per-message height limit and
 * lose entries below the fold.
 *
 * The nav row appears only when there's more than one page. The middle
 * `pageLabel` button is a no-op (`bind_page_noop` callback) — it exists
 * solely so the user sees "2/5" without us having to fake a divider with
 * a separate message.
 *
 * Subdirs whose callback_data exceeds 64 bytes are filtered out upstream
 * in `listAvailableSubdirs`. `page` is clamped to a valid index so a stale
 * callback (folders disappeared since the keyboard was sent) just lands
 * on the last available page.
 *
 * When `isBound` the FIRST row is a full-width «leave current dir» button
 * (`bindLeaveCurrentCallback`, the folded-in `/unbind`); the «create new folder»
 * button (`bindCreateFolderCallback`) follows. Both callbacks deliberately do
 * NOT start with `bind_`, so they can't be mistaken for a folder pick by the
 * `bind_<subdir>` action regex. They ride on every page so they're reachable
 * regardless of pagination.
 */
const bindCreateFolderCallback = 'bindCreateFolder';

/**
 * «Leave current dir» button — the folded-in `/unbind`. Like
 * `bindCreateFolderCallback`, the callback id deliberately does NOT start with
 * `bind_`, so the `bind_<subdir>` action regex can't mistake it for a folder
 * pick. Only rendered in a bound topic.
 */
const bindLeaveCurrentCallback = 'bindLeaveCurrent';

export function buildBindKeyboard(
  subdirs: readonly string[],
  page: number = 0,
  pageSize: number = BIND_PAGE_SIZE,
  isBound: boolean = false,
) {
  const { slice, currentPage, totalPages } = paginateBindList(subdirs, page, pageSize);

  const rows = [
    [Markup.button.callback(t('bind.create_button'), bindCreateFolderCallback)],
  ];
  // A bound topic gets a full-width «leave current dir» row PREPENDED above the
  // «create new folder» row — this is the folded-in `/unbind`. Its callback
  // deliberately avoids the `bind_` prefix so the `bind_<subdir>` action regex
  // can't catch it. The row is omitted when unbound (nothing to leave).
  if (isBound) {
    rows.unshift([Markup.button.callback(t('bind.leave_button'), bindLeaveCurrentCallback)]);
  }
  for (let i = 0; i < slice.length; i += 2) {
    const row = [Markup.button.callback(`📁 ${slice[i]}`, `bind_${slice[i]}`)];
    if (slice[i + 1]) {
      row.push(Markup.button.callback(`📁 ${slice[i + 1]}`, `bind_${slice[i + 1]}`));
    }
    rows.push(row);
  }

  if (totalPages > 1) {
    const nav = [];
    if (currentPage > 0) {
      nav.push(Markup.button.callback('⬅️ Prev', `bind_page_${currentPage - 1}`));
    }
    nav.push(Markup.button.callback(`${currentPage + 1}/${totalPages}`, 'bind_page_noop'));
    if (currentPage < totalPages - 1) {
      nav.push(Markup.button.callback('Next ➡️', `bind_page_${currentPage + 1}`));
    }
    rows.push(nav);
  }

  return Markup.inlineKeyboard(rows);
}

/**
 * @description Bot-level wrapper around the pure sweep helper in
 * `createAdapter.ts`. Binds the production adapter resolver so callers
 * don't have to thread it through; tests in `stopAllAdapters.test.ts`
 * cover the sweep logic directly with fakes.
 */
function stopAllAdaptersFor(key: ThreadKey, adapterNames?: string[]) {
  return sweepAdapters(key, getAdapter, adapterNames);
}

/**
 * @description Explicit-stop teardown used by `/new`/`/clear_session`:
 * sweep every adapter active for the thread, then RELEASE the persisted session
 * ids (even when nothing was running) so a later bot restart won't auto-reattach
 * and any half-dead state from a crash/SSE-giveup is cleared. The session stays
 * on disk → still reachable via `/sessions`. Returns the sweep result so callers
 * can decide what to reply.
 */
async function releaseThreadSession(key: ThreadKey): Promise<ReturnType<typeof stopAllAdaptersFor>> {
  // User took over (/new) → cancel any pending API-error retry silently
  // before the session is released, so the kick never lands in a torn-down
  // session.
  cancelApiRetry(key);
  clearAuthNotice(key); // session released → retire any pinned logged-out notice
  // Session is going away → no output is coming, so stop the "working" loader
  // (covers the release half of /new before its fresh start re-arms it).
  stopTypingLoader(key);
  // Close any still-pending OpenCode question on the server BEFORE stopping the
  // session — a stopped session can't accept the reject, and an unrejected
  // question re-surfaces on the next reattach (`restoreOpenQuestion`). No-op for
  // Claude / no pending question.
  getThreadAdapter(key).rejectQuestion?.(key);
  const result = stopAllAdaptersFor(key);
  await state.clearAgentSessionIds(key);
  return result;
}

/**
 * @description Switch a thread's adapter and clear the previous adapter's
 * persisted session id, so a later restart can't re-attach to the wrong
 * one. Audit S12 / #21: `setAgent({ name })` patched `agents[key].name`
 * but left `claudeSessionId` / `opencodeSessionId` behind. After a
 * restart the reattach loop saw both fields, treated the binding as a
 * claude session (because `claudeSessionId` was non-null), and re-spawned
 * a tmux pane while the UI insisted the thread used OpenCode.
 *
 * Also stops any live session belonging to the *previous* adapter so two
 * adapters can't end up polling/streaming the same thread at once — that
 * desync caused mixed output, silent `/stop`, and the "I keep getting
 * 'Login successful' on every message" bug reported 2026-05-15.
 */
async function switchThreadAdapter(key: ThreadKey, newName: string): Promise<void> {
  const prevName = getThreadAdapterName(key);
  if (prevName !== newName) {
    try {
      const prev = getAdapter(prevName);
      if (prev.checkIsActive(key)) {
        // `stopSession` is `void` in the AgentAdapter contract — OpenCode
        // queues teardown behind its lifecycle lock and returns
        // immediately. A handful of stragger `output`/`status` events
        // can still fire between this call and the actual teardown.
        // They route through the *new* adapter's `outputsDeltas` after
        // the map switch below, which is bounded and never lands them
        // in the wrong topic. A fully-awaited stop would need an async
        // hook on the adapter interface — follow-up if anyone hits a
        // real artefact from this window.
        prev.stopSession(key);
      }
    } catch (e) {
      // Unknown previous adapter (renamed/removed): nothing to stop.
      console.warn(`[switchThreadAdapter] could not stop previous adapter ${prevName}:`, e instanceof Error ? e.message : e);
    }
  }
  setThreadAdapter(key, newName);
  const agent = state.getAgent(key);
  if (!agent) return;
  // Wipe ids that don't belong to the new adapter. We persist via
  // setAgent (which merges), so build a fresh record with only the
  // surviving fields.
  const next: { name: string; model?: string; claudeSessionId?: string; opencodeSessionId?: string } = { name: newName };
  if (agent.model !== undefined) next.model = agent.model;
  // Both Claude backends share the on-disk transcript, so keep the session id
  // when switching between tmux-scrape and json-stream — the new backend resumes
  // the SAME conversation (`/claude_mode` live switch).
  if (checkIsClaudeBackend(newName) && agent.claudeSessionId) next.claudeSessionId = agent.claudeSessionId;
  if (newName === 'opencode' && agent.opencodeSessionId) next.opencodeSessionId = agent.opencodeSessionId;
  // Overwrite by removing the row first; setAgent then writes only the
  // fields we kept.
  await state.removeAgent(key);
  await state.setAgent(key, next);
}

/**
 * @description The post-start "ready" notice for an agent that just came up — or
 * the empty string when none should be posted. Pure decision extracted from
 * {@link startAgentSession} so the capability gate is unit-testable without the
 * whole start machinery (tmux/HTTP/state):
 *  - a self-greeting agent (Claude — `selfGreetsOnStart`) returns `''`: it prints
 *    its OWN banner to the topic, so the bot's notice would be a redundant,
 *    slightly-early "ready" line above it (the typing loader covers the gap);
 *  - terminal returns the shell-specific `terminal.ready` copy (a shell isn't an
 *    agent that takes a prompt);
 *  - any other backend (OpenCode) returns the generic `agent.ready` notice —
 *    without it the user would have no cue the session is up, since nothing greets.
 */
export function getStartReadyMessage(
  adapter: AgentAdapter,
  subdir: string,
  args?: string,
): string {
  if (adapter.selfGreetsOnStart) return '';
  const readyKey = adapter.name === 'terminal' ? 'terminal.ready' : 'agent.ready';
  return t(readyKey, {
    label: adapter.label,
    subdir,
    argsSuffix: args ? ` (${args})` : '',
  });
}

async function startAgentSession(key: ThreadKey, args?: string): Promise<string> {
  const kStr = keyToString(key);
  // The bound folder IS the agent's cwd — refuse to start without one. The
  // command/natural-language callers gate on the binding too, but a binding
  // can vanish (/unbind) between their check and here, so re-check before any
  // side effect (startup window / markers) opens.
  const workDirDecision = getWorkDirStartDecision(key);
  if (!workDirDecision.ok) return workDirDecision.message;
  const workDir = workDirDecision.workDir;
  // Open the startup window synchronously (before the first await) so text
  // typed right after `/claude` / `/opencode` is buffered, not dropped.
  startupPromptBuffer.markStarting(kStr);
  markNeedsNewMessage(key);
  // Fresh session — the agent's context is empty, so the next prompt must
  // re-carry the thread-context preamble. Forget the last-injected marker.
  clearThreadContextMarker(key);
  const adapter = getThreadAdapter(key);

  // Boot loader. A self-greeting agent (Claude) prints its banner shortly — keep
  // the SUSTAINED loader up from now until that first output covers the gap. A
  // non-self-greeting agent (OpenCode/terminal) emits nothing until the user
  // prompts, so a one-shot typing ping is enough — its `ready` notice (below)
  // tells the user the session is up; a sustained loader would dangle forever.
  if (adapter.selfGreetsOnStart) {
    startTypingLoader(key);
  } else {
    sendThreadTypingIndicator(key).catch(() => {});
  }

  try {
    await adapter.startSession(key, workDir, args);

    // Persist backend session ids so a bot restart can re-attach without
    // losing the live conversation (Claude tmux UUID; OpenCode server UUID).
    await persistAdapterSessionIds(key, adapter, state);

    // Session is active now — replay anything the user typed while it booted,
    // in arrival order, through the normal forward path. Fire-and-forget so the
    // `ready` message isn't delayed; `drainPrompts` runs synchronously here
    // (before the first await inside) so the startup window is already closed
    // by the time we return — no message can slip into a second buffer.
    void replayBufferedPrompts(key);

    const subdir = state.getBinding(key)?.subdir ?? path.basename(ENV.workRoot);
    return getStartReadyMessage(adapter, subdir, args);
  } catch (e) {
    // Start failed — the buffered prompts have nowhere to go, so drop them
    // rather than replaying into a dead session. Stop the boot loader too: a
    // self-greeting start armed the sustained loader, and no output is coming.
    startupPromptBuffer.discardPrompts(kStr);
    stopTypingLoader(key);
    return t('agent.start_failed', {
      label: adapter.label,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * @name EnsureAgentSessionResult
 * @description Outcome of {@link ensureAgentSession}. `ok` means a session is
 * ready to receive prompts NOW — either it was already active, it is in its
 * async startup window (prompts get buffered + replayed on ready), or it was
 * just started. `message` is the localized text the caller MAY surface (the
 * `agent.ready` notice on a fresh start, empty when nothing user-facing
 * happened). On failure, `reason` distinguishes a missing binding (`unbound`)
 * from a start that threw (`start-failed`), and `message` carries the
 * matching localized text.
 */
export type EnsureAgentSessionResult =
  | { ok: true; message: string }
  | { ok: false; reason: 'unbound' | 'start-failed'; message: string };

/**
 * @name EnsureAgentSessionOptions
 * @description Tuning for {@link ensureAgentSession}.
 *  - `preferredAdapterName` — an EXPLICIT user choice that outranks every
 *    resolved name (the natural-language-start path passes the matched
 *    `/claude` vs `/opencode` adapter here).
 *  - `fallbackAdapterName` — used only when nothing else resolves (the
 *    scheduler passes a job's `lastAdapterName` snapshot for a start after a
 *    rebind, where the thread has no live or persisted adapter).
 *  - `args` — forwarded to `startAgentSession` (e.g. the natural-language
 *    start phrase's trailing args).
 */
export interface EnsureAgentSessionOptions {
  preferredAdapterName?: string;
  fallbackAdapterName?: string;
  args?: string;
}

/**
 * @description Ensure the thread `key` has an agent session ready to take a
 * prompt, starting one if needed — the single choke point shared by the
 * natural-language-start path, the `/schedule` command (S7), and the scheduler
 * delivery (S4). It does NOT itself send any user-facing reply: it returns the
 * outcome (and the message to show) so each caller decides its own messaging
 * (e.g. the natural-language path adds a General-topic guard + a folder picker
 * on `unbound`, the scheduler annotates the run ledger instead).
 *
 * Cases:
 *  - already active                → `{ ok: true }` (no message; nothing started).
 *  - mid-startup (window open)     → `{ ok: true }` (prompts will buffer + replay).
 *  - no session, no binding        → `{ ok: false, reason: 'unbound' }`.
 *  - no session, has binding       → resolve the adapter name (explicit
 *    `preferredAdapterName` → in-memory thread pick → persisted
 *    `agents[key].name` → `fallbackAdapterName` → default), `switchThreadAdapter`
 *    + `startAgentSession`, then report `ok` from whether the session came up.
 */
async function ensureAgentSession(
  key: ThreadKey,
  options: EnsureAgentSessionOptions = {},
): Promise<EnsureAgentSessionResult> {
  const adapter = getThreadAdapter(key);
  if (adapter.checkIsActive(key)) return { ok: true, message: '' };
  if (startupPromptBuffer.checkIsStarting(keyToString(key))) return { ok: true, message: '' };

  if (!state.getBinding(key)) {
    return { ok: false, reason: 'unbound', message: t('thread.bind_required') };
  }

  // Resolve which adapter to start. `getThreadAdapterNameRaw` returns the
  // in-memory pick WITHOUT the default fallback, so "no pick yet" stays
  // distinguishable from "picked the default" and the chain doesn't short out.
  const adapterName =
    options.preferredAdapterName ??
    getThreadAdapterNameRaw(key) ??
    state.getAgent(key)?.name ??
    options.fallbackAdapterName ??
    getDefaultAdapterName();

  await switchThreadAdapter(key, adapterName);
  const message = await startAgentSession(key, options.args);
  if (getThreadAdapter(key).checkIsActive(key)) {
    return { ok: true, message };
  }
  return { ok: false, reason: 'start-failed', message };
}

/**
 * @description Replay prompts buffered during the startup window to the now-active
 * agent, preserving arrival order. Each prompt goes through the same forward
 * routine as a live message (new-message marker + loader + `sendInput`).
 */
async function replayBufferedPrompts(key: ThreadKey): Promise<void> {
  const adapter = getThreadAdapter(key);
  const prompts = startupPromptBuffer.drainPrompts(keyToString(key));
  if (prompts.length === 0 || !adapter.checkIsActive(key)) return;
  // Sequential await keeps `sendInput` calls in arrival order even when each
  // forward awaits its own loader send first.
  for (const prompt of prompts) {
    try {
      await forwardPromptToAgent(key, adapter, prompt);
    } catch (err) {
      console.error('[replayBufferedPrompts] forward failed:', err);
    }
  }
}

/**
 * @description Forward one user prompt to a live agent: mark the thread for a
 * fresh output message, start the typing loader (the sole "agent is working"
 * cue), and hand the text to the adapter. Shared by the text handler, the voice
 * handler, and startup-prompt replay so the loader/marker behaviour stays
 * identical across all three. The loader is cleared by the agent's first output
 * (or status / question / teardown) — never by a timeout.
 *
 * If the adapter implements `interruptAndWaitIdle`, we interrupt the running
 * turn and wait until it is actually idle before handing over the text. Only
 * Claude implements it (Escape + a TUI poll) — its TUI ignores typed input for
 * a long stretch of a running turn, so interrupting is what makes it read the
 * new message promptly. OpenCode deliberately does NOT: `prompt_async` queues
 * the prompt and the agent picks it up quickly, so aborting the live turn cost
 * work for nothing (user decision 2026-06-06). An adapter without the method
 * forwards directly.
 */
async function forwardPromptToAgent(
  key: ThreadKey,
  adapter: AgentAdapter,
  text: string,
  sentAtMs?: number,
): Promise<void> {
  // Glue the thread-context preamble (topic / group / thread / folder) ahead
  // of the prompt so the agent knows WHERE it works. Slash commands forwarded
  // to the agent (`/clear`, `/compact`, …) are skipped — a preamble would
  // corrupt them into plain text. The preamble rides only when it differs
  // from the last one we injected this session (fresh session, rename, or
  // post-`/clear` marker reset). See `threadContextPreamble.ts`.
  //
  // `/timestamps` injection (S2): when the thread toggle is ON, the send-time
  // rides EVERY prompt as the very top line (local-offset ISO + blank line,
  // above the on-change preamble) — agent-facing only, never posted to the
  // topic. `sentAtMs` is the originating Telegram message's real send time
  // (plumbed from the text/voice handlers); prompts with no live message
  // (scheduled runs, buffered replay, api-retry nudge, file intake) fall back
  // to now. Slash commands skip it for the same reason they skip the preamble.
  let promptText = getPromptWithThreadContext(key, text);
  if (state.checkIsTimestampsEnabled(key) && !checkShouldSkipPreambleForText(text)) {
    promptText = `${formatIsoLocalOffset(sentAtMs ?? Date.now())}\n\n${promptText}`;
  }
  markNeedsNewMessage(key);
  // A new prompt is a new turn: lift the S2 idle-suppress latch and re-base the
  // working-status elapsed so the next busy period shows a fresh 0:00 counter
  // (the single prompt-forward choke point — covers user text, scheduled runs,
  // and the auto-retry "continue" nudge). Harmless for OpenCode threads (they
  // never arm the Claude liveness loop, so these fields stay unread).
  const msgState = getThreadMessageState(key);
  msgState.statusIdleSuppressed = false;
  msgState.workingSince = Date.now();
  // The native typing indicator is the loader: it shows immediately, can't be
  // delayed behind a chat-wide 429 cooldown (unlike a sent message), and (S3)
  // persists while output is streaming OR the agent is busy — self-stopping only
  // when the topic drains + idles.
  startTypingLoader(key);
  if (adapter.interruptAndWaitIdle) {
    await adapter.interruptAndWaitIdle(key);
  }
  adapter.sendInput(key, promptText);
  // S2 busy-onset arm: start the Claude liveness loop the moment the prompt is
  // forwarded — driven by `checkIsBusy`, not by waiting for an opportunistic
  // scrape emit that may never come during a long quiet think. The arming grace
  // keeps the loop alive until Claude flips busy. Claude-only + idempotent
  // (no-op for OpenCode / an already-armed loop). This is the single prompt
  // choke point (user text, voice, scheduled run, api-retry continue, buffered
  // replay), so every path that makes Claude busy now raises the working frame.
  startClaudeLiveness(key, 'busyOnset');
}

/**
 * @description Return the prompt text with the thread-context preamble glued
 * in front when it should ride this turn, or the text unchanged otherwise.
 *
 * Slash commands forwarded to the agent skip the preamble (gluing it on would
 * turn `/clear` into plain text). For normal prompts we build the preamble
 * from the thread's binding (subdir + known topic name) and the cached group
 * title, then inject only when it differs from the last preamble sent for this
 * thread — a fresh session (marker cleared on start/stop/closed), a topic
 * rename, or a `/clear` (marker reset) all flip the decision to inject. On
 * inject we record the preamble as the new marker so identical follow-up
 * prompts don't repeat it.
 */
/**
 * @description Resolve the `group:` label for the thread-context preamble.
 * For a group key it's the cached supergroup title (empty until the first
 * authorised update after a restart). A DM key's chat is a private chat with no
 * title, so it falls back to the bot's own display name — a stable, non-fatal
 * label so the agent still gets a "where" even though there is no group.
 */
function getPreambleGroupTitle(key: ThreadKey): string | undefined {
  const cached = groupTitleCache.get(key.chatId);
  if (cached) return cached;
  if (checkIsDmKey(key)) return bot.botInfo?.username ?? bot.botInfo?.first_name;
  return undefined;
}

function getPromptWithThreadContext(key: ThreadKey, text: string): string {
  if (checkShouldSkipPreambleForText(text)) return text;

  const binding = state.getBinding(key);
  const subdir = binding?.subdir ?? path.basename(ENV.workRoot);
  const preamble = buildThreadContextPreamble({
    topicName: binding?.topicName,
    groupTitle: getPreambleGroupTitle(key),
    key,
    subdir,
  });

  const kStr = keyToString(key);
  if (!checkShouldInjectPreamble(preamble, threadContextMarkers.get(kStr))) {
    return text;
  }
  threadContextMarkers.set(kStr, preamble);
  return prependThreadContextPreamble(preamble, text);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Natural-language start phrases (`claude ...`, `opencode ...`)
// ═══════════════════════════════════════════════════════════════════════════════

// (Parser imported up-top — see `parseAgentTrigger` import.)

// ═══════════════════════════════════════════════════════════════════════════════
//  Model selection helper — used by /model and the numeric-reply flow
// ═══════════════════════════════════════════════════════════════════════════════

function groupModelsByProvider(models: string[]): Map<string, string[]> {
  const byProvider = new Map<string, string[]>();
  for (const model of models) {
    const slashIdx = model.indexOf('/');
    if (slashIdx > 0) {
      const provider = model.slice(0, slashIdx);
      if (!byProvider.has(provider)) byProvider.set(provider, []);
      byProvider.get(provider)!.push(model);
    }
  }
  return byProvider;
}

function formatTimeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

/**
 * @description Single choke point for the four `/model`-set paths (the
 * `/model <num>` and `/model <name>` commands, the text-handler numeric pick,
 * and the `model_<id>` button callback). Drives the thread's adapter and turns
 * the outcome into a ready reply via the pure {@link getModelSetReplyDecision}.
 *
 * No session gate here: each adapter decides what "no session" means
 * (OpenCode persists the pick for the next start and succeeds; Claude refuses
 * with a notice). On success the pinned banner is refreshed best-effort.
 */
async function applyModelSelection(
  adapter: AgentAdapter,
  key: ThreadKey,
  modelId: string,
): Promise<{ isOk: boolean; message: string; setModelError: string | null; displayLabel: string }> {
  const setModelError = adapter.setModel ? await adapter.setModel(key, modelId) : null;
  const displayLabel = adapter.getCurrentModel?.(key) || modelId;
  const decision = getModelSetReplyDecision(
    {
      hasSetModel: Boolean(adapter.setModel),
      setModelError,
      isActive: adapter.checkIsActive(key),
      adapterLabel: adapter.label,
      displayLabel,
    },
    t,
  );
  if (decision.isOk) await updatePinnedStatus(key).catch(() => {});
  return { ...decision, setModelError, displayLabel };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Commands
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Wrap a command handler with the gating check.
 *
 * Each handler gets a guaranteed-non-null `key` if it runs at all. Foreign
 * chats / unauthorized users are silently ignored (logged inside `authoriseContext`).
 */
function command(
  name: string | string[],
  handler: (ctx: NarrowedContext<Context, Update.MessageUpdate<Message.TextMessage>>, key: ThreadKey) => Promise<void> | void,
): void {
  bot.command(name, async (ctx) => {
    const key = await authoriseContext(ctx);
    if (!key) return;
    // Running ANY command exits the /bind create-folder await-name mode — the
    // create flow only expects a plain folder-name message, never a command.
    // (The picker's create button re-arms it afterwards via its own callback.)
    const keyString = keyToString(key);
    awaitingFolderName.delete(keyString);
    const hadPendingProviderConnect = pendingProviderConnects.delete(keyString);
    if (hadPendingProviderConnect && !checkIsConnectCommandText(ctx.message.text)) {
      await replyToThread(key, t('connect.cancelled'));
    }
    await handler(ctx, key);
  });
}

command('start', async (_ctx, key) => {
  const adapters = getAvailableAdapters();
  const list = adapters.map(a => `• ${a.label} (/${a.name})`).join('\n');
  await replyToThread(
    key,
    'AI Agent Bot (multi-thread)\n\n' +
      `WORK_ROOT: ${ENV.workRoot}\n\n` +
      `Available agents:\n${list}\n\n` +
      '/claude /opencode — start an agent in this thread\n' +
      '/sessions — previous sessions\n' +
      '/quit — quit current agent\n' +
      '/status — show status',
  );
});

command('status', async (_ctx, key) => {
  // In General the per-thread status is meaningless (no binding ever) — so
  // we promote /status to a workspace-wide overview there. Topical threads
  // keep the per-thread report.
  if (checkIsGeneral(key)) {
    const rows = collectBindingRows();
    if (rows.length === 0) {
      await replyToThread(key, t('status.global_empty'));
      return;
    }
    const body = rows.map(r => t('status.global_row', {
      key: keyToString(r.key),
      subdir: r.subdir,
      agent: r.agentLabel,
      status: formatBindingStatus(r),
    })).join('\n');
    await replyToThread(
      key,
      `${t('status.global_header', { total: rows.length })}\n${body}`,
      { parse_mode: 'Markdown' },
    );
    return;
  }
  const adapter = getThreadAdapter(key);
  const isActive = adapter.checkIsActive(key);
  const adapterName = getThreadAdapterName(key);
  const binding = state.getBinding(key);
  const subdir = binding?.subdir ?? '(no binding — WORK_ROOT)';
  await replyToThread(
    key,
    'Status:\n\n' +
      `Agent: ${adapter.label} (${adapterName})\n` +
      `Folder: ${subdir}\n` +
      `Session: ${isActive ? 'running' : 'stopped'}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  /bind /unbind /where — thread ↔ subfolder binding (plan §11 Этап 4)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Persist a `key → subdir` binding and report the outcome.
 *
 * Shared between the `/bind <subdir>` command and the `bind_<subdir>`
 * inline-callback so both paths apply identical validation, collision
 * checks (plan §11 Этап 4 — warn when other threads already use the same
 * folder, decision D7) and acknowledgement formatting.
 *
 * Returns `{ ok: true, subdir }` on success, plus a localised
 * acknowledgement string. Callers send the message themselves so they
 * can stack additional content (rich welcome, etc.) underneath.
 */
type ApplyBindingResult =
  | { ok: true;  message: string; subdir: string }
  | { ok: false; message: string };

async function applyBinding(
  key: ThreadKey,
  rawSubdir: string,
  options: { topicName?: string } = {},
): Promise<ApplyBindingResult> {
  let subdir: string;
  try {
    subdir = validateSubdir(ENV.workRoot, rawSubdir);
  } catch (e) {
    let msg: string;
    if (e instanceof BindError) {
      msg = formatBindErrorMessage(e, rawSubdir);
    } else {
      msg = `❌ ${e instanceof Error ? e.message : String(e)}`;
    }
    return { ok: false, message: msg };
  }

  // Collision warning: one folder may host several threads (D7), but the
  // user should know they're about to join an existing workspace rather
  // than start a fresh one.
  const peers = state.listKeysForSubdir(subdir).filter(k => keyToString(k) !== keyToString(key));
  await state.setBinding(key, subdir, options.topicName !== undefined ? { topicName: options.topicName } : {});

  const message = peers.length > 0
    ? t('thread.bind_collision', {
        subdir,
        threads: peers.map(k => `\`${keyToString(k)}\``).join(', '),
      })
    : t('thread.bound', { subdir });

  // Rebind resume (S8): a thread that was unbound paused its schedules; binding
  // it again (this thread, possibly a different folder) resumes them. Best
  // effort — a folder pick must succeed even if the resume bookkeeping hiccups.
  await resumeThreadSchedulesOnRebind(key).catch((e) =>
    console.warn(`[scheduler] resume-on-rebind failed for ${keyToString(key)}:`, e),
  );

  return { ok: true, message, subdir };
}

/**
 * @description Pause every schedule owned by `key` because its topic was just
 * unbound (S8): flag each `isPaused` with reason `'unbound'`, disarm its timer,
 * and post ONE notice naming the count (only when > 0). Scheduler pins are NOT
 * touched (user decision: pins accumulate). Returns the number paused so the
 * caller can decide whether anything happened. The engine stays generic — this
 * unbound-specific policy lives here in bot.ts.
 */
async function pauseThreadSchedulesOnUnbind(key: ThreadKey): Promise<number> {
  const records = state.getThreadSchedules(key);
  if (records.length === 0) return 0;
  for (const record of records) {
    await state.setSchedulePaused(record.id, true, 'unbound');
    schedulerEngine?.disarmJob(record.id);
  }
  await replyToThread(key, t('schedule.pausedUnbound', { count: records.length }));
  return records.length;
}

/**
 * @description Resume the schedules paused for `'unbound'` on `key` when its
 * topic is rebound (S8): recompute each `nextRunAt` FROM NOW (no catch-up for a
 * deliberate pause), then either un-pause + re-arm, or — for a one-shot whose
 * instant already passed while unbound — drop the record (a past one-shot has no
 * future occurrence, so it cannot be resumed). Posts ONE notice with the resumed
 * count (only when > 0). Jobs paused for other reasons (none exist in v1) are
 * left alone.
 */
async function resumeThreadSchedulesOnRebind(key: ThreadKey): Promise<void> {
  const paused = state
    .getThreadSchedules(key)
    .filter((record) => record.isPaused && record.pauseReason === 'unbound');
  if (paused.length === 0) return;

  const nowMs = Date.now();
  let resumed = 0;
  for (const record of paused) {
    const action = getRebindResumeAction(record, nowMs);
    if (action.kind === 'remove') {
      await state.removeSchedule(record.id);
      schedulerEngine?.disarmJob(record.id);
      continue;
    }
    const updated: ScheduleRecord = {
      ...record,
      nextRunAt: action.nextRunAt,
      updatedAt: new Date(nowMs).toISOString(),
    };
    delete updated.isPaused;
    delete updated.pauseReason;
    await state.upsertSchedule(updated);
    schedulerEngine?.armJob(updated);
    resumed += 1;
  }
  if (resumed > 0) {
    await replyToThread(key, t('schedule.resumedRebind', { count: resumed }));
  }
}

/**
 * @description Arm a thread's await-folder-name mode for the `/bind`
 * create-folder flow. Clears any other in-flight pick mode first so the
 * armed-mode branches in the text handler never overlap (only one armed
 * mode is active per thread at a time).
 */
function armFolderCreation(key: ThreadKey): void {
  const kStr = keyToString(key);
  awaitingModelSelection.delete(kStr);
  awaitingSessionSelection.delete(kStr);
  // A stale pending question would otherwise consume the message AFTER the
  // folder name as an answer to the old (pre-rebind) agent question.
  clearPendingQuestion(key);
  awaitingFolderName.add(kStr);
}

/** Map a `validateNewFolderName` rejection to its localised reply. */
function mapNewFolderError(reason: NewFolderNameError): string {
  switch (reason) {
    case 'empty':         return t('bind.create_empty');
    case 'separator':     return t('bind.create_separator');
    case 'dot_segment':   return t('bind.create_dot_segment');
    case 'hidden':        return t('bind.create_hidden');
    case 'invalid_chars': return t('bind.create_invalid_chars');
    default:              return t('bind.create_empty');
  }
}

/**
 * @description Create a new folder under WORK_ROOT from a user-typed name and
 * bind the thread to it. Validates the name first (no traversal/slashes/dots),
 * then `mkdir` (recursive: an already-existing folder is fine — we just bind
 * to it and tell the user), then routes through `applyBinding` for the same
 * containment/symlink defence + welcome stack the picker uses.
 *
 * Returns `{ ok }` so the caller knows whether to disarm the await-name mode:
 * an invalid name keeps the thread armed for a retry; success or a real
 * filesystem failure disarms it.
 */
async function createAndBindFolder(key: ThreadKey, rawName: string): Promise<{ ok: boolean }> {
  const validated = validateNewFolderName(rawName);
  if (!validated.ok) {
    await replyToThread(key, mapNewFolderError(validated.reason));
    return { ok: false };
  }

  const targetPath = path.join(ENV.workRoot, validated.name);
  const alreadyExisted = fs.existsSync(targetPath);
  try {
    fs.mkdirSync(targetPath, { recursive: true });
  } catch (e) {
    await replyToThread(key, t('bind.create_failed', {
      error: e instanceof Error ? e.message : String(e),
    }));
    return { ok: true };
  }

  // Folder freshly on disk → the cached subdir list is stale; drop it so the
  // next picker render includes the new folder.
  subdirCache.clear();

  if (alreadyExisted) {
    await replyToThread(key, t('bind.create_exists', { subdir: validated.name }));
  }
  const result = await applyBinding(key, validated.name);
  await replyToThread(key, result.message);
  if (result.ok) await sendBindingWelcome(key, result.subdir);
  return { ok: true };
}

command('bind', async (ctx, key) => {
  if (checkIsGeneral(key)) {
    await replyToThread(key, t('bind.in_general'));
    return;
  }
  // Collapse internal whitespace runs so `/bind   foo` works the same as
  // `/bind foo` and we don't end up looking for a literal "foo  bar"
  // directory because the user double-tapped space.
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  const arg = parts.join(' ');
  if (!arg) {
    // Show where the topic points now, so the picker message itself answers
    // "what am I bound to?" without a separate /where.
    const binding = state.getBinding(key);
    const currentLine = binding
      ? t('bind.current', { subdir: binding.subdir })
      : t('bind.current_none');
    const usage = `${currentLine}\n\n${t('bind.usage')}`;
    const subdirs = listAvailableSubdirs(ENV.workRoot);
    // Always show the keyboard — even with zero subdirs it carries the
    // «create new folder» button, which is the only way to bootstrap a folder
    // from an empty WORK_ROOT without the slash form. When already bound it
    // also carries the «leave current dir» button (the folded-in /unbind).
    await replyToThread(key, usage, buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!binding));
    return;
  }
  const result = await applyBinding(key, arg);
  await replyToThread(key, result.message);
  if (result.ok) await sendBindingWelcome(key, result.subdir);
});

/**
 * @description Unbind a thread from its folder: stop any live session, drop the
 * pinned banner, release persisted session ids, pause the thread's schedules,
 * then wipe the binding. Shared by the `/bind` picker's «leave current dir»
 * button (the old `/unbind` command was folded into it). Safe to call only on a
 * BOUND, non-General topic — the leave button only renders there.
 */
async function unbindThread(key: ThreadKey): Promise<void> {
  // Mark this thread as in-flight unbinding so the adapter's synchronous
  // `stopped` event doesn't race us and re-pin a stale "idle" banner over
  // the message we're about to delete.
  const kStr = keyToString(key);
  unbindingKeys.add(kStr);
  try {
    // Order matters: drop the pin FIRST (while binding.pinnedStatusMessageId
    // is still readable), then stop the session, then wipe the binding.
    await clearPinnedStatus(key);

    // Stop any running session before discarding the binding so we don't leave
    // an orphan tmux/SSE stream pointing at a directory we no longer track.
    const adapter = getThreadAdapter(key);
    if (adapter.checkIsActive(key)) {
      // Close any still-pending OpenCode question on the server BEFORE stopping
      // the session — a stopped session can't accept the reject, and an
      // unrejected question re-surfaces on the next reattach. No-op for Claude /
      // no pending question.
      adapter.rejectQuestion?.(key);
      try { adapter.stopSession(key); } catch (e) {
        console.warn(`[unbind] stopSession failed for ${kStr}:`, e);
      }
    }
    // Release persisted session ids too — otherwise re-binding this thread
    // later + a bot restart would resurrect the old session the user unbound.
    await state.clearAgentSessionIds(key);
    // Pause this thread's schedules BEFORE dropping the binding: a fire against
    // an unbound topic can't deliver, so the jobs park (paused + disarmed) and
    // the next /bind resumes them. `removeBinding` only touches bindings/agents/
    // messages — schedules are their own collection and survive (S8).
    await pauseThreadSchedulesOnUnbind(key).catch((e) =>
      console.warn(`[scheduler] pause-on-unbind failed for ${kStr}:`, e),
    );
    await state.removeBinding(key);
    clearInMemoryThreadState(key);
    await replyToThread(key, t('thread.unbound'));
  } finally {
    unbindingKeys.delete(kStr);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  /ls /list — General-scoped info (plan §11 Этап 4)
// ═══════════════════════════════════════════════════════════════════════════════

// `/ls` is intentionally available in topical threads too — there's no
// security reason to refuse, and it's handy when the user wants to see
// siblings before running /bind.
command('ls', async (_ctx, key) => {
  const subdirs = listAvailableSubdirs(ENV.workRoot);
  if (subdirs.length === 0) {
    await replyToThread(key, t('ls.empty'));
    return;
  }
  const body = subdirs.map(s => `• \`${s}\``).join('\n');
  await replyToThread(
    key,
    `${t('ls.header', { workRoot: ENV.workRoot })}\n${body}`,
    { parse_mode: 'Markdown' },
  );
});

/**
 * @description Iterate the bindings, sort them deterministically and resolve
 * each thread's display label + activity. Shared between `/list` and the
 * General-scoped branch of `/status` so adapter-resolution safety and
 * sort/render rules stay aligned.
 *
 * `getAdapter(agent.name)` *throws* on unknown adapter names — the same
 * binding may have been persisted with an adapter that has since been
 * renamed or removed, so we wrap the lookup defensively and fall back to
 * the stored name. Without this, the very first stale binding crashes the
 * whole report (review CRITICAL #1).
 */
interface BindingRow {
  key: ThreadKey;
  subdir: string;
  closed: boolean;
  agentLabel: string;
  isActive: boolean;
}

function collectBindingRows(): BindingRow[] {
  const bindings = [...state.listBindings()];
  bindings.sort((a, b) => a.key.threadId - b.key.threadId);
  return bindings.map(({ key: k, data }) => {
    const agent = state.getAgent(k);
    let agentLabel = '—';
    if (agent?.name) {
      try { agentLabel = getAdapter(agent.name).label; }
      catch { agentLabel = agent.name; }
    }
    let isActive = false;
    if (agent) {
      try { isActive = getThreadAdapter(k).checkIsActive(k); }
      catch { /* keep false */ }
    }
    return {
      key: k,
      subdir: data.subdir,
      closed: data.closed === true,
      agentLabel,
      isActive,
    };
  });
}

function formatBindingStatus(row: BindingRow): string {
  if (row.closed) return '🔒 closed';
  return row.isActive ? '🟢 running' : '⚪ stopped';
}

command('list', async (_ctx, key) => {
  const rows = collectBindingRows();
  if (rows.length === 0) {
    await replyToThread(key, t('list.empty'));
    return;
  }
  const body = rows.map(r => {
    if (r.closed) {
      return t('list.row_closed', {
        threadId: r.key.threadId, subdir: r.subdir, agent: r.agentLabel,
      });
    }
    return t('list.row', {
      threadId: r.key.threadId,
      subdir: r.subdir,
      agent: r.agentLabel,
      status: formatBindingStatus(r),
    });
  }).join('\n');
  await replyToThread(
    key,
    `${t('list.header', { count: rows.length })}\n${body}`,
    { parse_mode: 'Markdown' },
  );
});

/**
 * @description `/new` (alias `/clear_session`) — stop the thread's current agent
 * session and immediately start a fresh one in the SAME topic with the SAME
 * adapter. The old session is RELEASED (not deleted): its transcript stays on
 * disk so it's still resumable via `/sessions`, but a bot restart won't
 * auto-reattach it. Unlike `/quit` + `/claude`, this is one tap and keeps the
 * thread's chosen backend.
 *
 * Guards mirror `handleStartCommand`: General has no binding/agent, so it just
 * hints; an unbound topic gets the standard bind-required reply.
 */
command(['new', 'clear_session'], async (_ctx, key) => {
  if (checkIsGeneral(key)) {
    await replyToThread(key, t('new.general_hint'));
    return;
  }
  if (!state.getBinding(key)) {
    await replyToThread(key, t('thread.bind_required'));
    return;
  }
  // Release the current session (sweep + clear ids) via `releaseThreadSession`.
  // The fresh start below uses the thread's current adapter, so we keep the
  // adapter selection untouched.
  await releaseThreadSession(key);
  // `startAgentSession` handles startup buffering, the typing-loader boot, and
  // the preamble-marker reset. It returns `''` for a self-greeting agent (Claude
  // prints its own banner) — show a notice only for a non-empty ready text.
  const msg = await startAgentSession(key);
  if (msg) await replyToThread(key, msg);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  /whoami /version /help /status (global) — debug & onboarding
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Best-effort version probe for an external CLI.
 *
 * `execFile` is used (not `exec`) to avoid shell expansion of the argument
 * list — the binary name comes from configuration but the arg is constant.
 * 1500ms is enough for any reasonable `--version` call and short enough to
 * keep `/version` responsive when a binary hangs (e.g. opencode autostart
 * during a transient netfail).
 */
async function getCliVersion(cmd: string, args: string[] = ['--version']): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 1500 });
    const out = (stdout || stderr || '').split('\n')[0].trim();
    return out || t('version.unknown');
  } catch {
    return t('version.unknown');
  }
}

command('version', async (_ctx, key) => {
  // Read our own version from package.json so we don't drift if it ever bumps
  // again without us updating a hardcoded string here.
  let botVersion = t('version.unknown');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    botVersion = pkg.version || botVersion;
  } catch { /* fall through to unknown */ }

  const [tmuxV, claudeV, opencodeV] = await Promise.all([
    getCliVersion('tmux', ['-V']),
    getCliVersion('claude'),
    getCliVersion('opencode'),
  ]);

  await replyToThread(
    key,
    t('version.report', {
      bot: botVersion,
      node: process.version,
      tmux: tmuxV,
      claude: claudeV,
      opencode: opencodeV,
    }),
    { parse_mode: 'Markdown' },
  );
});

command('whoami', async (ctx, key) => {
  const userId = ctx.from?.id ?? 0;
  // Per-chat authority is the single source of truth now (owner for a DM chat,
  // the served group's admins for the group chat); `checkIsAllowedUser` already
  // encodes the surface gate, so no extra group-id clause is needed.
  const allowed = await checkIsAllowedUser(ctx);
  const binding = state.getBinding(key);
  await replyToThread(
    key,
    t('whoami.report', {
      userId,
      chatId: key.chatId,
      threadId: key.threadId,
      allowed: allowed ? 'yes' : 'no',
      binding: binding ? `\`${binding.subdir}\`` : t('whoami.binding_unbound'),
    }),
    { parse_mode: 'Markdown' },
  );
});

/**
 * @description Re-point the bot to the forum supergroup this command was
 * sent in. Registered raw (not via the group-gated `command()` wrapper) so
 * it can switch the bot from one group to another. Refused when the id is
 * locked by `ALLOWED_GROUP_ID` env. Only a creator/administrator of the target
 * group may pair, so a random group can't hijack the binding.
 */
bot.command('pair', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  // A private chat has no group to pair. Reply with the DM hint only to the
  // owner (a resolvable DM key); any other private chat stays silent so foreign
  // DMs get nothing. Group chats fall through to the real pairing logic — so in
  // `both` the group can still be (re)paired via /pair from inside it.
  if (ctx.chat?.type === 'private') {
    const dmKey = getThreadKey(ctx);
    if (dmKey) await replyToThread(dmKey, t('pair.dm')).catch(() => {});
    return;
  }

  const routeChat = getRouteChat(ctx);
  const fallbackThreadId =
    ctx.message && 'message_thread_id' in ctx.message ? ctx.message.message_thread_id : undefined;
  const replyKey: ThreadKey = getThreadKey(ctx) ?? {
    chatId: ctx.chat?.id ?? routeChat?.id ?? 0,
    threadId: fallbackThreadId ?? GENERAL_THREAD_ID,
  };

  if (isGroupLockedByEnv) {
    await replyToThread(replyKey, t('pair.locked')).catch(() => {});
    return;
  }
  if (!routeChat || routeChat.type !== 'supergroup' || !routeChat.is_forum) {
    await replyToThread(replyKey, t('pair.only_forum')).catch(() => {});
    return;
  }
  if (!(await checkIsForumAdmin(routeChat.id, userId))) {
    await replyToThread(replyKey, t('pair.not_admin')).catch(() => {});
    return;
  }

  effectiveGroupId = routeChat.id;
  await state.setPairedGroupId(routeChat.id);
  adminCache.invalidate();
  console.log(`[pair] re-paired to forum supergroup ${routeChat.id} via /pair`);
  const key = getThreadKey(ctx) ?? { chatId: routeChat.id, threadId: GENERAL_THREAD_ID };
  await replyToThread(key, t('pair.success', { groupId: routeChat.id }));
});

command('help', async (_ctx, key) => {
  if (checkIsGeneral(key)) {
    await replyToThread(key, t('help.general'), { parse_mode: 'Markdown' });
    return;
  }
  const binding = state.getBinding(key);
  if (!binding) {
    const subdirs = listAvailableSubdirs(ENV.workRoot);
    const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
    await replyToThread(key, t('help.thread_unbound'), {
      parse_mode: 'Markdown',
      ...(extra ?? {}),
    });
    return;
  }
  await replyToThread(
    key,
    t('help.thread_bound', { subdir: binding.subdir }),
    { parse_mode: 'Markdown' },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Rich binding welcome (plan §20.5) — folder stats + start-agent keyboard
// ═══════════════════════════════════════════════════════════════════════════════

interface BindingStats {
  claudeMdSize: string | null;
  mcpServerCount: number | null;
  gitBranch: string | null;
  gitClean: boolean | null;   // null = no git repo
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @description Collect a short factual summary of a bound project folder for
 * the welcome message — what onboarding context Claude would actually pick
 * up (CLAUDE.md), what MCP servers are configured at the project level, and
 * what git state the folder is in. Every probe is best-effort: a missing
 * file or non-git folder just means the corresponding row is dropped from
 * the welcome.
 */
async function getBindingStats(workDir: string): Promise<BindingStats> {
  const out: BindingStats = {
    claudeMdSize: null,
    mcpServerCount: null,
    gitBranch: null,
    gitClean: null,
  };

  try {
    const stat = fs.statSync(path.join(workDir, 'CLAUDE.md'));
    if (stat.isFile()) out.claudeMdSize = formatBytes(stat.size);
  } catch { /* no CLAUDE.md */ }

  try {
    const raw = fs.readFileSync(path.join(workDir, '.mcp.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers) {
      out.mcpServerCount = Object.keys(parsed.mcpServers).length;
    }
  } catch { /* no .mcp.json or invalid */ }

  // `git` is only inspected if `.git` is present — avoids spawning the
  // binary on every /bind, and dodges sub-second `git status` runs for big
  // monorepos.
  try {
    fs.accessSync(path.join(workDir, '.git'));
  } catch { return out; }

  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: workDir, timeout: 1500,
    });
    out.gitBranch = stdout.trim() || 'HEAD';
  } catch { out.gitBranch = 'HEAD'; }

  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: workDir, timeout: 1500,
    });
    out.gitClean = stdout.trim().length === 0;
  } catch { /* keep null = unknown */ }

  return out;
}

/**
 * @description Inline keyboard offering one-tap entry into the freshly bound
 * thread. The buttons reuse existing callback handlers (`agent_*` and
 * `resume_*`) so the routes stay single-sourced; resume is included as a
 * shortcut to the picker view.
 */
function buildStartAgentKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('▶️ Claude', 'agent_claude'),
      Markup.button.callback('▶️ OpenCode', 'agent_opencode'),
    ],
    [Markup.button.callback('📋 Resume…', 'open_sessions')],
  ]);
}

/**
 * @description Compose and send the rich post-bind welcome described in
 * plan §20.5: header with the bound subdir, three optional fact rows
 * (CLAUDE.md / .mcp.json / git), and an inline keyboard to start an agent.
 * Falls back gracefully when stats can't be probed.
 */
async function sendBindingWelcome(key: ThreadKey, subdir: string): Promise<void> {
  // Pin the status banner first so the user sees it land near the top of
  // the thread before the slower stats probe finishes. Fire-and-forget —
  // a failed pin (missing permissions, closed topic) just logs a warning
  // and never blocks the welcome flow.
  updatePinnedStatus(key).catch(err =>
    console.warn(`[pinned] initial pin for ${keyToString(key)} failed:`, err),
  );

  const workDir = path.join(ENV.workRoot, subdir);
  let stats: BindingStats;
  try {
    stats = await getBindingStats(workDir);
  } catch {
    stats = { claudeMdSize: null, mcpServerCount: null, gitBranch: null, gitClean: null };
  }

  const lines: string[] = [t('binding.welcome.header', { subdir })];
  if (stats.claudeMdSize) lines.push(t('binding.welcome.claude_md', { size: stats.claudeMdSize }));
  if (stats.mcpServerCount !== null) {
    lines.push(t('binding.welcome.mcp_json', { count: stats.mcpServerCount }));
  }
  if (stats.gitBranch) {
    const detail = stats.gitClean === null
      ? ''
      : stats.gitClean ? t('binding.welcome.git_clean') : t('binding.welcome.git_dirty');
    lines.push(t('binding.welcome.git', { branch: stats.gitBranch, detail }));
  } else if (fs.existsSync(path.join(workDir, '.git')) === false) {
    lines.push(t('binding.welcome.git_none'));
  }
  lines.push('');
  lines.push(t('binding.welcome.start_prompt'));

  await replyToThread(key, lines.join('\n'), {
    parse_mode: 'Markdown',
    ...buildStartAgentKeyboard(),
  });
}

// `open_sessions` callback wires the [📋 Resume…] button to the `/sessions`
// flow — same `handleSessionsList` helper the slash command calls into, so
// the picker source (list rendering + pick-mode arming) stays single-sourced.
bot.action('open_sessions', async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  await ctx.answerCbQuery();
  await handleSessionsList(key);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  /doctor — self-diagnostics (plan §20.1)
// ═══════════════════════════════════════════════════════════════════════════════

interface DoctorLine {
  status: 'ok' | 'warn' | 'fail';
  label: string;
  hint?: string;
}

function formatDoctorLine(line: DoctorLine): string {
  if (line.status === 'ok')  return t('doctor.ok',   { label: line.label });
  if (line.status === 'warn') return t('doctor.warn', { label: line.label, hint: line.hint ?? '' });
  return                       t('doctor.fail', { label: line.label, hint: line.hint ?? '' });
}

async function checkCliPresent(cmd: string): Promise<boolean> {
  try {
    await execFileAsync(cmd, ['--version'], { timeout: 1500 });
    return true;
  } catch { return false; }
}

async function runDoctor(): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];

  // 1. Bot admin permissions in the configured group.
  const groupId = getAllowedGroupId();
  if (groupId === null) {
    lines.push({ status: 'warn', label: t('doctor.bot_admin'), hint: t('pair.not_paired') });
  } else try {
    const botId = bot.botInfo?.id ?? (await bot.telegram.getMe()).id;
    const member = await bot.telegram.getChatMember(groupId, botId);
    if (member.status === 'administrator') {
      lines.push({ status: 'ok', label: t('doctor.bot_admin') });
      lines.push({
        status: member.can_manage_topics ? 'ok' : 'fail',
        label: t('doctor.can_manage_topics'),
        hint: t('error.tg.perm.manage_topics'),
      });
      lines.push({
        status: member.can_delete_messages ? 'ok' : 'fail',
        label: t('doctor.can_delete_messages'),
        hint: t('error.tg.perm.delete'),
      });
      lines.push({
        status: member.can_pin_messages ? 'ok' : 'warn',
        label: t('doctor.can_pin_messages'),
        hint: t('doctor.pin_hint'),
      });
    } else {
      lines.push({
        status: 'fail',
        label: t('doctor.bot_admin'),
        hint: `current status: ${member.status}`,
      });
    }
  } catch (e) {
    lines.push({
      status: 'warn',
      label: t('doctor.bot_admin'),
      hint: t('doctor.no_admin_info'),
    });
  }

  // 2. Privacy mode (heuristic — Bot API doesn't expose the flag directly,
  //    but `getMe().can_read_all_group_messages === false` indicates it's on).
  try {
    const me = await bot.telegram.getMe();
    lines.push({
      status: me.can_read_all_group_messages ? 'ok' : 'fail',
      label: t('doctor.privacy_off'),
      hint: t('doctor.privacy_hint'),
    });
  } catch { /* skip silently — covered by admin check above */ }

  // 3. WORK_ROOT.
  const subdirCount = listAvailableSubdirs(ENV.workRoot, 9999).length;
  lines.push({
    status: 'ok',
    label: t('doctor.workroot_subdirs', { workRoot: ENV.workRoot, count: subdirCount }),
  });

  // 4. DATA_DIR.
  lines.push({
    status: 'ok',
    label: t('doctor.datadir_path', { dataDir: path.dirname(state.stateFilePath) }),
  });

  // 5. CLI presence — informational, auto-install kicks in on first /claude
  //    or /opencode anyway.
  const [hasClaude, hasOpencode] = await Promise.all([
    checkCliPresent('claude'),
    checkCliPresent('opencode'),
  ]);
  lines.push({
    status: hasClaude ? 'ok' : 'warn',
    label: t('doctor.claude_installed'),
    hint: t('doctor.cli_missing'),
  });
  lines.push({
    status: hasOpencode ? 'ok' : 'warn',
    label: t('doctor.opencode_installed'),
    hint: t('doctor.cli_missing'),
  });

  // 6. State validity (and archive notice).
  const bindings = state.listBindings();
  const activeCount = bindings.filter(({ key: k }) => {
    try { return getThreadAdapter(k).checkIsActive(k); } catch { return false; }
  }).length;
  lines.push({
    status: 'ok',
    label: t('doctor.state_valid', { bindings: bindings.length, active: activeCount }),
  });
  if (state.wasCorruptedOnLoad()) {
    lines.push({
      status: 'warn',
      label: t('doctor.state_archived', { path: state.getCorruptedArchivePath() ?? '?' }),
    });
  }

  return lines;
}

command('doctor', async (_ctx, key) => {
  // Single big edit-in-place would be nicer, but doctor is rarely run and
  // gathering the report in series keeps it dead simple.
  const lines = await runDoctor();
  const body = lines.map(formatDoctorLine).join('\n');
  await replyToThread(
    key,
    `${t('doctor.header')}\n\n${body}`,
    { parse_mode: 'Markdown' },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  /mcp — read-only listing of MCP servers across all four levels (§19.3)
// ═══════════════════════════════════════════════════════════════════════════════

interface McpEntry {
  name: string;
  source: string;
}

function loadMcpFile(filePath: string): string[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers) {
      return Object.keys(parsed.mcpServers);
    }
    // Claude CLI also accepts a `mcpServers` key inside `~/.claude/settings.json`
    // alongside other settings; same shape.
  } catch { /* missing / unreadable / invalid JSON — skip */ }
  return [];
}

function collectMcpEntries(workDir: string | null, key: ThreadKey | null): McpEntry[] {
  const entries: McpEntry[] = [];
  const dataDir = path.dirname(state.stateFilePath);

  // user-level
  const userPath = path.join(os.homedir(), '.claude', 'settings.json');
  for (const name of loadMcpFile(userPath)) {
    entries.push({ name, source: t('mcp.source_user') });
  }
  // group-level
  for (const name of loadMcpFile(path.join(dataDir, 'mcp.json'))) {
    entries.push({ name, source: t('mcp.source_group') });
  }
  // project-level
  if (workDir) {
    for (const name of loadMcpFile(path.join(workDir, '.mcp.json'))) {
      entries.push({ name, source: t('mcp.source_project', { workDir }) });
    }
  }
  // thread-level
  if (key) {
    const threadFile = path.join(dataDir, 'threads', `${keyToString(key)}.json`);
    for (const name of loadMcpFile(threadFile)) {
      entries.push({ name, source: t('mcp.source_thread') });
    }
  }
  return entries;
}

command('mcp', async (_ctx, key) => {
  const binding = state.getBinding(key);
  const workDir = binding ? path.join(ENV.workRoot, binding.subdir) : null;
  // General can still benefit from user+group entries even without a workDir.
  const entries = collectMcpEntries(workDir, checkIsGeneral(key) ? null : key);
  if (entries.length === 0) {
    await replyToThread(key, t('mcp.empty'));
    return;
  }
  const body = entries.map(e => t('mcp.row', { name: e.name, source: e.source })).join('\n');
  await replyToThread(
    key,
    `${t('mcp.header')}\n${body}`,
    { parse_mode: 'Markdown' },
  );
});

/**
 * @description Switch a thread to `adapterName` and START a session in one step —
 * the shared core behind the `/claude` `/opencode` `/terminal` commands AND the
 * post-bind welcome buttons (one tap: select + start). Returns nothing user-facing
 * itself beyond the replies it sends, so callers can layer their own follow-up
 * (the button re-renders its keyboard ✓ + refreshes the pinned banner).
 *
 * Guards (in order): General topic → refuse; no binding → bind-required reply +
 * folder picker; already-active session → "already running". A self-greeting
 * agent's `startAgentSession` returns `''` (Claude prints its own banner), so the
 * ready notice is shown only when there is text.
 *
 * `adapterName` is typed `string` because the button passes a raw callback match;
 * an unknown name makes `getThreadAdapter` throw, which the caller wrapping this
 * (the `agent_*` action) turns into a "unknown agent" answer.
 */
async function handleAgentStart(
  key: ThreadKey,
  adapterName: string,
  args?: string,
): Promise<void> {
  if (checkIsGeneral(key)) {
    await replyToThread(key, t('error.start_in_general'));
    return;
  }
  // Refuse to start an agent without a binding — same rationale as the
  // natural-language path in the text handler (plan §11 Этап 4).
  if (!state.getBinding(key)) {
    const subdirs = listAvailableSubdirs(ENV.workRoot);
    const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
    await replyToThread(key, t('thread.no_binding'), extra);
    return;
  }
  // "Claude Code" is one user-facing choice with two backends (tmux-scrape vs
  // json-stream); open the thread's picked backend, default json-stream.
  if (adapterName === 'claude') adapterName = resolveClaudeBackendName(key);
  await switchThreadAdapter(key, adapterName);
  const adapter = getThreadAdapter(key);
  if (adapter.checkIsActive(key)) {
    await replyToThread(key, t('agent.already_active', { label: adapter.label }));
    return;
  }
  const msg = await startAgentSession(key, args);
  if (msg) await replyToThread(key, msg);
}

/**
 * @description Thin wrapper extracting the trailing args from the command text
 * for {@link handleAgentStart}. The args are everything after the command word
 * (e.g. `/claude refactor src/bot.ts` → `refactor src/bot.ts`).
 */
function handleStartCommand(
  ctx: NarrowedContext<Context, Update.MessageUpdate<Message.TextMessage>>,
  key: ThreadKey,
  adapterName: 'claude' | 'opencode' | 'terminal',
): Promise<void> {
  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  return handleAgentStart(key, adapterName, args || undefined);
}

command('claude', (ctx, key) => handleStartCommand(ctx, key, 'claude'));
command(['opencode', 'oc'], (ctx, key) => handleStartCommand(ctx, key, 'opencode'));
command('terminal', (ctx, key) => handleStartCommand(ctx, key, 'terminal'));

const defaultConnectProviderId = 'openai';

interface ConnectCommandArgs {
  providerId: string;
  apiKey: string | null;
}

function checkLooksLikeProviderApiKey(value: string): boolean {
  return value.startsWith('sk-');
}

function getConnectCommandArgs(rawText: string): ConnectCommandArgs {
  const [, ...args] = stripCommandBotMention(rawText.trim()).split(/\s+/);
  if (args.length === 0) return { providerId: defaultConnectProviderId, apiKey: null };
  if (args.length === 1) {
    const onlyArg = args[0].trim();
    if (checkLooksLikeProviderApiKey(onlyArg)) {
      return { providerId: defaultConnectProviderId, apiKey: onlyArg };
    }
    return { providerId: onlyArg.toLowerCase(), apiKey: null };
  }
  return {
    providerId: args[0].trim().toLowerCase(),
    apiKey: args.slice(1).join(' ').trim(),
  };
}

function armProviderConnect(key: ThreadKey, providerId: string): void {
  const keyString = keyToString(key);
  awaitingModelSelection.delete(keyString);
  awaitingSessionSelection.delete(keyString);
  awaitingFolderName.delete(keyString);
  pendingProviderConnects.set(keyString, { providerId });
}

async function handleProviderConnectKey(
  key: ThreadKey,
  providerId: string,
  apiKey: string,
  secretMessageId: number | null,
): Promise<void> {
  if (secretMessageId !== null) {
    await deleteThreadMessage(key, secretMessageId);
  }
  const trimmedApiKey = apiKey.trim();
  if (!trimmedApiKey) {
    armProviderConnect(key, providerId);
    await replyToThread(key, t('connect.empty_key'));
    return;
  }

  const adapter = getAdapter('opencode');
  if (!adapter.connectProvider) {
    await replyToThread(key, t('connect.unsupported_backend'));
    return;
  }
  const connectError = await adapter.connectProvider(key, providerId, trimmedApiKey);
  if (connectError) {
    await replyToThread(key, connectError);
    return;
  }
  await replyToThread(key, t('connect.success', { provider: providerId }));
}

command('connect', async (ctx, key) => {
  const { providerId, apiKey } = getConnectCommandArgs(ctx.message.text);
  if (!checkIsValidProviderId(providerId)) {
    if (apiKey !== null) await deleteThreadMessage(key, ctx.message.message_id);
    await replyToThread(key, t('connect.invalid_provider', { provider: providerId }));
    return;
  }
  if (apiKey !== null) {
    await handleProviderConnectKey(key, providerId, apiKey, ctx.message.message_id);
    return;
  }
  armProviderConnect(key, providerId);
  await replyToThread(key, t('connect.prompt_key', { provider: providerId }));
});

/** Human label for a Claude backend name (the two adapters share `label`
 *  "Claude Code", so the picker/notices need a distinguishing name). */
function getClaudeBackendLabel(name: string): string {
  return name === claudeJsonStreamAdapterName ? '⚡ JSON-stream' : '🖥 Terminal-scrape';
}

/** Build the `/claude_mode` picker: one button per Claude backend, `✓` on the
 *  current one. Callback data `ccmode_<adapterName>`. */
function buildClaudeModeKeyboard(current: string) {
  const buttons = [claudeJsonStreamAdapterName, 'claude'].map((name) =>
    Markup.button.callback(
      name === current ? `${getClaudeBackendLabel(name)} ✓` : getClaudeBackendLabel(name),
      `ccmode_${name}`,
    ),
  );
  return Markup.inlineKeyboard(buttons, { columns: 1 });
}

/**
 * @description Switch a thread's Claude Code backend (tmux-scrape ↔ json-stream)
 * live. Both drive the same CLI against the same on-disk transcript, so an
 * ACTIVE session is RESUMED seamlessly on the new backend (same conversation);
 * an idle thread just records the pick for its next start. Returns the localized
 * notice to show. Assumes the thread is already on a Claude backend (callers gate).
 */
async function applyClaudeBackendSwitch(key: ThreadKey, target: string): Promise<string> {
  const label = getClaudeBackendLabel(target);
  const wasActive = getThreadAdapter(key).checkIsActive(key);
  const sessionId = state.getAgent(key)?.claudeSessionId;

  // Stops the previous backend, records the pick, keeps `claudeSessionId`.
  await switchThreadAdapter(key, target);

  if (!wasActive) return t('claudeMode.set_idle', { label });

  const decision = getWorkDirStartDecision(key);
  if (!decision.ok) return decision.message;
  const targetAdapter = getThreadAdapter(key);
  sendThreadTypingIndicator(key).catch(() => {});
  if (sessionId && targetAdapter.resumeSession) {
    markNeedsNewMessage(key);
    clearThreadContextMarker(key);
    try {
      await targetAdapter.resumeSession(key, decision.workDir, sessionId, { isWithRecentContext: true });
      await persistAdapterSessionIds(key, targetAdapter, state);
      return t('claudeMode.switched_resumed', { label });
    } catch (e) {
      console.error('[claude_mode] resume failed, starting fresh:', e instanceof Error ? e.message : e);
    }
  }
  const msg = await startAgentSession(key);
  return msg || t('claudeMode.switched_fresh', { label });
}

command('claude_mode', async (ctx, key) => {
  if (checkIsGeneral(key)) { await replyToThread(key, t('error.start_in_general')); return; }

  // Gate on the thread adapter name (the default-adapter fallback included)
  // but compare/✓ against the EFFECTIVE Claude backend — the same resolution
  // the start path uses. See `getClaudeModeAction` for the live bug this split
  // resolution fixes (a fresh thread under a legacy env-forced 'claude'
  // default no-oped the first `/claude_mode tmux`).
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim().toLowerCase();
  const action = getClaudeModeAction({
    threadAdapterName: getThreadAdapterName(key),
    effectiveBackendName: resolveClaudeBackendName(key),
    requestedBackendName: parseClaudeBackendArg(arg),
  });
  if (action.kind === 'notClaude') { await replyToThread(key, t('claudeMode.not_claude')); return; }
  if (action.kind === 'already') {
    await replyToThread(key, t('claudeMode.already', { label: getClaudeBackendLabel(action.backendName) }));
    return;
  }
  if (action.kind === 'switch') {
    await replyToThread(key, await applyClaudeBackendSwitch(key, action.backendName));
    return;
  }
  await replyToThread(
    key,
    t('claudeMode.pick', { label: getClaudeBackendLabel(action.currentBackendName) }),
    buildClaudeModeKeyboard(action.currentBackendName),
  );
});

command('model', async (ctx, key) => {
  const adapter = getThreadAdapter(key);
  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const kStr = keyToString(key);

  // numeric selection from a previous /model list
  if (/^\d+$/.test(args)) {
    const num = parseInt(args, 10);
    const modelList = threadModelLists.get(kStr);
    if (!modelList || num < 1 || num > modelList.length) {
      await replyToThread(key, 'Invalid number. Run /model to see the list.');
      return;
    }
    const selected = modelList[num - 1];
    const { message } = await applyModelSelection(adapter, key, selected);
    await replyToThread(key, message);
    return;
  }

  // direct «/model provider/name»
  if (args) {
    const { message } = await applyModelSelection(adapter, key, args);
    await replyToThread(key, message);
    return;
  }

  // list flow
  const current = adapter.getCurrentModel?.(key) || 'default';
  let models: string[] = [];
  if (adapter.getAvailableModels) {
    try { models = await adapter.getAvailableModels(); } catch (e) {
      console.error('[Bot] getAvailableModels:', e);
    }
  }
  if (models.length === 0) {
    await replyToThread(
      key,
      `Current: ${current}\n\nNo models available. Use /model <provider/model> to set manually.`,
    );
    return;
  }
  threadModelLists.set(kStr, models);
  const byProvider = groupModelsByProvider(models);
  let listText = `Current: ${current}\n\n`;
  let num = 1;
  for (const [provider, providerModels] of byProvider) {
    listText += `📦 ${provider}:\n`;
    for (const m of providerModels) {
      listText += `  ${num}. ${m.slice(provider.length + 1)}\n`;
      num++;
    }
    listText += '\n';
  }
  listText += 'Reply with number to select';
  awaitingModelSelection.add(kStr);
  await replyToThread(key, listText);
});

/**
 * @description Build the `/effort` level picker keyboard.
 *
 * One callback button per available reasoning-effort level (3 per row);
 * the level matching `current` carries a `✓` marker. Shared by the
 * `/effort` command (initial render) and the `effort_<level>` callback
 * (re-render after a press) so the marker can never drift between the two.
 */
function buildEffortKeyboard(levels: readonly string[], current: string | null) {
  const buttons = levels.map((l) =>
    Markup.button.callback(l === current ? `${l} ✓` : l, `effort_${l}`),
  );
  return Markup.inlineKeyboard(buttons, { columns: 3 });
}

command('effort', async (ctx, key) => {
  const adapter = getThreadAdapter(key);
  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();

  // Backend must support the effort contract (both methods are optional).
  if (!adapter.setEffort || !adapter.getAvailableEffortLevels) {
    await replyToThread(key, t('effort.unsupported_backend', { label: adapter.label }));
    return;
  }
  // No `checkIsActive` gate — like `/model`, effort works pre-session: the
  // adapter persists the pick (OpenCode/Claude) and a later session replays it.
  // The picker lists the PROSPECTIVE model's levels; the direct-set path
  // surfaces the adapter's own notice (e.g. Claude's `effort.start_agent_first`).

  // Direct set: `/effort <level>`. The adapter validates (Claude against its
  // canonical set, OpenCode against the model's variants) and returns a
  // user-facing notice string on any non-success.
  if (args) {
    const err = await adapter.setEffort(key, args);
    if (err) {
      await replyToThread(key, err);
    } else {
      await replyToThread(key, t('effort.set_success', { level: args }));
      await updatePinnedStatus(key).catch(() => {});
    }
    return;
  }

  // No arg: show current effort + a button per available level.
  let levels: string[] = [];
  try {
    levels = await adapter.getAvailableEffortLevels(key);
  } catch (e) {
    console.error('[Bot] getAvailableEffortLevels:', e);
  }
  if (levels.length === 0) {
    // Empty means the current model declares no variants (OpenCode) or the
    // backend reports no levels — not an error, just nothing to pick.
    await replyToThread(key, t('effort.not_available'));
    return;
  }
  const cur = adapter.getEffort?.(key) ?? null;
  await replyToThread(
    key,
    t('effort.choose', { current: cur ?? t('effort.current_none') }),
    buildEffortKeyboard(levels, cur),
  );
});

// ── /thinking — per-topic chain-of-thought verbosity (both backends, S5) ─────

/**
 * @description Build a display-mode picker keyboard shared by ALL FOUR mode
 * commands (`/thinking`, `/tool_results`, `/subagent`, `/verbosity`): one
 * callback button per unified mode, the `marked` mode (if any) carrying a `✓`.
 * The four families differ only in their i18n label namespace and callback
 * prefix, so one builder removes the four near-identical copies (S2 review
 * note). `marked` is nullable for `/verbosity`'s mixed ("custom") state, where
 * no single level matches — then no button is marked.
 *
 * @param i18nGroup the mode-label namespace (`thinking`/`toolResults`/`subagent`/`verbosity`).
 * @param callbackPrefix the action prefix (`think`/`toolres`/`subag`/`verb`).
 * @param marked the mode to mark with `✓`, or null for no mark.
 */
function buildDisplayModeKeyboard(
  i18nGroup: string,
  callbackPrefix: string,
  marked: DisplayVerbosityMode | null,
) {
  const buttons = displayVerbosityModeOptions.map((mode) =>
    Markup.button.callback(
      mode === marked ? `${t(`${i18nGroup}.mode.${mode}`)} ✓` : t(`${i18nGroup}.mode.${mode}`),
      `${callbackPrefix}_${mode}`,
    ),
  );
  return Markup.inlineKeyboard(buttons, { columns: displayVerbosityModeOptions.length });
}

/**
 * @description Persist a new thinking mode for `key` and apply it best-effort to
 * the live reasoning stream (it always governs the NEXT one). Shared by the
 * `/thinking <mode>` direct form and the `think_<mode>` callback so the two
 * paths can never diverge.
 */
async function applyThinkingMode(key: ThreadKey, mode: DisplayVerbosityMode): Promise<void> {
  await state.setDisplayPref(key, 'thinking', mode);
}

command('thinking', async (ctx, key) => {
  // No backend gate (un-gated in S5): the pref drives both backends now —
  // OpenCode's thinking SSE render and Claude's scrape-chunk relay routing.
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim().toLowerCase();
  const current = state.getDisplayPrefs(key).thinking;

  if (arg) {
    // Normalization keeps retired names (`detailed`/`brief`/`hide`) working as
    // hidden aliases; the reply always names the NEW mode.
    const mode = normalizeDisplayVerbosityMode(arg);
    if (!mode) {
      await replyToThread(key, t('thinking.invalid_mode', {
        mode: arg,
        valid: displayVerbosityModeOptions.join(', '),
      }));
      return;
    }
    await applyThinkingMode(key, mode);
    await replyToThread(key, t('thinking.set_success', { mode: t(`thinking.mode.${mode}`) }));
    return;
  }

  // No arg: show current mode + a button per mode.
  await replyToThread(
    key,
    t('thinking.choose', { current: t(`thinking.mode.${current}`) }),
    buildDisplayModeKeyboard('thinking', 'think', current),
  );
});

// ── /tool_results — per-topic tool-output verbosity (OpenCode only, S3) ──────
// Telegram bot commands cannot contain '-', so the plan's "/tool-results" is
// registered as `tool_results` (same convention as /rename_session).

/**
 * @description Persist a new tool-results mode for `key` — it governs every
 * `toolResult` event from now on (the mode is resolved per event, so a live
 * turn picks it up immediately). Shared by the `/tool_results <mode>` direct
 * form and the `toolres_<mode>` callback so the two paths can never diverge.
 */
async function applyToolResultMode(key: ThreadKey, mode: DisplayVerbosityMode): Promise<void> {
  await state.setDisplayPref(key, 'toolResults', mode);
}

command('tool_results', async (ctx, key) => {
  // No backend gate (un-gated in S4): the pref drives both backends now —
  // OpenCode's `toolResult` SSE render and Claude's scrape-chunk relay routing.
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim().toLowerCase();
  const current = state.getDisplayPrefs(key).toolResults;

  if (arg) {
    // Normalization keeps the retired `hide` name working as a hidden alias;
    // the reply always names the NEW mode.
    const mode = normalizeDisplayVerbosityMode(arg);
    if (!mode) {
      await replyToThread(key, t('toolResults.invalid_mode', {
        mode: arg,
        valid: displayVerbosityModeOptions.join(', '),
      }));
      return;
    }
    await applyToolResultMode(key, mode);
    await replyToThread(key, t('toolResults.set_success', { mode: t(`toolResults.mode.${mode}`) }));
    return;
  }

  // No arg: show current mode + a button per mode.
  await replyToThread(
    key,
    t('toolResults.choose', { current: t(`toolResults.mode.${current}`) }),
    buildDisplayModeKeyboard('toolResults', 'toolres', current),
  );
});

// ── /subagent — per-topic sub-agent transcript verbosity (both backends) ────
// `minimal` and `short` are equivalent here (v1): both are status-only — the
// user always wants the "working" indicator visible (locked decision), so no
// mode ever hides it. Unlike /thinking and /tool_results (OpenCode-only
// render prefs), the pref is backend-agnostic: OpenCode branches its
// child-session SSE parts on it, Claude tails the on-disk sub-agent
// transcripts in `full` mode (plan 2026-06-11 S2/S3).

/**
 * @description Persist a new sub-agent mode for `key` — the adapter reads it
 * per child event (the injected reader), so a delegation already streaming
 * picks the change up immediately. Shared by the `/subagent <mode>` direct
 * form and the `subag_<mode>` callback so the two paths can never diverge.
 */
async function applySubagentMode(key: ThreadKey, mode: DisplayVerbosityMode): Promise<void> {
  await state.setDisplayPref(key, 'subagent', mode);
}

command('subagent', async (ctx, key) => {
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim().toLowerCase();
  const current = state.getDisplayPrefs(key).subagent;

  if (arg) {
    // Normalization keeps the retired `compact` name working as a hidden
    // alias (→ `short`); the reply always names the NEW mode.
    const mode = normalizeDisplayVerbosityMode(arg);
    if (!mode) {
      await replyToThread(key, t('subagent.invalid_mode', {
        mode: arg,
        valid: displayVerbosityModeOptions.join(', '),
      }));
      return;
    }
    await applySubagentMode(key, mode);
    await replyToThread(key, t('subagent.set_success', { mode: t(`subagent.mode.${mode}`) }));
    return;
  }

  // No arg: show current mode + a button per mode.
  await replyToThread(
    key,
    t('subagent.choose', { current: t(`subagent.mode.${current}`) }),
    buildDisplayModeKeyboard('subagent', 'subag', current),
  );
});

// ── /verbosity — per-topic macro over ALL THREE display prefs ───────────────
// Sets thinking + toolResults + subagent to one level at once; the individual
// commands keep point-overriding afterwards (they all write the same store,
// last write per pref wins — no extra mechanism). Like /subagent there is no
// backend or session gate: the prefs are bot-side rendering state, valid on
// both backends and with no session running.

/**
 * @description Render the picker's "current state" fragment: the shared mode
 * label when all three prefs agree, else the i18n'd "custom" line spelling
 * out each pref so the user sees WHAT is mixed.
 */
function formatVerbosityCurrent(prefs: ResolvedThreadDisplayPrefs): string {
  const matched = getUniformVerbosityLevel(prefs);
  if (matched) return t(`verbosity.mode.${matched}`);
  return t('verbosity.custom', {
    thinking: t(`verbosity.mode.${prefs.thinking}`),
    toolResults: t(`verbosity.mode.${prefs.toolResults}`),
    subagent: t(`verbosity.mode.${prefs.subagent}`),
  });
}

/**
 * @description Apply ONE level to all three display prefs (the `/verbosity`
 * macro). Reuses the per-command apply helpers so the macro and the point
 * commands can never write through different paths.
 */
async function applyVerbosityLevel(key: ThreadKey, mode: DisplayVerbosityMode): Promise<void> {
  await applyThinkingMode(key, mode);
  await applyToolResultMode(key, mode);
  await applySubagentMode(key, mode);
}

command('verbosity', async (ctx, key) => {
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim().toLowerCase();

  if (arg) {
    // Normalization keeps the retired names (`detailed`/`brief`/`hide`/
    // `compact`) working as hidden aliases; the reply always names the NEW mode.
    const mode = normalizeDisplayVerbosityMode(arg);
    if (!mode) {
      await replyToThread(key, t('verbosity.invalid_mode', {
        mode: arg,
        valid: displayVerbosityModeOptions.join(', '),
      }));
      return;
    }
    await applyVerbosityLevel(key, mode);
    await replyToThread(key, t('verbosity.set_success', { mode: t(`verbosity.mode.${mode}`) }));
    return;
  }

  // No arg: show the current state (exact level, or "custom" with the three
  // values spelled out) + a button per level.
  const prefs = state.getDisplayPrefs(key);
  await replyToThread(
    key,
    t('verbosity.choose', { current: formatVerbosityCurrent(prefs) }),
    buildDisplayModeKeyboard('verbosity', 'verb', getUniformVerbosityLevel(prefs)),
  );
});

// Manually rename the CURRENT thread's session. Adapter-owned capability
// (optional method, like /model): OpenCode renames via `PATCH /session/:id`;
// Claude has no title concept and is told "not supported". Requires a live
// session — without one the user is told to start an agent first.
command('rename_session', async (ctx, key) => {
  const adapter = getThreadAdapter(key);

  if (!adapter.renameSession) {
    await replyToThread(key, t('rename_session.unsupported_backend', { label: adapter.label }));
    return;
  }

  // Title is the whole text after the command, trimmed and capped to the same
  // length the auto-name snippet uses (single source of truth).
  const title = ctx.message.text.split(' ').slice(1).join(' ').trim().slice(0, sessionTitleSnippetMaxLength);
  if (!title) {
    await replyToThread(key, t('rename_session.usage'));
    return;
  }

  const err = await adapter.renameSession(key, title);
  if (err) {
    await replyToThread(key, err);
    return;
  }
  await replyToThread(key, t('rename_session.success', { title }));
  await updatePinnedStatus(key).catch(() => {});
});

/**
 * @description Build the agent-picker keyboard.
 *
 * One callback button per available adapter (2 per row); the adapter whose
 * name matches `currentName` carries a `✓` marker. Shared by the `/start` +
 * post-bind welcome buttons (initial render) and the `agent_<name>` callback
 * (re-render after a press) so the marker can never drift between the two
 * (B16, mirrors B12).
 */
function buildAgentKeyboard(
  available: ReadonlyArray<{ name: string; label: string }>,
  currentName: string,
) {
  const buttons = available.map(a =>
    Markup.button.callback(a.name === currentName ? `${a.label} ✓` : a.label, `agent_${a.name}`),
  );
  return Markup.inlineKeyboard(buttons, { columns: 2 });
}

/** Max chars of a session title rendered on an inline resume button. */
const sessionButtonTitleMaxLength = 40;

/**
 * @description Shared `/sessions` (and `/resume` synonym) handler.
 *
 * Lists resumable sessions for the thread's bound folder as BOTH numbered
 * text and tappable inline buttons, then arms session-pick mode so a bare
 * digit reply resumes the matching session. Guards mirror the `resume_<idx>`
 * button: topical-thread-only + binding required. Reused by the `/sessions`
 * and `/resume` commands and the `open_sessions` inline button so the picker
 * source stays single-sourced.
 */
async function handleSessionsList(key: ThreadKey): Promise<void> {
  if (checkIsGeneral(key)) {
    await replyToThread(key, t('cb.resume_only_topical'));
    return;
  }
  if (!state.getBinding(key)) {
    const subdirs = listAvailableSubdirs(ENV.workRoot);
    const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
    await replyToThread(key, t('thread.no_binding'), extra);
    return;
  }

  // Guarded by the `!state.getBinding` early-return above, so workDir is
  // non-null here; the explicit check keeps the no-fallback contract honest.
  const workDirDecision = getWorkDirStartDecision(key);
  if (!workDirDecision.ok) {
    await replyToThread(key, workDirDecision.message);
    return;
  }
  const workDir = workDirDecision.workDir;
  const adapter = getThreadAdapter(key);
  let sessions: AgentSession[];
  try {
    sessions = await adapter.getSessions(key, workDir);
  } catch (e) {
    console.error('[Bot] getSessions:', e);
    await replyToThread(key, t('session.load_failed'));
    return;
  }

  if (sessions.length === 0) {
    await replyToThread(key, t('session.none'));
    return;
  }

  // Audit S4 / #7: stash the full id list per thread so the `resume_<idx>`
  // callback (and the digit reply) can recover the full id — Telegram's
  // callback_data cap would otherwise truncate long OpenCode session ids.
  const shown = sessions.slice(0, sessionsDisplayLimit);
  const kStr = keyToString(key);
  threadSessionLists.set(kStr, shown.map(s => s.id));
  awaitingSessionSelection.add(kStr);

  const lines = [t('session.list_header', { label: adapter.label })];
  const buttons = shown.map((s, idx) => {
    const timeAgo = formatTimeAgo(s.updatedAt);
    const title = (s.title || s.id).slice(0, sessionButtonTitleMaxLength);
    lines.push(`${idx + 1}. ${title} (${timeAgo})`);
    return Markup.button.callback(`${title} (${timeAgo})`, `resume_${idx}`);
  });
  lines.push('');
  lines.push(t('session.list_footer', { max: shown.length }));

  await replyToThread(key, lines.join('\n'), Markup.inlineKeyboard(buttons, { columns: 1 }));
}

/**
 * @description Resume the session at `idx` in the thread's last shown list.
 *
 * Core shared by the `resume_<idx>` inline button and the digit-reply path.
 * Recovers the full session id from `threadSessionLists`; if the cache was
 * lost (bot restarted between showing the list and the pick), reports it
 * via `onExpired`. Returns the user-facing result message to send, or
 * `null` when `onExpired` already handled the stale-cache case.
 */
async function resumeSessionByIndex(
  key: ThreadKey,
  idx: number,
  onExpired: () => Promise<void>,
): Promise<string | null> {
  const list = threadSessionLists.get(keyToString(key));
  if (!list || idx < 0 || idx >= list.length) {
    await onExpired();
    return null;
  }
  const sessionId = list[idx];
  // Pick-mode is armed only by `handleSessionsList` (binding-gated), but a
  // binding can vanish (/unbind) between listing and picking — resume must
  // never run against an unbound thread (no WORK_ROOT fallback).
  const workDirDecision = getWorkDirStartDecision(key);
  if (!workDirDecision.ok) return workDirDecision.message;
  const workDir = workDirDecision.workDir;
  const adapter = getThreadAdapter(key);
  markNeedsNewMessage(key);
  try {
    // The ONLY resume path that posts the "last N messages" context block —
    // silent re-attach (bot restart) and crash recovery must stay quiet.
    await adapter.resumeSession(key, workDir, sessionId, { isWithRecentContext: true });
    // Persist the PICKED id — without this the next restart re-attaches to
    // whatever id the last fresh start wrote, silently dropping the user's
    // pick (live incident 2026-06-10).
    await persistAdapterSessionIds(key, adapter, state);
    return t('session.resumed');
  } catch (e) {
    return t('session.resume_failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

command(['sessions', 'resume'], (_ctx, key) => handleSessionsList(key));

/**
 * @description `/quit-all` — kill every active agent across every thread.
 *
 * General-only because it's a workspace-wide operation that's easy to
 * fire by mistake; restricting to General + needing an explicit command
 * matches the «admin-style» surface (see `/doctor`, `/status` global,
 * `/list`). Plan §20.x / §11 Этап 7.
 *
 * We walk persisted bindings (`state.listBindings`) rather than the
 * adapter's in-memory session map so we catch sessions whose adapter
 * instance has been replaced after a re-attach. For each, ask the
 * adapter that thread is configured for and stop only if it's active —
 * idempotent, so re-running is safe.
 */
command(['quit-all', 'quitall'], async (_ctx, key) => {
  if (!checkIsGeneral(key)) {
    await replyToThread(key, t('quit_all.general_only'));
    return;
  }

  // Same sweep semantics as `/quit`: kill any adapter that's actually
  // active for this key, not only the one the thread map points at —
  // otherwise a desynced thread (state says opencode but claude tmux is
  // running) gets counted as inactive and skipped. `attempted` /
  // `stopped` count *adapter sessions*, not threads, so the user-facing
  // summary preserves the "M of N" semantic when a stop call fails.
  let stopped = 0;
  let active = 0;
  for (const { key: bKey } of state.listBindings()) {
    const result = stopAllAdaptersFor(bKey);
    active += result.attempted;
    stopped += result.stopped.length;
    // Same release-for-good semantics as `/quit`, per swept thread.
    await state.clearAgentSessionIds(bKey);
  }

  if (active === 0) {
    await replyToThread(key, t('quit_all.none_active'));
    return;
  }
  await replyToThread(key, t('quit_all.summary', { stopped: String(stopped), total: String(active) }));
});

/**
 * Delay between the two `SIGINT`s that `/quit` sends to Claude CLI.
 *
 * Claude CLI debounces back-to-back Ctrl+C: the second press has to
 * land AFTER the first one has been rendered ("press Ctrl+C again to
 * exit") but BEFORE the prompt clears. 250ms is comfortably inside
 * that window on every machine we've tried — tighter values
 * occasionally collapse both presses into a single keystroke.
 */
const CLAUDE_DOUBLE_SIGINT_GAP_MS = 250;

// `/quit` (alias `/q`) — THE session-end command: gracefully ends the
// current thread's agent for every adapter shape.
// Two distinct paths because the agents themselves have very
// different "exit" semantics:
//
// • Claude CLI runs in a tmux session. Its canonical exit is two
//   Ctrl+C in quick succession (the first cancels the current turn,
//   the second leaves the CLI). We replay that by sending `SIGINT`
//   through the adapter twice with a small gap — softer than a
//   `tmux kill-session`.
//
// • Every other adapter (OpenCode HTTP server, the raw terminal shell,
//   any future backend) has no "double Ctrl+C" to leave cleanly — the
//   only real teardown is `stopSession` (abort the running generation /
//   `tmux kill-session`, drop the session). We call it directly so
//   `/quit` behaves like a real exit instead of two no-op aborts.
command(['quit', 'q'], async (_ctx, key) => {
  // User took over (/quit) → cancel any pending API-error retry silently. /quit
  // does NOT go through releaseThreadSession (it stops adapters + clears ids
  // inline), so the cancel is wired here explicitly.
  cancelApiRetry(key);
  clearAuthNotice(key); // /quit teardown → retire any pinned logged-out notice
  const adapter = getThreadAdapter(key);
  const adapterName = getThreadAdapterName(key);
  const primaryActive = adapter.checkIsActive(key);

  // Defensive: any *other* adapter that's also active for this thread is
  // a leftover from a previous botched switch. Kill it first so it can't
  // keep streaming after the user's "quit". Re-using the sweep helper
  // instead of an open-coded loop avoids drift between the call sites.
  const otherAdapters = getKnownAdapterNames().filter(n => n !== adapterName);
  stopAllAdaptersFor(key, otherAdapters);

  if (!primaryActive) {
    await replyToThread(key, 'No agent running');
    return;
  }
  markNeedsNewMessage(key);

  // Close any still-pending OpenCode question on the server BEFORE the teardown
  // below (a stopped session can't accept the reject; an unrejected question
  // re-surfaces on the next reattach). No-op for Claude / no pending question.
  adapter.rejectQuestion?.(key);

  if (adapterName === 'claude') {
    adapter.sendSignal(key, 'SIGINT');
    await new Promise((r) => setTimeout(r, CLAUDE_DOUBLE_SIGINT_GAP_MS));
    adapter.sendSignal(key, 'SIGINT');
    // Explicit quit releases the session for good — no auto-reattach later.
    await state.clearAgentSessionIds(key);
    await replyToThread(key, t('agent.exit_signal_sent', { label: adapter.label }));
    return;
  }

  // OpenCode, terminal, any future adapter: tear down via stopSession.
  adapter.stopSession(key);
  // Explicit quit releases the session for good — no auto-reattach later.
  await state.clearAgentSessionIds(key);
  await replyToThread(key, t('agent.stopped', { label: adapter.label }));
});

// ── tmux-style controls (Claude CLI) ──

command('c', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  markNeedsNewMessage(key);
  adapter.sendSignal(key, 'SIGINT');
  await replyToThread(key, 'Ctrl+C sent');
});

command('y', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  if (adapter.checkIsActive(key)) {
    markNeedsNewMessage(key);
    adapter.sendInput(key, 'y');
  }
});

command('n', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  if (adapter.checkIsActive(key)) {
    markNeedsNewMessage(key);
    adapter.sendInput(key, 'n');
  }
});

command('enter', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  if (adapter.sendEnter) {
    markNeedsNewMessage(key);
    adapter.sendEnter(key);
  } else {
    await replyToThread(key, `Not supported for ${adapter.label}`);
  }
});

command('up', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  if (adapter.sendArrow) adapter.sendArrow(key, 'Up');
  else await replyToThread(key, `Not supported for ${adapter.label}`);
});

command('down', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  if (adapter.sendArrow) adapter.sendArrow(key, 'Down');
  else await replyToThread(key, `Not supported for ${adapter.label}`);
});

command('tab', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  if (adapter.sendTab) adapter.sendTab(key);
  else await replyToThread(key, `Not supported for ${adapter.label}`);
});

command(['esc', 'escape'], async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  if (adapter.sendEscape) {
    markNeedsNewMessage(key);
    adapter.sendEscape(key);
  } else {
    await replyToThread(key, `Not supported for ${adapter.label}`);
  }
});

command('output', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  if (!adapter.getFullOutput) {
    await replyToThread(key, `Not supported for ${adapter.label}`);
    return;
  }
  const output = adapter.getFullOutput(key, 500);
  if (!output) {
    await replyToThread(key, 'Agent not running or no output');
    return;
  }
  const chunks: string[] = [];
  let current = '';
  for (const line of output.split('\n')) {
    if (current.length + line.length + 1 > 4000) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current);
  // Audit S11 / #26: the first chunk used to land via `replyToThread`
  // without flipping `needsNewMessage`, so it could overwrite a fresh
  // agent edit by accident. Also surface truncation explicitly so the
  // user knows N chunks were dropped instead of silently seeing only 5.
  markNeedsNewMessage(key);
  const MAX_CHUNKS = 5;
  const visible = chunks.slice(0, MAX_CHUNKS);
  const dropped = chunks.length - visible.length;
  for (let i = 0; i < visible.length; i++) {
    let chunk = visible[i] || '(empty)';
    if (i === visible.length - 1 && dropped > 0) {
      chunk += `\n\n…and ${dropped} more chunk${dropped === 1 ? '' : 's'} omitted`;
    }
    await replyToThread(key, chunk);
  }
});

/**
 * @description `/trace` — toggle the output-trace recorder at runtime.
 *
 *   /trace on        → trace THIS topic's events
 *   /trace off       → stop tracing this topic
 *   /trace on all    → trace every thread (cross-thread forensics)
 *   /trace off all   → clear the all-threads flag AND the per-thread set
 *   /trace           → status: this thread on/off, all-flag, traced count
 *
 * Replaces the boot-time `OUTPUT_TRACE` env var. The toggle is persisted in
 * `state.json` and re-seeded into `outputTrace.ts` at boot, so a `/trace`
 * setting survives a hot rebuild mid-debug. Lifecycle-independent: nothing in
 * the session lifecycle (stop, /new, /quit, resume, /unbind) touches it.
 */
command('trace', async (ctx, key) => {
  const args = ctx.message.text.split(' ').slice(1).map(a => a.toLowerCase()).filter(Boolean);
  const config = state.getTraceConfig();
  const keyStr = keyToString(key);

  // Bare `/trace` — status only.
  if (args.length === 0) {
    const onLabel = t('trace.statusOnLabel');
    const offLabel = t('trace.statusOffLabel');
    const isThisThreadOn = config.allThreads || config.threadKeys.includes(keyStr);
    await replyToThread(key, t('trace.statusReply', {
      thisThread: isThisThreadOn ? onLabel : offLabel,
      allThreads: config.allThreads ? onLabel : offLabel,
      count: config.threadKeys.length,
    }));
    return;
  }

  const [action, scope] = args;
  const isAllScope = scope === 'all';
  if ((action !== 'on' && action !== 'off') || (scope !== undefined && !isAllScope)) {
    await replyToThread(key, t('trace.usageHint'));
    return;
  }

  let nextConfig: { allThreads: boolean; threadKeys: string[] };
  let reply: string;
  if (action === 'on' && isAllScope) {
    nextConfig = { allThreads: true, threadKeys: config.threadKeys };
    reply = t('trace.onAllThreadsReply');
  } else if (action === 'off' && isAllScope) {
    nextConfig = { allThreads: false, threadKeys: [] };
    reply = t('trace.offAllThreadsReply');
  } else if (action === 'on') {
    nextConfig = { allThreads: config.allThreads, threadKeys: [...config.threadKeys, keyStr] };
    reply = t('trace.onThisThreadReply');
  } else {
    nextConfig = {
      allThreads: config.allThreads,
      threadKeys: config.threadKeys.filter(k => k !== keyStr),
    };
    reply = t('trace.offThisThreadReply');
  }

  // Persist first, then seed the in-memory writer from the normalised config so
  // the two never drift (the store dedups/sorts the thread keys).
  await state.setTraceConfig(nextConfig);
  setTraceConfig(state.getTraceConfig());
  await replyToThread(key, reply);
});

/**
 * @description `/timestamps` — toggle the per-thread prompt-timestamp injection.
 *
 *   /timestamps on   → prepend the send-time (local-offset ISO top line) to
 *                      every prompt forwarded to THIS topic's agent
 *   /timestamps off  → stop injecting
 *   /timestamps      → status: this thread on/off
 *
 * Agent-facing only: the line rides the forwarded prompt like the thread-context
 * preamble and is never posted to the topic. Persisted in `state.json`
 * (mirrors `/trace`'s shape), lifecycle-independent — nothing in the session
 * lifecycle touches it. Default OFF. Use case: long multi-day sessions where
 * the agent needs absolute time to interpret "yesterday" / "2-3 days ago".
 */
command('timestamps', async (ctx, key) => {
  const args = ctx.message.text.split(' ').slice(1).map(a => a.toLowerCase()).filter(Boolean);

  // Bare `/timestamps` — status only.
  if (args.length === 0) {
    await replyToThread(
      key,
      t(state.checkIsTimestampsEnabled(key) ? 'timestamps.statusOnReply' : 'timestamps.statusOffReply'),
    );
    return;
  }

  const [action] = args;
  if ((action !== 'on' && action !== 'off') || args.length > 1) {
    await replyToThread(key, t('timestamps.usageHint'));
    return;
  }

  await state.setTimestampsEnabled(key, action === 'on');
  await replyToThread(key, t(action === 'on' ? 'timestamps.onReply' : 'timestamps.offReply'));
});

/**
 * @description `/schedule` (S7) — a thin prompt wrapper. The bot owns NO
 * scheduling logic: it wraps the user's request in an agent-facing instruction
 * (forward template with args, interview template without) and delivers it
 * EXACTLY like a plain user message — reusing the agent session or starting one
 * with the thread's last-used agent. All the intelligence (parse the time,
 * call schedule_create / schedule_list / schedule_cancel) lives in the agent +
 * the bot's MCP tools (S5/S6). Until those land the agent simply replies it
 * can't schedule — an accepted intermediate state.
 *
 *   /schedule <free text>  → forward template wrapping {text}
 *   /schedule              → interview template (agent asks what + when)
 *
 * Routing mirrors the plain-text handler via the shared choke points:
 * `ensureAgentSession` does the bind-check + start (returns `unbound` →
 * bind-required reply, same as every agent-facing path), then
 * `deliverPromptOrBuffer` forwards (active) or buffers (mid-startup), reading
 * the startup window AFTER the ensure so a freshly-started session forwards.
 */
command('schedule', async (ctx, key) => {
  const text = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const wrappedPrompt = text
    ? t('schedule.forwardPromptTemplate', { text })
    : t('schedule.interviewPromptTemplate');

  const result = await ensureAgentSession(key);
  if (!result.ok) {
    await replyToThread(key, result.message);
    return;
  }
  // Fresh-start notice (empty when the session was already active / starting).
  if (result.message) await replyToThread(key, result.message);

  const isStarting = startupPromptBuffer.checkIsStarting(keyToString(key));
  await deliverPromptOrBuffer(key, wrappedPrompt, isStarting);
});

/**
 * @description `/clear` — delete the bot's messages in this thread.
 *
 * Plan §11 Этап 3 / §13.20 (T6):
 *   - Read ids from state.json (not in-memory `messageIds`).
 *   - Chunk by 100 (Bot API limit on deleteMessages).
 *   - Surface 48h truncation in the reply so the user understands why
 *     not all messages disappear (U2).
 *   - Requires `can_delete_messages` admin right; we degrade gracefully
 *     if Telegram says we can't.
 */
// `/clear_messages` (formerly `/clear`): delete the thread's Telegram
// messages. The bare `/clear` was freed for the agent — it now falls through
// to the verbatim-forward path (Claude TUI wipes its context, OpenCode treats
// it as plain text), and that path resets the thread-context preamble marker.
command('clear_messages', async (ctx, key) => {
  // Audit S11 / #19: snapshot and clear under the state lock so the
  // agent's concurrent `pushMessageId` writes between snapshot and
  // wipe don't get dropped without being deleted. New ids pushed
  // during the delete loop stay in state and get cleaned by the next
  // `/clear` invocation.
  const currentMsgId = ctx.message.message_id;
  const all = await state.withLock(key, async () => {
    const snap = state.getMessageIds(key);
    await state.clearMessageIds(key);
    return [...snap, currentMsgId];
  });
  if (all.length === 0) {
    await replyToThread(key, t('clearMessages.no_messages'));
    return;
  }

  let deleted = 0;
  const batchSize = 100;
  for (let i = 0; i < all.length; i += batchSize) {
    const batch = all.slice(i, i + batchSize);
    try {
      await enqueueSend(key, () =>
        bot.telegram.callApi('deleteMessages', {
          chat_id: key.chatId,
          message_ids: batch,
        }),
      );
      deleted += batch.length;
    } catch (e) {
      const desc = checkIsApiError(e) ? getErrorDescription(e) : String(e);
      if (/not enough rights|can't delete/i.test(desc)) {
        await replyToThread(key, t('error.tg.perm.delete'));
        return;
      }
      // `deleteMessages` is all-or-nothing per batch: a single un-deletable
      // id (>48h, already gone) sinks every fresh id alongside it. Fall back
      // to per-id deletes so we recover what we can. (Review HIGH #1.)
      for (const id of batch) {
        try {
          await enqueueSend(key, () => bot.telegram.deleteMessage(key.chatId, id));
          deleted += 1;
        } catch {
          // Expired / already deleted — drop silently.
        }
      }
    }
  }

  const ms = getThreadMessageState(key);
  ms.lastMessageId = null;
  ms.lastMessageText = null;
  ms.needsNewMessage = true;

  console.log(`[clear_messages] ${keyToString(key)}: deleted ${deleted}/${all.length}`);
  await replyToThread(key, t('clearMessages.summary', { deleted, total: all.length }));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Bot commands list (text vs slash) — known slash commands the bot handles
// ═══════════════════════════════════════════════════════════════════════════════

// Slash tokens the text handler must NOT forward to the agent. Covers every
// bot-owned command (incl. the raw-key controls c/y/n/enter/up/down/tab/esc)
// PLUS the retired commands (agent/cancel/unbind/where/stop/stopall/stop-all):
// their handlers were removed, but keeping the tokens here makes a stray
// `/where` (or `/stop`) inert instead of typing a meaningless prompt into the
// agent.
const botCommands = new Set([
  'start', 'claude', 'opencode', 'oc', 'terminal', 'agent', 'sessions', 'resume', 'cancel', 'model', 'connect',
  'stop', 'stopall', 'stop-all', 'status', 'c', 'y', 'n', 'enter', 'up', 'down', 'tab', 'esc', 'escape', 'output', 'clear_messages',
  'bind', 'unbind', 'where', 'ls', 'list', 'new', 'clear_session', 'whoami', 'version', 'help',
  'doctor', 'mcp', 'rename_session', 'trace', 'timestamps', 'schedule', 'thinking', 'tool_results',
  'subagent', 'claude_mode',
]);

/**
 * @description The bare `/clear` is no longer bot-owned (it was renamed to
 * `/clear_messages`); it's forwarded verbatim to the agent. Forwarding it
 * resets the thread-context preamble marker so the next prompt re-informs the
 * agent of its context after its own context is wiped.
 */
const forwardedClearCommand = '/clear';

// ═══════════════════════════════════════════════════════════════════════════════
//  Text message handler — main conversational entrypoint
// ═══════════════════════════════════════════════════════════════════════════════

bot.on(message('text'), async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) return;

  // User took over before a pending API-error retry fired → cancel it silently
  // (no give-up notice). Fires for EVERY authorised inbound text — a plain
  // prompt AND an owned slash-command — before the bot-command early-return.
  cancelApiRetry(key);

  // In groups Telegram appends `@botusername` to slash commands
  // (`/compact` → `/compact@my_bot`). Strip it up-front so BOTH the
  // bot-owned-command check below AND the verbatim forward to the agent see
  // the bare command — otherwise the agent's CLI gets `/compact@my_bot` and
  // silently ignores it (the long-standing /compact bug).
  const text = stripCommandBotMention(ctx.message.text.trim());
  const kStr = keyToString(key);

  // Slash commands we don't own → forward to the agent (e.g. `/compact`, `/help`).
  if (text.startsWith('/')) {
    const cmd = text.slice(1).split(' ')[0].split('@')[0].toLowerCase();
    if (botCommands.has(cmd)) return;
  }

  // Always track inbound message ids so /clear can delete user messages too.
  await state.pushMessageId(key, ctx.message.message_id);

  const pendingProviderConnect = pendingProviderConnects.get(kStr);
  if (pendingProviderConnect && text.startsWith('/')) {
    pendingProviderConnects.delete(kStr);
    await replyToThread(key, t('connect.cancelled'));
  } else if (pendingProviderConnect) {
    pendingProviderConnects.delete(kStr);
    await handleProviderConnectKey(
      key,
      pendingProviderConnect.providerId,
      text,
      ctx.message.message_id,
    );
    return;
  }

  // Session is mid-startup → buffer the prompt and replay it once the agent is
  // ready, instead of dropping it into the "no agent running" guidance below.
  if (startupPromptBuffer.checkIsStarting(kStr)) {
    const isFirstBuffered = startupPromptBuffer.addPrompt(kStr, text);
    if (isFirstBuffered) {
      await replyToThread(key, t('agent.queued_starting', { label: getThreadAdapter(key).label }));
    }
    return;
  }

  // Audit S2 / #5: if `forum_topic_created` was emitted by a non-allowed
  // admin, we stashed the topic name in `pendingTopicNames` without
  // binding. Now that an allowed user is engaging this thread, retry the
  // fuzzy auto-bind once. Failure leaves the binding empty — text below
  // will route to the picker UX, same as on a topic without a cache hit.
  // Skip entirely when the thread is armed for create-folder: the user
  // explicitly chose to create a new folder, so this message is the name —
  // don't let a stale topic-name cache hijack it into a different bind.
  if (!checkIsGeneral(key) && !state.getBinding(key) && !awaitingFolderName.has(kStr)) {
    const pending = pendingTopicNames.get(kStr);
    if (pending && Date.now() - pending.ts < PENDING_TOPIC_NAME_TTL_MS) {
      const match = findAutobindSubdir(pending.name, listAvailableSubdirs(ENV.workRoot));
      if (match) {
        try {
          const subdir = validateSubdir(ENV.workRoot, match);
          // The pending entry carries the topic name (cached at creation) —
          // copy it onto the binding for the thread-context preamble (S1).
          await state.setBinding(key, subdir, pending.name ? { topicName: pending.name } : {});
          pendingTopicNames.delete(kStr);
          await replyToThread(key, t('thread.welcome_bound', { subdir }));
          await sendBindingWelcome(key, subdir);
        } catch (e) {
          console.warn(`[deferred-autobind] failed for "${match}":`, e);
          pendingTopicNames.delete(kStr);
        }
      } else {
        pendingTopicNames.delete(kStr);
      }
    } else if (pending) {
      // TTL expired — clean the entry.
      pendingTopicNames.delete(kStr);
    }
  }

  const adapter = getThreadAdapter(key);

  // Create-folder mode (armed by the «create new folder» button in the /bind
  // picker). The whole next message is the folder name — checked BEFORE the
  // numeric model / session branches so a numeric folder name (e.g. "2025")
  // isn't mistaken for a pick. /cancel and other commands already exited above
  // (slash commands return early), so reaching here means real name text. An
  // invalid name keeps the thread armed for a retry; success disarms it.
  if (awaitingFolderName.has(kStr)) {
    const { ok } = await createAndBindFolder(key, text);
    if (ok) awaitingFolderName.delete(kStr);
    return;
  }

  // Numeric model selection after `/model`.
  if (/^\d+$/.test(text) && awaitingModelSelection.has(kStr)) {
    const num = parseInt(text, 10);
    const list = threadModelLists.get(kStr);
    awaitingModelSelection.delete(kStr);
    if (list && num >= 1 && num <= list.length) {
      const selected = list[num - 1];
      // Audit S12 / #20: previous code returned only when
      // `adapter.setModel` was truthy; on adapters that don't implement
      // it (legacy void return) execution fell through and the same
      // numeric reply was re-processed as a natural-language start +
      // forwarded to the agent. `applyModelSelection` always replies (even
      // for the unsupported case), so we always return after a numeric pick
      // — the user clearly intended a model pick, not a prompt.
      const { message } = await applyModelSelection(adapter, key, selected);
      await replyToThread(key, message);
    } else {
      await replyToThread(key, 'Invalid number. Run /model to see the list.');
    }
    return;
  }

  // Session-pick mode (armed by `/sessions` / `/resume`). Only while the
  // thread is armed is a bare digit treated as a pick — a normal numeric
  // prompt is never hijacked. See `checkSessionPickAction` for the rules.
  if (awaitingSessionSelection.has(kStr)) {
    const sessionList = threadSessionLists.get(kStr) ?? [];
    const pick = checkSessionPickAction(text, sessionList.length);
    if (pick.kind === 'invalid') {
      // Stay armed so the user can retry with a valid number.
      await replyToThread(key, t('session.invalid', { max: sessionList.length }));
      return;
    }
    if (pick.kind === 'cancel') {
      awaitingSessionSelection.delete(kStr);
      await replyToThread(key, t('session.cancelled'));
      return;
    }
    if (pick.kind === 'select') {
      awaitingSessionSelection.delete(kStr);
      const result = await resumeSessionByIndex(key, pick.index, async () => {
        await replyToThread(key, t('session.expired'));
      });
      if (result !== null) await replyToThread(key, result);
      return;
    }
    // passthrough: not a number — exit pick-mode and let normal handling run.
    awaitingSessionSelection.delete(kStr);
  }

  // Natural-language start.
  if (!adapter.checkIsActive(key)) {
    const startMatch = checkIsStartAgentPhrase(text);
    if (startMatch.isMatch && startMatch.adapterName) {
      if (checkIsGeneral(key)) {
        await replyToThread(key, t('error.start_in_general'));
        return;
      }
      // The shared `ensureAgentSession` does the bind-check + switch + start.
      // The explicit matched adapter wins (`preferredAdapterName`); the phrase's
      // trailing args ride along. On `unbound` we keep this path's own reply:
      // the folder picker (plan §11 Этап 4 — starting without a binding would
      // silently launch against WORK_ROOT, which is almost never wanted).
      const result = await ensureAgentSession(key, {
        preferredAdapterName: startMatch.adapterName,
        args: startMatch.args,
      });
      if (!result.ok && result.reason === 'unbound') {
        const subdirs = listAvailableSubdirs(ENV.workRoot);
        const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
        await replyToThread(key, t('thread.no_binding'), extra);
        return;
      }
      // Empty when a self-greeting agent started (its banner is the cue) — guard
      // like the /schedule consumer so we never post a blank message.
      if (result.message) await replyToThread(key, result.message);
      return;
    }
  }

  // Claude TUI prompt on screen + a bare control reply (option digit or y/n)
  // → drive it in place. `getClaudeReplyRoute` decides precedence: a real
  // AskUserQuestion SELECTOR wins for a control reply; free-form prose breaks
  // out as a fresh prompt. Forwarding a digit as a prompt would first send
  // Escape (interruptAndWaitIdle) and cancel the menu — live-caught with
  // /login: the user replied "1" and got "⎿ Login interrupted".
  //   • selector → sendInput(digit) types the digit + an instant Enter, which
  //     jumps the selector to that option and confirms it.
  // Claude's native session SURVEY is auto-dismissed by the adapter (Escape) and
  // never surfaced, so a bare digit during a survey window is NOT a route here —
  // it falls through to the normal prompt path instead of being dropped.
  const replyRoute = getClaudeReplyRoute({
    isQuestionPending: adapter.isQuestionPending?.(key) ?? false,
    isLoginPastePending: adapter.isLoginPastePending?.(key) ?? false,
    text,
  });
  if (replyRoute === 'selector') {
    markNeedsNewMessage(key);
    adapter.sendInput(key, text);
    return;
  }
  // Claude `/login` OAuth code paste: type the code VERBATIM into the box (no
  // Escape, no thread-context preamble — both would break the login flow). The
  // code is a single-use secret, so delete the user's message from the topic
  // and post a short confirmation instead of leaving the token in history.
  if (replyRoute === 'loginPaste') {
    markNeedsNewMessage(key);
    adapter.sendInput(key, text);
    await deleteThreadMessage(key, ctx.message.message_id);
    await replyToThread(key, t('agent.login_code_relayed'));
    return;
  }

  // Terminal backend: a plain text message IS a shell command. Type it straight
  // in via `sendInput` (which appends Enter and arms a fresh rolling message),
  // bypassing `forwardPromptToAgent` entirely — no `[thread context]` preamble
  // (a shell isn't an agent that needs to know WHERE it works), no typing loader,
  // no interrupt logic. A bare `/clear` is likewise just typed in as input.
  if (adapter.name === 'terminal' && adapter.checkIsActive(key)) {
    adapter.sendInput(key, text);
    return;
  }

  // Forward text to a running agent (shared choke point for text + voice). It
  // owns the pending-question route (digit answers / free-form cancels), the G2
  // wedge backstop, and the actual forward. The Claude-selector + terminal
  // branches above already returned for their own cases, so this is reached only
  // for a generic active prompt. The message's real send time (Telegram `date`,
  // unix seconds) rides along for the `/timestamps` injection.
  if (adapter.checkIsActive(key)) {
    await deliverActivePrompt(key, adapter, text, ctx.message.date * 1000);
    return;
  }

  // Idle thread — guide the user. Three sub-states:
  //   • General → it's never bindable, just point at topical threads.
  //   • Topical without binding → offer the subdir picker (plan §20.6).
  //   • Topical with binding → existing /claude /opencode hint.
  if (checkIsGeneral(key)) {
    await replyToThread(key, t('thread.general_no_agent'));
    return;
  }
  const binding = state.getBinding(key);
  if (!binding) {
    const subdirs = listAvailableSubdirs(ENV.workRoot);
    const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
    await replyToThread(key, t('thread.no_binding'), extra);
    return;
  }
  await replyToThread(key, t('thread.no_agent_with_binding', { subdir: binding.subdir }));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Voice message handler
// ═══════════════════════════════════════════════════════════════════════════════

bot.on(message('voice'), async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) return;

  // User took over (voice note) before a pending API-error retry fired → cancel
  // it silently, like the text handler.
  cancelApiRetry(key);

  await state.pushMessageId(key, ctx.message.message_id);

  if (!ENV.groqApiKey && !ENV.openaiApiKey) {
    await replyToThread(key, t('voice.no_api_key'));
    return;
  }

  // Offload the slow download+transcribe+forward off the telegraf update loop:
  // awaiting it here would stall intake of EVERY update until Groq replies
  // (up to 20s, longer on retries) and freeze the whole bot. The per-thread
  // FIFO queue preserves per-topic order; different topics run in parallel.
  // Do NOT await — the handler must return so the batch settles fast. A
  // rejected job is guarded so it can never become an unhandledRejection
  // (processVoiceJob already reports its own errors via replyToThread).
  const fileId = ctx.message.voice.file_id;
  const sentAtMs = ctx.message.date * 1000;
  void getVoiceTranscriptionQueue(key)
    .run(() => processVoiceJob(key, fileId, sentAtMs))
    .catch((err) => {
      console.error('[Bot] Voice job error (already handled):', err);
    });
});

/**
 * @description Background worker for a single voice note: download → transcribe
 * → status emit → (buffer / start-agent-phrase / binding checks / forward).
 * Byte-for-byte the old voice handler's post-gate body — moved verbatim out of
 * the handler so it runs OFF the telegraf update loop (per-thread serialized).
 * Uses only `key`/`bot`, never the request `ctx`, so it survives past the
 * handler's return. `sentAtMs` is the voice note's real Telegram send time,
 * captured by the handler for the `/timestamps` injection (transcription can
 * take ~20s, so "now" at forward time would drift).
 */
async function processVoiceJob(key: ThreadKey, fileId: string, sentAtMs?: number): Promise<void> {
  try {
    // Audit S14 / #33: `getFileLink` builds the bot-token URL in one
    // place inside Telegraf instead of us materialising the token in a
    // JS string. The previous manual interpolation worked but
    // accidentally leaking the token into any future log call would
    // expose the bot.
    const fileUrlObj = await bot.telegram.getFileLink(fileId);
    const fileUrl = fileUrlObj.toString();

    const tempDir = '/tmp';
    const tempFile = path.join(tempDir, `voice_${key.chatId}_${key.threadId}_${Date.now()}.ogg`);
    try {
      // Ride the same warm, IPv4-pinned keep-alive agent as the Telegram API
      // calls (avoids the cold-handshake stall that used to trip the timeout),
      // and retry transient failures automatically so the user never has to
      // re-send the voice note.
      await downloadFile(fileUrl, tempFile, {
        agent: telegramAgent,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        onRetry: (attempt, err, delayMs) => {
          console.warn(`[Bot] voice download attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms`);
        },
      });
    } catch (downloadErr) {
      const msg = downloadErr instanceof Error ? downloadErr.message : String(downloadErr);
      console.warn(`[Bot] voice download failed after retries: ${msg}`);
      await replyToThread(key, `${t('voice.failed')} (${msg})`);
      return;
    }
    const result = await transcribeAudio(tempFile);
    fs.unlink(tempFile, () => {});

    if (!result.ok) {
      await replyToThread(key, `${t('voice.failed')} (${result.error})`);
      return;
    }
    const transcript = result.text;
    console.log(`[Bot] voice transcribed: "${transcript}"`);
    // Acknowledge the user's own input on the UNPACED path so the "🎤 …" echo
    // surfaces immediately instead of queuing behind the thread's streaming
    // agent output (which is what made it arrive minutes late under load).
    void replyToThread(key, t('voice.transcribed', { text: transcript }), {}, { unpaced: true }).catch(() => {});

    // Session is mid-startup → buffer the transcript and replay it once ready.
    if (startupPromptBuffer.checkIsStarting(keyToString(key))) {
      const isFirstBuffered = startupPromptBuffer.addPrompt(keyToString(key), transcript);
      if (isFirstBuffered) {
        await replyToThread(key, t('agent.queued_starting', { label: getThreadAdapter(key).label }));
      }
      return;
    }

    const adapter = getThreadAdapter(key);
    if (!adapter.checkIsActive(key)) {
      const startMatch = checkIsStartAgentPhrase(transcript);
      if (startMatch.isMatch && startMatch.adapterName) {
        if (checkIsGeneral(key)) {
          await replyToThread(key, t('error.start_in_general'));
          return;
        }
        if (!state.getBinding(key)) {
          const subdirs = listAvailableSubdirs(ENV.workRoot);
          const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
          await replyToThread(key, t('thread.no_binding'), extra);
          return;
        }
        await switchThreadAdapter(key, startMatch.adapterName);
        // Empty for a self-greeting agent (Claude self-announces) — the typing
        // loader covers the gap; show a notice only when there's ready text.
        const msg = await startAgentSession(key, startMatch.args);
        if (msg) await replyToThread(key, msg);
        return;
      }
    }
    if (!adapter.checkIsActive(key)) {
      if (checkIsGeneral(key)) {
        await replyToThread(key, t('thread.general_no_agent'));
        return;
      }
      const binding = state.getBinding(key);
      if (!binding) {
        const subdirs = listAvailableSubdirs(ENV.workRoot);
        const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
        await replyToThread(key, t('thread.no_binding'), extra);
        return;
      }
      await replyToThread(key, t('thread.no_agent_with_binding', { subdir: binding.subdir }));
      return;
    }

    // Same choke point as text: a voice transcript while a question is pending
    // CANCELS it (a transcript is free-form prose, never a bare digit) and is
    // delivered as a fresh prompt — closing the gap where voice queued behind a
    // blocked question-turn and the user got no reply.
    await deliverActivePrompt(key, adapter, transcript, sentAtMs);
  } catch (err) {
    console.error('[Bot] Voice handling error:', err);
    await replyToThread(key, 'Error processing voice message');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  File intake handler — photo / document / video / video_note / audio / animation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Detect Telegram's "file is too big" rejection from `getFile` /
 * `getFileLink` (400 with that description) so we can map it to the friendly
 * `file.too_big` reply instead of a generic failure. Bot API refuses to serve
 * a download link for files over the 20 MB cap.
 */
function checkIsFileTooBigApiError(err: unknown): boolean {
  if (!checkIsApiError(err)) return false;
  return /file is too big/i.test(getErrorDescription(err));
}

/**
 * @description Handle an inbound media message: gate exactly like the text
 * path, download the file into the bot-owned per-thread dir, then announce it
 * to the agent through the same `forwardPromptToAgent` choke point so the
 * preamble / buffering / `/clear` marker all apply uniformly.
 *
 * Gating mirrors the text handler: group gate (`authoriseContext`), inbound
 * id tracking, startup-buffer replay, then the active-session check with the
 * same no-agent / no-binding hints. The file is downloaded ONLY once we know
 * an agent is active (or mid-startup) — an idle/unbound thread gets the hint
 * and nothing hits disk, per the locked decision.
 */
/**
 * @description Evaluate the file-intake gate for a thread: an idle thread (no
 * active agent and not mid-startup) gets the same friendly guidance as the text
 * path and nothing hits disk. Returns `true` when intake may proceed.
 *
 * The hint reply is routed through `sendHint` rather than sent directly so the
 * album path can dedupe it to once-per-album; the single-file path passes
 * `replyToThread` verbatim.
 */
async function checkFileIntakeGatePassed(
  key: ThreadKey,
  isStarting: boolean,
  sendHint: (text: string, extra?: SendExtra) => Promise<unknown>,
): Promise<boolean> {
  const adapter = getThreadAdapter(key);
  if (isStarting || adapter.checkIsActive(key)) return true;

  if (checkIsGeneral(key)) {
    await sendHint(t('thread.general_no_agent'));
    return false;
  }
  const binding = state.getBinding(key);
  if (!binding) {
    const subdirs = listAvailableSubdirs(ENV.workRoot);
    const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
    await sendHint(t('thread.no_binding'), extra);
    return false;
  }
  await sendHint(t('thread.no_agent_with_binding', { subdir: binding.subdir }));
  return false;
}

/**
 * @description Download one inbound media file into the bot-owned per-thread
 * dir, returning its absolute saved path, or `null` if it could not be fetched.
 *
 * On a known-too-big file, an over-cap API error, or a download failure it
 * sends the matching error reply through `onError` (so the album path can
 * dedupe it) and returns `null`. The size pre-check is the caller's job for the
 * single-file fast path; for albums it is folded in here so each item is sized.
 */
async function downloadIncomingFile(
  ctx: NarrowedContext<Context, Update.MessageUpdate>,
  key: ThreadKey,
  meta: TelegramFileMeta,
  onError: (text: string) => Promise<unknown>,
): Promise<string | null> {
  if (checkIsFileTooBig(meta.fileSize)) {
    await onError(t('file.too_big', { cap: FILE_DOWNLOAD_CAP_MB }));
    return null;
  }

  let fileUrl: string;
  try {
    fileUrl = (await ctx.telegram.getFileLink(meta.fileId)).toString();
  } catch (err) {
    if (checkIsFileTooBigApiError(err)) {
      await onError(t('file.too_big', { cap: FILE_DOWNLOAD_CAP_MB }));
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Bot] getFileLink failed for ${meta.kind}: ${msg}`);
      await onError(t('file.download_failed'));
    }
    return null;
  }

  try {
    const dir = await ensureThreadFilesDir(getDataDir(), key);
    const unixSeconds = Math.floor(Date.now() / 1000);
    const fileName = buildSavedFileName(unixSeconds, meta.fileUniqueId, meta.kind, meta.fileName);
    const savedPath = path.join(dir, fileName);
    await downloadFile(fileUrl, savedPath, {
      agent: telegramAgent,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      onRetry: (attempt, err, delayMs) => {
        console.warn(`[Bot] file download attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms`);
      },
    });
    return savedPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Bot] file download failed after retries: ${msg}`);
    await onError(t('file.download_failed'));
    return null;
  }
}

/**
 * @description Deliver one already-built prompt to the thread's agent,
 * honouring the startup window: mid-startup the prompt is buffered (replays in
 * order when ready, exactly like a text prompt typed during boot); otherwise it
 * is forwarded immediately through the normal choke point. This is the single
 * "buffer-or-forward" unit shared by file/album intake and the `/schedule`
 * command (S7) so the startup-window handling never drifts between them.
 *
 * `isStarting` is passed in (not read here) because the album collector
 * captures it AT FLUSH TIME — a session that finished booting mid-burst must
 * forward, not buffer.
 */
async function deliverPromptOrBuffer(
  key: ThreadKey,
  promptText: string,
  isStarting: boolean,
): Promise<void> {
  const kStr = keyToString(key);
  if (isStarting) {
    const isFirstBuffered = startupPromptBuffer.addPrompt(kStr, promptText);
    if (isFirstBuffered) {
      await replyToThread(key, t('agent.queued_starting', { label: getThreadAdapter(key).label }));
    }
    return;
  }
  await forwardPromptToAgent(key, getThreadAdapter(key), promptText);
}

/**
 * @description One member of an in-flight album, buffered in the collector
 * between the per-item download and the debounced flush. `caption` is the
 * caption that rode THIS item (Telegram puts it on a single, arbitrary album
 * member); the flush picks the first non-empty one.
 */
interface AlbumCollectorItem {
  /**
   * The originating message id. Album members arrive with monotonically
   * increasing ids, so sorting by it at flush time restores the user's visual
   * order even though Telegraf dispatches the burst concurrently (per-item
   * downloads can finish out of order).
   */
  messageId: number;
  albumFile: AlbumFile;
  caption?: string;
}

/**
 * @description Per-(thread, media_group) album batcher. Telegram delivers an
 * album as N messages sharing `media_group_id` in a quick burst; this coalesces
 * them so the agent gets ONE combined prompt after the burst settles, and gating
 * / error hints fire once per album. The flush forwards the combined prompt
 * through {@link deliverPromptOrBuffer}, re-reading the startup state AT FLUSH TIME
 * so a session that finished booting mid-burst forwards instead of buffers.
 */
const albumCollector = createMediaGroupCollector<AlbumCollectorItem>({
  debounceMs: ALBUM_DEBOUNCE_MS,
  onFlush: (groupKey, items) => {
    void (async () => {
      const { key } = parseAlbumGroupKey(groupKey);
      if (items.length === 0) return; // Group existed only to hold a claimed hint.
      // Restore the user's visual order — downloads may have completed (and
      // thus collected) out of order under Telegraf's concurrent dispatch.
      const orderedItems = [...items].sort((a, b) => a.messageId - b.messageId);
      const files = orderedItems.map((item) => item.albumFile);
      const caption = orderedItems.find((item) => item.caption && item.caption.trim())?.caption;
      const promptText = buildAlbumPromptText(files, caption);
      const isStarting = startupPromptBuffer.checkIsStarting(keyToString(key));
      // User took over (album upload) before a pending API-error retry fired →
      // cancel it silently, like the text/voice handlers.
      cancelApiRetry(key);
      try {
        await deliverPromptOrBuffer(key, promptText, isStarting);
      } catch (err) {
        console.error('[Bot] album flush failed:', err);
        await replyToThread(key, t('file.download_failed')).catch(() => {});
      }
    })();
  },
});

/** Join a thread key and a media_group_id into the collector's group key. */
function buildAlbumGroupKey(key: ThreadKey, mediaGroupId: string): string {
  return `${keyToString(key)}|${mediaGroupId}`;
}

/** Inverse of {@link buildAlbumGroupKey} — recover the owning thread key. */
function parseAlbumGroupKey(groupKey: string): { key: ThreadKey } {
  const separatorIndex = groupKey.indexOf('|');
  const threadKeyString = separatorIndex === -1 ? groupKey : groupKey.slice(0, separatorIndex);
  return { key: keyFromString(threadKeyString) };
}

/**
 * @description Handle one media message that is part of an album (carries a
 * `media_group_id`). Gating and download happen per item — but the gating hint
 * and the download-error reply are deduped to once per album via the collector's
 * one-shot guard, and only the COMBINED prompt is debounced (the flush in
 * {@link albumCollector}). A successful download is buffered into the collector;
 * a failed one still lets the album flush announce the rest.
 */
async function handleAlbumFile(
  ctx: NarrowedContext<Context, Update.MessageUpdate>,
  key: ThreadKey,
  meta: TelegramFileMeta,
  mediaGroupId: string,
): Promise<void> {
  const groupKey = buildAlbumGroupKey(key, mediaGroupId);
  const isStarting = startupPromptBuffer.checkIsStarting(keyToString(key));

  // Gate per item, but reply at most once per album. The guard is claimed
  // lazily so a passing gate never burns the one-shot slot.
  const gatePassed = await checkFileIntakeGatePassed(key, isStarting, async (text, extra) => {
    if (albumCollector.checkShouldAnnounceOnce(groupKey)) {
      await replyToThread(key, text, extra);
    }
  });
  if (!gatePassed) return;

  const savedPath = await downloadIncomingFile(ctx, key, meta, async (text) => {
    if (albumCollector.checkShouldAnnounceOnce(groupKey)) {
      await replyToThread(key, text);
    }
  });
  if (savedPath === null) return; // Error already deduped; let the rest flush.

  albumCollector.collect(groupKey, {
    messageId: ctx.message.message_id,
    albumFile: { kind: meta.kind, savedPath, fileSize: meta.fileSize },
    caption: meta.caption,
  });
}

async function handleIncomingFile(
  ctx: NarrowedContext<Context, Update.MessageUpdate>,
  key: ThreadKey,
): Promise<void> {
  const meta = getTelegramFileMeta(ctx.message);
  if (!meta) return; // Not one of the six kinds (e.g. sticker) — ignore.

  // Always track inbound ids so /clear_messages can delete user uploads too.
  await state.pushMessageId(key, ctx.message.message_id);

  // Album item (shares media_group_id with siblings) → batch them into one
  // combined prompt instead of N prompts that abort each other.
  const mediaGroupId = getMediaGroupId(ctx.message);
  if (mediaGroupId) {
    await handleAlbumFile(ctx, key, meta, mediaGroupId);
    return;
  }

  const isStarting = startupPromptBuffer.checkIsStarting(keyToString(key));

  const gatePassed = await checkFileIntakeGatePassed(key, isStarting, (text, extra) =>
    replyToThread(key, text, extra),
  );
  if (!gatePassed) return;

  const savedPath = await downloadIncomingFile(ctx, key, meta, (text) => replyToThread(key, text));
  if (savedPath === null) return;

  const promptText = buildFilePromptText(meta.kind, savedPath, meta.fileSize, meta.caption);
  // User took over (file upload) before a pending API-error retry fired →
  // cancel it silently, like the text/voice handlers.
  cancelApiRetry(key);
  await deliverPromptOrBuffer(key, promptText, isStarting);
}

bot.on(
  // anyOf-composed per-kind filter — `message('photo', 'document', …)` would
  // be an AND over the fields and never match a real media message (see
  // incomingFileMessageFilter).
  incomingFileMessageFilter,
  async (ctx) => {
    const key = await authoriseContext(ctx);
    if (!key) return;
    try {
      await handleIncomingFile(ctx, key);
    } catch (err) {
      console.error('[Bot] File handling error:', err);
      await replyToThread(key, t('file.download_failed'));
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Edited message — explicit UX hint instead of silent ignore
// ═══════════════════════════════════════════════════════════════════════════════

bot.on('edited_message', async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) return;
  // Reply once per edit so the user isn't left wondering. The bot does NOT
  // treat the edit as a re-prompt to the agent (plan §16.3, E6).
  await replyToThread(key, t('edited.hint'));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  my_chat_member — auto-welcome when the bot is added to the group (§20.2)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Detect when *this* bot is added to the configured group and
 * post a setup checklist into General. Without this, a fresh deployment is
 * silent: the user adds the bot, sees nothing, and has to dig through the
 * README to find out what permissions / privacy flags they need to flip.
 *
 * Filters:
 *   - chat must be the allowlisted group (we don't react in foreign chats),
 *   - the member that changed must be us (other admins being promoted etc.
 *     are not interesting),
 *   - new status must be `member` or `administrator` — `kicked`/`left`
 *     events would only generate noise.
 */
bot.on('my_chat_member', async (ctx) => {
  const chat = ctx.chat;
  if (!chat || chat.id !== getAllowedGroupId()) return;
  const upd = ctx.update.my_chat_member;
  const newMember = upd.new_chat_member;
  const botId = bot.botInfo?.id;
  if (!botId || newMember.user.id !== botId) return;
  if (newMember.status !== 'member' && newMember.status !== 'administrator') return;

  // We don't know which message_thread_id General actually has on this
  // group (it can be 1, or undefined for non-forum chats). For a forum
  // supergroup it's always the constant `GENERAL_THREAD_ID = 1`.
  const generalKey: ThreadKey = { chatId: chat.id, threadId: GENERAL_THREAD_ID };
  await replyToThread(
    generalKey,
    t('onboarding.welcome', { workRoot: ENV.workRoot }),
    { parse_mode: 'Markdown' },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  chat_member — admin promotion/demotion invalidates the admin cache
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description React to member-status changes in the served group: a
 * promotion/demotion changes the admin set that gates access, so the cached
 * set is invalidated and the next authorisation re-fetches it live — a demoted
 * admin loses access immediately instead of at the 1h TTL. Regular-member
 * joins/leaves can't change the admin set and are ignored
 * (`checkShouldInvalidateAdminCache`). Requires `chat_member` in
 * `allowed_updates` (NOT in Telegram's default set — see `botAllowedUpdates`).
 */
bot.on('chat_member', (ctx) => {
  if (ctx.chat?.id !== getAllowedGroupId()) return;
  const { old_chat_member, new_chat_member } = ctx.update.chat_member;
  if (!checkShouldInvalidateAdminCache(old_chat_member.status, new_chat_member.status)) return;
  adminCache.invalidate();
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Forum service events — created / deleted / closed / reopened
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Auto-bind a newly-created thread when its name matches an
 * existing subdir; otherwise greet the user with the picker.
 *
 * Idempotent: the same event may arrive twice on bot restart, and the user's
 * very first message can race the service message. If a binding already
 * exists for this key we only re-send the welcome — never overwrite the
 * chosen subdir (plan §13.9, D16).
 */
bot.on(message('forum_topic_created'), async (ctx) => {
  const key = getThreadKey(ctx);
  if (!key) return;
  if (checkIsGeneral(key)) return; // General isn't created this way; defensive.

  const topicName = ctx.message.forum_topic_created.name ?? '';
  const existing = state.getBinding(key);

  // Already bound — service event arrived after the user's first message
  // (or on restart). Don't overwrite; quietly skip the welcome too, the
  // user has already seen the binding ack.
  if (existing) return;

  // Audit S2 / #5: topic creation may be open to all members (group setting),
  // not only admins. If the creator isn't an authorised user (group
  // admin/creator), we MUST NOT auto-bind — a non-admin could pick a name that
  // fuzzy-matches a sensitive WORK_ROOT subdir, the bot would auto-bind, and the
  // next message from an authorised user would launch an agent against the
  // attacker-chosen folder. Stash the topic name so a later authorised-user
  // message in the same thread can still benefit from fuzzy auto-bind.
  const userId = ctx.from?.id;
  if (!userId || !(await checkIsAllowedUser(ctx))) {
    if (topicName) {
      pendingTopicNames.set(keyToString(key), { name: topicName, ts: Date.now() });
    }
    console.warn(
      `[security] forum_topic_created in chat ${ctx.chat.id} by user ${userId ?? '?'} (not a group admin) — name cached, no auto-bind`,
    );
    return;
  }

  const subdirs = listAvailableSubdirs(ENV.workRoot);
  // Fuzzy match: NFC + lower + separator-collapsed (see `findAutobindSubdir`
  // for the precise drift coverage). Anything more aggressive would start
  // guessing — auto-bind has to stay predictable, mis-matches fall through
  // to the picker UX.
  const match = findAutobindSubdir(topicName, subdirs);
  if (match) {
    try {
      const subdir = validateSubdir(ENV.workRoot, match);
      // The creation event carries the topic name — persist it on the binding
      // for the thread-context preamble (S1).
      await state.setBinding(key, subdir, topicName ? { topicName } : {});
      await replyToThread(key, t('thread.welcome_bound', { subdir }));
      await sendBindingWelcome(key, subdir);
      return;
    } catch (e) {
      console.warn(`[forum_topic_created] auto-bind failed for "${match}":`, e);
      // Fall through to picker.
    }
  }

  const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
  await replyToThread(key, t('thread.welcome_pick'), extra);
});

/**
 * @description A forum topic was renamed (or its icon changed). When the name
 * changed, persist it so the thread-context preamble can tell the agent its
 * current topic name. Admin-gated like the created/closed/reopened trio: a
 * non-authorised member's rename must not reshape what the bot remembers.
 *
 * This is also the ONLY way the bot learns the name of a pre-existing topic
 * (the Bot API can't query a topic title on demand). If the topic isn't bound
 * yet, refresh `pendingTopicNames` so a later auto-bind still gets the name.
 */
bot.on(message('forum_topic_edited'), async (ctx) => {
  const key = getThreadKey(ctx);
  if (!key) return;
  const newName = ctx.message.forum_topic_edited.name;
  // Icon-only edit (no `name`) — nothing for the preamble to track.
  if (!newName) return;
  const userId = ctx.from?.id;
  if (!userId || !(await checkIsAllowedUser(ctx))) {
    console.warn(`[security] forum_topic_edited in chat ${ctx.chat.id} by user ${userId ?? '?'} (not a group admin) — name not updated`);
    return;
  }
  if (state.getBinding(key)) {
    await state.setBindingTopicName(key, newName);
  } else {
    // No binding yet — keep the freshest name for a later fuzzy auto-bind.
    pendingTopicNames.set(keyToString(key), { name: newName, ts: Date.now() });
  }
});

// Audit S2 / #5: closed/reopened events can come from a member who isn't an
// authorised user. We deliberately diverge from "trust Telegram's state":
// better to leave our `closed` flag stale than to let a non-authorised user
// shape what the bot remembers about a thread. An authorised user re-engaging
// the thread will surface any drift via the `topic-closed` send-error path
// (which retries / surfaces a hint).
bot.on(message('forum_topic_closed'), async (ctx) => {
  const key = getThreadKey(ctx);
  if (!key) return;
  const userId = ctx.from?.id;
  if (!userId || !(await checkIsAllowedUser(ctx))) {
    console.warn(`[security] forum_topic_closed in chat ${ctx.chat.id} by user ${userId ?? '?'} (not a group admin) — state not updated`);
    return;
  }
  await state.setBindingClosed(key, true);
  // Topic closed — the session is no longer reachable from here, so any
  // re-engagement starts fresh. Drop the last-injected preamble so the next
  // prompt re-informs the agent of its context (the `closed` boundary in the
  // plan's start/stop/closed marker-reset rule).
  clearThreadContextMarker(key);
  // Refresh the banner so the `🔒 closed` marker appears immediately. Edits
  // INTO a closed topic are still allowed by Telegram even when sends aren't,
  // so we can update the existing pinned message without re-pinning.
  await updatePinnedStatus(key).catch(() => {});
});

bot.on(message('forum_topic_reopened'), async (ctx) => {
  const key = getThreadKey(ctx);
  if (!key) return;
  const userId = ctx.from?.id;
  if (!userId || !(await checkIsAllowedUser(ctx))) {
    console.warn(`[security] forum_topic_reopened in chat ${ctx.chat.id} by user ${userId ?? '?'} (not a group admin) — state not updated`);
    return;
  }
  await state.setBindingClosed(key, false);
  await updatePinnedStatus(key).catch(() => {});
});

// `forum_topic_deleted` is intentionally NOT handled here: Telegram doesn't
// reliably emit a service message for topic deletion (and Telegraf 4.16.3
// doesn't model it in its filter union), so we GC reactively via the 400
// "message thread not found" branch in `handleSendError` (plan §13.10, E5).
// That path also catches deletions that happen while the bot is offline,
// which any service-message-based handler would miss anyway.

// ═══════════════════════════════════════════════════════════════════════════════
//  Callback queries — model, agent switch, resume, opt buttons, qa answers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Inline-button binding picker shown by `/bind` (without args),
 * by the no-binding text-handler fallback, and by `forum_topic_created`.
 *
 * `bind_<subdir>` — subdir comes verbatim from the keyboard we just built,
 * so it's pre-filtered to entries actually present in WORK_ROOT. We still
 * route through `applyBinding` for validation parity with the slash command
 * (case the disk state changes between keyboard send and callback receive).
 */
/**
 * @description Pagination handler for the `/bind` keyboard.
 *
 * Edits the *existing* picker message in-place (`editMessageReplyMarkup`)
 * rather than sending a fresh keyboard — keeps the thread clean and
 * preserves the surrounding text. A no-op edit (same page tapped twice)
 * returns Telegram's "message is not modified" 400 which we swallow.
 *
 * Note: `bind_page_(\d+)$` is registered BEFORE `bind_(.+)$` so the
 * page-callback isn't accidentally interpreted as a folder name. Order
 * matters in Telegraf's action regex dispatch — first match wins.
 */
bot.action(/^bind_page_(\d+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  if (checkIsGeneral(key)) {
    await ctx.answerCbQuery(t('cb.bind_only_topical'));
    return;
  }
  const page = parseInt(ctx.match[1], 10);
  const subdirs = listAvailableSubdirs(ENV.workRoot);
  const keyboard = buildBindKeyboard(subdirs, page, BIND_PAGE_SIZE, !!state.getBinding(key));
  try {
    await ctx.editMessageReplyMarkup(keyboard.reply_markup);
  } catch (e) {
    const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
    if (!/message is not modified/i.test(desc)) {
      console.warn(`[bind_page] edit failed:`, desc || e);
    }
  }
  await ctx.answerCbQuery();
});

// Middle "N/M" pill in the nav row — pure UI, no state change.
bot.action('bind_page_noop', async (ctx) => {
  await ctx.answerCbQuery();
});

// «Create new folder» — first option in the /bind picker. Arms the thread's
// await-folder-name mode; the next text message is the name (see the text
// handler). Callback id deliberately avoids the `bind_` prefix so it can't be
// matched by the `bind_<subdir>` regex below.
bot.action(bindCreateFolderCallback, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  if (checkIsGeneral(key)) {
    await ctx.answerCbQuery(t('cb.bind_only_topical'));
    return;
  }
  await ctx.answerCbQuery(t('bind.create_cb'));
  armFolderCreation(key);
  await replyToThread(key, t('bind.create_prompt'));
});

// «Leave current dir» — the folded-in `/unbind`, shown only in a bound topic.
// Callback id deliberately avoids the `bind_` prefix so it can't be matched by
// the `bind_<subdir>` regex below.
bot.action(bindLeaveCurrentCallback, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  if (checkIsGeneral(key)) {
    await ctx.answerCbQuery(t('cb.bind_only_topical'));
    return;
  }
  await ctx.answerCbQuery();
  await unbindThread(key);
});

bot.action(/^bind_(.+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  if (checkIsGeneral(key)) {
    await ctx.answerCbQuery(t('cb.bind_only_topical'));
    return;
  }
  const subdir = ctx.match[1];
  await ctx.answerCbQuery(t('cb.binding_to', { subdir }));
  const result = await applyBinding(key, subdir);
  await replyToThread(key, result.message);
  if (result.ok) await sendBindingWelcome(key, result.subdir);
});

bot.action(/^model_(.+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const modelId = ctx.match[1];
  const adapter = getThreadAdapter(key);
  // No bot-side session gate: the adapter owns the no-session decision
  // (OpenCode persists the pick for next start and succeeds; Claude refuses
  // with a notice surfaced as the error toast below).
  if (!adapter.setModel) {
    await ctx.answerCbQuery(t('cb.not_supported', { label: adapter.label }));
    return;
  }
  const { isOk, message, setModelError, displayLabel } = await applyModelSelection(adapter, key, modelId);
  if (!isOk) {
    await ctx.answerCbQuery(t('cb.model_error', { error: (setModelError ?? message).slice(0, 50) }));
    return;
  }
  await ctx.answerCbQuery(t('cb.model_set', { model: displayLabel.split('/').pop() || displayLabel }));
  await replyToThread(key, message);
});

bot.action(/^effort_(.+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const level = ctx.match[1];
  const adapter = getThreadAdapter(key);
  // No `checkIsActive` gate — effort is persisted pre-session (mirrors the
  // `/effort` command and `/model`). The adapter returns its own notice if the
  // pick can't apply live; we surface it via `cb.effort_error` below.
  if (!adapter.setEffort) {
    await ctx.answerCbQuery(t('cb.not_supported', { label: adapter.label }));
    return;
  }
  const err = await adapter.setEffort(key, level);
  if (err) { await ctx.answerCbQuery(t('cb.effort_error', { error: err.slice(0, 50) })); return; }
  await ctx.answerCbQuery(t('cb.effort_set', { level }));
  await replyToThread(key, t('effort.set_success', { level }));
  await updatePinnedStatus(key).catch(() => {});

  // Re-render the picker so the `✓` marker follows the new level instead of
  // staying stuck on the previously-selected one (B12). The current level is
  // the freshly-set one; fall back to `level` if the adapter can't report it.
  const cbMsg = ctx.callbackQuery?.message as Message | undefined;
  if (cbMsg && adapter.getAvailableEffortLevels) {
    let levels: string[] = [];
    try {
      levels = await adapter.getAvailableEffortLevels(key);
    } catch (e) {
      console.error('[effort_cb] getAvailableEffortLevels:', e);
    }
    if (levels.length > 0) {
      const cur = adapter.getEffort?.(key) ?? level;
      const keyboard = buildEffortKeyboard(levels, cur);
      try {
        await enqueueSend(
          key,
          () => bot.telegram.editMessageReplyMarkup(
            key.chatId, cbMsg.message_id, undefined, keyboard.reply_markup,
          ),
        );
      } catch (e) {
        const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
        if (!/message is not modified/i.test(desc)) {
          console.warn('[effort_cb] keyboard re-render failed:', desc || e);
        }
      }
    }
  }
});

bot.action(/^ccmode_(.+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const target = ctx.match[1];
  if (!checkIsClaudeBackend(target)) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  // Compare against the EFFECTIVE backend (what /claude would start), same as
  // the command handler — the raw thread name may be a legacy default-adapter
  // fallback that never matches what a start would actually open.
  const current = resolveClaudeBackendName(key);
  if (target === current) { await ctx.answerCbQuery(t('cb.claudeMode_already')); return; }
  await ctx.answerCbQuery(t('cb.claudeMode_switching'));
  await replyToThread(key, await applyClaudeBackendSwitch(key, target));
  // Re-render the picker so the `✓` follows the new backend (mirrors effort_cb).
  const cbMsg = ctx.callbackQuery?.message as Message | undefined;
  if (cbMsg) {
    try {
      await enqueueSend(key, () => bot.telegram.editMessageReplyMarkup(
        key.chatId, cbMsg.message_id, undefined,
        buildClaudeModeKeyboard(resolveClaudeBackendName(key)).reply_markup,
      ));
    } catch (e) {
      const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
      if (!/message is not modified/i.test(desc)) console.warn('[ccmode_cb] re-render:', desc || e);
    }
  }
});

/**
 * @description Per-family config for the ONE shared display-mode callback
 * handler ({@link handleDisplayModeCallback}). The four mode-button callbacks
 * (`think_`/`toolres_`/`subag_`/`verb_`) differ only in these fields, so the
 * handler is written once (S2 review note — was four near-identical copies).
 */
interface DisplayModeCallbackConfig {
  /** i18n mode-label namespace (`thinking`/`toolResults`/`subagent`/`verbosity`). */
  i18nGroup: string;
  /** Action prefix used for the re-rendered keyboard's callbacks. */
  callbackPrefix: string;
  /** `true` to gate the callback to OpenCode-bound topics. All four families
   * drive both backends now (S5 un-gated `/thinking`), so this is `false` for
   * every config — kept as a field for the rare future per-backend display pref. */
  isOpenCodeOnly: boolean;
  /** Persist the picked mode (the per-command apply helper). */
  apply: (key: ThreadKey, mode: DisplayVerbosityMode) => Promise<void>;
  /** cb-query i18n key for the bad-mode answer. */
  errorCbKey: string;
  /** cb-query i18n key for the success answer. */
  setCbKey: string;
  /** Short tag for the keyboard-re-render warning log. */
  logTag: string;
}

/**
 * @description Shared handler for a display-mode button press. Authorises,
 * optionally gates to OpenCode (no family does today; see {@link
 * DisplayModeCallbackConfig.isOpenCodeOnly}), normalizes the picked mode
 * (legacy names on stale buttons keep working), persists it, answers the
 * callback, and re-renders the picker so the `✓` follows the new mode. The
 * re-render always marks `picked` because a single button press sets exactly
 * that mode (for `/verbosity` all three prefs then equal it, so there is always
 * an exact match).
 */
async function handleDisplayModeCallback(
  ctx: Context & { match: RegExpExecArray },
  config: DisplayModeCallbackConfig,
): Promise<void> {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  // Optional OpenCode-only gate (no family uses it today — see
  // `DisplayModeCallbackConfig.isOpenCodeOnly`): a stale button on a topic
  // switched to Claude after the picker was shown must not silently set an
  // unused pref.
  if (config.isOpenCodeOnly && !(getThreadAdapter(key) instanceof OpenCodeAdapter)) {
    await ctx.answerCbQuery(t('cb.not_supported', { label: getThreadAdapter(key).label }));
    return;
  }
  // Normalize BEFORE validating: picker messages posted before the vocabulary
  // was unified still carry old mode names (`think_detailed`, `subag_compact`,
  // `toolres_hide`) in their buttons — those must keep working.
  const picked = normalizeDisplayVerbosityMode(ctx.match[1]);
  if (!picked) {
    await ctx.answerCbQuery(t(config.errorCbKey, { error: ctx.match[1].slice(0, 50) }));
    return;
  }
  await config.apply(key, picked);
  await ctx.answerCbQuery(t(config.setCbKey, { mode: t(`${config.i18nGroup}.mode.${picked}`) }));

  // Re-render the picker so the `✓` follows the new mode (mirrors effort_cb).
  const cbMsg = ctx.callbackQuery?.message as Message | undefined;
  if (cbMsg) {
    const keyboard = buildDisplayModeKeyboard(config.i18nGroup, config.callbackPrefix, picked);
    try {
      await enqueueSend(
        key,
        () => bot.telegram.editMessageReplyMarkup(
          key.chatId, cbMsg.message_id, undefined, keyboard.reply_markup,
        ),
      );
    } catch (e) {
      const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
      if (!/message is not modified/i.test(desc)) {
        console.warn(`[${config.logTag}] keyboard re-render failed:`, desc || e);
      }
    }
  }
}

// All four mode callbacks drive both backends (S5 un-gated /thinking). Each is a
// one-line delegation to the shared handler above.
bot.action(/^think_(.+)$/, (ctx) => handleDisplayModeCallback(ctx, {
  i18nGroup: 'thinking', callbackPrefix: 'think', isOpenCodeOnly: false,
  apply: applyThinkingMode, errorCbKey: 'cb.thinking_error', setCbKey: 'cb.thinking_set', logTag: 'think_cb',
}));

bot.action(/^toolres_(.+)$/, (ctx) => handleDisplayModeCallback(ctx, {
  i18nGroup: 'toolResults', callbackPrefix: 'toolres', isOpenCodeOnly: false,
  apply: applyToolResultMode, errorCbKey: 'cb.toolresults_error', setCbKey: 'cb.toolresults_set', logTag: 'toolres_cb',
}));

bot.action(/^subag_(.+)$/, (ctx) => handleDisplayModeCallback(ctx, {
  i18nGroup: 'subagent', callbackPrefix: 'subag', isOpenCodeOnly: false,
  apply: applySubagentMode, errorCbKey: 'cb.subagent_error', setCbKey: 'cb.subagent_set', logTag: 'subag_cb',
}));

bot.action(/^verb_(.+)$/, (ctx) => handleDisplayModeCallback(ctx, {
  i18nGroup: 'verbosity', callbackPrefix: 'verb', isOpenCodeOnly: false,
  apply: applyVerbosityLevel, errorCbKey: 'cb.verbosity_error', setCbKey: 'cb.verbosity_set', logTag: 'verb_cb',
}));

bot.action(/^agent_(.+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const adapterName = ctx.match[1];
  try {
    // Resolve up-front so an unknown name throws into the catch (→ "unknown
    // agent") before any side effect, and so the toast can name the label.
    const adapter = getAdapter(adapterName);
    await ctx.answerCbQuery(t('cb.agent_switched', { label: adapter.label }));
    // One-tap start: switch + start the agent (was select-only — the user then
    // had to type /claude). `handleAgentStart` owns the General / binding /
    // already-active guards and the self-greeting ready-text suppression, and
    // `switchThreadAdapter` inside it persists the adapter choice.
    await handleAgentStart(key, adapterName);
    if (state.getBinding(key)) {
      await updatePinnedStatus(key).catch(() => {});
    }

    // Re-render the picker so the `✓` marker follows the newly-selected agent
    // instead of staying stuck on the previous one (B16, mirrors B12). The
    // start keeps the picker message visible (it is neither edited nor deleted),
    // so the stale marker would otherwise persist.
    const cbMsg = ctx.callbackQuery?.message as Message | undefined;
    if (cbMsg) {
      const keyboard = buildAgentKeyboard(getAvailableAdapters(), adapterName);
      try {
        await enqueueSend(
          key,
          () => bot.telegram.editMessageReplyMarkup(
            key.chatId, cbMsg.message_id, undefined, keyboard.reply_markup,
          ),
        );
      } catch (e) {
        const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
        if (!/message is not modified/i.test(desc)) {
          console.warn('[agent_cb] keyboard re-render failed:', desc || e);
        }
      }
    }
  } catch {
    await ctx.answerCbQuery(t('cb.unknown_agent'));
  }
});

// Inline [resume] buttons posted by `handleSessionsList`. The button only
// carries the list index (`resume_<idx>`) because Telegram caps callback_data
// at 64 bytes; the full id lives in `threadSessionLists`. Shares the resume
// core with the digit-reply path via `resumeSessionByIndex`.
bot.action(/^resume_(\d+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  await ctx.answerCbQuery();
  const idx = Number(ctx.match[1]);
  // A pick from the button also closes pick-mode (mirrors a digit reply).
  awaitingSessionSelection.delete(keyToString(key));
  const result = await resumeSessionByIndex(key, idx, async () => {
    await replyToThread(key, t('session.expired'));
  });
  if (result !== null) await replyToThread(key, result);
});

bot.action(/^opt_(\d+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const optNum = ctx.match[1];
  const adapter = getThreadAdapter(key);
  if (adapter.checkIsActive(key)) {
    markNeedsNewMessage(key);
    adapter.sendInput(key, optNum);
    await ctx.answerCbQuery(t('cb.sent_option', { option: optNum }));
  } else {
    await ctx.answerCbQuery(t('cb.agent_not_running'));
  }
});

bot.action(/^qa_(\d+)_(\d+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const qIdx = parseInt(ctx.match[1], 10);
  const optIdx = parseInt(ctx.match[2], 10);
  const kStr = keyToString(key);
  const pending = pendingQuestions.get(kStr);
  if (!pending) { await ctx.answerCbQuery(t('cb.no_pending_question')); return; }
  // A button must belong to the question currently on screen. With sequential
  // posting we only ever show `currentIndex`, so a click for any other index is
  // a stale button from a question that was already answered/advanced.
  if (qIdx !== pending.currentIndex) {
    await ctx.answerCbQuery(t('cb.no_pending_question'));
    return;
  }
  const question = pending.data.questions[qIdx];
  if (!question || !question.options[optIdx]) {
    await ctx.answerCbQuery(t('cb.invalid_option'));
    return;
  }
  const selectedLabel = question.options[optIdx].label;
  await applyQuestionAnswer(key, [selectedLabel]);
  await ctx.answerCbQuery(selectedLabel);
});

/**
 * @description The single choke point for delivering a free-form prompt (text OR
 * voice) to a thread whose agent is already active. In order:
 *  1. If an OpenCode question is pending, route the reply: a bare digit in range
 *     ANSWERS that option (unchanged path); ANY other free-form input CANCELS
 *     the question and is delivered as a fresh prompt — a real message means
 *     "move on", never the question's answer.
 *  2. Else the G2 wedge backstop: an OpenCode turn the bot lost track of can
 *     still be wedged behind an open question (the `pendingQuestions` map empty,
 *     e.g. `question.asked` dropped at ask time). Abort the turn and tell the
 *     user before forwarding so the prompt doesn't queue behind it forever.
 *  3. Forward the prompt (a bare `/clear` first purges thread context + files).
 *
 * Claude/terminal never reach step 1 (their routing returns earlier in the text
 * handler, and `pendingQuestions`/`answerQuestion` are OpenCode-only). For them
 * `forwardPromptToAgent` interrupts the TUI selector itself.
 */
async function deliverActivePrompt(
  key: ThreadKey,
  adapter: AgentAdapter,
  text: string,
  sentAtMs?: number,
): Promise<void> {
  const pending = pendingQuestions.get(keyToString(key));
  if (pending && adapter.answerQuestion) {
    const currentQuestion = pending.data.questions[pending.currentIndex];
    const route = getQuestionReplyRoute(text, currentQuestion);
    if (route.kind === 'answer') {
      await applyQuestionAnswer(key, route.labels);
      return;
    }
    await cancelPendingQuestionAndForward(key, adapter, text, sentAtMs);
    return;
  }

  // A bare `/clear` forwarded to the agent wipes its context (Claude TUI), so
  // the next prompt must re-carry the thread-context preamble. Reset the marker
  // before forwarding — the slash text itself never gets a preamble. The agent's
  // context is gone, so any intake files it might reference are now useless —
  // purge the thread's files dir in the same breath.
  if (text === forwardedClearCommand) {
    clearThreadContextMarker(key);
    await purgeThreadFiles(getDataDir(), key).catch((e) =>
      console.warn(`[file] purge on /clear failed for ${keyToString(key)}:`, e),
    );
  }

  // Backstop (G2): NO pendingQuestions entry, yet an OpenCode turn can still be
  // wedged behind an open question the bot lost track of (question.asked dropped
  // at ask time, or a restore that couldn't run). Forwarding now would queue the
  // prompt behind the dead turn forever, so if the adapter reports the session
  // wedged, abort the turn and tell the user the previous question was cancelled
  // — THEN forward. Strict check (open question for THIS session only), so a
  // genuinely streaming turn / live sub-agent is never aborted. Claude has no
  // such method → unchanged.
  if (await adapter.checkIsWedgedOnQuestion?.(key)) {
    adapter.sendSignal(key, 'SIGINT');
    await replyToThread(key, t('agent.question_cancelled_for_prompt'));
  }
  await forwardPromptToAgent(key, adapter, text, sentAtMs);
}

/**
 * @description Cancel a pending OpenCode question because the user sent free-form
 * input instead of answering it, then deliver that input as a fresh prompt. In
 * order: clear the bot's pending-question state, neutralize the stale buttons
 * message (edit it to a "cancelled" label so a late tap can't re-answer an
 * aborted question), abort the wedged OpenCode turn (`SIGINT` → `/session/:id/
 * abort`), post the "previous question cancelled" notice, then forward.
 *
 * The buttons-message edit runs through `runQuestionLifecycleOp` (same serializer
 * as the answer path) so it can't race a concurrent re-post-to-bottom. The
 * `messageId` + header are captured BEFORE clearing, since `clearPendingQuestion`
 * drops the state.
 */
async function cancelPendingQuestionAndForward(
  key: ThreadKey,
  adapter: AgentAdapter,
  text: string,
  sentAtMs?: number,
): Promise<void> {
  const pending = pendingQuestions.get(keyToString(key));
  const cancelledMessageId = pending?.messageId ?? null;
  const cancelledQuestion = pending?.data.questions[pending.currentIndex];

  clearPendingQuestion(key);

  if (cancelledMessageId !== null && cancelledQuestion) {
    const header = cancelledQuestion.header || cancelledQuestion.question;
    await runQuestionLifecycleOp(key, () =>
      editThreadMessage(key, cancelledMessageId, t('agent.question_cancelled_msg_label', { header })),
    );
  }

  // Close the question on the OpenCode server too (not just the bot-local +
  // Telegram state above): an abandoned-but-still-open question keeps getting
  // re-found by `restoreOpenQuestion` (`GET /question` on every reattach) and
  // re-posted after a restart. Runs while the session is still active — the
  // SIGINT below then unblocks the wedged turn. No-op for Claude / no pending
  // question (the adapter guards both).
  adapter.rejectQuestion?.(key);
  adapter.sendSignal(key, 'SIGINT');
  await replyToThread(key, t('agent.question_cancelled_for_prompt'));
  await forwardPromptToAgent(key, adapter, text, sentAtMs);
}

/**
 * @description Record one answer for the CURRENTLY shown OpenCode question and
 * either advance to the next unanswered question or, once every question is
 * answered, reply to the agent with the full answer matrix (S2). Shared by the
 * inline-button (`qa_`) and custom-text answer paths so both collect answers
 * locally instead of closing the request on the first answer with empties.
 */
async function applyQuestionAnswer(key: ThreadKey, answerForCurrent: string[]): Promise<void> {
  // Serialized: an in-flight re-post (delete+re-send) must fully finish before
  // the answer reads `messageId` for its ✅-edit — otherwise the edit targets
  // a message the re-post just deleted (live 2026-06-10: "message to edit not
  // found" + the next question never reached the topic).
  await runQuestionLifecycleOp(key, () => applyQuestionAnswerInner(key, answerForCurrent));
}

async function applyQuestionAnswerInner(key: ThreadKey, answerForCurrent: string[]): Promise<void> {
  const kStr = keyToString(key);
  const pending = pendingQuestions.get(kStr);
  if (!pending) return;

  const answeredQuestion = pending.data.questions[pending.currentIndex];
  const { nextState, action } = recordAnswerAndAdvance(pending, answerForCurrent);

  // Mark the answered question's message as done (the chosen answer in place).
  if (pending.messageId !== null && answeredQuestion) {
    await editThreadMessage(
      key,
      pending.messageId,
      `✅ ${answeredQuestion.header || answeredQuestion.question}: ${answerForCurrent.join(', ')}`,
    );
  }

  if (action.kind === 'submit') {
    const adapter = getThreadAdapter(key);
    clearPendingQuestion(key);
    if (adapter.answerQuestion) {
      // Load-bearing: send the REAL collected answers (all questions), not the
      // old per-answer matrix that blanked every other question.
      adapter.answerQuestion(key, action.matrix);
      markNeedsNewMessage(key);
    }
    return;
  }

  // More questions remain: persist the advanced state, then post the next one
  // (which re-owns `messageId`). DO NOT reply to the agent yet.
  setPendingQuestion(key, nextState);
  await postPendingQuestionAt(key);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Adapter event handlers (output / status / question / closed / error)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Whether the thread's backend streams output the DM draft "cursor"
 * can accumulate. BOTH streaming backends qualify now: OpenCode marks
 * continuations directly (`openCodeAdapter` tracks `lastEmittedLength`), while
 * the Claude scrape adapter emits each poll's prose delta with NO continuation
 * meta — the DM transport synthesises the flag for it (`getDmDraftContinuation`,
 * gated on `checkAdapterOutputsDeltas`) so the answer accumulates into one
 * full-snapshot draft instead of finalizing per poll. Group mode never reaches
 * here (the group transport is the thin `queueOutput` path).
 */
function checkAdapterSupportsDraftStreaming(key: ThreadKey): boolean {
  const name = getThreadAdapterName(key);
  return name === 'opencode' || name === 'claude' || name === claudeJsonStreamAdapterName;
}

/**
 * @description Whether the thread's adapter emits incremental deltas without
 * continuation meta (the Claude scrape adapter). The DM cursor reads this to
 * synthesise the continuation flag so Claude's per-poll prose deltas accumulate
 * into ONE draft rather than each finalizing as its own message.
 */
function checkAdapterOutputsDeltas(key: ThreadKey): boolean {
  return getThreadAdapter(key).outputsDeltas === true;
}

function handleAgentOutput(key: ThreadKey, output: string, meta?: OutputEventMeta): void {
  console.log(`[Bot] output ${keyToString(key)} (${output.length}): ${output.slice(0, 100)}...`);
  if (!output.trim()) return;
  traceAgentEmit('output', key, output);

  // Sub-agent chunk (`/subagent full`, S4): render it visibly marked and
  // OUTSIDE the parent reply's edit-in-place continuation chain — it must
  // never become `lastMessageId`/`lastMessageText` or flip `needsNewMessage`
  // (a child transcript as the continuation base would corrupt the parent's
  // accounting). Each flush is its own marked message (the prefix rides the
  // first chunk of a long split) — acceptable v1, `full` mode is opt-in. It
  // also deliberately does NOT delete the status frame: the parent is still
  // mid-turn while its sub-agent streams.
  if (meta?.isSubagent) {
    void sendStandaloneAgentMessage(key, `${buildSubagentOutputPrefix()} ${output}`);
    return;
  }

  // A scraped Claude question (S4): send it as its OWN message (id captured)
  // instead of the coalescing output cursor, then PIN it so the muted topic
  // fires a notification. `markNeedsNewMessage` so the agent's following answer
  // starts a fresh message below the question rather than appending onto it.
  // The unpin is the adapter's `questionGone` event (selector left) or
  // `clearPendingQuestion` (hard teardown). OpenCode questions never reach here
  // (they use the discrete `question` event + `postPendingQuestionAt`).
  if (meta?.isQuestion) {
    stopTypingLoader(key);
    void (async () => {
      // Land any in-flight content (DM draft / coalesced group output) ABOVE the
      // question first, mirroring the OpenCode question path's finalize.
      await getOutputTransport().finalizeInFlight(key);
      const id = await replyChunkWithFallback(key, renderAgentHtml(output), output);
      if (id !== null) void pinThreadQuestion(key, id);
    })();
    markNeedsNewMessage(key);
    return;
  }

  // Bot-side safety net for Claude-CLI "thinking" bursts that slip past
  // the adapter classifier (`checkIsStatusOutput`'s ≤200-char / ≤3-line
  // heuristic). When the diff between two polls happens to contain
  // 4+ progress ticks or pushes the chunk over 200 chars, the adapter
  // routes it as substantive `output` and the thread used to receive a
  // wall of spinner messages. The redirect into `handleAgentStatus`
  // sends the chunk through the same coalescer that single-line ticks
  // already use, so a long-thinking session edits ONE rolling message
  // instead of flooding the topic. Adapter-agnostic — same fix protects
  // OpenCode and any future adapter without touching their code.
  // See `progressLine.ts` for the regex and the chunk-purity rule.
  if (checkIsProgressChunk(output)) {
    // Collapse a redraw burst (many stacked ticks / increasing `/compact`
    // percentages) down to its latest frame before it reaches the
    // coalescer, so the rolling status message shows only the current
    // state instead of a growing wall of intermediate percentages.
    void handleAgentStatus(key, collapseProgressChunk(output));
    return;
  }

  // Recovery: a real answer means the session is working again → retire any
  // pinned logged-out notice and clear its one-notice guard so a LATER logout
  // notifies afresh. Placed AFTER the sub-agent / question / progress-chunk
  // early-returns. Also SKIP when this output is itself an error surface (Claude
  // `⎿ … /login` under `/tool_results full`, or OpenCode's `OpenCode error: …`
  // line): those flow as `output` too, and clearing on them would let a repeated
  // `session.error` clear-then-repin-and-RE-NOTIFY — the very double-notification
  // the one-per-episode guard exists to prevent.
  if (classifyAgentApiError(output, Date.now()) === null) clearAuthNotice(key);

  // The real answer is starting → resolve the thinking message per mode. Only
  // `minimal` removes its live indicator now (nothing should remain); `full` /
  // `short` leave their persisted message in place. No-op when no thinking
  // message exists (non-OpenCode threads, or a turn without reasoning).
  if (getThreadMessageState(key).thinkingMessageId !== null) {
    const thinkingMode = state.getDisplayPrefs(key).thinking;
    if (getThinkingAnswerStartAction(thinkingMode) === 'delete') clearThinkingMessage(key);
  }

  // Real output supersedes any not-yet-sent status frame. Without this,
  // a thinking-text edit queued ~50 ms before could still hit Telegram
  // and briefly overwrite the visible status with stale text after the
  // real output already landed. Clearing `pendingText` here is safe even
  // mid-flush: the loop re-checks `pendingText` after every send.
  getStatusCoalesceState(key).pendingText = null;

  const msgState = getThreadMessageState(key);
  const hadStatusMessage = msgState.statusMessageId !== null;

  if (hadStatusMessage) {
    const adapter = getThreadAdapter(key);
    if (adapter.outputsDeltas) msgState.needsNewMessage = true;
  }
  // S3: do NOT stop the typing loader on the first output. It is a persistent
  // "working" state now — the loader self-sustains while output is streaming OR
  // the agent is busy and self-stops only when the topic is drained + idle
  // (teardown paths clear it). Stopping here made the topic look idle mid-answer.
  // Delete UNCONDITIONALLY — not only when a frame is currently visible. A
  // liveness/scrape `sendStatusFrame` create may be mid-`await` with its id not
  // yet stored; calling `deleteStatusMessage` here bumps the frame generation so
  // that in-flight create discards its message instead of resurrecting it as an
  // orphan under the freshly-arrived output (the leftover-spinner half of #11).
  // When no id is tracked it's a cheap no-op delete that still bumps the gen.
  void deleteStatusMessage(key).catch(() => {});

  // Defense-in-depth backstop (flood 2026-06-16): suppress a FRESH permanent
  // output that is byte-identical to one recently sent to this thread, capping a
  // runaway regardless of which emit path produced it (the table flood was ~500
  // identical copies). Guard ONLY fresh permanent output: a continuation is the
  // OpenCode append chain (its tail is expected to repeat-then-extend), and
  // status/transient/question frames never reach here (separate events). Short
  // blocks pass (the helper's min-chars gate) so a legitimately-repeated short
  // answer is never eaten. On a suppressed duplicate: do NOT deliver, log once.
  if (!meta?.isContinuation && identicalOutputGuard.checkAndRecord(keyToString(key), output, Date.now())) {
    console.log(`[Bot] identical-output backstop suppressed a repeat ${keyToString(key)} (${output.length} chars)`);
    return;
  }

  // Output routing is selected once at boot by CHAT_MODE (the OutputTransport
  // seam). Group routes to the unchanged `queueOutput` edit-in-place persist
  // path; DM owns the draft-cursor manager (streaming tail → draft, complete
  // one-shot → finalize-then-post, Claude baseline → queueOutput). The 3-way
  // DM split + the group thin path live in `createOutputTransport`.
  getOutputTransport().deliverOutput(key, output, meta);

  // Bug #11: the agent may KEEP working after this chunk (which just deleted the
  // status frame). Arm the liveness loop so that once output streaming pauses
  // while still busy, the activity frame reappears — without waiting for the
  // next opportunistic scraped spinner (which may never come during a quiet
  // think). Claude-only; idempotent if already armed; self-disarms on idle.
  startClaudeLiveness(key);
}

/**
 * @description Adapter `status` event entry point. Wraps {@link handleAgentStatus}
 * (the pure send-a-frame primitive) with the two Claude-only liveness side
 * effects that must NOT happen for the liveness loop's own re-injected frames
 * (those call `handleAgentStatus` directly): record the scraped activity text as
 * the loop's preferred frame text, and arm the busy-state-driven loop (bug #11)
 * so the frame survives the gaps between scrape emits.
 */
function handleAdapterStatus(key: ThreadKey, status: string): void {
  if (status.trim()) {
    const adapter = getThreadAdapter(key);
    if (adapter instanceof ClaudeCliAdapter) {
      getThreadMessageState(key).lastActivityText = status;
      startClaudeLiveness(key);
    }
  }
  void handleAgentStatus(key, status);
}

/**
 * @description Receive a `status` (thinking/spinner) event from the adapter.
 *
 * Does not send to Telegram directly — instead it parks the latest text in
 * the per-thread coalescer and (re)starts the flush loop if one isn't
 * already running. See {@link StatusCoalesceState} for the rationale: a
 * burst of status events from a busy agent used to translate 1:1 into
 * `editMessageText` operations on the rate-limiter FIFO, pushing real
 * `output` sends behind a wall of stale thinking frames.
 */
async function handleAgentStatus(key: ThreadKey, status: string): Promise<void> {
  if (!status.trim()) return;
  console.log(`[Bot] status ${keyToString(key)}: ${status.slice(0, 100)}`);
  traceAgentEmit('status', key, status);

  // S3: a status/thinking frame does NOT stop the typing state — both are
  // "working" cues and typing persists while the agent is busy. The loader
  // self-stops when the topic drains + idles; teardown paths clear it explicitly.

  // DM streaming v2 — status is ALWAYS the bottom-most message. If a content
  // cursor draft is still active, finalize it to a permanent message FIRST so the
  // status frame posts BELOW the latest content (never stranded above it). The
  // delete-status-on-output in `handleAgentOutput` is the other half: when content
  // resumes the stale status is removed and the next status re-posts below again.
  // Group mode now drains any coalesced-but-unsent output here too (S2), so the
  // status likewise lands below content rather than above a still-buffered chunk;
  // a fully-delivered turn is a no-op.
  await getOutputTransport().finalizeInFlight(key);

  const c = getStatusCoalesceState(key);
  c.pendingText = status;
  // Don't start a flush while one is already running OR while a deferred
  // retry is armed for a 429 cooldown — in both cases the newest
  // `pendingText` is picked up by the running loop / the armed timer, and a
  // fresh flush would only re-defer and try to arm a second timer.
  if (!c.inFlight && !c.deferRetryTimer) {
    void flushStatusCoalescer(key);
  }
}

/**
 * @description Drain the per-thread status coalescer.
 *
 * Loops while `pendingText` keeps being refreshed by new `handleAgentStatus`
 * calls. Each iteration consults {@link getStatusFlushAction} for the current
 * `pendingText`, so:
 *
 *  - intermediate frames that arrive during a send are dropped (the loop
 *    only sees the latest one on its next iteration);
 *  - at most one send per thread is in flight at any time, regardless of
 *    how fast Claude's poller emits new frames;
 *  - if `handleAgentOutput` clears `pendingText`, the loop exits cleanly
 *    on the next iteration without queueing a stale edit;
 *  - an identical frame is skipped (no `400 "message is not modified"`);
 *  - while the chat is in a 429 cooldown the loop *defers*: it stops sending
 *    disposable spinner frames (which would burn the budget interactive
 *    replies and real output need) and re-arms once after the cooldown so the
 *    newest frame still shows.
 */
async function flushStatusCoalescer(key: ThreadKey): Promise<void> {
  const c = getStatusCoalesceState(key);
  if (c.inFlight) return;
  c.inFlight = true;
  try {
    while (c.pendingText !== null) {
      const text = c.pendingText;
      const action = getStatusFlushAction({
        nextText: text,
        lastSentText: c.lastSentText,
        isRateLimited: checkIsRateLimited(key.chatId),
      });

      if (action === 'defer') {
        // Leave the newest frame in `pendingText`; resume once after the
        // cooldown lifts. Arm at most one timer — new events meanwhile only
        // refresh `pendingText` (see `handleAgentStatus`).
        armStatusDeferRetry(key, c);
        break;
      }

      // Consume the frame for both `send` and `skip`.
      c.pendingText = null;
      if (action === 'skip') continue;

      const sent = await sendStatusFrame(key, text);
      if (sent) c.lastSentText = text;
    }
  } finally {
    c.inFlight = false;
  }
}

/**
 * @description Arm a one-shot timer to resume a status flush deferred during
 * a 429 cooldown. Idempotent: if a retry is already armed, does nothing (the
 * newest `pendingText` will be picked up when it fires).
 */
function armStatusDeferRetry(key: ThreadKey, c: StatusCoalesceState): void {
  if (c.deferRetryTimer) return;
  const waitMs = getRateLimitRemainingMs(key.chatId) + COOLDOWN_RETRY_SLACK_MS;
  c.deferRetryTimer = setTimeout(() => {
    c.deferRetryTimer = null;
    void flushStatusCoalescer(key);
  }, waitMs);
}

/**
 * @description Edit (or create) the thread's transient status message
 * with `status`. Lifted out of the old `handleAgentStatus` body so the
 * coalescer loop can call it once per latest-frame, instead of one
 * IIFE per incoming event.
 *
 * Returns `true` if the (first chunk of the) frame reached Telegram, so the
 * coalescer can record it as `lastSentText` and skip a redundant re-send.
 */
async function sendStatusFrame(key: ThreadKey, status: string): Promise<boolean> {
  const msgState = getThreadMessageState(key);
  // Render-aware split: status frames are sent through `renderAgentHtml` below,
  // which inflates the source past Telegram's cap, so size chunks by their
  // rendered length (same measure the durable-output flush plan uses).
  const chunks = splitMessage(status, undefined, chunk => renderAgentHtml(chunk).length);
  // Capture the generation BEFORE any create: a `deleteStatusMessage` that races
  // an in-flight create bumps it, telling us to discard the just-created message
  // rather than resurrect `statusMessageId` as an orphan (the leftover-spinner
  // bug). Single source of truth for the frame across liveness tick, scrape
  // coalescer, and the output-supersede delete.
  const generationAtStart = msgState.statusFrameGeneration;
  // Store a freshly-created message id IFF no delete landed mid-create; otherwise
  // the message is already orphaned by that delete → remove it, store nothing.
  const storeOrDiscardCreatedFrame = async (createdId: number | null): Promise<boolean> => {
    if (createdId === null) return false;
    if (getStatusFrameStoreDecision(generationAtStart, msgState.statusFrameGeneration) === 'discard') {
      await deleteThreadMessage(key, createdId);
      return false;
    }
    setStatusFrameId(key, createdId);
    return true;
  };
  let landed = false;
  try {
    const firstRendered = renderAgentHtml(chunks[0]);
    if (msgState.statusMessageId) {
      const editId = msgState.statusMessageId;
      const ok = await editThreadMessage(key, editId, firstRendered, {
        parse_mode: 'HTML',
      });
      // A delete that landed during the edit already nulled (or replaced) the id;
      // don't claim the frame as live — let the create path below re-evaluate.
      if (ok && msgState.statusMessageId === editId) {
        landed = true;
      } else if (!ok) {
        // Edit failed (e.g. the message was deleted under us). Only null it if it
        // still points at the message we tried to edit — a concurrent delete may
        // already have moved it. Then create a replacement under the gen guard.
        if (msgState.statusMessageId === editId) setStatusFrameId(key, null);
        const id = await replyChunkWithFallback(key, firstRendered, chunks[0]);
        landed = await storeOrDiscardCreatedFrame(id);
      }
    } else {
      const id = await replyChunkWithFallback(key, firstRendered, chunks[0]);
      landed = await storeOrDiscardCreatedFrame(id);
    }
    for (let i = 1; i < chunks.length; i++) {
      const rendered = renderAgentHtml(chunks[i]);
      const id = await replyChunkWithFallback(key, rendered, chunks[i]);
      await storeOrDiscardCreatedFrame(id);
    }
  } catch (err) {
    console.error('[sendStatusFrame] Failed:', err);
  }
  // S3: a status/liveness frame landed below any pending question — bring the
  // question back to the bottom (debounced; no-op when no question is pending).
  if (landed) onThreadActivityWhileQuestionPending(key);
  return landed;
}

// ── Thinking (chain-of-thought) lifecycle — OpenCode (#1, #6) ────────────────
//
// SINGLE OWNER of the dedicated `thinkingMessageId`, kept separate from
// `statusMessageId` so the live "☁️ thinking …" indicator persists across tool
// status churn. The adapter emits a mode-AGNOSTIC `thinking` event; the bot
// applies the per-thread mode (`state.getDisplayPrefs(key).thinking`). The live
// indicator shows in ALL modes — the mode only controls what remains after
// reasoning ends. See `utils/thinkingRender.ts` for the pure mode×phase matrix.

/** Headroom (chars) reserved above the per-message cap for the rendered cloud
 * header + the truncation marker when a long `full`-mode reasoning body must be
 * tail-trimmed to fit one editable message. */
const thinkingDetailedHeaderHeadroom = 200;

/**
 * @description Render the thinking-frame body for a mode×phase, ready to pass to
 * `renderAgentHtml`. Pure-ish (only reads i18n): the live label is identical in
 * all modes; `full` appends the accumulated reasoning text (tail-trimmed to
 * one message); `done` collapses to the "💭 thought for {N}s" line for `short`.
 */
function buildThinkingFrameText(mode: DisplayVerbosityMode, payload: ThinkingEvent): string {
  if (payload.phase === 'done') {
    // Only `short` collapses to a duration line here; `full` keeps its last
    // live body (the caller does not re-render on `keep`).
    const seconds = formatThinkingDurationSeconds(payload.durationMs ?? 0);
    return t('thinking.thoughtForSeconds', { seconds: seconds.toString() });
  }
  const header = t('thinking.live');
  if (mode !== 'full' || !payload.text.trim()) return header;
  // Full mode: header + the accumulated reasoning. Keep the TAIL (the most
  // recent reasoning, what is "currently" streaming) when it overflows one
  // message, with a leading "…" so the trim is visible.
  const bodyBudget = MAX_MESSAGE_LEN - thinkingDetailedHeaderHeadroom;
  let body = payload.text;
  if (body.length > bodyBudget) body = `…${body.slice(body.length - bodyBudget)}`;
  return `${header}\n\n${body}`;
}

/**
 * @description Adapter `thinking` event entry point. Reads the per-thread
 * thinking {@link DisplayVerbosityMode}, decides the action via the pure
 * {@link getThinkingEventAction}, and drives the dedicated thinking message.
 *
 * - `editLiveLabel` / `editLiveDetailed` → coalesced live edit of one message.
 * - `collapseToDuration` → final edit to "💭 thought for {N}s", then persist.
 * - `keep` → leave the message as-is (full done), persist.
 *
 * "Persist" means clear `thinkingMessageId` so the NEXT response starts a fresh
 * thinking message — the existing one stays in the chat untouched.
 */
function handleAgentThinking(key: ThreadKey, payload: ThinkingEvent): void {
  traceAgentEmit('thinking', key, payload.text);
  const mode = state.getDisplayPrefs(key).thinking;
  const action = getThinkingEventAction(mode, payload.phase);

  if (action === 'keep') {
    // Full done: nothing to send — the last live frame already shows the
    // full reasoning. Detach the id so the next response opens a fresh message.
    finishThinkingMessage(key);
    return;
  }

  if (action === 'holdForAnswer') {
    // Minimal done: leave the live indicator AND keep its id tracked so the
    // answer-start trigger (`handleAgentOutput`) can delete it. Nothing to send.
    return;
  }

  // `editLiveLabel` / `editLiveDetailed` (live) and `collapseToDuration` (short
  // done) all SEND a frame. The short-done frame is terminal: the flush detaches
  // the id only AFTER editing the collapse onto the same message.
  const frameText = buildThinkingFrameText(mode, payload);
  queueThinkingFrame(key, frameText, action === 'collapseToDuration');
}

/**
 * @description Detach the tracked thinking message id WITHOUT deleting the
 * message — it stays in the chat as the persisted reasoning record. The next
 * response's first `thinking` frame then creates a brand-new message. The
 * in-flight coalescer keeps the id it captured, so a frame still being sent
 * finishes against the right message.
 */
function finishThinkingMessage(key: ThreadKey): void {
  setThinkingFrameId(key, null);
  const coalescer = thinkingCoalescers.get(keyToString(key));
  // Drop the dedup baseline so the NEXT response's first frame is never skipped
  // as "identical" against this response's last frame.
  if (coalescer) coalescer.lastSentHtml = null;
}

/**
 * @description Park the latest thinking frame in the coalescer and (re)start the
 * single-flight flush loop. Newest frame always wins; at most one edit is in
 * flight per thread. `isTerminal` marks the short-mode collapse frame — after it
 * drains, the flush detaches the tracked id so the next response is fresh.
 */
function queueThinkingFrame(key: ThreadKey, frameText: string, isTerminal: boolean): void {
  const c = getThinkingCoalesceState(key);
  c.pendingHtml = renderAgentHtml(frameText);
  if (isTerminal) c.detachAfterDrain = true;
  if (!c.inFlight) void flushThinkingCoalescer(key);
}

/**
 * @description Drain the per-thread thinking coalescer: edit (or create) the
 * single thinking message with the latest pending frame. Identical frames are
 * skipped (no `400 "message is not modified"`); intermediate frames that arrive
 * during a send are dropped (the loop only sees the latest on its next pass).
 * When `detachAfterDrain` is armed (short-mode collapse), the tracked id is
 * detached only AFTER the final frame is edited onto the same message.
 */
async function flushThinkingCoalescer(key: ThreadKey): Promise<void> {
  const c = getThinkingCoalesceState(key);
  if (c.inFlight) return;
  c.inFlight = true;
  try {
    while (c.pendingHtml !== null) {
      const html = c.pendingHtml;
      c.pendingHtml = null;
      if (html === c.lastSentHtml) continue;
      const sent = await sendThinkingFrame(key, html);
      if (sent) c.lastSentHtml = html;
    }
    if (c.detachAfterDrain) {
      c.detachAfterDrain = false;
      finishThinkingMessage(key);
    }
  } finally {
    c.inFlight = false;
  }
}

/**
 * @description Edit the thread's thinking message in place, or create it on the
 * first frame. The frame is pre-rendered HTML (one message — `full`-mode bodies
 * are tail-trimmed to fit). Returns `true` when the frame reached Telegram.
 */
async function sendThinkingFrame(key: ThreadKey, renderedHtml: string): Promise<boolean> {
  const msgState = getThreadMessageState(key);
  try {
    if (msgState.thinkingMessageId !== null) {
      const editId = msgState.thinkingMessageId;
      const ok = await editThreadMessage(key, editId, renderedHtml, { parse_mode: 'HTML' });
      // A clear (session end / takeover) may have nulled the id mid-edit — only
      // treat the edit as live if the id still points at the message we edited.
      if (ok && msgState.thinkingMessageId === editId) return true;
      if (!ok && msgState.thinkingMessageId === editId) setThinkingFrameId(key, null);
      return false;
    }
    // Create the first frame. Capture the generation BEFORE the send: a
    // `clearThinkingMessage` racing this create bumps it, so we delete the
    // just-created message instead of resurrecting it as an orphan under a
    // "session ended" / question UI (the leftover-frame guard).
    const generationAtStart = msgState.thinkingFrameGeneration;
    const id = await replyChunkWithFallback(key, renderedHtml, renderedHtml);
    if (id === null) return false;
    if (msgState.thinkingFrameGeneration !== generationAtStart) {
      await deleteThreadMessage(key, id);
      return false;
    }
    setThinkingFrameId(key, id);
    return true;
  } catch (err) {
    console.error('[sendThinkingFrame] Failed:', err);
    return false;
  }
}

// ── Tool results — OpenCode (#8, S3) ─────────────────────────────────────────
//
// The adapter emits a mode-AGNOSTIC `toolResult` event for every completed
// tool call that produced output (the transient 🔧 status keeps flowing
// independently in all modes). The bot resolves the per-thread tool-results
// `DisplayVerbosityMode` here and renders the body as its OWN fresh message —
// never edited into the answer's continuation chain. See
// `utils/toolResultRender.ts` for the pure mode matrix + truncation caps.

/**
 * @description Adapter `toolResult` event entry point. `minimal` drops the body
 * (only the transient 🔧 status shows); `short` truncates
 * via the pure caps and appends a "… (truncated, /tool_results full)" footer;
 * `full` renders the whole body. The message is a header line `🔧 <tool> →`
 * (+ the tool's title when present, matching the transient status) over a
 * fenced code block.
 */
function handleAgentToolResult(key: ThreadKey, payload: ToolResultEvent): void {
  traceAgentEmit('toolResult', key, payload.output);
  const action = getToolResultRenderAction(state.getDisplayPrefs(key).toolResults);
  if (action === 'drop') return;

  const { text, isTruncated } = action === 'truncated'
    ? getTruncatedToolResult(payload.output)
    : { text: payload.output, isTruncated: false };

  const header = payload.title ? `🔧 ${payload.tool} → ${payload.title}` : `🔧 ${payload.tool} →`;
  const footer = isTruncated ? `\n${t('toolResults.truncated_footer')}` : '';
  void sendStandaloneAgentMessage(key, `${header}\n${buildFencedToolResultBody(text)}${footer}`);
}

/**
 * @description Send a STANDALONE agent message — a tool-result body (S3) or a
 * marked sub-agent chunk (S4) — through the same render machinery agent output
 * uses: render-aware split (`splitMessage` re-balances the ``` fences across
 * chunks — a `full` body can exceed Telegram's cap) + `renderAgentHtml` with
 * plain-text fallback. Unlike `sendOutputImmediate` it deliberately never
 * touches `lastMessageId` / `lastMessageText` / `needsNewMessage`: a
 * standalone message must not become the base of the answer's edit-in-place
 * continuation chain (the in-flight reply keeps growing in its own message
 * above it).
 */
async function sendStandaloneAgentMessage(key: ThreadKey, text: string): Promise<void> {
  const chunks = splitMessage(text, undefined, chunk => renderAgentHtml(chunk).length);
  for (const chunk of chunks) {
    await replyChunkWithFallback(key, renderAgentHtml(chunk), chunk);
  }
  // A standalone message is "other output" that landed below any pending
  // question — bring the question back to the bottom (debounced; no-op when
  // none pending).
  onThreadActivityWhileQuestionPending(key);
}

// ── Claude liveness loop (bug #11) ──────────────────────────────────────────
//
// SINGLE OWNER of the "recreate/keep-alive while busy" half of the
// `statusMessageId` lifecycle. The other half — "delete on real output" — stays
// in `handleAgentOutput`. They do not thrash because every liveness tick first
// checks `checkIsOutputStreaming`: while output owns the message the tick is a
// `noop`, so a just-deleted frame is recreated only once streaming pauses while
// the agent is still busy. The frame text rides the SAME coalescer + send path
// (`sendStatusFrame` via `handleAgentStatus`) as scraped spinner ticks, so the
// 429-aware defer/dedup machinery applies unchanged — no second send path.

/**
 * @description Build the liveness frame text via the pure
 * {@link buildClaudeLivenessFrameText}. Prefers the latest scraped activity line
 * (the whimsical `✻ Verb… (Ns · tokens)` the adapter emits as `status`), else a
 * neutral localized fallback, plus a live `m:ss` elapsed tail (S1 un-freeze) so
 * the frame visibly advances even when the scraped text is static — the elapsed
 * is the part the dedup's glyph-strip does NOT remove.
 */
function getClaudeLivenessFrameText(state: ThreadMessageState, nowMs: number): string {
  const glyph = CLAUDE_LIVENESS_GLYPHS[state.livenessGlyphIndex % CLAUDE_LIVENESS_GLYPHS.length];
  return buildClaudeLivenessFrameText({
    glyph,
    activityText: state.lastActivityText,
    fallbackText: t('agent.workingIndicator', { glyph }),
    workingSince: state.workingSince,
    nowMs,
  });
}

/**
 * @description One liveness tick: re-check busy, run the pure decision, execute
 * it on the shared status path, then re-arm or stop. Self-disarming — the timer
 * stops itself the instant the session goes idle, so the lifecycle handlers only
 * need to call {@link stopClaudeLiveness} for the hard teardown paths (stop /
 * close / quit / error), not for the normal busy→idle return.
 */
function runClaudeLivenessTick(key: ThreadKey): void {
  const state = getThreadMessageState(key);
  const adapter = getThreadAdapter(key);
  // Gate to Claude: only its tmux-scrape path has the #11 gap (OpenCode liveness
  // is a separate plan). `checkIsBusy` is Claude's cheap sync footer signal.
  if (!(adapter instanceof ClaudeCliAdapter) || !adapter.checkIsBusy) {
    stopClaudeLiveness(key);
    return;
  }

  // S2 hard anti-hang net: the scraped TUI pane has not changed for ≥30s ⇒ the
  // agent is idle no matter what the footer busy signal says. Force-remove the
  // working frame, stop the loop, and LATCH suppression so no fresh frame is
  // created until the next prompt re-arms activity. A genuine long think keeps
  // the pane changing every second, so this never trips mid-think. Mirror the
  // proven question-takeover teardown (stop → clear pending → delete) so no
  // in-flight coalescer frame is stranded with no loop left to remove it.
  if (
    adapter.getMsSincePaneChange &&
    checkShouldForceIdleRemoval({
      msSincePaneChange: adapter.getMsSincePaneChange(key),
      idlePaneThresholdMs: claudeIdlePaneMs,
    })
  ) {
    state.statusIdleSuppressed = true;
    stopClaudeLiveness(key);
    getStatusCoalesceState(key).pendingText = null;
    void deleteStatusMessage(key).catch(() => {});
    return;
  }

  const now = Date.now();
  const isBusy = adapter.checkIsBusy(key);
  // S2: once Claude actually goes busy the busy-onset grace has served its
  // purpose — normal busy ticking owns the frame from here. Clearing it lets the
  // loop stop cleanly when the turn ends instead of lingering for the full grace.
  if (isBusy) state.busyOnsetArmedUntil = 0;
  const withinArmingGrace = !isBusy && state.busyOnsetArmedUntil > now;
  const idleTransition = state.wasBusy && !isBusy;
  state.wasBusy = isBusy;

  const action = getClaudeLivenessAction({
    isBusy,
    hasStatusFrame: state.statusMessageId !== null,
    isOutputStreaming: checkIsOutputStreaming(key),
    idleTransition,
    isSuppressed: state.statusIdleSuppressed,
  });

  switch (action) {
    case 'create':
    case 'tick': {
      // Decouple the SEND cadence from the 1s idle-CHECK cadence: re-render the
      // working frame at most every `claudeWorkingStatusRefreshMs` so the live
      // `m:ss` elapsed advances visibly without a per-second editMessageText
      // flood. A `create` (no frame yet) always sends so the frame appears
      // immediately. The push rides the SAME coalescer scraped ticks use
      // (429-aware, dedups identical text) — no second send path. S3: under a
      // live 429 cooldown the throttle stretches to the remaining cooldown so the
      // frame stops adding edits to an already-throttling chat (it was ~half the
      // 429-storm traffic).
      if (
        checkShouldSendLivenessFrame({
          isCreate: action === 'create',
          msSinceLastSent: now - state.lastLivenessSentAt,
          refreshMs: claudeWorkingStatusRefreshMs,
          remainingCooldownMs: getRateLimitRemainingMs(key.chatId),
        })
      ) {
        state.livenessGlyphIndex = (state.livenessGlyphIndex + 1) % CLAUDE_LIVENESS_GLYPHS.length;
        state.lastLivenessSentAt = now;
        void handleAgentStatus(key, getClaudeLivenessFrameText(state, now));
      }
      break;
    }
    case 'delete':
      void deleteStatusMessage(key).catch(() => {});
      break;
    case 'noop':
      break;
  }

  // Stop only when the session is truly idle, no frame is tracked, AND the status
  // coalescer is fully drained. A coalescer send sets `statusMessageId` only after
  // its network await, so stopping while one is in flight (or queued / deferred
  // behind a 429) would strand the just-sent frame with no loop to delete it on
  // idle — the orphan that lingers until the next message (live 2026-06-29: a hung
  // "☁️ thinking …" whose final frame landed exactly as the agent went idle).
  // While busy, a frame lingers (mid-delete), or a send is pending, keep ticking
  // so the next tick refreshes / removes it. Never leave a frame stuck post-idle.
  const coalescer = getStatusCoalesceState(key);
  const statusSendPending =
    coalescer.inFlight || coalescer.pendingText !== null || coalescer.deferRetryTimer !== null;
  if (
    getClaudeLivenessShouldStop({
      isBusy,
      hasStatusFrame: state.statusMessageId !== null,
      statusSendPending,
      withinArmingGrace,
    })
  ) {
    stopClaudeLiveness(key);
  } else {
    armClaudeLivenessTimer(key, state);
  }
}

/**
 * @description (Re)arm the single per-thread liveness timer. Idempotent on the
 * timer handle: clears any existing one first so two callers can't stack timers.
 */
function armClaudeLivenessTimer(key: ThreadKey, state: ThreadMessageState): void {
  if (state.livenessTimer) clearTimeout(state.livenessTimer);
  state.livenessTimer = setTimeout(() => {
    state.livenessTimer = null;
    runClaudeLivenessTick(key);
  }, CLAUDE_LIVENESS_TICK_MS);
  // Don't keep the event loop alive just for a spinner.
  state.livenessTimer.unref?.();
}

/**
 * @description Start the liveness loop for a Claude thread. Called on every
 * proof of activity (a scraped `status`, or an `output` chunk that may be
 * followed by more work). Idempotent: if a timer is already armed the running
 * loop owns the rest, so this returns without touching its edge-tracking
 * (`wasBusy`) — clobbering it here could mask a busy→idle edge the tick is about
 * to act on. Seeds `wasBusy = true` only when arming a FRESH timer: the caller
 * just observed activity, so the next tick should treat an idle reading as a
 * genuine busy→idle transition. The first tick runs on the NEXT cadence, not
 * immediately — the triggering event already painted the frame.
 *
 * Arming a FRESH timer is a new busy turn, so it (re)bases the working-status
 * elapsed (`workingSince`) and clears the S2 idle-suppress latch — genuine new
 * activity re-enables the working frame after a pane-static force-removal.
 *
 * `reason` (S2) distinguishes the two arm triggers:
 *  - `'activity'` (default; scrape `output`/`status`) — busy work was just
 *    observed, so seed `wasBusy = true` (the next idle reading is a real
 *    busy→idle edge) and no grace is needed.
 *  - `'busyOnset'` (a prompt was just forwarded) — Claude may not have flipped
 *    busy yet, so seed `wasBusy = false` and open a {@link claudeBusyOnsetGraceMs}
 *    arming grace so the first idle tick does not self-stop the loop before the
 *    think starts.
 */
type ClaudeLivenessArmReason = 'activity' | 'busyOnset';

function startClaudeLiveness(key: ThreadKey, reason: ClaudeLivenessArmReason = 'activity'): void {
  const adapter = getThreadAdapter(key);
  if (!(adapter instanceof ClaudeCliAdapter) || !adapter.checkIsBusy) return;
  const state = getThreadMessageState(key);
  if (state.livenessTimer) return;
  if (reason === 'busyOnset') {
    state.wasBusy = false;
    state.busyOnsetArmedUntil = Date.now() + claudeBusyOnsetGraceMs;
  } else {
    state.wasBusy = true;
    state.busyOnsetArmedUntil = 0;
  }
  state.workingSince = Date.now();
  state.statusIdleSuppressed = false;
  armClaudeLivenessTimer(key, state);
}

/**
 * @description Stop and clear the thread's liveness timer (no leaked timers).
 * Called on every hard lifecycle teardown so the loop can't recreate a frame
 * after the session is gone. Leaves `statusMessageId` alone — the caller's own
 * `deleteStatusMessage` owns removing the visible frame.
 */
function stopClaudeLiveness(key: ThreadKey): void {
  const state = threadMessageStates.get(keyToString(key));
  if (!state?.livenessTimer) return;
  clearTimeout(state.livenessTimer);
  state.livenessTimer = null;
  state.wasBusy = false;
  // The turn is over — clear the elapsed base so the next turn restarts at 0:00,
  // and drop any busy-onset arming grace so a teardown can't leave it armed.
  state.workingSince = null;
  state.busyOnsetArmedUntil = 0;
}

// ── Sub-agent status (OpenCode minimal/short) — dedicated self-updating message ─
//
// SINGLE OWNER of the dedicated `subagentStatusMessageId`, kept separate from
// `statusMessageId` so the "🤖 sub-agent: <title> · m:ss" working indicator is
// ONE message edited in place — not the flood the shared transient status
// produced (a NEW `sendMessage` per child-text burst). The adapter emits a
// mode-AGNOSTIC `subagentStatus` event; the bot resolves the lifecycle via the
// pure `getSubagentStatusAction` and ticks an elapsed counter every
// `subagentTickMs`. Only minimal/short produce this event (`/subagent full`
// streams the child transcript as its own chunks — the stream IS the indicator).

/**
 * @description Edit the open sub-agent status message with the current elapsed
 * time. Best-effort: a failed edit just retries on the next tick. No-op (and
 * stops the timer) once the message is gone, so a racing teardown can't leave a
 * self-re-arming timer running.
 */
async function refreshSubagentStatus(key: ThreadKey): Promise<void> {
  const state = getThreadMessageState(key);
  if (state.subagentStatusMessageId === null) return;
  const elapsedMs = Date.now() - (state.subagentStartedAt ?? Date.now());
  const text = buildSubagentElapsedText(state.subagentTitle, elapsedMs);
  await editThreadMessage(
    key,
    state.subagentStatusMessageId,
    renderAgentHtml(text),
    { parse_mode: 'HTML' },
  );
}

/**
 * @description Arm (re-arm) the unref'd self-re-arming tick timer that re-edits
 * the sub-agent status message with the updated elapsed time. Mirrors
 * {@link armClaudeLivenessTimer}: clears any existing timer first (single armed
 * timer), unref'd so it never holds the event loop open, and self-stops once
 * the message is gone (the next tick sees a null id and returns).
 */
function armSubagentTimer(key: ThreadKey, state: ThreadMessageState): void {
  if (state.subagentTimer) clearTimeout(state.subagentTimer);
  state.subagentTimer = setTimeout(() => {
    state.subagentTimer = null;
    if (state.subagentStatusMessageId === null) return;
    void refreshSubagentStatus(key).finally(() => {
      // Re-arm only while the message is still open — a close that landed during
      // the edit nulls the id, so we stop instead of resurrecting the loop.
      if (state.subagentStatusMessageId !== null) armSubagentTimer(key, state);
    });
  }, subagentTickMs);
  state.subagentTimer.unref?.();
}

/**
 * @description Tear down a thread's sub-agent status message + timer. Called on
 * the delegation's end (`active:false`) and on every hard teardown that already
 * clears thinking/status (close, stop, error, question takeover) so the
 * "working" indicator never lingers after the work it described is gone.
 * Best-effort delete; the in-memory fields are nulled synchronously so a racing
 * emit can't resurrect a stale frame.
 */
function clearSubagentStatus(key: ThreadKey): void {
  const state = getThreadMessageState(key);
  if (state.subagentTimer) {
    clearTimeout(state.subagentTimer);
    state.subagentTimer = null;
  }
  const id = state.subagentStatusMessageId;
  setSubagentFrameId(key, null);
  state.subagentStartedAt = null;
  state.subagentTitle = null;
  if (id !== null) deleteThreadMessage(key, id).catch(() => {});
}

/**
 * @description Adapter `subagentStatus` event entry point (OpenCode
 * minimal/short). Drives the dedicated sub-agent status message via the pure
 * {@link getSubagentStatusAction}:
 *
 * - `open`    — record start time + title, create the message, arm the tick timer.
 * - `refresh` — update the sticky title (when the event carried one), re-edit
 *   with the current elapsed time, keep the timer armed.
 * - `close`   — {@link clearSubagentStatus} (stop timer + delete message).
 * - `noop`    — a defensive `active:false` with nothing open; do nothing.
 *
 * Wrapped so async sends never throw back into the EventEmitter (mirrors
 * `handleAgentQuestion`).
 */
function handleSubagentStatus(key: ThreadKey, payload: SubagentStatusEvent): void {
  const state = getThreadMessageState(key);
  // `subagentStartedAt` is set synchronously when an `open` begins (before its
  // `await`), so a second `active:true` arriving while the first create is still
  // in flight resolves to `refresh` (a harmless no-op until the id lands) rather
  // than opening a SECOND message that orphans the first.
  const hasMessage = state.subagentStatusMessageId !== null || state.subagentStartedAt !== null;
  const action = getSubagentStatusAction({ hasMessage, eventActive: payload.active });

  if (action === 'noop') return;
  if (action === 'close') {
    clearSubagentStatus(key);
    return;
  }

  (async () => {
    try {
      if (action === 'open') {
        state.subagentStartedAt = Date.now();
        state.subagentTitle = payload.title;
        const text = buildSubagentElapsedText(state.subagentTitle, 0);
        const id = await replyToThread(key, renderAgentHtml(text), { parse_mode: 'HTML' });
        if (id === null) return;
        // A close (teardown) may have landed during the create — don't leave the
        // just-created message orphaned and untracked; remove it.
        if (state.subagentStartedAt === null) {
          deleteThreadMessage(key, id).catch(() => {});
          return;
        }
        setSubagentFrameId(key, id);
        armSubagentTimer(key, state);
        return;
      }
      // refresh: keep the sticky title (overwrite only with a non-null one).
      if (payload.title !== null) state.subagentTitle = payload.title;
      await refreshSubagentStatus(key);
      if (state.subagentStatusMessageId !== null && state.subagentTimer === null) {
        armSubagentTimer(key, state);
      }
    } catch (err) {
      console.error('[handleSubagentStatus] Failed:', err);
    }
  })();
}

function handleAgentQuestion(key: ThreadKey, questionData: OpenCodePendingQuestion): void {
  console.log(`[Bot] question ${keyToString(key)} (${questionData.requestId}): ${questionData.questions.length}`);
  // Idempotent across restart: this handler ALSO fires from the adapter's
  // `restoreOpenQuestion` on reattach (the server still has the question open).
  // If the SAME question (matched by requestId) is already persisted,
  // `restorePendingQuestions` re-arms its original buttons + any local
  // multi-question progress, and `restoreOpenQuestion` already re-set the
  // adapter's own `session.pendingQuestion` BEFORE emitting — so re-posting
  // here would only duplicate the question message in the topic. Skip it. A
  // fresh LIVE question isn't persisted until this handler runs, so this never
  // skips a genuinely new one.
  const persistedQuestion = state.getPendingQuestions()[keyToString(key)];
  if (persistedQuestion && persistedQuestion.data.requestId === questionData.requestId) {
    return;
  }
  // A pending status frame is now stale — the question UI replaces it. Stop the
  // liveness loop first so it can't recreate a frame under the question prompt
  // (Claude-only; a no-op for OpenCode threads, which never arm it).
  stopClaudeLiveness(key);
  getStatusCoalesceState(key).pendingText = null;
  deleteStatusMessage(key).catch(() => {});
  // The question UI takes over — remove any live thinking frame so it doesn't
  // sit above the prompt (it would otherwise persist past the answer).
  clearThinkingMessage(key);
  // A question UI supersedes the sub-agent "working" line — remove it too.
  clearSubagentStatus(key);
  // The question UI takes over mid-stream — FINALIZE any in-flight content (DM:
  // the live draft so its already-accumulated text lands as a permanent message
  // above the prompt, not dropped; the finalize IS the persistence — no parallel
  // queueOutput in DM. Group: drain any coalesced-but-unsent output so the answer
  // lands above the prompt rather than behind it, S2). Fire-and-forget; a
  // fully-delivered turn is a no-op for both.
  void getOutputTransport().finalizeInFlight(key);
  // The question UI replaces the "working" cue — stop the typing loader.
  stopTypingLoader(key);

  // Audit S13 / #31: register the pending question BEFORE the async
  // network round-trip. A user hammering an inline button right after
  // the question arrives used to find an empty `pendingQuestions` entry
  // (the network reply was still in flight) and get a confusing
  // "no pending question" answerCbQuery. The messageId is patched in
  // after `replyToThread` resolves.
  //
  // S2: post ONLY the first question. The rest are shown one at a time as the
  // user answers, with answers collected locally (`answers`) and replied to the
  // agent as a full matrix once every question is answered. Posting all at once
  // was the bug: answering the first reply-closed the request with empty
  // answers for the rest.
  setPendingQuestion(key, {
    data: questionData,
    messageId: null,
    answers: new Array(questionData.questions.length).fill(null),
    currentIndex: 0,
  });

  void runQuestionLifecycleOp(key, () => postPendingQuestionAt(key));
}

/**
 * @description Render + send ONE OpenCode question (the one at the pending
 * state's `currentIndex`) as the newest thread message, then patch the
 * resulting message id back onto the pending state (in memory + persisted).
 *
 * This is the SINGLE owner of the pending `messageId` for an on-screen
 * transition — the initial post (S1), the "advance to the next question" step
 * (S2), and the "re-post at the bottom" step (S3) all route through here so
 * they never double-set or orphan the id.
 *
 * S1: option descriptions are rendered under each numbered label in the body
 * via {@link buildQuestionBodyLines}; the inline buttons stay label-only
 * (40-char cap). Callback ids stay `qa_<qIdx>_<optIdx>` against the absolute
 * question index so a restored old button still resolves.
 */
async function postPendingQuestionAt(key: ThreadKey): Promise<void> {
  const kStr = keyToString(key);
  const pending = pendingQuestions.get(kStr);
  if (!pending) return;

  const qIdx = pending.currentIndex;
  const question = pending.data.questions[qIdx];
  if (!question) return;

  // Single owner of `messageId` per transition: this post is about to put the
  // question at the bottom, so any armed re-post is moot — and a re-post that
  // fired DURING our send would read the previous question's `messageId` and
  // delete the wrong message (live race 2026-06-10: the answered-Q1 "✅"
  // confirmation vanished and Q2 was posted twice). Cancel the timer and hold
  // the in-flight flag until the new id is stored.
  const repostState = getQuestionRepostState(key);
  if (repostState.repostTimer) {
    clearTimeout(repostState.repostTimer);
    repostState.repostTimer = null;
  }
  repostState.isPostInFlight = true;

  const buttons = question.options.map((opt, optIdx) => {
    const label = opt.label.length > 40 ? opt.label.slice(0, 37) + '...' : opt.label;
    return [Markup.button.callback(label, `qa_${qIdx}_${optIdx}`)];
  });
  const keyboard = buttons.length > 0 ? Markup.inlineKeyboard(buttons) : undefined;

  try {
    const extra: Record<string, unknown> = { parse_mode: 'Markdown' };
    if (keyboard) Object.assign(extra, keyboard);

    let messageId = await replyToThread(
      key,
      buildQuestionBodyLines(question, escapeMarkdown).join('\n'),
      extra,
    );
    if (!messageId) {
      // Markdown rejected — retry plain.
      const plainExtra: Record<string, unknown> = {};
      if (keyboard) Object.assign(plainExtra, keyboard);
      messageId = await replyToThread(
        key,
        buildQuestionBodyLinesPlain(question).join('\n'),
        plainExtra,
      );
    }

    if (messageId !== null) {
      // Patch the messageId on the existing entry (it may already have been
      // cleared/advanced by an answer callback firing in between). Route
      // through `setPendingQuestion` so the persisted copy gets the live
      // button message id too — that id is what lets the OLD buttons resolve
      // after a restart, and what S3 deletes when re-posting to the bottom.
      const existing = pendingQuestions.get(kStr);
      if (existing && existing.data === pending.data && existing.currentIndex === qIdx) {
        existing.messageId = messageId;
        setPendingQuestion(key, existing);
        markQuestionMessageSent(key, messageId);
        // Pin the question so the muted topic fires a notification (S2). The
        // "unpin previous if different" step inside also retires the prior pin on
        // a Q1→Q2 advance (Q1 stays as a "✅" message but loses its pin).
        void pinThreadQuestion(key, messageId);
      } else {
        // The question advanced / was answered while our send sat in the
        // queue (a fast digit reply can beat the post — seen live 2026-06-10:
        // a stale unanswered-looking "❓" landed and lingered). The message we
        // just sent describes a question that no longer exists — remove it.
        void deleteThreadMessage(key, messageId);
      }
    }
  } catch (err) {
    console.error('[postPendingQuestionAt] Failed:', err);
  } finally {
    repostState.isPostInFlight = false;
  }
}

/**
 * @description Claude `questionGone` event — the scraped TUI selector left the
 * screen (answered / dismissed), so remove its pin. This is Claude's unpin path
 * for the normal answer case: Claude has no `pendingQuestions` entry, so it can't
 * lean on `clearPendingQuestion` (which OpenCode uses). The hard-teardown paths
 * (stop / quit / unbind / closed / error) still route through
 * `clearPendingQuestion` and unpin there for BOTH backends.
 */
function handleQuestionGone(key: ThreadKey): void {
  void unpinThreadQuestion(key);
}

function handleAgentClosed(key: ThreadKey): void {
  // Session is gone — drop any not-yet-sent output AND status frame so they
  // don't surface after the "session ended" notice (the trailing-output bug:
  // a 429 backlog could let queued deltas land seconds after the close).
  clearThreadQueues(key);
  // Session gone — stop the liveness loop so it can't recreate a frame after
  // the close (it would otherwise outlive the session via its self-re-arm).
  stopClaudeLiveness(key);
  deleteStatusMessage(key).catch(() => {});
  // A closed session won't finish reasoning — remove a live thinking frame so it
  // doesn't linger above the "session ended" notice.
  clearThinkingMessage(key);
  // A closed session has no running delegation — remove the sub-agent status.
  clearSubagentStatus(key);
  clearPendingQuestion(key);
  // A closed session has nothing to resume — drop any armed retry silently.
  cancelApiRetry(key);
  clearAuthNotice(key); // session closed → retire any pinned logged-out notice
  const adapter = getThreadAdapter(key);
  replyToThread(key, t('agent.session_ended', { label: adapter.label })).catch(() => {});
  // Banner now reads `idle`; closed sessions may also persist with the
  // wrong model/agent label otherwise.
  updatePinnedStatus(key).catch(() => {});
}

function handleAgentError(key: ThreadKey, error: Error): void {
  console.error(`[Bot] adapter error ${keyToString(key)}:`, error.message);
  stopClaudeLiveness(key);
  getStatusCoalesceState(key).pendingText = null;
  deleteStatusMessage(key).catch(() => {});
  clearThinkingMessage(key);
  clearSubagentStatus(key);
  clearPendingQuestion(key);
  replyToThread(key, `Error: ${error.message}`).catch(() => {});
}

/**
 * @description `started` from the adapter — flip the pinned banner to
 * `running` and refresh its model row. Fired by both `claudeCliAdapter`
 * and `openCodeAdapter` (`emit('started', key)`).
 */
function handleAgentStarted(key: ThreadKey): void {
  updatePinnedStatus(key).catch(() => {});
}

/**
 * @description `stopped` from the adapter — flip the banner back to `idle`.
 * Skipped via the in-flight unbind guard inside `updatePinnedStatus` so the
 * stop-then-unbind sequence doesn't re-pin a stale banner.
 */
function handleAgentStopped(key: ThreadKey): void {
  // Single convergence point for every `stopSession`-driven stop path —
  // `/quit` (OpenCode/terminal), `/quit-all`, `/new`, `/unbind`, and adapter
  // switch all emit `stopped`. Drop the thread's queued-but-unsent output here so
  // nothing coalesced before the stop posts after the "stopped" confirmation.
  clearThreadQueues(key);
  // Stop the liveness loop and remove its frame — a stopped session is idle, so
  // a lingering "working…" indicator would be a stuck spinner. Stopping the
  // timer first prevents it from recreating the frame right after this delete.
  stopClaudeLiveness(key);
  deleteStatusMessage(key).catch(() => {});
  // A stopped session is idle — a lingering "thinking …" frame would be a stuck
  // indicator, same rationale as the status frame above.
  clearThinkingMessage(key);
  // A stopped session has no running delegation — remove the sub-agent status.
  clearSubagentStatus(key);
  // F1: this is the convergence point for `/quit`, `/quit-all`, `/new`, and
  // adapter switch — none of which fire the adapter's `questionGone` (Claude's
  // pane is killed; OpenCode emits no resolve), so a pinned question would leak
  // forever. Clear it here (chains `unpinThreadQuestion`), matching
  // `handleAgentClosed` / `handleAgentError`.
  clearPendingQuestion(key);
  // Session ended — a future session starts with empty context, so forget the
  // last-injected thread-context preamble; the next prompt re-carries it.
  clearThreadContextMarker(key);
  // A stopped session has nothing to resume — drop any armed retry silently.
  cancelApiRetry(key);
  clearAuthNotice(key); // session stopped → retire any pinned logged-out notice
  updatePinnedStatus(key).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Startup orchestration — state init, re-attach, setMyCommands, launch
// ═══════════════════════════════════════════════════════════════════════════════

const COMMANDS_MENU = [
  { command: 'help', description: '❓ Context-aware help' },
  { command: 'doctor', description: '🔍 Self-diagnostics' },
  { command: 'bind', description: '📁 Bind thread to a subfolder' },
  { command: 'ls', description: '📂 List WORK_ROOT subfolders' },
  { command: 'list', description: '🧵 List all bound threads' },
  { command: 'mcp', description: '🔌 List active MCP servers' },
  { command: 'claude', description: '▶️ Start Claude Code' },
  { command: 'opencode', description: '▶️ Start OpenCode' },
  { command: 'connect', description: '🔑 Connect an OpenCode provider API key' },
  { command: 'terminal', description: '🖥 Open a raw shell in the bound folder' },
  { command: 'new', description: '🆕 Restart session (alias /clear_session)' },
  { command: 'clear_session', description: '🆕 Restart session (alias /new)' },
  { command: 'model', description: '🧠 Switch model' },
  { command: 'effort', description: '⚙️ Reasoning effort' },
  { command: 'verbosity', description: '🔊 Output verbosity (thinking+tools+sub-agents)' },
  { command: 'thinking', description: '☁️ Thinking verbosity (OpenCode)' },
  { command: 'tool_results', description: '🔧 Tool-results verbosity' },
  { command: 'subagent', description: '🤖 Sub-agent verbosity' },
  { command: 'sessions', description: '📋 Previous sessions (alias /resume)' },
  { command: 'resume', description: '📋 Resume a previous session' },
  { command: 'rename_session', description: '✏️ Rename the current session (OpenCode)' },
  { command: 'quit', description: '🚪 Quit agent (alias /q)' },
  { command: 'quitall', description: '🚪 Quit ALL agents (General-only)' },
  { command: 'compact', description: '🧹 Compact agent context' },
  { command: 'schedule', description: '⏰ Schedule a prompt (agent does the work)' },
  { command: 'status', description: '📊 Show status' },
  { command: 'output', description: '📜 Last 500 lines' },
  { command: 'whoami', description: '🪪 Show debug ids' },
  { command: 'pair', description: '🔗 Bind this group to the bot' },
  { command: 'version', description: 'ℹ️ Versions of bot + CLI tools' },
  { command: 'enter', description: '↵ Press Enter' },
  { command: 'up', description: '⬆️ Arrow Up' },
  { command: 'down', description: '⬇️ Arrow Down' },
  { command: 'tab', description: '⇥ Tab' },
  { command: 'esc', description: '⎋ Escape (interrupt / dismiss)' },
  { command: 'y', description: '✅ Send "y"' },
  { command: 'n', description: '❌ Send "n"' },
  { command: 'c', description: '🛑 Ctrl+C' },
  { command: 'clear_messages', description: '🗑 Delete this thread\'s messages' },
];

/**
 * @description Post the silent-reattach recap for one thread after a successful
 * re-adopt: how many AGENT messages were produced while the bot was down (vs the
 * persisted watermark) plus the last few turns. The anti-spam gate
 * ({@link checkShouldPostReattachRecap}) lives in the recap module: post when
 * `missedCount > 0` (real missed output, ANY boot mode) OR — only on a COLD start
 * (`isColdStart`) — the watermark-unknown fallback. The fallback is cold-start
 * gated precisely so a watermark-less session (first run after ship, pruned
 * transcript) does NOT re-spam every active topic on every hot rebuild.
 *
 * Adapters without `getReattachRecap` (Terminal) are skipped. Best-effort: a
 * read/format failure logs and posts nothing — it never blocks the reattach
 * scan or crashes boot.
 *
 * `watermark` is the PRE-adopt snapshot read by the caller BEFORE `adopt/resume`
 * (S1-wiring): the concurrent live-advance (Claude's idle-poll tracker / OpenCode's
 * `session.idle`) starts running the instant the session polls, so re-reading the
 * watermark here could see it already moved to the tail and silently suppress a
 * genuine recap. Taking the snapshot before adopt freezes the recap baseline.
 *
 * Idempotency: after the recap is computed the persisted watermark is ALWAYS
 * advanced to the session's current head (`recap.headWatermark`) — whether or not
 * a recap posted, and even on `missedCount === 0` — so the same gap can never
 * re-report on the next reattach. Skipped only when the head is unknown (the
 * record read failed) → retry on the next reattach. The collaborators are
 * injectable (`deps`) so the orchestration is unit-testable; production uses the
 * real {@link replyToThread} / {@link StateStore.setSeenWatermark}.
 */
interface PostReattachRecapDeps {
  reply: (key: ThreadKey, text: string) => Promise<unknown>;
  advanceWatermark: (key: ThreadKey, watermark: SeenWatermark) => void;
}

const defaultPostReattachRecapDeps: PostReattachRecapDeps = {
  reply: (key, text) => replyToThread(key, text),
  advanceWatermark: (key, watermark) => {
    void state.setSeenWatermark(key, watermark);
  },
};

export async function postReattachRecap(
  key: ThreadKey,
  adapter: Pick<AgentAdapter, 'getReattachRecap'>,
  workDir: string,
  sessionId: string,
  watermark: SeenWatermark | null,
  isColdStart: boolean,
  deps: PostReattachRecapDeps = defaultPostReattachRecapDeps,
): Promise<void> {
  if (!adapter.getReattachRecap) return;
  try {
    const recap = await adapter.getReattachRecap(key, workDir, sessionId, watermark);
    const shouldPost = checkShouldPostReattachRecap({
      missedCount: recap.missedCount,
      isWatermarkKnown: recap.isWatermarkKnown,
      hasTurns: recap.turns.length > 0,
      isColdStart,
    });
    if (shouldPost) {
      const text = formatReattachRecap(recap);
      if (text) await deps.reply(key, text);
    }
    if (recap.headWatermark) {
      deps.advanceWatermark(key, recap.headWatermark);
    }
  } catch (e) {
    console.warn(`[reattach] recap post failed for ${keyToString(key)}:`, e instanceof Error ? e.message : e);
  }
}

/**
 * @description Re-adopt tmux sessions and OpenCode SSE streams that
 * outlived the bot process.
 *
 * Plan §10.2 / §13.19 (E1). Runs **before** `bot.launch()` so the first
 * user message in any thread already finds a live adapter session, not
 * a stale "agent not running" reply.
 *
 * A successful re-adopt is SILENT unless the agent kept WORKING during the
 * downtime: {@link postReattachRecap} then posts ONE bounded recap of the
 * missed output (gated on `missedCount`), so nothing produced while the bot was
 * down is lost (the old "session is still alive" notice it replaced only added
 * noise). `opts.quietReattach` governs ONLY the per-topic ERROR notice this
 * scan can still post — the workDir-refused case (the bound folder
 * vanished, so the session can't be re-adopted): held on a hot reload
 * (nodemon swap, sub-threshold downtime — the user didn't notice the
 * blink), shown on a real cold start. The classifier lives in
 * `bootClassifier.ts`; this function only consumes the flag.
 */
async function reattachExistingSessions(
  opts: { quietReattach: boolean } = { quietReattach: false },
): Promise<void> {
  // 0. Rehydrate per-thread adapter choice from state.agents into the
  //    in-memory `threadAdapterNames` map. Without this, every thread
  //    reverts to the default adapter after a restart, so `getThreadAdapter(key)`
  //    would return the wrong adapter even though the *actual* tmux /
  //    opencode session was correctly adopted below. (Review CRITICAL #3.)
  let rehydrated = 0;
  for (const { key } of state.listBindings()) {
    const agent = state.getAgent(key);
    if (!agent?.name) continue;
    try {
      setThreadAdapter(key, agent.name);
      rehydrated += 1;
    } catch (e) {
      // Unknown adapter in state (renamed / removed). Log and move on.
      console.warn(
        `[reattach] cannot rehydrate ${keyToString(key)} (agent=${agent.name}):`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  console.log(`[reattach] rehydrated adapter choice for ${rehydrated} threads`);

  // 1. Claude — tmux sessions. Always resolve the claude adapter directly,
  //    not via `getThreadAdapter(generalKey)`: General may be unbound or
  //    bound to opencode, which would silently skip the entire claude scan
  //    (review CRITICAL #1).
  const claudeAdapter = getAdapter('claude');
  if (claudeAdapter instanceof ClaudeCliAdapter) {
    try {
      const found = await claudeAdapter.listExistingTmuxSessions();
      let adopted = 0;
      let killed = 0;
      let reconciled = 0;
      for (const { key, sessionName } of found) {
        const binding = state.getBinding(key);
        if (!binding) {
          // No binding at all → genuine orphan, no thread owns it.
          await claudeAdapter.killOrphanTmuxSession(sessionName);
          killed += 1;
          continue;
        }
        // A thread whose resolved backend is json-stream must never re-adopt a
        // stale tmux-claude session — kill it and let the json-stream reattach
        // (2b) own this thread instead.
        if (getThreadAdapterName(key) === claudeJsonStreamAdapterName) {
          await claudeAdapter.killOrphanTmuxSession(sessionName);
          killed += 1;
          continue;
        }
        let agent = state.getAgent(key);
        // If state and reality disagree (agent missing, or names another
        // adapter, or claudeSessionId is gone), try to reconstruct state
        // from the live tmux argv before declaring the session an orphan.
        // The running tmux session is the source of truth — `state.json`
        // can fall out of sync if the bot crashed mid-write (the 500ms
        // debounce never flushed) or if a previous `switchThreadAdapter`
        // call left a leftover session of the other adapter alive.
        const needsReconcile = !agent || agent.name !== 'claude' || !agent.claudeSessionId;
        if (needsReconcile) {
          const recovered = await claudeAdapter.recoverSessionIdFromTmux(sessionName);
          if (recovered) {
            const patched: { name: string; model?: string; claudeSessionId: string } = {
              name: 'claude',
              claudeSessionId: recovered,
            };
            if (agent?.model !== undefined) patched.model = agent.model;
            // Drop the row first so a stale opencodeSessionId doesn't
            // ride along into the new shape (setAgent merges).
            await state.removeAgent(key);
            await state.setAgent(key, patched);
            setThreadAdapter(key, 'claude');
            agent = state.getAgent(key);
            reconciled += 1;
            console.log(`[reattach] reconciled state for ${keyToString(key)} (recovered claudeSessionId=${recovered})`);
          } else {
            await claudeAdapter.killOrphanTmuxSession(sessionName);
            killed += 1;
            continue;
          }
        }
        // After reconcile, agent is always populated with claudeSessionId.
        if (!agent?.claudeSessionId) {
          await claudeAdapter.killOrphanTmuxSession(sessionName);
          killed += 1;
          continue;
        }
        const workDirDecision = getWorkDirStartDecision(key);
        if (!workDirDecision.ok) {
          console.warn(`[reattach] claude ${keyToString(key)} refused: ${workDirDecision.message}`);
          await claudeAdapter.killOrphanTmuxSession(sessionName);
          killed += 1;
          if (!opts.quietReattach) {
            replyToThread(key, workDirDecision.message).catch(() => {});
          }
          continue;
        }
        const workDir = workDirDecision.workDir;
        // Snapshot the persisted watermark BEFORE adopt: the live-advance tracker
        // starts moving it toward EOF the instant the adopted session polls, so a
        // post-adopt read could miss a genuine recap (S1-wiring).
        const preAdoptWatermark = state.getAgent(key)?.seenWatermark ?? null;
        if (await claudeAdapter.adoptExistingTmuxSession(key, sessionName, workDir, agent.claudeSessionId)) {
          adopted += 1;
          // Fire-and-forget: the body (a Claude fs read) must not serialize the
          // reattach scan. postReattachRecap swallows its own errors; the `.catch`
          // is defensive.
          void postReattachRecap(
            key,
            claudeAdapter,
            workDir,
            agent.claudeSessionId,
            preAdoptWatermark,
            !opts.quietReattach,
          ).catch(() => {});
        }
      }
      console.log(`[reattach] tmux: adopted ${adopted}, reconciled ${reconciled}, killed ${killed} orphans (quiet=${opts.quietReattach})`);
    } catch (e) {
      console.error('[reattach] tmux scan failed:', e);
    }
  }

  // 2. OpenCode — server-side sessions; resumeSession reconnects SSE.
  //    Resolve the opencode adapter directly: state.agents[key].name === 'opencode'
  //    is the source of truth here, not the (possibly stale) default-fallback
  //    from `getThreadAdapter(key)` (review CRITICAL #2).
  const opencodeAdapter = getAdapter('opencode');
  let reopened = 0;
  for (const { key } of state.listBindings()) {
    const agent = state.getAgent(key);
    if (!agent || agent.name !== 'opencode' || !agent.opencodeSessionId) continue;
    if (opencodeAdapter.checkIsActive(key)) continue;
    try {
      const workDirDecision = getWorkDirStartDecision(key);
      if (!workDirDecision.ok) {
        console.warn(`[reattach] opencode ${keyToString(key)} refused: ${workDirDecision.message}`);
        if (!opts.quietReattach) {
          replyToThread(key, workDirDecision.message).catch(() => {});
        }
        continue;
      }
      const workDir = workDirDecision.workDir;
      // Snapshot the persisted watermark BEFORE resume: the live-advance (OpenCode's
      // `session.idle`) starts moving it once the reconnected session settles, so a
      // post-resume read could miss a genuine recap (S1-wiring).
      const preAdoptWatermark = state.getAgent(key)?.seenWatermark ?? null;
      await opencodeAdapter.resumeSession(key, workDir, agent.opencodeSessionId);
      reopened += 1;
      // Fire-and-forget: the body (an OpenCode HTTP GET) must not serialize the
      // reattach scan. postReattachRecap swallows its own errors; the `.catch`
      // is defensive.
      void postReattachRecap(
        key,
        opencodeAdapter,
        workDir,
        agent.opencodeSessionId,
        preAdoptWatermark,
        !opts.quietReattach,
      ).catch(() => {});
    } catch (e) {
      console.warn(`[reattach] opencode ${keyToString(key)} failed:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`[reattach] opencode: reopened ${reopened} sessions (quiet=${opts.quietReattach})`);

  // 2b. Claude JSON-stream — EXTERNAL tmux-hosted processes (plan
  //     2026-07-05-jsonstream-restart-isolation): like the scrape backend, the
  //     sessions outlive the bot. First ADOPT every live `cjson-*` session —
  //     reopen the FIFO writer and resume the stdout tail from the persisted
  //     line-boundary offset, so everything produced during the downtime
  //     replays through the normal pipeline (which is why an adopt posts NO
  //     recap — the replay IS the delivery). A session whose thread released
  //     its persisted id (`/quit`, `/new`) or isn't a json-stream thread is an
  //     orphan and is killed, never adopted (locked decision). Then RESUME
  //     (dead-process fallback, the pre-plan behavior) any bound json-stream
  //     thread that still has a persisted id but no live process — the only
  //     path that still re-spawns `--resume`, and the only one that recaps.
  const claudeJsonAdapter = getAdapter(claudeJsonStreamAdapterName);
  let jsonAdopted = 0;
  let jsonKilled = 0;
  let jsonReopened = 0;
  if (claudeJsonAdapter instanceof ClaudeJsonStreamAdapter) {
    try {
      const found = await claudeJsonAdapter.listExistingTmuxSessions();
      for (const { key, sessionName } of found) {
        const binding = state.getBinding(key);
        const agent = state.getAgent(key);
        if (!binding || agent?.name !== claudeJsonStreamAdapterName || !agent.claudeSessionId) {
          await claudeJsonAdapter.killOrphanTmuxSession(sessionName);
          jsonKilled += 1;
          continue;
        }
        const workDirDecision = getWorkDirStartDecision(key);
        if (!workDirDecision.ok) {
          console.warn(`[reattach] claude-json-stream ${keyToString(key)} refused: ${workDirDecision.message}`);
          await claudeJsonAdapter.killOrphanTmuxSession(sessionName);
          jsonKilled += 1;
          if (!opts.quietReattach) replyToThread(key, workDirDecision.message).catch(() => {});
          continue;
        }
        if (await claudeJsonAdapter.adoptExistingTmuxSession(
          key, sessionName, workDirDecision.workDir, agent.claudeSessionId, agent.jsonStreamTail ?? null,
        )) {
          jsonAdopted += 1;
        } else {
          // Dead/zombie — adopt cleaned it up itself; the resume loop below
          // still reopens this thread from the persisted session id.
          jsonKilled += 1;
        }
      }
    } catch (e) {
      console.error('[reattach] claude-json-stream scan failed:', e);
    }
  }
  for (const { key } of state.listBindings()) {
    const agent = state.getAgent(key);
    if (!agent || agent.name !== claudeJsonStreamAdapterName || !agent.claudeSessionId) continue;
    if (claudeJsonAdapter.checkIsActive(key)) continue; // adopted above
    try {
      const workDirDecision = getWorkDirStartDecision(key);
      if (!workDirDecision.ok) {
        console.warn(`[reattach] claude-json-stream ${keyToString(key)} refused: ${workDirDecision.message}`);
        if (!opts.quietReattach) replyToThread(key, workDirDecision.message).catch(() => {});
        continue;
      }
      const workDir = workDirDecision.workDir;
      const preAdoptWatermark = state.getAgent(key)?.seenWatermark ?? null;
      await claudeJsonAdapter.resumeSession(key, workDir, agent.claudeSessionId);
      jsonReopened += 1;
      void postReattachRecap(
        key, claudeJsonAdapter, workDir, agent.claudeSessionId, preAdoptWatermark, !opts.quietReattach,
      ).catch(() => {});
    } catch (e) {
      console.warn(`[reattach] claude-json-stream ${keyToString(key)} failed:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`[reattach] claude-json-stream: adopted ${jsonAdopted}, reopened ${jsonReopened}, killed ${jsonKilled} orphans (quiet=${opts.quietReattach})`);

  // 3. Terminal — tmux shells (`term-…`). Like the Claude scan but simpler:
  //    a terminal has no session-id to recover, so adoption keys purely on a
  //    live binding whose agent is `terminal`. The tmux name is derived from
  //    the `ThreadKey`. `adoptExistingTmuxSession` itself liveness/zombie-checks
  //    the specific session; a dead/missing one is garbage-collected, never
  //    re-spawned (an explicitly-stopped shell stays gone).
  const terminalAdapter = getAdapter('terminal');
  if (terminalAdapter instanceof TerminalAdapter) {
    try {
      const found = await terminalAdapter.listExistingTmuxSessions();
      let adopted = 0;
      let killed = 0;
      for (const { key, sessionName } of found) {
        const binding = state.getBinding(key);
        const agent = state.getAgent(key);
        // No binding, or the thread isn't a terminal thread → genuine orphan.
        if (!binding || agent?.name !== 'terminal') {
          await terminalAdapter.killOrphanTmuxSession(sessionName);
          killed += 1;
          continue;
        }
        const workDirDecision = getWorkDirStartDecision(key);
        if (!workDirDecision.ok) {
          console.warn(`[reattach] terminal ${keyToString(key)} refused: ${workDirDecision.message}`);
          await terminalAdapter.killOrphanTmuxSession(sessionName);
          killed += 1;
          if (!opts.quietReattach) {
            replyToThread(key, workDirDecision.message).catch(() => {});
          }
          continue;
        }
        if (await terminalAdapter.adoptExistingTmuxSession(key, sessionName, workDirDecision.workDir)) {
          adopted += 1;
        } else {
          // Adopt failed (zombie pane / vanished) — it killed the session itself.
          killed += 1;
        }
      }
      console.log(`[reattach] terminal: adopted ${adopted}, killed ${killed} orphans (quiet=${opts.quietReattach})`);
    } catch (e) {
      console.error('[reattach] terminal scan failed:', e);
    }
  }
}

/**
 * @description Restore persisted pending interactive questions into the
 * in-memory `pendingQuestions` map so the existing Telegram option buttons
 * work again after a restart (without this the map is lost, the agent's
 * question tool hangs forever, and the buttons go dead — the live bug this
 * fixes). MUST run AFTER {@link reattachExistingSessions} so session activity
 * is known.
 *
 * A persisted question is restored ONLY when its thread's session reattached
 * and is currently active (`adapter.checkIsActive`). Otherwise the question is
 * unreachable — the agent that asked it is gone — so it is dropped from the
 * store, preventing a stale entry from lingering across boots. The persisted
 * `messageId` is preserved, so the OLD buttons resolve correctly; the question
 * is never re-posted.
 */
function restorePendingQuestions(): void {
  let restored = 0;
  let dropped = 0;
  for (const [keyStr, value] of Object.entries(state.getPendingQuestions())) {
    let key: ThreadKey;
    try {
      key = keyFromString(keyStr);
    } catch {
      // Hand-edited / corrupt key (can't come from `keyToString`): skip it,
      // keep booting. Tolerated-and-skipped, like state.ts's own key parsers.
      continue;
    }
    const adapter = getThreadAdapter(key);
    if (adapter.checkIsActive(key)) {
      // Restore-compat (S2): an OLD persisted entry has only `{ data, messageId }`
      // — `answers`/`currentIndex` are undefined and would crash the answer
      // handlers. Migrate to the new shape and re-persist so disk catches up.
      const migrated = migratePendingQuestionState(value);
      setPendingQuestion(key, migrated);
      restored += 1;
    } else {
      clearPendingQuestion(key);
      dropped += 1;
    }
  }
  console.log(`[reattach] pending questions: restored ${restored}, dropped ${dropped}`);
}

/**
 * @description Re-arm persisted API-error retries (S6) so a pending kick —
 * especially a multi-hour usage-limit wait — survives a bot restart. MUST run
 * AFTER {@link reattachExistingSessions} (and right after
 * {@link restorePendingQuestions}) so each thread's session is already
 * adopted/resumed and the kick lands in a live session.
 *
 * For each record we re-populate `apiRetryTimers` and arm one unref'd timer at
 * `fireAt - now` (clamped to `maxTimeoutMs`). A `fireAt` already in the past
 * fires ONE catch-up after {@link apiRetryCatchUpDelayMs} — not synchronously in
 * the adopt tick, since a freshly-adopted Claude pane may still be repainting.
 * The arm notice is NOT re-posted (the user saw it before the restart); the
 * `↻ resuming` notice fires when the timer fires.
 */
function restoreApiRetries(): void {
  let restored = 0;
  for (const [keyStr, record] of Object.entries(state.getApiRetries())) {
    let key: ThreadKey;
    try {
      key = keyFromString(keyStr);
    } catch {
      // Hand-edited / corrupt key (can't come from `keyToString`): skip it,
      // keep booting. Tolerated-and-skipped, like restorePendingQuestions.
      continue;
    }
    const dueInMs = record.fireAt - Date.now();
    const delayMs = dueInMs > 0 ? Math.min(dueInMs, maxTimeoutMs) : apiRetryCatchUpDelayMs;
    const timer = setTimeout(() => {
      void fireApiRetry(key);
    }, delayMs);
    timer.unref?.();
    apiRetryTimers.set(keyStr, {
      timer,
      attempt: record.attempt,
      kind: record.kind,
      firedAt: null,
    });
    restored += 1;
  }
  console.log(`[reattach] api retries: re-armed ${restored}`);
}

/**
 * @description Injected collaborators for {@link reconcileTransientFrames}, so the
 * boot reconciliation is unit-testable without a live Telegram client or
 * StateStore (mirrors the `deps` seam {@link postReattachRecap} uses). Defaults
 * wire the real bot client + the persist choke point.
 */
export interface ReconcileTransientFramesDeps {
  /** Best-effort delete of one Telegram message (Telegraf resolves `true`). */
  deleteMessage: (chatId: number, messageId: number) => Promise<boolean>;
  /** Re-sync disk to the thread's LIVE in-memory frame ids after the stale deletes. */
  persistFrames: (key: ThreadKey) => void;
}

const defaultReconcileTransientFramesDeps: ReconcileTransientFramesDeps = {
  deleteMessage: (chatId, messageId) => bot.telegram.deleteMessage(chatId, messageId),
  persistFrames: persistTransientFrames,
};

/**
 * @description Delete transient status frames left on screen by an UNGRACEFUL
 * exit (crash / SIGKILL — the graceful shutdown sweep never ran), so a
 * "✽ working…" / thinking / sub-agent frame doesn't stick forever in a topic
 * (S2, the crash safety net behind S1). Deletes every id in the `orphaned`
 * snapshot best-effort (swallowing "message not found" / too-old). The snapshot
 * MUST be captured BEFORE reattach (see {@link startBot}): a reattached
 * session's frame setters persist the fresh in-memory state and would clobber
 * the live persisted set first. Every snapshot id is stale by definition (the
 * fresh process holds no handle to it; a still-busy reattached session repaints
 * its OWN fresh frame), so deleting is always safe. After deleting, re-persist
 * the CURRENT live frame ids per thread so disk reflects post-reattach truth
 * (the repainted frame's id, or empty) instead of the consumed stale ids. A
 * graceful exit already cleared the set in its sweep, so this is normally a
 * no-op.
 */
export function reconcileTransientFrames(
  orphaned: Record<string, number[]>,
  deps: ReconcileTransientFramesDeps = defaultReconcileTransientFramesDeps,
): number {
  let deleted = 0;
  for (const [keyStr, ids] of Object.entries(orphaned)) {
    let key: ThreadKey;
    try {
      key = keyFromString(keyStr);
    } catch {
      // Hand-edited / corrupt key (can't come from `keyToString`): skip it,
      // keep booting. Tolerated-and-skipped, like restorePendingQuestions.
      continue;
    }
    for (const id of ids) {
      void deps.deleteMessage(key.chatId, id).catch(() => {});
      deleted += 1;
    }
    // Sync disk to the LIVE in-memory frames (post-reattach): a still-busy
    // session that repainted a fresh frame keeps its new id; an idle one clears.
    deps.persistFrames(key);
  }
  if (deleted > 0) console.log(`[reattach] transient frames: deleted ${deleted} stale`);
  return deleted;
}

/**
 * @description The bot side of the agent's `send_file` MCP tool: resolve the
 * thread's bound folder, path-check each file against it, decide the send
 * plan (single method / album / error), and dispatch through `enqueueSend`
 * (per-thread FIFO + 429 retry + output trace). Returns a typed `{ ok }` the
 * MCP surface relays to the agent — every failure mode is reported, never thrown
 * past this boundary, so the agent learns when a send didn't happen.
 */
async function sendFilesToThread(
  threadKeyStr: string,
  opts: { paths: string[]; caption?: string; asFile?: boolean },
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  let key: ThreadKey;
  try {
    key = keyFromString(threadKeyStr);
  } catch {
    return { ok: false, error: `invalid threadKey "${threadKeyStr}"` };
  }

  const decision = getWorkDirStartDecision(key);
  if (!decision.ok) return { ok: false, error: decision.message };
  const { workDir } = decision;

  const items: FileSendItem[] = [];
  for (const rawPath of opts.paths) {
    const resolved = resolveSendFileWithinDir(workDir, rawPath);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    let sizeBytes: number;
    try {
      sizeBytes = fs.statSync(resolved.absPath).size;
    } catch (e) {
      return { ok: false, error: `cannot read ${rawPath}: ${(e as Error).message}` };
    }
    items.push({ absPath: resolved.absPath, sizeBytes, kind: classifyFileSendKind(resolved.absPath) });
  }

  const plan = planFileSend(items, opts.asFile ?? false);
  if (plan.kind === 'error') return { ok: false, error: plan.error };

  const caption = trimCaption(opts.caption);

  try {
    if (plan.kind === 'send') {
      const source = { source: plan.item.absPath };
      const extra = buildSendExtra(key, caption !== undefined ? { caption } : {});
      switch (plan.mode) {
        case 'photo':
          await enqueueSend(key, () => bot.telegram.sendPhoto(key.chatId, source, extra));
          break;
        case 'animation':
          await enqueueSend(key, () => bot.telegram.sendAnimation(key.chatId, source, extra));
          break;
        case 'document':
          await enqueueSend(key, () => bot.telegram.sendDocument(key.chatId, source, extra));
          break;
      }
    } else {
      // Album: caption rides the first item only; the group extra just carries
      // the thread routing (no caption field at the group level).
      const groupExtra = buildSendExtra(key, {});
      if (plan.mode === 'albumPhoto') {
        const media: InputMediaPhoto[] = plan.items.map((it, index) => ({
          type: 'photo',
          media: { source: it.absPath },
          ...(index === 0 && caption !== undefined ? { caption } : {}),
        }));
        await enqueueSend(key, () => bot.telegram.sendMediaGroup(key.chatId, media, groupExtra));
      } else {
        const media: InputMediaDocument[] = plan.items.map((it, index) => ({
          type: 'document',
          media: { source: it.absPath },
          ...(index === 0 && caption !== undefined ? { caption } : {}),
        }));
        await enqueueSend(key, () => bot.telegram.sendMediaGroup(key.chatId, media, groupExtra));
      }
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  return { ok: true, summary: `Sent ${items.length} file(s) to the topic.` };
}

/**
 * @description Construct the scheduler stack (S8): run ledger → delivery (thin
 * lambdas over the bot's existing send/session functions) → timer engine
 * (assigned to the module-level {@link schedulerEngine}) → the bot-owned MCP
 * server handle (NOT started — the caller starts it and wires the injection
 * with the actually-bound port). Lives outside `startBot` only for readability;
 * it captures the same module-level state the rest of bot.ts uses.
 */
function wireScheduler(): SchedulerMcpHandle {
  const ledger = new RunLedger();

  const delivery = createScheduleDelivery({
    announce: (threadKeyStr, text) => replyToThread(keyFromString(threadKeyStr), text),
    pin: async (threadKeyStr, messageId, isSilent) => {
      const key = keyFromString(threadKeyStr);
      await enqueueSend(
        key,
        () =>
          bot.telegram.pinChatMessage(key.chatId, messageId, {
            disable_notification: isSilent,
          }),
      );
    },
    checkBusy: (threadKeyStr) => {
      const key = keyFromString(threadKeyStr);
      return getThreadAdapter(key).checkIsBusy?.(key) ?? false;
    },
    ensureSession: async (threadKeyStr, fallbackAdapterName) => {
      const result = await ensureAgentSession(keyFromString(threadKeyStr), { fallbackAdapterName });
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
    forwardPrompt: async (threadKeyStr, text) => {
      const key = keyFromString(threadKeyStr);
      await deliverPromptOrBuffer(key, text, startupPromptBuffer.checkIsStarting(threadKeyStr));
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  /**
   * The engine's deliver callback: the S4 pipeline plus the S8 unbound-pause
   * policy — a fire that hits an unbound topic parks the job (paused +
   * disarmed + one notice) instead of failing forever on every occurrence.
   * The engine's bookkeeping sees the paused record and leaves it disarmed.
   */
  const deliver = async (job: ScheduleRecord, fireContext: FireContext): Promise<DeliveryOutcome> => {
    const outcome = await delivery(job, fireContext);
    if (outcome.status === 'failed' && outcome.error === unboundDeliveryError) {
      await state.setSchedulePaused(job.id, true, 'unbound');
      schedulerEngine?.disarmJob(job.id);
      await replyToThread(keyFromString(job.threadKey), t('schedule.pausedUnbound', { count: 1 })).catch(() => {});
    }
    return outcome;
  };

  schedulerEngine = createSchedulerEngine({
    store: state,
    ledger,
    deliver,
    now: () => Date.now(),
  });

  return createSchedulerMcpServer({
    store: state,
    armJob: (record) => schedulerEngine?.armJob(record),
    disarmJob: (jobId) => schedulerEngine?.disarmJob(jobId),
    getThreadsForDirectory: (directory) =>
      getThreadKeysForDirectory(state.listBindings(), ENV.workRoot, directory),
    getThreadAdapterName: (threadKeyStr) => {
      const key = keyFromString(threadKeyStr);
      return getThreadAdapterNameRaw(key) ?? state.getAgent(key)?.name;
    },
    sendFilesToThread,
    getSecret: () => state.getSchedulerMcpSecret(),
  });
}

export async function startBot(): Promise<void> {
  console.log('');
  console.log('=================================');
  console.log('  Telegram Code Bot (multi-thread) starting...');
  console.log('=================================');
  console.log('Access:           forum-group admins/creator (live, cached)');
  console.log(`Work root:        ${ENV.workRoot}`);
  console.log(`Default agent:    ${getDefaultAdapterName()}`);
  console.log(`Available agents: ${getAvailableAdapters().map(a => a.name).join(', ')}`);

  // 1. State store.
  state = await getStateStore();
  console.log(`Data dir:         ${path.dirname(state.stateFilePath)}`);

  // Snapshot the persisted transient status-frame ids (S2) NOW, before reattach
  // can run any frame-id setter. A reattached session's first frame lifecycle
  // call persists the FRESH (all-null) in-memory state and would otherwise
  // clobber this crash-recovery set to empty before `reconcileTransientFrames`
  // reads it. Captured into a local so the orphans survive that clobber.
  const orphanedTransientFrames = state.getTransientFrames();

  // Seed the output-trace toggle from persisted state so a `/trace` setting
  // survives a hot rebuild mid-debug (the writer state lives in outputTrace.ts).
  setTraceConfig(state.getTraceConfig());

  // 1.5. Boot classification — hot reload vs cold start. Read the gap to
  //      the last persisted heartbeat BEFORE we stamp a fresh one
  //      (otherwise the comparison would always be against ourselves and
  //      every boot would look like a hot reload). `null` means "no
  //      heartbeat ever recorded" → conservative cold-start default.
  const downtimeMs = state.getDowntimeMs();
  const bootMode = classifyBoot(downtimeMs);
  console.log(
    `Boot mode:        ${bootMode.isHotReload ? 'HOT RELOAD' : 'COLD START'} ` +
      `(downtime=${downtimeMs === null ? 'unknown' : `${downtimeMs}ms`})`,
  );
  console.log(`Chat mode:        ${getChatMode()}`);
  // In `both`, the DM surface only lights up when an OWNER_USER_ID is set;
  // otherwise the instance serves the group only. Surface that explicitly so an
  // operator who expected DM to work knows why it is silent (the default `both`).
  if (getChatMode() === 'both' && ENV.isDmSurfaceInert) {
    console.log(
      'DM surface:       INERT (no OWNER_USER_ID set — group-only; set OWNER_USER_ID to enable the owner DM)',
    );
  }

  // 1a. Adopt a previously auto-paired group id (unless env locks one).
  if (!isGroupLockedByEnv && effectiveGroupId === null) {
    effectiveGroupId = state.getPairedGroupId();
  }
  console.log(
    `Allowed group:    ${
      getAllowedGroupId() ??
        '(pairing mode — add the bot to your forum supergroup and send a message)'
    }`,
  );
  if (state.wasCorruptedOnLoad()) {
    console.warn(
      `[startup] previous state.json was corrupted; archived to ${state.getCorruptedArchivePath()}`,
    );
    // Best-effort notice into General once the bot is up — only if we
    // already know the group (skipped while still in pairing mode).
    const groupId = getAllowedGroupId();
    if (groupId !== null) {
      setImmediate(() => {
        const generalKey: ThreadKey = { chatId: groupId, threadId: GENERAL_THREAD_ID };
        replyToThread(generalKey, t('error.state.corrupted')).catch(() => {});
      });
    }
  }
  const legacyBackup = state.getLegacyMigrationPath();
  if (legacyBackup) {
    console.log(`[startup] legacy message-ids file archived to ${legacyBackup}`);
  }

  // 2. Wire adapter events.
  registerAdapterEventHandlers({
    onOutput: handleAgentOutput,
    onStatus: handleAdapterStatus,
    onQuestion: handleAgentQuestion,
    onThinking: handleAgentThinking,
    onToolResult: handleAgentToolResult,
    onSubagentStatus: handleSubagentStatus,
    onApiError: handleApiError,
    onQuestionGone: handleQuestionGone,
    onClosed: handleAgentClosed,
    onStarted: handleAgentStarted,
    onStopped: handleAgentStopped,
    onError: handleAgentError,
  });
  // Both adapters branch on the per-thread display prefs while PRODUCING output
  // (OpenCode: child SSE parts on `subagent`; Claude: scrape-chunk relay routing
  // on `toolResults` + transcript tailing on `subagent`) — the prefs they cannot
  // resolve at render time. Same late-wiring idiom as the event handlers above;
  // before this line they fall back to all-fields-`minimal`.
  registerDisplayPrefsReader((key) => state.getDisplayPrefs(key));
  // Both adapters advance the per-thread seen-watermark at TURN END through this
  // writer (OpenCode on session.idle, Claude at the ready-prompt turn end) so a
  // later restart can recover output produced while the bot was down. Same
  // late-wiring idiom; inert (no-op) until this line runs.
  registerSeenWatermarkWriter((key, watermark) => {
    void state.setSeenWatermark(key, watermark);
  });
  // The json-stream tail poller persists its line-boundary stdout offset through
  // this writer (debounced save; the shutdown flush seals it) so the next boot
  // adopts the surviving external process and replays exactly the downtime gap.
  registerJsonStreamTailWriter((key, tail) => {
    void state.setJsonStreamTail(key, tail);
  });
  // The output path is selected ONCE here from CHAT_MODE (mirrors the adapter /
  // display-prefs wiring above) instead of a per-call surface branch at each
  // output site. Group is thin (queueOutput); DM owns the draft-cursor manager;
  // `both` dispatches per key via `checkIsDmKey`.
  registerOutputTransport(
    createOutputTransport(getChatMode(), {
      queueOutput,
      sendAgentChunks,
      getThreadMessageState,
      checkSupportsDraft: checkAdapterSupportsDraftStreaming,
      checkOutputsDeltas: checkAdapterOutputsDeltas,
      checkIsGeneral,
      checkIsDmKey,
      callSendMessageDraft,
      splitMessage,
      renderAgentHtml,
      maxMessageLength: MAX_MESSAGE_LEN,
      finalizeGroupOutput,
    }),
  );

  // 3. Connect to Telegram and register commands menu before starting local
  // daemons. If getMe fails, we should not leave an orphan opencode server.
  console.log('Testing Telegram API connection...');
  try {
    const botInfo = await bot.telegram.getMe();
    console.log(`Bot info: @${botInfo.username} (${botInfo.id})`);
    await bot.telegram.setMyCommands(COMMANDS_MENU);
    console.log('Bot commands menu set');
  } catch (err) {
    console.error('Failed to connect to Telegram API:', err);
    throw err;
  }

  // 4. Pre-start OpenCode server if available so first request is fast.
  if (getAvailableAdapters().some(a => a.name === 'opencode')) {
    try {
      console.log('[boot] pre-starting OpenCode server...');
      await ensureOpenCodeServer();
    } catch (e) {
      stopOpenCodeServer();
      console.log('[boot] OpenCode pre-start failed:', e instanceof Error ? e.message : e);
    }
  }

  // 5. Re-attach sessions that survived the restart. A successful re-adopt
  //    is silent; `quietReattach` only suppresses the reattach ERROR notice
  //    (workDir vanished) during a hot reload, surfaced on a real cold start.
  await reattachExistingSessions({ quietReattach: bootMode.isHotReload });

  // 5b. Re-arm pending interactive questions that survived the restart, so the
  //     existing option buttons keep working. MUST run AFTER reattach so each
  //     thread's session-active state is known (a question is restored only for
  //     a thread whose session came back; otherwise it is unreachable, dropped).
  restorePendingQuestions();

  // 5c. Re-arm persisted API-error retries (S6) so a pending kick survives the
  //     restart. AFTER reattach (and restorePendingQuestions) so the kick lands
  //     in a live session; a past fireAt fires one delayed catch-up.
  restoreApiRetries();

  // 5d. Delete transient status frames orphaned by an UNGRACEFUL exit (S2). AFTER
  //     reattach so each leftover frame is provably stale (the session is idle /
  //     will repaint). A graceful exit already cleared the set in its sweep, so
  //     this is normally a no-op. Uses the pre-reattach snapshot (the setters
  //     clobber the live persisted set during reattach).
  reconcileTransientFrames(orphanedTransientFrames);

  // 5-scheduler. Wire the scheduler (S8): run ledger → delivery (thin lambdas
  //    over existing bot functions) → timer engine → bot-owned MCP server →
  //    boot replay. Runs AFTER reattach so a catch-up fire finds adapters
  //    registered. The MCP server is the only piece that can fail at boot (port
  //    busy); if it does, the bot still boots and the engine still runs — only
  //    the agent-facing tools stay unavailable (injection stays inert).
  const schedulerMcpHandle = wireScheduler();
  let schedulerMcpStarted = false;
  try {
    await schedulerMcpHandle.start();
    schedulerMcpStarted = true;
    const boundPort = schedulerMcpHandle.port;
    configureSchedulerMcpInjection({
      getSecret: () => state.getSchedulerMcpSecret(),
      port: boundPort,
    });
    console.log(`[scheduler] MCP server listening on 127.0.0.1:${boundPort}`);
  } catch (e) {
    // Port busy / bind failure: keep booting WITHOUT the scheduler MCP server.
    // Injection stays unconfigured (inert), so agent sessions get no scheduling
    // tools, but engine timers still fire for jobs created in previous runs.
    console.error(
      '[scheduler] MCP server failed to start; scheduling tools unavailable this run:',
      e instanceof Error ? e.message : e,
    );
  }
  // Boot catch-up replay: arm every persisted job, fire one catch-up per missed
  // run. Independent of the MCP server (delivery does not need it).
  await schedulerEngine!.rearmAll().catch((e) =>
    console.error('[scheduler] rearmAll failed:', e),
  );

  // 5a. Refresh pinned banners for every binding. Threads that have a
  //     stored `pinnedStatusMessageId` get their banner edited in place;
  //     threads that don't (older state.json from before this feature, or
  //     bindings created while `can_pin_messages` was missing) get one
  //     freshly pinned. Failures are best-effort — `updatePinnedStatus`
  //     logs them itself.
  setImmediate(() => {
    Promise.all(
      state.listBindings().map(({ key }) => updatePinnedStatus(key).catch(() => {})),
    ).catch(() => {});
  });

  // 5b. Audit S13 / #18: periodically GC in-memory per-thread maps
  //     against state.json. Topics deleted via Telegram's UI don't
  //     produce a reliable service event; without this sweep their
  //     entries in `threadMessageStates` / `outputQueues` / etc. linger
  //     until the next failed send.
  const inMemoryGcInterval = setInterval(() => {
    try {
      const live = new Set(state.listBindings().map(({ key }) => keyToString(key)));
      // General-topic key always counts as live: in-memory state for
      // /status, /ls etc. is rooted there even without a binding row.
      const groupId = getAllowedGroupId();
      if (groupId !== null) live.add(`${groupId}:${GENERAL_THREAD_ID}`);
      let removed = 0;
      for (const m of [
        threadMessageStates as Map<string, unknown>,
        outputQueues as Map<string, unknown>,
        pendingQuestions as Map<string, unknown>,
        threadModelLists as Map<string, unknown>,
        threadSessionLists as Map<string, unknown>,
      ]) {
        for (const k of m.keys()) {
          if (!live.has(k)) { m.delete(k); removed += 1; }
        }
      }
      for (const k of awaitingModelSelection) {
        if (!live.has(k)) { awaitingModelSelection.delete(k); removed += 1; }
      }
      for (const k of awaitingSessionSelection) {
        if (!live.has(k)) { awaitingSessionSelection.delete(k); removed += 1; }
      }
      // NOTE: `awaitingFolderName` is intentionally NOT swept here. It arms an
      // UNBOUND thread (folder doesn't exist yet), so its key is never in
      // `live` — sweeping would clear a user who tapped "create folder" but is
      // still typing the name. The flag self-clears on the next message or any
      // command; an abandoned attempt costs one stray Set entry.
      // Per-topic-name cache also benefits from the same sweep — entries
      // for live keys are valid until TTL; for dead keys, drop now.
      for (const k of pendingTopicNames.keys()) {
        if (!live.has(k)) { pendingTopicNames.delete(k); removed += 1; }
      }
      if (removed > 0) console.log(`[gc] removed ${removed} orphan in-memory entries`);
    } catch (e) {
      console.warn('[gc] sweep failed:', e);
    }
  }, 60_000);
  // Keep the interval handle so shutdown can clear it (so test-time
  // shutdowns don't leak timers).
  (globalThis as { __telegramCodeGcInterval?: NodeJS.Timeout }).__telegramCodeGcInterval = inMemoryGcInterval;

  // 5c. Heartbeat. Stamps `state.lastHeartbeatAt = Date.now()` every
  //     `HEARTBEAT_INTERVAL_MS`; the next boot reads the stamp to
  //     distinguish a nodemon hot-reload swap (sub-threshold gap) from
  //     the operator stopping/restarting the bot (large gap, or no stamp
  //     after a fresh state.json wipe). `touchHeartbeat()` is debounced
  //     via the existing 500ms save coalescer so this loop is cheap.
  const HEARTBEAT_INTERVAL_MS = 10_000;
  const heartbeatInterval = setInterval(() => {
    try {
      state.touchHeartbeat();
    } catch (e) {
      console.warn('[heartbeat] touchHeartbeat failed:', e);
    }
  }, HEARTBEAT_INTERVAL_MS);
  // Stamp once immediately so a very short-lived first boot still leaves
  // a marker for the next start to read.
  state.touchHeartbeat();

  // 5d. File-intake age sweep. Logrotate-style: delete intake files older
  //     than the retention window and prune now-empty thread dirs. Runs once
  //     at boot (catches files orphaned while the bot was down) and then once
  //     a day. The interval is `unref`'d so it never keeps the process alive.
  //     The same tick also prunes the observability buckets (trace + the
  //     bot-console tee) past the shared 6h retention — whole-bucket deletes,
  //     never the live bucket the writer is appending to.
  const runFileSweep = (): void => {
    const nowMs = Date.now();
    void sweepExpiredThreadFiles(resolveFilesRoot(getDataDir()), fileRetentionMs, nowMs)
      .then((result) => {
        if (result.removedFiles > 0 || result.removedDirs > 0) {
          console.log(
            `[fileSweep] removed ${result.removedFiles} expired files, ${result.removedDirs} empty dirs`,
          );
        }
      })
      .catch((e) => console.warn('[fileSweep] sweep failed:', e));
    // Orphan json-stream host dirs: a crash can leave a host dir behind for a
    // thread that no longer owns a json-stream session (the normal stop /
    // release paths delete the dir themselves; reattach's adopt/orphan-kill
    // covers live tmux sessions — this covers their dirs).
    void sweepOrphanJsonStreamDirs(resolveJsonStreamRoot(getDataDir()), (key) => {
      if (getAdapter(claudeJsonStreamAdapterName).checkIsActive(key)) return true;
      const agent = state.getAgent(key);
      return agent?.name === claudeJsonStreamAdapterName && !!agent.claudeSessionId;
    })
      .then((removedCount) => {
        if (removedCount > 0) console.log(`[fileSweep] removed ${removedCount} orphan jsonstream dirs`);
      })
      .catch((e) => console.warn('[fileSweep] jsonstream sweep failed:', e));
    // Best-effort already (pruneExpiredBuckets never throws) — the .catch is
    // belt-and-braces against an unexpected rejection from the shared helper.
    void pruneTraceBuckets(nowMs).catch((e) => console.warn('[fileSweep] trace prune failed:', e));
    void pruneExpiredBuckets(getDataDir(), consoleFileBase, consoleFileExt, logBucketRetentionMs, nowMs).catch(
      (e) => console.warn('[fileSweep] console prune failed:', e),
    );
  };
  runFileSweep();
  const fileSweepInterval = setInterval(runFileSweep, fileSweepIntervalMs);
  fileSweepInterval.unref();

  // 5e. Periodic per-chat outbound-rate summary (always-on instrumentation,
  //     plan 2026-06-24-rate-limit-429-metrics). Every ~5 min, log a
  //     `[RateLimit] rate chat=… sent/min=… peak10s=…` line for each chat with
  //     activity in the rolling minute (silent chats skipped) into bot-console.
  //     Lets us see how close normal operation runs to the per-chat ceiling
  //     WITHOUT needing a 429. Separate from the daily file sweep because the
  //     cadence differs; `unref`'d so it never keeps the process alive.
  const rateSummaryIntervalMs = 5 * 60 * 1000;
  const runRateSummary = (): void => {
    try {
      for (const summary of getActiveChatRateSummaries()) {
        console.log(formatRateSummaryLine(summary.chatId, summary.sentPerMin, summary.peak10s));
      }
    } catch (e) {
      console.warn('[RateLimit] rate summary failed:', e);
    }
  };
  const rateSummaryInterval = setInterval(runRateSummary, rateSummaryIntervalMs);
  rateSummaryInterval.unref();

  // 6. Global catch — Telegraf swallows handler errors otherwise.
  bot.catch((err, ctx) => {
    if (checkIsStaleAnswerCallbackQueryError(err)) {
      console.debug('[bot.catch] stale answerCallbackQuery ignored:', ctx.updateType);
      return;
    }
    console.error('[bot.catch] unhandled error:', err, 'update:', ctx.updateType);
  });

  // 7. Shutdown — preserve active agents for restart/reattach. Use /quit
  //    (or /quit-all) for an intentional agent stop; process signals only
  //    stop the bot itself. Ordering (bot.stop → state.flush →
  //    releaseLock → exit) is enforced by `gracefulShutdown` so the
  //    previous race against `lock.ts`'s synchronous `process.exit(0)`
  //    can't reappear. D5 (plan): we deliberately do NOT call
  //    `stopOpenCodeServer()` or `adapter.stopSession()` here — tmux and
  //    opencode survive the bot process by design and are picked back up
  //    by `reattachExistingSessions` on the next boot.
  const shutdown = (signal: string): void => {
    void gracefulShutdown({
      signal,
      bot,
      state,
      releaseLock,
      exit: (code) => process.exit(code),
      drainPendingUpdates: () => updateDispatcher.drainIdle(updateDrainTimeoutMs),
      finalizePendingOutput: () => finalizePendingOutputOnShutdown(),
      clearTransientFrames: () => sweepTransientFramesOnShutdown(),
      cleanupTimers: () => {
        clearInterval(inMemoryGcInterval);
        clearInterval(heartbeatInterval);
        clearInterval(fileSweepInterval);
        clearInterval(rateSummaryInterval);
        // Scheduler (S8): clear every armed job timer; persisted nextRunAt
        // means the next boot's rearmAll picks them back up (catch-up replay).
        schedulerEngine?.shutdown();
        if (schedulerMcpStarted) void schedulerMcpHandle.stop().catch(() => {});
      },
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // 8. Launch. `dropPendingUpdates` follows the boot classifier: on a hot
  //    reload we KEEP the buffered backlog so a message typed during the
  //    ~1s reload window still routes to its live agent; on a cold start
  //    we drop stale updates that piled up while the bot was actually
  //    down (otherwise the user gets a flood of replies to old messages).
  console.log(`Launching Telegraf bot (long polling, dropPendingUpdates=${bootMode.dropPendingUpdates})...`);
  try {
    await bot.launch({
      dropPendingUpdates: bootMode.dropPendingUpdates,
      allowedUpdates: botAllowedUpdates,
    });
    console.log('');
    console.log('Bot is running! Waiting for messages...');
    console.log('Press Ctrl+C to stop');
    console.log('');
  } catch (err) {
    console.error('Failed to launch bot:', err);
    stopOpenCodeServer();
    throw err;
  }
}
