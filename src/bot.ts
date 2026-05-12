import { Telegraf, Markup, type Context, type NarrowedContext } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Update, Message } from 'telegraf/typings/core/types/typegram';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

import {
  getAdapter,
  getThreadAdapter,
  getThreadAdapterName,
  setThreadAdapter,
  getAvailableAdapters,
  getDefaultAdapterName,
  registerAdapterEventHandlers,
} from './adapters/createAdapter';
import type { ThreadKey } from './types';
import { keyToString } from './types';
import { ClaudeCliAdapter } from './adapters/claudeCliAdapter';
import type { OpenCodePendingQuestion } from './adapters/openCodeAdapter';
import {
  enqueueSend,
  checkIsRateLimited,
} from './rateLimiter';
import {
  stopOpenCodeServer,
  ensureOpenCodeServer,
} from './installManager';
import { getStateStore, type StateStore } from './state';
import { t } from './i18n';
import { validateSubdir, BindError } from './validation';

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

  const allowedUsersEnv = process.env.ALLOWED_USERS ?? '';
  const allowedUsers = allowedUsersEnv
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(n => Number.isFinite(n));
  if (allowedUsers.length === 0) {
    // P3 fix from plan §16.3: empty list after filter would silently ban
    // everyone, which looks like a working bot that just never answers.
    errors.push('ALLOWED_USERS must contain at least one numeric user id');
  }

  const allowedGroupIdRaw = process.env.ALLOWED_GROUP_ID;
  const allowedGroupId = allowedGroupIdRaw ? Number(allowedGroupIdRaw) : NaN;
  if (!Number.isFinite(allowedGroupId)) {
    errors.push(
      'ALLOWED_GROUP_ID is required — set it to the negative chat id of your forum supergroup',
    );
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
    allowedUsers,
    allowedGroupId,
    workRoot: workRoot!,
    defaultAgent: process.env.DEFAULT_AGENT || 'claude',
    openaiApiKey: process.env.OPENAI_API_KEY,
    groqApiKey: process.env.GROQ_API_KEY,
  };
}

const ENV = parseEnv();
const bot = new Telegraf(ENV.botToken);

// ═══════════════════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description `message_thread_id` of the General forum topic. The Bot API
 * uses 1 for General; some clients omit `message_thread_id` entirely for
 * General messages. We normalise both forms to 1 in `getThreadKey()` so
 * routing is consistent (plan §4.3 point 3).
 */
const GENERAL_THREAD_ID = 1;

/** Telegram caps a message at 4096 chars; we leave headroom for markdown noise. */
const MAX_MESSAGE_LEN = 4000;

/** Debounce window for output batching. Telegram tolerates ~1 msg/sec/chat. */
const OUTPUT_DEBOUNCE_MS = 1000;

// ═══════════════════════════════════════════════════════════════════════════════
//  State store — singleton populated in startBot(), referenced by handlers
// ═══════════════════════════════════════════════════════════════════════════════

let state!: StateStore;

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
  /** True when next output should send a new message instead of editing. */
  needsNewMessage: boolean;
  /** Loader (⏳) message id — deleted when the first real output arrives. */
  loaderMessageId: number | null;
  /** Transient status/spinner message id — replaced by permanent text. */
  statusMessageId: number | null;
}

interface OutputQueueState {
  pendingOutput: string | null;
  isProcessing: boolean;
  debounceTimer: NodeJS.Timeout | null;
}

interface PendingQuestionState {
  data: OpenCodePendingQuestion;
  messageId: number | null;
}

const threadMessageStates = new Map<string, ThreadMessageState>();
const outputQueues = new Map<string, OutputQueueState>();
const pendingQuestions = new Map<string, PendingQuestionState>();
const threadModelLists = new Map<string, string[]>();
const awaitingModelSelection = new Set<string>();

function getThreadMessageState(key: ThreadKey): ThreadMessageState {
  const k = keyToString(key);
  let s = threadMessageStates.get(k);
  if (!s) {
    s = { lastMessageId: null, needsNewMessage: true, loaderMessageId: null, statusMessageId: null };
    threadMessageStates.set(k, s);
  }
  return s;
}

function getOutputQueueState(key: ThreadKey): OutputQueueState {
  const k = keyToString(key);
  let s = outputQueues.get(k);
  if (!s) {
    s = { pendingOutput: null, isProcessing: false, debounceTimer: null };
    outputQueues.set(k, s);
  }
  return s;
}

