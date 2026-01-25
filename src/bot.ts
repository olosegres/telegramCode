import { Telegraf, Context, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { claudeManager } from './claudeManager';
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

const bot = new Telegraf(botToken);

interface UserMessageState {
  lastMessageId: number | null;
  needsNewMessage: boolean;
  messageIds: number[];
}

const userMessageStates = new Map<number, UserMessageState>();

function getUserMessageState(userId: number): UserMessageState {
  let state = userMessageStates.get(userId);
  if (!state) {
    state = { lastMessageId: null, needsNewMessage: true, messageIds: [] };
    userMessageStates.set(userId, state);
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
  // Keep only last 100 messages to avoid memory issues
  if (state.messageIds.length > 100) {
    state.messageIds = state.messageIds.slice(-100);
  }
}

async function clearAllMessages(userId: number): Promise<number> {
  const state = getUserMessageState(userId);
  let deleted = 0;

  for (const msgId of state.messageIds) {
    try {
      await bot.telegram.deleteMessage(userId, msgId);
      deleted++;
    } catch {
      // Message might be too old or already deleted
    }
  }

  state.messageIds = [];
  state.lastMessageId = null;
  state.needsNewMessage = true;

  return deleted;
}

function checkIsAllowed(userId: number): boolean {
  return allowedUsers.includes(userId);
}

function checkIsPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === 'private';
}

function truncateOutput(text: string, maxLen: number = maxMessageLength): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen - 50);
  const lastNewline = truncated.lastIndexOf('\n');
  return lastNewline > maxLen - 300 ? truncated.slice(0, lastNewline) : truncated;
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
  // Prefer Groq (free), fallback to OpenAI
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
        // Handle rate limit (429)
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

function escapeMarkdown(text: string): string {
  // Escape markdown special characters except our intentional *bold* markers
  // Process character by character to handle bold markers properly
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
    // Escape the part before this bold marker
    const before = text.slice(lastIndex, m.start);
    result += before.replace(/_/g, '\\_').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    // Add bold marker with escaped content (but keep the * markers)
    const escapedContent = m.content.replace(/_/g, '\\_').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    result += `*${escapedContent}*`;
    lastIndex = m.end;
  }

  // Escape the remaining part
  const remaining = text.slice(lastIndex);
  result += remaining.replace(/_/g, '\\_').replace(/\[/g, '\\[').replace(/\]/g, '\\]');

  return result;
}

interface ParsedOutput {
  text: string;
  options: Array<{ num: string; label: string }>;
}

function parseOutput(output: string): ParsedOutput {
  const options: Array<{ num: string; label: string }> = [];

  const optionRegex = /^\s*(\d+)[.\)]\s*(.+)$/gm;
  let match;
  while ((match = optionRegex.exec(output)) !== null) {
    const label = match[2].trim().slice(0, 30);
    if (label.length > 0) {
      options.push({ num: match[1], label });
    }
  }

  return { text: output, options };
}

