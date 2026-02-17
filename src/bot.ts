import { Telegraf, type Context, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import {
  getUserAdapter,
  getUserAdapterName,
  setUserAdapter,
  getAvailableAdapters,
  getDefaultAdapterName,
  registerAdapterEventHandlers,
} from './adapters/createAdapter';
import { withRateLimitRetry, checkIsRateLimited } from './rateLimiter';
import { stopOpenCodeServer, checkIsOpenCodeServerRunning, ensureOpenCodeServer } from './installManager';
import type { OpenCodePendingQuestion, OpenCodeQuestion } from './adapters/openCodeAdapter';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const allowedUsersEnv = process.env.ALLOWED_USERS;
const defaultWorkDir = process.env.WORK_DIR || '/workspace';
const openaiApiKey = process.env.OPENAI_API_KEY;
const groqApiKey = process.env.GROQ_API_KEY;

if (!botToken) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

if (!allowedUsersEnv) {
  console.error('ALLOWED_USERS is required for security');
  process.exit(1);
}

const allowedUsers = allowedUsersEnv.split(',').filter(Boolean).map(Number);

if (allowedUsers.length === 0) {
  console.error('ALLOWED_USERS must contain at least one user ID');
  process.exit(1);
}

const maxMessageLength = 4000;
const messageIdsFile = path.join(process.env.HOME || '/tmp', '.telegram-bot-messages.json');

const bot = new Telegraf(botToken);

interface UserMessageState {
  lastMessageId: number | null;
  needsNewMessage: boolean;
  messageIds: number[];
  loaderMessageId: number | null;
  /** ID of the current transient status message (tool calls, thinking) — edited in place, deleted on text output */
  statusMessageId: number | null;
}

interface StoredMessageIds {
  [userId: string]: number[];
}

/**
 * Output queue state per user.
 * Prevents race conditions when multiple outputs arrive faster than Telegram API can handle.
 * Uses debounce to batch rapid updates into single message edits.
 */
interface OutputQueueState {
  /** Pending output text waiting to be sent */
  pendingOutput: string | null;
  /** Whether queue is currently being processed */
  isProcessing: boolean;
  /** Debounce timer for batching rapid updates */
  debounceTimer: NodeJS.Timeout | null;
}

const userMessageStates = new Map<number, UserMessageState>();
const outputQueues = new Map<number, OutputQueueState>();

/**
 * Per-user pending question state.
 * When a question is shown to the user, we store it here so callback handlers
 * can look up the question data and send the answer back to the adapter.
 */
interface PendingQuestionState {
  /** The question data from the adapter */
  data: OpenCodePendingQuestion;
  /** Message ID of the question message in Telegram (for cleanup) */
  messageId: number | null;
}
const pendingQuestions = new Map<number, PendingQuestionState>();

/** Debounce delay in ms — increased to avoid Telegram 429 rate limits */
const outputDebounceMs = 1000;

function loadMessageIds(): void {
  try {
    if (fs.existsSync(messageIdsFile)) {
      const data = JSON.parse(fs.readFileSync(messageIdsFile, 'utf-8')) as StoredMessageIds;
      for (const [userIdStr, messageIds] of Object.entries(data)) {
        const userId = Number(userIdStr);
        const state = getUserMessageState(userId);
        state.messageIds = messageIds;
      }
      console.log(`[Bot] Loaded message IDs from ${messageIdsFile}`);
    }
  } catch (err) {
    console.error('[Bot] Failed to load message IDs:', err);
  }
}

function saveMessageIds(): void {
  try {
    const data: StoredMessageIds = {};
    for (const [userId, state] of userMessageStates.entries()) {
      if (state.messageIds.length > 0) {
        data[userId.toString()] = state.messageIds;
      }
    }
    fs.writeFileSync(messageIdsFile, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[Bot] Failed to save message IDs:', err);
  }
}

function getUserMessageState(userId: number): UserMessageState {
  let state = userMessageStates.get(userId);
  if (!state) {
    state = { lastMessageId: null, needsNewMessage: true, messageIds: [], loaderMessageId: null, statusMessageId: null };
    userMessageStates.set(userId, state);
  }
  return state;
}

function setLoaderMessage(userId: number, messageId: number): void {
  const state = getUserMessageState(userId);
  state.loaderMessageId = messageId;
}

async function deleteLoaderMessage(userId: number): Promise<void> {
  const state = getUserMessageState(userId);
  if (state.loaderMessageId) {
    try {
      await withRateLimitRetry(userId, () =>
        bot.telegram.deleteMessage(userId, state.loaderMessageId!)
      );
    } catch {
      // Message might already be deleted
    }
    state.loaderMessageId = null;
  }
}

function getOutputQueueState(userId: number): OutputQueueState {
  let state = outputQueues.get(userId);
  if (!state) {
    state = { pendingOutput: null, isProcessing: false, debounceTimer: null };
    outputQueues.set(userId, state);
  }
  return state;
}

function markNeedsNewMessage(userId: number): void {
  const state = getUserMessageState(userId);
  state.needsNewMessage = true;
}

function trackMessageId(userId: number, messageId: number): void {
  const state = getUserMessageState(userId);
  state.messageIds.push(messageId);
  if (state.messageIds.length > 500) {
    state.messageIds = state.messageIds.slice(-500);
  }
  saveMessageIds();
}

function checkIsAllowed(userId: number): boolean {
  return allowedUsers.includes(userId);
}

function checkIsPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === 'private';
}

/**
 * Split a long message into multiple chunks that fit within Telegram's 4096 char limit.
 * Tries to split on newline boundaries for cleaner output.
 */
function splitMessage(text: string, maxLen: number = maxMessageLength): string[] {
  if (text.length <= maxLen) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }

    // Try to cut at last newline within the limit
    let cutAt = maxLen;
    const lastNewline = remaining.lastIndexOf('\n', maxLen);
    if (lastNewline > maxLen * 0.5) {
      cutAt = lastNewline;
    }

    parts.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).replace(/^\n/, ''); // skip leading newline in next chunk
  }

  return parts;
}

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
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function transcribeAudio(filePath: string, retryCount = 0): Promise<string | null> {
  const apiKey = groqApiKey || openaiApiKey;
  const isGroq = !!groqApiKey;

  if (!apiKey) {
    console.log('[Bot] No GROQ_API_KEY or OPENAI_API_KEY, cannot transcribe voice');
    return null;
  }

  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('model', isGroq ? 'whisper-large-v3' : 'whisper-1');

  const hostname = isGroq ? 'api.groq.com' : 'api.openai.com';
  const apiPath = isGroq ? '/openai/v1/audio/transcriptions' : '/v1/audio/transcriptions';

  console.log(`[Bot] Transcribing with ${isGroq ? 'Groq' : 'OpenAI'}...`);

  return new Promise((resolve) => {
    const req = https.request({
      hostname,
      path: apiPath,
      method: 'POST',
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${apiKey}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', async () => {
        if (res.statusCode === 429) {
          const retryAfter = parseInt(res.headers['retry-after'] as string) || 5;
          console.log(`[Bot] Rate limited, retry after ${retryAfter}s (attempt ${retryCount + 1}/3)`);

          if (retryCount < 2) {
            await new Promise(r => setTimeout(r, retryAfter * 1000));
            const result = await transcribeAudio(filePath, retryCount + 1);
            resolve(result);
            return;
          } else {
            console.error('[Bot] Rate limit exceeded, max retries reached');
            resolve(null);
            return;
          }
        }

        try {
          const json = JSON.parse(data);
          if (json.text) {
            resolve(json.text);
          } else {
            console.error('[Bot] Whisper error:', json);
            resolve(null);
          }
        } catch (e) {
          console.error('[Bot] Whisper parse error:', e);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.error('[Bot] Whisper request error:', e);
      resolve(null);
    });

    form.pipe(req);
  });
}

function escapeMarkdownChars(text: string): string {
  return text
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/`/g, '\\`');
}

function escapeMarkdown(text: string): string {
  const boldRegex = /\*([^*\n]+)\*/g;
  const boldMatches: Array<{ start: number; end: number; content: string }> = [];

  let match;
  while ((match = boldRegex.exec(text)) !== null) {
    boldMatches.push({
      start: match.index,
      end: match.index + match[0].length,
      content: match[1]
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

  const remaining = text.slice(lastIndex);
  result += escapeMarkdownChars(remaining);

  return result;
}

interface ParsedOutput {
  text: string;
  options: Array<{ num: string; label: string }>;
}

function parseOutput(output: string): ParsedOutput {
  const options: Array<{ num: string; label: string }> = [];

  const optionRegex = /^\s*(\d+)[.)]\s*(.+)$/gm;
  let match;
  while ((match = optionRegex.exec(output)) !== null) {
    const label = match[2].trim().slice(0, 30);
    if (label.length > 0) {
      options.push({ num: match[1], label });
    }
  }

  return { text: output, options };
}

/**
 * Queue output for sending with debounce.
 * Multiple rapid outputs will be batched into single message updates.
 * Skips sending if user is currently rate-limited by Telegram.
 */
function queueOutput(userId: number, output: string): void {
  const queueState = getOutputQueueState(userId);

  queueState.pendingOutput = output;

  if (queueState.debounceTimer) {
    clearTimeout(queueState.debounceTimer);
  }

  // If rate-limited, use longer delay
  const delayMs = checkIsRateLimited(userId)
    ? Math.max(outputDebounceMs, 5000)
    : outputDebounceMs;

  queueState.debounceTimer = setTimeout(() => {
    queueState.debounceTimer = null;
    processOutputQueue(userId);
  }, delayMs);
}

/**
 * Process the output queue for a user.
 * Ensures sequential processing — only one send operation at a time.
 */
async function processOutputQueue(userId: number): Promise<void> {
  const queueState = getOutputQueueState(userId);

  if (queueState.isProcessing) return;
  if (!queueState.pendingOutput) return;

  queueState.isProcessing = true;

  try {
    const output = queueState.pendingOutput;
    queueState.pendingOutput = null;

    await sendOutputImmediate(userId, output);
  } finally {
    queueState.isProcessing = false;

    if (queueState.pendingOutput) {
      const delayMs = checkIsRateLimited(userId)
        ? Math.max(outputDebounceMs, 5000)
        : outputDebounceMs;
      setTimeout(() => processOutputQueue(userId), delayMs);
    }
  }
}

/**
 * Send a single chunk of text to the user, with Markdown fallback to plain text.
 * Returns the sent message ID.
 */
async function sendChunk(userId: number, text: string, parseMode: 'Markdown' | undefined): Promise<number | null> {
  try {
    const sent = await withRateLimitRetry(userId, () =>
      bot.telegram.sendMessage(userId, text, parseMode ? { parse_mode: parseMode } : {})
    );
    return (sent as { message_id: number }).message_id;
  } catch {
    if (parseMode) {
      // Markdown failed, retry as plain text
      try {
        const sent = await withRateLimitRetry(userId, () =>
          bot.telegram.sendMessage(userId, text)
        );
        return (sent as { message_id: number }).message_id;
      } catch (plainErr) {
        console.error('[sendChunk] Plain text also failed:', plainErr);
        return null;
      }
    }
    return null;
  }
}

/**
 * Immediately send output to user (internal function).
 * Splits long messages into multiple Telegram messages.
 * First chunk may edit the existing message; subsequent chunks are always new messages.
 */
async function sendOutputImmediate(userId: number, output: string): Promise<void> {
  await deleteLoaderMessage(userId);
  await deleteStatusMessage(userId);

  const chunks = splitMessage(output);
  const msgState = getUserMessageState(userId);
  const parseMode = 'Markdown' as const;

  const shouldSendNew = msgState.needsNewMessage || !msgState.lastMessageId;

  // --- First chunk: try editing existing message if possible ---
  const firstChunk = chunks[0];
  const firstEscaped = escapeMarkdown(firstChunk);

  if (shouldSendNew) {
    const msgId = await sendChunk(userId, firstEscaped, parseMode);
    if (msgId) {
      msgState.lastMessageId = msgId;
      msgState.needsNewMessage = false;
      trackMessageId(userId, msgId);
    }
  } else {
    const messageId = msgState.lastMessageId as number;
    try {
      await withRateLimitRetry(userId, () =>
        bot.telegram.editMessageText(userId, messageId, undefined, firstEscaped, { parse_mode: parseMode })
      );
    } catch (editErr: unknown) {
      const errMessage = editErr instanceof Error ? editErr.message : String(editErr);
      if (!errMessage.includes('message is not modified')) {
        // Edit failed — send as new message
        const msgId = await sendChunk(userId, firstEscaped, parseMode);
        if (msgId) {
          msgState.lastMessageId = msgId;
          msgState.needsNewMessage = false;
          trackMessageId(userId, msgId);
        }
      }
    }
  }

  // --- Remaining chunks: always send as new messages ---
  for (let i = 1; i < chunks.length; i++) {
    const escaped = escapeMarkdown(chunks[i]);
    const msgId = await sendChunk(userId, escaped, parseMode);
    if (msgId) {
      msgState.lastMessageId = msgId;
      msgState.needsNewMessage = false;
      trackMessageId(userId, msgId);
    }
  }
}

// ═══════════════════════════════════════════
//  Helper for sending replies with rate limit
// ═══════════════════════════════════════════

async function safeSendMessage(userId: number, text: string, extra?: object): Promise<number | null> {
  try {
    const msg = await withRateLimitRetry(userId, () =>
      bot.telegram.sendMessage(userId, text, extra)
    );
    return msg.message_id;
  } catch (err) {
    console.error('[Bot] safeSendMessage failed:', err);
    return null;
  }
}

// ═══════════════════════════════════════════
//  Commands
// ═══════════════════════════════════════════

bot.command('start', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) {
    await ctx.reply('This bot works only in private messages.');
    return;
  }

  if (!checkIsAllowed(ctx.from!.id)) {
    await ctx.reply('Access denied.');
    return;
  }

  const adapters = getAvailableAdapters();
  const adapterList = adapters.map(a => `• ${a.label} (/${a.name})`).join('\n');

  await ctx.reply(
    'AI Agent Bot\n\n' +
    `Work dir: ${defaultWorkDir}\n\n` +
    `Available agents:\n${adapterList}\n\n` +
    '/agent - Choose agent\n' +
    '/sessions - Previous sessions\n' +
    '/stop - Stop current agent\n' +
    '/status - Show status'
  );
});

bot.command('status', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const adapter = getUserAdapter(userId);
  const isActive = adapter.checkIsActive(userId);
  const adapterName = getUserAdapterName(userId);

  const status =
    `Status:\n\n` +
    `Agent: ${adapter.label} (${adapterName})\n` +
    `Work dir: ${defaultWorkDir}\n` +
    `Session: ${isActive ? 'running' : 'stopped'}`;

  await ctx.reply(status);
});

