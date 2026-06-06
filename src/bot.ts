import { Telegraf, Markup, type Context, type NarrowedContext } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Update, Message } from 'telegraf/typings/core/types/typegram';
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
  stopAllAdaptersFor as sweepAdapters,
  getKnownAdapterNames,
} from './adapters/createAdapter';
import type { ThreadKey, AgentAdapter, AgentSession, OutputEventMeta } from './types';
import { keyToString, keyFromString } from './types';
// Pure parser lives in `./agentTrigger` so it can be unit-tested without
// booting Telegraf (audit S19 / #25).
import { parseAgentTrigger as checkIsStartAgentPhrase } from './agentTrigger';
import { checkSessionPickAction } from './sessionPick';
import { ClaudeCliAdapter, checkIsSelectorControlReply } from './adapters/claudeCliAdapter';
import { OpenCodeAdapter, type OpenCodePendingQuestion } from './adapters/openCodeAdapter';
import {
  enqueueSend,
  checkIsRateLimited,
  getRateLimitRemainingMs,
  checkIsRateLimitedError,
  type SendPriority,
} from './rateLimiter';
import { scheduleRedelivery } from './redeliverDecision';
import {
  stopOpenCodeServer,
  ensureOpenCodeServer,
} from './installManager';
import { getStateStore, KeyLock, type StateStore } from './state';
import { releaseLock } from './cli/lock';
import { gracefulShutdown } from './shutdown';
import { classifyBoot } from './bootClassifier';
import { t } from './i18n';
import { validateSubdir, BindError, findAutobindSubdir, paginateBindList } from './validation';
import { validateNewFolderName, NewFolderNameError } from './folderName';
import { resolveThreadKey, resolvePairingCandidate, GENERAL_THREAD_ID } from './threadRouting';
import { AdminCache, extractAdminIds, ADMIN_CACHE_TTL_MS } from './accessControl';
import { downloadFile } from './utils/download';
import { stripCommandBotMention } from './utils';
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
import { splitMessage } from './messageSplit';
import { getOutputFlushPlan, appendPendingOutput } from './utils/outputFlushPlan';
import { checkIsStaleAnswerCallbackQueryError } from './utils/telegramError';
import {
  flushTraceBufferSyncOnExit,
  installCallApiTrace,
  setTraceConfig,
  traceAgentEmit,
  traceRecvUpdate,
} from './outputTrace';
import { clearThreadOutputQueues } from './utils/clearThreadOutputQueues';
import { getStatusFlushAction } from './utils/statusFlushDecision';
import { getBindGateDecision } from './utils/bindGateDecision';
import { getModelSetReplyDecision } from './utils/modelSetReplyDecision';
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

// ═══════════════════════════════════════════════════════════════════════════════
//  ENV parsing & fatal validation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Parse + validate boot environment. Throws (and ends the
 * process via `index.ts`) on any required mis-configuration so the bot
 * never silently runs in a half-broken state.
 *
 * Plan §10.7 lists the obligatory variables; §13.4 / §13.12 spell out
 * the breaking renames (`WORK_DIR` → `WORK_ROOT`, new `ALLOWED_GROUP_ID`).
 */
function parseEnv() {
  const errors: string[] = [];

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) errors.push('TELEGRAM_BOT_TOKEN is required');

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

  // WORK_DIR deprecation (plan §13.12, D20).
  if (process.env.WORK_DIR && !process.env.WORK_ROOT) {
    errors.push(
      'WORK_DIR is deprecated in 2.0; set WORK_ROOT to the parent folder ' +
        'containing your projects (e.g., WORK_ROOT=/home/user/src). ' +
        'Each forum thread will bind to a subdirectory under WORK_ROOT.',
    );
  }

  const workRoot = process.env.WORK_ROOT;
  if (!workRoot) {
    errors.push('WORK_ROOT is required (parent dir of your project subfolders)');
  } else {
    try {
      if (!fs.statSync(workRoot).isDirectory()) {
        errors.push(`WORK_ROOT="${workRoot}" is not a directory`);
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? 'unknown';
      errors.push(`WORK_ROOT="${workRoot}" is not accessible (${code})`);
    }
  }

  if (errors.length > 0) {
    for (const err of errors) console.error(`[startup] ${err}`);
    process.exit(1);
  }

  return {
    botToken: botToken!,
    allowedGroupId,
    workRoot: workRoot!,
    defaultAgent: process.env.DEFAULT_AGENT || 'claude',
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

const telegramAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  family: 4,
});
const bot = new Telegraf(ENV.botToken, { telegram: { agent: telegramAgent } });

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
//  hour (lazy refresh on the first access after expiry); a demoted/left user
//  drops out on the next refresh and is silently ignored thereafter. There is
//  no static allow-list env and no /grant command.
// ═══════════════════════════════════════════════════════════════════════════════

const adminCache = new AdminCache({
  fetchAdmins: () => {
    const groupId = getAllowedGroupId();
    return groupId === null ? Promise.resolve([]) : bot.telegram.getChatAdministrators(groupId);
  },
  ttlMs: ADMIN_CACHE_TTL_MS,
});

