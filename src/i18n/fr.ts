// Machine-translated from en. Native review welcome.

export const frDict: Record<string, string> = {
  'access.denied': 'Accès refusé.',
  'access.group_only': 'Je ne fonctionne que dans le super-groupe forum configuré.',

  'thread.no_binding':
    '📁 Ce fil n\'est pas lié à un dossier. Utilisez /bind <subdir> ou choisissez dans la liste.',
  'thread.bind_required':
    '📁 Liez d\'abord un dossier : /bind <subdir>. L\'agent ne fonctionne que dans le dossier lié.',
  'thread.bound': '📁 Lié à `{subdir}`.\nLancez /claude ou /opencode.',
  'thread.unbound': '📁 Lien effacé.',
  'thread.general_no_agent':
    'General n\'est pas lié à un dossier — passez à un fil thématique pour parler à un agent.',
  'thread.welcome_bound':
    '👋 Fil créé et lié automatiquement à `{subdir}` (nom du fil correspondait à un sous-dossier).\nLancez /claude ou /opencode.',
  'thread.welcome_pick':
    '👋 Fil créé. Liez un dossier : /bind <subdir>, ou choisissez-en un ci-dessous.',
  'thread.bind_collision':
    '⚠️ Le dossier `{subdir}` est déjà utilisé par les fils : {threads}.\nLien ajouté ; les sessions restent indépendantes (tmux/SSE séparés).',
  'thread.no_agent_with_binding':
    '📁 Le dossier `{subdir}` est lié. Lancez /claude ou /opencode pour commencer le dialogue.',

  'bind.usage': 'Utilisation : /bind <subdir>\nExemple : /bind overview',
  'bind.current': '📂 Actuellement lié : `{subdir}`',
  'bind.current_none': '📂 Pas encore lié',
  'bind.in_general': '/bind ne fonctionne que dans les fils thématiques, pas dans General.',
  'bind.invalid_chars': '❌ Le nom du dossier ne doit pas contenir de caractères de contrôle.',
  'bind.not_found': '❌ Dossier `{subdir}` introuvable sous `WORK_ROOT` (`{workRoot}`).',
  'bind.outside_root': '❌ Le chemin sort de `WORK_ROOT`.',
  'bind.not_directory': '❌ `{subdir}` existe mais n\'est pas un dossier.',

  'bind.leave_button': '⬅️ Quitter le dossier actuel',
  'bind.create_button': '➕ Créer un nouveau dossier',
  'bind.create_prompt':
    '✏️ Envoyez le nom du nouveau dossier (il sera créé sous `WORK_ROOT`). Toute commande annule.',
  'bind.create_cb': 'Création d\'un nouveau dossier…',
  'bind.create_empty': '❌ Le nom est vide. Envoyez un nom de dossier.',
  'bind.create_separator': '❌ Le nom ne doit pas contenir `/` ou `\\`. Envoyez un nom simple.',
  'bind.create_dot_segment': '❌ `.` et `..` ne peuvent pas être utilisés comme nom de dossier.',
  'bind.create_hidden': '❌ Le nom ne doit pas commencer par un point.',
  'bind.create_invalid_chars': '❌ Le nom du dossier ne doit pas contenir de caractères de contrôle.',
  'bind.create_exists': '📁 Le dossier `{subdir}` existe déjà — liaison en cours.',
  'bind.create_failed': '❌ Échec de la création du dossier : {error}',

  'ls.header': '📁 Sous-dossiers de `{workRoot}` :',
  'ls.empty': '📁 Aucun sous-dossier liaisable sous `WORK_ROOT`.',
  'list.header': '🧵 Liens de fils ({count}) :',
  'list.empty': '🧵 Aucun lien pour l\'instant. Créez un fil et lancez /bind.',
  'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
  'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
  'new.general_hint':
    '/new fonctionne dans un fil lié — ouvrez un fil et lancez /new pour redémarrer sa session d\'agent.',

  'help.general':
    '*Commandes dans General :*\n' +
    '/ls — lister les sous-dossiers `WORK_ROOT`\n' +
    '/list — lister les fils\n' +
    '/status — état de tous les fils\n' +
    '/quitall — arrêter tous les agents en cours\n' +
    '/whoami /version — débogage\n\n' +
    'Pour parler à un agent — ouvrez un fil thématique.',
  'help.thread_unbound':
    '*Le fil n\'est pas lié à un dossier.*\n' +
    '/bind <subdir> — lier (ou choisir dans la liste)\n' +
    '/ls — sous-dossiers `WORK_ROOT` (dans General)',
  'help.thread_bound':
    '*Fil lié à `{subdir}`.*\n' +
    '/claude /opencode — démarrer un agent\n' +
    '/connect — connecter une clé API de provider OpenCode (OpenAI par défaut)\n' +
    '/terminal — ouvrir un shell dans ce dossier\n' +
    '/new — redémarrer la session (l\'ancienne → /sessions)\n' +
    '/model /sessions — basculer\n' +
    '/effort — niveau de reasoning effort\n' +
    '/verbosity — verbosité de sortie (thinking/tools/sous-agents)\n' +
    '/quit /status /output — contrôle\n' +
    '/compact — compacter le contexte de l\'agent\n' +
    '/clear — supprimer les messages du fil\n' +
    '/c /y /n /enter /up /down /tab /esc — touches TUI (Claude)\n' +
    '/bind — gérer la liaison',

  'doctor.header': '🔍 *TelegramCode Doctor*',
  'doctor.ok': '✅ {label}',
  'doctor.warn': '⚠️ {label} — {hint}',
  'doctor.fail': '❌ {label} — {hint}',
  'doctor.bot_admin': 'Le bot est admin du groupe',
  'doctor.can_manage_topics': '`can_manage_topics` accordé',
  'doctor.can_delete_messages': '`can_delete_messages` accordé',
  'doctor.can_pin_messages': '`can_pin_messages` accordé',
  'doctor.privacy_off': 'Privacy mode désactivé',
  'doctor.privacy_hint':
    '@BotFather → /setprivacy → Disable, puis retirer et ré-ajouter le bot',
  'doctor.workroot_subdirs':
    '`WORK_ROOT` : `{workRoot}` ({count} sous-dossiers)',
  'doctor.datadir_path': '`DATA_DIR` : `{dataDir}`',
  'doctor.claude_installed': 'claude CLI installé',
  'doctor.opencode_installed': 'opencode CLI installé',
  'doctor.state_valid':
    'state.json valide ({bindings} liens, {active} actifs)',
  'doctor.state_archived':
    'l\'ancien state.json était corrompu, archive : {path}',
  'doctor.cli_missing':
    'introuvable dans PATH (auto-install se lancera sur /claude ou /opencode)',
  'doctor.no_admin_info':
    'impossible de lire les droits du bot — getChatMember échoué',

  'onboarding.welcome':
    '👋 *TelegramCode Bot 2.0*\n\n' +
    'Checklist de mise en service :\n' +
    '1️⃣ Faites de moi un admin de groupe avec les droits :\n' +
    '   • Manage Topics, Delete Messages, Pin Messages\n' +
    '2️⃣ @BotFather → /setprivacy → Disable, puis retirez et ré-ajoutez-moi\n' +
    '3️⃣ Lancez /doctor pour voir ce qui manque\n' +
    '4️⃣ Dans chaque fil thématique, lancez /bind <subdir> et démarrez un agent\n\n' +
    '`WORK_ROOT` : `{workRoot}`',

  'binding.welcome.header': '📁 Lié à `{subdir}`',
  'binding.welcome.claude_md': '• CLAUDE.md : {size}',
  'binding.welcome.mcp_json': '• `.mcp.json` : {count} serveurs',
  'binding.welcome.git': '• git : branche `{branch}`{detail}',
  'binding.welcome.git_clean': ', propre',
  'binding.welcome.git_dirty': ', modifications non validées',
  'binding.welcome.git_none': '• git : non initialisé',
  'binding.welcome.start_prompt': 'Démarrez une conversation :',

  'mcp.header': '🔌 *Serveurs MCP pour ce fil :*',
  'mcp.row': '• `{name}` — {source}',
  'mcp.empty': '🔌 Aucun serveur MCP configuré.',
  'mcp.source_user': 'user (~/.claude/settings.json)',
  'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
  'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
  'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

  'doctor.pin_hint': 'Le statut épinglé du fil (Stage 7) sera indisponible',

  'whoami.report':
    '👤 user : `{userId}`\n💬 chat : `{chatId}`\n🧵 thread : `{threadId}`\n' +
    '🔐 allowed : {allowed}\n📁 binding : {binding}',
  'whoami.binding_unbound': '(aucun lien)',

  'pair.success': '✅ Groupe apparié. id : `{groupId}`. Le bot sert désormais ce super-groupe.',
  'pair.locked':
    'ℹ️ L\'id du groupe est défini via `ALLOWED_GROUP_ID` — l\'auto-appariement est désactivé. ' +
    'Pour changer de groupe, modifiez la variable et redémarrez le bot.',
  'pair.only_forum': '❌ /pair ne fonctionne que dans un super-groupe forum (activez Topics).',
  'pair.not_admin': '❌ Seul un administrateur ou créateur du groupe peut apparier le bot.',
  'pair.not_paired': 'groupe non encore apparié (mode pairing)',
  'pair.dm': "ℹ️ /pair n'est pas nécessaire en mode DM — le bot sert votre chat privé.",
  'version.report':
    '*TelegramCode {bot}*\n' +
    'Node : {node}\n' +
    'tmux : {tmux}\n' +
    'claude : {claude}\n' +
    'opencode : {opencode}',
  'version.unknown': '(indisponible)',
  'status.global_header': '📊 *Tous les fils* ({total}) :',
  'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
  'status.global_empty': '📊 Aucun fil pour l\'instant.',
  'language.status': '🌐 Langue : {display}',
  'language.set_success': '✅ Langue définie sur `{locale}` pour ce chat.',
  'language.auto_success': '✅ Langue réinitialisée en automatique. Actuelle : {display}.',
  'language.invalid': '⚠️ Locale `{locale}` non prise en charge. Disponibles : {locales}.',

  'agent.ready': '{label} prêt dans `{subdir}`{argsSuffix}\nEnvoyez un message :',
  'agent.no_session': 'Aucun agent en cours. /claude ou /opencode pour démarrer.',
  'agent.session_ended': '{label} : session terminée',
  'agent.stopped': '{label} arrêté',
  'agent.exit_signal_sent': 'Double Ctrl+C envoyé — {label} en cours d\'arrêt',
  'agent.already_active': '{label} fonctionne déjà ici. Envoyez un message ou /quit.',
  'agent.starting': 'Démarrage de {label} dans `{subdir}`…',
  'agent.queued_starting': '⏳ {label} démarre encore — votre message est en file d\'attente et sera envoyé dès qu\'il sera prêt.',
  'agent.question_hint': 'ℹ️ Répondez avec le numéro d\'option (ex. 1) ou y/n. Aussi : /up /down pour naviguer, /enter pour confirmer, /c pour annuler.',
  'agent.start_failed': 'Échec du démarrage de {label} : {error}',
  'agent.question_cancelled_for_prompt': '⚠️ Question précédente annulée — exécution de votre nouvelle requête.',
  'agent.question_cancelled_msg_label': '❌ Question annulée : {header}',
  'agent.login_code_relayed': '🔐 Code de connexion transmis à Claude — le message avec le jeton a été supprimé de l\'historique.',
  'agent.workingIndicator': '{glyph} travail…',
  'terminal.ready': '🖥 Terminal prêt dans `{subdir}`{argsSuffix}\nChaque message est exécuté comme une commande. /c — Ctrl+C, /up /down — historique, /tab — complétion, /quit — fermer.',

  'effort.choose': '⚙️ Effort actuel : {current}\nChoisissez un niveau :',
  'effort.current_none': 'non défini',
  'effort.set_success': '✅ Effort : {level}',
  'effort.invalid_level': '⚠️ Niveau `{level}` invalide. Disponibles : {valid}.',
  'effort.not_available': 'ℹ️ Aucun niveau de reasoning effort disponible pour le modèle actuel.',
  'effort.not_supported': 'ℹ️ Le modèle `{model}` n\'a pas de niveaux de reasoning effort.',
  'effort.start_agent_first': 'ℹ️ Niveau enregistré. Aucun agent en cours — sera appliqué au prochain démarrage.',
  'effort.cleared_on_model_switch': 'ℹ️ Effort `{level}` effacé : le nouveau modèle `{model}` ne le prend pas en charge.',
  'effort.unsupported_backend': 'Le contrôle d\'effort n\'est pas pris en charge pour {label}.',
  'effort.no_session': 'Aucun agent en cours. Démarrez-en un avec /claude ou /opencode.',

  'thinking.live': '•••',
  'thinking.thoughtForSeconds': '💭 a réfléchi pendant {seconds}s',
  'thinking.choose': '☁️ Mode de thinking actuel : {current}\nChoisissez un mode :',
  'thinking.set_success': '✅ Mode de thinking : {mode}',
  'thinking.invalid_mode': '⚠️ Mode `{mode}` invalide. Disponibles : {valid}.',
  'thinking.mode.minimal': 'minimal',
  'thinking.mode.short': 'court',
  'thinking.mode.full': 'complet',

  'toolResults.choose': '🔧 Mode de résultats d\'outils actuel : {current}\nChoisissez un mode :',
  'toolResults.set_success': '✅ Mode de résultats d\'outils : {mode}',
  'toolResults.invalid_mode': '⚠️ Mode `{mode}` invalide. Disponibles : {valid}.',
  'toolResults.mode.minimal': 'minimal',
  'toolResults.mode.short': 'court',
  'toolResults.mode.full': 'complet',
  'toolResults.truncated_footer': '… (tronqué, /tool_results full)',
  'toolResults.activity_status': '🔧 {tool} …',
  'toolResults.activity_fallback': 'outil',

  'subagent.status_elapsed': '🤖 sous-agent : {title} · {elapsed}',
  'subagent.panel_fold_status': '🤖 sous-agent travaille …',
  'subagent.delegating_status': '🤖 Délégation : {title} …',
  'subagent.chunk_prefix': '🤖 ⤷',
  'subagent.fallback_title': 'sous-agent',
  'subagent.choose': '🤖 Mode de sous-agent actuel : {current}\nChoisissez un mode :',
  'subagent.set_success': '✅ Mode de sous-agent : {mode}',
  'subagent.invalid_mode': '⚠️ Mode `{mode}` invalide. Disponibles : {valid}.',
  'subagent.mode.minimal': 'minimal',
  'subagent.mode.short': 'court',
  'subagent.mode.full': 'complet',

  'verbosity.choose': '🔊 Verbosité de sortie actuelle : {current}\nChoisissez un niveau :',
  'verbosity.set_success': '✅ Verbosité de sortie : {mode} (thinking, résultats d\'outils, sous-agents)',
  'verbosity.invalid_mode': '⚠️ Mode `{mode}` invalide. Disponibles : {valid}.',
  'verbosity.custom': 'personnalisé (thinking : {thinking} · outils : {toolResults} · sous-agents : {subagent})',
  'verbosity.mode.minimal': 'minimal',
  'verbosity.mode.short': 'court',
  'verbosity.mode.full': 'complet',

  'model.saved_for_next_start': 'Modèle enregistré : {model} — s\'appliquera au prochain démarrage d\'agent.',
  'model.start_agent_first': 'Aucune session active. Démarrez d\'abord un agent.',

  'rename_session.usage': 'Utilisation : /rename_session <nouveau titre>',
  'rename_session.start_agent_first': 'Aucune session active. Démarrez d\'abord un agent (/claude ou /opencode).',
  'rename_session.unsupported_backend': 'Le renommage de session n\'est pas pris en charge pour {label}.',
  'rename_session.success': '✅ Session renommée : {title}',
  'rename_session.failed': '⚠️ Échec du renommage de la session : {reason}',

  'connect.prompt_key': '🔑 Envoyez la clé API pour `{provider}` comme prochain message. Je supprimerai le message contenant la clé de l\'historique.',
  'connect.empty_key': '❌ La clé API est vide. Envoyez la clé comme prochain message.',
  'connect.invalid_provider': '❌ ID de provider invalide `{provider}`. Exemple : /connect openai',
  'connect.unsupported_provider': '⚠️ Le provider `{provider}` ne prend pas en charge la connexion par clé API simple via ce flux. Utilisez l\'UI/CLI OpenCode pour ce provider.',
  'connect.unsupported_backend': 'L\'auth de provider OpenCode n\'est pas disponible dans ce build.',
  'connect.failed': '⚠️ Échec de la connexion à `{provider}` : {reason}',
  'connect.success': '✅ Provider `{provider}` connecté. Le serveur OpenCode n\'a pas été redémarré.',
  'connect.cancelled': 'Saisie de clé API annulée.',

  'quit_all.none_active': 'Aucun agent en cours — rien à arrêter.',
  'quit_all.summary': '🚪 {stopped} sur {total} agents actifs arrêtés.',
  'quit_all.general_only': '`/quit-all` n\'est disponible que dans le topic General.',

  'clearMessages.summary':
    '🗑 {deleted} sur {total} messages supprimés. ' +
    'Telegram refuse de supprimer ce qui date de plus de 48 h — le reste reste dans l\'historique.',
  'clearMessages.no_messages': 'Aucun message à supprimer dans ce fil.',

  'edited.hint':
    "✏️ Je ne traite pas les messages modifiés comme une nouvelle entrée — envoyez la correction dans un message séparé.",

  'voice.no_api_key':
    'La voix nécessite `GROQ_API_KEY` (gratuit) ou `OPENAI_API_KEY`.',
  'voice.failed': 'Échec de la transcription du message vocal.',
  'voice.transcribed': '🎤 {text}',

  'file.too_big':
    '📎 Le fichier dépasse la limite Bot API ({cap} Mo) — je ne peux pas le télécharger. Envoyez un fichier plus petit.',
  'file.download_failed': '📎 Échec du téléchargement du fichier. Veuillez réessayer.',

  'error.workdir.gone':
    '📁 Le dossier `{subdir}` a disparu du disque. Lancez /bind <newdir>.',
  'error.tg.thread.deleted':
    '⚠️ Le fil a été supprimé dans Telegram ; lien effacé.',
  'error.tg.thread.closed':
    '🔒 Le fil {key} est fermé — rouvrez-le dans votre client Telegram, ou supprimez-le entièrement.',
  'error.tg.perm.delete':
    '🔐 Impossible de supprimer les messages. Accordez au bot `can_delete_messages`.',
  'error.tg.perm.manage_topics':
    '🔐 `can_manage_topics` manquant. Faites-moi admin du groupe.',
  'error.state.corrupted':
    '⚠️ state.json était corrompu ; liens réinitialisés. Relancez /bind si nécessaire.',
  'error.start_in_general':
    'Impossible de démarrer un agent dans General — c\'est un topic de service. Ouvrez un fil thématique.',

  'cb.access_denied': 'Accès refusé',
  'cb.bind_only_topical': '/bind ne fonctionne que dans les fils thématiques',
  'cb.binding_to': 'Liaison à {subdir}…',
  'cb.no_active_session': 'Aucune session active',
  'cb.model_error': 'Erreur : {error}',
  'cb.model_set': 'Modèle : {model}',
  'cb.not_supported': 'Non pris en charge pour {label}',
  'cb.unknown_agent': 'Agent inconnu',
  'cb.agent_switched': 'Basculé vers {label}',
  'cb.resume_only_topical': 'Resume ne fonctionne que dans les fils thématiques',
  'cb.bind_folder_first': 'Liezez d\'abord un dossier via /bind',
  'cb.agent_not_running': 'Agent non en cours',
  'cb.no_pending_question': 'Aucune question en attente',
  'cb.invalid_option': 'Option invalide',
  'cb.sent_option': 'Envoyé : {option}',
  'cb.effort_set': 'Effort : {level}',
  'cb.effort_error': 'Erreur : {error}',
  'cb.claudeMode_already': 'Déjà actif',
  'cb.claudeMode_switching': 'Basculement…',
  'claudeMode.pick': '⚙️ Backend Claude Code — actuel : {label}\nChoisissez un backend (le basculement garde la même conversation) :',
  'claudeMode.not_claude': "Ce topic n'est pas sur Claude Code — /claude_mode ne bascule que le backend de Claude.",
  'claudeMode.already': 'Déjà {label}.',
  'claudeMode.set_idle': '⚙️ Backend Claude : {label} — s\'appliquera au prochain démarrage.',
  'claudeMode.switched_resumed': '⚙️ Basculé vers {label} — même conversation reprise.',
  'claudeMode.switched_fresh': '⚙️ Basculé vers {label} — nouvelle session démarrée.',
  'cb.thinking_set': 'Thinking : {mode}',
  'cb.thinking_error': 'Erreur : {error}',
  'cb.toolresults_set': 'Résultats d\'outils : {mode}',
  'cb.toolresults_error': 'Erreur : {error}',
  'cb.subagent_set': 'Sous-agents : {mode}',
  'cb.subagent_error': 'Erreur : {error}',
  'cb.verbosity_set': 'Verbosité de sortie : {mode}',
  'cb.verbosity_error': 'Erreur : {error}',

  'session.list_header': 'Sessions à reprendre ({label}) :',
  'session.list_footer': 'Envoyez 1–{max} pour reprendre · 0 pour quitter',
  'session.none': 'Aucune session à reprendre dans ce dossier.',
  'session.cancelled': 'Annulé. Sélecteur de session fermé.',
  'session.invalid': 'Numéro invalide. Entrez une valeur de 1 à {max}.',
  'session.resumed': 'Session reprise. Envoyez votre message :',
  'session.resume_failed': 'Échec de la reprise de session : {error}',
  'session.expired': 'La liste des sessions est périmée. Relancez /sessions.',
  'session.load_failed': 'Échec du chargement des sessions.',

  'resume.context_header': '↩️ Repris — {count} derniers messages :',
  'resume.context_user_label': '👤',
  'resume.context_assistant_label': '🤖',

  'recap.missedCountHeader': '⚠️ {count} message(s) manqué(s) pendant que le bot était hors ligne. Dernier de la session :',
  'recap.restartedFallbackHeader': '🔄 Bot redémarré. Dernier de la session :',
  'recap.stillWorkingLine': '⏳ L\'agent travaille encore…',

  'trace.onThisThreadReply': '🔎 Traçage activé pour ce fil.',
  'trace.offThisThreadReply': '🔎 Traçage désactivé pour ce fil.',
  'trace.onAllThreadsReply': '🔎 Traçage activé pour TOUS les fils.',
  'trace.offAllThreadsReply': '🔎 Traçage désactivé partout (le flag « all » et la liste des fils sont effacés).',
  'trace.statusReply':
    '🔎 Trace — ce fil : {thisThread}\nTous les fils : {allThreads}\nFils tracés : {count}',
  'trace.statusOnLabel': 'activé',
  'trace.statusOffLabel': 'désactivé',
  'trace.usageHint': 'Utilisation : /trace on | off | on all | off all | (sans argument — statut)',

  'timestamps.onReply':
    '🕐 Horodatage activé : chaque prompt transmis à l\'agent reçoit l\'heure d\'envoi comme première ligne (jamais posté dans le topic).',
  'timestamps.offReply': '🕐 Horodatage désactivé pour ce fil.',
  'timestamps.statusOnReply': '🕐 Horodatage : activé pour ce fil.',
  'timestamps.statusOffReply': '🕐 Horodatage : désactivé pour ce fil.',
  'timestamps.usageHint': 'Utilisation : /timestamps on | off | (sans argument — statut)',

  'schedule.fired':
    '⏰ Planification « {name} » ({schedule}){missedNote}\n\n{prompt}',
  'schedule.missedNote': ' — manqué à {time}, rattrapage',
  'schedule.pausedUnbound':
    '⏸ Planifications en pause : {count} — le topic a été détaché de son dossier. /bind les restaurera.',
  'schedule.resumedRebind': '▶️ Planifications reprises : {count} (prochain recalculé à partir de maintenant).',
  'schedule.forwardPromptTemplate':
    'The user wants to schedule the following. Use the schedule_create / schedule_list / schedule_cancel MCP tools (cron for repeats, one-shot for a single run), translating any time phrasing into the right schedule, then confirm to the user IN FRENCH what you scheduled.\n\nRequest: {text}',
  'schedule.interviewPromptTemplate':
    'The user invoked /schedule with no details. Ask them IN FRENCH what prompt they want scheduled and WHEN (one-time or repeating). Once you have both, create it with the schedule_create MCP tool and confirm IN FRENCH what you scheduled.',

  'apiRetry.transientNotice':
    '⏳ API limité en débit — nouvelle tentative automatique dans {minutes} min (tentative {attempt}).',
  'apiRetry.usageLimitDelayNotice':
    '🚧 Limite d\'utilisation atteinte — nouvelle tentative dans {minutes} min (tentative {attempt}).',
  'apiRetry.usageLimitResetNotice':
    '🚧 Limite d\'utilisation atteinte — reprise automatique après reset (~{time}).',
  'apiRetry.resuming': '↻ Reprise…',
  'apiRetry.giveUp':
    '⚠️ Impossible de reprendre après {attempts} tentatives. Écrivez-moi quand continuer.',
  'apiRetry.continueNudge': 'Continuez là où vous vous êtes arrêté.',
  'apiRetry.loggedOutClaude':
    '⚠️ Claude est déconnecté — lancez /login pour continuer.',
  'apiRetry.loggedOutOpenCode':
    '⚠️ OpenCode : identifiants invalides — redémarrez le serveur opencode.',

  // ── startup readiness status (boot-time owner notice) ──
  'startup.ready':
    '✅ Prêt — je peux traiter les messages dans les fils du bot et les sujets de groupe.',
  'startup.header_not_ready':
    '⚠️ Configuration incomplète. Pour commencer à travailler avec moi, veuillez terminer ces étapes :',
  'startup.item.create_group':
    'Créez un supergroupe de forum avec les Sujets activés, puis envoyez-moi un message là-bas pour l’associer.',
  'startup.item.grant_admin':
    'Faites de moi un administrateur avec ces droits : {missing}.',
  'startup.item.bind_topic':
    'Créez un sujet et liez-le à un dossier avec /bind.',
  'startup.item.install_agent':
    'Installez un CLI d’agent — claude ou opencode.',
  'startup.item.optional_groq':
    '(optionnel) Ajoutez GROQ_API_KEY à votre .env et redémarrez pour activer la saisie vocale.',
  'startup.item.optional_owner':
    '(optionnel) Définissez OWNER_USER_ID pour recevoir ce statut dans votre chat privé.',
};