bot.command('claude', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  setUserAdapter(userId, 'claude');
  const adapter = getUserAdapter(userId);

  if (adapter.checkIsActive(userId)) {
    await ctx.reply('Claude session active. Send a message or /stop');
    return;
  }

  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const msg = await startAgentSession(userId, args || undefined);
  await ctx.reply(msg);
});

bot.command('opencode', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  setUserAdapter(userId, 'opencode');
  const adapter = getUserAdapter(userId);

  if (adapter.checkIsActive(userId)) {
    await ctx.reply('OpenCode session active. Send a message or /stop');
    return;
  }

  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const msg = await startAgentSession(userId, args || undefined);
  await ctx.reply(msg);
});

bot.command('oc', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  setUserAdapter(userId, 'opencode');
  const adapter = getUserAdapter(userId);

  if (adapter.checkIsActive(userId)) {
    await ctx.reply('OpenCode session active. Send a message or /stop');
    return;
  }

  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const msg = await startAgentSession(userId, args || undefined);
  await ctx.reply(msg);
});

/** Store model list for number-based selection */
const userModelLists = new Map<number, string[]>();
/** Track if user is awaiting model selection (after /model without args) */
const awaitingModelSelection = new Set<number>();

bot.command('model', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const adapter = getUserAdapter(userId);
  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();

  // If number provided, select from previous list
  if (/^\d+$/.test(args)) {
    const num = parseInt(args, 10);
    const modelList = userModelLists.get(userId);
    if (!modelList || num < 1 || num > modelList.length) {
      await ctx.reply('Invalid number. Use /model to see the list.');
      return;
    }
    const selectedModel = modelList[num - 1];
    if (!adapter.checkIsActive(userId)) {
      await ctx.reply('No active session. Start an agent first.');
      return;
    }
    if (adapter.setModel) {
      const error = await adapter.setModel(userId, selectedModel);
      if (error) {
        await ctx.reply(`Error: ${error}`);
      } else {
        await ctx.reply(`Model set to: ${selectedModel}`);
      }
    }
    return;
  }

  // If model name provided, set it directly
  if (args) {
    if (!adapter.checkIsActive(userId)) {
      await ctx.reply('No active session. Start an agent first.');
      return;
    }
    if (adapter.setModel) {
      const error = await adapter.setModel(userId, args);
      if (error) {
        await ctx.reply(`Error: ${error}`);
      } else {
        const currentModel = adapter.getCurrentModel?.(userId) || args;
        await ctx.reply(`Model set to: ${currentModel}`);
      }
    } else {
      await ctx.reply(`Model switching not supported for ${adapter.label}`);
    }
    return;
  }

  // No args — show numbered list of models
  const currentModel = adapter.getCurrentModel?.(userId) || 'default';
  
  // Get available models from adapter
  let models: string[] = [];
  if (adapter.getAvailableModels) {
    try {
      models = await adapter.getAvailableModels();
    } catch (e) {
      console.error('[Bot] Failed to get models:', e);
    }
  }

  if (models.length === 0) {
    await ctx.reply(
      `Current: ${currentModel}\n\nNo models available. Use /model <provider/model> to set manually.`
    );
    return;
  }

  // Store list for number selection
  userModelLists.set(userId, models);

  // Build numbered list grouped by provider
  const byProvider = groupModelsByProvider(models);
  let listText = `Current: ${currentModel}\n\n`;
  let num = 1;
  
  for (const [provider, providerModels] of byProvider) {
    listText += `📦 ${provider}:\n`;
    for (const model of providerModels) {
      const modelName = model.slice(provider.length + 1);
      listText += `  ${num}. ${modelName}\n`;
      num++;
    }
    listText += '\n';
  }
  
  listText += `Reply with number to select`;

  // Mark that we're waiting for model selection
  awaitingModelSelection.add(userId);
  
  await ctx.reply(listText);
});

