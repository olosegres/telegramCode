/**
 * @description Canonical English catalog — the reference every other locale
 * falls back to. A key missing in any locale resolves here. When adding a new
 * key, add it here FIRST, then mirror it in every other locale file.
 */

export const enDict: Record<string, string> = {
  'access.denied': 'Access denied.',
  'access.group_only': 'I only work in the configured forum supergroup.',

  'thread.no_binding':
    '📁 This thread is not bound to a folder. Use /bind <subdir> or pick from the list.',
  'thread.bind_required':
    '📁 Bind a folder first: /bind <subdir>. The agent only ever runs inside the bound folder.',
  'thread.bound': '📁 Bound to `{subdir}`.\nRun /claude or /opencode.',
  'thread.unbound': '📁 Binding cleared.',
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

  'bind.usage': 'Usage: /bind <subdir>\nExample: /bind overview',
  'bind.current': '📂 Currently bound: `{subdir}`',
  'bind.current_none': '📂 Not bound yet',
  'bind.in_general': '/bind only works in topical threads, not in General.',
  'bind.invalid_chars': '❌ Folder name must not contain control characters.',
  'bind.not_found': '❌ Folder `{subdir}` not found under `WORK_ROOT` (`{workRoot}`).',
  'bind.outside_root': '❌ Path escapes `WORK_ROOT`.',
  'bind.not_directory': '❌ `{subdir}` exists but is not a directory.',

  'bind.leave_button': '⬅️ Leave current dir',
  'bind.create_button': '➕ Create new folder',
  'bind.create_prompt':
    '✏️ Send the new folder name (it will be created under `WORK_ROOT`). Any command cancels.',
  'bind.create_cb': 'Creating a new folder…',
  'bind.create_empty': '❌ Name is empty. Send a folder name.',
  'bind.create_separator': '❌ Name must not contain `/` or `\\`. Send a plain name.',
  'bind.create_dot_segment': '❌ `.` and `..` cannot be used as a folder name.',
  'bind.create_hidden': '❌ Name must not start with a dot.',
  'bind.create_invalid_chars': '❌ Folder name must not contain control characters.',
  'bind.create_exists': '📁 Folder `{subdir}` already exists — binding to it.',
  'bind.create_failed': '❌ Failed to create the folder: {error}',

  'ls.header': '📁 Subfolders of `{workRoot}`:',
  'ls.empty': '📁 No bindable subfolders under `WORK_ROOT`.',
  'list.header': '🧵 Thread bindings ({count}):',
  'list.empty': '🧵 No bindings yet. Create a thread and run /bind.',
  'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
  'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
  'new.general_hint':
    '/new works inside a bound topic — open a thread and run /new to restart its agent session.',

  'help.general':
    '*Commands in General:*\n' +
    '/ls — list `WORK_ROOT` subfolders\n' +
    '/list — list threads\n' +
    '/status — status of all threads\n' +
    '/quitall — quit every running agent\n' +
    '/whoami /version — debug\n\n' +
    'To talk to an agent — open a topical thread.',
  'help.thread_unbound':
    '*Thread is not bound to a folder.*\n' +
    '/bind <subdir> — bind (or pick from the list)\n' +
    '/ls — `WORK_ROOT` subfolders (in General)',
  'help.thread_bound':
    '*Thread bound to `{subdir}`.*\n' +
    '/claude /opencode — start an agent\n' +
    '/connect — connect an OpenCode provider API key (OpenAI by default)\n' +
    '/terminal — open a shell in this folder\n' +
    '/new — restart the session (old one → /sessions)\n' +
    '/model /sessions — switch\n' +
    '/effort — reasoning-effort level\n' +
    '/verbosity — output verbosity (thinking/tools/sub-agents)\n' +
    '/quit /status /output — control\n' +
    '/compact — compact agent context\n' +
    '/clear — delete thread messages\n' +
    '/c /y /n /enter /up /down /tab /esc — TUI keys (Claude)\n' +
    '/bind — manage binding',

  'doctor.header': '🔍 *TelegramCode Doctor*',
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

  'onboarding.welcome':
    '👋 *TelegramCode Bot 2.0*\n\n' +
    'Ready-to-work checklist:\n' +
    '1️⃣ Make me a group admin with rights:\n' +
    '   • Manage Topics, Delete Messages, Pin Messages\n' +
    '2️⃣ @BotFather → /setprivacy → Disable, then remove and re-add me\n' +
    '3️⃣ Run /doctor to see what is still missing\n' +
    '4️⃣ In each topical thread run /bind <subdir> and start an agent\n\n' +
    '`WORK_ROOT`: `{workRoot}`',

  'binding.welcome.header': '📁 Bound to `{subdir}`',
  'binding.welcome.claude_md': '• CLAUDE.md: {size}',
  'binding.welcome.mcp_json': '• `.mcp.json`: {count} servers',
  'binding.welcome.git': '• git: branch `{branch}`{detail}',
  'binding.welcome.git_clean': ', clean',
  'binding.welcome.git_dirty': ', uncommitted changes',
  'binding.welcome.git_none': '• git: not initialised',
  'binding.welcome.start_prompt': 'Start a conversation:',

  'mcp.header': '🔌 *MCP servers for this thread:*',
  'mcp.row': '• `{name}` — {source}',
  'mcp.empty': '🔌 No MCP servers configured.',
  'mcp.source_user': 'user (~/.claude/settings.json)',
  'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
  'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
  'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

  'doctor.pin_hint': 'Pinned thread status (Stage 7) will be unavailable',

  'whoami.report':
    '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
    '🔐 allowed: {allowed}\n📁 binding: {binding}',
  'whoami.binding_unbound': '(no binding)',

  'pair.success': '✅ Group paired. id: `{groupId}`. The bot is now serving this supergroup.',
  'pair.locked':
    'ℹ️ The group id is set via `ALLOWED_GROUP_ID` — auto-pairing is disabled. ' +
    'To switch groups, change the variable and restart the bot.',
  'pair.only_forum': '❌ /pair only works inside a forum supergroup (enable Topics).',
  'pair.not_admin': '❌ Only a group administrator or creator can pair the bot.',
  'pair.not_paired': 'group not paired yet (pairing mode)',
  'pair.dm': "ℹ️ /pair isn't needed in DM mode — the bot serves your private chat.",
  'version.report':
    '*TelegramCode {bot}*\n' +
    'Node: {node}\n' +
    'tmux: {tmux}\n' +
    'claude: {claude}\n' +
    'opencode: {opencode}',
  'version.unknown': '(unavailable)',
  'status.global_header': '📊 *All threads* ({total}):',
  'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
  'status.global_empty': '📊 No threads yet.',
  'status.thread_report': 'Status:\n\nAgent: {agent}\nFolder: {subdir}\nSession: {session}',
  'status.thread_model': 'Model: {model}',
  'status.thread_effort': 'Effort: {effort}',
  'status.thread_started': 'Started: {started}',
  'status.thread_running': 'running',
  'status.thread_stopped': 'stopped',
  'status.thread_no_agent': 'none (start /claude or /opencode)',
  'status.thread_no_binding': '(no binding — WORK_ROOT)',
  'status.thread_workdir': 'Working directory: {workDir}',
  'status.thread_runtime_version': 'Runtime version: {version}',
  'status.thread_context': 'Context: {used} / {limit} tokens',
  'language.status': '🌐 Language: {display}',
  'language.set_success': '✅ Language set to `{locale}` for this chat.',
  'language.auto_success': '✅ Language reset to auto. Current: {display}.',
  'language.invalid': '⚠️ Locale `{locale}` is not supported. Available: {locales}.',

  'agent.ready': '{label} ready in `{subdir}`{argsSuffix}\nSend a message:',
  'agent.no_session': 'No agent running. /claude or /opencode to start.',
  'agent.session_ended': '{label}: session ended',
  'agent.stopped': '{label} stopped',
  'agent.exit_signal_sent': 'Double Ctrl+C sent — {label} exiting',
  'agent.already_active': '{label} is already running here. Send a message or /quit.',
  'agent.starting': 'Starting {label} in `{subdir}`…',
  'agent.queued_starting': '⏳ {label} is still starting — your message is queued and will be sent once it is ready.',
  'agent.question_hint': 'ℹ️ Reply with the option number (e.g. 1) or y/n. Also: /up /down to move, /enter to confirm, /c to cancel.',
  'agent.start_failed': 'Failed to start {label}: {error}',
  'agent.no_response': '⚠️ The agent accepted your request but never started responding — the session may be stuck. Send it again, or /new to start a fresh session.',
  'agent.session_restarting': '⚠️ The agent didn\'t respond — the session looks stuck. Restarting it and re-running your request…',
  'agent.session_recovering': '⚠️ The agent didn\'t respond — recovering (your conversation is kept) and re-running your request…',
  'agent.question_cancelled_for_prompt': '⚠️ Previous question cancelled — running your new request.',
  'agent.question_cancelled_msg_label': '❌ Question cancelled: {header}',
  'agent.login_code_relayed': '🔐 Login code relayed to Claude — the token message was deleted from history.',
  'agent.login_url': '🔐 To sign in to Claude, open this link, complete sign-in, then paste the code back here:\n{url}',
  'agent.login_success': '✅ Signed in to Claude.',
  'agent.login_failed': '⚠️ Claude sign-in failed. Run /login to try again.',
  'agent.workingIndicator': '{glyph} working…',
  'terminal.ready': '🖥 Terminal ready in `{subdir}`{argsSuffix}\nEvery message runs as a command. /c — Ctrl+C, /up /down — history, /tab — completion, /quit — close.',

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

  'thinking.live': '•••',
  'thinking.thoughtForSeconds': '💭 thought for {seconds}s',
  'thinking.choose': '☁️ Current thinking mode: {current}\nPick a mode:',
  'thinking.set_success': '✅ Thinking mode: {mode}',
  'thinking.invalid_mode': '⚠️ Mode `{mode}` is not valid. Available: {valid}.',
  'thinking.mode.minimal': 'minimal',
  'thinking.mode.short': 'short',
  'thinking.mode.full': 'full',

  'toolResults.choose': '🔧 Current tool-results mode: {current}\nPick a mode:',
  'toolResults.set_success': '✅ Tool-results mode: {mode}',
  'toolResults.invalid_mode': '⚠️ Mode `{mode}` is not valid. Available: {valid}.',
  'toolResults.mode.minimal': 'minimal',
  'toolResults.mode.short': 'short',
  'toolResults.mode.full': 'full',
  'toolResults.truncated_footer': '… (truncated, /tool_results full)',
  'toolResults.activity_status': '🔧 {tool} …',
  'toolResults.activity_fallback': 'tool',

  'subagent.status_elapsed': '🤖 sub-agent: {title} · {elapsed}',
  'subagent.panel_fold_status': '🤖 sub-agent working …',
  'subagent.delegating_status': '🤖 Delegating: {title} …',
  'subagent.chunk_prefix': '🤖 ⤷',
  'subagent.fallback_title': 'sub-agent',
  'subagent.choose': '🤖 Current sub-agent mode: {current}\nPick a mode:',
  'subagent.set_success': '✅ Sub-agent mode: {mode}',
  'subagent.invalid_mode': '⚠️ Mode `{mode}` is not valid. Available: {valid}.',
  'subagent.mode.minimal': 'minimal',
  'subagent.mode.short': 'short',
  'subagent.mode.full': 'full',

  'verbosity.choose': '🔊 Current output verbosity: {current}\nPick a level:',
  'verbosity.set_success': '✅ Output verbosity: {mode} (thinking, tool results, sub-agents)',
  'verbosity.invalid_mode': '⚠️ Mode `{mode}` is not valid. Available: {valid}.',
  'verbosity.custom': 'custom (thinking: {thinking} · tools: {toolResults} · sub-agents: {subagent})',
  'verbosity.mode.minimal': 'minimal',
  'verbosity.mode.short': 'short',
  'verbosity.mode.full': 'full',

  'model.saved_for_next_start': 'Model saved: {model} — applies on next agent start.',
  'model.start_agent_first': 'No active session. Start an agent first.',

  'rename_session.usage': 'Usage: /rename_session <new title>',
  'rename_session.start_agent_first': 'No active session. Start an agent first (/claude or /opencode).',
  'rename_session.unsupported_backend': 'Session rename is not supported for {label}.',
  'rename_session.success': '✅ Session renamed: {title}',
  'rename_session.failed': '⚠️ Failed to rename the session: {reason}',

  'connect.prompt_key': '🔑 Send the API key for `{provider}` as the next message. I will delete the key message from history.',
  'connect.empty_key': '❌ API key is empty. Send the key as the next message.',
  'connect.invalid_key': '❌ That does not look like an API key (it has spaces or non-Latin characters). Send just the key as the next message, or run /connect again.',
  'connect.invalid_provider': '❌ Invalid provider id `{provider}`. Example: /connect openai',
  'connect.unsupported_provider': '⚠️ Provider `{provider}` does not support a simple API-key login through this flow. Use the OpenCode UI/CLI for this provider.',
  'connect.unsupported_backend': 'OpenCode provider auth is not available in this build.',
  'connect.failed': '⚠️ Failed to connect `{provider}`: {reason}',
  'connect.success': '✅ Provider `{provider}` connected. OpenCode server was not restarted.',
  'connect.cancelled': 'API key entry cancelled.',
  'connect.pick_method': 'How do you want to connect `{provider}`? Pick a method:',
  'connect.no_methods': '⚠️ No auth methods found for `{provider}`.',
  'connect.oauth_device': '🔓 To connect `{provider}`: open {url} and enter the code `{code}`, then authorize. On a server, use the *headless* method. I\'ll confirm here when it\'s done.',
  'connect.oauth_url_only': '🔓 To connect `{provider}`: open {url} and complete sign-in. I\'ll confirm here when it\'s done.',
  'connect.oauth_paste': '🔑 After authorizing, paste the code here as the next message — I\'ll delete it from history.',
  'connect.oauth_waiting': '⏳ Waiting for authorization…',
  'connect.oauth_loopback': '🔑 After authorizing, your browser will try to open a `localhost` page that fails to load — that\'s expected here. Copy that URL from the address bar and paste it back as the next message (or just the `code` value). I\'ll delete it from history and finish sign-in.',
  'connect.oauth_invalid_reply': '❌ That does not look like a callback URL or an auth code. After authorizing, paste the `localhost` callback URL from your browser (or the `code` value).',
  'connect.oauth_callback_no_flow': '⚠️ That looks like an OAuth callback URL, but no sign-in is in progress here — I deleted it. Run /connect to start again.',
  'connect.oauth_success': '✅ `{provider}` connected via OAuth. OpenCode server credentials were reloaded.',
  'connect.oauth_failed': '⚠️ OAuth sign-in for `{provider}` didn\'t complete. Run /connect to try again.',

  'quit_all.none_active': 'No agents running — nothing to stop.',
  'quit_all.summary': '🚪 Quit {stopped} of {total} active agents.',
  'quit_all.general_only': '`/quit-all` is only available in the General topic.',

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

  'file.too_big':
    '📎 File exceeds the Bot API limit ({cap} MB) — I can\'t download it. Send a smaller file.',
  'file.download_failed': '📎 Failed to download the file. Please try again.',

  'error.workdir.gone':
    '📁 Folder `{subdir}` is gone from disk. Run /bind <newdir>.',
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
  'cb.connect_method_expired': 'This connect menu expired — run /connect again',
  'cb.invalid_option': 'Invalid option',
  'cb.sent_option': 'Sent: {option}',
  'cb.effort_set': 'Effort: {level}',
  'cb.effort_error': 'Error: {error}',
  'cb.claudeMode_already': 'Already active',
  'cb.claudeMode_switching': 'Switching…',
  'claudeMode.pick': '⚙️ Claude Code backend — current: {label}\nPick a backend (switching keeps the same conversation):',
  'claudeMode.not_claude': "This topic isn't on Claude Code — /claude_mode only switches Claude's backend.",
  'claudeMode.already': 'Already {label}.',
  'claudeMode.set_idle': '⚙️ Claude backend: {label} — applies on next start.',
  'claudeMode.switched_resumed': '⚙️ Switched to {label} — same conversation resumed.',
  'claudeMode.switched_fresh': '⚙️ Switched to {label} — started a fresh session.',
  'cb.thinking_set': 'Thinking: {mode}',
  'cb.thinking_error': 'Error: {error}',
  'cb.toolresults_set': 'Tool results: {mode}',
  'cb.toolresults_error': 'Error: {error}',
  'cb.subagent_set': 'Sub-agents: {mode}',
  'cb.subagent_error': 'Error: {error}',
  'cb.verbosity_set': 'Output verbosity: {mode}',
  'cb.verbosity_error': 'Error: {error}',

  'session.list_header': 'Sessions to resume ({label}):',
  'session.list_footer': 'Send 1–{max} to resume · 0 to exit',
  'session.none': 'No resumable sessions in this folder.',
  'session.cancelled': 'Cancelled. Session picker closed.',
  'session.invalid': 'Invalid number. Enter a value from 1 to {max}.',
  'session.resumed': 'Session resumed. Send your message:',
  'session.resume_failed': 'Failed to resume session: {error}',
  'session.expired': 'Session list is stale. Run /sessions again.',
  'session.load_failed': 'Failed to load sessions.',

  'resume.context_header': '↩️ Resumed — last {count} messages:',
  'resume.context_user_label': '👤',
  'resume.context_assistant_label': '🤖',

  'recap.missedCountHeader': '⚠️ Missed {count} message(s) while the bot was down. Latest from the session:',
  'recap.restartedFallbackHeader': '🔄 Bot restarted. Latest from the session:',
  'recap.stillWorkingLine': '⏳ The agent is still working…',

  'trace.onThisThreadReply': '🔎 Tracing enabled for this thread.',
  'trace.offThisThreadReply': '🔎 Tracing disabled for this thread.',
  'trace.onAllThreadsReply': '🔎 Tracing enabled for ALL threads.',
  'trace.offAllThreadsReply': '🔎 Tracing disabled everywhere (the «all» flag and the thread list are cleared).',
  'trace.statusReply':
    '🔎 Trace — this thread: {thisThread}\nAll threads: {allThreads}\nTraced threads: {count}',
  'trace.statusOnLabel': 'on',
  'trace.statusOffLabel': 'off',
  'trace.usageHint': 'Usage: /trace on | off | on all | off all | (no arg — status)',

  'timestamps.onReply':
    '🕐 Timestamps enabled: every prompt forwarded to the agent gets the send time as its top line (never posted to the topic).',
  'timestamps.offReply': '🕐 Timestamps disabled for this thread.',
  'timestamps.statusOnReply': '🕐 Timestamps: on for this thread.',
  'timestamps.statusOffReply': '🕐 Timestamps: off for this thread.',
  'timestamps.usageHint': 'Usage: /timestamps on | off | (no arg — status)',

  'schedule.fired':
    '⏰ Schedule "{name}" ({schedule}){missedNote}\n\n{prompt}',
  'schedule.missedNote': ' — missed at {time}, catching up',
  'schedule.pausedUnbound':
    '⏸ Schedules paused: {count} — the topic was unbound from its folder. /bind will bring them back.',
  'schedule.resumedRebind': '▶️ Schedules resumed: {count} (next run recomputed from now).',
  'schedule.noAgent':
    '⚠️ Nothing scheduled — no agent is running in this topic, so a scheduled run would have nothing to launch. Start /claude or /opencode first.',
  'schedule.forwardPromptTemplate':
    'The user wants to schedule the following. Use the schedule_create / schedule_list / schedule_cancel MCP tools (cron for repeats, one-shot for a single run), translating any time phrasing into the right schedule, then confirm to the user IN ENGLISH what you scheduled.\n\nRequest: {text}',
  'schedule.interviewPromptTemplate':
    'The user invoked /schedule with no details. Ask them IN ENGLISH what prompt they want scheduled and WHEN (one-time or repeating). Once you have both, create it with the schedule_create MCP tool and confirm IN ENGLISH what you scheduled.',

  'apiRetry.transientNotice':
    '⏳ API rate-limited — auto-retrying in {minutes} min (attempt {attempt}).',
  'apiRetry.usageLimitDelayNotice':
    '🚧 Usage limit reached — retrying in {minutes} min (attempt {attempt}).',
  'apiRetry.usageLimitResetNotice':
    '🚧 Usage limit reached — will auto-resume after reset (~{time}).',
  'apiRetry.resuming': '↻ Resuming…',
  'apiRetry.giveUp':
    "⚠️ Couldn't resume after {attempts} attempts. Message me when to continue.",
  'apiRetry.continueNudge': 'Continue from where you left off.',
  'apiRetry.loggedOutClaude':
    '⚠️ Claude is logged out — run /login to continue.',
  'apiRetry.loggedOutOpenCode':
    '⚠️ OpenCode: invalid credentials — restart the opencode server.',

  // ── startup readiness status (boot-time owner notice) ──
  'startup.ready':
    '✅ Ready — I can handle messages in bot threads and group topics.',
  'startup.header_not_ready':
    '⚠️ Setup incomplete. To start working with me, please finish these steps:',
  'startup.item.create_group':
    'Create a forum supergroup with Topics enabled, then send me a message there to pair it.',
  'startup.item.grant_admin':
    'Make me an admin with these rights: {missing}.',
  'startup.item.bind_topic':
    'Create a topic and bind it to a folder with /bind.',
  'startup.item.install_agent':
    'Install an agent CLI — claude or opencode.',
  'startup.item.optional_groq':
    '(optional) Add GROQ_API_KEY to your .env and restart to enable voice input.',
  'startup.item.optional_owner':
    '(optional) Set OWNER_USER_ID to receive this status in your private chat.',
};