async function sendOutput(userId: number, output: string): Promise<void> {
  const truncated = truncateOutput(output);
  const escaped = escapeMarkdown(truncated);
  const { options } = parseOutput(output);
  const state = getUserMessageState(userId);

  try {
    const hasButtons = options.length >= 2 && options.length <= 6;

    const parseMode = 'Markdown' as const;

    if (state.needsNewMessage || !state.lastMessageId) {
      // Send new message
      let sentMessage;
      if (hasButtons) {
        const buttons = options.map(opt =>
          Markup.button.callback(`${opt.num}. ${opt.label}`, `opt_${opt.num}`)
        );
        const keyboard = Markup.inlineKeyboard(buttons, { columns: 1 });
        sentMessage = await bot.telegram.sendMessage(userId, escaped, { ...keyboard, parse_mode: parseMode });
      } else {
        sentMessage = await bot.telegram.sendMessage(userId, escaped, { parse_mode: parseMode });
      }
      state.lastMessageId = sentMessage.message_id;
      state.needsNewMessage = false;
      trackMessageId(userId, sentMessage.message_id);
    } else {
      // Try to edit existing message
      try {
        if (hasButtons) {
          const buttons = options.map(opt =>
            Markup.button.callback(`${opt.num}. ${opt.label}`, `opt_${opt.num}`)
          );
          const keyboard = Markup.inlineKeyboard(buttons, { columns: 1 });
          await bot.telegram.editMessageText(userId, state.lastMessageId, undefined, escaped, { ...keyboard, parse_mode: parseMode });
        } else {
          await bot.telegram.editMessageText(userId, state.lastMessageId, undefined, escaped, { parse_mode: parseMode });
        }
      } catch (editErr: unknown) {
        // If edit fails (message too old, deleted, or content unchanged), send new message
        const errMessage = editErr instanceof Error ? editErr.message : String(editErr);
        if (!errMessage.includes('message is not modified')) {
          console.log('[sendOutput] Edit failed, sending new message:', errMessage);
          const sentMessage = await bot.telegram.sendMessage(userId, escaped, { parse_mode: parseMode });
          state.lastMessageId = sentMessage.message_id;
          trackMessageId(userId, sentMessage.message_id);
        }
      }
    }
  } catch (err) {
    // Fallback: send without markdown if parsing fails
    console.error('[sendOutput] Markdown error, falling back to plain text:', err);
    try {
      const sentMessage = await bot.telegram.sendMessage(userId, truncated);
      state.lastMessageId = sentMessage.message_id;
      state.needsNewMessage = false;
      trackMessageId(userId, sentMessage.message_id);
    } catch (plainErr) {
      console.error('[sendOutput] Plain text also failed:', plainErr);
    }
  }
}

bot.command('start', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) {
    await ctx.reply('This bot works only in private messages.');
    return;
  }

  if (!checkIsAllowed(ctx.from!.id)) {
    await ctx.reply('Access denied.');
    return;
  }

  await ctx.reply(
    'Claude Bot\n\n' +
    `Work dir: ${defaultWorkDir}\n\n` +
    '/claude - Start Claude\n' +
    '/stop - Stop Claude\n' +
    '/status - Show status'
  );
});

bot.command('status', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const isClaudeActive = claudeManager.checkIsActive(userId);

  const status = `Status:\n\nWork dir: ${defaultWorkDir}\nClaude: ${isClaudeActive ? 'running' : 'stopped'}`;

  await ctx.reply(status);
});

bot.command('claude', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;

  if (claudeManager.checkIsActive(userId)) {
    await ctx.reply('Claude session active. Send a message or /stop to stop');
    return;
  }

  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const msg = await startClaudeSession(userId, args || undefined);
  await ctx.reply(msg);
});

bot.command('stop', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;

  if (!claudeManager.checkIsActive(userId)) {
    await ctx.reply('Claude not running');
    return;
  }

  await claudeManager.stopSession(userId);
  await ctx.reply('Claude stopped');
});

bot.command('c', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  markNeedsNewMessage(userId);
  claudeManager.sendSignal(userId, 'SIGINT');
  await ctx.reply('Ctrl+C sent');
});

bot.command('y', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  if (claudeManager.checkIsActive(userId)) {
    markNeedsNewMessage(userId);
    claudeManager.sendInput(userId, 'y');
  }
});

bot.command('n', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  if (claudeManager.checkIsActive(userId)) {
    markNeedsNewMessage(userId);
    claudeManager.sendInput(userId, 'n');
  }
});

bot.command('enter', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  if (claudeManager.checkIsActive(userId)) {
    markNeedsNewMessage(userId);
    claudeManager.sendEnter(userId);
  }
});

bot.command('up', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  if (claudeManager.checkIsActive(userId)) {
    claudeManager.sendArrow(userId, 'Up');
  }
});

bot.command('down', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  if (claudeManager.checkIsActive(userId)) {
    claudeManager.sendArrow(userId, 'Down');
  }
});