bot.action(/^model_(.+)$/, async (ctx) => {
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const modelId = ctx.match[1];
  const adapter = getUserAdapter(userId);

  if (!adapter.checkIsActive(userId)) {
    await ctx.answerCbQuery('No active session');
    return;
  }

  if (adapter.setModel) {
    const error = await adapter.setModel(userId, modelId);
    if (error) {
      await ctx.answerCbQuery(`Error: ${error.slice(0, 50)}`);
      return;
    }
    const currentModel = adapter.getCurrentModel?.(userId) || modelId;
    await ctx.answerCbQuery(`Model: ${currentModel.split('/').pop() || currentModel}`);
    await safeSendMessage(userId, `Model switched to: ${currentModel}`);
  } else {
    await ctx.answerCbQuery(`Not supported for ${adapter.label}`);
  }
});

bot.command('agent', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const available = getAvailableAdapters();
  const currentName = getUserAdapterName(ctx.from!.id);

  const buttons = available.map(a => {
    const isCurrent = a.name === currentName;
    const label = isCurrent ? `${a.label} ✓` : a.label;
    return Markup.button.callback(label, `agent_${a.name}`);
  });

  await ctx.reply('Choose agent:', Markup.inlineKeyboard(buttons, { columns: 2 }));
});

bot.action(/^agent_(.+)$/, async (ctx) => {
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const adapterName = ctx.match[1];

  try {
    setUserAdapter(userId, adapterName);
    const adapter = getUserAdapter(userId);
    await ctx.answerCbQuery(`Switched to ${adapter.label}`);
    await safeSendMessage(userId, `Agent: ${adapter.label}\nSend a message or /${adapterName} to start`);
  } catch {
    await ctx.answerCbQuery('Unknown agent');
  }
});

