import { Telegraf, Context, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { storage } from './storage';
import { claudeManager } from './claudeManager';
import type { UserConfig } from './types';

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const allowedUsersEnv = process.env.ALLOWED_USERS;
const defaultWorkDir = process.env.WORK_DIR || '/workspace';

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

function checkIsAllowed(userId: number): boolean {
  return allowedUsers.includes(userId);
}

function checkIsPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === 'private';
}

function truncateOutput(text: string, maxLen: number = maxMessageLength): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen - 100);
  const lastNewline = truncated.lastIndexOf('\n');
  return (lastNewline > maxLen - 500 ? truncated.slice(0, lastNewline) : truncated)
    + '\n\n... (truncated)';
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
  const { options } = parseOutput(output);

  try {
    if (options.length >= 2 && options.length <= 6) {
      const buttons = options.map(opt =>
        Markup.button.callback(`${opt.num}. ${opt.label}`, `opt_${opt.num}`)
      );
      const keyboard = Markup.inlineKeyboard(buttons, { columns: 1 });
      await bot.telegram.sendMessage(userId, truncated, keyboard);
    } else {
      await bot.telegram.sendMessage(userId, truncated);
    }
  } catch (err) {
    console.error('[sendOutput error]', err);
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

  const userConfig = storage.getUser(ctx.from!.id);

  if (userConfig) {
    await ctx.reply(
      'Claude Bot\n\n' +
      `Work dir: ${userConfig.workDir}\n\n` +
      '/claude - Start Claude\n' +
      '/stop - Stop Claude\n' +
      '/setup - Change work directory\n' +
      '/status - Show status'
    );
  } else {
    await ctx.reply(
      'Claude Bot\n\n' +
      'Send /setup to configure work directory.\n' +
      `Or /claude to start with default: ${defaultWorkDir}`
    );
  }
});

bot.command('setup', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      'Usage: /setup <path>\n\n' +
      'Example:\n' +
      '/setup /workspace\n' +
      '/setup /home/user/projects/myapp'
    );
    return;
  }

  const workDir = args;

  const config: UserConfig = {
    userId,
    workDir,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  storage.saveUser(config);

  await ctx.reply(`Work directory set to: ${workDir}\n\n/claude to start`);
});

bot.command('status', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const userConfig = storage.getUser(userId);
  const isClaudeActive = claudeManager.checkIsActive(userId);

  let status = 'Status:\n\n';

  if (userConfig) {
    status += `Work dir: ${userConfig.workDir}\n`;
  } else {
    status += `Work dir: ${defaultWorkDir} (default)\n`;
  }

  status += `Claude: ${isClaudeActive ? 'running' : 'stopped'}`;

  await ctx.reply(status);
});

bot.command('claude', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;

  if (claudeManager.checkIsActive(userId)) {
    await ctx.reply('Claude already running. /stop to stop');
    return;
  }

  const userConfig = storage.getUser(userId);
  const workDir = userConfig?.workDir || defaultWorkDir;

  await ctx.reply(`Starting Claude in ${workDir}...`);

  try {
    await claudeManager.startSession(userId, workDir);
  } catch (err) {
    const error = err as Error;
    await ctx.reply(`Error: ${error.message}`);
  }
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
  claudeManager.sendSignal(userId, 'SIGINT');
  await ctx.reply('Ctrl+C sent');
});

bot.command('y', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  if (claudeManager.checkIsActive(userId)) {
    claudeManager.sendInput(userId, 'y');
  }
});

bot.command('n', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  if (claudeManager.checkIsActive(userId)) {
    claudeManager.sendInput(userId, 'n');
  }
});

bot.command('clear', async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;

  if (claudeManager.checkIsActive(userId)) {
    await claudeManager.stopSession(userId);
  }

  storage.deleteUser(userId);
  await ctx.reply('Configuration deleted');
});

bot.on(message('text'), async (ctx) => {
  if (!checkIsPrivateChat(ctx)) return;
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const text = ctx.message.text.trim();

  if (text.startsWith('/')) return;

  if (claudeManager.checkIsActive(userId)) {
    claudeManager.clearBuffer(userId);
    claudeManager.sendInput(userId, text);
    return;
  }

  await ctx.reply('Claude not running. /claude to start');
});

bot.action(/^opt_(\d+)$/, async (ctx) => {
  if (!checkIsAllowed(ctx.from!.id)) return;

  const userId = ctx.from!.id;
  const optNum = ctx.match[1];

  if (claudeManager.checkIsActive(userId)) {
    claudeManager.clearBuffer(userId);
    claudeManager.sendInput(userId, optNum);
    await ctx.answerCbQuery(`Sent: ${optNum}`);
  } else {
    await ctx.answerCbQuery('Claude not running');
  }
});

function handleClaudeOutput(userId: number, output: string): void {
  if (!output.trim()) return;
  sendOutput(userId, output).catch(err => {
    console.error('[Claude output error]', err);
  });
}

function handleClaudeClosed(userId: number): void {
  bot.telegram.sendMessage(userId, 'Claude session ended').catch(() => {
    // ignore
  });
}

function handleClaudeError(userId: number, err: Error): void {
  bot.telegram.sendMessage(userId, `Claude error: ${err.message}`).catch(() => {
    // ignore
  });
}

claudeManager.on('output', handleClaudeOutput);
claudeManager.on('closed', handleClaudeClosed);
claudeManager.on('error', handleClaudeError);

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
    storage.close();
    bot.stop(signal);
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await bot.launch();
  console.log('');
  console.log('Bot is running! Waiting for messages...');
  console.log('Press Ctrl+C to stop');
  console.log('');
}

export { bot };
