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
    'thread.bind_required':
      '📁 Сначала привяжи папку: /bind <subdir>. Агент запускается только в привязанной папке.',
    'thread.bound': '📁 Привязано к `{subdir}`.\nЗапусти /claude или /opencode.',
    'thread.unbound': '📁 Привязка снята.',
    'thread.unbind_unbound': 'Тред и так не был привязан.',
    'thread.where_unbound': 'Тред не привязан к папке.',
    'thread.where_root':
      '📁 `WORK_ROOT`: `{workRoot}`\n📊 Привязок: {bindings}\n🟢 Активных сессий: {active}',
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
    'bind.current': '📂 Сейчас привязано: `{subdir}`',
    'bind.current_none': '📂 Пока не привязано',
    'bind.in_general':
      '/bind работает только в тематических тредах, не в General.',
    'bind.invalid_chars': '❌ В имени папки запрещены управляющие символы.',
    'bind.not_found': '❌ Папка `{subdir}` не найдена в `WORK_ROOT` (`{workRoot}`).',
    'bind.outside_root': '❌ Путь выходит за пределы `WORK_ROOT`.',
    'bind.not_directory': '❌ `{subdir}` существует, но это не папка.',

    // ── /ls /list /new (General-scoped) ──
    'ls.header': '📁 Подпапки `{workRoot}`:',
    'ls.empty': '📁 В `WORK_ROOT` нет подходящих подпапок.',
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
      '/ls — подпапки `WORK_ROOT`\n' +
      '/list — список тредов\n' +
      '/new <name> [subdir] — создать тред\n' +
      '/where — общая сводка\n' +
      '/status — статус всех тредов\n' +
      '/stopall — остановить все агенты\n' +
      '/whoami /version — debug\n\n' +
      'Чтобы начать диалог с агентом — открой тематический тред.',
    'help.thread_unbound':
      '*Тред не привязан к папке.*\n' +
      '/bind <subdir> — привязать (или выбери в списке)\n' +
      '/where — показать состояние\n' +
      '/ls — подпапки `WORK_ROOT` (в General)',
    'help.thread_bound':
      '*Тред привязан к `{subdir}`.*\n' +
      '/claude /opencode — старт агента\n' +
      '/agent /model /sessions — выбор/переключение\n' +
      '/effort — уровень reasoning effort\n' +
      '/stop /status /output — контроль\n' +
      '/compact — сжать контекст агента\n' +
      '/clear — удалить сообщения треда\n' +
      '/c /y /n /enter /up /down /tab — TUI-команды (Claude)\n' +
      '/where /unbind — управление binding',

    // ── /doctor self-diagnostics ──
    'doctor.header': '🔍 *Telegram Code Doctor*',
    'doctor.ok': '✅ {label}',
    'doctor.warn': '⚠️ {label} — {hint}',
    'doctor.fail': '❌ {label} — {hint}',
    'doctor.bot_admin': 'Бот — админ группы',
    'doctor.can_manage_topics': 'Право `can_manage_topics`',
    'doctor.can_delete_messages': 'Право `can_delete_messages`',
    'doctor.can_pin_messages': 'Право `can_pin_messages`',
    'doctor.privacy_off': 'Privacy mode выключен',
    'doctor.privacy_hint':
      '@BotFather → /setprivacy → Disable, потом удали и добавь бота заново',
    // NB: `WORK_ROOT` / `DATA_DIR` are wrapped in backticks below NOT for
    // typographical reasons but because raw `_` outside code spans is
    // parsed by Telegram Markdown as italic — and a stray opener in a
    // multi-line body silently corrupts the rest of the message. Same
    // pattern applies to any user-visible ALL_CAPS env var name.
    'doctor.workroot_subdirs':
      '`WORK_ROOT`: `{workRoot}` ({count} подпапок)',
    'doctor.datadir_path': '`DATA_DIR`: `{dataDir}`',
    'doctor.claude_installed': 'claude CLI установлен',
    'doctor.opencode_installed': 'opencode CLI установлен',
    'doctor.state_valid':
      'state.json валиден ({bindings} bindings, {active} активных)',
    'doctor.state_archived':
      'Прошлый state.json был повреждён, архив: {path}',
    'doctor.cli_missing':
      'не найдено в PATH (auto-install сработает при /claude или /opencode)',
    'doctor.no_admin_info':
      'не могу прочитать права бота — getChatMember failed',

    // ── auto-welcome when bot is added to group ──
    'onboarding.welcome':
      '👋 *Telegram Code Bot 2.0*\n\n' +
      'Готовность к работе:\n' +
      '1️⃣ Сделай меня админом группы с правами:\n' +
      '   • Manage Topics, Delete Messages, Pin Messages\n' +
      '2️⃣ @BotFather → /setprivacy → Disable, потом удали и добавь бота заново\n' +
      '3️⃣ Запусти /doctor — увижу проблемы сразу\n' +
      '4️⃣ В каждом тематическом треде сделай /bind <subdir> и запусти агента\n\n' +
      '`WORK_ROOT`: `{workRoot}`',

    // ── rich welcome после /bind (§20.5) ──
    'binding.welcome.header': '📁 Привязано к `{subdir}`',
    'binding.welcome.claude_md': '• CLAUDE.md: {size}',
    'binding.welcome.mcp_json': '• `.mcp.json`: {count} серверов',
    'binding.welcome.git': '• git: ветка `{branch}`{detail}',
    'binding.welcome.git_clean': ', чисто',
    'binding.welcome.git_dirty': ', изменения не закоммичены',
    'binding.welcome.git_none': '• git: не инициализирован',
    'binding.welcome.start_prompt': 'Начни диалог:',

    // ── /mcp read-only ──
    'mcp.header': '🔌 *MCP-серверы для этого треда:*',
    'mcp.row': '• `{name}` — {source}',
    'mcp.empty': '🔌 MCP-серверы не настроены.',
    'mcp.source_user': 'user (~/.claude/settings.json)',
    'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
    'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
    'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

    // ── extra hints ──
    'doctor.pin_hint': 'Pinned-статус треда (Этап 7) будет недоступен',

    // ── /whoami /version /status (global) ──
    'whoami.report':
      '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
      '🔐 allowed: {allowed}\n📁 binding: {binding}',
    'whoami.binding_unbound': '(нет привязки)',

    // ── pairing ──
    'pair.success': '✅ Группа привязана. id: `{groupId}`. Бот готов к работе в этой супергруппе.',
    'pair.locked':
      'ℹ️ id группы задан через `ALLOWED_GROUP_ID` — авто-привязка отключена. ' +
      'Чтобы сменить группу, измени переменную и перезапусти бота.',
    'pair.only_forum': '❌ /pair работает только в forum-супергруппе (включи Topics).',
    'pair.not_admin': '❌ Привязать бота может только администратор или создатель группы.',
    'pair.not_paired': 'группа ещё не привязана (режим pairing)',
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
    'agent.exit_signal_sent': 'Послан двойной Ctrl+C — {label} завершает работу',
    'agent.already_active': '{label} уже работает в этом треде. Отправь сообщение или /stop.',
    'agent.starting': 'Запускаю {label} в `{subdir}`…',
    'agent.queued_starting': '⏳ {label} ещё запускается — сообщение в очереди, отправлю как только будет готов.',
    'agent.question_hint': 'ℹ️ Ответь клавишами: /up /down — выбор, /enter — подтвердить, /y /n /c — быстрый ответ.',
    'agent.start_failed': 'Не удалось запустить {label}: {error}',
    'agent.reattached': '🔄 Бот перезапущен, сессия жива — продолжаем.',

    // ── /effort (reasoning effort) ──
    'effort.choose': '⚙️ Текущий effort: {current}\nВыбери уровень:',
    'effort.current_none': 'не задан',
    'effort.set_success': '✅ Effort: {level}',
    'effort.invalid_level': '⚠️ Уровень `{level}` недопустим. Доступные: {valid}.',
    'effort.not_available': 'ℹ️ Для текущей модели уровни reasoning effort недоступны.',
    'effort.not_supported': 'ℹ️ Модель `{model}` не поддерживает уровни reasoning effort.',
    'effort.start_agent_first': 'ℹ️ Уровень сохранён. Агент не запущен — применю при следующем старте.',
    'effort.cleared_on_model_switch': 'ℹ️ Effort `{level}` сброшен: новая модель `{model}` его не поддерживает.',
    'effort.unsupported_backend': 'Управление effort не поддерживается для {label}.',
    'effort.no_session': 'Агент не запущен. Сначала /claude или /opencode.',

    // ── /model (model selection) ──
    'model.saved_for_next_start': 'Модель сохранена: {model} — применится при старте агента.',
    'model.start_agent_first': 'Нет активной сессии. Сначала запусти агента.',

    // ── /stop-all ──
    'stop_all.none_active': 'Нет активных агентов — нечего останавливать.',
    'stop_all.summary': '🛑 Остановлено {stopped} из {total} активных агентов.',
    'stop_all.general_only': 'Команда `/stop-all` доступна только в General-топике.',

    // ── /clear_messages ──
    'clearMessages.summary':
      '🗑 Удалено {deleted} сообщений из {total}. ' +
      'Telegram не отдаёт ничего старше 48 ч — остальные останутся в истории.',
    'clearMessages.no_messages': 'Нет сообщений для удаления в этом треде.',

    // ── edited message UX hint ──
    'edited.hint':
      '✏️ Редактирование сообщений я не вижу как новый ввод — отправь правку отдельным сообщением.',

    // ── voice ──
    'voice.no_api_key':
      'Для голоса нужен `GROQ_API_KEY` (бесплатно) или `OPENAI_API_KEY`.',
    'voice.failed': 'Не удалось распознать голосовое.',
    'voice.transcribed': '🎤 {text}',

    // ── file intake ──
    'file.too_big':
      '📎 Файл больше лимита Bot API ({cap} МБ) — скачать его я не могу. Пришли файл поменьше.',
    'file.download_failed': '📎 Не удалось скачать файл. Попробуй ещё раз.',

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

    // Inline-keyboard answer-callback strings (audit S18 / #45).
    // Telegram caps answerCbQuery at ~200 chars; keep them short.
    'cb.access_denied': 'Доступ запрещён',
    'cb.bind_only_topical': '/bind работает только в тематических тредах',
    'cb.binding_to': 'Привязываю к {subdir}…',
    'cb.no_active_session': 'Нет активной сессии',
    'cb.model_error': 'Ошибка: {error}',
    'cb.model_set': 'Модель: {model}',
    'cb.not_supported': 'Не поддерживается для {label}',
    'cb.unknown_agent': 'Неизвестный агент',
    'cb.agent_switched': 'Переключено на {label}',
    'cb.resume_only_topical': 'Resume работает только в тематических тредах',
    'cb.bind_folder_first': 'Сначала привяжи папку через /bind',
    'cb.agent_not_running': 'Агент не запущен',
    'cb.no_pending_question': 'Нет ожидающего вопроса',
    'cb.invalid_option': 'Некорректный вариант',
    'cb.sent_option': 'Отправлено: {option}',
    'cb.effort_set': 'Effort: {level}',
    'cb.effort_error': 'Ошибка: {error}',

    // ── session picker (/sessions, /resume). {label}=агент, {max}=кол-во, {error}=причина ──
    'session.list_header': 'Сессии для возобновления ({label}):',
    'session.list_footer': 'Отправьте 1–{max} чтобы возобновить · 0 или /cancel для выхода',
    'session.none': 'Нет сессий для возобновления в этой папке.',
    'session.cancelled': 'Отменено. Выбор сессии закрыт.',
    'session.cancel_noop': 'Нечего отменять — выбор сессии не активен.',
    'session.invalid': 'Неверный номер. Введите число от 1 до {max}.',
    'session.resumed': 'Сессия возобновлена. Отправьте сообщение:',
    'session.resume_failed': 'Не удалось возобновить сессию: {error}',
    'session.expired': 'Список сессий устарел. Запустите /sessions заново.',
    'session.load_failed': 'Не удалось загрузить список сессий.',

    // ── resume context block (last {count} turns shown on resume) ──
    'resume.context_header': '↩️ Возобновлено — последние {count} сообщений:',
    'resume.context_user_label': '👤',
    'resume.context_assistant_label': '🤖',
  },
  en: {
    'access.denied': 'Access denied.',
    'access.group_only': 'I only work in the configured forum supergroup.',

    'thread.no_binding':
      '📁 This thread is not bound to a folder. Use /bind <subdir> or pick from the list.',
    'thread.bind_required':
      '📁 Bind a folder first: /bind <subdir>. The agent only ever runs inside the bound folder.',
    'thread.bound': '📁 Bound to `{subdir}`.\nRun /claude or /opencode.',
    'thread.unbound': '📁 Binding cleared.',
    'thread.unbind_unbound': 'Thread had no binding to clear.',
    'thread.where_unbound': 'Thread is not bound to a folder.',
    'thread.where_root':
      '📁 `WORK_ROOT`: `{workRoot}`\n📊 Bindings: {bindings}\n🟢 Active sessions: {active}',
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
    'bind.current': '📂 Currently bound: `{subdir}`',
    'bind.current_none': '📂 Not bound yet',
    'bind.in_general':
      '/bind only works in topical threads, not in General.',
    'bind.invalid_chars': '❌ Folder name must not contain control characters.',
    'bind.not_found': '❌ Folder `{subdir}` not found under `WORK_ROOT` (`{workRoot}`).',
    'bind.outside_root': '❌ Path escapes `WORK_ROOT`.',
    'bind.not_directory': '❌ `{subdir}` exists but is not a directory.',

    // ── /ls /list /new (General-scoped) ──
    'ls.header': '📁 Subfolders of `{workRoot}`:',
    'ls.empty': '📁 No bindable subfolders under `WORK_ROOT`.',
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
      '/ls — list `WORK_ROOT` subfolders\n' +
      '/list — list threads\n' +
      '/new <name> [subdir] — create a thread\n' +
      '/where — global summary\n' +
      '/status — status of all threads\n' +
      '/stopall — stop every running agent\n' +
      '/whoami /version — debug\n\n' +
      'To talk to an agent — open a topical thread.',
    'help.thread_unbound':
      '*Thread is not bound to a folder.*\n' +
      '/bind <subdir> — bind (or pick from the list)\n' +
      '/where — show state\n' +
      '/ls — `WORK_ROOT` subfolders (in General)',
    'help.thread_bound':
      '*Thread bound to `{subdir}`.*\n' +
      '/claude /opencode — start an agent\n' +
      '/agent /model /sessions — choose/switch\n' +
      '/effort — reasoning-effort level\n' +
      '/stop /status /output — control\n' +
      '/compact — compact agent context\n' +
      '/clear — delete thread messages\n' +
      '/c /y /n /enter /up /down /tab — TUI keys (Claude)\n' +
      '/where /unbind — manage binding',

    // ── /doctor self-diagnostics ──
    'doctor.header': '🔍 *Telegram Code Doctor*',
    'doctor.ok': '✅ {label}',
    'doctor.warn': '⚠️ {label} — {hint}',
    'doctor.fail': '❌ {label} — {hint}',
    'doctor.bot_admin': 'Bot is a group admin',
    'doctor.can_manage_topics': '`can_manage_topics` granted',
    'doctor.can_delete_messages': '`can_delete_messages` granted',
    'doctor.can_pin_messages': '`can_pin_messages` granted',
    'doctor.privacy_off': 'Privacy mode disabled',
    'doctor.privacy_hint':
      '@BotFather → /setprivacy → Disable, then remove and re-add the bot',
    'doctor.workroot_subdirs':
      '`WORK_ROOT`: `{workRoot}` ({count} subfolders)',
    'doctor.datadir_path': '`DATA_DIR`: `{dataDir}`',
    'doctor.claude_installed': 'claude CLI installed',
    'doctor.opencode_installed': 'opencode CLI installed',
    'doctor.state_valid':
      'state.json valid ({bindings} bindings, {active} active)',
    'doctor.state_archived':
      'previous state.json was corrupted, archive: {path}',
    'doctor.cli_missing':
      'not found in PATH (auto-install will run on /claude or /opencode)',
    'doctor.no_admin_info':
      'cannot read bot rights — getChatMember failed',

    // ── auto-welcome when bot is added to group ──
    'onboarding.welcome':
      '👋 *Telegram Code Bot 2.0*\n\n' +
      'Ready-to-work checklist:\n' +
      '1️⃣ Make me a group admin with rights:\n' +
      '   • Manage Topics, Delete Messages, Pin Messages\n' +
      '2️⃣ @BotFather → /setprivacy → Disable, then remove and re-add me\n' +
      '3️⃣ Run /doctor to see what is still missing\n' +
      '4️⃣ In each topical thread run /bind <subdir> and start an agent\n\n' +
      '`WORK_ROOT`: `{workRoot}`',

    // ── rich welcome after /bind (§20.5) ──
    'binding.welcome.header': '📁 Bound to `{subdir}`',
    'binding.welcome.claude_md': '• CLAUDE.md: {size}',
    'binding.welcome.mcp_json': '• `.mcp.json`: {count} servers',
    'binding.welcome.git': '• git: branch `{branch}`{detail}',
    'binding.welcome.git_clean': ', clean',
    'binding.welcome.git_dirty': ', uncommitted changes',
    'binding.welcome.git_none': '• git: not initialised',
    'binding.welcome.start_prompt': 'Start a conversation:',

    // ── /mcp read-only ──
    'mcp.header': '🔌 *MCP servers for this thread:*',
    'mcp.row': '• `{name}` — {source}',
    'mcp.empty': '🔌 No MCP servers configured.',
    'mcp.source_user': 'user (~/.claude/settings.json)',
    'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
    'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
    'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

    // ── extra hints ──
    'doctor.pin_hint': 'Pinned thread status (Stage 7) will be unavailable',

    // ── /whoami /version /status (global) ──
    'whoami.report':
      '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
      '🔐 allowed: {allowed}\n📁 binding: {binding}',
    'whoami.binding_unbound': '(no binding)',

    // ── pairing ──
    'pair.success': '✅ Group paired. id: `{groupId}`. The bot is now serving this supergroup.',
    'pair.locked':
      'ℹ️ The group id is set via `ALLOWED_GROUP_ID` — auto-pairing is disabled. ' +
      'To switch groups, change the variable and restart the bot.',
    'pair.only_forum': '❌ /pair only works inside a forum supergroup (enable Topics).',
    'pair.not_admin': '❌ Only a group administrator or creator can pair the bot.',
    'pair.not_paired': 'group not paired yet (pairing mode)',
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
    'agent.exit_signal_sent': 'Double Ctrl+C sent — {label} exiting',
    'agent.already_active': '{label} is already running here. Send a message or /stop.',
    'agent.starting': 'Starting {label} in `{subdir}`…',
    'agent.queued_starting': '⏳ {label} is still starting — your message is queued and will be sent once it is ready.',
    'agent.question_hint': 'ℹ️ Answer with keys: /up /down to move, /enter to confirm, /y /n /c for a quick reply.',
    'agent.start_failed': 'Failed to start {label}: {error}',
    'agent.reattached': '🔄 Bot restarted — session is still alive, continuing.',

    // ── /effort (reasoning effort) ──
    'effort.choose': '⚙️ Current effort: {current}\nPick a level:',
    'effort.current_none': 'not set',
    'effort.set_success': '✅ Effort: {level}',
    'effort.invalid_level': '⚠️ Level `{level}` is not valid. Available: {valid}.',
    'effort.not_available': 'ℹ️ No reasoning-effort levels are available for the current model.',
    'effort.not_supported': 'ℹ️ Model `{model}` has no reasoning-effort levels.',
    'effort.start_agent_first': 'ℹ️ Level saved. No agent running — it will apply on next start.',
    'effort.cleared_on_model_switch': 'ℹ️ Effort `{level}` cleared: the new model `{model}` does not support it.',
    'effort.unsupported_backend': 'Effort control is not supported for {label}.',
    'effort.no_session': 'No agent running. Start one with /claude or /opencode.',

    // ── /model (model selection) ──
    'model.saved_for_next_start': 'Model saved: {model} — applies on next agent start.',
    'model.start_agent_first': 'No active session. Start an agent first.',

    'stop_all.none_active': 'No agents running — nothing to stop.',
    'stop_all.summary': '🛑 Stopped {stopped} of {total} active agents.',
    'stop_all.general_only': '`/stop-all` is only available in the General topic.',

    'clearMessages.summary':
      '🗑 Deleted {deleted} of {total} messages. ' +
      'Telegram refuses to delete anything older than 48 h — the rest stays in history.',
    'clearMessages.no_messages': 'No messages to delete in this thread.',

    'edited.hint':
      '✏️ I don\'t treat edited messages as new input — send the correction as a separate message.',

    'voice.no_api_key':
      'Voice requires `GROQ_API_KEY` (free) or `OPENAI_API_KEY`.',
    'voice.failed': 'Failed to transcribe voice message.',
    'voice.transcribed': '🎤 {text}',

    // ── file intake ──
    'file.too_big':
      '📎 File exceeds the Bot API limit ({cap} MB) — I can\'t download it. Send a smaller file.',
    'file.download_failed': '📎 Failed to download the file. Please try again.',

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

    'cb.access_denied': 'Access denied',
    'cb.bind_only_topical': '/bind only works in topical threads',
    'cb.binding_to': 'Binding to {subdir}…',
    'cb.no_active_session': 'No active session',
    'cb.model_error': 'Error: {error}',
    'cb.model_set': 'Model: {model}',
    'cb.not_supported': 'Not supported for {label}',
    'cb.unknown_agent': 'Unknown agent',
    'cb.agent_switched': 'Switched to {label}',
    'cb.resume_only_topical': 'Resume only works in topical threads',
    'cb.bind_folder_first': 'Bind a folder first via /bind',
    'cb.agent_not_running': 'Agent not running',
    'cb.no_pending_question': 'No pending question',
    'cb.invalid_option': 'Invalid option',
    'cb.sent_option': 'Sent: {option}',
    'cb.effort_set': 'Effort: {level}',
    'cb.effort_error': 'Error: {error}',

    // ── session picker (/sessions, /resume). {label}=agent, {max}=count, {error}=reason ──
    'session.list_header': 'Sessions to resume ({label}):',
    'session.list_footer': 'Send 1–{max} to resume · 0 or /cancel to exit',
    'session.none': 'No resumable sessions in this folder.',
    'session.cancelled': 'Cancelled. Session picker closed.',
    'session.cancel_noop': 'Nothing to cancel — the session picker is not active.',
    'session.invalid': 'Invalid number. Enter a value from 1 to {max}.',
    'session.resumed': 'Session resumed. Send your message:',
    'session.resume_failed': 'Failed to resume session: {error}',
    'session.expired': 'Session list is stale. Run /sessions again.',
    'session.load_failed': 'Failed to load sessions.',

    // ── resume context block (last {count} turns shown on resume) ──
    'resume.context_header': '↩️ Resumed — last {count} messages:',
    'resume.context_user_label': '👤',
    'resume.context_assistant_label': '🤖',
  },
};