bot.command('tab', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  if (claudeManager.checkIsActive(userId)) {
    claudeManager.sendTab(userId);
  }
});

bot.command('output', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const output = claudeManager.getFullOutput(userId, 500);

  if (!output) {
    await ctx.reply('Claude not running or no output');
    return;
  }

  // Split into chunks if too long (Telegram limit ~4096)
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

  for (const chunk of chunks.slice(0, 5)) { // Max 5 messages
    const msg = await ctx.reply(chunk || '(empty)');
    trackMessageId(userId, msg.message_id);
  }
});

bot.command('clear', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const currentMsgId = ctx.message.message_id;

  // Build array of message IDs to delete (up to 1000 messages back)
  const maxMessages = 1000;
  const batchSize = 100; // Telegram limit per request
  let totalDeleted = 0;

  for (let start = currentMsgId; start > currentMsgId - maxMessages && start > 0; start -= batchSize) {
    const msgIds: number[] = [];
    for (let i = 0; i < batchSize && start - i > 0; i++) {
      msgIds.push(start - i);
    }

    try {
      await bot.telegram.callApi('deleteMessages', {
        chat_id: userId,
        message_ids: msgIds,
      });
      totalDeleted += msgIds.length;
    } catch {
      // Some messages might not exist or be too old
    }
  }

  // Reset message state
  const state = getUserMessageState(userId);
  state.messageIds = [];
  state.lastMessageId = null;
  state.needsNewMessage = true;

  console.log(`[Bot] Cleared ~${totalDeleted} messages for user ${userId}`);
});

const botCommands = new Set(['start', 'claude', 'stop', 'status', 'c', 'y', 'n', 'enter', 'up', 'down', 'tab', 'output', 'clear']);

const startClaudePhrases = [
  'клод', 'клауд', 'клоуд', 'claude', 'cloud',
  'запусти клод', 'запусти клода',
  'запусти клауд', 'запусти клауда',
  'запусти клоуд', 'запусти клоуда',
  'запусти claude', 'запусти cloud',
];

interface StartClaudeMatch {
  isMatch: boolean;
  args?: string;
}

function checkIsStartClaudePhrase(text: string): StartClaudeMatch {
  const normalized = text.toLowerCase().trim().replace(/[.,!?;:]+$/, '');

  // Exact match
  if (startClaudePhrases.includes(normalized)) {
    return { isMatch: true };
  }

  // Check for "claude <args>" pattern
  const claudeWithArgsMatch = normalized.match(/^(claude|клод|клауд|клоуд)\s+(.+)$/);
  if (claudeWithArgsMatch) {
    return { isMatch: true, args: claudeWithArgsMatch[2] };
  }

  return { isMatch: false };
}

async function startClaudeSession(userId: number, args?: string): Promise<string> {
  markNeedsNewMessage(userId);
  claudeManager.startSession(userId, defaultWorkDir, args);
  return `Claude ready in ${defaultWorkDir}${args ? ` (${args})` : ''}\nSend your message:`;
}