function markNeedsNewMessage(key: ThreadKey): void {
  getThreadMessageState(key).needsNewMessage = true;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Threading helpers — gating, key extraction
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Resolve a `ThreadKey` from a Telegram context, or `null` if
 * the message must be ignored.
 *
 * Plan §8 gating rules:
 *   1. Chat must be a forum supergroup (`type === 'supergroup'` AND `is_forum: true`).
 *   2. Chat id must match `ALLOWED_GROUP_ID`.
 *   3. If a `message_thread_id` is present, `is_topic_message` must be true
 *      — guards against plain reply-threads in non-forum supergroups, which
 *      also carry `message_thread_id` but are NOT topics (plan §4.3 point 2).
 *   4. `message_thread_id` absent → General topic, normalised to 1.
 */
function getThreadKey(ctx: Context): ThreadKey | null {
  const chat = ctx.chat;
  if (!chat || chat.type !== 'supergroup') return null;
  // The forum flag isn't on the union type for all chat shapes, but a
  // forum supergroup has it set.
  if (!('is_forum' in chat) || !chat.is_forum) return null;
  if (chat.id !== ENV.allowedGroupId) return null;

  // The message may come from either a fresh update or a callback query's
  // origin message — both carry `message_thread_id` on the same shape.
  const msg = (ctx.message ?? ctx.callbackQuery?.message) as Message | undefined;

  // Default: General topic (id 1) if the message has no explicit thread id.
  const rawThreadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined;
  const isTopicMessage = msg && 'is_topic_message' in msg ? msg.is_topic_message : undefined;

  // Plain reply-threads (non-forum supergroups) also carry message_thread_id.
  // Reject them: they're not topics, just reply nests.
  if (rawThreadId && !isTopicMessage) return null;

  const threadId = rawThreadId ?? GENERAL_THREAD_ID;
  return { chatId: chat.id, threadId };
}

/** Is this thread the General forum topic? */
function checkIsGeneral(key: ThreadKey): boolean {
  return key.threadId === GENERAL_THREAD_ID;
}

/**
 * @description Combined access check. Returns the `ThreadKey` if the
 * context is from an authorised user in the configured forum supergroup,
 * else `null`. Logs (but does not reply to) chats / users we don't accept
 * so foreign chats / spam stay silent (plan §13.13, D21).
 */
function authoriseContext(ctx: Context): ThreadKey | null {
  const userId = ctx.from?.id;
  if (!userId || !ENV.allowedUsers.includes(userId)) {
    if (ctx.chat) {
      console.warn(
        `[security] ignored update from chat ${ctx.chat.id} user ${userId ?? '?'} (not in ALLOWED_USERS)`,
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
  return key;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Send helpers — replyToThread + auto-track + error routing
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Classify Telegram API errors so we can surgically clean up
 * stale bindings without confusing closures with deletions (plan §13.10, E5).
 */
interface TelegramApiErrorLike {
  response?: { error_code?: number; description?: string };
  description?: string;
}

function checkIsApiError(e: unknown): e is TelegramApiErrorLike {
  return typeof e === 'object' && e !== null && (
    'response' in e || 'description' in e
  );
}

function getErrorDescription(e: TelegramApiErrorLike): string {
  return (e.response?.description ?? e.description ?? '').toString();
}

function getErrorCode(e: TelegramApiErrorLike): number | undefined {
  return e.response?.error_code;
}

/**
 * @description Central handler for failed sends.
 *
 * Differentiates between:
 *   - **thread-deleted** (400 "message thread not found") → wipe binding +
 *     in-memory state, kill any matching tmux session. Plan §13.10.
 *   - **topic-closed** (400 "TOPIC_CLOSED" / "topic is closed") → preserve
 *     binding (closures are reversible), mark `closed: true`, notify in
 *     General.
 *   - **perm-denied** (400 about permissions) → log + leave a hint.
 *   - **everything else** → log; no state mutation.
 */
async function handleSendError(key: ThreadKey, err: unknown): Promise<void> {
  if (!checkIsApiError(err)) {
    console.error(`[send] ${keyToString(key)} unknown error:`, err);
    return;
  }
  const code = getErrorCode(err);
  const desc = getErrorDescription(err);

  if (code === 400 && /thread not found/i.test(desc)) {
    console.log(`[gc] thread ${keyToString(key)} not found — removing binding`);
    await state.removeBinding(key);
    clearInMemoryThreadState(key);
    return;
  }
  if (code === 400 && /TOPIC_CLOSED|topic is closed/i.test(desc)) {
    console.log(`[skip] thread ${keyToString(key)} is closed — binding preserved`);
    await state.setBindingClosed(key, true);
    // Notify in General so user is not silent. Use low-level send (no
    // recursion through replyToThread, which would re-enter this handler).
    const generalKey: ThreadKey = { chatId: key.chatId, threadId: GENERAL_THREAD_ID };
    enqueueSend(key.chatId, () =>
      bot.telegram.sendMessage(
        key.chatId,
        t('error.tg.thread.closed', { key: keyToString(key) }),
        { message_thread_id: generalKey.threadId },
      ),
    ).catch(e2 => console.error('[send] failed to notify General about TOPIC_CLOSED:', e2));
    return;
  }
  console.error(
    `[send] ${keyToString(key)} ${code ?? '?'} ${desc || '(no description)'}`,
  );
}

/**
 * @description Drop all in-memory traces of a thread.
 *
 * Used after a `forum_topic_deleted` event or a 400-thread-not-found
 * cleanup. Does NOT touch state.json — caller already did or will.
 */
function clearInMemoryThreadState(key: ThreadKey): void {
  const k = keyToString(key);
  threadMessageStates.delete(k);
  outputQueues.delete(k);
  pendingQuestions.delete(k);
  threadModelLists.delete(k);
  awaitingModelSelection.delete(k);
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

async function replyToThread(
  key: ThreadKey,
  text: string,
  extra: SendExtra = {},
): Promise<number | null> {
  try {
    const sent = await enqueueSend(key.chatId, () =>
      bot.telegram.sendMessage(key.chatId, text, {
        message_thread_id: key.threadId,
        ...(extra as Record<string, unknown>),
      } as Parameters<typeof bot.telegram.sendMessage>[2]),
    );
    const messageId = (sent as { message_id: number }).message_id;
    await state.pushMessageId(key, messageId);
    return messageId;
  } catch (e) {
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
  try {
    await enqueueSend(key.chatId, () =>
      bot.telegram.editMessageText(
        key.chatId, messageId, undefined, text, extra as Parameters<typeof bot.telegram.editMessageText>[4],
      ),
    );
    return true;
  } catch (e) {
    const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
    if (/message is not modified/i.test(desc)) return true; // benign
    if (
      /thread not found|TOPIC_CLOSED|topic is closed/i.test(desc)
    ) {
      await handleSendError(key, e);
    } else {
      console.error(`[edit] ${keyToString(key)}#${messageId}:`, desc || e);
    }
    return false;
  }
}

async function deleteThreadMessage(key: ThreadKey, messageId: number): Promise<void> {
  try {
    await enqueueSend(key.chatId, () => bot.telegram.deleteMessage(key.chatId, messageId));
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
    await enqueueSend(key.chatId, () =>
      bot.telegram.sendChatAction(key.chatId, 'typing', { message_thread_id: key.threadId }),
    );
  } catch (e) {
    console.log(`[typing] ${keyToString(key)} failed:`, e instanceof Error ? e.message : e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Output rendering — split, escape, queued edits
// ═══════════════════════════════════════════════════════════════════════════════

function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    let cutAt = maxLen;
    const lastNewline = remaining.lastIndexOf('\n', maxLen);
    if (lastNewline > maxLen * 0.5) cutAt = lastNewline;
    parts.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).replace(/^\n/, '');
  }
  return parts;
}

function escapeMarkdownChars(text: string): string {
  return text
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/`/g, '\\`');
}

/**
 * @description Best-effort escape that preserves existing `*bold*` runs
 * while escaping incidental Markdown chars elsewhere. Same heuristic as
 * the legacy bot — Telegram's classic Markdown is loose enough that this
 * holds for the agent output we render.
 */
function escapeMarkdown(text: string): string {
  const boldRegex = /\*([^*\n]+)\*/g;
  const boldMatches: Array<{ start: number; end: number; content: string }> = [];

  let match;
  while ((match = boldRegex.exec(text)) !== null) {
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
 * Rapid stream of `output` events from the adapter coalesces into a single
 * Telegram message edit. During a 429 cooldown the delay stretches so we
 * don't keep hammering the API.
 */
function queueOutput(key: ThreadKey, output: string): void {
  const q = getOutputQueueState(key);
  q.pendingOutput = output;
  if (q.debounceTimer) clearTimeout(q.debounceTimer);
  const delayMs = checkIsRateLimited(key.chatId)
    ? Math.max(OUTPUT_DEBOUNCE_MS, 5000)
    : OUTPUT_DEBOUNCE_MS;
  q.debounceTimer = setTimeout(() => {
    q.debounceTimer = null;
    processOutputQueue(key);
  }, delayMs);
}

async function processOutputQueue(key: ThreadKey): Promise<void> {
  const q = getOutputQueueState(key);
  if (q.isProcessing || !q.pendingOutput) return;
  q.isProcessing = true;
  try {
    const out = q.pendingOutput;
    q.pendingOutput = null;
    await sendOutputImmediate(key, out);
  } finally {
    q.isProcessing = false;
    if (q.pendingOutput) {
      const delayMs = checkIsRateLimited(key.chatId)
        ? Math.max(OUTPUT_DEBOUNCE_MS, 5000)
        : OUTPUT_DEBOUNCE_MS;
      setTimeout(() => processOutputQueue(key), delayMs);
    }
  }
}

/**
 * @description Render `output` as the agent's permanent message in a
 * thread. Uses edit-in-place for the first chunk if we have a recent
 * editable message, otherwise sends new. Subsequent chunks always send new.
 *
 * On Markdown rejection by Telegram we fall back to plain text (`parse_mode`
 * unset) — the message lands either way.
 */
async function sendOutputImmediate(key: ThreadKey, output: string): Promise<void> {
  await deleteLoaderMessage(key);
  await deleteStatusMessage(key);

  const chunks = splitMessage(output);
  const msgState = getThreadMessageState(key);

  const sendOrEditFirst = async (text: string): Promise<number | null> => {
    const escaped = escapeMarkdown(text);
    const shouldSendNew = msgState.needsNewMessage || !msgState.lastMessageId;
    if (shouldSendNew) {
      const id = await replyChunkWithFallback(key, escaped, text);
      if (id) {
        msgState.lastMessageId = id;
        msgState.needsNewMessage = false;
      }
      return id;
    }
    // Try edit; on failure send new.
    const editedOk = await editThreadMessage(key, msgState.lastMessageId!, escaped, {
      parse_mode: 'Markdown',
    });
    if (editedOk) return msgState.lastMessageId;
    const id = await replyChunkWithFallback(key, escaped, text);
    if (id) {
      msgState.lastMessageId = id;
      msgState.needsNewMessage = false;
    }
    return id;
  };

  await sendOrEditFirst(chunks[0]);

  for (let i = 1; i < chunks.length; i++) {
    const escaped = escapeMarkdown(chunks[i]);
    const id = await replyChunkWithFallback(key, escaped, chunks[i]);
    if (id) {
      msgState.lastMessageId = id;
      msgState.needsNewMessage = false;
    }
  }
}

/**
 * @description Send a chunk with Markdown first; if Markdown is rejected,
 * fall back to plain text so the message reaches the user either way.
 */
async function replyChunkWithFallback(
  key: ThreadKey,
  escapedMarkdown: string,
  plainFallback: string,
): Promise<number | null> {
  const id = await replyToThread(key, escapedMarkdown, { parse_mode: 'Markdown' });
  if (id) return id;
  return replyToThread(key, plainFallback);
}

async function deleteLoaderMessage(key: ThreadKey): Promise<void> {
  const s = getThreadMessageState(key);
  if (s.loaderMessageId === null) return;
  const id = s.loaderMessageId;
  s.loaderMessageId = null;
  await deleteThreadMessage(key, id);
}

async function deleteStatusMessage(key: ThreadKey): Promise<void> {
  const s = getThreadMessageState(key);
  if (s.statusMessageId === null) return;
  const id = s.statusMessageId;
  s.statusMessageId = null;
  await deleteThreadMessage(key, id);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Voice download + transcribe
// ═══════════════════════════════════════════════════════════════════════════════

async function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const client = url.startsWith('https') ? https : http;
    client.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          file.close();
          fs.unlinkSync(destPath);
          downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
          return;
        }
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function transcribeAudio(filePath: string, retryCount = 0): Promise<string | null> {
  const apiKey = ENV.groqApiKey || ENV.openaiApiKey;
  const isGroq = !!ENV.groqApiKey;
  if (!apiKey) return null;

  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('model', isGroq ? 'whisper-large-v3' : 'whisper-1');

  const hostname = isGroq ? 'api.groq.com' : 'api.openai.com';
  const apiPath = isGroq ? '/openai/v1/audio/transcriptions' : '/v1/audio/transcriptions';

  return new Promise((resolve) => {
    const req = https.request({
      hostname, path: apiPath, method: 'POST',
      headers: { ...form.getHeaders(), 'Authorization': `Bearer ${apiKey}` },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', async () => {
        if (res.statusCode === 429) {
          const retryAfter = parseInt(res.headers['retry-after'] as string) || 5;
          if (retryCount < 2) {
            await new Promise(r => setTimeout(r, retryAfter * 1000));
            resolve(await transcribeAudio(filePath, retryCount + 1));
            return;
          }
          resolve(null);
          return;
        }
        try {
          const json = JSON.parse(data);
          resolve(json.text ?? null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    form.pipe(req);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Adapter lifecycle helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Resolve the working directory for an adapter session in
 * this thread.
 *
 * Этап 3 fallback: if the thread has a binding, use it; otherwise use
 * `WORK_ROOT` itself so a fresh install can smoke-test agents before any
 * `/bind` lands. Этап 4 adds `/bind` proper and may make the «no binding»
 * case error out depending on UX choices.
 */
function getWorkDir(key: ThreadKey): string {
  const binding = state.getBinding(key);
  if (binding) return path.join(ENV.workRoot, binding.subdir);
  return ENV.workRoot;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Subdir validation + discovery (plan §13.7 / T1)
// ═══════════════════════════════════════════════════════════════════════════════

// `validateSubdir` + `BindError` live in `src/validation.ts` so the
// security-critical bits can be unit-tested without booting Telegraf
// (plan §11 Этап 7, R3). The import at the top of this file pulls them in.

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
function listAvailableSubdirs(workRoot: string, limit = 50): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const skip = new Set(['node_modules', '.git', '.cache', '.idea', '.vscode']);
  const callbackPrefix = 'bind_';
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('__') && !skip.has(e.name))
    .map(e => e.name)
    .filter(name => Buffer.byteLength(callbackPrefix + name, 'utf8') <= 64)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit);
}

/**
 * @description Build a `subdir`-suggestion keyboard for `/bind` and for the
 * topic-creation welcome message. Two columns keeps the buttons readable on
 * mobile clients. Subdirs whose callback_data exceeds 64 bytes are already
 * filtered out upstream in `listAvailableSubdirs`.
 */
function buildBindKeyboard(subdirs: string[]) {
  const rows = [];
  for (let i = 0; i < subdirs.length; i += 2) {
    const row = [Markup.button.callback(`📁 ${subdirs[i]}`, `bind_${subdirs[i]}`)];
    if (subdirs[i + 1]) {
      row.push(Markup.button.callback(`📁 ${subdirs[i + 1]}`, `bind_${subdirs[i + 1]}`));
    }
    rows.push(row);
  }
  return Markup.inlineKeyboard(rows);
}

async function startAgentSession(key: ThreadKey, args?: string): Promise<string> {
  markNeedsNewMessage(key);
  const adapter = getThreadAdapter(key);
  const workDir = getWorkDir(key);

  // U1 from plan §10.2 / §16.3: typing indicator while the agent boots so
  // the user doesn't think the bot is asleep.
  sendThreadTypingIndicator(key).catch(() => {});

  try {
    await adapter.startSession(key, workDir, args);

    // If this adapter exposes a session id (Claude does, OpenCode handles
    // it server-side via resumeSession), persist it now so a bot restart
    // can re-attach without losing history (plan §13.1, D14).
    if (adapter instanceof ClaudeCliAdapter) {
      const uuid = adapter.getClaudeSessionId(key);
      if (uuid) await state.setClaudeSessionId(key, uuid);
    }
    await state.setAgent(key, { name: adapter.name });

    const subdir = state.getBinding(key)?.subdir ?? path.basename(ENV.workRoot);
    return t('agent.ready', {
      label: adapter.label,
      subdir,
      argsSuffix: args ? ` (${args})` : '',
    });
  } catch (e) {
    return t('agent.start_failed', {
      label: adapter.label,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Natural-language start phrases (`claude ...`, `opencode ...`)
// ═══════════════════════════════════════════════════════════════════════════════

const startClaudePhrases = [
  'клод', 'клауд', 'клоуд', 'claude', 'cloud',
  'запусти клод', 'запусти клода',
  'запусти клауд', 'запусти клауда',
  'запусти клоуд', 'запусти клоуда',
  'запусти claude', 'запусти cloud',
];

const startOpencodePhrases = [
  'opencode', 'опенкод', 'open code', 'опен код',
  'запусти opencode', 'запусти опенкод',
  'запусти open code', 'запусти опен код',
];

interface StartAgentMatch {
  isMatch: boolean;
  adapterName?: string;
  args?: string;
}

function checkIsStartAgentPhrase(text: string): StartAgentMatch {
  const normalized = text.toLowerCase().trim().replace(/[.,!?;:]+$/, '');
  if (startClaudePhrases.includes(normalized)) return { isMatch: true, adapterName: 'claude' };
  const claudeArgs = normalized.match(/^(claude|клод|клауд|клоуд)\s+(.+)$/);
  if (claudeArgs) return { isMatch: true, adapterName: 'claude', args: claudeArgs[2] };
  if (startOpencodePhrases.includes(normalized)) return { isMatch: true, adapterName: 'opencode' };
  const ocArgs = normalized.match(/^(opencode|опенкод|open code|опен код)\s+(.+)$/);
  if (ocArgs) return { isMatch: true, adapterName: 'opencode', args: ocArgs[2] };
  return { isMatch: false };
}

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
    const key = authoriseContext(ctx);
    if (!key) return;
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

async function applyBinding(key: ThreadKey, rawSubdir: string): Promise<ApplyBindingResult> {
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
  await state.setBinding(key, subdir);

  const message = peers.length > 0
    ? t('thread.bind_collision', {
        subdir,
        threads: peers.map(k => `\`${keyToString(k)}\``).join(', '),
      })
    : t('thread.bound', { subdir });
  return { ok: true, message, subdir };
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
    const subdirs = listAvailableSubdirs(ENV.workRoot);
    if (subdirs.length === 0) {
      await replyToThread(key, t('bind.usage'));
      return;
    }
    await replyToThread(key, t('bind.usage'), buildBindKeyboard(subdirs));
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
  // Stop any running session before discarding the binding so we don't leave
  // an orphan tmux/SSE stream pointing at a directory we no longer track.
  const adapter = getThreadAdapter(key);
  if (adapter.checkIsActive(key)) {
    try { adapter.stopSession(key); } catch (e) {
      console.warn(`[unbind] stopSession failed for ${keyToString(key)}:`, e);
    }
  }
  await state.removeBinding(key);
  clearInMemoryThreadState(key);
  await replyToThread(key, t('thread.unbound'));
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
//  /ls /list /new — General-scoped info & creation (plan §11 Этап 4)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Build the Telegram deeplink for a thread inside our private
 * supergroup. Format `https://t.me/c/<chatid_short>/<thread_id>/1` matches
 * what the official client uses; `chatid_short` is the chat id with the
 * `-100` supergroup prefix stripped.
 *
 * Telegram requires the trailing `/1` to land on the *first* message of the
 * topic; without it, clients sometimes open the chat root and lose context.
 */
function makeThreadDeeplink(chatId: number, threadId: number): string {
  const shortId = String(chatId).replace(/^-100/, '');
  return `https://t.me/c/${shortId}/${threadId}/1`;
}

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

command('new', async (ctx, key) => {
  if (!checkIsGeneral(key)) {
    await replyToThread(key, t('new.in_topic'));
    return;
  }
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  if (parts.length === 0) {
    await replyToThread(key, t('new.usage'));
    return;
  }
  const name = parts[0];
  // When `subdir` is omitted, fall back to the thread name — same logic as
  // `forum_topic_created` auto-bind, so `/new overview` and "create topic
  // named overview manually" produce identical state.
  const requestedSubdir = parts[1] ?? name;

  let topic: { message_thread_id: number };
  try {
    topic = await bot.telegram.createForumTopic(ENV.allowedGroupId, name);
  } catch (e) {
    const desc = checkIsApiError(e) ? getErrorDescription(e) : (e instanceof Error ? e.message : String(e));
    await replyToThread(key, t('new.failed', { error: desc }));
    return;
  }

  const newKey: ThreadKey = { chatId: ENV.allowedGroupId, threadId: topic.message_thread_id };
  const link = makeThreadDeeplink(newKey.chatId, newKey.threadId);

  // Try to auto-bind to the requested subdir. If that fails (folder missing,
  // path-traversal, etc.) we still keep the thread — user can /bind from
  // inside it — but the General reply tells them what happened.
  try {
    const subdir = validateSubdir(ENV.workRoot, requestedSubdir);
    await state.setBinding(newKey, subdir);
    await replyToThread(
      key,
      t('new.created', { name, threadId: newKey.threadId, subdir, link }),
      { parse_mode: 'Markdown' },
    );
    // Welcome inside the new thread mirrors `forum_topic_created` so the
    // user doesn't get a different experience based on creation path.
    await replyToThread(newKey, t('thread.welcome_bound', { subdir }));
    await sendBindingWelcome(newKey, subdir);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (parts.length >= 2) {
      // User explicitly named a subdir → tell them why bind failed.
      await replyToThread(key, t('new.bind_failed', { subdir: requestedSubdir, error }));
    } else {
      // Implicit subdir (= thread name) didn't match a folder; that's normal
      // for ad-hoc topic names, just point at /bind.
      await replyToThread(
        key,
        t('new.created_unbound', { name, threadId: newKey.threadId, link }),
        { parse_mode: 'Markdown' },
      );
    }
    const subdirs = listAvailableSubdirs(ENV.workRoot);
    const extra = subdirs.length > 0 ? buildBindKeyboard(subdirs) : undefined;
    await replyToThread(newKey, t('thread.welcome_pick'), extra);
  }
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
  const allowed = ENV.allowedUsers.includes(userId) && ctx.chat?.id === ENV.allowedGroupId;
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

command('help', async (_ctx, key) => {
  if (checkIsGeneral(key)) {
    await replyToThread(key, t('help.general'), { parse_mode: 'Markdown' });
    return;
  }
  const binding = state.getBinding(key);
  if (!binding) {
    const subdirs = listAvailableSubdirs(ENV.workRoot);
    const extra = subdirs.length > 0 ? buildBindKeyboard(subdirs) : undefined;
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
// flow — same handler the slash command calls into, so the picker source
// stays single-sourced.
bot.action('open_sessions', async (ctx) => {
  const key = authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery('Access denied'); return; }
  await ctx.answerCbQuery();
  // Cheapest UX without duplicating the /sessions picker: ask the user to
  // type /sessions, which opens the same flow. Refactoring the slash
  // handler into a reusable helper is Stage 7 polish.
  await replyToThread(key, t('sessions.run_hint'));
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
  try {
    const botId = bot.botInfo?.id ?? (await bot.telegram.getMe()).id;
    const member = await bot.telegram.getChatMember(ENV.allowedGroupId, botId);
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
    const extra = subdirs.length > 0 ? buildBindKeyboard(subdirs) : undefined;
    await replyToThread(key, t('thread.no_binding'), extra);
    return;
  }
  setThreadAdapter(key, adapterName);
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
    if (!adapter.checkIsActive(key)) {
      await replyToThread(key, 'No active session. Start an agent first.');
      return;
    }
    const selected = modelList[num - 1];
    if (adapter.setModel) {
      const err = await adapter.setModel(key, selected);
      await replyToThread(key, err ? `Error: ${err}` : `Model set to: ${selected}`);
    }
    return;
  }

  // direct «/model provider/name»
  if (args) {
    if (!adapter.checkIsActive(key)) {
      await replyToThread(key, 'No active session. Start an agent first.');
      return;
    }
    if (adapter.setModel) {
      const err = await adapter.setModel(key, args);
      if (err) {
        await replyToThread(key, `Error: ${err}`);
      } else {
        const current = adapter.getCurrentModel?.(key) || args;
        await replyToThread(key, `Model set to: ${current}`);
      }
    } else {
      await replyToThread(key, `Model switching not supported for ${adapter.label}`);
    }
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

command('agent', async (_ctx, key) => {
  const available = getAvailableAdapters();
  const currentName = getThreadAdapterName(key);
  const buttons = available.map(a => {
    const label = a.name === currentName ? `${a.label} ✓` : a.label;
    return Markup.button.callback(label, `agent_${a.name}`);
  });
  await replyToThread(key, 'Choose agent:', Markup.inlineKeyboard(buttons, { columns: 2 }));
});

command('sessions', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  try {
    const sessions = await adapter.getSessions(key);
    if (sessions.length === 0) {
      await replyToThread(key, 'No previous sessions');
      return;
    }
    const buttons = sessions.slice(0, 10).map(s => {
      const timeAgo = formatTimeAgo(s.updatedAt);
      const title = (s.title || s.id).slice(0, 40);
      return Markup.button.callback(`${title} (${timeAgo})`, `resume_${s.id.slice(0, 60)}`);
    });
    await replyToThread(
      key,
      `Previous sessions (${adapter.label}):`,
      Markup.inlineKeyboard(buttons, { columns: 1 }),
    );
  } catch (e) {
    console.error('[Bot] getSessions:', e);
    await replyToThread(key, 'Failed to load sessions');
  }
});

command('stop', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  if (!adapter.checkIsActive(key)) {
    await replyToThread(key, 'No agent running');
    return;
  }
  adapter.stopSession(key);
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
  for (const chunk of chunks.slice(0, 5)) {
    await replyToThread(key, chunk || '(empty)');
  }
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
command('clear', async (ctx, key) => {
  const trackedIds = state.getMessageIds(key);
  const currentMsgId = ctx.message.message_id;
  const all = [...trackedIds, currentMsgId];
  if (all.length === 0) {
    await replyToThread(key, t('clear.no_messages'));
    return;
  }

  let deleted = 0;
  const batchSize = 100;
  for (let i = 0; i < all.length; i += batchSize) {
    const batch = all.slice(i, i + batchSize);
    try {
      await enqueueSend(key.chatId, () =>
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
          await enqueueSend(key.chatId, () => bot.telegram.deleteMessage(key.chatId, id));
          deleted += 1;
        } catch {
          // Expired / already deleted — drop silently.
        }
      }
    }
  }

  await state.clearMessageIds(key);
  const ms = getThreadMessageState(key);
  ms.lastMessageId = null;
  ms.needsNewMessage = true;

  console.log(`[clear] ${keyToString(key)}: deleted ${deleted}/${all.length}`);
  await replyToThread(key, t('clear.summary', { deleted, total: all.length }));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Bot commands list (text vs slash) — known slash commands the bot handles
// ═══════════════════════════════════════════════════════════════════════════════

const botCommands = new Set([
  'start', 'claude', 'opencode', 'oc', 'agent', 'sessions', 'model',
  'stop', 'status', 'c', 'y', 'n', 'enter', 'up', 'down', 'tab', 'output', 'clear',
  'bind', 'unbind', 'where', 'ls', 'list', 'new', 'whoami', 'version', 'help',
  'doctor', 'mcp',
]);

// ═══════════════════════════════════════════════════════════════════════════════
//  Text message handler — main conversational entrypoint
// ═══════════════════════════════════════════════════════════════════════════════

bot.on(message('text'), async (ctx) => {
  const key = authoriseContext(ctx);
  if (!key) return;

  const text = ctx.message.text.trim();
  const kStr = keyToString(key);

  // Slash commands we don't own → forward to the agent (e.g. `/compact`, `/help`).
  if (text.startsWith('/')) {
    const cmd = text.slice(1).split(' ')[0].split('@')[0].toLowerCase();
    if (botCommands.has(cmd)) return;
  }

  // Always track inbound message ids so /clear can delete user messages too.
  await state.pushMessageId(key, ctx.message.message_id);

  const adapter = getThreadAdapter(key);

  // Numeric model selection after `/model`.
  if (/^\d+$/.test(text) && awaitingModelSelection.has(kStr)) {
    const num = parseInt(text, 10);
    const list = threadModelLists.get(kStr);
    awaitingModelSelection.delete(kStr);
    if (list && num >= 1 && num <= list.length) {
      const selected = list[num - 1];
      if (adapter.setModel) {
        const err = await adapter.setModel(key, selected);
        await replyToThread(key, err ? `Error: ${err}` : `Model set to: ${selected}`);
        return;
      }
    } else {
      await replyToThread(key, 'Invalid number. Run /model to see the list.');
      return;
    }
  }

  // Natural-language start.
  if (!adapter.checkIsActive(key)) {
    const startMatch = checkIsStartAgentPhrase(text);
    if (startMatch.isMatch && startMatch.adapterName) {
      if (checkIsGeneral(key)) {
        await replyToThread(key, t('error.start_in_general'));
        return;
      }
      // Plan §11 Этап 4: starting an agent without a binding would silently
      // launch it against WORK_ROOT itself. That's almost never what the
      // user wants, so refuse and offer the picker instead.
      if (!state.getBinding(key)) {
        const subdirs = listAvailableSubdirs(ENV.workRoot);
        const extra = subdirs.length > 0 ? buildBindKeyboard(subdirs) : undefined;
        await replyToThread(key, t('thread.no_binding'), extra);
        return;
      }
      setThreadAdapter(key, startMatch.adapterName);
      const msg = await startAgentSession(key, startMatch.args);
      await replyToThread(key, msg);
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

  // Forward text to a running agent.
  if (adapter.checkIsActive(key)) {
    markNeedsNewMessage(key);
    const loaderId = await replyToThread(key, '⏳');
    if (loaderId) getThreadMessageState(key).loaderMessageId = loaderId;
    adapter.sendInput(key, text);
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
    const extra = subdirs.length > 0 ? buildBindKeyboard(subdirs) : undefined;
    await replyToThread(key, t('thread.no_binding'), extra);
    return;
  }
  await replyToThread(key, t('thread.no_agent_with_binding', { subdir: binding.subdir }));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Voice message handler
// ═══════════════════════════════════════════════════════════════════════════════

bot.on(message('voice'), async (ctx) => {
  const key = authoriseContext(ctx);
  if (!key) return;

  await state.pushMessageId(key, ctx.message.message_id);

  if (!ENV.groqApiKey && !ENV.openaiApiKey) {
    await replyToThread(key, t('voice.no_api_key'));
    return;
  }

  try {
    const fileId = ctx.message.voice.file_id;
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${ENV.botToken}/${file.file_path}`;

    const tempDir = '/tmp';
    const tempFile = path.join(tempDir, `voice_${key.chatId}_${key.threadId}_${Date.now()}.ogg`);
    await downloadFile(fileUrl, tempFile);
    const transcript = await transcribeAudio(tempFile);
    fs.unlink(tempFile, () => {});

    if (!transcript) {
      await replyToThread(key, t('voice.failed'));
      return;
    }
    console.log(`[Bot] voice transcribed: "${transcript}"`);
    await replyToThread(key, t('voice.transcribed', { text: transcript }));

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
          const extra = subdirs.length > 0 ? buildBindKeyboard(subdirs) : undefined;
          await replyToThread(key, t('thread.no_binding'), extra);
          return;
        }
        setThreadAdapter(key, startMatch.adapterName);
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
        const extra = subdirs.length > 0 ? buildBindKeyboard(subdirs) : undefined;
        await replyToThread(key, t('thread.no_binding'), extra);
        return;
      }
      await replyToThread(key, t('thread.no_agent_with_binding', { subdir: binding.subdir }));
      return;
    }

    markNeedsNewMessage(key);
    const loaderId = await replyToThread(key, '⏳');
    if (loaderId) getThreadMessageState(key).loaderMessageId = loaderId;
    adapter.sendInput(key, transcript);
  } catch (err) {
    console.error('[Bot] Voice handling error:', err);
    await replyToThread(key, 'Error processing voice message');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Edited message — explicit UX hint instead of silent ignore
// ═══════════════════════════════════════════════════════════════════════════════

bot.on('edited_message', async (ctx) => {
  const key = authoriseContext(ctx);
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
  if (!chat || chat.id !== ENV.allowedGroupId) return;
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

  const subdirs = listAvailableSubdirs(ENV.workRoot);
  // NFC-normalised case-insensitive match — Telegram clients tend to send
  // the topic name verbatim, but case drift is common (`Overview` vs
  // `overview`). We normalise *both* sides because Linux filesystems happily
  // preserve NFD names from older macOS/rsync sources, and the topic name
  // from Telegram is always NFC. We auto-bind only on an exact
  // (case-insensitive) match to keep the rule predictable.
  const normalisedName = topicName.normalize('NFC').toLowerCase().trim();
  const match = subdirs.find(s => s.normalize('NFC').toLowerCase() === normalisedName);
  if (match) {
    try {
      const subdir = validateSubdir(ENV.workRoot, match);
      await state.setBinding(key, subdir);
      await replyToThread(key, t('thread.welcome_bound', { subdir }));
      await sendBindingWelcome(key, subdir);
      return;
    } catch (e) {
      console.warn(`[forum_topic_created] auto-bind failed for "${match}":`, e);
      // Fall through to picker.
    }
  }

  const extra = subdirs.length > 0 ? buildBindKeyboard(subdirs) : undefined;
  await replyToThread(key, t('thread.welcome_pick'), extra);
});

// Closed/reopened are generated by *any* group admin (close/reopen
// requires `can_manage_topics`), who may not be in ALLOWED_USERS. We gate
// only on group identity here so the binding's `closed` flag stays in
// sync with reality regardless of who flipped it. (Review HIGH #2.)
bot.on(message('forum_topic_closed'), async (ctx) => {
  const key = getThreadKey(ctx);
  if (!key) return;
  await state.setBindingClosed(key, true);
});

bot.on(message('forum_topic_reopened'), async (ctx) => {
  const key = getThreadKey(ctx);
  if (!key) return;
  await state.setBindingClosed(key, false);
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
bot.action(/^bind_(.+)$/, async (ctx) => {
  const key = authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery('Access denied'); return; }
  if (checkIsGeneral(key)) {
    await ctx.answerCbQuery('/bind only works in topical threads');
    return;
  }
  const subdir = ctx.match[1];
  await ctx.answerCbQuery(`Binding to ${subdir}…`);
  const result = await applyBinding(key, subdir);
  await replyToThread(key, result.message);
  if (result.ok) await sendBindingWelcome(key, result.subdir);
});

bot.action(/^model_(.+)$/, async (ctx) => {
  const key = authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery('Access denied'); return; }
  const modelId = ctx.match[1];
  const adapter = getThreadAdapter(key);
  if (!adapter.checkIsActive(key)) {
    await ctx.answerCbQuery('No active session');
    return;
  }
  if (adapter.setModel) {
    const err = await adapter.setModel(key, modelId);
    if (err) { await ctx.answerCbQuery(`Error: ${err.slice(0, 50)}`); return; }
    const current = adapter.getCurrentModel?.(key) || modelId;
    await ctx.answerCbQuery(`Model: ${current.split('/').pop() || current}`);
    await replyToThread(key, `Model switched to: ${current}`);
  } else {
    await ctx.answerCbQuery(`Not supported for ${adapter.label}`);
  }
});

bot.action(/^agent_(.+)$/, async (ctx) => {
  const key = authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery('Access denied'); return; }
  const adapterName = ctx.match[1];
  try {
    setThreadAdapter(key, adapterName);
    const adapter = getThreadAdapter(key);
    await ctx.answerCbQuery(`Switched to ${adapter.label}`);
    await replyToThread(
      key,
      `Agent: ${adapter.label}\nSend a message or /${adapterName} to start`,
    );
  } catch {
    await ctx.answerCbQuery('Unknown agent');
  }
});

bot.action(/^resume_(.+)$/, async (ctx) => {
  const key = authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery('Access denied'); return; }
  // Resume must respect the same binding invariant as every other start
  // path — otherwise picking an old session here would silently spawn an
  // adapter against WORK_ROOT itself (review HIGH #2).
  if (checkIsGeneral(key)) {
    await ctx.answerCbQuery('Resume only works in topical threads');
    return;
  }
  if (!state.getBinding(key)) {
    await ctx.answerCbQuery('Bind a folder first via /bind');
    const subdirs = listAvailableSubdirs(ENV.workRoot);
    const extra = subdirs.length > 0 ? buildBindKeyboard(subdirs) : undefined;
    await replyToThread(key, t('thread.no_binding'), extra);
    return;
  }
  const sessionId = ctx.match[1];
  const adapter = getThreadAdapter(key);
  markNeedsNewMessage(key);
  await ctx.answerCbQuery('Resuming session...');
  try {
    await adapter.resumeSession(key, getWorkDir(key), sessionId);
    await replyToThread(key, 'Session resumed. Send your message:');
  } catch (e) {
    await replyToThread(
      key,
      `Failed to resume: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
});

bot.action(/^opt_(\d+)$/, async (ctx) => {
  const key = authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery('Access denied'); return; }
  const optNum = ctx.match[1];
  const adapter = getThreadAdapter(key);
  if (adapter.checkIsActive(key)) {
    markNeedsNewMessage(key);
    adapter.sendInput(key, optNum);
    await ctx.answerCbQuery(`Sent: ${optNum}`);
  } else {
    await ctx.answerCbQuery('Agent not running');
  }
});

bot.action(/^qa_(\d+)_(\d+)$/, async (ctx) => {
  const key = authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery('Access denied'); return; }
  const qIdx = parseInt(ctx.match[1], 10);
  const optIdx = parseInt(ctx.match[2], 10);
  const kStr = keyToString(key);
  const pending = pendingQuestions.get(kStr);
  if (!pending) { await ctx.answerCbQuery('No pending question'); return; }
  const question = pending.data.questions[qIdx];
  if (!question || !question.options[optIdx]) {
    await ctx.answerCbQuery('Invalid option');
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

function handleAgentOutput(key: ThreadKey, output: string): void {
  console.log(`[Bot] output ${keyToString(key)} (${output.length}): ${output.slice(0, 100)}...`);
  if (!output.trim()) return;

  const msgState = getThreadMessageState(key);
  const hadStatusMessage = msgState.statusMessageId !== null;

  deleteStatusMessage(key).then(() => {
    if (hadStatusMessage) {
      const adapter = getThreadAdapter(key);
      if (adapter.outputsDeltas) msgState.needsNewMessage = true;
    }
    queueOutput(key, output);
  });
}

function handleAgentStatus(key: ThreadKey, status: string): void {
  if (!status.trim()) return;
  console.log(`[Bot] status ${keyToString(key)}: ${status.slice(0, 100)}`);

  const msgState = getThreadMessageState(key);
  deleteLoaderMessage(key).catch(() => {});

  const chunks = splitMessage(status);

  (async () => {
    try {
      const firstEscaped = escapeMarkdown(chunks[0]);
      if (msgState.statusMessageId) {
        const ok = await editThreadMessage(key, msgState.statusMessageId, firstEscaped, {
          parse_mode: 'Markdown',
        });
        if (!ok) {
          msgState.statusMessageId = null;
          const id = await replyChunkWithFallback(key, firstEscaped, chunks[0]);
          if (id) msgState.statusMessageId = id;
        }
      } else {
        const id = await replyChunkWithFallback(key, firstEscaped, chunks[0]);
        if (id) msgState.statusMessageId = id;
      }
      for (let i = 1; i < chunks.length; i++) {
        const escaped = escapeMarkdown(chunks[i]);
        const id = await replyChunkWithFallback(key, escaped, chunks[i]);
        if (id) msgState.statusMessageId = id;
      }
    } catch (err) {
      console.error('[handleAgentStatus] Failed:', err);
    }
  })();
}

function handleAgentQuestion(key: ThreadKey, questionData: OpenCodePendingQuestion): void {
  console.log(`[Bot] question ${keyToString(key)} (${questionData.requestId}): ${questionData.questions.length}`);
  deleteStatusMessage(key).catch(() => {});
  deleteLoaderMessage(key).catch(() => {});

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
          pendingQuestions.set(keyToString(key), {
            data: questionData,
            messageId,
          });
        }
      }
    } catch (err) {
      console.error('[handleAgentQuestion] Failed:', err);
    }
  })();
}

function handleAgentClosed(key: ThreadKey): void {
  deleteStatusMessage(key).catch(() => {});
  pendingQuestions.delete(keyToString(key));
  const adapter = getThreadAdapter(key);
  replyToThread(key, t('agent.session_ended', { label: adapter.label })).catch(() => {});
}

function handleAgentError(key: ThreadKey, error: Error): void {
  console.error(`[Bot] adapter error ${keyToString(key)}:`, error.message);
  deleteStatusMessage(key).catch(() => {});
  pendingQuestions.delete(keyToString(key));
  replyToThread(key, `Error: ${error.message}`).catch(() => {});
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
  { command: 'new', description: '🆕 Create a new thread (General)' },
  { command: 'mcp', description: '🔌 List active MCP servers' },
  { command: 'claude', description: '▶️ Start Claude Code' },
  { command: 'opencode', description: '▶️ Start OpenCode' },
  { command: 'model', description: '🧠 Switch model' },
  { command: 'agent', description: '🔄 Choose agent' },
  { command: 'sessions', description: '📋 Previous sessions' },
  { command: 'stop', description: '⏹ Stop agent' },
  { command: 'status', description: '📊 Show status' },
  { command: 'output', description: '📜 Last 500 lines' },
  { command: 'whoami', description: '🪪 Show debug ids' },
  { command: 'version', description: 'ℹ️ Versions of bot + CLI tools' },
  { command: 'enter', description: '↵ Press Enter' },
  { command: 'up', description: '⬆️ Arrow Up' },
  { command: 'down', description: '⬇️ Arrow Down' },
  { command: 'tab', description: '⇥ Tab' },
  { command: 'y', description: '✅ Send "y"' },
  { command: 'n', description: '❌ Send "n"' },
  { command: 'c', description: '🛑 Ctrl+C' },
  { command: 'clear', description: '🗑 Clear messages' },
];

/**
 * @description Re-adopt tmux sessions and OpenCode SSE streams that
 * outlived the bot process.
 *
 * Plan §10.2 / §13.19 (E1). Runs **before** `bot.launch()` so the first
 * user message in any thread already finds a live adapter session, not
 * a stale "agent not running" reply.
 */
async function reattachExistingSessions(): Promise<void> {
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
      for (const { key, sessionName } of found) {
        const binding = state.getBinding(key);
        const agent = state.getAgent(key);
        if (!binding || !agent || agent.name !== 'claude' || !agent.claudeSessionId) {
          claudeAdapter.killOrphanTmuxSession(sessionName);
          killed += 1;
          continue;
        }
        const workDir = path.join(ENV.workRoot, binding.subdir);
        if (claudeAdapter.adoptExistingTmuxSession(key, sessionName, workDir, agent.claudeSessionId)) {
          adopted += 1;
          replyToThread(key, t('agent.reattached')).catch(() => {});
        }
      }
      console.log(`[reattach] tmux: adopted ${adopted}, killed ${killed} orphans`);
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
      replyToThread(key, t('agent.reattached')).catch(() => {});
    } catch (e) {
      console.warn(`[reattach] opencode ${keyToString(key)} failed:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`[reattach] opencode: reopened ${reopened} sessions`);
}

export async function startBot(): Promise<void> {
  console.log('');
  console.log('=================================');
  console.log('  Telegram Code Bot (multi-thread) starting...');
  console.log('=================================');
  console.log(`Allowed users:    ${ENV.allowedUsers.join(', ')}`);
  console.log(`Allowed group:    ${ENV.allowedGroupId}`);
  console.log(`Work root:        ${ENV.workRoot}`);
  console.log(`Default agent:    ${getDefaultAdapterName()}`);
  console.log(`Available agents: ${getAvailableAdapters().map(a => a.name).join(', ')}`);

  // 1. State store.
  state = await getStateStore();
  console.log(`Data dir:         ${path.dirname(state.stateFilePath)}`);
  if (state.wasCorruptedOnLoad()) {
    console.warn(
      `[startup] previous state.json was corrupted; archived to ${state.getCorruptedArchivePath()}`,
    );
    // Best-effort notice into General once the bot is up.
    setImmediate(() => {
      const generalKey: ThreadKey = { chatId: ENV.allowedGroupId, threadId: GENERAL_THREAD_ID };
      replyToThread(generalKey, t('error.state.corrupted')).catch(() => {});
    });
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
    onError: handleAgentError,
  });

  // 3. Pre-start OpenCode server if available so first request is fast.
  if (getAvailableAdapters().some(a => a.name === 'opencode')) {
    try {
      console.log('[boot] pre-starting OpenCode server...');
      await ensureOpenCodeServer();
    } catch (e) {
      console.log('[boot] OpenCode pre-start failed:', e instanceof Error ? e.message : e);
    }
  }

  // 4. Re-attach sessions that survived the restart.
  await reattachExistingSessions();

  // 5. Connect to Telegram and register commands menu.
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

  // 6. Global catch — Telegraf swallows handler errors otherwise.
  bot.catch((err, ctx) => {
    console.error('[bot.catch] unhandled error:', err, 'update:', ctx.updateType);
  });

  // 7. Shutdown — stop active sessions, flush state, kill OpenCode server.
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    try {
      // Stop every active session by walking state bindings.
      for (const { key } of state.listBindings()) {
        const adapter = getThreadAdapter(key);
        if (adapter.checkIsActive(key)) {
          try { adapter.stopSession(key); } catch (e) {
            console.warn(`[shutdown] stop ${keyToString(key)} failed:`, e instanceof Error ? e.message : e);
          }
        }
      }
      await state.flush();
    } catch (e) {
      console.error('[shutdown] error during cleanup:', e);
    }
    stopOpenCodeServer();
    bot.stop(signal);
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // 8. Launch.
  console.log('Launching Telegraf bot (long polling)...');
  try {
    bot.launch({ dropPendingUpdates: true });
    console.log('');
    console.log('Bot is running! Waiting for messages...');
    console.log('Press Ctrl+C to stop');
    console.log('');
  } catch (err) {
    console.error('Failed to launch bot:', err);
    throw err;
  }
}