/**
 * @description Active language, picked once at boot from `BOT_LANG`.
 *
 * Audit S18 / #46: previous code did a literal `=== 'en'` check, so
 * `BOT_LANG=EN` / `English` / `En` silently fell back to ru with no
 * indication anything was off. Now we lowercase + trim and warn loudly
 * on unknown values.
 */
const lang: Lang = ((): Lang => {
  const raw = (process.env.BOT_LANG ?? '').trim().toLowerCase();
  if (raw === 'en') return 'en';
  if (raw === 'ru' || raw === '') return 'ru';
  console.warn(`[i18n] unknown BOT_LANG="${process.env.BOT_LANG}", falling back to ru`);
  return 'ru';
})();

/**
 * @description Format a localised message.
 *
 * `opts` values are substituted into `{name}` placeholders. Unknown codes
 * fall back to English; if the code is missing in English too, the last
 * segment of the code is returned with a warning (loud failure mode —
 * easier to spot in tests / logs than a silently empty string).
 *
 * Audit S18 / #46: previously returned the raw code, which surfaces in
 * chat as e.g. `agent.foo.bar` — confusing for users. Last-segment
 * fallback at least reads naturally while the warning still hits logs.
 */
export function t(code: string, opts?: Record<string, string | number>): string {
  const primary = dict[lang][code];
  const fallback = dict.en[code];
  let template: string;
  if (primary !== undefined) {
    template = primary;
  } else if (fallback !== undefined) {
    template = fallback;
  } else {
    console.warn(`[i18n] missing key "${code}" in both ru and en`);
    template = code.split('.').pop() ?? code;
  }
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

/**
 * @description Integrity check (tests): is `code` present in EVERY language
 * catalog? Independent of the import-time `lang`, so a single test process can
 * prove a key resolves in both `ru` and `en` without the bare-code fallback —
 * which `t` alone can't show, since it only ever reaches the active locale plus
 * the en fallback.
 */
export function checkKeyInAllLangs(code: string): boolean {
  return (Object.keys(dict) as Lang[]).every((l) => dict[l][code] !== undefined);
}
