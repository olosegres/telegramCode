/**
 * @description Russian catalog — hand-maintained. Not
 * machine-translated; kept as the reference set the project shipped with.
 */

export const ruDict: Record<string, string> = {
  'access.denied': 'Доступ запрещён.',
  'access.group_only': 'Я работаю только в настроенной forum-супергруппе.',

  'thread.no_binding':
    '📁 Этот тред не привязан к папке. Используй /bind <subdir> или выбери из списка.',
  'thread.bind_required':
    '📁 Сначала привяжи папку: /bind <subdir>. Агент запускается только в привязанной папке.',
  'thread.bound': '📁 Привязано к `{subdir}`.\nЗапусти /claude или /opencode.',
  'thread.unbound': '📁 Привязка снята.',
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

  'bind.usage': 'Использование: /bind <subdir>\nПример: /bind overview',
  'bind.current': '📂 Сейчас привязано: `{subdir}`',
  'bind.current_none': '📂 Пока не привязано',
  'bind.in_general':
    '/bind работает только в тематических тредах, не в General.',
  'bind.invalid_chars': '❌ В имени папки запрещены управляющие символы.',
  'bind.not_found': '❌ Папка `{subdir}` не найдена в `WORK_ROOT` (`{workRoot}`).',
  'bind.outside_root': '❌ Путь выходит за пределы `WORK_ROOT`.',
  'bind.not_directory': '❌ `{subdir}` существует, но это не папка.',

  'bind.leave_button': '⬅️ Покинуть текущую папку',
  'bind.create_button': '➕ Создать новую папку',
  'bind.create_prompt':
    '✏️ Пришли название новой папки (будет создана в `WORK_ROOT`). Любая команда отменяет.',
  'bind.create_cb': 'Создаю новую папку…',
  'bind.create_empty': '❌ Название пустое. Пришли название папки.',
  'bind.create_separator': '❌ Название не должно содержать `/` или `\\`. Пришли простое имя.',
  'bind.create_dot_segment': '❌ `.` и `..` нельзя использовать как имя папки.',
  'bind.create_hidden': '❌ Имя не должно начинаться с точки.',
  'bind.create_invalid_chars': '❌ В названии папки запрещены управляющие символы.',
  'bind.create_exists': '📁 Папка `{subdir}` уже существует — привязываю к ней.',
  'bind.create_failed': '❌ Не удалось создать папку: {error}',

  'ls.header': '📁 Подпапки `{workRoot}`:',
  'ls.empty': '📁 В `WORK_ROOT` нет подходящих подпапок.',
  'list.header': '🧵 Привязки тредов ({count}):',
  'list.empty': '🧵 Привязок ещё нет. Создай тред и напиши /bind.',
  'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
  'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
  'new.general_hint':
    '/new работает внутри привязанного треда — открой тред и выполни /new, чтобы перезапустить сессию агента.',

  'help.general':
    '*Команды в General:*\n' +
    '/ls — подпапки `WORK_ROOT`\n' +
    '/list — список тредов\n' +
    '/status — статус всех тредов\n' +
    '/quitall — завершить всех агентов\n' +
    '/whoami /version — debug\n\n' +
    'Чтобы начать диалог с агентом — открой тематический тред.',
  'help.thread_unbound':
    '*Тред не привязан к папке.*\n' +
    '/bind <subdir> — привязать (или выбери в списке)\n' +
    '/ls — подпапки `WORK_ROOT` (в General)',
  'help.thread_bound':
    '*Тред привязан к `{subdir}`.*\n' +
    '/claude /opencode — старт агента\n' +
    '/connect — подключить OpenCode provider API key (по умолчанию OpenAI)\n' +
    '/terminal — открыть shell в этой папке\n' +
    '/new — перезапустить сессию (старая → /sessions)\n' +
    '/model /sessions — переключение\n' +
    '/effort — уровень reasoning effort\n' +
    '/verbosity — детализация вывода (размышления/инструменты/суб-агенты)\n' +
    '/quit /status /output — контроль\n' +
    '/compact — сжать контекст агента\n' +
    '/clear — удалить сообщения треда\n' +
    '/c /y /n /enter /up /down /tab /esc — TUI-команды (Claude)\n' +
    '/bind — управление binding',

  'doctor.header': '🔍 *TelegramCode Doctor*',
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

  'onboarding.welcome':
    '👋 *TelegramCode Bot 2.0*\n\n' +
    'Готовность к работе:\n' +
    '1️⃣ Сделай меня админом группы с правами:\n' +
    '   • Manage Topics, Delete Messages, Pin Messages\n' +
    '2️⃣ @BotFather → /setprivacy → Disable, потом удали и добавь бота заново\n' +
    '3️⃣ Запусти /doctor — увижу проблемы сразу\n' +
    '4️⃣ В каждом тематическом треде сделай /bind <subdir> и запусти агента\n\n' +
    '`WORK_ROOT`: `{workRoot}`',

  'binding.welcome.header': '📁 Привязано к `{subdir}`',
  'binding.welcome.claude_md': '• CLAUDE.md: {size}',
  'binding.welcome.mcp_json': '• `.mcp.json`: {count} серверов',
  'binding.welcome.git': '• git: ветка `{branch}`{detail}',
  'binding.welcome.git_clean': ', чисто',
  'binding.welcome.git_dirty': ', изменения не закоммичены',
  'binding.welcome.git_none': '• git: не инициализирован',
  'binding.welcome.start_prompt': 'Начни диалог:',

  'mcp.header': '🔌 *MCP-серверы для этого треда:*',
  'mcp.row': '• `{name}` — {source}',
  'mcp.empty': '🔌 MCP-серверы не настроены.',
  'mcp.source_user': 'user (~/.claude/settings.json)',
  'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
  'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
  'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

  'doctor.pin_hint': 'Pinned-статус треда (Этап 7) будет недоступен',

  'whoami.report':
    '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
    '🔐 allowed: {allowed}\n📁 binding: {binding}',
  'whoami.binding_unbound': '(нет привязки)',

  'pair.success': '✅ Группа привязана. id: `{groupId}`. Бот готов к работе в этой супергруппе.',
  'pair.locked':
    'ℹ️ id группы задан через `ALLOWED_GROUP_ID` — авто-привязка отключена. ' +
    'Чтобы сменить группу, измени переменную и перезапусти бота.',
  'pair.only_forum': '❌ /pair работает только в forum-супергруппе (включи Topics).',
  'pair.not_admin': '❌ Привязать бота может только администратор или создатель группы.',
  'pair.not_paired': 'группа ещё не привязана (режим pairing)',
  'pair.dm': 'ℹ️ /pair не нужен в режиме DM — бот работает в твоём личном чате.',
  'version.report':
    '*TelegramCode {bot}*\n' +
    'Node: {node}\n' +
    'tmux: {tmux}\n' +
    'claude: {claude}\n' +
    'opencode: {opencode}',
  'version.unknown': '(недоступно)',
  'status.global_header': '📊 *Все треды* ({total}):',
  'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
  'status.global_empty': '📊 Тредов пока нет.',
  'language.status': '🌐 Язык: {display}',
  'language.set_success': '✅ Язык для этого чата: `{locale}`.',
  'language.auto_success': '✅ Автовыбор языка включён. Сейчас: {display}.',
  'language.invalid': '⚠️ Локаль `{locale}` не поддерживается. Доступно: {locales}.',

  'agent.ready': '{label} готов в `{subdir}`{argsSuffix}\nОтправь сообщение:',
  'agent.no_session': 'Агент не запущен. /claude или /opencode — старт.',
  'agent.session_ended': '{label}: сессия завершена',
  'agent.stopped': '{label} остановлен',
  'agent.exit_signal_sent': 'Послан двойной Ctrl+C — {label} завершает работу',
  'agent.already_active': '{label} уже работает в этом треде. Отправь сообщение или /quit.',
  'agent.starting': 'Запускаю {label} в `{subdir}`…',
  'agent.queued_starting': '⏳ {label} ещё запускается — сообщение в очереди, отправлю как только будет готов.',
  'agent.question_hint': 'ℹ️ Ответь цифрой варианта (например 1) или y/n. Также: /up /down — выбор, /enter — подтвердить, /c — отмена.',
  'agent.start_failed': 'Не удалось запустить {label}: {error}',
  'agent.question_cancelled_for_prompt': '⚠️ Предыдущий вопрос отменён — выполняю новый запрос.',
  'agent.question_cancelled_msg_label': '❌ Вопрос отменён: {header}',
  'agent.login_code_relayed': '🔐 Код входа передан в Claude — сообщение с токеном удалено из истории.',
  'agent.workingIndicator': '{glyph} работаю…',
  'terminal.ready': '🖥 Терминал готов в `{subdir}`{argsSuffix}\nЛюбое сообщение выполнится как команда. /c — Ctrl+C, /up /down — история, /tab — автодополнение, /quit — закрыть.',

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

  'thinking.live': '•••',
  'thinking.thoughtForSeconds': '💭 думал {seconds} с',
  'thinking.choose': '☁️ Текущий режим размышлений: {current}\nВыбери режим:',
  'thinking.set_success': '✅ Режим размышлений: {mode}',
  'thinking.invalid_mode': '⚠️ Режим `{mode}` недопустим. Доступные: {valid}.',
  'thinking.mode.minimal': 'минимум',
  'thinking.mode.short': 'кратко',
  'thinking.mode.full': 'подробно',

  'toolResults.choose': '🔧 Текущий режим результатов инструментов: {current}\nВыбери режим:',
  'toolResults.set_success': '✅ Режим результатов инструментов: {mode}',
  'toolResults.invalid_mode': '⚠️ Режим `{mode}` недопустим. Доступные: {valid}.',
  'toolResults.mode.minimal': 'минимум',
  'toolResults.mode.short': 'кратко',
  'toolResults.mode.full': 'подробно',
  'toolResults.truncated_footer': '… (обрезано, /tool_results full)',
  'toolResults.activity_status': '🔧 {tool} …',
  'toolResults.activity_fallback': 'инструмент',

  'subagent.status_elapsed': '🤖 суб-агент: {title} · {elapsed}',
  'subagent.panel_fold_status': '🤖 суб-агент работает …',
  'subagent.delegating_status': '🤖 Делегирую: {title} …',
  'subagent.chunk_prefix': '🤖 ⤷',
  'subagent.fallback_title': 'суб-агент',
  'subagent.choose': '🤖 Текущий режим суб-агентов: {current}\nВыбери режим:',
  'subagent.set_success': '✅ Режим суб-агентов: {mode}',
  'subagent.invalid_mode': '⚠️ Режим `{mode}` недопустим. Доступные: {valid}.',
  'subagent.mode.minimal': 'минимум',
  'subagent.mode.short': 'кратко',
  'subagent.mode.full': 'подробно',

  'verbosity.choose': '🔊 Текущая детализация вывода: {current}\nВыбери уровень:',
  'verbosity.set_success': '✅ Детализация вывода: {mode} (размышления, инструменты, суб-агенты)',
  'verbosity.invalid_mode': '⚠️ Режим `{mode}` недопустим. Доступные: {valid}.',
  'verbosity.custom': 'смешанный (размышления: {thinking} · инструменты: {toolResults} · суб-агенты: {subagent})',
  'verbosity.mode.minimal': 'минимум',
  'verbosity.mode.short': 'кратко',
  'verbosity.mode.full': 'подробно',

  'model.saved_for_next_start': 'Модель сохранена: {model} — применится при старте агента.',
  'model.start_agent_first': 'Нет активной сессии. Сначала запусти агента.',

  'rename_session.usage': 'Использование: /rename_session <новое название>',
  'rename_session.start_agent_first': 'Нет активной сессии. Сначала запусти агента (/claude или /opencode).',
  'rename_session.unsupported_backend': 'Переименование сессии не поддерживается для {label}.',
  'rename_session.success': '✅ Сессия переименована: {title}',
  'rename_session.failed': '⚠️ Не удалось переименовать сессию: {reason}',

  'connect.prompt_key': '🔑 Пришли API key для `{provider}` следующим сообщением. Я удалю сообщение с ключом из истории.',
  'connect.empty_key': '❌ API key пустой. Пришли ключ следующим сообщением.',
  'connect.invalid_provider': '❌ Некорректный provider id `{provider}`. Например: /connect openai',
  'connect.unsupported_provider': '⚠️ Provider `{provider}` не поддерживает простой API-key вход через этот flow. Используй OpenCode UI/CLI для этого provider.',
  'connect.unsupported_backend': 'OpenCode provider auth недоступен в этом билде.',
  'connect.failed': '⚠️ Не удалось подключить `{provider}`: {reason}',
  'connect.success': '✅ Provider `{provider}` подключён. OpenCode server не перезапускался.',
  'connect.cancelled': 'Ввод API key отменён.',

  'quit_all.none_active': 'Нет активных агентов — нечего останавливать.',
  'quit_all.summary': '🚪 Завершено {stopped} из {total} активных агентов.',
  'quit_all.general_only': 'Команда `/quit-all` доступна только в General-топике.',

  'clearMessages.summary':
    '🗑 Удалено {deleted} сообщений из {total}. ' +
    'Telegram не отдаёт ничего старше 48 ч — остальные останутся в истории.',
  'clearMessages.no_messages': 'Нет сообщений для удаления в этом треде.',

  'edited.hint':
    '✏️ Редактирование сообщений я не вижу как новый ввод — отправь правку отдельным сообщением.',

  'voice.no_api_key':
    'Для голоса нужен `GROQ_API_KEY` (бесплатно) или `OPENAI_API_KEY`.',
  'voice.failed': 'Не удалось распознать голосовое.',
  'voice.transcribed': '🎤 {text}',

  'file.too_big':
    '📎 Файл больше лимита Bot API ({cap} МБ) — скачать его я не могу. Пришли файл поменьше.',
  'file.download_failed': '📎 Не удалось скачать файл. Попробуй ещё раз.',

  'error.workdir.gone':
    '📁 Папка `{subdir}` исчезла с диска. Сделай /bind <newdir>.',
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
  'cb.claudeMode_already': 'Уже активно',
  'cb.claudeMode_switching': 'Переключаю…',
  'claudeMode.pick': '⚙️ Режим Claude Code — сейчас: {label}\nВыбери бэкенд (переключение сохраняет тот же диалог):',
  'claudeMode.not_claude': 'Этот топик не на Claude Code — /claude_mode переключает только бэкенд Claude.',
  'claudeMode.already': 'Уже {label}.',
  'claudeMode.set_idle': '⚙️ Бэкенд Claude: {label} — применится при следующем старте.',
  'claudeMode.switched_resumed': '⚙️ Переключено на {label} — тот же диалог продолжен.',
  'claudeMode.switched_fresh': '⚙️ Переключено на {label} — начата свежая сессия.',
  'cb.thinking_set': 'Размышления: {mode}',
  'cb.thinking_error': 'Ошибка: {error}',
  'cb.toolresults_set': 'Результаты инструментов: {mode}',
  'cb.toolresults_error': 'Ошибка: {error}',
  'cb.subagent_set': 'Суб-агенты: {mode}',
  'cb.subagent_error': 'Ошибка: {error}',
  'cb.verbosity_set': 'Детализация вывода: {mode}',
  'cb.verbosity_error': 'Ошибка: {error}',

  'session.list_header': 'Сессии для возобновления ({label}):',
  'session.list_footer': 'Отправьте 1–{max} чтобы возобновить · 0 для выхода',
  'session.none': 'Нет сессий для возобновления в этой папке.',
  'session.cancelled': 'Отменено. Выбор сессии закрыт.',
  'session.invalid': 'Неверный номер. Введите число от 1 до {max}.',
  'session.resumed': 'Сессия возобновлена. Отправьте сообщение:',
  'session.resume_failed': 'Не удалось возобновить сессию: {error}',
  'session.expired': 'Список сессий устарел. Запустите /sessions заново.',
  'session.load_failed': 'Не удалось загрузить список сессий.',

  'resume.context_header': '↩️ Возобновлено — последние {count} сообщений:',
  'resume.context_user_label': '👤',
  'resume.context_assistant_label': '🤖',

  'recap.missedCountHeader': '⚠️ Пока бот был недоступен, пропущено сообщений: {count}. Последнее из сессии:',
  'recap.restartedFallbackHeader': '🔄 Бот перезапущен. Последнее из сессии:',
  'recap.stillWorkingLine': '⏳ Агент всё ещё работает…',

  'trace.onThisThreadReply': '🔎 Трейс включён для этого треда.',
  'trace.offThisThreadReply': '🔎 Трейс выключен для этого треда.',
  'trace.onAllThreadsReply': '🔎 Трейс включён для ВСЕХ тредов.',
  'trace.offAllThreadsReply': '🔎 Трейс выключен везде (флаг «all» и список тредов очищены).',
  'trace.statusReply':
    '🔎 Трейс — этот тред: {thisThread}\nВсе треды: {allThreads}\nТредов в трейсе: {count}',
  'trace.statusOnLabel': 'вкл',
  'trace.statusOffLabel': 'выкл',
  'trace.usageHint': 'Использование: /trace on | off | on all | off all | (без аргумента — статус)',

  'timestamps.onReply':
    '🕐 Метки времени включены: каждый промпт агенту получает время отправки первой строкой (в топик не постится).',
  'timestamps.offReply': '🕐 Метки времени выключены для этого треда.',
  'timestamps.statusOnReply': '🕐 Метки времени: вкл для этого треда.',
  'timestamps.statusOffReply': '🕐 Метки времени: выкл для этого треда.',
  'timestamps.usageHint': 'Использование: /timestamps on | off | (без аргумента — статус)',

  'schedule.fired':
    '⏰ Расписание «{name}» ({schedule}){missedNote}\n\n{prompt}',
  'schedule.missedNote': ' — пропущено в {time}, догоняю',
  'schedule.pausedUnbound':
    '⏸ Расписаний на паузе: {count} — топик отвязан от папки. /bind вернёт их в строй.',
  'schedule.resumedRebind': '▶️ Расписаний возобновлено: {count} (следующий запуск пересчитан от текущего момента).',
  'schedule.forwardPromptTemplate':
    'The user wants to schedule the following. Use the schedule_create / schedule_list / schedule_cancel MCP tools (cron for repeats, one-shot for a single run), translating any time phrasing into the right schedule, then confirm to the user IN RUSSIAN what you scheduled.\n\nRequest: {text}',
  'schedule.interviewPromptTemplate':
    'The user invoked /schedule with no details. Ask them IN RUSSIAN what prompt they want scheduled and WHEN (one-time or repeating). Once you have both, create it with the schedule_create MCP tool and confirm IN RUSSIAN what you scheduled.',

  'apiRetry.transientNotice':
    '⏳ API перегружен (rate limit) — повторю автоматически через {minutes} мин (попытка {attempt}).',
  'apiRetry.usageLimitDelayNotice':
    '🚧 Лимит исчерпан — повторю через {minutes} мин (попытка {attempt}).',
  'apiRetry.usageLimitResetNotice':
    '🚧 Лимит исчерпан — продолжу автоматически после сброса (~{time}).',
  'apiRetry.resuming': '↻ Продолжаю…',
  'apiRetry.giveUp':
    '⚠️ Не смог возобновить после {attempts} попыток. Напиши, когда продолжить.',
  'apiRetry.continueNudge': 'Продолжай с того места, где ты остановился.',
  'apiRetry.loggedOutClaude':
    '⚠️ Claude разлогинен — отправь /login, чтобы продолжить.',
  'apiRetry.loggedOutOpenCode':
    '⚠️ OpenCode: неверные учётные данные — перезапусти opencode-сервер.',

  // ── startup readiness status (boot-time owner notice) ──
  'startup.ready':
    '✅ Готов — я могу обрабатывать сообщения в тредах бота и темах группы.',
  'startup.header_not_ready':
    '⚠️ Настройка не завершена. Чтобы начать работу со мной, выполните эти шаги:',
  'startup.item.create_group':
    'Создайте форум-супергруппу с включёнными темами (Topics) и отправьте мне там сообщение, чтобы привязать её.',
  'startup.item.grant_admin':
    'Сделайте меня админом с правами: {missing}.',
  'startup.item.bind_topic':
    'Создайте тему и привяжите её к папке командой /bind.',
  'startup.item.install_agent':
    'Установите агентский CLI — claude или opencode.',
  'startup.item.optional_groq':
    '(необязательно) Добавьте GROQ_API_KEY в .env и перезапустите, чтобы включить голосовой ввод.',
  'startup.item.optional_owner':
    '(необязательно) Задайте OWNER_USER_ID, чтобы получать этот статус в личном чате.',
};