bot.command('sessions', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const adapter = getUserAdapter(userId);

  try {
    const sessions = await adapter.getSessions(userId);

    if (sessions.length === 0) {
      await ctx.reply('No previous sessions');
      return;
    }

    const buttons = sessions.slice(0, 10).map(s => {
      const timeAgo = formatTimeAgo(s.updatedAt);
      const title = (s.title || s.id).slice(0, 40);
      return Markup.button.callback(`${title} (${timeAgo})`, `resume_${s.id.slice(0, 60)}`);
    });

    await ctx.reply(
      `Previous sessions (${adapter.label}):`,
      Markup.inlineKeyboard(buttons, { columns: 1 })
    );
  } catch (err) {
    console.error('[Bot] getSessions error:', err);
    await ctx.reply('Failed to load sessions');
  }
});

bot.action(/^resume_(.+)$/, async (ctx) => {
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const sessionId = ctx.match[1];
  const adapter = getUserAdapter(userId);

  markNeedsNewMessage(userId);
  await ctx.answerCbQuery('Resuming session...');
  try {
    await adapter.resumeSession(userId, sessionId);
    await safeSendMessage(userId, `Session resumed. Send your message:`);
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    await safeSendMessage(userId, `Failed to resume: ${errorMsg}`);
  }
});

bot.command('stop', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const adapter = getUserAdapter(userId);

  if (!adapter.checkIsActive(userId)) {
    await ctx.reply('No agent running');
    return;
  }

  adapter.stopSession(userId);
  await ctx.reply(`${adapter.label} stopped`);
});

