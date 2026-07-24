// Machine-translated from en. Native review welcome.

export const deDict: Record<string, string> = {
  'access.denied': 'Zugriff verweigert.',
  'access.group_only': 'Ich arbeite nur in der konfigurierten Forum-Supergroup.',

  'thread.no_binding':
    '📁 Dieser Thread ist nicht mit einem Ordner verknüpft. Verwende /bind <subdir> oder wähle aus der Liste.',
  'thread.bind_required':
    '📁 Verknüpfe zuerst einen Ordner: /bind <subdir>. Der Agent läuft nur im verknüpften Ordner.',
  'thread.bound': '📁 Verknüpft mit `{subdir}`.\nStarte /claude oder /opencode.',
  'thread.unbound': '📁 Verknüpfung aufgehoben.',
  'thread.general_no_agent':
    'General ist nicht mit einem Ordner verknüpft — wechsle in einen thematischen Thread, um mit einem Agent zu sprechen.',
  'thread.welcome_bound':
    '👋 Thread erstellt und automatisch mit `{subdir}` verknüpft (Thread-Name passte zu einem Unterordner).\nStarte /claude oder /opencode.',
  'thread.welcome_pick':
    '👋 Thread erstellt. Verknüpfe einen Ordner: /bind <subdir>, oder wähle einen aus der Liste.',
  'thread.bind_collision':
    '⚠️ Ordner `{subdir}` wird bereits von Threads verwendet: {threads}.\nVerknüpfung hinzugefügt; Sessions bleiben unabhängig (eigene tmux/SSE).',
  'thread.no_agent_with_binding':
    '📁 Ordner `{subdir}` ist verknüpft. Starte /claude oder /opencode, um den Dialog zu beginnen.',

  'bind.usage': 'Verwendung: /bind <subdir>\nBeispiel: /bind overview',
  'bind.current': '📂 Aktuell verknüpft: `{subdir}`',
  'bind.current_none': '📂 Noch nicht verknüpft',
  'bind.in_general': '/bind funktioniert nur in thematischen Threads, nicht in General.',
  'bind.invalid_chars': '❌ Der Ordnername darf keine Steuerzeichen enthalten.',
  'bind.not_found': '❌ Ordner `{subdir}` nicht unter `WORK_ROOT` (`{workRoot}`) gefunden.',
  'bind.outside_root': '❌ Pfad verlässt `WORK_ROOT`.',
  'bind.not_directory': '❌ `{subdir}` existiert, ist aber kein Ordner.',

  'bind.leave_button': '⬅️ Aktuellen Ordner verlassen',
  'bind.create_button': '➕ Neuen Ordner erstellen',
  'bind.create_prompt':
    '✏️ Sende den Namen des neuen Ordners (wird unter `WORK_ROOT` erstellt). Jeder Befehl bricht ab.',
  'bind.create_cb': 'Erstelle neuen Ordner…',
  'bind.create_empty': '❌ Name ist leer. Sende einen Ordnernamen.',
  'bind.create_separator': '❌ Name darf kein `/` oder `\\` enthalten. Sende einen einfachen Namen.',
  'bind.create_dot_segment': '❌ `.` und `..` können nicht als Ordnername verwendet werden.',
  'bind.create_hidden': '❌ Name darf nicht mit einem Punkt beginnen.',
  'bind.create_invalid_chars': '❌ Ordnername darf keine Steuerzeichen enthalten.',
  'bind.create_exists': '📁 Ordner `{subdir}` existiert bereits — verknüpfe damit.',
  'bind.create_failed': '❌ Ordner konnte nicht erstellt werden: {error}',

  'ls.header': '📁 Unterordner von `{workRoot}`:',
  'ls.empty': '📁 Keine verknüpfbaren Unterordner unter `WORK_ROOT`.',
  'list.header': '🧵 Thread-Verknüpfungen ({count}):',
  'list.empty': '🧵 Noch keine Verknüpfungen. Erstelle einen Thread und führe /bind aus.',
  'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
  'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
  'new.general_hint':
    '/new funktioniert innerhalb eines verknüpften Threads — öffne einen Thread und führe /new aus, um die Agent-Session neu zu starten.',

  'help.general':
    '*Befehle in General:*\n' +
    '/ls — `WORK_ROOT`-Unterordner auflisten\n' +
    '/list — Threads auflisten\n' +
    '/status — Status aller Threads\n' +
    '/quitall — jeden laufenden Agent beenden\n' +
    '/whoami /version — Debug\n\n' +
    'Um mit einem Agent zu sprechen — öffne einen thematischen Thread.',
  'help.thread_unbound':
    '*Thread ist nicht mit einem Ordner verknüpft.*\n' +
    '/bind <subdir> — verknüpfen (oder aus Liste wählen)\n' +
    '/ls — `WORK_ROOT`-Unterordner (in General)',
  'help.thread_bound':
    '*Thread verknüpft mit `{subdir}`.*\n' +
    '/claude /opencode — Agent starten\n' +
    '/connect — OpenCode-Provider-API-Key verbinden (Standard: OpenAI)\n' +
    '/terminal — Shell in diesem Ordner öffnen\n' +
    '/new — Session neu starten (alte → /sessions)\n' +
    '/model /sessions — wechseln\n' +
    '/effort — Reasoning-Effort-Stufe\n' +
    '/verbosity — Ausgabedetaillierung (Thinking/Tools/Sub-Agenten)\n' +
    '/quit /status /output — Steuerung\n' +
    '/compact — Agent-Kontext komprimieren\n' +
    '/clear — Thread-Nachrichten löschen\n' +
    '/c /y /n /enter /up /down /tab /esc — TUI-Tasten (Claude)\n' +
    '/bind — Verknüpfung verwalten',

  'doctor.header': '🔍 *TelegramCode Doctor*',
  'doctor.ok': '✅ {label}',
  'doctor.warn': '⚠️ {label} — {hint}',
  'doctor.fail': '❌ {label} — {hint}',
  'doctor.bot_admin': 'Bot ist Gruppen-Admin',
  'doctor.can_manage_topics': '`can_manage_topics` gewährt',
  'doctor.can_delete_messages': '`can_delete_messages` gewährt',
  'doctor.can_pin_messages': '`can_pin_messages` gewährt',
  'doctor.privacy_off': 'Privacy-Modus deaktiviert',
  'doctor.privacy_hint':
    '@BotFather → /setprivacy → Disable, dann Bot entfernen und neu hinzufügen',
  'doctor.workroot_subdirs':
    '`WORK_ROOT`: `{workRoot}` ({count} Unterordner)',
  'doctor.datadir_path': '`DATA_DIR`: `{dataDir}`',
  'doctor.claude_installed': 'claude CLI installiert',
  'doctor.opencode_installed': 'opencode CLI installiert',
  'doctor.state_valid':
    'state.json gültig ({bindings} Verknüpfungen, {active} aktiv)',
  'doctor.state_archived':
    'vorherige state.json war beschädigt, Archiv: {path}',
  'doctor.cli_missing':
    'nicht in PATH gefunden (Auto-Install läuft bei /claude oder /opencode)',
  'doctor.no_admin_info':
    'Bot-Rechte nicht lesbar — getChatMember fehlgeschlagen',

  'onboarding.welcome':
    '👋 *TelegramCode Bot 2.0*\n\n' +
    'Checkliste für den Einsatz:\n' +
    '1️⃣ Mach mich zum Gruppen-Admin mit Rechten:\n' +
    '   • Manage Topics, Delete Messages, Pin Messages\n' +
    '2️⃣ @BotFather → /setprivacy → Disable, dann entferne und füge mich neu hinzu\n' +
    '3️⃣ Führe /doctor aus, um zu sehen, was noch fehlt\n' +
    '4️⃣ In jedem thematischen Thread /bind <subdir> ausführen und Agent starten\n\n' +
    '`WORK_ROOT`: `{workRoot}`',

  'binding.welcome.header': '📁 Verknüpft mit `{subdir}`',
  'binding.welcome.claude_md': '• CLAUDE.md: {size}',
  'binding.welcome.mcp_json': '• `.mcp.json`: {count} Server',
  'binding.welcome.git': '• git: Branch `{branch}`{detail}',
  'binding.welcome.git_clean': ', sauber',
  'binding.welcome.git_dirty': ', unbestätigte Änderungen',
  'binding.welcome.git_none': '• git: nicht initialisiert',
  'binding.welcome.start_prompt': 'Beginne eine Unterhaltung:',

  'mcp.header': '🔌 *MCP-Server für diesen Thread:*',
  'mcp.row': '• `{name}` — {source}',
  'mcp.empty': '🔌 Keine MCP-Server konfiguriert.',
  'mcp.source_user': 'user (~/.claude/settings.json)',
  'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
  'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
  'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

  'doctor.pin_hint': 'Pinned-Thread-Status (Stage 7) wird nicht verfügbar sein',

  'whoami.report':
    '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
    '🔐 allowed: {allowed}\n📁 binding: {binding}',
  'whoami.binding_unbound': '(keine Verknüpfung)',

  'pair.success': '✅ Gruppe verknüpft. id: `{groupId}`. Der Bot bedient nun diese Supergroup.',
  'pair.locked':
    'ℹ️ Die Gruppen-ID ist über `ALLOWED_GROUP_ID` gesetzt — Auto-Pairing ist deaktiviert. ' +
    'Um die Gruppe zu wechseln, ändere die Variable und starte den Bot neu.',
  'pair.only_forum': '❌ /pair funktioniert nur in einer Forum-Supergroup (Topics aktivieren).',
  'pair.not_admin': '❌ Nur ein Gruppen-Administrator oder Ersteller kann den Bot verknüpfen.',
  'pair.not_paired': 'Gruppe noch nicht verknüpft (Pairing-Modus)',
  'pair.dm': "ℹ️ /pair ist im DM-Modus nicht nötig — der Bot bedient deinen privaten Chat.",
  'version.report':
    '*TelegramCode {bot}*\n' +
    'Node: {node}\n' +
    'tmux: {tmux}\n' +
    'claude: {claude}\n' +
    'opencode: {opencode}',
  'version.unknown': '(nicht verfügbar)',
  'status.global_header': '📊 *Alle Threads* ({total}):',
  'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
  'status.global_empty': '📊 Noch keine Threads.',
  'status.thread_report': 'Status:\n\nAgent: {agent}\nOrdner: {subdir}\nSitzung: {session}',
  'status.thread_model': 'Modell: {model}',
  'status.thread_effort': 'Aufwand: {effort}',
  'status.thread_started': 'Gestartet: {started}',
  'status.thread_running': 'läuft',
  'status.thread_stopped': 'gestoppt',
  'status.thread_no_agent': 'keiner (starte /claude oder /opencode)',
  'status.thread_no_binding': '(keine Bindung — WORK_ROOT)',
  'language.status': '🌐 Sprache: {display}',
  'language.set_success': '✅ Sprache für diesen Chat auf `{locale}` gesetzt.',
  'language.auto_success': '✅ Sprache auf automatisch zurückgesetzt. Aktuell: {display}.',
  'language.invalid': '⚠️ Locale `{locale}` wird nicht unterstützt. Verfügbar: {locales}.',

  'agent.ready': '{label} bereit in `{subdir}`{argsSuffix}\nSende eine Nachricht:',
  'agent.no_session': 'Kein Agent läuft. /claude oder /opencode zum Starten.',
  'agent.session_ended': '{label}: Session beendet',
  'agent.stopped': '{label} gestoppt',
  'agent.exit_signal_sent': 'Doppeltes Ctrl+C gesendet — {label} wird beendet',
  'agent.already_active': '{label} läuft hier bereits. Sende eine Nachricht oder /quit.',
  'agent.starting': 'Starte {label} in `{subdir}`…',
  'agent.queued_starting': '⏳ {label} startet noch — deine Nachricht ist in der Warteschlange und wird gesendet, sobald der Agent bereit ist.',
  'agent.question_hint': 'ℹ️ Antworte mit der Optionsnummer (z.B. 1) oder y/n. Auch: /up /down zum Bewegen, /enter zum Bestätigen, /c zum Abbrechen.',
  'agent.start_failed': '{label} konnte nicht gestartet werden: {error}',
  'agent.question_cancelled_for_prompt': '⚠️ Vorherige Frage abgebrochen — führe deine neue Anfrage aus.',
  'agent.question_cancelled_msg_label': '❌ Frage abgebrochen: {header}',
  'agent.login_code_relayed': '🔐 Login-Code an Claude weitergeleitet — die Token-Nachricht wurde aus dem Verlauf gelöscht.',
  'agent.login_url': '🔐 Um dich bei Claude anzumelden, öffne diesen Link, schließe die Anmeldung ab und füge den Code hier ein:\n{url}',
  'agent.login_success': '✅ Bei Claude angemeldet.',
  'agent.login_failed': '⚠️ Anmeldung bei Claude fehlgeschlagen. Führe /login aus, um es erneut zu versuchen.',
  'agent.workingIndicator': '{glyph} arbeite…',
  'terminal.ready': '🖥 Terminal bereit in `{subdir}`{argsSuffix}\nJede Nachricht wird als Befehl ausgeführt. /c — Ctrl+C, /up /down — Verlauf, /tab — Vervollständigung, /quit — schließen.',

  'effort.choose': '⚙️ Aktueller Effort: {current}\nWähle eine Stufe:',
  'effort.current_none': 'nicht gesetzt',
  'effort.set_success': '✅ Effort: {level}',
  'effort.invalid_level': '⚠️ Stufe `{level}` ist ungültig. Verfügbar: {valid}.',
  'effort.not_available': 'ℹ️ Für das aktuelle Modell sind keine Reasoning-Effort-Stufen verfügbar.',
  'effort.not_supported': 'ℹ️ Modell `{model}` hat keine Reasoning-Effort-Stufen.',
  'effort.start_agent_first': 'ℹ️ Stufe gespeichert. Kein Agent läuft — wird beim nächsten Start angewendet.',
  'effort.cleared_on_model_switch': 'ℹ️ Effort `{level}` zurückgesetzt: das neue Modell `{model}` unterstützt ihn nicht.',
  'effort.unsupported_backend': 'Effort-Steuerung wird für {label} nicht unterstützt.',
  'effort.no_session': 'Kein Agent läuft. Starte einen mit /claude oder /opencode.',

  'thinking.live': '•••',
  'thinking.thoughtForSeconds': '💭 dachte {seconds}s nach',
  'thinking.choose': '☁️ Aktueller Thinking-Modus: {current}\nWähle einen Modus:',
  'thinking.set_success': '✅ Thinking-Modus: {mode}',
  'thinking.invalid_mode': '⚠️ Modus `{mode}` ist ungültig. Verfügbar: {valid}.',
  'thinking.mode.minimal': 'minimal',
  'thinking.mode.short': 'kurz',
  'thinking.mode.full': 'voll',

  'toolResults.choose': '🔧 Aktueller Tool-Ergebnis-Modus: {current}\nWähle einen Modus:',
  'toolResults.set_success': '✅ Tool-Ergebnis-Modus: {mode}',
  'toolResults.invalid_mode': '⚠️ Modus `{mode}` ist ungültig. Verfügbar: {valid}.',
  'toolResults.mode.minimal': 'minimal',
  'toolResults.mode.short': 'kurz',
  'toolResults.mode.full': 'voll',
  'toolResults.truncated_footer': '… (gekürzt, /tool_results full)',
  'toolResults.activity_status': '🔧 {tool} …',
  'toolResults.activity_fallback': 'Tool',

  'subagent.status_elapsed': '🤖 Sub-Agent: {title} · {elapsed}',
  'subagent.panel_fold_status': '🤖 Sub-Agent arbeitet …',
  'subagent.delegating_status': '🤖 Delegiere: {title} …',
  'subagent.chunk_prefix': '🤖 ⤷',
  'subagent.fallback_title': 'Sub-Agent',
  'subagent.choose': '🤖 Aktueller Sub-Agent-Modus: {current}\nWähle einen Modus:',
  'subagent.set_success': '✅ Sub-Agent-Modus: {mode}',
  'subagent.invalid_mode': '⚠️ Modus `{mode}` ist ungültig. Verfügbar: {valid}.',
  'subagent.mode.minimal': 'minimal',
  'subagent.mode.short': 'kurz',
  'subagent.mode.full': 'voll',

  'verbosity.choose': '🔊 Aktuelle Ausgabedetaillierung: {current}\nWähle eine Stufe:',
  'verbosity.set_success': '✅ Ausgabedetaillierung: {mode} (Thinking, Tool-Ergebnisse, Sub-Agenten)',
  'verbosity.invalid_mode': '⚠️ Modus `{mode}` ist ungültig. Verfügbar: {valid}.',
  'verbosity.custom': 'benutzerdefiniert (Thinking: {thinking} · Tools: {toolResults} · Sub-Agenten: {subagent})',
  'verbosity.mode.minimal': 'minimal',
  'verbosity.mode.short': 'kurz',
  'verbosity.mode.full': 'voll',

  'model.saved_for_next_start': 'Modell gespeichert: {model} — wird beim nächsten Agent-Start angewendet.',
  'model.start_agent_first': 'Keine aktive Session. Starte zuerst einen Agent.',

  'rename_session.usage': 'Verwendung: /rename_session <neuer Titel>',
  'rename_session.start_agent_first': 'Keine aktive Session. Starte zuerst einen Agent (/claude oder /opencode).',
  'rename_session.unsupported_backend': 'Session-Umbenennung wird für {label} nicht unterstützt.',
  'rename_session.success': '✅ Session umbenannt: {title}',
  'rename_session.failed': '⚠️ Session konnte nicht umbenannt werden: {reason}',

  'connect.prompt_key': '🔑 Sende den API-Key für `{provider}` als nächste Nachricht. Ich lösche die Key-Nachricht aus dem Verlauf.',
  'connect.empty_key': '❌ API-Key ist leer. Sende den Key als nächste Nachricht.',
  'connect.invalid_key': '❌ Das sieht nicht wie ein API key aus (er enthält Leerzeichen oder nicht-lateinische Zeichen). Sende als nächste Nachricht nur den Key oder starte /connect erneut.',
  'connect.invalid_provider': '❌ Ungültige Provider-ID `{provider}`. Beispiel: /connect openai',
  'connect.unsupported_provider': '⚠️ Provider `{provider}` unterstützt keinen einfachen API-Key-Login über diesen Ablauf. Verwende die OpenCode-UI/CLI für diesen Provider.',
  'connect.unsupported_backend': 'OpenCode-Provider-Auth ist in diesem Build nicht verfügbar.',
  'connect.failed': '⚠️ Verbinden von `{provider}` fehlgeschlagen: {reason}',
  'connect.success': '✅ Provider `{provider}` verbunden. OpenCode-Server wurde nicht neu gestartet.',
  'connect.cancelled': 'API-Key-Eingabe abgebrochen.',
  'connect.pick_method': '`{provider}` verbinden — wie? Wähle eine Methode:',
  'connect.no_methods': '⚠️ Keine Auth-Methoden für `{provider}` gefunden.',
  'connect.oauth_device': '🔓 Um `{provider}` zu verbinden: öffne {url} und gib den Code `{code}` ein, dann bestätige. Auf einem Server die *headless*-Methode nutzen. Ich melde mich hier, wenn es fertig ist.',
  'connect.oauth_url_only': '🔓 Um `{provider}` zu verbinden: öffne {url} und schließe die Anmeldung ab. Ich melde mich hier, wenn es fertig ist.',
  'connect.oauth_paste': '🔑 Füge nach der Bestätigung den Code als nächste Nachricht hier ein — ich lösche ihn aus dem Verlauf.',
  'connect.oauth_waiting': '⏳ Warte auf Autorisierung…',
  'connect.oauth_loopback': '🔑 Nach der Autorisierung versucht dein Browser, eine `localhost`-Seite zu öffnen, die nicht lädt — das ist hier normal. Kopiere diese URL aus der Adresszeile und sende sie als nächste Nachricht zurück (oder nur den `code`-Wert). Ich lösche sie aus dem Verlauf und schließe die Anmeldung ab.',
  'connect.oauth_invalid_reply': '❌ Das sieht weder nach einer Callback-URL noch nach einem Auth-Code aus. Füge nach der Autorisierung die `localhost`-Callback-URL aus deinem Browser ein (oder den `code`-Wert).',
  'connect.oauth_callback_no_flow': '⚠️ Das sieht nach einer OAuth-Callback-URL aus, aber hier läuft gerade keine Anmeldung — ich habe sie gelöscht. Starte /connect, um erneut zu beginnen.',
  'connect.oauth_success': '✅ `{provider}` per OAuth verbunden. Die Zugangsdaten des OpenCode-Servers wurden aktualisiert.',
  'connect.oauth_failed': '⚠️ OAuth-Anmeldung für `{provider}` nicht abgeschlossen. Führe /connect erneut aus.',
  'quit_all.none_active': 'Keine Agenten laufen — nichts zu stoppen.',
  'quit_all.summary': '🚪 {stopped} von {total} aktiven Agenten beendet.',
  'quit_all.general_only': '`/quit-all` ist nur im General-Topic verfügbar.',

  'clearMessages.summary':
    '🗑 {deleted} von {total} Nachrichten gelöscht. ' +
    'Telegram weigert sich, Nachrichten älter als 48 h zu löschen — der Rest bleibt im Verlauf.',
  'clearMessages.no_messages': 'Keine Nachrichten zum Löschen in diesem Thread.',

  'edited.hint':
    "✏️ Bearbeitete Nachrichten behandle ich nicht als neue Eingabe — sende die Korrektur als separate Nachricht.",

  'voice.no_api_key':
    'Sprache erfordert `GROQ_API_KEY` (kostenlos) oder `OPENAI_API_KEY`.',
  'voice.failed': 'Sprachnachricht konnte nicht transkribiert werden.',
  'voice.transcribed': '🎤 {text}',

  'file.too_big':
    '📎 Datei überschreitet das Bot-API-Limit ({cap} MB) — ich kann sie nicht herunterladen. Sende eine kleinere Datei.',
  'file.download_failed': '📎 Datei konnte nicht heruntergeladen werden. Bitte versuche es erneut.',

  'error.workdir.gone':
    '📁 Ordner `{subdir}` ist von der Festplatte verschwunden. Führe /bind <newdir> aus.',
  'error.tg.thread.deleted':
    '⚠️ Thread wurde in Telegram gelöscht; Verknüpfung aufgehoben.',
  'error.tg.thread.closed':
    '🔒 Thread {key} ist geschlossen — öffne ihn in deinem Telegram-Client erneut oder lösche ihn vollständig.',
  'error.tg.perm.delete':
    '🔐 Kann Nachrichten nicht löschen. Gewähre dem Bot `can_delete_messages`.',
  'error.tg.perm.manage_topics':
    '🔐 `can_manage_topics` fehlt. Mach mich zum Gruppen-Admin.',
  'error.state.corrupted':
    '⚠️ state.json war beschädigt; Verknüpfungen zurückgesetzt. Führe /bind erneut aus, wo nötig.',
  'error.start_in_general':
    'Agent kann in General nicht gestartet werden — das ist ein Service-Topic. Öffne einen thematischen Thread.',

  'cb.access_denied': 'Zugriff verweigert',
  'cb.bind_only_topical': '/bind funktioniert nur in thematischen Threads',
  'cb.binding_to': 'Verknüpfe mit {subdir}…',
  'cb.no_active_session': 'Keine aktive Session',
  'cb.model_error': 'Fehler: {error}',
  'cb.model_set': 'Modell: {model}',
  'cb.not_supported': 'Nicht unterstützt für {label}',
  'cb.unknown_agent': 'Unbekannter Agent',
  'cb.agent_switched': 'Gewechselt zu {label}',
  'cb.resume_only_topical': 'Resume funktioniert nur in thematischen Threads',
  'cb.bind_folder_first': 'Verknüpfe zuerst einen Ordner via /bind',
  'cb.agent_not_running': 'Agent läuft nicht',
  'cb.no_pending_question': 'Keine ausstehende Frage',
  'cb.connect_method_expired': 'Dieses Verbinden-Menü ist abgelaufen — /connect erneut ausführen',
  'cb.invalid_option': 'Ungültige Option',
  'cb.sent_option': 'Gesendet: {option}',
  'cb.effort_set': 'Effort: {level}',
  'cb.effort_error': 'Fehler: {error}',
  'cb.claudeMode_already': 'Bereits aktiv',
  'cb.claudeMode_switching': 'Wechsle…',
  'claudeMode.pick': '⚙️ Claude Code Backend — aktuell: {label}\nWähle ein Backend (Wechsel behält denselben Dialog):',
  'claudeMode.not_claude': "Dieses Topic ist nicht auf Claude Code — /claude_mode wechselt nur Claude's Backend.",
  'claudeMode.already': 'Bereits {label}.',
  'claudeMode.set_idle': '⚙️ Claude-Backend: {label} — wird beim nächsten Start angewendet.',
  'claudeMode.switched_resumed': '⚙️ Gewechselt zu {label} — derselbe Dialog fortgesetzt.',
  'claudeMode.switched_fresh': '⚙️ Gewechselt zu {label} — neue Session gestartet.',
  'cb.thinking_set': 'Thinking: {mode}',
  'cb.thinking_error': 'Fehler: {error}',
  'cb.toolresults_set': 'Tool-Ergebnisse: {mode}',
  'cb.toolresults_error': 'Fehler: {error}',
  'cb.subagent_set': 'Sub-Agenten: {mode}',
  'cb.subagent_error': 'Fehler: {error}',
  'cb.verbosity_set': 'Ausgabedetaillierung: {mode}',
  'cb.verbosity_error': 'Fehler: {error}',

  'session.list_header': 'Sessions zum Fortsetzen ({label}):',
  'session.list_footer': 'Sende 1–{max} zum Fortsetzen · 0 zum Abbrechen',
  'session.none': 'Keine fortsetzbaren Sessions in diesem Ordner.',
  'session.cancelled': 'Abgebrochen. Session-Auswahl geschlossen.',
  'session.invalid': 'Ungültige Nummer. Gib einen Wert von 1 bis {max} ein.',
  'session.resumed': 'Session fortgesetzt. Sende deine Nachricht:',
  'session.resume_failed': 'Session konnte nicht fortgesetzt werden: {error}',
  'session.expired': 'Session-Liste ist veraltet. Führe /sessions erneut aus.',
  'session.load_failed': 'Sessions konnten nicht geladen werden.',

  'resume.context_header': '↩️ Fortgesetzt — letzte {count} Nachrichten:',
  'resume.context_user_label': '👤',
  'resume.context_assistant_label': '🤖',

  'recap.missedCountHeader': '⚠️ {count} Nachricht(en) verpasst, während der Bot offline war. Neueste aus der Session:',
  'recap.restartedFallbackHeader': '🔄 Bot neu gestartet. Neueste aus der Session:',
  'recap.stillWorkingLine': '⏳ Der Agent arbeitet noch…',

  'trace.onThisThreadReply': '🔎 Tracing für diesen Thread aktiviert.',
  'trace.offThisThreadReply': '🔎 Tracing für diesen Thread deaktiviert.',
  'trace.onAllThreadsReply': '🔎 Tracing für ALLE Threads aktiviert.',
  'trace.offAllThreadsReply': '🔎 Tracing überall deaktiviert (das «all»-Flag und die Thread-Liste wurden geleert).',
  'trace.statusReply':
    '🔎 Trace — dieser Thread: {thisThread}\nAlle Threads: {allThreads}\nGetracete Threads: {count}',
  'trace.statusOnLabel': 'an',
  'trace.statusOffLabel': 'aus',
  'trace.usageHint': 'Verwendung: /trace on | off | on all | off all | (kein Argument — Status)',

  'timestamps.onReply':
    '🕐 Zeitstempel aktiviert: jeder an den Agent weitergeleitete Prompt erhält die Sendezeit als erste Zeile (nie im Topic gepostet).',
  'timestamps.offReply': '🕐 Zeitstempel für diesen Thread deaktiviert.',
  'timestamps.statusOnReply': '🕐 Zeitstempel: an für diesen Thread.',
  'timestamps.statusOffReply': '🕐 Zeitstempel: aus für diesen Thread.',
  'timestamps.usageHint': 'Verwendung: /timestamps on | off | (kein Argument — Status)',

  'schedule.fired':
    '⏰ Zeitplan „{name}« ({schedule}){missedNote}\n\n{prompt}',
  'schedule.missedNote': ' — verpasst um {time}, hole nach',
  'schedule.pausedUnbound':
    '⏸ Zeitpläne pausiert: {count} — das Topic wurde vom Ordner getrennt. /bind bringt sie zurück.',
  'schedule.resumedRebind': '▶️ Zeitpläne fortgesetzt: {count} (nächster Lauf ab jetzt neu berechnet).',
  'schedule.noAgent':
    '⚠️ Nichts geplant — in diesem Thema läuft kein Agent, ein geplanter Lauf hätte also nichts zu starten. Starte zuerst /claude oder /opencode.',
  'schedule.forwardPromptTemplate':
    'The user wants to schedule the following. Use the schedule_create / schedule_list / schedule_cancel MCP tools (cron for repeats, one-shot for a single run), translating any time phrasing into the right schedule, then confirm to the user IN GERMAN what you scheduled.\n\nRequest: {text}',
  'schedule.interviewPromptTemplate':
    'The user invoked /schedule with no details. Ask them IN GERMAN what prompt they want scheduled and WHEN (one-time or repeating). Once you have both, create it with the schedule_create MCP tool and confirm IN GERMAN what you scheduled.',

  'apiRetry.transientNotice':
    '⏳ API rate-limited — automatischer Wiederholungsversuch in {minutes} Min (Versuch {attempt}).',
  'apiRetry.usageLimitDelayNotice':
    '🚧 Nutzungslimit erreicht — Wiederholung in {minutes} Min (Versuch {attempt}).',
  'apiRetry.usageLimitResetNotice':
    '🚧 Nutzungslimit erreicht — automatisches Fortsetzen nach Reset (~{time}).',
  'apiRetry.resuming': '↻ Fortsetzen…',
  'apiRetry.giveUp':
    '⚠️ Konnte nach {attempts} Versuchen nicht fortsetzen. Schreibe mir, wann ich weitermachen soll.',
  'apiRetry.continueNudge': 'Fahre von dort fort, wo du aufgehört hast.',
  'apiRetry.loggedOutClaude':
    '⚠️ Claude ist abgemeldet — führe /login aus, um fortzufahren.',
  'apiRetry.loggedOutOpenCode':
    '⚠️ OpenCode: ungültige Anmeldedaten — starte den opencode-Server neu.',

  // ── startup readiness status (boot-time owner notice) ──
  'startup.ready':
    '✅ Bereit — ich kann Nachrichten in Bot-Threads und Gruppenthemen verarbeiten.',
  'startup.header_not_ready':
    '⚠️ Einrichtung unvollständig. Um mit mir zu arbeiten, schließe bitte diese Schritte ab:',
  'startup.item.create_group':
    'Erstelle eine Forum-Supergruppe mit aktivierten Themen und schreibe mir dort eine Nachricht, um sie zu koppeln.',
  'startup.item.grant_admin':
    'Mache mich zum Admin mit diesen Rechten: {missing}.',
  'startup.item.bind_topic':
    'Erstelle ein Thema und binde es mit /bind an einen Ordner.',
  'startup.item.install_agent':
    'Installiere ein Agent-CLI — claude oder opencode.',
  'startup.item.optional_groq':
    '(optional) Füge GROQ_API_KEY zu deiner .env hinzu und starte neu, um Spracheingabe zu aktivieren.',
  'startup.item.optional_owner':
    '(optional) Setze OWNER_USER_ID, um diesen Status in deinem privaten Chat zu erhalten.',
};