bot.on(message('text'), async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const text = ctx.message.text.trim();

  // Check if it's a bot command (skip those, they're handled by bot.command)
  if (text.startsWith('/')) {
    const cmd = text.slice(1).split(' ')[0].split('@')[0].toLowerCase();
    if (botCommands.has(cmd)) {
      return; // Let bot.command handle it
    }
    // Otherwise pass to Claude (e.g., /resume, /help, /compact, etc.)
  }

  // Track user's message
  trackMessageId(userId, ctx.message.message_id);

  // Check for start Claude phrases when Claude is not running
  const startMatch = checkIsStartClaudePhrase(text);
  if (!claudeManager.checkIsActive(userId) && startMatch.isMatch) {
    const msg = await startClaudeSession(userId, startMatch.args);
    await ctx.reply(msg);
    return;
  }

  if (claudeManager.checkIsActive(userId)) {
    markNeedsNewMessage(userId);
    const processingMsg = await ctx.reply('⏳');
    trackMessageId(userId, processingMsg.message_id);
    claudeManager.sendInput(userId, text);
    return;
  }

  await ctx.reply('Claude not running. /claude to start');
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
    // Get file info
    const fileId = ctx.message.voice.file_id;
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

    // Download to temp file
    const tempDir = '/tmp';
    const tempFile = path.join(tempDir, `voice_${userId}_${Date.now()}.ogg`);
    await downloadFile(fileUrl, tempFile);

    // Transcribe
    const transcript = await transcribeAudio(tempFile);

    // Clean up temp file
    fs.unlink(tempFile, () => {});

    if (!transcript) {
      await ctx.reply('Failed to transcribe voice message');
      return;
    }

    console.log(`[Bot] Voice transcribed: "${transcript}"`);

    // Send transcription to user
    const sentMsg = await ctx.reply(`🎤 ${transcript}`);
    trackMessageId(userId, sentMsg.message_id);

    // Check for start Claude phrases when Claude is not running
    const startMatch = checkIsStartClaudePhrase(transcript);
    if (!claudeManager.checkIsActive(userId) && startMatch.isMatch) {
      const msg = await startClaudeSession(userId, startMatch.args);
      await ctx.reply(msg);
      return;
    }

    if (!claudeManager.checkIsActive(userId)) {
      await ctx.reply('Claude not running. /claude to start');
      return;
    }

    // Send to Claude with processing indicator
    markNeedsNewMessage(userId);
    const processingMsg = await ctx.reply('⏳');
    trackMessageId(userId, processingMsg.message_id);
    claudeManager.sendInput(userId, transcript);
  } catch (err) {
    console.error('[Bot] Voice handling error:', err);
    await ctx.reply('Error processing voice message');
  }
});

bot.action(/^opt_(\d+)$/, async (ctx) => {
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const optNum = ctx.match[1];

  if (claudeManager.checkIsActive(userId)) {
    markNeedsNewMessage(userId);
    claudeManager.sendInput(userId, optNum);
    await ctx.answerCbQuery(`Sent: ${optNum}`);
  } else {
    await ctx.answerCbQuery('Claude not running');
  }
});

function handleClaudeOutput(userId: number, output: string): void {
  console.log(`[Bot] output (${output.length}): ${output.slice(0, 100)}...`);
  if (!output.trim()) return;

  sendOutput(userId, output).catch(err => {
    console.error('[Bot] sendOutput error:', err);
  });
}

function handleClaudeClosed(userId: number): void {
  bot.telegram.sendMessage(userId, 'Claude session ended').catch(() => {});
}

claudeManager.on('output', handleClaudeOutput);
claudeManager.on('closed', handleClaudeClosed);

export async function startBot(): Promise<void> {
  console.log('');
  console.log('=================================');
  console.log('  Telegram Claude Bot starting...');
  console.log('=================================');
  console.log(`Allowed users: ${allowedUsers.join(', ')}`);
  console.log(`Work dir: ${defaultWorkDir}`);

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    for (const userId of allowedUsers) {
      if (claudeManager.checkIsActive(userId)) {
        await claudeManager.stopSession(userId);
      }
    }
    bot.stop(signal);
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  console.log('Testing Telegram API connection...');
  try {
    const botInfo = await bot.telegram.getMe();
    console.log(`Bot info: @${botInfo.username} (${botInfo.id})`);

    // Set bot commands menu
    await bot.telegram.setMyCommands([
      { command: 'claude', description: '▶️ Start Claude' },
      { command: 'stop', description: '⏹️ Stop Claude' },
      { command: 'status', description: '📊 Show status' },
      { command: 'output', description: '📜 Last 500 lines' },
      { command: 'enter', description: '↵ Press Enter' },
      { command: 'up', description: '⬆️ Arrow Up' },
      { command: 'down', description: '⬇️ Arrow Down' },
      { command: 'tab', description: '⇥ Tab (autocomplete)' },
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