bot.command('c', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const adapter = getUserAdapter(userId);
  markNeedsNewMessage(userId);
  adapter.sendSignal(userId, 'SIGINT');
  await ctx.reply('Ctrl+C sent');
});

bot.command('y', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const adapter = getUserAdapter(userId);
  if (adapter.checkIsActive(userId)) {
    markNeedsNewMessage(userId);
    adapter.sendInput(userId, 'y');
  }
});

bot.command('n', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const adapter = getUserAdapter(userId);
  if (adapter.checkIsActive(userId)) {
    markNeedsNewMessage(userId);
    adapter.sendInput(userId, 'n');
  }
});

bot.command('enter', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const adapter = getUserAdapter(userId);
  if (adapter.sendEnter) {
    markNeedsNewMessage(userId);
    adapter.sendEnter(userId);
  } else {
    await ctx.reply(`Not supported for ${adapter.label}`);
  }
});

bot.command('up', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const adapter = getUserAdapter(userId);
  if (adapter.sendArrow) {
    adapter.sendArrow(userId, 'Up');
  } else {
    await ctx.reply(`Not supported for ${adapter.label}`);
  }
});

bot.command('down', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const adapter = getUserAdapter(userId);
  if (adapter.sendArrow) {
    adapter.sendArrow(userId, 'Down');
  } else {
    await ctx.reply(`Not supported for ${adapter.label}`);
  }
});

bot.command('tab', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const adapter = getUserAdapter(userId);
  if (adapter.sendTab) {
    adapter.sendTab(userId);
  } else {
    await ctx.reply(`Not supported for ${adapter.label}`);
  }
});

bot.command('output', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const adapter = getUserAdapter(userId);

  if (!adapter.getFullOutput) {
    await ctx.reply(`Not supported for ${adapter.label}`);
    return;
  }

  const output = adapter.getFullOutput(userId, 500);

  if (!output) {
    await ctx.reply('Agent not running or no output');
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
    const msgId = await safeSendMessage(userId, chunk || '(empty)');
    if (msgId) trackMessageId(userId, msgId);
  }
});

bot.command('clear', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const state = getUserMessageState(userId);
  const currentMsgId = ctx.message.message_id;

  const allMsgIds = [...state.messageIds, currentMsgId];

  if (allMsgIds.length === 0) {
    await ctx.reply('No tracked messages to delete');
    return;
  }

  let totalDeleted = 0;
  const batchSize = 100;

  for (let i = 0; i < allMsgIds.length; i += batchSize) {
    const batch = allMsgIds.slice(i, i + batchSize);
    try {
      await withRateLimitRetry(userId, () =>
        bot.telegram.callApi('deleteMessages', {
          chat_id: userId,
          message_ids: batch,
        })
      );
      totalDeleted += batch.length;
    } catch {
      // Some messages might be too old (>48h) or already deleted
    }
  }

  state.messageIds = [];
  state.lastMessageId = null;
  state.needsNewMessage = true;
  saveMessageIds();

  console.log(`[Bot] Cleared ${totalDeleted}/${allMsgIds.length} messages for user ${userId}`);
});

// ═══════════════════════════════════════════
//  Start phrases (natural language triggers)
// ═══════════════════════════════════════════

const botCommands = new Set([
  'start', 'claude', 'opencode', 'oc', 'agent', 'sessions', 'model',
  'stop', 'status', 'c', 'y', 'n', 'enter', 'up', 'down', 'tab', 'output', 'clear',
]);

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

  // Check Claude phrases
  if (startClaudePhrases.includes(normalized)) {
    return { isMatch: true, adapterName: 'claude' };
  }

  // Check "claude <args>" pattern
  const claudeWithArgsMatch = normalized.match(/^(claude|клод|клауд|клоуд)\s+(.+)$/);
  if (claudeWithArgsMatch) {
    return { isMatch: true, adapterName: 'claude', args: claudeWithArgsMatch[2] };
  }

  // Check OpenCode phrases
  if (startOpencodePhrases.includes(normalized)) {
    return { isMatch: true, adapterName: 'opencode' };
  }

  // Check "opencode <args>" pattern
  const opencodeWithArgsMatch = normalized.match(/^(opencode|опенкод|open code|опен код)\s+(.+)$/);
  if (opencodeWithArgsMatch) {
    return { isMatch: true, adapterName: 'opencode', args: opencodeWithArgsMatch[2] };
  }

  return { isMatch: false };
}

async function startAgentSession(userId: number, args?: string): Promise<string> {
  markNeedsNewMessage(userId);
  const adapter = getUserAdapter(userId);
  try {
    await adapter.startSession(userId, defaultWorkDir, args);
    return `${adapter.label} ready in ${defaultWorkDir}${args ? ` (${args})` : ''}\nSend your message:`;
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    return `Failed to start ${adapter.label}: ${errorMsg}`;
  }
}

// ═══════════════════════════════════════════
//  Message handlers
// ═══════════════════════════════════════════

