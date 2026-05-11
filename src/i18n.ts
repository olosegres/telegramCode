/**
 * @description Lightweight i18n for the multi-thread bot.
 *
 * The previous bot mixed Russian and English user-facing strings ad-hoc.
 * The new bot has a single source of truth: a dictionary keyed by short
 * stable codes, with language picked via `BOT_LANG` (`ru` | `en`, default
 * `ru`). Plan §20.9.
 *
 * Design choices:
 *
 * 1. **Codes, not English-as-key.** `'thread.bound'` instead of
 *    `'📁 Bound to {subdir}'` so renames don't ripple through `t()` calls
 *    and so translators see semantic intent.
 * 2. **No external library.** A handful of strings and one fallback rule
 *    don't justify pulling in i18next. Easy to swap later.
 * 3. **`{placeholder}` substitution.** Single regex pass, escapes are
 *    handled by callers (we don't try to be markdown-aware).
 * 4. **English is the fallback** so missing translations degrade gracefully
 *    rather than echoing the code back to the user.
 *
 * Error templates (plan §20.7) are co-located here under the `error.*`
 * namespace and consumed via {@link errorMessage}, which is sugar over
 * `t()` plus button hints.
 */

type Lang = 'ru' | 'en';

/**
 * @description Dictionary of user-facing strings.
 *
 * Two-level structure: top key = lang, nested key = message code. We keep
 * the type permissive (`Record<string, string>`) so new codes can land
 * without touching a giant type — drift is caught by a runtime fallback
 * to English, not by TypeScript.
 */
