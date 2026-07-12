/**
 * @description Ukrainian catalog. Hand-translated with full key parity to `en`
 * (the canonical reference). Native review welcome. Agent-facing templates
 * (`schedule.*`, `apiRetry.continueNudge`) follow the `ru` pattern: English
 * instruction skeleton, but the reply-language directive baked as "IN UKRAINIAN".
 */

export const ukDict: Record<string, string> = {
  'access.denied': 'Доступ заборонено.',
  'access.group_only': 'Я працюю лише в налаштованій forum-супергрупі.',

  'thread.no_binding':
    '📁 Цей тред не прив\'язаний до папки. Використай /bind <subdir> або обери зі списку.',
  'thread.bind_required':
    '📁 Спершу прив\'яжи папку: /bind <subdir>. Агент запускається лише в прив\'язаній папці.',
  'thread.bound': '📁 Прив\'язано до `{subdir}`.\nЗапусти /claude або /opencode.',
  'thread.unbound': '📁 Прив\'язку знято.',
  'thread.general_no_agent':
    'General не прив\'язаний до папки — перейди в тематичний тред, щоб поговорити з агентом.',
  'thread.welcome_bound':
    '👋 Тред створено й автоматично прив\'язано до `{subdir}` (назва теми збіглася з підпапкою).\nЗапусти /claude або /opencode.',
  'thread.welcome_pick':
    '👋 Тред створено. Прив\'яжи папку: /bind <subdir>, або обери одну нижче.',
  'thread.bind_collision':
    '⚠️ Папка `{subdir}` вже використовується в тредах: {threads}.\nПрив\'язку додано; сесії лишаються незалежними (власний tmux/SSE).',
  'thread.no_agent_with_binding':
    '📁 Папка `{subdir}` прив\'язана. Запусти /claude або /opencode, щоб почати діалог.',

  'bind.usage': 'Використання: /bind <subdir>\nПриклад: /bind overview',
  'bind.current': '📂 Зараз прив\'язано: `{subdir}`',
  'bind.current_none': '📂 Ще не прив\'язано',
  'bind.in_general':
    '/bind працює лише в тематичних тредах, не в General.',
  'bind.invalid_chars': '❌ Назва папки не повинна містити керуючих символів.',
  'bind.not_found': '❌ Папку `{subdir}` не знайдено в `WORK_ROOT` (`{workRoot}`).',
  'bind.outside_root': '❌ Шлях виходить за межі `WORK_ROOT`.',
  'bind.not_directory': '❌ `{subdir}` існує, але це не папка.',

  'bind.leave_button': '⬅️ Покинути поточну папку',
  'bind.create_button': '➕ Створити нову папку',
  'bind.create_prompt':
    '✏️ Надішли назву нової папки (її буде створено в `WORK_ROOT`). Будь-яка команда скасовує.',
  'bind.create_cb': 'Створюю нову папку…',
  'bind.create_empty': '❌ Назва порожня. Надішли назву папки.',
  'bind.create_separator': '❌ Назва не повинна містити `/` чи `\\`. Надішли просте ім\'я.',
  'bind.create_dot_segment': '❌ `.` та `..` не можна використовувати як назву папки.',
  'bind.create_hidden': '❌ Назва не повинна починатися з крапки.',
  'bind.create_invalid_chars': '❌ Назва папки не повинна містити керуючих символів.',
  'bind.create_exists': '📁 Папка `{subdir}` вже існує — прив\'язуюся до неї.',
  'bind.create_failed': '❌ Не вдалося створити папку: {error}',

  'ls.header': '📁 Підпапки `{workRoot}`:',
  'ls.empty': '📁 У `WORK_ROOT` немає придатних підпапок.',
  'list.header': '🧵 Прив\'язки тредів ({count}):',
  'list.empty': '🧵 Прив\'язок ще немає. Створи тред і виконай /bind.',
  'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
  'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
  'new.general_hint':
    '/new працює всередині прив\'язаного треда — відкрий тред і виконай /new, щоб перезапустити сесію агента.',

  'help.general':
    '*Команди в General:*\n' +
    '/ls — підпапки `WORK_ROOT`\n' +
    '/list — список тредів\n' +
    '/status — статус усіх тредів\n' +
    '/quitall — завершити всіх агентів\n' +
    '/whoami /version — debug\n\n' +
    'Щоб поговорити з агентом — відкрий тематичний тред.',
  'help.thread_unbound':
    '*Тред не прив\'язаний до папки.*\n' +
    '/bind <subdir> — прив\'язати (або обери зі списку)\n' +
    '/ls — підпапки `WORK_ROOT` (в General)',
  'help.thread_bound':
    '*Тред прив\'язаний до `{subdir}`.*\n' +
    '/claude /opencode — запустити агента\n' +
    '/connect — підключити OpenCode provider API key (за замовчуванням OpenAI)\n' +
    '/terminal — відкрити shell у цій папці\n' +
    '/new — перезапустити сесію (стара → /sessions)\n' +
    '/model /sessions — переключення\n' +
    '/effort — рівень reasoning-effort\n' +
    '/verbosity — деталізація виводу (розмірковування/інструменти/суб-агенти)\n' +
    '/quit /status /output — контроль\n' +
    '/compact — стиснути контекст агента\n' +
    '/clear — видалити повідомлення треда\n' +
    '/c /y /n /enter /up /down /tab /esc — TUI-клавіші (Claude)\n' +
    '/bind — керування прив\'язкою',

  'doctor.header': '🔍 *TelegramCode Doctor*',
  'doctor.ok': '✅ {label}',
  'doctor.warn': '⚠️ {label} — {hint}',
  'doctor.fail': '❌ {label} — {hint}',
  'doctor.bot_admin': 'Бот — адміністратор групи',
  'doctor.can_manage_topics': 'Право `can_manage_topics` надано',
  'doctor.can_delete_messages': 'Право `can_delete_messages` надано',
  'doctor.can_pin_messages': 'Право `can_pin_messages` надано',
  'doctor.privacy_off': 'Privacy mode вимкнено',
  'doctor.privacy_hint':
    '@BotFather → /setprivacy → Disable, потім видали й додай бота знову',
  'doctor.workroot_subdirs':
    '`WORK_ROOT`: `{workRoot}` ({count} підпапок)',
  'doctor.datadir_path': '`DATA_DIR`: `{dataDir}`',
  'doctor.claude_installed': 'claude CLI встановлено',
  'doctor.opencode_installed': 'opencode CLI встановлено',
  'doctor.state_valid':
    'state.json валідний ({bindings} bindings, {active} активних)',
  'doctor.state_archived':
    'Попередній state.json був пошкоджений, архів: {path}',
  'doctor.cli_missing':
    'не знайдено в PATH (auto-install спрацює при /claude чи /opencode)',
  'doctor.no_admin_info':
    'не можу прочитати права бота — getChatMember failed',

  'onboarding.welcome':
    '👋 *TelegramCode Bot 2.0*\n\n' +
    'Чеклист готовності до роботи:\n' +
    '1️⃣ Зроби мене адміністратором групи з правами:\n' +
    '   • Manage Topics, Delete Messages, Pin Messages\n' +
    '2️⃣ @BotFather → /setprivacy → Disable, потім видали й додай мене знову\n' +
    '3️⃣ Запусти /doctor, щоб побачити, чого ще бракує\n' +
    '4️⃣ У кожному тематичному треді виконай /bind <subdir> і запусти агента\n\n' +
    '`WORK_ROOT`: `{workRoot}`',

  'binding.welcome.header': '📁 Прив\'язано до `{subdir}`',
  'binding.welcome.claude_md': '• CLAUDE.md: {size}',
  'binding.welcome.mcp_json': '• `.mcp.json`: {count} серверів',
  'binding.welcome.git': '• git: гілка `{branch}`{detail}',
  'binding.welcome.git_clean': ', чисто',
  'binding.welcome.git_dirty': ', незакомічені зміни',
  'binding.welcome.git_none': '• git: не ініціалізовано',
  'binding.welcome.start_prompt': 'Почни розмову:',

  'mcp.header': '🔌 *MCP-сервери для цього треда:*',
  'mcp.row': '• `{name}` — {source}',
  'mcp.empty': '🔌 MCP-сервери не налаштовано.',
  'mcp.source_user': 'user (~/.claude/settings.json)',
  'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
  'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
  'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

  'doctor.pin_hint': 'Закріплений статус треда (Етап 7) буде недоступний',

  'whoami.report':
    '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
    '🔐 allowed: {allowed}\n📁 binding: {binding}',
  'whoami.binding_unbound': '(немає прив\'язки)',

  'pair.success': '✅ Групу прив\'язано. id: `{groupId}`. Бот тепер обслуговує цю супергрупу.',
  'pair.locked':
    'ℹ️ id групи задано через `ALLOWED_GROUP_ID` — авто-прив\'язку вимкнено. ' +
    'Щоб змінити групу, зміни змінну й перезапусти бота.',
  'pair.only_forum': '❌ /pair працює лише в forum-супергрупі (увімкни Topics).',
  'pair.not_admin': '❌ Прив\'язати бота може лише адміністратор або творець групи.',
  'pair.not_paired': 'групу ще не прив\'язано (режим pairing)',
  'pair.dm': 'ℹ️ /pair не потрібен у режимі DM — бот обслуговує твій приватний чат.',
  'version.report':
    '*TelegramCode {bot}*\n' +
    'Node: {node}\n' +
    'tmux: {tmux}\n' +
    'claude: {claude}\n' +
    'opencode: {opencode}',
  'version.unknown': '(недоступно)',
  'status.global_header': '📊 *Усі треди* ({total}):',
  'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
  'status.global_empty': '📊 Тредів поки немає.',
  'language.status': '🌐 Мова: {display}',
  'language.set_success': '✅ Мову для цього чату встановлено: `{locale}`.',
  'language.auto_success': '✅ Мову скинуто на авто. Зараз: {display}.',
  'language.invalid': '⚠️ Локаль `{locale}` не підтримується. Доступні: {locales}.',

  'agent.ready': '{label} готовий у `{subdir}`{argsSuffix}\nНадішли повідомлення:',
  'agent.no_session': 'Агент не запущений. /claude або /opencode — щоб запустити.',
  'agent.session_ended': '{label}: сесію завершено',
  'agent.stopped': '{label} зупинено',
  'agent.exit_signal_sent': 'Надіслано подвійний Ctrl+C — {label} завершує роботу',
  'agent.already_active': '{label} вже працює тут. Надішли повідомлення або /quit.',
  'agent.starting': 'Запускаю {label} у `{subdir}`…',
  'agent.queued_starting': '⏳ {label} ще запускається — твоє повідомлення в черзі й буде надіслане, щойно він буде готовий.',
  'agent.question_hint': 'ℹ️ Відповідай номером варіанта (наприклад 1) або y/n. Також: /up /down — рух, /enter — підтвердити, /c — скасувати.',
  'agent.start_failed': 'Не вдалося запустити {label}: {error}',
  'agent.question_cancelled_for_prompt': '⚠️ Попереднє питання скасовано — виконую твій новий запит.',
  'agent.question_cancelled_msg_label': '❌ Питання скасовано: {header}',
  'agent.login_code_relayed': '🔐 Код входу передано в Claude — повідомлення з токеном видалено з історії.',
  'agent.workingIndicator': '{glyph} працюю…',
  'terminal.ready': '🖥 Термінал готовий у `{subdir}`{argsSuffix}\nКожне повідомлення виконується як команда. /c — Ctrl+C, /up /down — історія, /tab — автодоповнення, /quit — закрити.',

  'effort.choose': '⚙️ Поточний effort: {current}\nОбери рівень:',
  'effort.current_none': 'не задано',
  'effort.set_success': '✅ Effort: {level}',
  'effort.invalid_level': '⚠️ Рівень `{level}` недопустимий. Доступні: {valid}.',
  'effort.not_available': 'ℹ️ Для поточної моделі рівні reasoning effort недоступні.',
  'effort.not_supported': 'ℹ️ Модель `{model}` не має рівнів reasoning effort.',
  'effort.start_agent_first': 'ℹ️ Рівень збережено. Агент не запущений — застосується при наступному старті.',
  'effort.cleared_on_model_switch': 'ℹ️ Effort `{level}` скинуто: нова модель `{model}` його не підтримує.',
  'effort.unsupported_backend': 'Керування effort не підтримується для {label}.',
  'effort.no_session': 'Агент не запущений. Спершу /claude чи /opencode.',

  'thinking.live': '•••',
  'thinking.thoughtForSeconds': '💭 думав {seconds} с',
  'thinking.choose': '☁️ Поточний режим розмірковувань: {current}\nОбери режим:',
  'thinking.set_success': '✅ Режим розмірковувань: {mode}',
  'thinking.invalid_mode': '⚠️ Режим `{mode}` недопустимий. Доступні: {valid}.',
  'thinking.mode.minimal': 'мінімум',
  'thinking.mode.short': 'коротко',
  'thinking.mode.full': 'докладно',

  'toolResults.choose': '🔧 Поточний режим результатів інструментів: {current}\nОбери режим:',
  'toolResults.set_success': '✅ Режим результатів інструментів: {mode}',
  'toolResults.invalid_mode': '⚠️ Режим `{mode}` недопустимий. Доступні: {valid}.',
  'toolResults.mode.minimal': 'мінімум',
  'toolResults.mode.short': 'коротко',
  'toolResults.mode.full': 'докладно',
  'toolResults.truncated_footer': '… (обрізано, /tool_results full)',
  'toolResults.activity_status': '🔧 {tool} …',
  'toolResults.activity_fallback': 'інструмент',

  'subagent.status_elapsed': '🤖 суб-агент: {title} · {elapsed}',
  'subagent.panel_fold_status': '🤖 суб-агент працює …',
  'subagent.delegating_status': '🤖 Делегую: {title} …',
  'subagent.chunk_prefix': '🤖 ⤷',
  'subagent.fallback_title': 'суб-агент',
  'subagent.choose': '🤖 Поточний режим суб-агентів: {current}\nОбери режим:',
  'subagent.set_success': '✅ Режим суб-агентів: {mode}',
  'subagent.invalid_mode': '⚠️ Режим `{mode}` недопустимий. Доступні: {valid}.',
  'subagent.mode.minimal': 'мінімум',
  'subagent.mode.short': 'коротко',
  'subagent.mode.full': 'докладно',

  'verbosity.choose': '🔊 Поточна деталізація виводу: {current}\nОбери рівень:',
  'verbosity.set_success': '✅ Деталізація виводу: {mode} (розмірковування, інструменти, суб-агенти)',
  'verbosity.invalid_mode': '⚠️ Режим `{mode}` недопустимий. Доступні: {valid}.',
  'verbosity.custom': 'змішаний (розмірковування: {thinking} · інструменти: {toolResults} · суб-агенти: {subagent})',
  'verbosity.mode.minimal': 'мінімум',
  'verbosity.mode.short': 'коротко',
  'verbosity.mode.full': 'докладно',

  'model.saved_for_next_start': 'Модель збережено: {model} — застосується при старті агента.',
  'model.start_agent_first': 'Немає активної сесії. Спершу запусти агента.',

  'rename_session.usage': 'Використання: /rename_session <нова назва>',
  'rename_session.start_agent_first': 'Немає активної сесії. Спершу запусти агента (/claude чи /opencode).',
  'rename_session.unsupported_backend': 'Перейменування сесії не підтримується для {label}.',
  'rename_session.success': '✅ Сесію перейменовано: {title}',
  'rename_session.failed': '⚠️ Не вдалося перейменувати сесію: {reason}',

  'connect.prompt_key': '🔑 Надішли API key для `{provider}` наступним повідомленням. Я видалю повідомлення з ключем з історії.',
  'connect.empty_key': '❌ API key порожній. Надішли ключ наступним повідомленням.',
  'connect.invalid_provider': '❌ Некоректний provider id `{provider}`. Наприклад: /connect openai',
  'connect.unsupported_provider': '⚠️ Provider `{provider}` не підтримує простий вхід через API key у цьому flow. Скористайся OpenCode UI/CLI для цього provider.',
  'connect.unsupported_backend': 'OpenCode provider auth недоступний у цій збірці.',
  'connect.failed': '⚠️ Не вдалося підключити `{provider}`: {reason}',
  'connect.success': '✅ Provider `{provider}` підключено. OpenCode server не перезапускався.',
  'connect.cancelled': 'Введення API key скасовано.',

  'quit_all.none_active': 'Немає запущених агентів — нема чого зупиняти.',
  'quit_all.summary': '🚪 Завершено {stopped} з {total} активних агентів.',
  'quit_all.general_only': 'Команда `/quit-all` доступна лише в топіку General.',

  'clearMessages.summary':
    '🗑 Видалено {deleted} з {total} повідомлень. ' +
    'Telegram відмовляється видаляти будь-що старше за 48 год — решта лишається в історії.',
  'clearMessages.no_messages': 'Немає повідомлень для видалення в цьому треді.',

  'edited.hint':
    '✏️ Я не сприймаю відредаговані повідомлення як новий ввід — надішли виправлення окремим повідомленням.',

  'voice.no_api_key':
    'Для голосу потрібен `GROQ_API_KEY` (безкоштовно) або `OPENAI_API_KEY`.',
  'voice.failed': 'Не вдалося розпізнати голосове повідомлення.',
  'voice.transcribed': '🎤 {text}',

  'file.too_big':
    '📎 Файл перевищує ліміт Bot API ({cap} МБ) — я не можу його завантажити. Надішли менший файл.',
  'file.download_failed': '📎 Не вдалося завантажити файл. Спробуй ще раз.',

  'error.workdir.gone':
    '📁 Папка `{subdir}` зникла з диска. Виконай /bind <newdir>.',
  'error.tg.thread.deleted':
    '⚠️ Тред видалено в Telegram; прив\'язку знято.',
  'error.tg.thread.closed':
    '🔒 Тред {key} закрито — відкрий його заново в клієнті Telegram, або видали повністю.',
  'error.tg.perm.delete':
    '🔐 Не можу видаляти повідомлення. Надай боту право `can_delete_messages`.',
  'error.tg.perm.manage_topics':
    '🔐 Бракує права `can_manage_topics`. Зроби мене адміністратором групи.',
  'error.state.corrupted':
    '⚠️ state.json був пошкоджений; прив\'язки скинуто. Повтори /bind де потрібно.',
  'error.start_in_general':
    'Не можна запускати агента в General — це службовий топік. Відкрий тематичний тред.',

  'cb.access_denied': 'Доступ заборонено',
  'cb.bind_only_topical': '/bind працює лише в тематичних тредах',
  'cb.binding_to': 'Прив\'язую до {subdir}…',
  'cb.no_active_session': 'Немає активної сесії',
  'cb.model_error': 'Помилка: {error}',
  'cb.model_set': 'Модель: {model}',
  'cb.not_supported': 'Не підтримується для {label}',
  'cb.unknown_agent': 'Невідомий агент',
  'cb.agent_switched': 'Переключено на {label}',
  'cb.resume_only_topical': 'Resume працює лише в тематичних тредах',
  'cb.bind_folder_first': 'Спершу прив\'яжи папку через /bind',
  'cb.agent_not_running': 'Агент не запущений',
  'cb.no_pending_question': 'Немає питання, що очікує',
  'cb.invalid_option': 'Некоректний варіант',
  'cb.sent_option': 'Надіслано: {option}',
  'cb.effort_set': 'Effort: {level}',
  'cb.effort_error': 'Помилка: {error}',
  'cb.claudeMode_already': 'Вже активно',
  'cb.claudeMode_switching': 'Переключаю…',
  'claudeMode.pick': '⚙️ Бекенд Claude Code — зараз: {label}\nОбери бекенд (переключення зберігає той самий діалог):',
  'claudeMode.not_claude': 'Цей топік не на Claude Code — /claude_mode переключає лише бекенд Claude.',
  'claudeMode.already': 'Вже {label}.',
  'claudeMode.set_idle': '⚙️ Бекенд Claude: {label} — застосується при наступному старті.',
  'claudeMode.switched_resumed': '⚙️ Переключено на {label} — той самий діалог продовжено.',
  'claudeMode.switched_fresh': '⚙️ Переключено на {label} — почато нову сесію.',
  'cb.thinking_set': 'Розмірковування: {mode}',
  'cb.thinking_error': 'Помилка: {error}',
  'cb.toolresults_set': 'Результати інструментів: {mode}',
  'cb.toolresults_error': 'Помилка: {error}',
  'cb.subagent_set': 'Суб-агенти: {mode}',
  'cb.subagent_error': 'Помилка: {error}',
  'cb.verbosity_set': 'Деталізація виводу: {mode}',
  'cb.verbosity_error': 'Помилка: {error}',

  'session.list_header': 'Сесії для відновлення ({label}):',
  'session.list_footer': 'Надішли 1–{max} щоб відновити · 0 для виходу',
  'session.none': 'Немає сесій для відновлення в цій папці.',
  'session.cancelled': 'Скасовано. Вибір сесії закрито.',
  'session.invalid': 'Неправильний номер. Введи значення від 1 до {max}.',
  'session.resumed': 'Сесію відновлено. Надішли повідомлення:',
  'session.resume_failed': 'Не вдалося відновити сесію: {error}',
  'session.expired': 'Список сесій застарів. Запусти /sessions знову.',
  'session.load_failed': 'Не вдалося завантажити список сесій.',

  'resume.context_header': '↩️ Відновлено — останні {count} повідомлень:',
  'resume.context_user_label': '👤',
  'resume.context_assistant_label': '🤖',

  'recap.missedCountHeader': '⚠️ Поки бот був недоступний, пропущено повідомлень: {count}. Останнє із сесії:',
  'recap.restartedFallbackHeader': '🔄 Бот перезапущено. Останнє із сесії:',
  'recap.stillWorkingLine': '⏳ Агент усе ще працює…',

  'trace.onThisThreadReply': '🔎 Трейс увімкнено для цього треда.',
  'trace.offThisThreadReply': '🔎 Трейс вимкнено для цього треда.',
  'trace.onAllThreadsReply': '🔎 Трейс увімкнено для ВСІХ тредів.',
  'trace.offAllThreadsReply': '🔎 Трейс вимкнено всюди (прапорець «all» і список тредів очищено).',
  'trace.statusReply':
    '🔎 Трейс — цей тред: {thisThread}\nУсі треди: {allThreads}\nТредів у трейсі: {count}',
  'trace.statusOnLabel': 'увімк',
  'trace.statusOffLabel': 'вимк',
  'trace.usageHint': 'Використання: /trace on | off | on all | off all | (без аргументу — статус)',

  'timestamps.onReply':
    '🕐 Мітки часу увімкнено: кожен промпт, переданий агенту, отримує час відправлення першим рядком (у топік ніколи не публікується).',
  'timestamps.offReply': '🕐 Мітки часу вимкнено для цього треда.',
  'timestamps.statusOnReply': '🕐 Мітки часу: увімкнено для цього треда.',
  'timestamps.statusOffReply': '🕐 Мітки часу: вимкнено для цього треда.',
  'timestamps.usageHint': 'Використання: /timestamps on | off | (без аргументу — статус)',

  'schedule.fired':
    '⏰ Розклад «{name}» ({schedule}){missedNote}\n\n{prompt}',
  'schedule.missedNote': ' — пропущено о {time}, надолужую',
  'schedule.pausedUnbound':
    '⏸ Розкладів на паузі: {count} — топік відв\'язано від папки. /bind поверне їх у роботу.',
  'schedule.resumedRebind': '▶️ Розкладів відновлено: {count} (наступний запуск перераховано від поточного моменту).',
  'schedule.forwardPromptTemplate':
    'The user wants to schedule the following. Use the schedule_create / schedule_list / schedule_cancel MCP tools (cron for repeats, one-shot for a single run), translating any time phrasing into the right schedule, then confirm to the user IN UKRAINIAN what you scheduled.\n\nRequest: {text}',
  'schedule.interviewPromptTemplate':
    'The user invoked /schedule with no details. Ask them IN UKRAINIAN what prompt they want scheduled and WHEN (one-time or repeating). Once you have both, create it with the schedule_create MCP tool and confirm IN UKRAINIAN what you scheduled.',

  'apiRetry.transientNotice':
    '⏳ API перевантажено (rate limit) — повторю автоматично через {minutes} хв (спроба {attempt}).',
  'apiRetry.usageLimitDelayNotice':
    '🚧 Ліміт вичерпано — повторю через {minutes} хв (спроба {attempt}).',
  'apiRetry.usageLimitResetNotice':
    '🚧 Ліміт вичерпано — продовжу автоматично після скидання (~{time}).',
  'apiRetry.resuming': '↻ Продовжую…',
  'apiRetry.giveUp':
    '⚠️ Не вдалося відновити після {attempts} спроб. Напиши, коли продовжити.',
  'apiRetry.continueNudge': 'Продовжуй з того місця, де ти зупинився.',
  'apiRetry.loggedOutClaude':
    '⚠️ Claude вийшов із системи — виконай /login, щоб продовжити.',
  'apiRetry.loggedOutOpenCode':
    '⚠️ OpenCode: неправильні облікові дані — перезапусти opencode-сервер.',

  // ── startup readiness status (boot-time owner notice) ──
  'startup.ready':
    '✅ Готовий — я можу обробляти повідомлення в тредах бота й темах групи.',
  'startup.header_not_ready':
    '⚠️ Налаштування не завершено. Щоб почати роботу зі мною, будь ласка, виконай ці кроки:',
  'startup.item.create_group':
    'Створи forum-супергрупу з увімкненими темами (Topics), потім надішли мені там повідомлення, щоб її прив\'язати.',
  'startup.item.grant_admin':
    'Зроби мене адміністратором із такими правами: {missing}.',
  'startup.item.bind_topic':
    'Створи тему та прив\'яжи її до папки командою /bind.',
  'startup.item.install_agent':
    'Встанови агентський CLI — claude або opencode.',
  'startup.item.optional_groq':
    '(необов\'язково) Додай GROQ_API_KEY у свій .env і перезапусти, щоб увімкнути голосовий ввід.',
  'startup.item.optional_owner':
    '(необов\'язково) Задай OWNER_USER_ID, щоб отримувати цей статус у своєму приватному чаті.',
};