bot.on(message('text'), async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const text = ctx.message.text.trim();

  if (text.startsWith('/')) {
    const cmd = text.slice(1).split(' ')[0].split('@')[0].toLowerCase();
    if (botCommands.has(cmd)) {
      return;
    }
    // Otherwise pass to agent (e.g., /resume, /help, /compact, etc.)
  }

  trackMessageId(userId, ctx.message.message_id);

  const adapter = getUserAdapter(userId);

  // Check if this is a model selection number (after /model command)
  if (/^\d+$/.test(text) && awaitingModelSelection.has(userId)) {
    const num = parseInt(text, 10);
    const modelList = userModelLists.get(userId);
    awaitingModelSelection.delete(userId); // Clear awaiting state
    
    if (modelList && num >= 1 && num <= modelList.length) {
      const selectedModel = modelList[num - 1];
      if (adapter.setModel) {
        const error = await adapter.setModel(userId, selectedModel);
        if (error) {
          await ctx.reply(`Error: ${error}`);
        } else {
          await ctx.reply(`Model set to: ${selectedModel}`);
        }
        return;
      }
    } else {
      await ctx.reply(`Invalid number. Use /model to see the list.`);
      return;
    }
  }

  // Check for start phrases when no agent is running
  if (!adapter.checkIsActive(userId)) {
    const startMatch = checkIsStartAgentPhrase(text);
    if (startMatch.isMatch && startMatch.adapterName) {
      setUserAdapter(userId, startMatch.adapterName);
      const msg = await startAgentSession(userId, startMatch.args);
      await ctx.reply(msg);
      return;
    }
  }

  // If there's a pending question, treat text as a custom answer
  const pending = pendingQuestions.get(userId);
  if (pending && adapter.checkIsActive(userId) && adapter.answerQuestion) {
    // Use the typed text as answer for the first question
    const answers: string[][] = pending.data.questions.map(() => [text]);
    pendingQuestions.delete(userId);

    // Update question message to show the custom answer
    if (pending.messageId) {
      const q = pending.data.questions[0];
      const header = q?.header || q?.question || 'Question';
      try {
        await withRateLimitRetry(userId, () =>
          bot.telegram.editMessageText(
            userId, pending.messageId!, undefined,
            `✅ ${header}: ${text}`,
          )
        );
      } catch { /* ignore */ }
    }

    adapter.answerQuestion(userId, answers);
    markNeedsNewMessage(userId);
    return;
  }

  if (adapter.checkIsActive(userId)) {
    markNeedsNewMessage(userId);
    const processingMsg = await ctx.reply('⏳');
    trackMessageId(userId, processingMsg.message_id);
    setLoaderMessage(userId, processingMsg.message_id);
    adapter.sendInput(userId, text);
    return;
  }

  await ctx.reply(`No agent running. /agent to choose, /claude or /opencode to start`);
});

bot.on(message('voice'), async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  trackMessageId(userId, ctx.message.message_id);

  if (!groqApiKey && !openaiApiKey) {
    await ctx.reply('Voice messages require GROQ_API_KEY (free) or OPENAI_API_KEY');
    return;
  }

  try {
    const fileId = ctx.message.voice.file_id;
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

    const tempDir = '/tmp';
    const tempFile = path.join(tempDir, `voice_${userId}_${Date.now()}.ogg`);
    await downloadFile(fileUrl, tempFile);

    const transcript = await transcribeAudio(tempFile);

    fs.unlink(tempFile, () => {});

    if (!transcript) {
      await ctx.reply('Failed to transcribe voice message');
      return;
    }

    console.log(`[Bot] Voice transcribed: "${transcript}"`);

    const sentMsg = await ctx.reply(`🎤 ${transcript}`, { reply_parameters: { message_id: ctx.message.message_id } });
    trackMessageId(userId, sentMsg.message_id);

    const adapter = getUserAdapter(userId);

    // Check for start phrases when no agent is running
    if (!adapter.checkIsActive(userId)) {
      const startMatch = checkIsStartAgentPhrase(transcript);
      if (startMatch.isMatch && startMatch.adapterName) {
        setUserAdapter(userId, startMatch.adapterName);
        const msg = await startAgentSession(userId, startMatch.args);
        await ctx.reply(msg);
        return;
      }
    }

    if (!adapter.checkIsActive(userId)) {
      await ctx.reply('No agent running. /agent to choose, /claude or /opencode to start');
      return;
    }

    markNeedsNewMessage(userId);
    const processingMsg = await ctx.reply('⏳');
    trackMessageId(userId, processingMsg.message_id);
    setLoaderMessage(userId, processingMsg.message_id);
    adapter.sendInput(userId, transcript);
  } catch (err) {
    console.error('[Bot] Voice handling error:', err);
    await ctx.reply('Error processing voice message');
  }
});

bot.action(/^opt_(\d+)$/, async (ctx) => {
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const optNum = ctx.match[1];
  const adapter = getUserAdapter(userId);

  if (adapter.checkIsActive(userId)) {
    markNeedsNewMessage(userId);
    adapter.sendInput(userId, optNum);
    await ctx.answerCbQuery(`Sent: ${optNum}`);
  } else {
    await ctx.answerCbQuery('Agent not running');
  }
});

/**
 * Handle question answer callback: qa_{questionIndex}_{optionIndex}
 * questionIndex is the index within the questions array (usually 0).
 * optionIndex is the index of the selected option.
 */
bot.action(/^qa_(\d+)_(\d+)$/, async (ctx) => {
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const qIdx = parseInt(ctx.match[1], 10);
  const optIdx = parseInt(ctx.match[2], 10);

  const pending = pendingQuestions.get(userId);
  if (!pending) {
    await ctx.answerCbQuery('No pending question');
    return;
  }

  const question = pending.data.questions[qIdx];
  if (!question || !question.options[optIdx]) {
    await ctx.answerCbQuery('Invalid option');
    return;
  }

  const selectedLabel = question.options[optIdx].label;
  const adapter = getUserAdapter(userId);

  // Build answers array: one answer per question, default empty for unselected
  const answers: string[][] = pending.data.questions.map((_, i) => {
    if (i === qIdx) return [selectedLabel];
    return [''];
  });

  // Clean up: remove pending state and edit the question message to show selection
  pendingQuestions.delete(userId);

  try {
    if (pending.messageId) {
      await withRateLimitRetry(userId, () =>
        bot.telegram.editMessageText(
          userId, pending.messageId!, undefined,
          `✅ ${question.header || question.question}: ${selectedLabel}`,
        )
      );
    }
  } catch {
    // Ignore edit errors
  }

  if (adapter.answerQuestion) {
    adapter.answerQuestion(userId, answers);
    markNeedsNewMessage(userId);
  }

  await ctx.answerCbQuery(selectedLabel);
});