const dict: Record<Lang, Record<string, string>> = {
  ru: {
    // ── access ──
    'access.denied': 'Доступ запрещён.',
    'access.group_only': 'Я работаю только в настроенной forum-супергруппе.',

    // ── bindings / threads ──
    'thread.no_binding':
      '📁 Этот тред не привязан к папке. Используй /bind <subdir> или выбери из списка.',
    'thread.bound': '📁 Привязано к `{subdir}`.\nЗапусти /claude или /opencode.',
    'thread.unbound': '📁 Привязка снята.',
    'thread.unbind_unbound': 'Тред и так не был привязан.',
    'thread.where_unbound': 'Тред не привязан к папке.',
    'thread.where_root':
      '📁 WORK_ROOT: `{workRoot}`\n📊 Привязок: {bindings}\n🟢 Активных сессий: {active}',
    'thread.where_bound': '📁 Папка: `{subdir}`\n🤖 Агент: {agent}\n🟢 Статус: {status}',
    'thread.general_no_agent':
      'General не привязан к папке — перейди в тематический тред для разговора с агентом.',
    'thread.welcome_bound':
      '👋 Тред создан и автоматически привязан к `{subdir}` (имя треда совпало с подпапкой).\nЗапусти /claude или /opencode.',
    'thread.welcome_pick':
      '👋 Тред создан. Привяжи папку: /bind <subdir>, или выбери из списка ниже.',
    'thread.bind_collision':
      '⚠️ Папка `{subdir}` уже используется в тредах: {threads}.\nПривязка добавлена; сессии независимы (свой tmux/SSE).',
    'thread.no_agent_with_binding':
      '📁 Папка `{subdir}` привязана. Запусти /claude или /opencode чтобы начать диалог.',

    // ── /bind validation errors ──
    'bind.usage': 'Использование: /bind <subdir>\nПример: /bind overview',
    'bind.in_general':
      '/bind работает только в тематических тредах, не в General.',
    'bind.invalid_chars': '❌ В имени папки запрещены управляющие символы.',
    'bind.not_found': '❌ Папка `{subdir}` не найдена в WORK_ROOT (`{workRoot}`).',
    'bind.outside_root': '❌ Путь выходит за пределы WORK_ROOT.',
    'bind.not_directory': '❌ `{subdir}` существует, но это не папка.',

    // ── /ls /list /new (General-scoped) ──
    'ls.header': '📁 Подпапки `{workRoot}`:',
    'ls.empty': '📁 В WORK_ROOT нет подходящих подпапок.',
    'list.header': '🧵 Привязки тредов ({count}):',
    'list.empty': '🧵 Привязок ещё нет. Создай тред и напиши /bind.',
    'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
    'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
    'new.in_topic': '/new можно только в General — открой General и попробуй ещё раз.',
    'new.usage':
      'Использование: /new <thread-name> [subdir]\nПример: /new ovr-feature overview',
    'new.created':
      '✅ Создан тред `{name}` (id {threadId}), привязан к `{subdir}`.\nПерейди: {link}',
    'new.created_unbound':
      '✅ Создан тред `{name}` (id {threadId}).\nПривяжи папку: /bind в самом треде.\nПерейди: {link}',
    'new.failed': '❌ Не удалось создать тред: {error}',
    'new.bind_failed':
      '⚠️ Тред создан, но автопривязка к `{subdir}` не удалась: {error}\nЗайди в тред и выполни /bind.',

    // ── /help context-aware ──
    'help.general':
      '*Команды в General:*\n' +
      '/ls — подпапки WORK_ROOT\n' +
      '/list — список тредов\n' +
      '/new <name> [subdir] — создать тред\n' +
      '/where — общая сводка\n' +
      '/status — статус всех тредов\n' +
      '/whoami /version — debug\n\n' +
      'Чтобы начать диалог с агентом — открой тематический тред.',
    'help.thread_unbound':
      '*Тред не привязан к папке.*\n' +
      '/bind <subdir> — привязать (или выбери в списке)\n' +
      '/where — показать состояние\n' +
      '/ls — подпапки WORK_ROOT (в General)',
    'help.thread_bound':
      '*Тред привязан к `{subdir}`.*\n' +
      '/claude /opencode — старт агента\n' +
      '/agent /model /sessions — выбор/переключение\n' +
      '/stop /status /output — контроль\n' +
      '/clear — удалить сообщения треда\n' +
      '/c /y /n /enter /up /down /tab — TUI-команды (Claude)\n' +
      '/where /unbind — управление binding',

    // ── /whoami /version /status (global) ──
    'whoami.report':
      '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
      '🔐 allowed: {allowed}\n📁 binding: {binding}',
    'whoami.binding_unbound': '(нет привязки)',
    'version.report':
      '*telegramCode {bot}*\n' +
      'Node: {node}\n' +
      'tmux: {tmux}\n' +
      'claude: {claude}\n' +
      'opencode: {opencode}',
    'version.unknown': '(недоступно)',
    'status.global_header': '📊 *Все треды* ({total}):',
    'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
    'status.global_empty': '📊 Тредов пока нет.',

    // ── agent lifecycle ──
    'agent.ready': '{label} готов в `{subdir}`{argsSuffix}\nОтправь сообщение:',
    'agent.no_session': 'Агент не запущен. /agent — выбрать, /claude или /opencode — старт.',
    'agent.session_ended': '{label}: сессия завершена',
    'agent.stopped': '{label} остановлен',
    'agent.already_active': '{label} уже работает в этом треде. Отправь сообщение или /stop.',
    'agent.starting': 'Запускаю {label} в `{subdir}`…',
    'agent.start_failed': 'Не удалось запустить {label}: {error}',
    'agent.reattached': '🔄 Бот перезапущен, сессия жива — продолжаем.',

    // ── /clear ──
    'clear.summary':
      '🗑 Удалено {deleted} сообщений из {total}. ' +
      'Telegram не отдаёт ничего старше 48 ч — остальные останутся в истории.',
    'clear.no_messages': 'Нет сообщений для удаления в этом треде.',

    // ── edited message UX hint ──
    'edited.hint':
      '✏️ Редактирование сообщений я не вижу как новый ввод — отправь правку отдельным сообщением.',

    // ── voice ──
    'voice.no_api_key':
      'Для голоса нужен GROQ_API_KEY (бесплатно) или OPENAI_API_KEY.',
    'voice.failed': 'Не удалось распознать голосовое.',
    'voice.transcribed': '🎤 {text}',

    // ── error codes ──
    'error.workdir.gone':
      '📁 Папка `{subdir}` исчезла с диска. Сделай /unbind или /bind <newdir>.',
    'error.tg.thread.deleted':
      '⚠️ Тред удалён в Telegram, binding очищен.',
    'error.tg.thread.closed':
      '🔒 Тред {key} закрыт — переоткрой его в клиенте Telegram, или удали полностью.',
    'error.tg.perm.delete':
      '🔐 Не могу удалить сообщения. Выдай право `can_delete_messages` админу бота.',
    'error.tg.perm.manage_topics':
      '🔐 Не хватает прав `can_manage_topics`. Сделай меня админом группы.',
    'error.state.corrupted':
      '⚠️ state.json был повреждён, привязки пересозданы. Повтори /bind где нужно.',
    'error.start_in_general':
      'Запускать агента в General нельзя — это служебный топик. Открой тематический тред.',
  },
  en: {
    'access.denied': 'Access denied.',
    'access.group_only': 'I only work in the configured forum supergroup.',

    'thread.no_binding':
      '📁 This thread is not bound to a folder. Use /bind <subdir> or pick from the list.',
    'thread.bound': '📁 Bound to `{subdir}`.\nRun /claude or /opencode.',
    'thread.unbound': '📁 Binding cleared.',
    'thread.unbind_unbound': 'Thread had no binding to clear.',
    'thread.where_unbound': 'Thread is not bound to a folder.',
    'thread.where_root':
      '📁 WORK_ROOT: `{workRoot}`\n📊 Bindings: {bindings}\n🟢 Active sessions: {active}',
    'thread.where_bound': '📁 Folder: `{subdir}`\n🤖 Agent: {agent}\n🟢 Status: {status}',
    'thread.general_no_agent':
      'General is not bound to a folder — switch to a topical thread to talk to an agent.',
    'thread.welcome_bound':
      '👋 Thread created and auto-bound to `{subdir}` (topic name matched a subfolder).\nRun /claude or /opencode.',
    'thread.welcome_pick':
      '👋 Thread created. Bind a folder: /bind <subdir>, or pick one below.',
    'thread.bind_collision':
      '⚠️ Folder `{subdir}` is already used by threads: {threads}.\nBinding added; sessions stay independent (own tmux/SSE).',
    'thread.no_agent_with_binding':
      '📁 Folder `{subdir}` is bound. Run /claude or /opencode to start the dialog.',

    // ── /bind validation errors ──
    'bind.usage': 'Usage: /bind <subdir>\nExample: /bind overview',
    'bind.in_general':
      '/bind only works in topical threads, not in General.',
    'bind.invalid_chars': '❌ Folder name must not contain control characters.',
    'bind.not_found': '❌ Folder `{subdir}` not found under WORK_ROOT (`{workRoot}`).',
    'bind.outside_root': '❌ Path escapes WORK_ROOT.',
    'bind.not_directory': '❌ `{subdir}` exists but is not a directory.',

    // ── /ls /list /new (General-scoped) ──
    'ls.header': '📁 Subfolders of `{workRoot}`:',
    'ls.empty': '📁 No bindable subfolders under WORK_ROOT.',
    'list.header': '🧵 Thread bindings ({count}):',
    'list.empty': '🧵 No bindings yet. Create a thread and run /bind.',
    'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
    'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
    'new.in_topic': '/new only works in General — switch back to General and try again.',
    'new.usage':
      'Usage: /new <thread-name> [subdir]\nExample: /new ovr-feature overview',
    'new.created':
      '✅ Created thread `{name}` (id {threadId}), bound to `{subdir}`.\nOpen: {link}',
    'new.created_unbound':
      '✅ Created thread `{name}` (id {threadId}).\nBind a folder: /bind inside that thread.\nOpen: {link}',
    'new.failed': '❌ Failed to create thread: {error}',
    'new.bind_failed':
      '⚠️ Thread created but auto-bind to `{subdir}` failed: {error}\nOpen the thread and run /bind.',

    // ── /help context-aware ──
    'help.general':
      '*Commands in General:*\n' +
      '/ls — list WORK_ROOT subfolders\n' +
      '/list — list threads\n' +
      '/new <name> [subdir] — create a thread\n' +
      '/where — global summary\n' +
      '/status — status of all threads\n' +
      '/whoami /version — debug\n\n' +
      'To talk to an agent — open a topical thread.',
    'help.thread_unbound':
      '*Thread is not bound to a folder.*\n' +
      '/bind <subdir> — bind (or pick from the list)\n' +
      '/where — show state\n' +
      '/ls — WORK_ROOT subfolders (in General)',
    'help.thread_bound':
      '*Thread bound to `{subdir}`.*\n' +
      '/claude /opencode — start an agent\n' +
      '/agent /model /sessions — choose/switch\n' +
      '/stop /status /output — control\n' +
      '/clear — delete thread messages\n' +
      '/c /y /n /enter /up /down /tab — TUI keys (Claude)\n' +
      '/where /unbind — manage binding',

    // ── /whoami /version /status (global) ──
    'whoami.report':
      '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
      '🔐 allowed: {allowed}\n📁 binding: {binding}',
    'whoami.binding_unbound': '(no binding)',
    'version.report':
      '*telegramCode {bot}*\n' +
      'Node: {node}\n' +
      'tmux: {tmux}\n' +
      'claude: {claude}\n' +
      'opencode: {opencode}',
    'version.unknown': '(unavailable)',
    'status.global_header': '📊 *All threads* ({total}):',
    'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
    'status.global_empty': '📊 No threads yet.',

    'agent.ready': '{label} ready in `{subdir}`{argsSuffix}\nSend a message:',
    'agent.no_session': 'No agent running. /agent to pick, /claude or /opencode to start.',
    'agent.session_ended': '{label}: session ended',
    'agent.stopped': '{label} stopped',
    'agent.already_active': '{label} is already running here. Send a message or /stop.',
    'agent.starting': 'Starting {label} in `{subdir}`…',
    'agent.start_failed': 'Failed to start {label}: {error}',
    'agent.reattached': '🔄 Bot restarted — session is still alive, continuing.',

    'clear.summary':
      '🗑 Deleted {deleted} of {total} messages. ' +
      'Telegram refuses to delete anything older than 48 h — the rest stays in history.',
    'clear.no_messages': 'No messages to delete in this thread.',

    'edited.hint':
      '✏️ I don\'t treat edited messages as new input — send the correction as a separate message.',

    'voice.no_api_key':
      'Voice requires GROQ_API_KEY (free) or OPENAI_API_KEY.',
    'voice.failed': 'Failed to transcribe voice message.',
    'voice.transcribed': '🎤 {text}',

    'error.workdir.gone':
      '📁 Folder `{subdir}` is gone from disk. Run /unbind or /bind <newdir>.',
    'error.tg.thread.deleted':
      '⚠️ Thread was deleted in Telegram; binding cleared.',
    'error.tg.thread.closed':
      '🔒 Thread {key} is closed — reopen it in your Telegram client, or delete it entirely.',
    'error.tg.perm.delete':
      '🔐 Can\'t delete messages. Grant the bot `can_delete_messages`.',
    'error.tg.perm.manage_topics':
      '🔐 Missing `can_manage_topics`. Make me a group admin.',
    'error.state.corrupted':
      '⚠️ state.json was corrupted; bindings reset. Re-run /bind where needed.',
    'error.start_in_general':
      'Can\'t start an agent in General — that\'s a service topic. Open a topical thread.',
  },
};

/** Active language, picked once at boot from `BOT_LANG`. */
const lang: Lang = (process.env.BOT_LANG === 'en' ? 'en' : 'ru');

/**
 * @description Format a localised message.
 *
 * `opts` values are substituted into `{name}` placeholders. Unknown codes
 * fall back to English; if the code is missing in English too, the code
 * itself is returned (loud failure mode — easier to spot in tests / logs
 * than a silently empty string).
 */
export function t(code: string, opts?: Record<string, string | number>): string {
  const primary = dict[lang][code];
  const fallback = dict.en[code];
  let template = primary ?? fallback ?? code;
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      template = template.replace(new RegExp(`\\{${k}\\}`, 'g'), v.toString());
    }
  }
  return template;
}

/**
 * @description Sugar for {@link t} that prefixes the code with `error.`
 * — purely cosmetic, makes call sites easier to read and grep for.
 */
export function errorMessage(code: string, opts?: Record<string, string | number>): string {
  return t(`error.${code}`, opts);
}

/** Exposed for tests + `/doctor` output ("language: ru"). */
export function getActiveLang(): Lang {
  return lang;
}
