// Machine-translated from en. Native review welcome.

export const ptDict: Record<string, string> = {
  'access.denied': 'Acesso negado.',
  'access.group_only': 'Só funciono no supergrupo fórum configurado.',

  'thread.no_binding':
    '📁 Este tópico não está vinculado a uma pasta. Usa /bind <subdir> ou escolhe da lista.',
  'thread.bind_required':
    '📁 Vincula primeiro uma pasta: /bind <subdir>. O agente só funciona na pasta vinculada.',
  'thread.bound': '📁 Vinculado a `{subdir}`.\nInicia /claude ou /opencode.',
  'thread.unbound': '📁 Vínculo removido.',
  'thread.general_no_agent':
    'General não está vinculado a uma pasta — muda para um tópico temático para falar com um agente.',
  'thread.welcome_bound':
    '👋 Tópico criado e vinculado automaticamente a `{subdir}` (nome do tópico correspondeu a uma subpasta).\nInicia /claude ou /opencode.',
  'thread.welcome_pick':
    '👋 Tópico criado. Vincula uma pasta: /bind <subdir>, ou escolhe uma da lista.',
  'thread.bind_collision':
    '⚠️ A pasta `{subdir}` já é usada pelos tópicos: {threads}.\nVínculo adicionado; as sessões mantêm-se independentes (tmux/SSE próprios).',
  'thread.no_agent_with_binding':
    '📁 A pasta `{subdir}` está vinculada. Inicia /claude ou /opencode para começar o diálogo.',

  'bind.usage': 'Uso: /bind <subdir>\nExemplo: /bind overview',
  'bind.current': '📂 Vinculado atualmente: `{subdir}`',
  'bind.current_none': '📂 Ainda não vinculado',
  'bind.in_general': '/bind só funciona em tópicos temáticos, não no General.',
  'bind.invalid_chars': '❌ O nome da pasta não deve conter caracteres de controlo.',
  'bind.not_found': '❌ Pasta `{subdir}` não encontrada sob `WORK_ROOT` (`{workRoot}`).',
  'bind.outside_root': '❌ O caminho sai de `WORK_ROOT`.',
  'bind.not_directory': '❌ `{subdir}` existe mas não é uma pasta.',

  'bind.leave_button': '⬅️ Sair da pasta atual',
  'bind.create_button': '➕ Criar nova pasta',
  'bind.create_prompt':
    '✏️ Envia o nome da nova pasta (será criada sob `WORK_ROOT`). Qualquer comando cancela.',
  'bind.create_cb': 'A criar nova pasta…',
  'bind.create_empty': '❌ Nome vazio. Envia um nome de pasta.',
  'bind.create_separator': '❌ O nome não deve conter `/` ou `\\`. Envia um nome simples.',
  'bind.create_dot_segment': '❌ `.` e `..` não podem ser usados como nome de pasta.',
  'bind.create_hidden': '❌ O nome não deve começar com um ponto.',
  'bind.create_invalid_chars': '❌ O nome da pasta não deve conter caracteres de controlo.',
  'bind.create_exists': '📁 A pasta `{subdir}` já existe — a vincular.',
  'bind.create_failed': '❌ Falha ao criar a pasta: {error}',

  'ls.header': '📁 Subpastas de `{workRoot}`:',
  'ls.empty': '📁 Sem subpastas vinculáveis sob `WORK_ROOT`.',
  'list.header': '🧵 Vínculos de tópicos ({count}):',
  'list.empty': '🧵 Ainda sem vínculos. Cria um tópico e executa /bind.',
  'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
  'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
  'new.general_hint':
    '/new funciona dentro de um tópico vinculado — abre um tópico e executa /new para reiniciar a sessão do agente.',

  'help.general':
    '*Comandos no General:*\n' +
    '/ls — listar subpastas `WORK_ROOT`\n' +
    '/list — listar tópicos\n' +
    '/status — estado de todos os tópicos\n' +
    '/quitall — parar todos os agentes em execução\n' +
    '/whoami /version — depuração\n\n' +
    'Para falar com um agente — abre um tópico temático.',
  'help.thread_unbound':
    '*O tópico não está vinculado a uma pasta.*\n' +
    '/bind <subdir> — vincular (ou escolher da lista)\n' +
    '/ls — subpastas `WORK_ROOT` (no General)',
  'help.thread_bound':
    '*Tópico vinculado a `{subdir}`.*\n' +
    '/claude /opencode — iniciar um agente\n' +
    '/connect — ligar uma API key de provider OpenCode (OpenAI por defeito)\n' +
    '/terminal — abrir um shell nesta pasta\n' +
    '/new — reiniciar a sessão (a antiga → /sessions)\n' +
    '/model /sessions — trocar\n' +
    '/effort — nível de reasoning effort\n' +
    '/verbosity — verbosidade de saída (thinking/tools/sub-agentes)\n' +
    '/quit /status /output — controlo\n' +
    '/compact — compactar o contexto do agente\n' +
    '/clear — apagar mensagens do tópico\n' +
    '/c /y /n /enter /up /down /tab /esc — teclas TUI (Claude)\n' +
    '/bind — gerir vínculo',

  'doctor.header': '🔍 *TelegramCode Doctor*',
  'doctor.ok': '✅ {label}',
  'doctor.warn': '⚠️ {label} — {hint}',
  'doctor.fail': '❌ {label} — {hint}',
  'doctor.bot_admin': 'O bot é admin do grupo',
  'doctor.can_manage_topics': '`can_manage_topics` concedido',
  'doctor.can_delete_messages': '`can_delete_messages` concedido',
  'doctor.can_pin_messages': '`can_pin_messages` concedido',
  'doctor.privacy_off': 'Privacy mode desativado',
  'doctor.privacy_hint':
    '@BotFather → /setprivacy → Disable, depois remove e volta a adicionar o bot',
  'doctor.workroot_subdirs':
    '`WORK_ROOT`: `{workRoot}` ({count} subpastas)',
  'doctor.datadir_path': '`DATA_DIR`: `{dataDir}`',
  'doctor.claude_installed': 'claude CLI instalado',
  'doctor.opencode_installed': 'opencode CLI instalado',
  'doctor.state_valid':
    'state.json válido ({bindings} vínculos, {active} ativos)',
  'doctor.state_archived':
    'o state.json anterior estava corrompido, arquivo: {path}',
  'doctor.cli_missing':
    'não encontrado no PATH (auto-instala ao executar /claude ou /opencode)',
  'doctor.no_admin_info':
    'não é possível ler os direitos do bot — getChatMember falhou',

  'onboarding.welcome':
    '👋 *TelegramCode Bot 2.0*\n\n' +
    'Checklist de configuração:\n' +
    '1️⃣ Torna-me admin do grupo com direitos:\n' +
    '   • Manage Topics, Delete Messages, Pin Messages\n' +
    '2️⃣ @BotFather → /setprivacy → Disable, depois remove e volta a adicionar-me\n' +
    '3️⃣ Executa /doctor para ver o que falta\n' +
    '4️⃣ Em cada tópico temático executa /bind <subdir> e inicia um agente\n\n' +
    '`WORK_ROOT`: `{workRoot}`',

  'binding.welcome.header': '📁 Vinculado a `{subdir}`',
  'binding.welcome.claude_md': '• CLAUDE.md: {size}',
  'binding.welcome.mcp_json': '• `.mcp.json`: {count} servidores',
  'binding.welcome.git': '• git: ramo `{branch}`{detail}',
  'binding.welcome.git_clean': ', limpo',
  'binding.welcome.git_dirty': ', alterações não confirmadas',
  'binding.welcome.git_none': '• git: não inicializado',
  'binding.welcome.start_prompt': 'Inicia uma conversa:',

  'mcp.header': '🔌 *Servidores MCP para este tópico:*',
  'mcp.row': '• `{name}` — {source}',
  'mcp.empty': '🔌 Sem servidores MCP configurados.',
  'mcp.source_user': 'user (~/.claude/settings.json)',
  'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
  'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
  'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

  'doctor.pin_hint': 'O estado fixado do tópico (Stage 7) não estará disponível',

  'whoami.report':
    '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
    '🔐 allowed: {allowed}\n📁 binding: {binding}',
  'whoami.binding_unbound': '(sem vínculo)',

  'pair.success': '✅ Grupo emparelhado. id: `{groupId}`. O bot agora serve este supergrupo.',
  'pair.locked':
    'ℹ️ O id do grupo está definido via `ALLOWED_GROUP_ID` — o auto-emparelhamento está desativado. ' +
    'Para mudar de grupo, altera a variável e reinicia o bot.',
  'pair.only_forum': '❌ /pair só funciona num supergrupo fórum (ativa Topics).',
  'pair.not_admin': '❌ Apenas um administrador ou criador do grupo pode emparelhar o bot.',
  'pair.not_paired': 'grupo ainda não emparelhado (modo pairing)',
  'pair.dm': "ℹ️ /pair não é necessário no modo DM — o bot serve o teu chat privado.",
  'version.report':
    '*TelegramCode {bot}*\n' +
    'Node: {node}\n' +
    'tmux: {tmux}\n' +
    'claude: {claude}\n' +
    'opencode: {opencode}',
  'version.unknown': '(indisponível)',
  'status.global_header': '📊 *Todos os tópicos* ({total}):',
  'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
  'status.global_empty': '📊 Ainda sem tópicos.',
  'language.status': '🌐 Idioma: {display}',
  'language.set_success': '✅ Idioma definido para `{locale}` neste chat.',
  'language.auto_success': '✅ Idioma reposto para automático. Atual: {display}.',
  'language.invalid': '⚠️ A locale `{locale}` não é suportada. Disponíveis: {locales}.',

  'agent.ready': '{label} pronto em `{subdir}`{argsSuffix}\nEnvia uma mensagem:',
  'agent.no_session': 'Sem agente em execução. /claude ou /opencode para iniciar.',
  'agent.session_ended': '{label}: sessão terminada',
  'agent.stopped': '{label} parado',
  'agent.exit_signal_sent': 'Duplo Ctrl+C enviado — {label} a sair',
  'agent.already_active': '{label} já está em execução aqui. Envia uma mensagem ou /quit.',
  'agent.starting': 'A iniciar {label} em `{subdir}`…',
  'agent.queued_starting': '⏳ {label} ainda está a iniciar — a tua mensagem está na fila e será enviada quando estiver pronto.',
  'agent.question_hint': 'ℹ️ Responde com o número da opção (ex. 1) ou y/n. Também: /up /down para mover, /enter para confirmar, /c para cancelar.',
  'agent.start_failed': 'Falha ao iniciar {label}: {error}',
  'agent.question_cancelled_for_prompt': '⚠️ Pergunta anterior cancelada — a executar o teu novo pedido.',
  'agent.question_cancelled_msg_label': '❌ Pergunta cancelada: {header}',
  'agent.login_code_relayed': '🔐 Código de login retransmitido para o Claude — a mensagem com o token foi apagada do histórico.',
  'agent.login_url': '🔐 Para entrar no Claude, abra este link, conclua o login e cole o código aqui:\n{url}',
  'agent.login_success': '✅ Login no Claude concluído.',
  'agent.login_failed': '⚠️ Falha no login do Claude. Execute /login para tentar novamente.',
  'agent.workingIndicator': '{glyph} a trabalhar…',
  'terminal.ready': '🖥 Terminal pronto em `{subdir}`{argsSuffix}\nCada mensagem executa como um comando. /c — Ctrl+C, /up /down — histórico, /tab — autocompletar, /quit — fechar.',

  'effort.choose': '⚙️ Effort atual: {current}\nEscolhe um nível:',
  'effort.current_none': 'não definido',
  'effort.set_success': '✅ Effort: {level}',
  'effort.invalid_level': '⚠️ Nível `{level}` inválido. Disponíveis: {valid}.',
  'effort.not_available': 'ℹ️ Sem níveis de reasoning effort disponíveis para o modelo atual.',
  'effort.not_supported': 'ℹ️ O modelo `{model}` não tem níveis de reasoning effort.',
  'effort.start_agent_first': 'ℹ️ Nível guardado. Sem agente em execução — será aplicado no próximo início.',
  'effort.cleared_on_model_switch': 'ℹ️ Effort `{level}` removido: o novo modelo `{model}` não o suporta.',
  'effort.unsupported_backend': 'O controlo de effort não é suportado para {label}.',
  'effort.no_session': 'Sem agente em execução. Inicia um com /claude ou /opencode.',

  'thinking.live': '•••',
  'thinking.thoughtForSeconds': '💭 pensou durante {seconds}s',
  'thinking.choose': '☁️ Modo de thinking atual: {current}\nEscolhe um modo:',
  'thinking.set_success': '✅ Modo de thinking: {mode}',
  'thinking.invalid_mode': '⚠️ Modo `{mode}` inválido. Disponíveis: {valid}.',
  'thinking.mode.minimal': 'mínimo',
  'thinking.mode.short': 'curto',
  'thinking.mode.full': 'completo',

  'toolResults.choose': '🔧 Modo de resultados de ferramentas atual: {current}\nEscolhe um modo:',
  'toolResults.set_success': '✅ Modo de resultados de ferramentas: {mode}',
  'toolResults.invalid_mode': '⚠️ Modo `{mode}` inválido. Disponíveis: {valid}.',
  'toolResults.mode.minimal': 'mínimo',
  'toolResults.mode.short': 'curto',
  'toolResults.mode.full': 'completo',
  'toolResults.truncated_footer': '… (truncado, /tool_results full)',
  'toolResults.activity_status': '🔧 {tool} …',
  'toolResults.activity_fallback': 'ferramenta',

  'subagent.status_elapsed': '🤖 sub-agente: {title} · {elapsed}',
  'subagent.panel_fold_status': '🤖 sub-agente a trabalhar …',
  'subagent.delegating_status': '🤖 A delegar: {title} …',
  'subagent.chunk_prefix': '🤖 ⤷',
  'subagent.fallback_title': 'sub-agente',
  'subagent.choose': '🤖 Modo de sub-agente atual: {current}\nEscolhe um modo:',
  'subagent.set_success': '✅ Modo de sub-agente: {mode}',
  'subagent.invalid_mode': '⚠️ Modo `{mode}` inválido. Disponíveis: {valid}.',
  'subagent.mode.minimal': 'mínimo',
  'subagent.mode.short': 'curto',
  'subagent.mode.full': 'completo',

  'verbosity.choose': '🔊 Verbosidade de saída atual: {current}\nEscolhe um nível:',
  'verbosity.set_success': '✅ Verbosidade de saída: {mode} (thinking, resultados de ferramentas, sub-agentes)',
  'verbosity.invalid_mode': '⚠️ Modo `{mode}` inválido. Disponíveis: {valid}.',
  'verbosity.custom': 'personalizado (thinking: {thinking} · ferramentas: {toolResults} · sub-agentes: {subagent})',
  'verbosity.mode.minimal': 'mínimo',
  'verbosity.mode.short': 'curto',
  'verbosity.mode.full': 'completo',

  'model.saved_for_next_start': 'Modelo guardado: {model} — aplica-se no próximo início de agente.',
  'model.start_agent_first': 'Sem sessão ativa. Inicia um agente primeiro.',

  'rename_session.usage': 'Uso: /rename_session <novo título>',
  'rename_session.start_agent_first': 'Sem sessão ativa. Inicia um agente primeiro (/claude ou /opencode).',
  'rename_session.unsupported_backend': 'O renomear de sessão não é suportado para {label}.',
  'rename_session.success': '✅ Sessão renomeada: {title}',
  'rename_session.failed': '⚠️ Falha ao renomear a sessão: {reason}',

  'connect.prompt_key': '🔑 Envia a API key para `{provider}` como próxima mensagem. Vou apagar a mensagem com a chave do histórico.',
  'connect.empty_key': '❌ A API key está vazia. Envia a chave como próxima mensagem.',
  'connect.invalid_provider': '❌ ID de provider inválido `{provider}`. Exemplo: /connect openai',
  'connect.unsupported_provider': '⚠️ O provider `{provider}` não suporta um login por API key simples neste fluxo. Usa a UI/CLI do OpenCode para este provider.',
  'connect.unsupported_backend': 'A auth de provider OpenCode não está disponível neste build.',
  'connect.failed': '⚠️ Falha ao ligar `{provider}`: {reason}',
  'connect.success': '✅ Provider `{provider}` ligado. O servidor OpenCode não foi reiniciado.',
  'connect.cancelled': 'Introdução de API key cancelada.',

  'quit_all.none_active': 'Sem agentes em execução — nada a parar.',
  'quit_all.summary': '🚪 Parados {stopped} de {total} agentes ativos.',
  'quit_all.general_only': '`/quit-all` só está disponível no tópico General.',

  'clearMessages.summary':
    '🗑 Apagadas {deleted} de {total} mensagens. ' +
    'O Telegram recusa apagar o que tem mais de 48 h — o resto fica no histórico.',
  'clearMessages.no_messages': 'Sem mensagens para apagar neste tópico.',

  'edited.hint':
    '✏️ Não trato mensagens editadas como nova entrada — envia a correção como uma mensagem separada.',

  'voice.no_api_key':
    'A voz requer `GROQ_API_KEY` (grátis) ou `OPENAI_API_KEY`.',
  'voice.failed': 'Falha ao transcrever a mensagem de voz.',
  'voice.transcribed': '🎤 {text}',

  'file.too_big':
    '📎 O ficheiro excede o limite da Bot API ({cap} MB) — não o consigo descarregar. Envia um ficheiro mais pequeno.',
  'file.download_failed': '📎 Falha ao descarregar o ficheiro. Tenta novamente.',

  'error.workdir.gone':
    '📁 A pasta `{subdir}` desapareceu do disco. Executa /bind <newdir>.',
  'error.tg.thread.deleted':
    '⚠️ O tópico foi apagado no Telegram; vínculo removido.',
  'error.tg.thread.closed':
    '🔒 O tópico {key} está fechado — reabre-o no teu cliente do Telegram, ou apaga-o por completo.',
  'error.tg.perm.delete':
    '🔐 Não consigo apagar mensagens. Concede ao bot `can_delete_messages`.',
  'error.tg.perm.manage_topics':
    '🔐 Falta `can_manage_topics`. Torna-me admin do grupo.',
  'error.state.corrupted':
    '⚠️ O state.json estava corrompido; vínculos reiniciados. Executa /bind onde for necessário.',
  'error.start_in_general':
    'Não é possível iniciar um agente no General — é um tópico de serviço. Abre um tópico temático.',

  'cb.access_denied': 'Acesso negado',
  'cb.bind_only_topical': '/bind só funciona em tópicos temáticos',
  'cb.binding_to': 'A vincular a {subdir}…',
  'cb.no_active_session': 'Sem sessão ativa',
  'cb.model_error': 'Erro: {error}',
  'cb.model_set': 'Modelo: {model}',
  'cb.not_supported': 'Não suportado para {label}',
  'cb.unknown_agent': 'Agente desconhecido',
  'cb.agent_switched': 'Trocado para {label}',
  'cb.resume_only_topical': 'Resume só funciona em tópicos temáticos',
  'cb.bind_folder_first': 'Vincula primeiro uma pasta via /bind',
  'cb.agent_not_running': 'Agente não em execução',
  'cb.no_pending_question': 'Sem pergunta pendente',
  'cb.invalid_option': 'Opção inválida',
  'cb.sent_option': 'Enviado: {option}',
  'cb.effort_set': 'Effort: {level}',
  'cb.effort_error': 'Erro: {error}',
  'cb.claudeMode_already': 'Já ativo',
  'cb.claudeMode_switching': 'A trocar…',
  'claudeMode.pick': '⚙️ Backend do Claude Code — atual: {label}\nEscolhe um backend (a troca mantém a mesma conversa):',
  'claudeMode.not_claude': "Este tópico não está no Claude Code — /claude_mode só troca o backend do Claude.",
  'claudeMode.already': 'Já {label}.',
  'claudeMode.set_idle': '⚙️ Backend do Claude: {label} — aplica-se no próximo início.',
  'claudeMode.switched_resumed': '⚙️ Trocado para {label} — mesma conversa retomada.',
  'claudeMode.switched_fresh': '⚙️ Trocado para {label} — nova sessão iniciada.',
  'cb.thinking_set': 'Thinking: {mode}',
  'cb.thinking_error': 'Erro: {error}',
  'cb.toolresults_set': 'Resultados de ferramentas: {mode}',
  'cb.toolresults_error': 'Erro: {error}',
  'cb.subagent_set': 'Sub-agentes: {mode}',
  'cb.subagent_error': 'Erro: {error}',
  'cb.verbosity_set': 'Verbosidade de saída: {mode}',
  'cb.verbosity_error': 'Erro: {error}',

  'session.list_header': 'Sessões para retomar ({label}):',
  'session.list_footer': 'Envia 1–{max} para retomar · 0 para sair',
  'session.none': 'Sem sessões retomáveis nesta pasta.',
  'session.cancelled': 'Cancelado. Seletor de sessão fechado.',
  'session.invalid': 'Número inválido. Introduz um valor de 1 a {max}.',
  'session.resumed': 'Sessão retomada. Envia a tua mensagem:',
  'session.resume_failed': 'Falha ao retomar a sessão: {error}',
  'session.expired': 'A lista de sessões está desatualizada. Executa /sessions novamente.',
  'session.load_failed': 'Falha ao carregar as sessões.',

  'resume.context_header': '↩️ Retomado — últimas {count} mensagens:',
  'resume.context_user_label': '👤',
  'resume.context_assistant_label': '🤖',

  'recap.missedCountHeader': '⚠️ {count} mensagem(ns) perdida(s) enquanto o bot esteve offline. Última da sessão:',
  'recap.restartedFallbackHeader': '🔄 Bot reiniciado. Última da sessão:',
  'recap.stillWorkingLine': '⏳ O agente ainda está a trabalhar…',

  'trace.onThisThreadReply': '🔎 Rastreio ativado para este tópico.',
  'trace.offThisThreadReply': '🔎 Rastreio desativado para este tópico.',
  'trace.onAllThreadsReply': '🔎 Rastreio ativado para TODOS os tópicos.',
  'trace.offAllThreadsReply': '🔎 Rastreio desativado em todo o lado (o flag «all» e a lista de tópicos foram limpos).',
  'trace.statusReply':
    '🔎 Trace — este tópico: {thisThread}\nTodos os tópicos: {allThreads}\nTópicos rastreados: {count}',
  'trace.statusOnLabel': 'ligado',
  'trace.statusOffLabel': 'desligado',
  'trace.usageHint': 'Uso: /trace on | off | on all | off all | (sem argumento — estado)',

  'timestamps.onReply':
    '🕐 Marcas de tempo ativadas: cada prompt enviado ao agente recebe a hora de envio como primeira linha (nunca publicada no tópico).',
  'timestamps.offReply': '🕐 Marcas de tempo desativadas para este tópico.',
  'timestamps.statusOnReply': '🕐 Marcas de tempo: ligadas para este tópico.',
  'timestamps.statusOffReply': '🕐 Marcas de tempo: desligadas para este tópico.',
  'timestamps.usageHint': 'Uso: /timestamps on | off | (sem argumento — estado)',

  'schedule.fired':
    '⏰ Agendamento «{name}» ({schedule}){missedNote}\n\n{prompt}',
  'schedule.missedNote': ' — perdido às {time}, a recuperar',
  'schedule.pausedUnbound':
    '⏸ Agendamentos em pausa: {count} — o tópico foi desvinculado da sua pasta. /bind irá restaurá-los.',
  'schedule.resumedRebind': '▶️ Agendamentos retomados: {count} (próximo recalculado a partir de agora).',
  'schedule.noAgent':
    '⚠️ Nada agendado — nenhum agente está ativo neste tópico, então uma execução agendada não teria nada para iniciar. Inicie /claude ou /opencode primeiro.',
  'schedule.forwardPromptTemplate':
    'The user wants to schedule the following. Use the schedule_create / schedule_list / schedule_cancel MCP tools (cron for repeats, one-shot for a single run), translating any time phrasing into the right schedule, then confirm to the user IN PORTUGUESE what you scheduled.\n\nRequest: {text}',
  'schedule.interviewPromptTemplate':
    'The user invoked /schedule with no details. Ask them IN PORTUGUESE what prompt they want scheduled and WHEN (one-time or repeating). Once you have both, create it with the schedule_create MCP tool and confirm IN PORTUGUESE what you scheduled.',

  'apiRetry.transientNotice':
    '⏳ API limitada por taxa — nova tentativa automática em {minutes} min (tentativa {attempt}).',
  'apiRetry.usageLimitDelayNotice':
    '🚧 Limite de uso atingido — nova tentativa em {minutes} min (tentativa {attempt}).',
  'apiRetry.usageLimitResetNotice':
    '🚧 Limite de uso atingido — retoma automática após reset (~{time}).',
  'apiRetry.resuming': '↻ A retomar…',
  'apiRetry.giveUp':
    '⚠️ Não foi possível retomar após {attempts} tentativas. Escreve-me quando continuar.',
  'apiRetry.continueNudge': 'Continua de onde paraste.',
  'apiRetry.loggedOutClaude':
    '⚠️ Claude está desconectado — executa /login para continuar.',
  'apiRetry.loggedOutOpenCode':
    '⚠️ OpenCode: credenciais inválidas — reinicia o servidor opencode.',

  // ── startup readiness status (boot-time owner notice) ──
  'startup.ready':
    '✅ Pronto — posso processar mensagens nas conversas do bot e nos tópicos de grupo.',
  'startup.header_not_ready':
    '⚠️ Configuração incompleta. Para começar a trabalhar comigo, conclua estas etapas:',
  'startup.item.create_group':
    'Crie um supergrupo de fórum com os Tópicos ativados e envie-me uma mensagem lá para emparelhá-lo.',
  'startup.item.grant_admin':
    'Torne-me administrador com estes direitos: {missing}.',
  'startup.item.bind_topic':
    'Crie um tópico e vincule-o a uma pasta com /bind.',
  'startup.item.install_agent':
    'Instale uma CLI de agente — claude ou opencode.',
  'startup.item.optional_groq':
    '(opcional) Adicione GROQ_API_KEY ao seu .env e reinicie para ativar a entrada de voz.',
  'startup.item.optional_owner':
    '(opcional) Defina OWNER_USER_ID para receber este status no seu chat privado.',
};
