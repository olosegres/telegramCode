// Machine-translated from en. Native review welcome.

export const kaDict: Record<string, string> = {
  'access.denied': 'წვდომა უარყოფილია.',
  'access.group_only': 'მე მხოლოდ კონფიგურირებულ ფორუმ სუპერჯგუფში ვმუშაობ.',

  'thread.no_binding':
    '📁 ეს თემა არ არის დაკავშირებული საქაღალდესთან. გამოიყენეთ /bind <subdir> ან აირჩიეთ სიიდან.',
  'thread.bind_required':
    '📁 ჯერ დააკავშირეთ საქაღალდე: /bind <subdir>. აგენტი მუშაობს მხოლოდ დაკავშირებულ საქაღალდეში.',
  'thread.bound': '📁 დაკავშირებულია `{subdir}`-თან.\nგაუშვით /claude ან /opencode.',
  'thread.unbound': '📁 კავშირი მოხსნილია.',
  'thread.general_no_agent':
    'General არ არის დაკავშირებული საქაღალდესთან — გადადით თემატურ თემაში აგენტთან სასაუბროდ.',
  'thread.welcome_bound':
    '👋 თემა შეიქმნა და ავტომატურად დაკავშირდა `{subdir}`-თან (თემის სახელი ემთხვევა ქვესაქაღალდეს).\nგაუშვით /claude ან /opencode.',
  'thread.welcome_pick':
    '👋 თემა შეიქმნა. დააკავშირეთ საქაღალდე: /bind <subdir>, ან აირჩიეთ ქვემოდან.',
  'thread.bind_collision':
    '⚠️ საქაღალდე `{subdir}` უკვე გამოიყენება თემების მიერ: {threads}.\nკავშირი დამატებულია; სესიები დარჩენილია დამოუკიდებელი (საკუთარი tmux/SSE).',
  'thread.no_agent_with_binding':
    '📁 საქაღალდე `{subdir}` დაკავშირებულია. გაუშვით /claude ან /opencode დიალოგის დასაწყებად.',

  'bind.usage': 'გამოყენება: /bind <subdir>\nმაგალითი: /bind overview',
  'bind.current': '📂 მიმდინარე კავშირი: `{subdir}`',
  'bind.current_none': '📂 ჯერ არ არის დაკავშირებული',
  'bind.in_general': '/bind მუშაობს მხოლოდ თემატურ თემებში, General-ში არა.',
  'bind.invalid_chars': '❌ საქაღალდის სახელი არ უნდა შეიცავდეს კონტროლის სიმბოლოებს.',
  'bind.not_found': '❌ საქაღალდე `{subdir}` ვერ მოიძებნა `WORK_ROOT`-ის ქვეშ (`{workRoot}`).',
  'bind.outside_root': '❌ ბილიკი გადადის `WORK_ROOT`-ის ფარგლებს გარეთ.',
  'bind.not_directory': '❌ `{subdir}` არსებობს, მაგრამ საქაღალდე არ არის.',

  'bind.leave_button': '⬅️ მიმდინარე დირექტორიის დატოვება',
  'bind.create_button': '➕ ახალი საქაღალდის შექმნა',
  'bind.create_prompt':
    '✏️ გამოგვიგზავნეთ ახალი საქაღალდის სახელი (შეიქმნება `WORK_ROOT`-ის ქვეშ). ნებისმიერი ბრძანება აუქმებს.',
  'bind.create_cb': 'ახალი საქაღალდის შექმნა…',
  'bind.create_empty': '❌ სახელი ცარიელია. გამოგვიგზავნეთ საქაღალდის სახელი.',
  'bind.create_separator': '❌ სახელი არ უნდა შეიცავდეს `/` ან `\\`. გამოგვიგზავნეთ მარტივი სახელი.',
  'bind.create_dot_segment': '❌ `.` და `..` არ შეიძლება გამოყენებულ იქნას როგორც საქაღალდის სახელი.',
  'bind.create_hidden': '❌ სახელი არ უნდა იწყებოდეს წერტილით.',
  'bind.create_invalid_chars': '❌ საქაღალდის სახელი არ უნდა შეიცავდეს კონტროლის სიმბოლოებს.',
  'bind.create_exists': '📁 საქაღალდე `{subdir}` უკვე არსებობს — მიმდინარეობს დაკავშირება.',
  'bind.create_failed': '❌ საქაღალდის შექმნა ვერ მოხერხდა: {error}',

  'ls.header': '📁 `{workRoot}`-ის ქვესაქაღალდეები:',
  'ls.empty': '📁 `WORK_ROOT`-ის ქვეშ დასაკავშირებელი ქვესაქაღალდეები არ არის.',
  'list.header': '🧵 თემების კავშირები ({count}):',
  'list.empty': '🧵 ჯერ კავშირები არ არის. შექმენით თემა და გაუშვით /bind.',
  'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
  'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
  'new.general_hint':
    '/new მუშაობს დაკავშირებულ თემაში — გახსენით თემა და გაუშვით /new მისი აგენტის სესიის გადასატვირთად.',

  'help.general':
    '*ბრძანებები General-ში:*\n' +
    '/ls — `WORK_ROOT` ქვესაქაღალდეების სია\n' +
    '/list — თემების სია\n' +
    '/status — ყველა თემის სტატუსი\n' +
    '/quitall — ყველა მომუშავე აგენტის გამორთვა\n' +
    '/whoami /version — გამართვა\n\n' +
    'აგენტთან სასაუბროდ — გახსენით თემატური თემა.',
  'help.thread_unbound':
    '*თემა არ არის დაკავშირებული საქაღალდესთან.*\n' +
    '/bind <subdir> — დაკავშირება (ან სიიდან არჩევა)\n' +
    '/ls — `WORK_ROOT` ქვესაქაღალდეები (General-ში)',
  'help.thread_bound':
    '*თემა დაკავშირებულია `{subdir}`-თან.*\n' +
    '/claude /opencode — აგენტის გაშვება\n' +
    '/connect — OpenCode პროვაიდერის API გასაღების დაკავშირება (ნაგულისხმევად OpenAI)\n' +
    '/terminal — shell-ის გახსნა ამ საქაღალდეში\n' +
    '/new — სესიის გადატვირთვა (ძველი → /sessions)\n' +
    '/model /sessions — გადართვა\n' +
    '/effort — reasoning effort დონე\n' +
    '/verbosity — გამოტანის დეტალურობა (thinking/tools/ქვე-აგენტები)\n' +
    '/quit /status /output — კონტროლი\n' +
    '/compact — აგენტის კონტექსტის შეკუმშვა\n' +
    '/clear — თემის შეტყობინებების წაშლა\n' +
    '/c /y /n /enter /up /down /tab /esc — TUI ღილაკები (Claude)\n' +
    '/bind — კავშირის მართვა',

  'doctor.header': '🔍 *TelegramCode Doctor*',
  'doctor.ok': '✅ {label}',
  'doctor.warn': '⚠️ {label} — {hint}',
  'doctor.fail': '❌ {label} — {hint}',
  'doctor.bot_admin': 'Bot არის ჯგუფის ადმინი',
  'doctor.can_manage_topics': '`can_manage_topics` მინიჭებულია',
  'doctor.can_delete_messages': '`can_delete_messages` მინიჭებულია',
  'doctor.can_pin_messages': '`can_pin_messages` მინიჭებულია',
  'doctor.privacy_off': 'Privacy mode გამორთულია',
  'doctor.privacy_hint':
    '@BotFather → /setprivacy → Disable, შემდეგ წაშალეთ და ხელახლა დაამატეთ Bot',
  'doctor.workroot_subdirs':
    '`WORK_ROOT`: `{workRoot}` ({count} ქვესაქაღალდე)',
  'doctor.datadir_path': '`DATA_DIR`: `{dataDir}`',
  'doctor.claude_installed': 'claude CLI დაყენებულია',
  'doctor.opencode_installed': 'opencode CLI დაყენებულია',
  'doctor.state_valid':
    'state.json ვალიდურია ({bindings} კავშირი, {active} აქტიური)',
  'doctor.state_archived':
    'წინა state.json დაზიანებული იყო, არქივი: {path}',
  'doctor.cli_missing':
    'PATH-ში ვერ მოიძებნა (ავტო-ინსტალაცია გაუშვება /claude ან /opencode-ზე)',
  'doctor.no_admin_info':
    'Bot-ის უფლებების წაკითხვა ვერ ხერხდება — getChatMember ვერ შედგა',

  'onboarding.welcome':
    '👋 *TelegramCode Bot 2.0*\n\n' +
    'მზადყოფის ჩეკლისტი:\n' +
    '1️⃣ გამახლეთ ჯგუფის ადმინად უფლებებით:\n' +
    '   • Manage Topics, Delete Messages, Pin Messages\n' +
    '2️⃣ @BotFather → /setprivacy → Disable, შემდეგ წამშალეთ და ხელახლა დაამატეთ\n' +
    '3️⃣ გაუშვით /doctor რა აკლია ნახვად\n' +
    '4️⃣ თითოეულ თემატურ თემაში გაუშვით /bind <subdir> და გაუშვით აგენტი\n\n' +
    '`WORK_ROOT`: `{workRoot}`',

  'binding.welcome.header': '📁 დაკავშირებულია `{subdir}`-თან',
  'binding.welcome.claude_md': '• CLAUDE.md: {size}',
  'binding.welcome.mcp_json': '• `.mcp.json`: {count} სერვერი',
  'binding.welcome.git': '• git: ბრენჩი `{branch}`{detail}',
  'binding.welcome.git_clean': ', სუფთა',
  'binding.welcome.git_dirty': ', დადასტურებული ცვლილებები',
  'binding.welcome.git_none': '• git: ინიციალიზებული არ არის',
  'binding.welcome.start_prompt': 'დაიწყეთ საუბარი:',

  'mcp.header': '🔌 *ამ თემისთვის MCP სერვერები:*',
  'mcp.row': '• `{name}` — {source}',
  'mcp.empty': '🔌 MCP სერვერები არ არის კონფიგურირებული.',
  'mcp.source_user': 'user (~/.claude/settings.json)',
  'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
  'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
  'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

  'doctor.pin_hint': 'თემის მიმაგრებული სტატუსი (Stage 7) მიუწვდომელი იქნება',

  'whoami.report':
    '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
    '🔐 allowed: {allowed}\n📁 binding: {binding}',
  'whoami.binding_unbound': '(კავშირი არ არის)',

  'pair.success': '✅ ჯგუფი დაკავშირდა. id: `{groupId}`. Bot ახლა ამ სუპერჯგუფს ემსახურება.',
  'pair.locked':
    'ℹ️ ჯგუფის id დაყენებულია `ALLOWED_GROUP_ID`-ით — ავტო-დაკავშირება გამორთულია. ' +
    'ჯგუფის შესაცვლელად შეცვალეთ ცვლადი და გადატვირთეთ Bot.',
  'pair.only_forum': '❌ /pair მუშაობს მხოლოდ ფორუმ სუპერჯგუფში (ჩართეთ Topics).',
  'pair.not_admin': '❌ მხოლოდ ჯგუფის ადმინისტრატორი ან შემქმნელი შეიძლება დააკავშიროს Bot.',
  'pair.not_paired': 'ჯგუფი ჯერ არ არის დაკავშირებული (დაკავშირების რეჟიმი)',
  'pair.dm': "ℹ️ DM რეჟიმში /pair არ არის საჭირო — Bot ემსახურება თქვენს პირად ჩატს.",
  'version.report':
    '*TelegramCode {bot}*\n' +
    'Node: {node}\n' +
    'tmux: {tmux}\n' +
    'claude: {claude}\n' +
    'opencode: {opencode}',
  'version.unknown': '(მიუწვდომელი)',
  'status.global_header': '📊 *ყველა თემა* ({total}):',
  'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
  'status.global_empty': '📊 ჯერ თემები არ არის.',
  'language.status':
    '🌐 ენა: {display} · {source}\nTelegram: {telegram}',
  'language.set_success': '✅ ამ ჩატის ენა დაყენდა `{locale}`-ზე.',
  'language.auto_success': '✅ ენა დაბრუნდა ავტომატურ რეჟიმზე. მიმდინარე: {display}.',
  'language.invalid': '⚠️ locale `{locale}` არ არის მხარდაჭერილი. ხელმისაწვდომია: {locales}.',
  'language.telegram_unknown': 'უცნობია',
  'language.source.override': 'ჩატის პარამეტრი',
  'language.source.telegram': 'Telegram პროფილი',
  'language.source.storedTelegram': 'ბოლოს ნანახი Telegram პროფილი',
  'language.source.fallback': 'fallback',

  'agent.ready': '{label} მზადაა `{subdir}`{argsSuffix}-ში\nგამოგვიგზავნეთ შეტყობინება:',
  'agent.no_session': 'აგენტი არ არის გაშვებული. /claude ან /opencode გასაშვებად.',
  'agent.session_ended': '{label}: სესია დასრულდა',
  'agent.stopped': '{label} გაჩერდა',
  'agent.exit_signal_sent': 'ორმაგი Ctrl+C გაგზავნილია — {label} იხურება',
  'agent.already_active': '{label} უკვე მუშაობს აქ. გამოგვიგზავნეთ შეტყობინება ან /quit.',
  'agent.starting': 'გაშვება {label} `{subdir}`-ში…',
  'agent.queued_starting': '⏳ {label} ჯერ იწყება — თქვენი შეტყობინება რიგშია და გაგზავნილი იქნება როგორც კი მზად იქნება.',
  'agent.question_hint': 'ℹ️ უპასუხეთ ვარიანტის ნომრით (მაგ. 1) ან y/n. ასევე: /up /down გადასაადგილებლად, /enter დასადასტურებლად, /c გასაუქმებლად.',
  'agent.start_failed': '{label}-ის გაშვება ვერ მოხერხდა: {error}',
  'agent.question_cancelled_for_prompt': '⚠️ წინა შეკითხვა გაუქმებულია — თქვენი ახალი მოთხოვნა მუშაობს.',
  'agent.question_cancelled_msg_label': '❌ შეკითხვა გაუქმებულია: {header}',
  'agent.login_code_relayed': '🔐 შესვლის კოდი გადაგზავნილია Claude-სთვის — ტოკენის შეტყობინება ისტორიიდან წაშლილია.',
  'agent.workingIndicator': '{glyph} ვმუშაობ…',
  'terminal.ready': '🖥 ტერმინალი მზადაა `{subdir}`{argsSuffix}-ში\nთითოეული შეტყობინება შესრულდება როგორც ბრძანება. /c — Ctrl+C, /up /down — ისტორია, /tab — შევსება, /quit — დახურვა.',

  'effort.choose': '⚙️ მიმდინარე effort: {current}\nაირჩიეთ დონე:',
  'effort.current_none': 'არ არის დაყენებული',
  'effort.set_success': '✅ Effort: {level}',
  'effort.invalid_level': '⚠️ დონე `{level}` არასწორია. ხელმისაწვდომი: {valid}.',
  'effort.not_available': 'ℹ️ მიმდინარე მოდელისთვის reasoning effort დონეები არ არის ხელმისაწვდომი.',
  'effort.not_supported': 'ℹ️ მოდელს `{model}` არ აქვს reasoning effort დონეები.',
  'effort.start_agent_first': 'ℹ️ დონე შენახულია. აგენტი არ არის გაშვებული — მოქმედებს შემდეგ გაშვებაზე.',
  'effort.cleared_on_model_switch': 'ℹ️ Effort `{level}` გასუფთავდა: ახალი მოდელი `{model}` არ უჭერს მხარს.',
  'effort.unsupported_backend': '{label}-ისთვის effort კონტროლი არ არის მხარდაჭერილი.',
  'effort.no_session': 'აგენტი არ არის გაშვებული. გაუშვით /claude ან /opencode.',

  'thinking.live': '•••',
  'thinking.thoughtForSeconds': '💭 {seconds}წმ ფიქრობდა',
  'thinking.choose': '☁️ მიმდინარე thinking რეჟიმი: {current}\nაირჩიეთ რეჟიმი:',
  'thinking.set_success': '✅ Thinking რეჟიმი: {mode}',
  'thinking.invalid_mode': '⚠️ რეჟიმი `{mode}` არასწორია. ხელმისაწვდომი: {valid}.',
  'thinking.mode.minimal': 'მინიმალური',
  'thinking.mode.short': 'მოკლე',
  'thinking.mode.full': 'სრული',

  'toolResults.choose': '🔧 მიმდინარე ხელსაწყოს-შედეგის რეჟიმი: {current}\nაირჩიეთ რეჟიმი:',
  'toolResults.set_success': '✅ ხელსაწყოს-შედეგის რეჟიმი: {mode}',
  'toolResults.invalid_mode': '⚠️ რეჟიმი `{mode}` არასწორია. ხელმისაწვდომი: {valid}.',
  'toolResults.mode.minimal': 'მინიმალური',
  'toolResults.mode.short': 'მოკლე',
  'toolResults.mode.full': 'სრული',
  'toolResults.truncated_footer': '… (შეკვეცილი, /tool_results full)',
  'toolResults.activity_status': '🔧 {tool} …',
  'toolResults.activity_fallback': 'ხელსაწყო',

  'subagent.status_elapsed': '🤖 ქვე-აგენტი: {title} · {elapsed}',
  'subagent.panel_fold_status': '🤖 ქვე-აგენტი მუშაობს …',
  'subagent.delegating_status': '🤖 დელეგირება: {title} …',
  'subagent.chunk_prefix': '🤖 ⤷',
  'subagent.fallback_title': 'ქვე-აგენტი',
  'subagent.choose': '🤖 მიმდინარე ქვე-აგენტის რეჟიმი: {current}\nაირჩიეთ რეჟიმი:',
  'subagent.set_success': '✅ ქვე-აგენტის რეჟიმი: {mode}',
  'subagent.invalid_mode': '⚠️ რეჟიმი `{mode}` არასწორია. ხელმისაწვდომი: {valid}.',
  'subagent.mode.minimal': 'მინიმალური',
  'subagent.mode.short': 'მოკლე',
  'subagent.mode.full': 'სრული',

  'verbosity.choose': '🔊 მიმდინარე გამოტანის დეტალურობა: {current}\nაირჩიეთ დონე:',
  'verbosity.set_success': '✅ გამოტანის დეტალურობა: {mode} (thinking, ხელსაწყოს შედეგები, ქვე-აგენტები)',
  'verbosity.invalid_mode': '⚠️ რეჟიმი `{mode}` არასწორია. ხელმისაწვდომი: {valid}.',
  'verbosity.custom': 'მორგინილი (thinking: {thinking} · ხელსაწყოები: {toolResults} · ქვე-აგენტები: {subagent})',
  'verbosity.mode.minimal': 'მინიმალური',
  'verbosity.mode.short': 'მოკლე',
  'verbosity.mode.full': 'სრული',

  'model.saved_for_next_start': 'მოდელი შენახულია: {model} — მოქმედებს შემდეგ აგენტის გაშვებაზე.',
  'model.start_agent_first': 'აქტიური სესია არ არის. ჯერ გაუშვით აგენტი.',

  'rename_session.usage': 'გამოყენება: /rename_session <ახალი სათაური>',
  'rename_session.start_agent_first': 'აქტიური სესია არ არის. ჯერ გაუშვით აგენტი (/claude ან /opencode).',
  'rename_session.unsupported_backend': '{label}-ისთვის სესიის სახელის შეცვლა არ არის მხარდაჭერილი.',
  'rename_session.success': '✅ სესიის სახელი შეიცვალა: {title}',
  'rename_session.failed': '⚠️ სესიის სახელის შეცვლა ვერ მოხერხდა: {reason}',

  'connect.prompt_key': '🔑 შემდეგ შეტყობინებად გამოგვიგზავნეთ `{provider}`-ის API გასაღები. გასაღების შეტყობინებას ისტორიიდან წავშლი.',
  'connect.empty_key': '❌ API გასაღები ცარიელია. შემდეგ შეტყობინებად გამოგვიგზავნეთ გასაღები.',
  'connect.invalid_provider': '❌ არასწორი პროვაიდერის id `{provider}`. მაგალითი: /connect openai',
  'connect.unsupported_provider': '⚠️ პროვაიდერი `{provider}` არ უჭერს მხარს მარტივი API-გასაღებით შესვლას ამ პროცესით. გამოიყენეთ OpenCode UI/CLI ამ პროვაიდერისთვის.',
  'connect.unsupported_backend': 'ამ ბილდში OpenCode პროვაიდერის ავთენტიფიკაცია მიუწვდომელია.',
  'connect.failed': '⚠️ `{provider}`-ის დაკავშირება ვერ მოხერხდა: {reason}',
  'connect.success': '✅ პროვაიდერი `{provider}` დაკავშირდა. OpenCode სერვერი არ გადატვირთულა.',
  'connect.cancelled': 'API გასაღების შეყვანა გაუქმებულია.',

  'quit_all.none_active': 'აგენტები არ არის გაშვებული — გასაჩერებელი არაფერია.',
  'quit_all.summary': '🚪 გაჩერდა {stopped} / {total} აქტიური აგენტი.',
  'quit_all.general_only': '`/quit-all` ხელმისაწვდომია მხოლოდ General თემაში.',

  'clearMessages.summary':
    '🗑 წაიშალა {deleted} / {total} შეტყობინება. ' +
    'Telegram უარყოფს 48 საათზე ძველი შეტყობინებების წაშლას — დანარჩენი რჩება ისტორიაში.',
  'clearMessages.no_messages': 'ამ თემაში წასაშლელი შეტყობინებები არ არის.',

  'edited.hint':
    '✏️ მე არ მივიჩნევ შესწორებულ შეტყობინებებს როგორც ახალ შეყვანას — გამოგვიგზავნეთ შესწორება ცალკე შეტყობინებად.',

  'voice.no_api_key':
    'ხმისთვის სჭირდება `GROQ_API_KEY` (უფასო) ან `OPENAI_API_KEY`.',
  'voice.failed': 'ხმოვანი შეტყობინების ტრანსკრიფცია ვერ მოხერხდა.',
  'voice.transcribed': '🎤 {text}',

  'file.too_big':
    '📎 ფაილი აღემატება Bot API ზღვარს ({cap} მბ) — ვერ გადმოწერ. გამოგვიგზავნეთ უფრო მცირე ფაილი.',
  'file.download_failed': '📎 ფაილის გადმოწერა ვერ მოხერხდა. კიდევ სცადეთ.',

  'error.workdir.gone':
    '📁 საქაღალდე `{subdir}` დისკიდან გაქრა. გაუშვით /bind <newdir>.',
  'error.tg.thread.deleted':
    '⚠️ თემა წაიშალა Telegram-ში; კავშირი გასუფთავდა.',
  'error.tg.thread.closed':
    '🔒 თემა {key} დახურულია — ხელახლა გახსენით თქვენს Telegram კლიენტში, ან სრულად წაშალეთ.',
  'error.tg.perm.delete':
    '🔐 შეტყობინებების წაშლა ვერ ხერხდება. მიეცით Bot-ს `can_delete_messages`.',
  'error.tg.perm.manage_topics':
    '🔐 `can_manage_topics` აკლია. გამახლეთ ჯგუფის ადმინად.',
  'error.state.corrupted':
    '⚠️ state.json დაზიანებული იყო; კავშირები გადატვირთულია. სადცა საჭიროა ხელახლა გაუშვით /bind.',
  'error.start_in_general':
    'General-ში აგენტს ვერ გაუშვებთ — ეს სერვისის თემაა. გახსენით თემატური თემა.',

  'cb.access_denied': 'წვდომა უარყოფილია',
  'cb.bind_only_topical': '/bind მუშაობს მხოლოდ თემატურ თემებში',
  'cb.binding_to': 'დაკავშირება {subdir}-თან…',
  'cb.no_active_session': 'აქტიური სესია არ არის',
  'cb.model_error': 'შეცდომა: {error}',
  'cb.model_set': 'მოდელი: {model}',
  'cb.not_supported': '{label}-ისთვის არ არის მხარდაჭერილი',
  'cb.unknown_agent': 'უცნობი აგენტი',
  'cb.agent_switched': 'გადართულია {label}-ზე',
  'cb.resume_only_topical': 'Resume მუშაობს მხოლოდ თემატურ თემებში',
  'cb.bind_folder_first': 'ჯერ დააკავშირეთ საქაღალდე /bind-ით',
  'cb.agent_not_running': 'აგენტი არ არის გაშვებული',
  'cb.no_pending_question': 'მოლოდინის შეკითხვა არ არის',
  'cb.invalid_option': 'არასწორი ვარიანტი',
  'cb.sent_option': 'გაგზავნილია: {option}',
  'cb.effort_set': 'Effort: {level}',
  'cb.effort_error': 'შეცდომა: {error}',
  'cb.claudeMode_already': 'უკვე აქტიურია',
  'cb.claudeMode_switching': 'გადართვა…',
  'claudeMode.pick': '⚙️ Claude Code ბექენდი — მიმდინარე: {label}\nაირჩიეთ ბექენდი (გადართვა ინარჩუნებს იგივე საუბარს):',
  'claudeMode.not_claude': "ეს თემა Claude Code-ზე არ არის — /claude_mode მხოლოდ Claude-ის ბექენდს ცვლის.",
  'claudeMode.already': 'უკვე {label}.',
  'claudeMode.set_idle': '⚙️ Claude ბექენდი: {label} — მოქმედებს შემდეგ გაშვებაზე.',
  'claudeMode.switched_resumed': '⚙️ გადართულია {label}-ზე — იგივე საუბარი გაგრძელდა.',
  'claudeMode.switched_fresh': '⚙️ გადართულია {label}-ზე — ახალი სესია დაიწყო.',
  'cb.thinking_set': 'Thinking: {mode}',
  'cb.thinking_error': 'შეცდომა: {error}',
  'cb.toolresults_set': 'ხელსაწყოს შედეგები: {mode}',
  'cb.toolresults_error': 'შეცდომა: {error}',
  'cb.subagent_set': 'ქვე-აგენტები: {mode}',
  'cb.subagent_error': 'შეცდომა: {error}',
  'cb.verbosity_set': 'გამოტანის დეტალურობა: {mode}',
  'cb.verbosity_error': 'შეცდომა: {error}',

  'session.list_header': 'გასაგრძელებელი სესიები ({label}):',
  'session.list_footer': 'გამოგვიგზავნეთ 1–{max} გასაგრძელებლად · 0 გასასვლელად',
  'session.none': 'ამ საქაღალდეში გასაგრძელებელი სესიები არ არის.',
  'session.cancelled': 'გაუქმებულია. სესიის არჩევა დახურულია.',
  'session.invalid': 'არასწორი ნომერი. შეიყვანეთ მნიშვნელობა 1-დან {max}-მდე.',
  'session.resumed': 'სესია გაგრძელდა. გამოგვიგზავნეთ შეტყობინება:',
  'session.resume_failed': 'სესიის გაგრძელება ვერ მოხერხდა: {error}',
  'session.expired': 'სესიების სია მოძველდა. ხელახლა გაუშვით /sessions.',
  'session.load_failed': 'სესიების ჩატვირთვა ვერ მოხერხდა.',

  'resume.context_header': '↩️ გაგრძელდა — ბოლო {count} შეტყობინება:',
  'resume.context_user_label': '👤',
  'resume.context_assistant_label': '🤖',

  'recap.missedCountHeader': '⚠️ Bot-ის გათიშვისას {count} შეტყობინება გამოტოვდა. სესიის უახლესი:',
  'recap.restartedFallbackHeader': '🔄 Bot გადატვირთულია. სესიის უახლესი:',
  'recap.stillWorkingLine': '⏳ აგენტი ჯერ კიდევ მუშაობს…',

  'trace.onThisThreadReply': '🔎 ტრეისიng ჩართულია ამ თემისთვის.',
  'trace.offThisThreadReply': '🔎 ტრეისიng გამორთულია ამ თემისთვის.',
  'trace.onAllThreadsReply': '🔎 ტრეისიng ჩართულია ყველა თემისთვის.',
  'trace.offAllThreadsReply': '🔎 ტრეისიng გამორთულია ყველგან («all» ალამი და თემების სია გასუფთავდა).',
  'trace.statusReply':
    '🔎 Trace — ეს თემა: {thisThread}\nყველა თემა: {allThreads}\nტრეისინგის თემები: {count}',
  'trace.statusOnLabel': 'ჩართული',
  'trace.statusOffLabel': 'გამორთული',
  'trace.usageHint': 'გამოყენება: /trace on | off | on all | off all | (არგუმენტის გარეშე — სტატუსი)',

  'timestamps.onReply':
    '🕐 დროის შტამპები ჩართულია: აგენტისთვის გადაგზავნილი თითოეული ბრძანება იღებს გაგზავნის დროს როგორც პირველ ხაზზე (თემაში არასოდეს ქვეყნდება).',
  'timestamps.offReply': '🕐 დროის შტამპები გამორთულია ამ თემისთვის.',
  'timestamps.statusOnReply': '🕐 დროის შტამპები: ჩართულია ამ თემისთვის.',
  'timestamps.statusOffReply': '🕐 დროის შტამპები: გამორთულია ამ თემისთვის.',
  'timestamps.usageHint': 'გამოყენება: /timestamps on | off | (არგუმენტის გარეშე — სტატუსი)',

  'schedule.fired':
    '⏰ განრიგი «{name}» ({schedule}){missedNote}\n\n{prompt}',
  'schedule.missedNote': ' — გამოტოვებულია {time}-ზე, მიწევს',
  'schedule.pausedUnbound':
    '⏸ შეჩერებული განრიგები: {count} — თემა მოხსნილია თავის საქაღალდიდან. /bind დააბრუნებს მათ.',
  'schedule.resumedRebind': '▶️ განრიგები გაგრძელდა: {count} (შემდეგი გაშვება ხელახლა გამოითვლება ახლანდელი დროიდან).',
  'schedule.forwardPromptTemplate':
    'The user wants to schedule the following. Use the schedule_create / schedule_list / schedule_cancel MCP tools (cron for repeats, one-shot for a single run), translating any time phrasing into the right schedule, then confirm to the user IN GEORGIAN what you scheduled.\n\nRequest: {text}',
  'schedule.interviewPromptTemplate':
    'The user invoked /schedule with no details. Ask them IN GEORGIAN what prompt they want scheduled and WHEN (one-time or repeating). Once you have both, create it with the schedule_create MCP tool and confirm IN GEORGIAN what you scheduled.',

  'apiRetry.transientNotice':
    '⏳ API სიხშირით შეზღუდული — ავტომატური ხელახლე ცდა {minutes} წუთში (მცდელობა {attempt}).',
  'apiRetry.usageLimitDelayNotice':
    '🚧 გამოყენების ზღვარს მიაღწია — ხელახლე ცდა {minutes} წუთში (მცდელობა {attempt}).',
  'apiRetry.usageLimitResetNotice':
    '🚧 გამოყენების ზღვარს მიაღწია — ავტომატური გაგრძელება გადატვირთვის შემდეგ (~{time}).',
  'apiRetry.resuming': '↻ გაგრძელება…',
  'apiRetry.giveUp':
    '⚠️ {attempts} ცდის შემდეგ ვერ გაგრძელდა. როცა გაგრძელება გსურთ გამოგვიგზავნეთ შეტყობინება.',
  'apiRetry.continueNudge': 'გააგრძელე იმ ადგილიდან, სადაც გაჩერდი.',
  'apiRetry.loggedOutClaude':
    '⚠️ Claude გამოსულია — გასაგრძელებლად გაუშვით /login.',
  'apiRetry.loggedOutOpenCode':
    '⚠️ OpenCode: არასწორი ავტორიზაციის მონაცემები — გადატვირთეთ opencode სერვერი.',

  // ── startup readiness status (boot-time owner notice) ──
  'startup.ready':
    '✅ მზადაა — შემიძლია დავამუშავო შეტყობინებები თქვენს თემებსა და ჯგუფში.',
  'startup.header_not_ready':
    '⚠️ კონფიგურაცია დაუსრულებელია. ჩემთან სამუშაოდ, გთხოვთ, დაასრულოთ ეს ნაბიჯები:',
  'startup.item.create_group':
    'შექმენით ფორუმ-სუპერჯგუფი ჩართული თემებით (Topics) და მომწერეთ იქ, რომ დაწყვილდეს.',
  'startup.item.grant_admin':
    'გამხადეთ ადმინი შემდეგი უფლებებით: {missing}.',
  'startup.item.bind_topic':
    'შექმენით თემა და მიაბით საქაღალდეს /bind ბრძანებით.',
  'startup.item.install_agent':
    'დააინსტალირეთ აგენტის CLI — claude ან opencode.',
  'startup.item.optional_groq':
    '(არასავალდებულო) ხმოვანი შეყვანის ჩასართავად დაამატეთ GROQ_API_KEY თქვენს .env-ში და გადატვირთეთ.',
  'startup.item.optional_owner':
    '(არასავალდებულო) დააყენეთ OWNER_USER_ID, რომ ეს სტატუსი მიიღოთ თქვენს პირად ჩატში.',
};