// ═══════════════════════════════════════════
//  Adapter event handlers
// ═══════════════════════════════════════════

/**
 * Delete the transient status message for a user (if any).
 * Called before sending a permanent text output so the chat stays clean.
 */
async function deleteStatusMessage(userId: number): Promise<void> {
  const state = getUserMessageState(userId);
  if (state.statusMessageId) {
    const msgId = state.statusMessageId;
    state.statusMessageId = null;
    try {
      await withRateLimitRetry(userId, () =>
        bot.telegram.deleteMessage(userId, msgId)
      );
    } catch {
      // Message might already be deleted or too old
    }
  }
}

function handleAgentOutput(userId: number, output: string): void {
  console.log(`[Bot] output (${output.length}): ${output.slice(0, 100)}...`);
  if (!output.trim()) return;

  // Delete transient status message before sending permanent text
  deleteStatusMessage(userId).then(() => {
    queueOutput(userId, output);
  });
}

/**
 * Handle transient status updates (tool calls, thinking, etc.).
 * If a status message already exists — edit it in place.
 * If not — send a new one and track its ID.
 * Long status texts are split into multiple messages.
 */
function handleAgentStatus(userId: number, status: string): void {
  if (!status.trim()) return;
  console.log(`[Bot] status: ${status.slice(0, 100)}`);

  const msgState = getUserMessageState(userId);

  // Also delete the loader message if it's still showing
  deleteLoaderMessage(userId).catch(() => {});

  const chunks = splitMessage(status);
  const parseMode = 'Markdown' as const;

  (async () => {
    try {
      // --- First chunk: edit existing status or send new ---
      const firstEscaped = escapeMarkdown(chunks[0]);

      if (msgState.statusMessageId) {
        try {
          await withRateLimitRetry(userId, () =>
            bot.telegram.editMessageText(
              userId, msgState.statusMessageId!, undefined,
              firstEscaped, { parse_mode: parseMode },
            )
          );
        } catch (editErr: unknown) {
          const errMessage = editErr instanceof Error ? editErr.message : String(editErr);
          if (!errMessage.includes('message is not modified')) {
            // Edit failed — send as new message instead
            msgState.statusMessageId = null;
            const msgId = await sendChunk(userId, firstEscaped, parseMode);
            if (msgId) {
              msgState.statusMessageId = msgId;
              trackMessageId(userId, msgId);
            }
          }
        }
      } else {
        const msgId = await sendChunk(userId, firstEscaped, parseMode);
        if (msgId) {
          msgState.statusMessageId = msgId;
          trackMessageId(userId, msgId);
        }
      }

      // --- Remaining chunks: send as new messages, update statusMessageId to last ---
      for (let i = 1; i < chunks.length; i++) {
        const escaped = escapeMarkdown(chunks[i]);
        const msgId = await sendChunk(userId, escaped, parseMode);
        if (msgId) {
          msgState.statusMessageId = msgId;
          trackMessageId(userId, msgId);
        }
      }
    } catch (err) {
      console.error('[handleAgentStatus] Failed:', err);
    }
  })();
}

/**
 * Handle interactive question from agent.
 * Shows question with inline buttons in Telegram.
 * Also supports custom text answers — user can type a reply.
 */
function handleAgentQuestion(userId: number, questionData: OpenCodePendingQuestion): void {
  console.log(`[Bot] question (${questionData.requestId}): ${questionData.questions.length} questions`);

  // Delete status/loader messages to make room for the question
  deleteStatusMessage(userId).catch(() => {});
  deleteLoaderMessage(userId).catch(() => {});

  (async () => {
    try {
      for (let qIdx = 0; qIdx < questionData.questions.length; qIdx++) {
        const q = questionData.questions[qIdx];
        const header = q.header || q.question || 'Question';

        // Build message text
        const lines: string[] = [`❓ *${escapeMarkdown(header)}*`];
        if (q.question && q.question !== header) {
          lines.push(escapeMarkdown(q.question));
        }

        // Build inline keyboard with options
        const buttons = q.options.map((opt, optIdx) => {
          const label = opt.label.length > 40 ? opt.label.slice(0, 37) + '...' : opt.label;
          return [Markup.button.callback(label, `qa_${qIdx}_${optIdx}`)];
        });

        const keyboard = buttons.length > 0
          ? Markup.inlineKeyboard(buttons)
          : undefined;

        const msgOpts: Record<string, unknown> = { parse_mode: 'Markdown' as const };
        if (keyboard) Object.assign(msgOpts, keyboard);

        let sent;
        try {
          sent = await withRateLimitRetry(userId, () =>
            bot.telegram.sendMessage(userId, lines.join('\n'), msgOpts as Parameters<typeof bot.telegram.sendMessage>[2])
          );
        } catch {
          // Markdown failed, try plain text
          const plainLines = [`❓ ${header}`];
          if (q.question && q.question !== header) plainLines.push(q.question);
          const plainOpts: Record<string, unknown> = {};
          if (keyboard) Object.assign(plainOpts, keyboard);
          sent = await withRateLimitRetry(userId, () =>
            bot.telegram.sendMessage(userId, plainLines.join('\n'), plainOpts as Parameters<typeof bot.telegram.sendMessage>[2])
          );
        }

        const sentMsg = sent as { message_id: number };
        trackMessageId(userId, sentMsg.message_id);

        // Store pending question so callbacks and text handler can find it
        pendingQuestions.set(userId, {
          data: questionData,
          messageId: sentMsg.message_id,
        });
      }
    } catch (err) {
      console.error('[handleAgentQuestion] Failed to send question:', err);
    }
  })();
}

