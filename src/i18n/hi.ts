// Machine-translated from en. Native review welcome.

export const hiDict: Record<string, string> = {
  'access.denied': 'पहुँच अस्वीकृत।',
  'access.group_only': 'मैं केवल कॉन्फ़िगर किए गए फ़ोरम सुपरग्रुप में काम करता हूँ।',

  'thread.no_binding':
    '📁 यह थ्रेड किसी फ़ोल्डर से बाउंड नहीं है। /bind <subdir> का उपयोग करें या सूची से चुनें।',
  'thread.bind_required':
    '📁 पहले फ़ोल्डर बाइंड करें: /bind <subdir>। एजेंट केवल बाउंड फ़ोल्डर में चलता है।',
  'thread.bound': '📁 `{subdir}` से बाउंड।\n/claude या /opencode चलाएँ।',
  'thread.unbound': '📁 बाइंडिंग हटाई गई।',
  'thread.general_no_agent':
    'General किसी फ़ोल्डर से बाउंड नहीं है — एजेंट से बात करने के लिए एक विषय-वस्तु थ्रेड पर स्विच करें।',
  'thread.welcome_bound':
    '👋 थ्रेड बनाया गया और स्वतः `{subdir}` से बाउंड किया गया (थ्रेड नाम एक सबफ़ोल्डर से मेल खाया)।\n/claude या /opencode चलाएँ।',
  'thread.welcome_pick':
    '👋 थ्रेड बनाया गया। फ़ोल्डर बाइंड करें: /bind <subdir>, या नीचे से चुनें।',
  'thread.bind_collision':
    '⚠️ फ़ोल्डर `{subdir}` पहले से थ्रेड्स द्वारा उपयोग में है: {threads}.\nबाइंडिंग जोड़ी गई; सत्र स्वतंत्र रहते हैं (अपना tmux/SSE)।',
  'thread.no_agent_with_binding':
    '📁 फ़ोल्डर `{subdir}` बाउंड है। संवाद शुरू करने के लिए /claude या /opencode चलाएँ।',

  'bind.usage': 'उपयोग: /bind <subdir>\nउदाहरण: /bind overview',
  'bind.current': '📂 वर्तमान बाइंडिंग: `{subdir}`',
  'bind.current_none': '📂 अभी तक बाउंड नहीं',
  'bind.in_general': '/bind केवल विषय-वस्तु थ्रेड्स में काम करता है, General में नहीं।',
  'bind.invalid_chars': '❌ फ़ोल्डर नाम में नियंत्रण वर्ण नहीं होने चाहिए।',
  'bind.not_found': '❌ फ़ोल्डर `{subdir}` `WORK_ROOT` (`{workRoot}`) के अंतर्गत नहीं मिला।',
  'bind.outside_root': '❌ पथ `WORK_ROOT` के बाहर जाता है।',
  'bind.not_directory': '❌ `{subdir}` मौजूद है लेकिन एक फ़ोल्डर नहीं है।',

  'bind.leave_button': '⬅️ वर्तमान डायरेक्टरी छोड़ें',
  'bind.create_button': '➕ नया फ़ोल्डर बनाएँ',
  'bind.create_prompt':
    '✏️ नए फ़ोल्डर का नाम भेजें (`WORK_ROOT` के अंतर्गत बनाया जाएगा)। कोई भी कमांड रद्द करता है।',
  'bind.create_cb': 'नया फ़ोल्डर बनाया जा रहा है…',
  'bind.create_empty': '❌ नाम खाली है। फ़ोल्डर नाम भेजें।',
  'bind.create_separator': '❌ नाम में `/` या `\\` नहीं होना चाहिए। सरल नाम भेजें।',
  'bind.create_dot_segment': '❌ `.` और `..` को फ़ोल्डर नाम के रूप में नहीं इस्तेमाल किया जा सकता।',
  'bind.create_hidden': '❌ नाम बिंदु से शुरू नहीं होना चाहिए।',
  'bind.create_invalid_chars': '❌ फ़ोल्डर नाम में नियंत्रण वर्ण नहीं होने चाहिए।',
  'bind.create_exists': '📁 फ़ोल्डर `{subdir}` पहले से मौजूद है — बाइंड किया जा रहा है।',
  'bind.create_failed': '❌ फ़ोल्डर बनाने में विफल: {error}',

  'ls.header': '📁 `{workRoot}` के सबफ़ोल्डर:',
  'ls.empty': '📁 `WORK_ROOT` के अंतर्गत कोई बाइंड करने योग्य सबफ़ोल्डर नहीं।',
  'list.header': '🧵 थ्रेड बाइंडिंग ({count}):',
  'list.empty': '🧵 अभी तक कोई बाइंडिंग नहीं। एक थ्रेड बनाएँ और /bind चलाएँ।',
  'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
  'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
  'new.general_hint':
    '/new एक बाउंड टॉपिक के अंदर काम करता है — एक थ्रेड खोलें और उसके एजेंट सत्र को पुनः प्रारंभ करने के लिए /new चलाएँ।',

  'help.general':
    '*General में कमांड:*\n' +
    '/ls — `WORK_ROOT` सबफ़ोल्डर सूचीबद्ध करें\n' +
    '/list — थ्रेड सूचीबद्ध करें\n' +
    '/status — सभी थ्रेड्स की स्थिति\n' +
    '/quitall — हर चल रहे एजेंट को बंद करें\n' +
    '/whoami /version — डिबग\n\n' +
    'एजेंट से बात करने के लिए — एक विषय-वस्तु थ्रेड खोलें।',
  'help.thread_unbound':
    '*थ्रेड किसी फ़ोल्डर से बाउंड नहीं है।*\n' +
    '/bind <subdir> — बाइंड करें (या सूची से चुनें)\n' +
    '/ls — `WORK_ROOT` सबफ़ोल्डर (General में)',
  'help.thread_bound':
    '*थ्रेड `{subdir}` से बाउंड है।*\n' +
    '/claude /opencode — एजेंट शुरू करें\n' +
    '/connect — OpenCode प्रदाता API कुंजी कनेक्ट करें (डिफ़ॉल्ट OpenAI)\n' +
    '/terminal — इस फ़ोल्डर में शेल खोलें\n' +
    '/new — सत्र पुनः प्रारंभ करें (पुराना → /sessions)\n' +
    '/model /sessions — स्विच\n' +
    '/effort — reasoning effort स्तर\n' +
    '/verbosity — आउटपुट विस्तार (thinking/tools/सब-एजेंट)\n' +
    '/quit /status /output — नियंत्रण\n' +
    '/compact — एजेंट संदर्भ संक्षिप्त करें\n' +
    '/clear — थ्रेड संदेश हटाएँ\n' +
    '/c /y /n /enter /up /down /tab /esc — TUI कुंजी (Claude)\n' +
    '/bind — बाइंडिंग प्रबंधित करें',

  'doctor.header': '🔍 *TelegramCode Doctor*',
  'doctor.ok': '✅ {label}',
  'doctor.warn': '⚠️ {label} — {hint}',
  'doctor.fail': '❌ {label} — {hint}',
  'doctor.bot_admin': 'Bot ग्रुप एडमिन है',
  'doctor.can_manage_topics': '`can_manage_topics` प्रदान किया गया',
  'doctor.can_delete_messages': '`can_delete_messages` प्रदान किया गया',
  'doctor.can_pin_messages': '`can_pin_messages` प्रदान किया गया',
  'doctor.privacy_off': 'Privacy mode अक्षम',
  'doctor.privacy_hint':
    '@BotFather → /setprivacy → Disable, फिर Bot को हटाकर पुनः जोड़ें',
  'doctor.workroot_subdirs':
    '`WORK_ROOT`: `{workRoot}` ({count} सबफ़ोल्डर)',
  'doctor.datadir_path': '`DATA_DIR`: `{dataDir}`',
  'doctor.claude_installed': 'claude CLI स्थापित',
  'doctor.opencode_installed': 'opencode CLI स्थापित',
  'doctor.state_valid':
    'state.json मान्य ({bindings} बाइंडिंग, {active} सक्रिय)',
  'doctor.state_archived':
    'पिछला state.json दूषित था, संग्रह: {path}',
  'doctor.cli_missing':
    'PATH में नहीं मिला (/claude या /opencode पर ऑटो-इंस्टॉल चलेगा)',
  'doctor.no_admin_info':
    'Bot के अधिकार नहीं पढ़ सकते — getChatMember विफल',

  'onboarding.welcome':
    '👋 *TelegramCode Bot 2.0*\n\n' +
    'तैयारी चेकलिस्ट:\n' +
    '1️⃣ मुझे ग्रुप एडमिन बनाएँ अधिकारों के साथ:\n' +
    '   • Manage Topics, Delete Messages, Pin Messages\n' +
    '2️⃣ @BotFather → /setprivacy → Disable, फिर मुझे हटाकर पुनः जोड़ें\n' +
    '3️⃣ /doctor चलाएँ और देखें क्या कमी है\n' +
    '4️⃣ प्रत्येक विषय-वस्तु थ्रेड में /bind <subdir> चलाएँ और एजेंट शुरू करें\n\n' +
    '`WORK_ROOT`: `{workRoot}`',

  'binding.welcome.header': '📁 `{subdir}` से बाउंड',
  'binding.welcome.claude_md': '• CLAUDE.md: {size}',
  'binding.welcome.mcp_json': '• `.mcp.json`: {count} सर्वर',
  'binding.welcome.git': '• git: शाखा `{branch}`{detail}',
  'binding.welcome.git_clean': ', स्वच्छ',
  'binding.welcome.git_dirty': ', अप्रतिबद्ध परिवर्तन',
  'binding.welcome.git_none': '• git: प्रारंभ नहीं किया गया',
  'binding.welcome.start_prompt': 'एक बातचीत शुरू करें:',

  'mcp.header': '🔌 *इस थ्रेड के लिए MCP सर्वर:*',
  'mcp.row': '• `{name}` — {source}',
  'mcp.empty': '🔌 कोई MCP सर्वर कॉन्फ़िगर नहीं।',
  'mcp.source_user': 'user (~/.claude/settings.json)',
  'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
  'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
  'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

  'doctor.pin_hint': 'थ्रेड की पिन की गई स्थिति (Stage 7) अनुपलब्ध रहेगी',

  'whoami.report':
    '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
    '🔐 allowed: {allowed}\n📁 binding: {binding}',
  'whoami.binding_unbound': '(कोई बाइंडिंग नहीं)',

  'pair.success': '✅ ग्रुप जोड़ा गया। id: `{groupId}`। Bot अब इस सुपरग्रुप को सेवा दे रहा है।',
  'pair.locked':
    'ℹ️ ग्रुप id `ALLOWED_GROUP_ID` के माध्यम से सेट है — ऑटो-पेयरिंग अक्षम है। ' +
    'ग्रुप बदलने के लिए वेरिएबल बदलें और Bot पुनः प्रारंभ करें।',
  'pair.only_forum': '❌ /pair केवल फ़ोरम सुपरग्रुप में काम करता है (Topics सक्षम करें)।',
  'pair.not_admin': '❌ केवल ग्रुप व्यवस्थापक या निर्माता Bot को जोड़ सकता है।',
  'pair.not_paired': 'ग्रुप अभी तक जोड़ा नहीं गया (पेयरिंग मोड)',
  'pair.dm': "ℹ️ DM मोड में /pair की आवश्यकता नहीं — Bot आपकी निजी चैट सेवा देता है।",
  'version.report':
    '*TelegramCode {bot}*\n' +
    'Node: {node}\n' +
    'tmux: {tmux}\n' +
    'claude: {claude}\n' +
    'opencode: {opencode}',
  'version.unknown': '(अनुपलब्ध)',
  'status.global_header': '📊 *सभी थ्रेड्स* ({total}):',
  'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
  'status.global_empty': '📊 अभी तक कोई थ्रेड नहीं।',
  'language.status':
    '🌐 भाषा: `{current}` ({source})\nTelegram: {telegram}\nउपलब्ध: {locales}\n/language <locale> या /language auto इस्तेमाल करें।',
  'language.set_success': '✅ इस चैट की भाषा `{locale}` सेट की गई।',
  'language.auto_success': '✅ भाषा ऑटो पर रीसेट की गई। मौजूदा: `{locale}`।',
  'language.invalid': '⚠️ locale `{locale}` समर्थित नहीं है। उपलब्ध: {locales}.',
  'language.telegram_unknown': 'अज्ञात',
  'language.source.override': 'चैट सेटिंग',
  'language.source.telegram': 'Telegram प्रोफाइल',
  'language.source.storedTelegram': 'आखिरी देखी गई Telegram प्रोफाइल',
  'language.source.fallback': 'fallback',

  'agent.ready': '{label} `{subdir}`{argsSuffix} में तैयार\nएक संदेश भेजें:',
  'agent.no_session': 'कोई एजेंट नहीं चल रहा। /claude या /opencode से शुरू करें।',
  'agent.session_ended': '{label}: सत्र समाप्त',
  'agent.stopped': '{label} रुक गया',
  'agent.exit_signal_sent': 'दोहरा Ctrl+C भेजा गया — {label} बंद हो रहा है',
  'agent.already_active': '{label} पहले से यहाँ चल रहा है। संदेश भेजें या /quit।',
  'agent.starting': '`{subdir}` में {label} शुरू हो रहा है…',
  'agent.queued_starting': '⏳ {label} अभी शुरू हो रहा है — आपका संदेश कतार में है, तैयार होने पर भेजा जाएगा।',
  'agent.question_hint': 'ℹ️ विकल्प नंबर (जैसे 1) या y/n से उत्तर दें। और भी: /up /down चलाने के लिए, /enter पुष्टि करने, /c रद्द करने।',
  'agent.start_failed': '{label} शुरू करने में विफल: {error}',
  'agent.question_cancelled_for_prompt': '⚠️ पिछला प्रश्न रद्द — आपका नया अनुरोध चल रहा है।',
  'agent.question_cancelled_msg_label': '❌ प्रश्न रद्द: {header}',
  'agent.login_code_relayed': '🔐 लॉगिन कोड Claude को भेजा गया — टोकन संदेश इतिहास से हटाया गया।',
  'agent.workingIndicator': '{glyph} काम कर रहा है…',
  'terminal.ready': '🖥 `{subdir}`{argsSuffix} में टर्मिनल तैयार\nहर संदेश एक कमांड के रूप में चलता है। /c — Ctrl+C, /up /down — इतिहास, /tab — पूर्णता, /quit — बंद।',

  'effort.choose': '⚙️ वर्तमान effort: {current}\nएक स्तर चुनें:',
  'effort.current_none': 'सेट नहीं',
  'effort.set_success': '✅ Effort: {level}',
  'effort.invalid_level': '⚠️ स्तर `{level}` अमान्य है। उपलब्ध: {valid}।',
  'effort.not_available': 'ℹ️ वर्तमान मॉडल के लिए कोई reasoning effort स्तर उपलब्ध नहीं।',
  'effort.not_supported': 'ℹ️ मॉडल `{model}` में कोई reasoning effort स्तर नहीं है।',
  'effort.start_agent_first': 'ℹ️ स्तर सहेजा गया। कोई एजेंट नहीं चल रहा — अगली शुरुआत पर लागू होगा।',
  'effort.cleared_on_model_switch': 'ℹ️ Effort `{level}` हटाया गया: नया मॉडल `{model}` इसे समर्थन नहीं करता।',
  'effort.unsupported_backend': '{label} के लिए effort नियंत्रण समर्थित नहीं।',
  'effort.no_session': 'कोई एजेंट नहीं चल रहा। /claude या /opencode से एक शुरू करें।',

  'thinking.live': '•••',
  'thinking.thoughtForSeconds': '💭 {seconds} सेकंड तक सोचा',
  'thinking.choose': '☁️ वर्तमान thinking मोड: {current}\nएक मोड चुनें:',
  'thinking.set_success': '✅ Thinking मोड: {mode}',
  'thinking.invalid_mode': '⚠️ मोड `{mode}` अमान्य है। उपलब्ध: {valid}।',
  'thinking.mode.minimal': 'न्यून',
  'thinking.mode.short': 'संक्षिप्त',
  'thinking.mode.full': 'पूर्ण',

  'toolResults.choose': '🔧 वर्तमान टूल-परिणाम मोड: {current}\nएक मोड चुनें:',
  'toolResults.set_success': '✅ टूल-परिणाम मोड: {mode}',
  'toolResults.invalid_mode': '⚠️ मोड `{mode}` अमान्य है। उपलब्ध: {valid}।',
  'toolResults.mode.minimal': 'न्यून',
  'toolResults.mode.short': 'संक्षिप्त',
  'toolResults.mode.full': 'पूर्ण',
  'toolResults.truncated_footer': '… (संक्षिप्त, /tool_results full)',
  'toolResults.activity_status': '🔧 {tool} …',
  'toolResults.activity_fallback': 'टूल',

  'subagent.status_elapsed': '🤖 सब-एजेंट: {title} · {elapsed}',
  'subagent.panel_fold_status': '🤖 सब-एजेंट काम कर रहा है …',
  'subagent.delegating_status': '🤖 सौंपा जा रहा: {title} …',
  'subagent.chunk_prefix': '🤖 ⤷',
  'subagent.fallback_title': 'सब-एजेंट',
  'subagent.choose': '🤖 वर्तमान सब-एजेंट मोड: {current}\nएक मोड चुनें:',
  'subagent.set_success': '✅ सब-एजेंट मोड: {mode}',
  'subagent.invalid_mode': '⚠️ मोड `{mode}` अमान्य है। उपलब्ध: {valid}।',
  'subagent.mode.minimal': 'न्यून',
  'subagent.mode.short': 'संक्षिप्त',
  'subagent.mode.full': 'पूर्ण',

  'verbosity.choose': '🔊 वर्तमान आउटपुट विस्तार: {current}\nएक स्तर चुनें:',
  'verbosity.set_success': '✅ आउटपुट विस्तार: {mode} (thinking, टूल-परिणाम, सब-एजेंट)',
  'verbosity.invalid_mode': '⚠️ मोड `{mode}` अमान्य है। उपलब्ध: {valid}।',
  'verbosity.custom': 'कस्टम (thinking: {thinking} · टूल: {toolResults} · सब-एजेंट: {subagent})',
  'verbosity.mode.minimal': 'न्यून',
  'verbosity.mode.short': 'संक्षिप्त',
  'verbosity.mode.full': 'पूर्ण',

  'model.saved_for_next_start': 'मॉडल सहेजा गया: {model} — अगली एजेंट शुरुआत पर लागू।',
  'model.start_agent_first': 'कोई सक्रिय सत्र नहीं। पहले एक एजेंट शुरू करें।',

  'rename_session.usage': 'उपयोग: /rename_session <नया शीर्षक>',
  'rename_session.start_agent_first': 'कोई सक्रिय सत्र नहीं। पहले एक एजेंट शुरू करें (/claude या /opencode)।',
  'rename_session.unsupported_backend': '{label} के लिए सत्र नाम परिवर्तन समर्थित नहीं।',
  'rename_session.success': '✅ सत्र का नाम बदला गया: {title}',
  'rename_session.failed': '⚠️ सत्र का नाम बदलने में विफल: {reason}',

  'connect.prompt_key': '🔑 अगले संदेश में `{provider}` के लिए API key भेजें। मैं key संदेश को इतिहास से हटा दूँगा।',
  'connect.empty_key': '❌ API key खाली है। अगले संदेश में key भेजें।',
  'connect.invalid_provider': '❌ अमान्य प्रदाता id `{provider}`। उदाहरण: /connect openai',
  'connect.unsupported_provider': '⚠️ प्रदाता `{provider}` इस प्रवाह के माध्यम से सरल API-key लॉगिन का समर्थन नहीं करता। इस प्रदाता के लिए OpenCode UI/CLI का उपयोग करें।',
  'connect.unsupported_backend': 'इस बिल्ड में OpenCode प्रदाता प्रमाणीकरण उपलब्ध नहीं।',
  'connect.failed': '⚠️ `{provider}` कनेक्ट करने में विफल: {reason}',
  'connect.success': '✅ प्रदाता `{provider}` कनेक्ट हो गया। OpenCode सर्वर पुनः प्रारंभ नहीं हुआ।',
  'connect.cancelled': 'API key प्रविष्टि रद्द।',

  'quit_all.none_active': 'कोई एजेंट नहीं चल रहा — रोकने के लिए कुछ नहीं।',
  'quit_all.summary': '🚪 {total} में से {stopped} सक्रिय एजेंट बंद किए।',
  'quit_all.general_only': '`/quit-all` केवल General टॉपिक में उपलब्ध है।',

  'clearMessages.summary':
    '🗑 {total} में से {deleted} संदेश हटाए। ' +
    'Telegram 48 घंटे से पुराने संदेश हटाने से इनकार करता है — बाकी इतिहास में रहते हैं।',
  'clearMessages.no_messages': 'इस थ्रेड में हटाने के लिए कोई संदेश नहीं।',

  'edited.hint':
    '✏️ मैं संपादित संदेशों को नया इनपुट नहीं मानता — सुधार एक अलग संदेश के रूप में भेजें।',

  'voice.no_api_key':
    'वॉइस के लिए `GROQ_API_KEY` (मुफ़्त) या `OPENAI_API_KEY` चाहिए।',
  'voice.failed': 'वॉइस संदेश ट्रांसक्राइब करने में विफल।',
  'voice.transcribed': '🎤 {text}',

  'file.too_big':
    '📎 फ़ाइल Bot API सीमा ({cap} MB) से बड़ी है — मैं इसे डाउनलोड नहीं कर सकता। एक छोटी फ़ाइल भेजें।',
  'file.download_failed': '📎 फ़ाइल डाउनलोड करने में विफल। पुनः प्रयास करें।',

  'error.workdir.gone':
    '📁 फ़ोल्डर `{subdir}` डिस्क से गायब हो गया। /bind <newdir> चलाएँ।',
  'error.tg.thread.deleted':
    '⚠️ थ्रेड Telegram में हटा दिया गया; बाइंडिंग हटाई गई।',
  'error.tg.thread.closed':
    '🔒 थ्रेड {key} बंद है — अपने Telegram क्लाइंट में पुनः खोलें, या पूरी तरह हटाएँ।',
  'error.tg.perm.delete':
    '🔐 संदेश हटा नहीं सकते। Bot को `can_delete_messages` प्रदान करें।',
  'error.tg.perm.manage_topics':
    '🔐 `can_manage_topics` अनुपलब्ध। मुझे ग्रुप एडमिन बनाएँ।',
  'error.state.corrupted':
    '⚠️ state.json दूषित था; बाइंडिंग रीसेट की गई। आवश्यकतानुसार /bind पुनः चलाएँ।',
  'error.start_in_general':
    'General में एजेंट शुरू नहीं कर सकते — वह एक सेवा टॉपिक है। एक विषय-वस्तु थ्रेड खोलें।',

  'cb.access_denied': 'पहुँच अस्वीकृत',
  'cb.bind_only_topical': '/bind केवल विषय-वस्तु थ्रेड्स में काम करता है',
  'cb.binding_to': '{subdir} से बाइंड हो रहा है…',
  'cb.no_active_session': 'कोई सक्रिय सत्र नहीं',
  'cb.model_error': 'त्रुटि: {error}',
  'cb.model_set': 'मॉडल: {model}',
  'cb.not_supported': '{label} के लिए समर्थित नहीं',
  'cb.unknown_agent': 'अज्ञात एजेंट',
  'cb.agent_switched': '{label} पर स्विच किया',
  'cb.resume_only_topical': 'Resume केवल विषय-वस्तु थ्रेड्स में काम करता है',
  'cb.bind_folder_first': 'पहले /bind से फ़ोल्डर बाइंड करें',
  'cb.agent_not_running': 'एजेंट नहीं चल रहा',
  'cb.no_pending_question': 'कोई लंबित प्रश्न नहीं',
  'cb.invalid_option': 'अमान्य विकल्प',
  'cb.sent_option': 'भेजा: {option}',
  'cb.effort_set': 'Effort: {level}',
  'cb.effort_error': 'त्रुटि: {error}',
  'cb.claudeMode_already': 'पहले से सक्रिय',
  'cb.claudeMode_switching': 'स्विच कर रहा है…',
  'claudeMode.pick': '⚙️ Claude Code बैकएंड — वर्तमान: {label}\nएक बैकएंड चुनें (स्विच वही बातचीत बनाए रखता है):',
  'claudeMode.not_claude': "यह टॉपिक Claude Code पर नहीं है — /claude_mode केवल Claude का बैकएंड बदलता है।",
  'claudeMode.already': 'पहले से {label}।',
  'claudeMode.set_idle': '⚙️ Claude बैकएंड: {label} — अगली शुरुआत पर लागू।',
  'claudeMode.switched_resumed': '⚙️ {label} पर स्विच — वही बातचीत जारी।',
  'claudeMode.switched_fresh': '⚙️ {label} पर स्विच — नया सत्र शुरू।',
  'cb.thinking_set': 'Thinking: {mode}',
  'cb.thinking_error': 'त्रुटि: {error}',
  'cb.toolresults_set': 'टूल-परिणाम: {mode}',
  'cb.toolresults_error': 'त्रुटि: {error}',
  'cb.subagent_set': 'सब-एजेंट: {mode}',
  'cb.subagent_error': 'त्रुटि: {error}',
  'cb.verbosity_set': 'आउटपुट विस्तार: {mode}',
  'cb.verbosity_error': 'त्रुटि: {error}',

  'session.list_header': 'पुनः आरंभ करने योग्य सत्र ({label}):',
  'session.list_footer': 'पुनः आरंभ 1–{max} · बाहर निकलने के लिए 0 भेजें',
  'session.none': 'इस फ़ोल्डर में पुनः आरंभ करने योग्य कोई सत्र नहीं।',
  'session.cancelled': 'रद्द। सत्र चयनकर्ता बंद।',
  'session.invalid': 'अमान्य नंबर। 1 से {max} तक का मान दर्ज करें।',
  'session.resumed': 'सत्र पुनः आरंभ। अपना संदेश भेजें:',
  'session.resume_failed': 'सत्र पुनः आरंभ विफल: {error}',
  'session.expired': 'सत्र सूची पुरानी है। /sessions पुनः चलाएँ।',
  'session.load_failed': 'सत्र लोड करने में विफल।',

  'resume.context_header': '↩️ पुनः आरंभ — अंतिम {count} संदेश:',
  'resume.context_user_label': '👤',
  'resume.context_assistant_label': '🤖',

  'recap.missedCountHeader': '⚠️ Bot ऑफ़लाइन रहने पर {count} संदेश छूटे। सत्र का नवीनतम:',
  'recap.restartedFallbackHeader': '🔄 Bot पुनः प्रारंभ। सत्र का नवीनतम:',
  'recap.stillWorkingLine': '⏳ एजेंट अभी भी काम कर रहा है…',

  'trace.onThisThreadReply': '🔎 इस थ्रेड के लिए ट्रेस सक्षम।',
  'trace.offThisThreadReply': '🔎 इस थ्रेड के लिए ट्रेस अक्षम।',
  'trace.onAllThreadsReply': '🔎 सभी थ्रेड्स के लिए ट्रेस सक्षम।',
  'trace.offAllThreadsReply': '🔎 सभी जगह ट्रेस अक्षम («all» फ़्लैग और थ्रेड सूची साफ़)।',
  'trace.statusReply':
    '🔎 Trace — यह थ्रेड: {thisThread}\nसभी थ्रेड्स: {allThreads}\nट्रेस किए गए थ्रेड्स: {count}',
  'trace.statusOnLabel': 'चालू',
  'trace.statusOffLabel': 'बंद',
  'trace.usageHint': 'उपयोग: /trace on | off | on all | off all | (बिना तर्क — स्थिति)',

  'timestamps.onReply':
    '🕐 टाइमस्टैम्प सक्षम: एजेंट को भेजा गया प्रत्येक प्रॉम्प्ट पहली पंक्ति में समय प्राप्त करता है (टॉपिक में पोस्ट नहीं)।',
  'timestamps.offReply': '🕐 इस थ्रेड के लिए टाइमस्टैम्प अक्षम।',
  'timestamps.statusOnReply': '🕐 टाइमस्टैम्प: इस थ्रेड के लिए चालू।',
  'timestamps.statusOffReply': '🕐 टाइमस्टैम्प: इस थ्रेड के लिए बंद।',
  'timestamps.usageHint': 'उपयोग: /timestamps on | off | (बिना तर्क — स्थिति)',

  'schedule.fired':
    '⏰ शेड्यूल «{name}» ({schedule}){missedNote}\n\n{prompt}',
  'schedule.missedNote': ' — {time} पर छूटा, पकड़ रहा हूँ',
  'schedule.pausedUnbound':
    '⏸ रुके हुए शेड्यूल: {count} — टॉपिक अपने फ़ोल्डर से अनबाउंड हो गया। /bind उन्हें वापस लाएगा।',
  'schedule.resumedRebind': '▶️ शेड्यूल पुनः शुरू: {count} (अगला रन अब से पुनः गणना)।',
  'schedule.forwardPromptTemplate':
    'The user wants to schedule the following. Use the schedule_create / schedule_list / schedule_cancel MCP tools (cron for repeats, one-shot for a single run), translating any time phrasing into the right schedule, then confirm to the user IN HINDI what you scheduled.\n\nRequest: {text}',
  'schedule.interviewPromptTemplate':
    'The user invoked /schedule with no details. Ask them IN HINDI what prompt they want scheduled and WHEN (one-time or repeating). Once you have both, create it with the schedule_create MCP tool and confirm IN HINDI what you scheduled.',

  'apiRetry.transientNotice':
    '⏳ API दर-सीमित — {minutes} मिनट में स्वतः पुनः प्रयास (प्रयास {attempt})।',
  'apiRetry.usageLimitDelayNotice':
    '🚧 उपयोग सीमा पहुँची — {minutes} मिनट में पुनः प्रयास (प्रयास {attempt})।',
  'apiRetry.usageLimitResetNotice':
    '🚧 उपयोग सीमा पहुँची — रीसेट के बाद स्वतः पुनः ( ~{time})।',
  'apiRetry.resuming': '↻ पुनः शुरू…',
  'apiRetry.giveUp':
    '⚠️ {attempts} प्रयासों के बाद पुनः शुरू नहीं कर सका। जब जारी रखना हो तो संदेश भेजें।',
  'apiRetry.continueNudge': 'जहाँ रुके थे वहाँ से जारी रखें।',
  'apiRetry.loggedOutClaude':
    '⚠️ Claude लॉगआउट है — जारी रखने के लिए /login चलाएँ।',
  'apiRetry.loggedOutOpenCode':
    '⚠️ OpenCode: अमान्य क्रेडेंशियल — opencode सर्वर पुनः प्रारंभ करें।',
};