/** True iff `userId` is currently a creator/admin of the served group (cached). */
async function checkIsAllowedUser(userId: number): Promise<boolean> {
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
bot.use(async (ctx, next) => {
  const message = ctx.message;
  const messageText = message && 'text' in message ? message.text : undefined;
  const callbackData =
    ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
  traceRecvUpdate({
    updateType: ctx.updateType,
    updateId: ctx.update.update_id,
    fromId: ctx.from?.id,
    chatId: ctx.chat?.id,
    threadId: message?.message_thread_id,
    preview: messageText ?? callbackData,
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

/** Debounce window for output batching. Telegram tolerates ~1 msg/sec/chat. */
const OUTPUT_DEBOUNCE_MS = 1000;

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
  /** Loader (⏳) message id — deleted when the first real output arrives. */
  loaderMessageId: number | null;
  /**
   * True once output superseded the loader. The loader send is fire-and-forget
   * (it can stall behind a chat-wide 429 cooldown), so the agent's reply can
   * land BEFORE the loader's own send resolves; this flag tells the late
   * loader to delete itself on arrival instead of sticking under the answer.
   */
  loaderObsolete: boolean;
  /** Transient status/spinner message id — replaced by permanent text. */
  statusMessageId: number | null;
}

interface OutputQueueState {
  pendingOutput: string | null;
  /** Whether the FIRST batch in `pendingOutput` continues the last sent message. */
  pendingIsContinuation: boolean;
  isProcessing: boolean;
  debounceTimer: NodeJS.Timeout | null;
}

interface PendingQuestionState {
  data: OpenCodePendingQuestion;
  messageId: number | null;
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

const threadMessageStates = new Map<string, ThreadMessageState>();
const outputQueues = new Map<string, OutputQueueState>();
const pendingQuestions = new Map<string, PendingQuestionState>();
const threadModelLists = new Map<string, string[]>();
const awaitingModelSelection = new Set<string>();
const statusCoalescers = new Map<string, StatusCoalesceState>();

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
    s = { lastMessageId: null, lastMessageText: null, needsNewMessage: true, loaderMessageId: null, loaderObsolete: false, statusMessageId: null };
    threadMessageStates.set(k, s);
  }
  return s;
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

function getStatusCoalesceState(key: ThreadKey): StatusCoalesceState {
  const k = keyToString(key);
  let s = statusCoalescers.get(k);
  if (!s) {
    s = { pendingText: null, inFlight: false, lastSentText: null, deferRetryTimer: null };
    statusCoalescers.set(k, s);
  }
  return s;
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
  clearThreadOutputQueues(outputQueues.get(k), statusCoalescers.get(k));
}

function markNeedsNewMessage(key: ThreadKey): void {
  getThreadMessageState(key).needsNewMessage = true;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Threading helpers — gating, key extraction
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Thin Telegraf adapter over `resolveThreadKey` (pure logic
 * lives in `./threadRouting`, where it can be unit-tested). The bot only
 * needs to translate `ctx` shapes into the routing module's plain inputs.
 */
function getThreadKey(ctx: Context): ThreadKey | null {
  const msg = ctx.message as Message | undefined;
  const cbMsg = ctx.callbackQuery?.message as Message | undefined;
  return resolveThreadKey(
    {
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
    },
    getAllowedGroupId() ?? NaN,
  );
}

/** Is this thread the General forum topic? */
function checkIsGeneral(key: ThreadKey): boolean {
  return key.threadId === GENERAL_THREAD_ID;
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
  if (!userId || !(await checkIsAllowedUser(userId))) {
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
      console.warn(
        `[security] ignored update from chat ${ctx.chat.id} (not the forum supergroup we listen to)`,
      );
    }
    return null;
  }
  // Refresh the group-title cache from this authorised update — group chats
  // (supergroups) always carry `chat.title`. Feeds the thread-context
  // preamble (S2). Cheap, idempotent, and the only place every accepted
  // update funnels through.
  if (ctx.chat && 'title' in ctx.chat && ctx.chat.title) {
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
 * cleanup. Does NOT touch state.json — caller already did or will.
 */
function clearInMemoryThreadState(key: ThreadKey): void {
  const k = keyToString(key);
  // Drop queued output AND status frame (incl. cancelling the output
  // debounce timer) BEFORE deleting the map entries — otherwise an armed
  // `debounceTimer` would survive the `outputQueues.delete` as an orphan and
  // still fire into a freshly-bound session.
  clearThreadQueues(key);
  threadMessageStates.delete(k);
  outputQueues.delete(k);
  pendingQuestions.delete(k);
  threadModelLists.delete(k);
  awaitingModelSelection.delete(k);
  threadSessionLists.delete(k);
  awaitingSessionSelection.delete(k);
  awaitingFolderName.delete(k);
  pinnedStatusTextCache.delete(k);
  statusCoalescers.delete(k);
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
          'status',
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
        'status',
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
        'status',
      );
    } catch (e) {
      // Most common reason: bot is not admin or lacks `can_pin_messages`.
      // We still keep the message id so subsequent edits keep refreshing it
      // (so the user at least sees a fresh status line in the topic body
      // even without a pin).
      const desc = checkIsApiError(e) ? getErrorDescription(e) : (e instanceof Error ? e.message : String(e));
      console.warn(`[pinned] pin ${k} failed: ${desc}`);
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
        'status',
      );
    } catch (e) {
      const desc = checkIsApiError(e) ? getErrorDescription(e) : (e instanceof Error ? e.message : String(e));
      console.warn(`[pinned] unpin ${k} failed: ${desc}`);
    }
    try {
      await enqueueSend(key, () =>
        bot.telegram.deleteMessage(key.chatId, existingId),
        'status',
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

async function replyToThread(
  key: ThreadKey,
  text: string,
  extra: SendExtra = {},
  priority: SendPriority = 'interactive',
  /**
   * Internal guard against an infinite redelivery loop. The B14 cooldown
   * redelivery (see below) calls back into `replyToThread` once with this
   * set to `false` so a second double-429 just drops instead of requeueing
   * forever. Callers never pass this.
   */
  allowRedeliver = true,
): Promise<number | null> {
  // Snapshot binding presence now so the eventual redelivery can tell a
  // fresh (still-unbound) folder-picker thread apart from one the user
  // unbound / deleted between this send and the cooldown (B14).
  const hadBindingAtSend = state.getBinding(key) !== null;

  const sendOnce = (sendExtra: Record<string, unknown>) =>
    enqueueSend(key, () =>
      bot.telegram.sendMessage(
        key.chatId,
        text,
        sendExtra as Parameters<typeof bot.telegram.sendMessage>[2],
      ),
      priority,
    );

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

    // B14: a double-429 (rate-limited even after the single retry) would
    // otherwise drop an interactive reply permanently (live: the `/bind`
    // folder list that never arrived). For interactive content, schedule ONE
    // redelivery after the cooldown instead of dropping. Bounded — the
    // requeued send passes `allowRedeliver = false`, so a second double-429
    // drops normally with no loop. The requeue goes back through
    // `replyToThread` → `enqueueSend`, so FIFO / bucket / blockedUntil are
    // all respected. Edits/deletes don't reach here (only fresh sends).
    if (allowRedeliver && checkIsRateLimitedError(e)) {
      scheduleInteractiveRedelivery(key, text, extra, priority, hadBindingAtSend);
      return null;
    }

    await handleSendError(key, e);
    return null;
  }
}

/**
 * @description Schedule the single B14 redelivery of a rate-limited
 * interactive reply, fired once the chat's 429 cooldown has lifted.
 *
 * Wires the real clock / timer / binding-read / send into the testable
 * {@link scheduleRedelivery} orchestration. The redelivery re-enters
 * `replyToThread` with `allowRedeliver = false` so it can't loop.
 */
function scheduleInteractiveRedelivery(
  key: ThreadKey,
  text: string,
  extra: SendExtra,
  priority: SendPriority,
  hadBindingAtSend: boolean,
): void {
  console.warn(
    `[send] ${keyToString(key)} interactive reply hit double-429; redelivery scheduled after cooldown`,
  );
  scheduleRedelivery(priority, hadBindingAtSend, COOLDOWN_RETRY_SLACK_MS, {
    getRemainingCooldownMs: () => getRateLimitRemainingMs(key.chatId),
    scheduleAfter: (fn, ms) => { setTimeout(fn, ms); },
    getBindingNow: () => state.getBinding(key),
    redeliver: () => { void replyToThread(key, text, extra, priority, false); },
    onSkip: reason => console.log(`[send] ${keyToString(key)} skipping redelivery — ${reason}`),
  });
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
  priority: SendPriority = 'interactive',
): Promise<boolean> {
  const editOnce = (editExtra: Record<string, unknown>) =>
    enqueueSend(key, () =>
      bot.telegram.editMessageText(
        key.chatId, messageId, undefined, text,
        editExtra as Parameters<typeof bot.telegram.editMessageText>[4],
      ),
      priority,
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
  priority: SendPriority = 'interactive',
): Promise<void> {
  try {
    await enqueueSend(key, () => bot.telegram.deleteMessage(key.chatId, messageId), priority);
  } catch {
    /* messages older than 48h or already deleted — silently ignore */
  }
}

/**
 * @description `sendChatAction('typing')` in a thread. Best-effort; we
 * don't fail the caller if the API rejects it (e.g. action briefly not
 * supported for forum threads on older clients).
 */
async function sendThreadTypingIndicator(key: ThreadKey): Promise<void> {
  try {
    await enqueueSend(key, () =>
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
 * Telegram while it's already throttling us.
 */
function getOutputDelay(chatId: number): number {
  return checkIsRateLimited(chatId)
    ? Math.max(OUTPUT_DEBOUNCE_MS, 5000)
    : OUTPUT_DEBOUNCE_MS;
}

function queueOutput(key: ThreadKey, output: string, isContinuation = false): void {
  const q = getOutputQueueState(key);
  // The continuation flag of the FIRST batch in a fresh buffer decides whether
  // the whole flush extends the last sent message; later batches only append.
  if (q.pendingOutput === null) q.pendingIsContinuation = isContinuation;
  q.pendingOutput = appendPendingOutput(q.pendingOutput, output, isContinuation);
  if (q.debounceTimer) clearTimeout(q.debounceTimer);
  q.debounceTimer = setTimeout(() => {
    q.debounceTimer = null;
    processOutputQueue(key);
  }, getOutputDelay(key.chatId));
}

async function processOutputQueue(key: ThreadKey): Promise<void> {
  const q = getOutputQueueState(key);
  if (q.isProcessing || !q.pendingOutput) return;
  q.isProcessing = true;
  try {
    const out = q.pendingOutput;
    const isContinuation = q.pendingIsContinuation;
    q.pendingOutput = null;
    await sendOutputImmediate(key, out, isContinuation);
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
async function sendOutputImmediate(key: ThreadKey, output: string, isContinuation = false): Promise<void> {
  await deleteLoaderMessage(key);
  await deleteStatusMessage(key);

  const msgState = getThreadMessageState(key);
  const { chunks, shouldEditFirstChunk } = getOutputFlushPlan({
    output,
    isContinuation,
    needsNewMessage: msgState.needsNewMessage,
    lastMessageId: msgState.lastMessageId,
    lastMessageText: msgState.lastMessageText,
  });

  let startIndex = 0;
  if (shouldEditFirstChunk) {
    const editedOk =
      chunks[0] === msgState.lastMessageText ||
      (await editThreadMessage(key, msgState.lastMessageId!, renderAgentHtml(chunks[0]), { parse_mode: 'HTML' }, 'output'));
    if (editedOk) {
      msgState.lastMessageText = chunks[0];
      startIndex = 1;
    }
    // Edit failed (message deleted / API hiccup): fall through and send every
    // chunk fresh — the full combined text still reaches the user.
  }

  for (let i = startIndex; i < chunks.length; i++) {
    const id = await replyChunkWithFallback(key, renderAgentHtml(chunks[i]), chunks[i], 'output');
    if (id) {
      msgState.lastMessageId = id;
      msgState.lastMessageText = chunks[i];
      msgState.needsNewMessage = false;
    }
  }
}

/**
 * @description Send a chunk as HTML first; if Telegram rejects the entities,
 * fall back to plain text so the message reaches the user either way.
 */
async function replyChunkWithFallback(
  key: ThreadKey,
  renderedHtml: string,
  plainFallback: string,
  priority: SendPriority = 'interactive',
): Promise<number | null> {
  const id = await replyToThread(key, renderedHtml, { parse_mode: 'HTML' }, priority);
  if (id) return id;
  return replyToThread(key, plainFallback, {}, priority);
}

async function deleteLoaderMessage(key: ThreadKey): Promise<void> {
  const s = getThreadMessageState(key);
  // Mark even when no id is stored yet: an in-flight loader send (stalled in
  // the rate-limit queue) checks this flag on arrival and self-deletes.
  s.loaderObsolete = true;
  if (s.loaderMessageId === null) return;
  const id = s.loaderMessageId;
  s.loaderMessageId = null;
  await deleteThreadMessage(key, id);
}

async function deleteStatusMessage(key: ThreadKey): Promise<void> {
  const s = getThreadMessageState(key);
  // The next status frame will create a *new* message, so the dedup baseline
  // is stale — clear it, otherwise an identical-text frame after a delete
  // would be wrongly skipped and the fresh status message never appear.
  getStatusCoalesceState(key).lastSentText = null;
  if (s.statusMessageId === null) return;
  const id = s.statusMessageId;
  s.statusMessageId = null;
  await deleteThreadMessage(key, id);
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
function getWorkDir(key: ThreadKey): string | null {
  const decision = getBindGateDecision(state.getBinding(key), ENV.workRoot);
  return decision.kind === 'proceed' ? decision.workDir : null;
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
 * The FIRST row is always a full-width «create new folder» button
 * (`bindCreateFolderCallback`) — its callback deliberately does NOT start
 * with `bind_`, so it can't be mistaken for a folder pick by the
 * `bind_<subdir>` action regex. It rides on every page so it's reachable
 * regardless of pagination.
 */
const bindCreateFolderCallback = 'bindCreateFolder';

function buildBindKeyboard(
  subdirs: readonly string[],
  page: number = 0,
  pageSize: number = BIND_PAGE_SIZE,
) {
  const { slice, currentPage, totalPages } = paginateBindList(subdirs, page, pageSize);

  const rows = [
    [Markup.button.callback(t('bind.create_button'), bindCreateFolderCallback)],
  ];
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
 * @description Explicit-stop teardown shared by `/stop` and `/new`/`/clear_session`:
 * sweep every adapter active for the thread, then RELEASE the persisted session
 * ids (even when nothing was running) so a later bot restart won't auto-reattach
 * and any half-dead state from a crash/SSE-giveup is cleared. The session stays
 * on disk → still reachable via `/sessions`. Returns the sweep result so callers
 * can decide what to reply.
 */
async function releaseThreadSession(key: ThreadKey): Promise<ReturnType<typeof stopAllAdaptersFor>> {
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
  if (newName === 'claude' && agent.claudeSessionId) next.claudeSessionId = agent.claudeSessionId;
  if (newName === 'opencode' && agent.opencodeSessionId) next.opencodeSessionId = agent.opencodeSessionId;
  // Overwrite by removing the row first; setAgent then writes only the
  // fields we kept.
  await state.removeAgent(key);
  await state.setAgent(key, next);
}

async function startAgentSession(key: ThreadKey, args?: string): Promise<string> {
  const kStr = keyToString(key);
  // The bound folder IS the agent's cwd — refuse to start without one. The
  // command/natural-language callers gate on the binding too, but a binding
  // can vanish (/unbind) between their check and here, so re-check before any
  // side effect (startup window / markers) opens.
  const workDir = getWorkDir(key);
  if (!workDir) return t('thread.bind_required');
  // Open the startup window synchronously (before the first await) so text
  // typed right after `/claude` / `/opencode` is buffered, not dropped.
  startupPromptBuffer.markStarting(kStr);
  markNeedsNewMessage(key);
  // Fresh session — the agent's context is empty, so the next prompt must
  // re-carry the thread-context preamble. Forget the last-injected marker.
  clearThreadContextMarker(key);
  const adapter = getThreadAdapter(key);

  // U1 from plan §10.2 / §16.3: typing indicator while the agent boots so
  // the user doesn't think the bot is asleep.
  sendThreadTypingIndicator(key).catch(() => {});

  try {
    await adapter.startSession(key, workDir, args);

    // Persist backend session ids so a bot restart can re-attach without
    // losing the live conversation (Claude tmux UUID; OpenCode server UUID).
    if (adapter instanceof ClaudeCliAdapter) {
      const uuid = adapter.getClaudeSessionId(key);
      if (uuid) await state.setClaudeSessionId(key, uuid);
    } else if (adapter instanceof OpenCodeAdapter) {
      const sessionId = adapter.getOpenCodeSessionId(key);
      if (sessionId) await state.setOpenCodeSessionId(key, sessionId);
    }
    await state.setAgent(key, { name: adapter.name });

    // Session is active now — replay anything the user typed while it booted,
    // in arrival order, through the normal forward path. Fire-and-forget so the
    // `ready` message isn't delayed; `drainPrompts` runs synchronously here
    // (before the first await inside) so the startup window is already closed
    // by the time we return — no message can slip into a second buffer.
    void replayBufferedPrompts(key);

    const subdir = state.getBinding(key)?.subdir ?? path.basename(ENV.workRoot);
    return t('agent.ready', {
      label: adapter.label,
      subdir,
      argsSuffix: args ? ` (${args})` : '',
    });
  } catch (e) {
    // Start failed — the buffered prompts have nowhere to go, so drop them
    // rather than replaying into a dead session.
    startupPromptBuffer.discardPrompts(kStr);
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
 * fresh output message, show the `⏳` loader, and hand the text to the adapter.
 * Shared by the text handler, the voice handler, and startup-prompt replay so
 * the loader/marker behaviour stays identical across all three.
 *
 * If the adapter implements `interruptAndWaitIdle`, we interrupt the running
 * turn and wait until it is actually idle before handing over the text —
 * waiting (instead of a fixed delay) is what keeps the prompt from queuing
 * behind a still-running turn. Claude does this via Escape + a TUI poll,
 * OpenCode via `POST /abort` + an SSE-state wait; both leave a running
 * sub-agent / compaction untouched and let the prompt queue instead. An
 * adapter without the method forwards directly.
 */
async function forwardPromptToAgent(
  key: ThreadKey,
  adapter: AgentAdapter,
  text: string,
): Promise<void> {
  // Glue the thread-context preamble (topic / group / thread / folder) ahead
  // of the prompt so the agent knows WHERE it works. Slash commands forwarded
  // to the agent (`/clear`, `/compact`, …) are skipped — a preamble would
  // corrupt them into plain text. The preamble rides only when it differs
  // from the last one we injected this session (fresh session, rename, or
  // post-`/clear` marker reset). See `threadContextPreamble.ts`.
  const promptText = getPromptWithThreadContext(key, text);
  markNeedsNewMessage(key);
  const msgState = getThreadMessageState(key);
  msgState.loaderObsolete = false;
  // Deliberately NOT awaited (B6): during a chat-wide 429 cooldown this send
  // can stall for tens of seconds, and the prompt's local tmux/HTTP delivery
  // must never wait on Telegram send capacity. If the agent's reply lands
  // first, `deleteLoaderMessage` flips `loaderObsolete` and the late ⏳
  // deletes itself on arrival instead of sticking under the answer.
  void replyToThread(key, '⏳')
    .then((loaderId) => {
      if (!loaderId) return;
      if (msgState.loaderObsolete) {
        void deleteThreadMessage(key, loaderId).catch(() => {});
        return;
      }
      msgState.loaderMessageId = loaderId;
    })
    .catch(() => {});
  if (adapter.interruptAndWaitIdle) {
    await adapter.interruptAndWaitIdle(key);
  }
  adapter.sendInput(key, promptText);
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
function getPromptWithThreadContext(key: ThreadKey, text: string): string {
  if (checkShouldSkipPreambleForText(text)) return text;

  const binding = state.getBinding(key);
  const subdir = binding?.subdir ?? path.basename(ENV.workRoot);
  const preamble = buildThreadContextPreamble({
    topicName: binding?.topicName,
    groupTitle: groupTitleCache.get(key.chatId),
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
  const names = Array.isArray(name) ? name : [name];
  // `/cancel` owns its own exit + acknowledgement for the create-folder mode,
  // so the wrapper must NOT clear the flag before it runs (it would otherwise
  // see "nothing armed" and reply the no-op notice).
  const ownsFolderModeExit = names.includes('cancel');
  bot.command(name, async (ctx) => {
    const key = await authoriseContext(ctx);
    if (!key) return;
    // Running any other command exits the /bind create-folder await-name mode —
    // the create flow only expects a plain folder-name message, never a command.
    // (The picker's create button re-arms it afterwards via its own callback.)
    if (!ownsFolderModeExit) awaitingFolderName.delete(keyToString(key));
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
      '/stop — stop current agent\n' +
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
      switch (e.code) {
        case 'BIND_INVALID_CHARS': msg = t('bind.invalid_chars'); break;
        case 'BIND_NOT_FOUND':     msg = t('bind.not_found', { subdir: rawSubdir, workRoot: ENV.workRoot }); break;
        case 'BIND_OUTSIDE_ROOT':  msg = t('bind.outside_root'); break;
        case 'BIND_NOT_DIRECTORY': msg = t('bind.not_directory', { subdir: rawSubdir }); break;
        default:                   msg = `❌ ${e.message}`;
      }
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
  return { ok: true, message, subdir };
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
  pendingQuestions.delete(kStr);
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
    // from an empty WORK_ROOT without the slash form.
    await replyToThread(key, usage, buildBindKeyboard(subdirs));
    return;
  }
  const result = await applyBinding(key, arg);
  await replyToThread(key, result.message);
  if (result.ok) await sendBindingWelcome(key, result.subdir);
});

command('unbind', async (_ctx, key) => {
  if (checkIsGeneral(key)) {
    await replyToThread(key, t('bind.in_general'));
    return;
  }
  const binding = state.getBinding(key);
  if (!binding) {
    await replyToThread(key, t('thread.unbind_unbound'));
    return;
  }
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
      try { adapter.stopSession(key); } catch (e) {
        console.warn(`[unbind] stopSession failed for ${kStr}:`, e);
      }
    }
    // Release persisted session ids too — otherwise re-binding this thread
    // later + a bot restart would resurrect the old session the user unbound.
    await state.clearAgentSessionIds(key);
    await state.removeBinding(key);
    clearInMemoryThreadState(key);
    await replyToThread(key, t('thread.unbound'));
  } finally {
    unbindingKeys.delete(kStr);
  }
});

command('where', async (_ctx, key) => {
  if (checkIsGeneral(key)) {
    const bindings = state.listBindings();
    const active = bindings.filter(({ key: k }) => {
      const a = state.getAgent(k);
      if (!a) return false;
      try { return getThreadAdapter(k).checkIsActive(k); } catch { return false; }
    }).length;
    await replyToThread(
      key,
      t('thread.where_root', {
        workRoot: ENV.workRoot,
        bindings: bindings.length,
        active,
      }),
    );
    return;
  }
  const binding = state.getBinding(key);
  if (!binding) {
    await replyToThread(key, t('thread.where_unbound'));
    return;
  }
  const adapter = getThreadAdapter(key);
  const isActive = adapter.checkIsActive(key);
  await replyToThread(
    key,
    t('thread.where_bound', {
      subdir: binding.subdir,
      agent: adapter.label,
      status: isActive ? 'running' : 'stopped',
    }),
  );
});

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
 * auto-reattach it. Unlike `/stop` + `/claude`, this is one tap and keeps the
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
  // Release the current session the same way `/stop` does (sweep + clear ids).
  // The fresh start below uses the thread's current adapter, so we keep the
  // adapter selection untouched.
  await releaseThreadSession(key);
  // `startAgentSession` handles startup buffering, the typing indicator, the
  // preamble-marker reset, and sends its own `agent.ready` — no extra "started"
  // notice here to avoid double-posting.
  const msg = await startAgentSession(key);
  await replyToThread(key, msg);
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
  const allowed = (await checkIsAllowedUser(userId)) && ctx.chat?.id === getAllowedGroupId();
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
    const extra = buildBindKeyboard(subdirs);
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

async function handleStartCommand(
  ctx: NarrowedContext<Context, Update.MessageUpdate<Message.TextMessage>>,
  key: ThreadKey,
  adapterName: 'claude' | 'opencode',
): Promise<void> {
  if (checkIsGeneral(key)) {
    await replyToThread(key, t('error.start_in_general'));
    return;
  }
  // Refuse to start an agent without a binding — same rationale as the
  // natural-language path in the text handler (plan §11 Этап 4).
  if (!state.getBinding(key)) {
    const subdirs = listAvailableSubdirs(ENV.workRoot);
    const extra = buildBindKeyboard(subdirs);
    await replyToThread(key, t('thread.no_binding'), extra);
    return;
  }
  await switchThreadAdapter(key, adapterName);
  const adapter = getThreadAdapter(key);
  if (adapter.checkIsActive(key)) {
    await replyToThread(key, t('agent.already_active', { label: adapter.label }));
    return;
  }
  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const msg = await startAgentSession(key, args || undefined);
  await replyToThread(key, msg);
}

command('claude', (ctx, key) => handleStartCommand(ctx, key, 'claude'));
command(['opencode', 'oc'], (ctx, key) => handleStartCommand(ctx, key, 'opencode'));

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
  if (!adapter.checkIsActive(key)) {
    await replyToThread(key, t('effort.no_session'));
    return;
  }

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
 * @description Build the `/agent` picker keyboard.
 *
 * One callback button per available adapter (2 per row); the adapter whose
 * name matches `currentName` carries a `✓` marker. Shared by the `/agent`
 * command (initial render) and the `agent_<name>` callback (re-render after
 * a press) so the marker can never drift between the two (B16, mirrors B12).
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

command('agent', async (_ctx, key) => {
  const available = getAvailableAdapters();
  const currentName = getThreadAdapterName(key);
  await replyToThread(key, 'Choose agent:', buildAgentKeyboard(available, currentName));
});

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
    const extra = buildBindKeyboard(subdirs);
    await replyToThread(key, t('thread.no_binding'), extra);
    return;
  }

  // Guarded by the `!state.getBinding` early-return above, so workDir is
  // non-null here; the explicit check keeps the no-fallback contract honest.
  const workDir = getWorkDir(key);
  if (!workDir) {
    await replyToThread(key, t('thread.bind_required'));
    return;
  }
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
  const workDir = getWorkDir(key);
  if (!workDir) return t('thread.bind_required');
  const adapter = getThreadAdapter(key);
  markNeedsNewMessage(key);
  try {
    // The ONLY resume path that posts the "last N messages" context block —
    // silent re-attach (bot restart) and crash recovery must stay quiet.
    await adapter.resumeSession(key, workDir, sessionId, { isWithRecentContext: true });
    return t('session.resumed');
  } catch (e) {
    return t('session.resume_failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

command(['sessions', 'resume'], (_ctx, key) => handleSessionsList(key));

// Exit session-pick mode without resuming. No-op (friendly notice) when the
// thread wasn't armed, so a stray /cancel never looks broken.
command('cancel', async (_ctx, key) => {
  const kStr = keyToString(key);
  if (awaitingFolderName.has(kStr)) {
    awaitingFolderName.delete(kStr);
    await replyToThread(key, t('bind.create_cancelled'));
    return;
  }
  if (awaitingSessionSelection.has(kStr)) {
    awaitingSessionSelection.delete(kStr);
    await replyToThread(key, t('session.cancelled'));
  } else {
    await replyToThread(key, t('session.cancel_noop'));
  }
});

command('stop', async (_ctx, key) => {
  // Sweep every adapter, not just the one the in-memory map currently
  // points at — keeps `/stop` working when state and reality have drifted
  // apart (a previous switch left a live session on the other adapter).
  // `releaseThreadSession` also wipes the persisted ids unconditionally so a
  // later bot restart won't auto-reattach and half-dead state is cleared.
  const { stopped, attempted } = await releaseThreadSession(key);
  if (attempted === 0) {
    await replyToThread(key, 'No agent running');
    return;
  }
  for (const label of stopped) {
    await replyToThread(key, t('agent.stopped', { label }));
  }
});

/**
 * @description `/stop-all` — kill every active agent across every thread.
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
command(['stop-all', 'stopall'], async (_ctx, key) => {
  if (!checkIsGeneral(key)) {
    await replyToThread(key, t('stop_all.general_only'));
    return;
  }

  // Same sweep semantics as `/stop`: kill any adapter that's actually
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
    // Same release-for-good semantics as `/stop`, per swept thread.
    await state.clearAgentSessionIds(bKey);
  }

  if (active === 0) {
    await replyToThread(key, t('stop_all.none_active'));
    return;
  }
  await replyToThread(key, t('stop_all.summary', { stopped: String(stopped), total: String(active) }));
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

// `/quit` (alias `/q`) — graceful exit of the agent, regardless of
// adapter shape. Lives alongside `/stop` and `/stop-all` because it's
// a session-end command, not a tmux-style intra-session control.
// Two distinct paths because the agents themselves have very
// different "exit" semantics:
//
// • Claude CLI runs in a tmux session. Its canonical exit is two
//   Ctrl+C in quick succession (the first cancels the current turn,
//   the second leaves the CLI). We replay that by sending `SIGINT`
//   through the adapter twice with a small gap — softer than the
//   `tmux kill-session` that `/stop` performs.
//
// • OpenCode is a long-running HTTP server, not a TUI. There is no
//   "double Ctrl+C" — the only way to actually leave is to abort
//   the running generation, disconnect the SSE stream and drop the
//   session, which is exactly what `stopSession` does. We call it
//   directly so `/quit` behaves like a real exit instead of two
//   no-op aborts.
command(['quit', 'q'], async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  const adapterName = getThreadAdapterName(key);
  const primaryActive = adapter.checkIsActive(key);

  // Defensive: any *other* adapter that's also active for this thread is
  // a leftover from a previous botched switch. Kill it first so it can't
  // keep streaming after the user's "quit". Same robustness as `/stop` —
  // re-using the sweep helper instead of an open-coded loop avoids
  // drift between the two call sites.
  const otherAdapters = getKnownAdapterNames().filter(n => n !== adapterName);
  stopAllAdaptersFor(key, otherAdapters);

  if (!primaryActive) {
    await replyToThread(key, 'No agent running');
    return;
  }
  markNeedsNewMessage(key);

  if (adapterName === 'opencode') {
    adapter.stopSession(key);
    // Explicit quit releases the session for good — no auto-reattach later.
    await state.clearAgentSessionIds(key);
    await replyToThread(key, t('agent.stopped', { label: adapter.label }));
    return;
  }

  adapter.sendSignal(key, 'SIGINT');
  await new Promise((r) => setTimeout(r, CLAUDE_DOUBLE_SIGINT_GAP_MS));
  adapter.sendSignal(key, 'SIGINT');
  // Explicit quit releases the session for good — no auto-reattach later.
  await state.clearAgentSessionIds(key);
  await replyToThread(key, t('agent.exit_signal_sent', { label: adapter.label }));
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

const botCommands = new Set([
  'start', 'claude', 'opencode', 'oc', 'agent', 'sessions', 'resume', 'cancel', 'model',
  'stop', 'status', 'c', 'y', 'n', 'enter', 'up', 'down', 'tab', 'output', 'clear_messages',
  'bind', 'unbind', 'where', 'ls', 'list', 'new', 'clear_session', 'whoami', 'version', 'help',
  'doctor', 'mcp', 'rename_session', 'trace', 'schedule',
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
        const extra = buildBindKeyboard(subdirs);
        await replyToThread(key, t('thread.no_binding'), extra);
        return;
      }
      await replyToThread(key, result.message);
      return;
    }
  }

  // Pending interactive question (OpenCode) → custom text answer.
  const pending = pendingQuestions.get(kStr);
  if (pending && adapter.checkIsActive(key) && adapter.answerQuestion) {
    const answers: string[][] = pending.data.questions.map(() => [text]);
    pendingQuestions.delete(kStr);
    if (pending.messageId) {
      const q = pending.data.questions[0];
      const header = q?.header || q?.question || 'Question';
      await editThreadMessage(key, pending.messageId, `✅ ${header}: ${text}`);
    }
    adapter.answerQuestion(key, answers);
    markNeedsNewMessage(key);
    return;
  }

  // Claude TUI selector on screen + a bare control reply (option digit or
  // y/n) → drive the selector in place. Forwarding it as a prompt would first
  // send Escape (interruptAndWaitIdle) and cancel the menu — live-caught with
  // /login: the user replied "1" and got "⎿ Login interrupted". sendInput
  // types the digit + an instant Enter (short-control path), which jumps the
  // selector to that option and confirms it. Only an on-screen selector
  // (isQuestionPending) arms this — a normal "1" prompt is never hijacked.
  if (adapter.isQuestionPending?.(key) && checkIsSelectorControlReply(text)) {
    markNeedsNewMessage(key);
    adapter.sendInput(key, text);
    return;
  }

  // Forward text to a running agent. Every user message is treated as a fresh
  // turn: forwardPromptToAgent interrupts the current turn for TUI backends
  // (cancelling any on-screen selector and breaking Claude out of the busy
  // state) and waits for idle before typing, so the message isn't queued
  // behind the current turn — EXCEPT while a sub-agent runs or context is
  // compacting, where it deliberately does NOT interrupt and lets the message
  // queue. Deliberately driving a selector in place is still available via the
  // explicit /up /down /enter /y /n /c keys, and a bare digit / y / n while a
  // selector is on screen is routed to it above.
  if (adapter.checkIsActive(key)) {
    // A bare `/clear` forwarded to the agent wipes its context (Claude TUI),
    // so the next prompt must re-carry the thread-context preamble. Reset the
    // marker before forwarding — the slash text itself never gets a preamble.
    // The agent's context is gone, so any intake files it might reference are
    // now useless — purge the thread's files dir in the same breath.
    if (text === forwardedClearCommand) {
      clearThreadContextMarker(key);
      await purgeThreadFiles(getDataDir(), key).catch((e) =>
        console.warn(`[file] purge on /clear failed for ${keyToString(key)}:`, e),
      );
    }
    await forwardPromptToAgent(key, adapter, text);
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
    const extra = buildBindKeyboard(subdirs);
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

  await state.pushMessageId(key, ctx.message.message_id);

  if (!ENV.groqApiKey && !ENV.openaiApiKey) {
    await replyToThread(key, t('voice.no_api_key'));
    return;
  }

  try {
    const fileId = ctx.message.voice.file_id;
    // Audit S14 / #33: `getFileLink` builds the bot-token URL in one
    // place inside Telegraf instead of us materialising the token in a
    // JS string. The previous manual interpolation worked but
    // accidentally leaking the token into any future log call would
    // expose the bot.
    const fileUrlObj = await ctx.telegram.getFileLink(fileId);
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
    await replyToThread(key, t('voice.transcribed', { text: transcript }));

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
          const extra = buildBindKeyboard(subdirs);
          await replyToThread(key, t('thread.no_binding'), extra);
          return;
        }
        await switchThreadAdapter(key, startMatch.adapterName);
        const msg = await startAgentSession(key, startMatch.args);
        await replyToThread(key, msg);
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
        const extra = buildBindKeyboard(subdirs);
        await replyToThread(key, t('thread.no_binding'), extra);
        return;
      }
      await replyToThread(key, t('thread.no_agent_with_binding', { subdir: binding.subdir }));
      return;
    }

    await forwardPromptToAgent(key, adapter, transcript);
  } catch (err) {
    console.error('[Bot] Voice handling error:', err);
    await replyToThread(key, 'Error processing voice message');
  }
});

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
    const extra = buildBindKeyboard(subdirs);
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
  if (!userId || !(await checkIsAllowedUser(userId))) {
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

  const extra = buildBindKeyboard(subdirs);
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
  if (!userId || !(await checkIsAllowedUser(userId))) {
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
  if (!userId || !(await checkIsAllowedUser(userId))) {
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
  if (!userId || !(await checkIsAllowedUser(userId))) {
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
  const keyboard = buildBindKeyboard(subdirs, page);
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
  if (!adapter.checkIsActive(key)) {
    await ctx.answerCbQuery(t('cb.no_active_session'));
    return;
  }
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
          'interactive',
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

bot.action(/^agent_(.+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const adapterName = ctx.match[1];
  try {
    await switchThreadAdapter(key, adapterName);
    const adapter = getThreadAdapter(key);
    await ctx.answerCbQuery(t('cb.agent_switched', { label: adapter.label }));
    await replyToThread(
      key,
      `Agent: ${adapter.label}\nSend a message or /${adapterName} to start`,
    );
    // Persist the choice so the banner survives restart and reflect it now.
    if (state.getBinding(key)) {
      await state.setAgent(key, { name: adapterName }).catch(() => {});
      await updatePinnedStatus(key).catch(() => {});
    }

    // Re-render the picker so the `✓` marker follows the newly-selected agent
    // instead of staying stuck on the previous one (B16, mirrors B12). The
    // switch keeps the picker message visible (a fresh "Agent: …" reply is
    // sent, the picker is neither edited nor deleted), so the stale marker
    // would otherwise persist.
    const cbMsg = ctx.callbackQuery?.message as Message | undefined;
    if (cbMsg) {
      const keyboard = buildAgentKeyboard(getAvailableAdapters(), adapterName);
      try {
        await enqueueSend(
          key,
          () => bot.telegram.editMessageReplyMarkup(
            key.chatId, cbMsg.message_id, undefined, keyboard.reply_markup,
          ),
          'interactive',
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
  const question = pending.data.questions[qIdx];
  if (!question || !question.options[optIdx]) {
    await ctx.answerCbQuery(t('cb.invalid_option'));
    return;
  }
  const selectedLabel = question.options[optIdx].label;
  const adapter = getThreadAdapter(key);
  const answers: string[][] = pending.data.questions.map((_, i) =>
    i === qIdx ? [selectedLabel] : [''],
  );
  pendingQuestions.delete(kStr);
  if (pending.messageId) {
    await editThreadMessage(
      key,
      pending.messageId,
      `✅ ${question.header || question.question}: ${selectedLabel}`,
    );
  }
  if (adapter.answerQuestion) {
    adapter.answerQuestion(key, answers);
    markNeedsNewMessage(key);
  }
  await ctx.answerCbQuery(selectedLabel);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Adapter event handlers (output / status / question / closed / error)
// ═══════════════════════════════════════════════════════════════════════════════

function handleAgentOutput(key: ThreadKey, output: string, meta?: OutputEventMeta): void {
  console.log(`[Bot] output ${keyToString(key)} (${output.length}): ${output.slice(0, 100)}...`);
  if (!output.trim()) return;
  traceAgentEmit('output', key, output);

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
    handleAgentStatus(key, collapseProgressChunk(output));
    return;
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
    void deleteStatusMessage(key).catch(() => {});
  }
  queueOutput(key, output, meta?.isContinuation === true);
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
function handleAgentStatus(key: ThreadKey, status: string): void {
  if (!status.trim()) return;
  console.log(`[Bot] status ${keyToString(key)}: ${status.slice(0, 100)}`);
  traceAgentEmit('status', key, status);

  deleteLoaderMessage(key).catch(() => {});

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
  const chunks = splitMessage(status);
  let landed = false;
  try {
    const firstRendered = renderAgentHtml(chunks[0]);
    if (msgState.statusMessageId) {
      const ok = await editThreadMessage(key, msgState.statusMessageId, firstRendered, {
        parse_mode: 'HTML',
      }, 'status');
      if (ok) {
        landed = true;
      } else {
        msgState.statusMessageId = null;
        const id = await replyChunkWithFallback(key, firstRendered, chunks[0], 'status');
        if (id) { msgState.statusMessageId = id; landed = true; }
      }
    } else {
      const id = await replyChunkWithFallback(key, firstRendered, chunks[0], 'status');
      if (id) { msgState.statusMessageId = id; landed = true; }
    }
    for (let i = 1; i < chunks.length; i++) {
      const rendered = renderAgentHtml(chunks[i]);
      const id = await replyChunkWithFallback(key, rendered, chunks[i], 'status');
      if (id) msgState.statusMessageId = id;
    }
  } catch (err) {
    console.error('[sendStatusFrame] Failed:', err);
  }
  return landed;
}

function handleAgentQuestion(key: ThreadKey, questionData: OpenCodePendingQuestion): void {
  console.log(`[Bot] question ${keyToString(key)} (${questionData.requestId}): ${questionData.questions.length}`);
  // A pending status frame is now stale — the question UI replaces it.
  getStatusCoalesceState(key).pendingText = null;
  deleteStatusMessage(key).catch(() => {});
  deleteLoaderMessage(key).catch(() => {});

  // Audit S13 / #31: register the pending question BEFORE the async
  // network round-trip. A user hammering an inline button right after
  // the question arrives used to find an empty `pendingQuestions` entry
  // (the network reply was still in flight) and get a confusing
  // "no pending question" answerCbQuery. The messageId is patched in
  // after `replyToThread` resolves.
  const kStr = keyToString(key);
  pendingQuestions.set(kStr, { data: questionData, messageId: null });

  (async () => {
    try {
      for (let qIdx = 0; qIdx < questionData.questions.length; qIdx++) {
        const q = questionData.questions[qIdx];
        const header = q.header || q.question || 'Question';
        const lines: string[] = [`❓ *${escapeMarkdown(header)}*`];
        if (q.question && q.question !== header) lines.push(escapeMarkdown(q.question));

        const buttons = q.options.map((opt, optIdx) => {
          const label = opt.label.length > 40 ? opt.label.slice(0, 37) + '...' : opt.label;
          return [Markup.button.callback(label, `qa_${qIdx}_${optIdx}`)];
        });
        const keyboard = buttons.length > 0 ? Markup.inlineKeyboard(buttons) : undefined;

        const extra: Record<string, unknown> = { parse_mode: 'Markdown' };
        if (keyboard) Object.assign(extra, keyboard);

        let messageId = await replyToThread(key, lines.join('\n'), extra);
        if (!messageId) {
          // Markdown rejected — retry plain.
          const plainLines = [`❓ ${header}`];
          if (q.question && q.question !== header) plainLines.push(q.question);
          const plainExtra: Record<string, unknown> = {};
          if (keyboard) Object.assign(plainExtra, keyboard);
          messageId = await replyToThread(key, plainLines.join('\n'), plainExtra);
        }

        if (messageId !== null) {
          // Patch the messageId on the existing entry (it may already
          // have been deleted by a `qa_*` callback firing in between).
          const existing = pendingQuestions.get(kStr);
          if (existing && existing.data === questionData) {
            existing.messageId = messageId;
          }
        }
      }
    } catch (err) {
      console.error('[handleAgentQuestion] Failed:', err);
    }
  })();
}

function handleAgentClosed(key: ThreadKey): void {
  // Session is gone — drop any not-yet-sent output AND status frame so they
  // don't surface after the "session ended" notice (the trailing-output bug:
  // a 429 backlog could let queued deltas land seconds after the close).
  clearThreadQueues(key);
  deleteStatusMessage(key).catch(() => {});
  pendingQuestions.delete(keyToString(key));
  const adapter = getThreadAdapter(key);
  replyToThread(key, t('agent.session_ended', { label: adapter.label })).catch(() => {});
  // Banner now reads `idle`; closed sessions may also persist with the
  // wrong model/agent label otherwise.
  updatePinnedStatus(key).catch(() => {});
}

function handleAgentError(key: ThreadKey, error: Error): void {
  console.error(`[Bot] adapter error ${keyToString(key)}:`, error.message);
  getStatusCoalesceState(key).pendingText = null;
  deleteStatusMessage(key).catch(() => {});
  pendingQuestions.delete(keyToString(key));
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
  // `/stop`, `/stop-all`, `/quit` (OpenCode), `/unbind`, and adapter switch
  // all emit `stopped`. Drop the thread's queued-but-unsent output here so
  // nothing coalesced before the stop posts after the "stopped" confirmation.
  clearThreadQueues(key);
  // Session ended — a future session starts with empty context, so forget the
  // last-injected thread-context preamble; the next prompt re-carries it.
  clearThreadContextMarker(key);
  updatePinnedStatus(key).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Startup orchestration — state init, re-attach, setMyCommands, launch
// ═══════════════════════════════════════════════════════════════════════════════

const COMMANDS_MENU = [
  { command: 'help', description: '❓ Context-aware help' },
  { command: 'doctor', description: '🔍 Self-diagnostics' },
  { command: 'bind', description: '📁 Bind thread to a subfolder' },
  { command: 'unbind', description: '🚫 Remove binding' },
  { command: 'where', description: '📍 Show current binding' },
  { command: 'ls', description: '📂 List WORK_ROOT subfolders' },
  { command: 'list', description: '🧵 List all bound threads' },
  { command: 'mcp', description: '🔌 List active MCP servers' },
  { command: 'claude', description: '▶️ Start Claude Code' },
  { command: 'opencode', description: '▶️ Start OpenCode' },
  { command: 'new', description: '🆕 Restart session (alias /clear_session)' },
  { command: 'clear_session', description: '🆕 Restart session (alias /new)' },
  { command: 'model', description: '🧠 Switch model' },
  { command: 'effort', description: '⚙️ Reasoning effort' },
  { command: 'agent', description: '🔄 Choose agent' },
  { command: 'sessions', description: '📋 Previous sessions (alias /resume)' },
  { command: 'resume', description: '📋 Resume a previous session' },
  { command: 'rename_session', description: '✏️ Rename the current session (OpenCode)' },
  { command: 'cancel', description: '🚫 Cancel the session picker' },
  { command: 'stop', description: '⏹ Stop agent (hard kill)' },
  { command: 'quit', description: '🚪 Quit agent (graceful, alias /q)' },
  { command: 'stopall', description: '🛑 Stop ALL agents (General-only)' },
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
  { command: 'y', description: '✅ Send "y"' },
  { command: 'n', description: '❌ Send "n"' },
  { command: 'c', description: '🛑 Ctrl+C' },
  { command: 'clear_messages', description: '🗑 Delete this thread\'s messages' },
];

/**
 * @description Re-adopt tmux sessions and OpenCode SSE streams that
 * outlived the bot process.
 *
 * Plan §10.2 / §13.19 (E1). Runs **before** `bot.launch()` so the first
 * user message in any thread already finds a live adapter session, not
 * a stale "agent not running" reply.
 *
 * `opts.quietReattach` controls whether each successfully re-adopted
 * session triggers a per-topic notice (`t('agent.reattached')`). On a hot
 * reload (nodemon swap, sub-threshold downtime) the user typically didn't
 * even notice the bot blinked — spamming every active topic with
 * "session reattached" is noise. On a real cold start (the operator
 * actually stopped and restarted the bot) the notice is informative and
 * stays. The classifier lives in `bootClassifier.ts`; this function only
 * consumes the flag.
 */
async function reattachExistingSessions(
  opts: { quietReattach: boolean } = { quietReattach: false },
): Promise<void> {
  // 0. Rehydrate per-thread adapter choice from state.agents into the
  //    in-memory `threadAdapterNames` map. Without this, every thread
  //    reverts to DEFAULT_AGENT after a restart, so `getThreadAdapter(key)`
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
        const workDir = path.join(ENV.workRoot, binding.subdir);
        if (await claudeAdapter.adoptExistingTmuxSession(key, sessionName, workDir, agent.claudeSessionId)) {
          adopted += 1;
          if (!opts.quietReattach) {
            replyToThread(key, t('agent.reattached')).catch(() => {});
          }
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
  for (const { key, data: binding } of state.listBindings()) {
    const agent = state.getAgent(key);
    if (!agent || agent.name !== 'opencode' || !agent.opencodeSessionId) continue;
    if (opencodeAdapter.checkIsActive(key)) continue;
    try {
      const workDir = path.join(ENV.workRoot, binding.subdir);
      await opencodeAdapter.resumeSession(key, workDir, agent.opencodeSessionId);
      reopened += 1;
      if (!opts.quietReattach) {
        replyToThread(key, t('agent.reattached')).catch(() => {});
      }
    } catch (e) {
      console.warn(`[reattach] opencode ${keyToString(key)} failed:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`[reattach] opencode: reopened ${reopened} sessions (quiet=${opts.quietReattach})`);
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
    onStatus: handleAgentStatus,
    onQuestion: handleAgentQuestion,
    onClosed: handleAgentClosed,
    onStarted: handleAgentStarted,
    onStopped: handleAgentStopped,
    onError: handleAgentError,
  });

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

  // 5. Re-attach sessions that survived the restart. Quiet during a hot
  //    reload so the user isn't spammed with "session reattached" notices
  //    on every nodemon swap; verbose on a real cold start.
  await reattachExistingSessions({ quietReattach: bootMode.isHotReload });

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
  const runFileSweep = (): void => {
    void sweepExpiredThreadFiles(resolveFilesRoot(getDataDir()), fileRetentionMs, Date.now())
      .then((result) => {
        if (result.removedFiles > 0 || result.removedDirs > 0) {
          console.log(
            `[fileSweep] removed ${result.removedFiles} expired files, ${result.removedDirs} empty dirs`,
          );
        }
      })
      .catch((e) => console.warn('[fileSweep] sweep failed:', e));
  };
  runFileSweep();
  const fileSweepInterval = setInterval(runFileSweep, fileSweepIntervalMs);
  fileSweepInterval.unref();

  // 6. Global catch — Telegraf swallows handler errors otherwise.
  bot.catch((err, ctx) => {
    if (checkIsStaleAnswerCallbackQueryError(err)) {
      console.debug('[bot.catch] stale answerCallbackQuery ignored:', ctx.updateType);
      return;
    }
    console.error('[bot.catch] unhandled error:', err, 'update:', ctx.updateType);
  });

  // 7. Shutdown — preserve active agents for restart/reattach. Use /stop
  //    or /stop-all for an intentional agent stop; process signals only
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
      cleanupTimers: () => {
        clearInterval(inMemoryGcInterval);
        clearInterval(heartbeatInterval);
        clearInterval(fileSweepInterval);
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
    await bot.launch({ dropPendingUpdates: bootMode.dropPendingUpdates });
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