function handleAgentClosed(userId: number): void {
  // Clean up status message and pending questions on session close
  deleteStatusMessage(userId).catch(() => {});
  pendingQuestions.delete(userId);
  const adapter = getUserAdapter(userId);
  safeSendMessage(userId, `${adapter.label} session ended`);
}

function handleAgentError(userId: number, error: Error): void {
  console.error(`[Bot] Agent error for user ${userId}:`, error.message);
  deleteStatusMessage(userId).catch(() => {});
  pendingQuestions.delete(userId);
  safeSendMessage(userId, `Error: ${error.message}`);
}

// ═══════════════════════════════════════════
//  Model selection utilities
// ═══════════════════════════════════════════

function groupModelsByProvider(models: string[]): Map<string, string[]> {
  const byProvider = new Map<string, string[]>();
  for (const model of models) {
    const slashIdx = model.indexOf('/');
    if (slashIdx > 0) {
      const provider = model.slice(0, slashIdx);
      if (!byProvider.has(provider)) {
        byProvider.set(provider, []);
      }
      byProvider.get(provider)!.push(model);
    }
  }
  return byProvider;
}

// ═══════════════════════════════════════════
//  Utilities
// ═══════════════════════════════════════════

function formatTimeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

// ═══════════════════════════════════════════
//  Bot startup
// ═══════════════════════════════════════════

export async function startBot(): Promise<void> {
  console.log('');
  console.log('=================================');
  console.log('  AI Agent Telegram Bot starting...');
  console.log('=================================');
  console.log(`Allowed users: ${allowedUsers.join(', ')}`);
  console.log(`Work dir: ${defaultWorkDir}`);
  console.log(`Default agent: ${getDefaultAdapterName()}`);
  console.log(`Available agents: ${getAvailableAdapters().map(a => a.name).join(', ')}`);

  // Wire adapter events to bot handlers
  registerAdapterEventHandlers({
    onOutput: handleAgentOutput,
    onStatus: handleAgentStatus,
    onQuestion: handleAgentQuestion,
    onClosed: handleAgentClosed,
    onError: handleAgentError,
  });

  loadMessageIds();

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    for (const userId of allowedUsers) {
      const adapter = getUserAdapter(userId);
      if (adapter.checkIsActive(userId)) {
        adapter.stopSession(userId);
      }
    }
    stopOpenCodeServer();
    bot.stop(signal);
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  console.log('Testing Telegram API connection...');
  try {
    const botInfo = await bot.telegram.getMe();
    console.log(`Bot info: @${botInfo.username} (${botInfo.id})`);

    await bot.telegram.setMyCommands([
      { command: 'claude', description: '▶️ Start Claude Code' },
      { command: 'opencode', description: '▶️ Start OpenCode' },
      { command: 'model', description: '🧠 Switch model' },
      { command: 'agent', description: '🔄 Choose agent' },
      { command: 'sessions', description: '📋 Previous sessions' },
      { command: 'stop', description: '⏹️ Stop agent' },
      { command: 'status', description: '📊 Show status' },
      { command: 'output', description: '📜 Last 500 lines' },
      { command: 'enter', description: '↵ Press Enter' },
      { command: 'up', description: '⬆️ Arrow Up' },
      { command: 'down', description: '⬇️ Arrow Down' },
      { command: 'tab', description: '⇥ Tab' },
      { command: 'y', description: '✅ Send "y"' },
      { command: 'n', description: '❌ Send "n"' },
      { command: 'c', description: '🛑 Ctrl+C' },
      { command: 'clear', description: '🗑️ Clear messages' },
    ]);
    console.log('Bot commands menu set');
  } catch (err) {
    console.error('Failed to connect to Telegram API:', err);
    throw err;
  }

  // Pre-start OpenCode server if opencode adapter is available
  if (getAvailableAdapters().some(a => a.name === 'opencode')) {
    try {
      console.log('[Boot] Pre-starting OpenCode server...');
      await ensureOpenCodeServer();
      
      // Diagnostic: fetch config to see what model OpenCode resolved
      const openCodeUrl = (process.env.OPENCODE_URL || 'http://localhost:4096').replace(/\/$/, '');
      const configResp = await fetch(`${openCodeUrl}/config`, { signal: AbortSignal.timeout(5000) });
      if (configResp.ok) {
        const config = await configResp.json() as Record<string, unknown>;
        const dm = config.defaultModel as { providerID?: string; modelID?: string } | undefined;
        console.log(`[Boot] OpenCode config.model: ${config.model || '(not set)'}`);
        console.log(`[Boot] OpenCode defaultModel: ${dm?.providerID && dm?.modelID ? `${dm.providerID}/${dm.modelID}` : '(not resolved)'}`);
      } else {
        console.log(`[Boot] OpenCode /config returned ${configResp.status}`);
      }
    } catch (e) {
      console.log(`[Boot] OpenCode pre-start failed:`, e instanceof Error ? e.message : e);
    }
  }

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

export { bot };
